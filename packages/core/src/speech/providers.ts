// The optional Voice providers integration bridges the existing speech API and agent tools.
// Providers run in the plugin sandbox; the hub never reads their keys or contacts their hosts.
import { randomUUID } from "node:crypto";
import type { Locale, SpeechStatus } from "@piomio/shared";
import type { PluginHost } from "../plugins/host.ts";
import type { SpeechEngine } from "./engine.ts";
import { speakable } from "./text.ts";
import { hubLocale, LocalizedError, tFor } from "../i18n.ts";
import { LOCAL_ENGINE_LABEL, TranscribeError, type Engine, type Transcriber } from "../transcribe.ts";

const PLUGIN = "voice-providers";
const LABELS: Record<string, string> = { xai: "Grok (xAI)", elevenlabs: "ElevenLabs", openai: "OpenAI" };
export interface SpokenAudio { data: Buffer; mimeType: string; warning?: string }
export class VoiceProviders {
  private plugins: Pick<PluginHost, "get" | "http">;
  private local: SpeechEngine;
  private transcriber: Transcriber;
  constructor(plugins: Pick<PluginHost, "get" | "http">, local: SpeechEngine, transcriber: Transcriber) {
    this.plugins = plugins; this.local = local; this.transcriber = transcriber;
    transcriber.extension = {
      engine: () => this.engine(),
      transcribe: (data, mime, name, lang, warn) => this.transcribe(data, mime, name, lang, warn),
    };
  }
  selection() {
    const r = this.plugins.get(PLUGIN);
    if (!r?.enabled) return undefined;
    const tts = typeof r.settings.ttsProvider === "string" && Object.hasOwn(LABELS, r.settings.ttsProvider) ? r.settings.ttsProvider : undefined;
    const stt = typeof r.settings.sttProvider === "string" && Object.hasOwn(LABELS, r.settings.sttProvider) ? r.settings.sttProvider : undefined;
    return tts || stt ? { tts, stt, fallback: "local" as const } : undefined;
  }
  status(s: SpeechStatus): SpeechStatus {
    const cloud = this.selection();
    return this.plugins.get(PLUGIN)?.enabled ? { ...s, transcriptionManaged: true, ...(cloud ? { cloud } : {}) } : s;
  }
  private engine(): Engine | null | undefined {
    if (!this.plugins.get(PLUGIN)?.enabled) return undefined;
    const s = this.selection();
    if (!s?.stt) {
      const model = this.local.sttReady();
      return model ? { label: LOCAL_ENGINE_LABEL, model, local: true } : null;
    }
    return { label: LABELS[s.stt], model: String(this.plugins.get(PLUGIN)?.settings[`${s.stt}SttModel`] ?? "default") };
  }
  private async call(path: string, body: Record<string, unknown>, locale: Locale, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    const id = randomUUID();
    const send = (p: string, b: Record<string, unknown>) => this.plugins.http(PLUGIN, { method: "POST", path: p, query: {}, headers: {}, public: false, body: b, locale });
    if (this.plugins.get(PLUGIN)?.status !== "running") throw new LocalizedError("speech.cloudUnavailable", undefined, 503);
    let cancel: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      cancel = () => { void send("/cancel", { id }).catch(() => {}); reject(signal?.reason ?? new Error("cancelled")); };
      signal?.addEventListener("abort", cancel, { once: true });
    });
    try {
      // Enqueue synthesis before its cancellation, including an abort racing with the RPC send.
      const pending = send(path, { ...body, id });
      if (signal?.aborted) cancel?.();
      const r = await Promise.race([pending, interrupted]);
      signal?.throwIfAborted();
      const b = r.body as Record<string, unknown> | undefined;
      if ((r.status ?? 200) >= 400 || !b) {
        const reason = typeof b?.error === "string" ? b.error.slice(0, 500) : tFor(locale)("speech.cloudUnavailable");
        throw new LocalizedError("speech.cloudFailed", { reason }, 502);
      }
      return b;
    } catch (e) {
      signal?.throwIfAborted();
      if (e instanceof LocalizedError) throw e;
      throw new LocalizedError("speech.cloudUnavailable", undefined, 503);
    } finally { if (cancel) signal?.removeEventListener("abort", cancel); }
  }
  async say(text: string, opts: { voice?: unknown; speed?: unknown; language?: unknown; signal?: AbortSignal; locale?: Locale } = {}): Promise<SpokenAudio> {
    const selected = this.selection();
    const local = async () => ({ data: await this.local.say(text, opts), mimeType: "audio/wav" });
    if (!selected?.tts) return local();
    opts.signal?.throwIfAborted();
    const words = speakable(text);
    if (!words) throw new LocalizedError("speech.nothingToSay", undefined, 400);
    const locale = opts.locale ?? hubLocale();
    try {
      const b = await this.call("/say", { text: words, language: opts.language }, locale, opts.signal);
      if (typeof b.data !== "string" || b.data.length > 35_000_000 || !["audio/mpeg", "audio/wav"].includes(String(b.mimeType))) throw new LocalizedError("speech.cloudUnavailable", undefined, 502);
      const data = Buffer.from(b.data, "base64"); if (!data.length) throw new LocalizedError("speech.cloudUnavailable", undefined, 502);
      return { data, mimeType: b.mimeType as string };
    } catch (e) {
      opts.signal?.throwIfAborted();
      const reason = e instanceof LocalizedError ? e.localized(locale) : tFor(locale)("speech.cloudUnavailable");
      try { return { ...await local(), warning: tFor(locale)("speech.cloudFallback", { reason }) }; }
      catch (localError) {
        opts.signal?.throwIfAborted();
        throw new LocalizedError("speech.cloudNoFallback", { reason, local: localError instanceof LocalizedError ? localError.localized(locale) : tFor(locale)("speech.cloudUnavailable") }, 502);
      }
    }
  }
  private async transcribe(data: Buffer, mimeType: string | undefined, name: string, lang?: string, warn?: (warning: string) => void): Promise<string> {
    const locale = hubLocale();
    try {
      const b = await this.call("/transcribe", { data: data.toString("base64"), mimeType, name, language: lang }, locale);
      if (typeof b.text !== "string") throw new LocalizedError("speech.cloudUnavailable", undefined, 502);
      return b.text;
    } catch (e) {
      const reason = e instanceof LocalizedError ? e.localized(locale) : tFor(locale)("speech.cloudUnavailable");
      try {
        const text = await this.transcriber.hearLocally(data, mimeType, lang);
        warn?.(tFor(locale)("speech.cloudFallback", { reason })); return text;
      } catch (e) { throw new TranscribeError(tFor(locale)("speech.cloudNoFallback", { reason, local: e instanceof Error ? e.message : "local speech unavailable" })); }
    }
  }
}
