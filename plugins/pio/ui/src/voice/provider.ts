import type { SpeechStatus } from "../hub.ts";
import { langOf, voiceFor } from "./lang.ts";

/** Cloud selection works without local downloads; cancellation never starts a fallback voice. */
export async function speakWithProvider(words: string, signal: AbortSignal, status: SpeechStatus | undefined, io: {
  say(text: string, voice: string | undefined, signal: AbortSignal, language: string): Promise<ArrayBuffer>;
  play(data: ArrayBuffer): Promise<boolean>;
  system(text: string, language: string): Promise<boolean>;
  warning(message: string): void;
}): Promise<boolean> {
  const lang = langOf(words);
  const v = status?.runtime === "ready" ? voiceFor(lang, status.voices, status.voice, true) : undefined;
  if (status?.cloud?.tts || v) {
    try {
      const data = await io.say(words, status?.cloud?.tts ? undefined : v?.id, signal, lang);
      signal.throwIfAborted(); return await io.play(data);
    } catch (e) {
      signal.throwIfAborted();
      if (status?.cloud?.tts) {
        io.warning(e instanceof Error ? e.message : String(e));
        // Browser speech engines can themselves use cloud services: cloud fallback is only the hub's local engine.
        return false;
      }
    }
  }
  signal.throwIfAborted(); return io.system(words, lang);
}

export function needsLocalVoice(status: SpeechStatus | undefined, voiceInstalled: boolean | undefined, sttNeeded: boolean): boolean {
  return !!status && ((!status.cloud?.tts && (status.runtime !== "ready" || voiceInstalled === false)) || sttNeeded);
}
