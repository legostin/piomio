// Provider wire formats are isolated here; no keys, audio, or upstream error bodies are logged.
export type ProviderId = "xai" | "elevenlabs" | "openai";
export const IDS: ProviderId[] = ["xai", "elevenlabs", "openai"];
export const LABELS = { xai: "Grok (xAI)", elevenlabs: "ElevenLabs", openai: "OpenAI" };
export const KEYS = { xai: "xai_api_key", elevenlabs: "elevenlabs_api_key", openai: "openai_api_key" };
export const DEFAULTS = {
  xai: { voice: "rex", sttModel: "grok-voice-transcribe-2.0", ttsModel: "" },
  elevenlabs: { voice: "JBFqnCBsd6RMkjVDRZzb", sttModel: "scribe_v2", ttsModel: "eleven_flash_v2_5" },
  openai: { voice: "cedar", sttModel: "gpt-transcribe", ttsModel: "gpt-realtime-2.1-mini" },
};
export type Failure = "key" | "auth" | "quota" | "request" | "unavailable" | "timeout" | "response" | "busy";
export class VoiceError extends Error {
  code: Failure;
  constructor(code: Failure) { super(code); this.code = code; }
}
export interface Audio { data: Uint8Array; mimeType: "audio/mpeg" | "audio/wav" }
export interface Options { model: string; voice: string; language?: string; signal: AbortSignal }
export interface SpeechProvider {
  synthesize(text: string, options: Options): Promise<Audio>;
  transcribe(data: Uint8Array, mimeType: string, name: string, options: Options): Promise<string>;
}
export type Transport = typeof fetch;
export const MAX_AUDIO = 25 * 1024 * 1024;
export const errorForStatus = (status: number): Failure => status === 401 || status === 403 ? "auth" : status === 429 || status === 402 ? "quota" : status >= 500 ? "unavailable" : "request";

async function bytes(res: Response, limit = MAX_AUDIO): Promise<Uint8Array> {
  if (!res.body) throw new VoiceError("response");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) throw new VoiceError("response");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return new Uint8Array(Buffer.concat(chunks));
}

export function provider(id: ProviderId, key: string, transport: Transport = fetch,
  realtime?: (text: string, o: Options, key: string) => Promise<Audio>): SpeechProvider {
  const origin = { xai: "https://api.x.ai/v1", elevenlabs: "https://api.elevenlabs.io/v1", openai: "https://api.openai.com/v1" }[id];
  const headers = { "user-agent": "Piomio/voice-providers", ...(id === "elevenlabs" ? { "xi-api-key": key } : { authorization: `Bearer ${key}` }) };
  const request = async (path: string, body: FormData | string, signal: AbortSignal) => {
    signal.throwIfAborted();
    const res = await transport(origin + path, { method: "POST", redirect: "error", headers: { ...headers, ...(typeof body === "string" ? { "content-type": "application/json" } : {}) }, body, signal });
    if (!res.ok) { await res.body?.cancel(); throw new VoiceError(errorForStatus(res.status)); }
    return res;
  };
  return {
    async synthesize(text, o) {
      if (id === "openai" && o.model.startsWith("gpt-realtime")) {
        if (!realtime) throw new VoiceError("request");
        return realtime(text, o, key);
      }
      const [path, body] = id === "xai" ? ["/tts", { text, voice_id: o.voice, language: o.language || "auto" }]
        : id === "elevenlabs" ? [`/text-to-speech/${encodeURIComponent(o.voice)}?output_format=mp3_44100_128`, { text, model_id: o.model }]
        : ["/audio/speech", { input: text, model: o.model, voice: o.voice, response_format: "mp3" }];
      const res = await request(path as string, JSON.stringify(body), o.signal);
      const type = res.headers.get("content-type")?.split(";")[0];
      if (type && !["audio/mpeg", "audio/mp3", "application/octet-stream"].includes(type)) { await res.body?.cancel(); throw new VoiceError("response"); }
      const data = await bytes(res);
      // MP3 frame sync or ID3; do not hand an HTML/JSON error to the audio decoder.
      if (data.length < 4 || !(Buffer.from(data.subarray(0, 3)).toString() === "ID3" || (data[0] === 255 && (data[1] & 224) === 224))) throw new VoiceError("response");
      return { data, mimeType: "audio/mpeg" };
    },
    async transcribe(data, mimeType, name, o) {
      const form = new FormData();
      form.append(id === "elevenlabs" ? "model_id" : "model", o.model);
      if (o.language) form.append(id === "elevenlabs" ? "language_code" : id === "openai" && /^gpt-transcribe(?:-|$)/.test(o.model) ? "languages[]" : "language", o.language);
      if (id === "openai") form.append("response_format", "json");
      if (id === "elevenlabs") { form.append("tag_audio_events", "false"); form.append("timestamps_granularity", "none"); }
      // xAI consumes fields before the file; fields after it may be ignored.
      form.append("file", new Blob([new Uint8Array(data)], { type: mimeType }), name);
      const res = await request(id === "xai" ? "/stt" : id === "elevenlabs" ? "/speech-to-text" : "/audio/transcriptions", form, o.signal);
      let result: unknown;
      try { result = JSON.parse(Buffer.from(await bytes(res, 1024 * 1024)).toString()); } catch { throw new VoiceError("response"); }
      if (!result || typeof (result as { text?: unknown }).text !== "string") throw new VoiceError("response");
      return (result as { text: string }).text.trim();
    },
  };
}
