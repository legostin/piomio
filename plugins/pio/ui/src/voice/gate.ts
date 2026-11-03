// Which of the person's phrases are for Pio (spec "Listening"): by default the ones that name it, the ones said while
// the key is held, and the answer right after Pio spoke; "key" only the held ones; "all" everything. The rest is
// dropped, never stored.

export type ListenMode = "name" | "key" | "all";

/** After Pio spoke, the person's next words are an answer for this long. */
export const FOLLOW_MS = 20_000;

/** A listening acknowledgement, not a request to replace the reply. */
export function backchannel(text: string): boolean {
  return /^(?:угу|ага|м[гх]м|да|ясно|понятно|uh[ -]?huh|m+h+m+|yeah|yep|okay|ok)[.!?,…\s]*$/iu.test(text.trim());
}

// Pio as speech-to-text writes it: Пио, Пиа, Пиу, Пью, Пиё, Био, Pio, Pia, Peo, Pío, Bio (the wake phrase: "Пио, …").
const SPELLINGS = "пио|пиo|пиа|пиу|пью|пиё|пийо|био|pio|pia|peo|pío|pyo|bio";
const NAME = new RegExp(`(?<![\\p{L}\\p{N}])(?:${SPELLINGS})(?![\\p{L}\\p{N}])`, "iu");
const LEADING = new RegExp(`^\\s*(?:(?:эй|слушай|hey|ok|okay|ок|окей)[\\s,]+)?(?:${SPELLINGS})(?![\\p{L}\\p{N}])[\\s,.!?:—-]*`, "iu");

// Asking Pio to look at what is on the screen ("погляди, что не так с этим графиком"): the window goes with the words.
const LOOK = new RegExp(
  [
    "посмотр|погляд|глянь|гляну|взгля|видишь|увидь",
    "на экран|что тут|что здесь|что у меня|вот это|вот тут|вот здесь",
    "(?:с |на |в |по )?(?:этим|этот|этой|эту|этого|этом|эта|это) (?:график|диаграм|таблиц|текст|код|файл|окн|слайд|документ|сайт|страниц|письм|картинк|фото|ошибк|формул|схем|макет|дизайн)",
    "\\blook\\b|\\bsee (?:this|that|here)\\b|on (?:my|the) screen|what's (?:this|here|wrong)|\\bthis (?:chart|graph|code|page|text|window|screen|error|table|slide|file|design)",
  ].join("|"),
  "iu",
);

/** The words ask Pio to look at the screen. */
export function asksToLook(text: string): boolean {
  return LOOK.test(text);
}

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
