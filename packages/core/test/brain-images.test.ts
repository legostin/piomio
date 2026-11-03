import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainImageEvents, type BrainEvent } from "@piomio/shared";
import { CodexAppParser } from "../../brains-cli/src/codex-app.ts";
import { BrainImages, saveBrainImage } from "../src/brain-images.ts";
import { Hub, loadConfig } from "../src/index.ts";
import { buildMainApp } from "../src/server/main-app.ts";
import { mediaSrc } from "../../web/src/lib/media.ts";

const frame = JSON.parse(readFileSync(new URL("../../brains-cli/test/fixtures/codex-image-completed.json", import.meta.url), "utf8"));
const PNG = Buffer.from(frame.params.item.result, "base64");

describe("native image transfer", () => {
  it("assembles a large image from bounded frames, once", () => {
    const data = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]);
    const frames = brainImageEvents("large", data.toString("base64"));
    const images = new BrainImages();
    const results = frames.flatMap((f) => images.push(f as any) ?? []);
    expect(results).toEqual([{ data, ext: "png" }]);
    expect(images.push(frames.at(-1) as any)).toBeUndefined();
    expect(images.finish()).toBe(false);
  });

  it("rejects malformed bytes, out-of-order chunks, excess size, and active content", () => {
    for (const data of ["not base64!!!", "", Buffer.from("<svg onload='alert(1)'/>").toString("base64"), "a".repeat(40 * 1024 * 1024 + 4)]) {
      expect(() => new BrainImages().push({ type: "image", id: "x", data })).toThrow(/invalid|incomplete/);
    }
    const image = { type: "image", id: "x", data: frame.params.item.result } as const;
    expect(() => new BrainImages().push({ ...image, chunk: { index: 1, total: 2 } })).toThrow();
    const partial = new BrainImages();
    expect(partial.push({ ...image, chunk: { index: 0, total: 2 } })).toBeUndefined();
    expect(partial.finish()).toBe(true);
    expect(partial.finish()).toBe(false);
  });

  it("does not write through a workspace symlink outside the hub's files", () => {
    const root = mkdtempSync(join(tmpdir(), "image-root-"));
    const outside = mkdtempSync(join(tmpdir(), "image-outside-"));
    symlinkSync(outside, join(root, "escape"));
    expect(() => saveBrainImage(root, join(root, "escape"), { data: PNG, ext: "png" })).toThrow(/outside/);
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("Codex output to the actual hub runner and HTTP file route (no listeners)", () => {
  it.each(["local", "mach_vps", "mach_windows"])("%s: stores bytes, shows in task and parent, serves through authenticated UI URL", async (machine) => {
    const dataDir = mkdtempSync(join(tmpdir(), "native-image-hub-"));
    const hub = new Hub(loadConfig({ PIOMIO_DEVICES: "0" }, { dataDir, builtinPluginsDirs: [], builtinAgentsDir: join(dataDir, "agents") }));
    const app = await buildMainApp(hub);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const parent = hub.store.agentConversation("assistant");
      const task = hub.store.createTask({ agentId: "assistant", title: "Image", goal: "x", createdBy: "agent", background: false, parentConversationId: parent.id });
      const conv = hub.store.getConversation(task.conversationId)!;
      const brainRef = `codex@${machine}`;
      const stream = async (events: BrainEvent[]) => (hub.runner as any).streamTurn(conv,
        { id: "image-session", agentId: "assistant", conversationId: conv.id, brainRef, background: false, tainted: false },
        { brainRef, handle: { send: async (_turn: unknown, onEvent: (e: BrainEvent) => void) => {
          // Same JSON frames as node/plugin RPC, with no file access on the brain's machine.
          for (const e of events) onEvent(JSON.parse(JSON.stringify(e)));
        } } }, { id: "assistant", name: "Assistant" }, { text: "Draw" }, task);
      const result = await stream(new CodexAppParser().push(frame.method, frame.params));
      const message = hub.store.getMessage(result.messageId)!;
      const part = message.parts.find((p) => p.type === "images")!;
      expect(part).toMatchObject({ items: [{ src: expect.stringMatching(/^file:assistant\/.+\/generated-image-.+\/image.png$/) }] });
      const src = part.type === "images" ? part.items[0].src : "";
      expect(readFileSync(join(dataDir, "workspaces", src.slice(5)))).toEqual(PNG);
      expect(hub.store.listMessages(parent.id).some((m) => m.parts.some((p) => p.type === "images"))).toBe(true);
      expect(JSON.stringify(hub.store.listMessages(conv.id))).not.toContain(frame.params.item.result);
      expect(JSON.stringify(hub.store.listMessages(conv.id))).not.toContain("savedPath");
      expect(warn).not.toHaveBeenCalled();
      expect(await (hub.runner as any).replyMedia(message.id)).toMatchObject([{ kind: "image", data: PNG.toString("base64"), mimeType: "image/png" }]);

      const url = mediaSrc(src)!;
      const host = new URL(hub.config.publicUrl).host;
      expect((await app.inject({ url, headers: { host } })).statusCode).toBe(401);
      const setup = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { host, origin: hub.config.publicUrl }, payload: { token: hub.auth.setupToken, password: "test-images-password" } });
      expect(setup.statusCode).toBe(200);
      const cookie = String(setup.headers["set-cookie"]).split(";")[0];
      const file = await app.inject({ url, headers: { host, cookie } });
      expect(file.statusCode).toBe(200);
      expect(file.headers["content-type"]).toContain("image/png");
      expect(file.rawPayload).toEqual(PNG);

      const missing = await stream(new CodexAppParser().push(frame.method, { item: { ...frame.params.item, result: "" } }));
      expect(hub.store.getMessage(missing.messageId)?.parts).toContainEqual({ type: "error", message: expect.stringContaining("savedPath is present") });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("no inline data"));
      const broken = await stream([{ type: "image", id: "partial", data: PNG.toString("base64"), chunk: { index: 0, total: 2 } }]);
      expect(hub.store.getMessage(broken.messageId)?.parts).toContainEqual({ type: "error", message: expect.stringContaining("incomplete") });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(frame.params.item.result);
    } finally {
      warn.mockRestore();
      await app.close();
      await hub.stop();
    }
  });
});
