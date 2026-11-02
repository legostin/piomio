// Which of the person's phrases are for Pio (spec "Listening"): by default the ones that name it, the ones said while
// the key is held, and the answer right after Pio spoke; "key" only the held ones; "all" everything. The rest is
// dropped, never stored.

export type ListenMode = "name" | "key" | "all";

/** After Pio spoke, the person's next words are an answer for this long. */
export const FOLLOW_MS = 20_000;

// Pio as speech-to-text writes it: Пио, Пиo, Пиа, Пью, Pio, Pia, Peo, Pío.
const NAME = /(?<![\p{L}\p{N}])(?:пио|пиo|пиа|пью|pio|pia|peo|pío)(?![\p{L}\p{N}])/iu;
const LEADING = /^\s*(?:(?:эй|слушай|hey|ok|okay|ок)[\s,]+)?(?:пио|пиo|пиа|пью|pio|pia|peo|pío)(?![\p{L}\p{N}])[\s,.!:—-]*/iu;

export function namesPio(text: string): boolean {
  return NAME.test(text);
}

/** The words for Pio, or undefined when the phrase is not for it; "Pio, …" at the start is taken off. */
export function forPio(text: string, mode: ListenMode, o: { keyHeld: boolean; now: number; followUntil: number }): string | undefined {
  const words = text.replace(/\s+/g, " ").trim();
  if (!words) return undefined;
  const addressed = mode === "all" || o.keyHeld || (mode === "name" && (namesPio(words) || o.now < o.followUntil));
  if (!addressed) return undefined;
  const rest = words.replace(LEADING, "").trim();
  return rest || words;
}
