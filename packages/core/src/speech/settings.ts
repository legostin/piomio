// The hub setting `voice`: which voice speaks and how fast. Unset: the hub language's default voice at normal speed.

import { VOICES, type VoiceSpec } from "./catalog.ts";

export interface VoiceSettings {
  /** A voice id from the catalog (catalog.ts VOICES). */
  voice?: string;
  /** 0.5–2, 1 is normal. */
  speed?: number;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {};
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;

/** Checks a settings value from the person or an agent; returns the cleaned settings or an English error. */
export function cleanVoice(v: unknown, voices: VoiceSpec[] = VOICES): VoiceSettings | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "voice must be an object";
  const o = v as Record<string, unknown>;
  const out: VoiceSettings = {};
  if (o.voice !== undefined && o.voice !== null && o.voice !== "") {
    if (typeof o.voice !== "string" || !voices.some((x) => x.id === o.voice)) return `voice.voice must be one of ${voices.map((x) => x.id).join(", ")}`;
    out.voice = o.voice;
  }
  if (o.speed !== undefined && o.speed !== null) {
    const n = Number(o.speed);
    if (typeof o.speed === "boolean" || !Number.isFinite(n) || n < MIN_SPEED || n > MAX_SPEED) return `voice.speed must be a number from ${MIN_SPEED} to ${MAX_SPEED}`;
    out.speed = Math.round(n * 100) / 100;
  }
  return out;
}
