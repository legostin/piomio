import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachmentFromPath,
  attachmentNote,
  attachmentsDir,
  defaultName,
  formatSize,
  forSession,
  isSpeech,
  mimeOf,
  SPEECH_NOT_SET_UP,
  safeFileName,
  saveAttachment,
} from "../src/attachments.ts";

const conv = { id: "c1", agentId: "assistant" };
const at = new Date(2026, 9, 27, 9, 15, 0);

describe("attachments", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "piomio-att-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("makes plain, safe file names", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\Users\\a\\отчёт.pdf")).toBe("отчёт.pdf");
    expect(safeFileName("..hidden")).toBe("hidden");
    expect(safeFileName('a<b>:c"|?*.txt')).toBe("a_b__c____.txt");
    expect(safeFileName("")).toBe("file");
    const long = safeFileName(`${"я".repeat(300)}.jpeg`);
    expect(long.length).toBeLessThanOrEqual(150);
    expect(long.endsWith(".jpeg")).toBe(true);
  });

  it("knows types by extension and keeps a given one", () => {
    expect(mimeOf("a.JPG")).toBe("image/jpeg");
    expect(mimeOf("a.pdf")).toBe("application/pdf");
    expect(mimeOf("v.ogg")).toBe("audio/ogg");
    expect(mimeOf("x.unknown")).toBe("application/octet-stream");
    expect(mimeOf("x.bin", "audio/mpeg")).toBe("audio/mpeg");
    expect(mimeOf("x.png", "not a type")).toBe("image/png");
  });

  it("names files that came without a name by what they are", () => {
    expect(defaultName("photo", "image/jpeg", at)).toBe("photo-20261027-091500.jpg");
    expect(defaultName("voice", "audio/ogg", at)).toBe("voice-20261027-091500.ogg");
    expect(defaultName(undefined, "application/pdf", at)).toBe("file-20261027-091500.pdf");
    expect(defaultName("video", "video/unknown-thing", at)).toBe("video-20261027-091500");
  });

  it("saves into the conversation's attachments folder with unique names", () => {
    const a = saveAttachment(root, conv, { name: "отчёт.pdf", data: Buffer.from("one") }, at);
    const b = saveAttachment(root, conv, { name: "отчёт.pdf", data: Buffer.from("two") }, at);
    const c = saveAttachment(root, { ...conv, taskId: "t9" }, { kind: "voice", mimeType: "audio/ogg", data: Buffer.from("v"), durationSec: 12 }, at);
    expect(a).toEqual({ type: "attachment", path: "assistant/c1/attachments/отчёт.pdf", name: "отчёт.pdf", mimeType: "application/pdf", size: 3 });
    expect(b.path).toBe("assistant/c1/attachments/отчёт (2).pdf");
    expect(readFileSync(join(root, b.path), "utf8")).toBe("two");
    expect(c).toMatchObject({ path: "assistant/t9/attachments/voice-20261027-091500.ogg", kind: "voice", durationSec: 12, mimeType: "audio/ogg" });
    expect(attachmentsDir(root, conv)).toBe(join(root, "assistant", "c1", "attachments"));
  });

  it("accepts only this conversation's own attachments", () => {
    const a = saveAttachment(root, conv, { name: "a.png", data: Buffer.from("png") }, at);
    expect(attachmentFromPath(root, conv, a.path)).toEqual(a);
    expect(attachmentFromPath(root, { id: "c2", agentId: "assistant" }, a.path)).toBeUndefined();
    expect(attachmentFromPath(root, conv, "assistant/c1/attachments/../../c2/x.png")).toBeUndefined();
    expect(attachmentFromPath(root, conv, "assistant/c1/attachments/missing.png")).toBeUndefined();
    mkdirSync(join(root, "assistant/c1/attachments/sub"), { recursive: true });
    writeFileSync(join(root, "assistant/c1/attachments/sub/x.png"), "x");
    expect(attachmentFromPath(root, conv, "assistant/c1/attachments/sub/x.png")).toBeUndefined();
    writeFileSync(join(root, "assistant/c1/notes.md"), "x");
    expect(attachmentFromPath(root, conv, "assistant/c1/notes.md")).toBeUndefined();
  });

  it("gives a session paths in its own workspace, copying when it works elsewhere", () => {
    const a = saveAttachment(root, conv, { name: "a.png", data: Buffer.from("png") }, at);
    expect(forSession([a], root, join(root, "assistant", "c1"))).toEqual([{ part: a, path: "attachments/a.png" }]);
    const other = join(root, "researcher", "c1");
    const gone = { type: "attachment" as const, path: "assistant/c1/attachments/gone.pdf", name: "gone.pdf" };
    expect(forSession([a, gone], root, other)).toEqual([{ part: a, path: "attachments/a.png" }, { part: gone }]);
    expect(readFileSync(join(other, "attachments", "a.png"), "utf8")).toBe("png");
    expect(existsSync(join(root, a.path))).toBe(true);
    // The same file again is not copied twice; another file with that name gets its own.
    expect(forSession([a], root, other)).toEqual([{ part: a, path: "attachments/a.png" }]);
    writeFileSync(join(root, "assistant/c1/attachments/b.png"), "other png");
    const b = { type: "attachment" as const, path: "assistant/c1/attachments/b.png", name: "a.png" };
    writeFileSync(join(other, "attachments", "b.png"), "something else");
    expect(forSession([b], root, other)).toEqual([{ part: b, path: "attachments/b (2).png" }]);
  });

  it("writes the note for the model", () => {
    const photo = { type: "attachment" as const, path: "assistant/c1/attachments/receipt.jpg", name: "receipt.jpg", mimeType: "image/jpeg", size: 1_250_000 };
    const voice = { type: "attachment" as const, path: "assistant/c1/attachments/voice.ogg", name: "voice.ogg", mimeType: "audio/ogg", size: 48_000, kind: "voice" as const, durationSec: 72 };
    const old = { type: "attachment" as const, path: "assistant/c1/attachments/old.pdf", name: "old.pdf", mimeType: "application/pdf" };
    expect(attachmentNote([{ part: photo, path: "attachments/receipt.jpg" }])).toBe(
      "[The user attached a file, saved in your working folder:\n- attachments/receipt.jpg (image/jpeg, 1.2 MB)\nOpen it with your file tools when the request needs it.]",
    );
    expect(attachmentNote([{ part: photo, path: "attachments/receipt.jpg" }, { part: voice, path: "attachments/voice.ogg" }, { part: old }])).toBe(
      [
        "[The user attached 3 files, saved in your working folder:",
        "- attachments/receipt.jpg (image/jpeg, 1.2 MB)",
        "- attachments/voice.ogg (audio/ogg, 47 KB, voice message 1:12)",
        "- old.pdf (no longer available)",
        "Open them with your file tools when the request needs them.]",
      ].join("\n"),
    );
    // Another computer: the hub's copy of its folder syncs there, a file too big to sync stays on the hub.
    const film = { type: "attachment" as const, path: "assistant/c1/attachments/film.mov", name: "film.mov", mimeType: "video/quicktime", size: 300 * 1024 * 1024 };
    expect(attachmentNote([{ part: photo, path: "attachments/receipt.jpg" }, { part: film }, { part: old }], { remote: true })).toBe(
      [
        "[The user attached 3 files, saved in your working folder:",
        "- attachments/receipt.jpg (image/jpeg, 1.2 MB)",
        "- film.mov (video/quicktime, 300 MB): stays on the hub, too big to copy to this computer",
        "- old.pdf (no longer available)",
        "They come over from the hub: if one is not there yet, wait a few seconds and look again.",
        "Open them with your file tools when the request needs them.]",
      ].join("\n"),
    );
    expect(attachmentNote([])).toBe("");
  });

  it("puts what a voice message says into the note, or why it cannot", () => {
    const voice = { type: "attachment" as const, path: "a/c/attachments/v.ogg", name: "v.ogg", mimeType: "audio/ogg", size: 2048, kind: "voice" as const, durationSec: 5 };
    expect(isSpeech(voice)).toBe(true);
    expect(isSpeech({ ...voice, kind: "video" as const, mimeType: "video/mp4" })).toBe(false);
    expect(isSpeech({ type: "attachment", path: "x", name: "song.mp3", mimeType: "audio/mpeg" })).toBe(true);
    expect(attachmentNote([{ part: { ...voice, transcript: "купи хлеба" }, path: "attachments/v.ogg" }])).toContain('- attachments/v.ogg (audio/ogg, 2 KB, voice message 0:05), transcript: "купи хлеба"');
    expect(attachmentNote([{ part: { ...voice, transcript: "" }, path: "attachments/v.ogg" }])).toContain("voice message 0:05), transcript: (no speech)");
    const none = attachmentNote([{ part: voice, path: "attachments/v.ogg", speech: SPEECH_NOT_SET_UP }]);
    expect(none).toContain("voice message 0:05), no speech-to-text is set up\nYou cannot hear voice messages until speech-to-text is set up.");
    expect(attachmentNote([{ part: voice, path: "attachments/v.ogg", speech: "could not transcribe it: Groq answered 429" }])).not.toContain("You cannot hear");
  });

  it("formats sizes", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(48_000)).toBe("47 KB");
    expect(formatSize(1_250_000)).toBe("1.2 MB");
    expect(formatSize(25 * 1024 * 1024)).toBe("25 MB");
  });
});
