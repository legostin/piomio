import { describe, expect, it, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { provider, DEFAULTS, VoiceError, type ProviderId } from "../server/providers.ts";
import { collectSpeech } from "../server/realtime.ts";
import { settingsFor } from "../server/index.ts";
const mp3 = new Uint8Array([73, 68, 51, 0, 0, 0]);
const options = (id: ProviderId) => ({ model: DEFAULTS[id].ttsModel, voice: DEFAULTS[id].voice, language: "ru", signal: new AbortController().signal });
afterEach(() => vi.restoreAllMocks());

describe("provider wire contracts", () => {
  for (const id of ["xai", "elevenlabs", "openai"] as const) {
    it(`${id}: sends only its key, model, voice and text to its own fixed endpoint`, async () => {
      const send = vi.fn().mockResolvedValue(new Response(mp3, { headers: { "content-type": "audio/mpeg" } }));
      const o = options(id); if (id === "openai") o.model = "gpt-4o-mini-tts";
      expect(await provider(id, "test-key", send).synthesize("Привет", o)).toEqual({ data: mp3, mimeType: "audio/mpeg" });
      const [url, req] = send.mock.calls[0]; const body = JSON.parse(req.body);
      expect(req.redirect).toBe("error"); expect(req.signal).toBe(o.signal);
      expect(req.headers["user-agent"]).toBe("Piomio/voice-providers");
      expect(req.headers[id === "elevenlabs" ? "xi-api-key" : "authorization"]).toBe(id === "elevenlabs" ? "test-key" : "Bearer test-key");
      if (id === "xai") { expect(url).toBe("https://api.x.ai/v1/tts"); expect(body).toEqual({ text: "Привет", voice_id: "rex", language: "ru" }); }
      if (id === "elevenlabs") { expect(url).toContain("https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?"); expect(body).toEqual({ text: "Привет", model_id: "eleven_flash_v2_5" }); }
      if (id === "openai") { expect(url).toBe("https://api.openai.com/v1/audio/speech"); expect(body).toEqual({ input: "Привет", model: "gpt-4o-mini-tts", voice: "cedar", response_format: "mp3" }); }
      expect(JSON.stringify(body)).not.toContain("test-key");
    });
    it(`${id}: uploads recording and model, keeps xAI's file last and returns trimmed words`, async () => {
      const send = vi.fn().mockResolvedValue(Response.json({ text: "  Привет мир  " }));
      const o = { ...options(id), model: DEFAULTS[id].sttModel };
      expect(await provider(id, "test-key", send).transcribe(mp3, "audio/mpeg", "recording.mp3", o)).toBe("Привет мир");
      const [url, req] = send.mock.calls[0]; const form = req.body as FormData;
      expect(url).toBe({ xai: "https://api.x.ai/v1/stt", elevenlabs: "https://api.elevenlabs.io/v1/speech-to-text", openai: "https://api.openai.com/v1/audio/transcriptions" }[id]);
      expect([...form.keys()].at(-1)).toBe("file"); expect(form.get(id === "elevenlabs" ? "model_id" : "model")).toBe(o.model);
      expect(form.get(id === "elevenlabs" ? "language_code" : id === "openai" ? "languages[]" : "language")).toBe("ru");
      expect(req.headers["content-type"]).toBeUndefined();
      const file = form.get("file") as File; expect(file.name).toBe("recording.mp3"); expect(file.type).toBe("audio/mpeg"); expect(new Uint8Array(await file.arrayBuffer())).toEqual(mp3);
    });
  }
  it("keeps older OpenAI transcription language field and routes Realtime models separately", async () => {
    const send = vi.fn().mockResolvedValue(Response.json({ text: "" })); const real = vi.fn().mockResolvedValue({ data: mp3, mimeType: "audio/wav" });
    const p = provider("openai", "test-key", send, real);
    await p.transcribe(mp3, "audio/mpeg", "a.mp3", { ...options("openai"), model: "gpt-4o-mini-transcribe" });
    expect(send.mock.calls[0][1].body.get("language")).toBe("ru");
    const o = options("openai"); await p.synthesize("hello", o); expect(real).toHaveBeenCalledWith("hello", o, "test-key"); expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([[401,"auth"],[403,"auth"],[402,"quota"],[429,"quota"],[400,"request"],[500,"unavailable"]])("maps HTTP %s without echoing upstream content or key", async (status, code) => {
    const send = vi.fn().mockResolvedValue(new Response('secret key test-key; user private text', { status: status as number }));
    await expect(provider("xai", "test-key", send).synthesize("hello", options("xai"))).rejects.toMatchObject({ code });
  });
  it("rejects empty, HTML and JSON audio and malformed transcript responses", async () => {
    for (const data of [new Uint8Array(), new TextEncoder().encode("<html>error"), new TextEncoder().encode('{"text":"wrong"}')])
      await expect(provider("xai", "key", vi.fn().mockResolvedValue(new Response(data))).synthesize("hello", options("xai"))).rejects.toBeInstanceOf(VoiceError);
    await expect(provider("xai", "key", vi.fn().mockResolvedValue(Response.json({ wrong: "x" }))).transcribe(mp3, "audio/mpeg", "a.mp3", options("xai"))).rejects.toMatchObject({ code: "response" });
  });
  it("does not start an aborted request and rejects malformed configuration", async () => {
    const ctl = new AbortController(); ctl.abort(); const send = vi.fn();
    await expect(provider("xai", "key", send).synthesize("hello", { ...options("xai"), signal: ctl.signal })).rejects.toThrow(); expect(send).not.toHaveBeenCalled();
    expect(settingsFor({ ttsProvider: "openai", openaiTtsModel: "gpt-realtime-2.1", openaiVoice: "marin" }, "tts")).toEqual({ id: "openai", model: "gpt-realtime-2.1", voice: "marin" });
    for (const s of [{ ttsProvider: "bad" }, { ttsProvider: "xai", xaiVoice: "../secret" }, { ttsProvider: "openai", openaiTtsModel: "sk key" }]) expect(() => settingsFor(s,"tts")).toThrow();
  });
});

class Socket extends EventEmitter { readyState = 1; send = vi.fn(); terminate = vi.fn(); }
describe("OpenAI Realtime synthesis lifecycle", () => {
  it("requests stateless audio with no tools and wraps all PCM chunks as a valid mono 24kHz WAV", async () => {
    const ws = new Socket(); const p = collectSpeech(ws as any, "Привет", options("openai")); ws.emit("open");
    const request = JSON.parse(ws.send.mock.calls[0][0]); expect(request.response).toMatchObject({ conversation: "none", tools: [], tool_choice: "none", output_modalities: ["audio"], audio: { output: { voice: "cedar", format: { type:"audio/pcm",rate:24000 } } } });
    expect(request.response.input[0].content[0].text).toBe("Привет");
    for (const delta of ["AQI=", "AwQ="]) ws.emit("message", JSON.stringify({ type: "response.output_audio.delta", delta }));
    ws.emit("message", JSON.stringify({ type: "response.done", response: { status: "completed" } }));
    const a = await p; expect(a.mimeType).toBe("audio/wav"); const b = Buffer.from(a.data); expect(b.readUInt32LE(24)).toBe(24000); expect(b.readUInt32LE(40)).toBe(4); expect([...b.subarray(44)]).toEqual([1,2,3,4]); expect(ws.terminate).toHaveBeenCalledOnce();
  });
  it("cancels immediately and ignores late audio", async () => {
    const ws = new Socket(); const ctl = new AbortController(); const p = collectSpeech(ws as any, "x", { ...options("openai"), signal: ctl.signal }); const failed = expect(p).rejects.toThrow();
    ws.emit("open"); ctl.abort(); await failed; expect(ws.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "response.cancel" })); expect(ws.terminate).toHaveBeenCalledOnce();
    ws.emit("message", JSON.stringify({ type: "response.done", response: { status: "completed" } }));
  });
  it.each(["close","error","failed","empty","malformed"])("refuses %s results", async (kind) => {
    const ws = new Socket(); const p = collectSpeech(ws as any, "x", options("openai")); const bad = expect(p).rejects.toThrow();
    if (kind === "close" || kind === "error") ws.emit(kind);
    else ws.emit("message", kind === "malformed" ? "{" : JSON.stringify({ type: "response.done", response: { status: kind === "empty" ? "completed" : "failed" } }));
    await bad; expect(ws.terminate).toHaveBeenCalledOnce();
  });
});
