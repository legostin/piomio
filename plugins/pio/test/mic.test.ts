// The mic looks after itself: it notices when the browser's capture ends, is muted or goes quiet (the computer slept, a
// headset came or went), wakes or reopens it, and tells the window when it is deaf, so the face never claims to listen
// while nothing is heard.
import { describe, expect, it, vi } from "vitest";
import { CHECK_MS, Mic, REOPEN_MS, SILENT_MS, type Capture, type CaptureHandlers, type MicTrouble } from "../ui/src/voice/mic.ts";

const RATE = 16_000;

interface FakeCapture extends Capture {
  h: CaptureHandlers;
  stopped: boolean;
  woken: number;
}

function rig(opts: { muted?: boolean } = {}) {
  const captures: FakeCapture[] = [];
  let failWith: Error | undefined;
  let tick: (() => void) | undefined;
  let t = 1_000_000;
  const health: Array<MicTrouble | "ok"> = [];
  const phrases: Uint8Array[] = [];
  const phrase = vi.fn((wav: Uint8Array) => { phrases.push(wav); });
  const hearing = vi.fn();
  const interrupt = vi.fn();
  const isEcho = vi.fn(() => false);
  const mic = new Mic({
    onPhrase: phrase,
    onHearing: hearing,
    onInterrupt: interrupt,
    isEcho,
    onHealth: (ok, why) => health.push(ok ? "ok" : why!),
    port: {
      async open(h) {
        if (failWith) throw failWith;
        const cap: FakeCapture = { h, stopped: false, woken: 0, sampleRate: RATE, muted: opts.muted, wake: () => void cap.woken++, stop: () => void (cap.stopped = true) };
        captures.push(cap);
        return cap;
      },
    },
    clock: { now: () => t, setInterval: (fn) => ((tick = fn), 1), clearInterval: () => (tick = undefined) },
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const last = () => captures.at(-1)!;
  const frame = (level = 0) => last().h.onFrame(new Float32Array(320).fill(level));
  /** Time passes in CHECK_MS steps, the watchdog running each step; with `frames`, a (silent) frame comes each step too. */
  const go = async (ms: number, frames = false) => {
    for (let i = 0; i < ms / CHECK_MS; i++) {
      t += CHECK_MS;
      if (frames) frame();
      tick?.();
      await flush();
    }
  };
  /** The clock jumps (the computer slept) and the watchdog runs once. */
  const jump = async (ms: number) => {
    t += ms;
    tick?.();
    await flush();
  };
  return { mic, captures, last, frame, go, jump, flush, health, phrases, phrase, hearing, interrupt, isEcho, fail: (e?: Error) => void (failWith = e), ticking: () => !!tick };
}

describe("the mic looks after itself", () => {
  it("cuts phrases from the frames and hands them over as WAV", async () => {
    const r = rig();
    await r.mic.start();
    expect(r.captures).toHaveLength(1);
    expect(r.ticking()).toBe(true);
    for (let i = 0; i < 25; i++) r.frame(0.002);
    for (let i = 0; i < 50; i++) r.frame(0.2);
    for (let i = 0; i < 40; i++) r.frame(0.002);
    expect(r.phrases).toHaveLength(1);
    expect(String.fromCharCode(...r.phrases[0].slice(0, 4))).toBe("RIFF");
    expect(r.health).toEqual([]);
  });

  it("opens the mic again when its track ends", async () => {
    const r = rig();
    await r.mic.start();
    const first = r.last();
    first.h.onLost("ended");
    await r.flush();
    expect(r.captures).toHaveLength(2);
    expect(first.stopped).toBe(true);
    expect(r.health).toEqual(["silent"]);
    r.frame();
    expect(r.health).toEqual(["silent", "ok"]);
    // The dead capture's frames count for nothing.
    first.h.onFrame(new Float32Array(320));
    expect(r.health).toEqual(["silent", "ok"]);
  });

  it("wakes a context that went quiet, and reopens the mic when that does not help", async () => {
    const r = rig();
    await r.mic.start();
    r.frame();
    await r.go(SILENT_MS);
    expect(r.health).toEqual(["silent"]);
    expect(r.last().woken).toBeGreaterThan(0);
    expect(r.captures).toHaveLength(1);
    await r.go(REOPEN_MS);
    expect(r.captures).toHaveLength(2);
    expect(r.captures[0].stopped).toBe(true);
    r.frame();
    expect(r.health).toEqual(["silent", "ok"]);
  });

  it("leaves a mic alone while frames come, including during playback", async () => {
    const r = rig();
    await r.mic.start();
    r.mic.setPlayback(true);
    await r.go(REOPEN_MS * 2, true);
    expect(r.captures).toHaveLength(1);
    expect(r.health).toEqual([]);
    expect(r.phrases).toEqual([]);
  });

  it("says when the system muted the track, and reopens it when it stays muted", async () => {
    const r = rig();
    await r.mic.start();
    r.last().h.onMuted(true);
    expect(r.health).toEqual(["muted"]);
    r.last().h.onMuted(false);
    expect(r.health).toEqual(["muted", "ok"]);
    r.last().h.onMuted(true);
    // A muted track still delivers frames (of silence): they do not count as hearing.
    await r.go(REOPEN_MS, true);
    expect(r.captures).toHaveLength(2);
    r.frame();
    expect(r.health.at(-1)).toBe("ok");
  });

  it("gives the mic a fresh chance after the computer slept, before opening it again", async () => {
    const r = rig();
    await r.mic.start();
    r.frame();
    await r.jump(600_000);
    expect(r.health).toEqual([]);
    expect(r.captures).toHaveLength(1);
    expect(r.last().woken).toBe(1);
    // Nothing comes after the wake either: the usual way.
    await r.go(SILENT_MS + REOPEN_MS);
    expect(r.health).toEqual(["silent"]);
    expect(r.captures).toHaveLength(2);
  });

  it("says when the mic cannot be opened again, and keeps trying", async () => {
    const r = rig();
    await r.mic.start();
    r.fail(new Error("NotAllowedError"));
    r.last().h.onLost("ended");
    await r.flush();
    expect(r.health).toEqual(["silent", "noMic"]);
    expect(r.captures).toHaveLength(1);
    r.fail(undefined);
    await r.go(REOPEN_MS);
    expect(r.captures).toHaveLength(2);
    expect(r.health).toEqual(["silent", "noMic"]);
    r.frame();
    expect(r.health.at(-1)).toBe("ok");
  });

  it("knows a track the system handed over muted", async () => {
    const r = rig({ muted: true });
    await r.mic.start();
    expect(r.health).toEqual(["muted"]);
  });

  it("does not start at all without a secure page, and stops cleanly", async () => {
    const r = rig();
    r.fail(new Error("insecure"));
    await expect(r.mic.start()).rejects.toThrow("insecure");
    expect(r.mic.on).toBe(false);
    r.fail(undefined);
    await r.mic.start();
    expect(r.mic.on).toBe(true);
    r.mic.stop();
    expect(r.mic.on).toBe(false);
    expect(r.last().stopped).toBe(true);
    expect(r.ticking()).toBe(false);
  });

  it("keeps the watchdog healthy during echo rejection and still interrupts after reopening", async () => {
    const r = rig();
    await r.mic.start();
    r.mic.setPlayback(true);
    r.isEcho.mockReturnValue(true);
    await r.go(REOPEN_MS * 2, true);
    for (let i = 0; i < 50; i++) r.frame(0.2);
    expect(r.health).toEqual([]);
    expect(r.captures).toHaveLength(1);
    expect(r.interrupt).not.toHaveBeenCalled();
    expect(r.hearing).not.toHaveBeenCalledWith(true);
    const first = r.last();
    first.h.onLost("ended");
    await r.flush();
    expect(r.health).toEqual(["silent"]);
    expect(r.hearing).toHaveBeenLastCalledWith(false);
    r.isEcho.mockReturnValue(false);
    for (let i = 0; i < 50; i++) first.h.onFrame(new Float32Array(320).fill(0.2));
    expect(r.interrupt).not.toHaveBeenCalled();
    for (let i = 0; i < 50; i++) r.frame(0.2);
    for (let i = 0; i < 40; i++) r.frame();
    expect(r.health).toEqual(["silent", "ok"]);
    expect(r.interrupt).toHaveBeenCalledOnce();
    expect(r.phrase.mock.calls[0].slice(1)).toEqual([false, true]);
  });

  it("clears a hearing face on capture loss and discards an unfinished phrase", async () => {
    const r = rig();
    await r.mic.start();
    r.mic.setPlayback(true);
    for (let i = 0; i < 10; i++) r.frame(0.2);
    expect(r.hearing).toHaveBeenLastCalledWith(true);
    await r.go(SILENT_MS);
    expect(r.health).toEqual(["silent"]);
    expect(r.hearing).toHaveBeenLastCalledWith(false);
    // Frames resume before a reopen: start a new phrase, not the old partial one.
    for (let i = 0; i < 10; i++) r.frame(0.2);
    for (let i = 0; i < 40; i++) r.frame();
    expect(r.health).toEqual(["silent", "ok"]);
    expect(r.phrases).toEqual([]);
    expect(r.interrupt).not.toHaveBeenCalled();
    expect(r.captures).toHaveLength(1);
  });

  it("discards system-muted input and resumes held-key capture after reopening", async () => {
    const r = rig();
    await r.mic.start();
    r.mic.setPlayback(true);
    r.mic.hold(true);
    r.frame(0.2);
    r.last().h.onMuted(true);
    expect(r.hearing).toHaveBeenLastCalledWith(false);
    for (let i = 0; i < 50; i++) r.frame(0.2);
    expect(r.interrupt).not.toHaveBeenCalled();
    await r.go(REOPEN_MS, true);
    expect(r.captures).toHaveLength(2);
    r.frame(0.2);
    r.mic.hold(false);
    expect(r.health.at(-1)).toBe("ok");
    expect(r.phrase.mock.calls[0].slice(1)).toEqual([true, true]);
  });

  it("clears stale mic trouble when voice is toggled off and on", async () => {
    const r = rig();
    await r.mic.start();
    r.last().h.onMuted(true);
    expect(r.health.at(-1)).toBe("muted");
    r.mic.stop();
    expect(r.health.at(-1)).toBe("ok");
    await r.mic.start();
    r.frame();
    expect(r.health.at(-1)).toBe("ok");
    expect(r.hearing).toHaveBeenLastCalledWith(false);
  });
});
