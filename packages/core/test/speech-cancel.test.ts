import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fork } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpeechEngine, WorkerBackend } from "../src/speech/engine.ts";

vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), fork: vi.fn() }));
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const workers: WorkerBackend[] = [];
afterEach(() => { for (const b of workers.splice(0)) b.stop(); vi.clearAllMocks(); vi.useRealTimers(); });
function backend() { const b = new WorkerBackend("/test/runtime", () => {}); workers.push(b); return b; }
const voice = { dir: "/test/voice", model: "m.onnx", espeak: "en-us" };
function child() {
  const c = new EventEmitter() as any;
  c.stderr = new EventEmitter(); c.stderr.setEncoding = () => {};
  c.send = vi.fn((_request, cb) => cb?.(null)); c.kill = vi.fn();
  vi.mocked(fork).mockReturnValueOnce(c);
  return c;
}

describe("cancelling synthesis without losing recognition", () => {
  it("the engine routes public say/recognize calls to separate workers", async () => {
    const ttsChild = child(); const sttChild = child();
    const engine = new SpeechEngine({ dataDir: mkdtempSync(join(tmpdir(), "voice-cancel-")), language: () => "en", voice: () => undefined, sttProvider: () => "local" });
    engine.runtimeReady = () => true;
    (engine as any).modelReady = () => true;
    const ctl = new AbortController();
    try {
      const saying = engine.say("old answer", { signal: ctl.signal }); const rejected = expect(saying).rejects.toThrow();
      const hearing = engine.recognize(new Float32Array(320), 16000); await tick();
      expect(ttsChild.send.mock.calls[0][0].op).toBe("say"); expect(sttChild.send.mock.calls[0][0].op).toBe("recognize");
      ctl.abort(); await rejected; expect(sttChild.kill).not.toHaveBeenCalled();
      sttChild.emit("message", { id: sttChild.send.mock.calls[0][0].id, text: "new input" });
      expect(await hearing).toBe("new input");
    } finally { engine.stop(); }
  });
  it("kills only the active synthesis worker, never runs a cancelled queued sentence, and recovers", async () => {
    const ttsChild = child(); const sttChild = child(); const nextChild = child();
    const tts = backend(); const stt = backend(); const ctl = new AbortController();
    const first = tts.say(voice, "first", 1, ctl.signal); const rejected = expect(first).rejects.toThrow();
    const second = tts.say(voice, "queued", 1, ctl.signal); const rejected2 = expect(second).rejects.toThrow();
    const recognizing = stt.recognize({ dir: "/stt", kind: "nemo_ctc", files: [] }, new Float32Array(16), 16000);
    await tick(); ctl.abort(); await Promise.all([rejected, rejected2]);
    expect(ttsChild.kill).toHaveBeenCalledOnce(); expect(ttsChild.send).toHaveBeenCalledOnce();
    expect(sttChild.kill).not.toHaveBeenCalled();
    sttChild.emit("message", { id: sttChild.send.mock.calls[0][0].id, text: "new words" });
    expect(await recognizing).toBe("new words");
    const next = tts.say(voice, "new sentence", 1); await tick();
    // The old worker exiting must not reject the new request.
    ttsChild.emit("exit", 0, "SIGTERM");
    nextChild.emit("message", { id: nextChild.send.mock.calls[0][0].id, wav: new Uint8Array([1, 2]) });
    expect(await next).toEqual(Buffer.from([1, 2]));
  });
  it("rejects an already aborted request without spawning or sending, and invalidates queue on shutdown", async () => {
    const ctl = new AbortController(); ctl.abort(); const b = backend();
    await expect(b.say(voice, "old", 1, ctl.signal)).rejects.toThrow(); expect(fork).not.toHaveBeenCalled();
    const c = child(); const a = b.say(voice, "first", 1); const d = b.say(voice, "queued", 1);
    const pa = expect(a).rejects.toThrow(); const pd = expect(d).rejects.toThrow();
    await tick(); b.stop(); await Promise.all([pa, pd]); expect(c.send).toHaveBeenCalledOnce();
  });
  it("retains the existing worker deadline for a request that never replies", async () => {
    vi.useFakeTimers(); const c = child(); const b = backend();
    const pending = b.say(voice, "hung request", 1); const failed = expect(pending).rejects.toThrow("voice engine stopped");
    await tick(); await vi.advanceTimersByTimeAsync(10 * 60_000); await failed;
    expect(c.kill).toHaveBeenCalledOnce();
  });
});
