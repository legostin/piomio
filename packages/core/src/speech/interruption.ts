import type { MessagePart } from "@piomio/shared";
import { speakable } from "./text.ts";

export interface HeardPrefix { messageId: string; end: number }

/** Keep completed playback only. Tools/cards stay: interrupting speech does not undo actions. */
export function heardParts(parts: MessagePart[], end: number, marker: string): MessagePart[] {
  if (parts.some((p) => p.type === "text" && p.voiceInterrupted)) return parts;
  const raw = parts.flatMap((p) => p.type === "text" ? [p.text] : []).join("");
  const words = speakable(raw.slice(0, Math.max(0, Math.floor(end))), Number.MAX_SAFE_INTEGER);
  const text: MessagePart = { type: "text", text: [words, `[${marker}]`].filter(Boolean).join("\n\n"), voiceInterrupted: true };
  let inserted = false;
  const out = parts.flatMap((p): MessagePart[] => {
    if (p.type !== "text") return [p];
    if (inserted) return [];
    inserted = true;
    return [text];
  });
  if (!inserted) out.push(text);
  return out;
}

export function heardPrefixes(value: unknown): HeardPrefix[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error("invalid playback acknowledgement");
  const seen = new Set<string>();
  return value.map((p) => {
    if (!p || typeof p.messageId !== "string" || p.messageId.length > 200 || !Number.isSafeInteger(p.end) || p.end < 0 || p.end > 1_000_000 || seen.has(p.messageId))
      throw new Error("invalid playback acknowledgement");
    seen.add(p.messageId);
    return { messageId: p.messageId, end: p.end };
  });
}
