// Which language Pio hears and speaks: the person's, from their own words (the hub may be set to another language),
// and the voice for a reply's words: an installed one of that language, the person's pick first, a male one next
// (Pio is "he").

export interface VoiceChoice {
  id: string;
  lang: string;
  gender: "male" | "female";
  installed: boolean;
}

/** The language of some words: Russian when they are in Cyrillic, else English. */
export function langOf(text: string): "ru" | "en" {
  const cyr = (text.match(/[а-яё]/gi) ?? []).length;
  const lat = (text.match(/[a-z]/gi) ?? []).length;
  return cyr > 0 && cyr >= lat / 3 ? "ru" : "en";
}

/** The person's language: of their latest words to Pio, else the interface's. */
export function personLang(theirs: string[], locale: string): string {
  const said = theirs.slice(-3).join(" ");
  return said.trim() ? langOf(said) : locale;
}

/** The voice for `lang`: the hub's pick when it speaks it, else a male one, else any (installed only when asked). */
export function voiceFor<V extends VoiceChoice>(lang: string, voices: V[], picked: string, installed: boolean): V | undefined {
  const ok = voices.filter((v) => v.lang === lang && (!installed || v.installed));
  return ok.find((v) => v.id === picked) ?? ok.find((v) => v.gender === "male") ?? ok[0];
}

/** What a line beside the face shows: its first sentence or two, at most `max` characters. */
export function brief(words: string, max = 160): string {
  const s = words.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > 40 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, "")}…`;
}
