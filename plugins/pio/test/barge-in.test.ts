import { afterEach, describe, expect, it, vi } from "vitest";
import { Mic } from "../ui/src/voice/mic.ts";
import { Speaker } from "../ui/src/voice/speaker.ts";
import { ReplyVoice, sentence } from "../ui/src/voice/reply.ts";
import { Vad } from "../ui/src/voice/vad.ts";
import { backchannel } from "../ui/src/voice/gate.ts";
import { SpeechApi } from "../ui/src/hub.ts";

const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const frame = (level = 0.2) => new Float32Array(320).fill(level);
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => resolve = r); return { promise, resolve }; };
afterEach(() => vi.unstubAllGlobals());

describe("confirmed speech", () => {
  function feed(plan: Array<[number, number]>) {
    const v = new Vad({ sampleRate: 16000, confidenceMs: 300 });
    const events = [];
    for (const [level, ms] of plan) for (let at = 0; at < ms; at += 20) {
      const e = v.feed(frame(level)); if (e) events.push(e);
    }
    return events;
  }
  it("requires sustained, sufficiently loud speech; short acknowledgements do not interrupt", () => {
    expect(feed([[0.2, 280], [0, 800]]).some((e) => e.type === "confident")).toBe(false);
    expect(feed([[0.025, 1200], [0, 800]]).some((e) => e.type === "confident")).toBe(false);
    expect(feed([[0.2, 240], [0, 180], [0.2, 240], [0, 800]]).some((e) => e.type === "confident")).toBe(false);
    expect(feed([[0.2, 1000], [0, 800]]).map((e) => e.type)).toEqual(["start", "confident", "end"]);
    expect(backchannel("угу!")).toBe(true);
    expect(backchannel("ага")).toBe(true);
    expect(backchannel("да, но сделай иначе")).toBe(false);
  });
});

function audio() {
  const decode = deferred<AudioBuffer>();
  const sources: any[] = [];
  let node: any;
  const ctx = {
    state: "running", sampleRate: 16000, currentTime: 0, destination: {}, resume: vi.fn(async () => {}),
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createScriptProcessor: () => node = { connect() {}, disconnect() {} },
    decodeAudioData: vi.fn(() => decode.promise),
    createBufferSource: () => { const s = { start: vi.fn(), stop: vi.fn(), connect() {}, onended: undefined }; sources.push(s); return s; },
  };
  const media = vi.fn(async () => ({ getTracks: () => [{ stop() {} }], getAudioTracks: () => [] }));
  vi.stubGlobal("AudioContext", function () { return ctx; });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: media } });
  return { ctx, decode, sources, media, feed: (level = 0.2) => node.onaudioprocess({ inputBuffer: { getChannelData: () => frame(level) } }) };
}

describe("microphone during playback", () => {
  it("keeps VAD alive with AEC, reports confident speech once, and preserves held-key input", async () => {
    const a = audio(); const interrupt = vi.fn(); const phrase = vi.fn(); const hearing = vi.fn();
    const mic = new Mic({ onPhrase: phrase, onHearing: hearing, onInterrupt: interrupt });
    await mic.start(); mic.setPlayback(true);
    for (let i = 0; i < 50; i++) a.feed();
    expect(a.media).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    expect(hearing).toHaveBeenCalledWith(true);
    expect(interrupt).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 40; i++) a.feed(0);
    expect(phrase.mock.calls[0].slice(1)).toEqual([false, true]);
    mic.hold(true); a.feed(); mic.hold(false);
    expect(phrase.mock.calls[1][1]).toBe(true);
    mic.stop();
  });
  it("drops the known output waveform before VAD", async () => {
    const a = audio(); const interrupt = vi.fn(); const hearing = vi.fn();
    const mic = new Mic({ onPhrase: vi.fn(), onHearing: hearing, onInterrupt: interrupt, isEcho: () => true });
    await mic.start(); mic.setPlayback(true);
    for (let i = 0; i < 80; i++) a.feed();
    expect(hearing).not.toHaveBeenCalledWith(true); expect(interrupt).not.toHaveBeenCalled(); mic.stop();
  });
});

describe("playback cancellation", () => {
  it("cannot start audio whose decode completed after stop", async () => {
    const a = audio(); const speaker = new Speaker(vi.fn());
    const playing = speaker.play(new ArrayBuffer(8)); await tick(); speaker.stop();
    a.decode.resolve({} as AudioBuffer);
    expect(await playing).toBe(false); expect(a.sources).toHaveLength(0);
  });
  it("acknowledges only an ended buffer, never a stopped one, and recognizes its own waveform", async () => {
    const a = audio(); const speaker = new Speaker(vi.fn());
    const samples = Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i * 1.618) * 0.2);
    a.decode.resolve({ sampleRate: 16000, duration: 1, getChannelData: () => samples } as AudioBuffer);
    const first = speaker.play(new ArrayBuffer(8)); await tick();
    a.ctx.currentTime = 0.1;
    expect(speaker.isEcho(samples.slice(1280, 1600), 16000)).toBe(true);
    speaker.stop(); expect(await first).toBe(false);
    const next = speaker.play(new ArrayBuffer(8)); await tick();
    a.sources[0].onended(); expect(a.sources[1].stop).not.toHaveBeenCalled();
    a.sources[1].onended(); expect(await next).toBe(true);
  });
});

describe("streaming sentences", () => {
  it("speaks the first sentence before the answer finishes; records completed fragments only", async () => {
    const a = deferred<boolean>(); const b = deferred<boolean>(); const say = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const stop = vi.fn(); const voice = new ReplyVoice(say, stop);
    voice.observe("m", "First sentence. The next", false);
    expect(say.mock.calls[0][0]).toBe("First sentence.");
    voice.delta("m", " sentence."); voice.observe("m", "First sentence. The next sentence.", true);
    expect(say).toHaveBeenCalledTimes(1);
    a.resolve(true); await tick(); expect(say).toHaveBeenCalledTimes(2);
    const signal = say.mock.calls[1][1];
    expect(voice.cancel()).toEqual([{ messageId: "m", end: 15 }]);
    expect(signal.aborted).toBe(true); expect(stop).toHaveBeenCalledOnce();
    b.resolve(true); await tick();
    voice.observe("m", "First sentence. The next sentence. Late text.", true);
    expect(say).toHaveBeenCalledTimes(2);
  });
  it("cancels pending synthesis and never starts the queued sentence or acknowledges a failed gap", async () => {
    const d = deferred<boolean>(); const say = vi.fn(() => d.promise); const voice = new ReplyVoice(say, vi.fn());
    voice.observe("m", "One. Two.", true);
    expect(voice.cancel()).toEqual([{ messageId: "m", end: 0 }]);
    d.resolve(true); await tick(); expect(say).toHaveBeenCalledOnce();
    const fail = vi.fn(async () => false); const failed = new ReplyVoice(fail, vi.fn());
    failed.observe("n", "One. Two.", true); await tick();
    expect(fail).toHaveBeenCalledOnce(); expect(failed.cancel()[0].end).toBe(0);
  });
  it("does not speak code, split URLs, or unfinished sentences", () => {
    expect(sentence("Still thinking", false)).toBeUndefined();
    expect(sentence("```js\na.b();\n", false)).toBeUndefined();
    expect(sentence("```js\na.b();\n", true)?.words).toBe("");
    expect(sentence("See [this](https://a.test/x). Next", false)?.words).toBe("See this.");
    expect(sentence("Number 1.25 is fine. Next", false)?.words).toBe("Number 1.25 is fine.");
    expect(sentence("word ".repeat(500), true)!.words.length).toBeLessThan(1000);
    const withCode = `\`\`\`\n${"secretcode ".repeat(300)}\n\`\`\`\n${"word ".repeat(500)}`;
    expect(sentence(withCode, true)!.words).not.toContain("secretcode");
    expect(sentence(withCode, true)!.end).toBeGreaterThan(withCode.indexOf("word"));
  });
  it("can be interrupted between sentences while the brain is still producing text", async () => {
    const voice = new ReplyVoice(vi.fn(async () => true), vi.fn());
    voice.observe("m", "First. ", false); await tick();
    expect(voice.active).toBe(true);
    expect(voice.cancel()).toEqual([{ messageId: "m", end: 6 }]);
    voice.delta("m", "Late sentence."); expect(voice.active).toBe(false);
  });
  it("a deletion or interruption from another window cancels only that reply", async () => {
    const a = deferred<boolean>(); const say = vi.fn().mockReturnValueOnce(a.promise).mockResolvedValue(true);
    const voice = new ReplyVoice(say, vi.fn());
    voice.observe("old", "Old reply.", true); voice.observe("new", "New reply.", true);
    voice.discard("old"); await tick(); expect(say).toHaveBeenCalledTimes(2);
    a.resolve(true); await tick();
    expect(voice.cancel()).toEqual([{ messageId: "new", end: 10 }]);
  });
});

it("does not send synthesis after cancellation while fetching the CSRF token", async () => {
  const token = deferred<{ csrf: string }>(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const api = new SpeechApi({ api: { get: () => token.promise } } as any);
  const ctl = new AbortController(); const saying = api.say("old sentence", undefined, ctl.signal);
  ctl.abort(); token.resolve({ csrf: "test" });
  await expect(saying).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
});
