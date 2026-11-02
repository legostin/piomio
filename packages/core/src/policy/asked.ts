// The person's own words as their yes (ToolSpec.asked). An agent that does what the person asked for in so many words
// quotes them (`asked`), and the hub checks the quote against what it knows itself, never against the agent's say:
// the words are in one of the person's own recent messages; the action's kind is in them (a control's «Remove» ←
// «удалите»); every other word on the control is in them too («Delete domain» is not «delete the records»); and the
// person named the site. Then the action runs without a card. Money never goes this way.

import type { AskedKind, AskedSpec } from "@piomio/shared";
import { hostOf } from "@piomio/shared";

/** A lowercase letter, Latin or Cyrillic: the edges of words (JS \b is ASCII-only). */
const LETTER = "a-z0-9\\u0430-\\u044f\\u0451";
const word = (alternatives: string) => new RegExp(`(?<![${LETTER}])(?:${alternatives})(?![${LETTER}])`, "u");

/** Verbs of each kind in English (with -s, -d, -ed) and Russian (imperative and infinitive: the person's words and a Russian site's buttons). */
const KINDS: Record<AskedKind, RegExp> = {
  delete: word(
    "(?:delete|remove|erase|destroy|discard|clear|trash|wipe)(?:s|d|ed)?|" +
      "удал(?:и|ите|ить|яй|яйте)|сотри|сотрите|стереть|уничтожь|уничтожьте|уничтожить|убери|уберите|убрать|очисти|очистите|очистить",
  ),
  send: word("(?:send|submit|reply|forward|resend)(?:s|ed)?|отправь|отправьте|отправить|пошли|пошлите|послать|ответь|ответьте|ответить|перешли|перешлите|переслать"),
  publish: word(
    "(?:publish|post|share|tweet|repost|retweet)(?:s|d|ed)?|" +
      "опубликуй|опубликуйте|опубликовать|выложи|выложите|выложить|запости|запость|запостить|размести|разместите|разместить|поделись|поделитесь",
  ),
  upload: word("(?:upload|attach)(?:s|ed)?|загрузи|загрузите|загрузить|прикрепи|прикрепите|прикрепить|залей|залейте|залить|выложи|выложите|выложить"),
  confirm: word("(?:confirm|submit|approve|verify|accept)(?:s|d|ed)?|подтверди|подтвердите|подтвердить|одобри|одобрите|одобрить|прими|примите|принять"),
  unsubscribe: word("unsubscribe[sd]?|отпишись|отпишитесь|отписаться|отпиши|отпишите"),
};

/** Words of paying, ordering, booking and signing up for something: a control with one always asks. */
const MONEY = word(
  "buy|purchase|pay|payment|checkout|check\\s*out|order|transfer|withdraw|deposit|top\\s*up|sell|bid|donate|book|reserve|subscribe|upgrade|renew|" +
    "куп(?:и|ите|ить)|покупк\\p{L}*|оплат\\p{L}*|заказ\\p{L}*|оформ\\p{L}*|перевед\\p{L}*|перевест\\p{L}*|пожертв\\p{L}*|спис\\p{L}*|прода\\p{L}*|" +
    "вывест\\p{L}*|вывед\\p{L}*|пополн\\p{L}*|ставк\\p{L}*|брон\\p{L}*|подпис\\p{L}*|подпиш\\p{L}*|продл\\p{L}*",
);

/** Words on a control that say nothing about what it does. */
const FILLER = new Set(["the", "and", "for", "this", "that", "these", "those", "your", "you", "my", "our", "its", "with", "from", "now", "here", "это", "эту", "этот", "для"]);

/** Lowercase words of letters and digits: quotes, arrows, dashes and ё make no difference. */
function words(s: string): string[] {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The site's own name in a URL: «namecheap» for ap.www.namecheap.com, «example» for shop.example.co.uk, and its domain. */
export function siteOf(url: string): { name: string; domain: string } | undefined {
  const labels = hostOf(url).replace(/^www\./, "").split(".").filter(Boolean);
  if (labels.length < 2) return undefined;
  let i = labels.length - 2;
  if (i > 0 && labels[i].length <= 3 && labels[labels.length - 1].length === 2) i--;
  return { name: labels[i], domain: labels.slice(i).join(".") };
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Is `s` written in `text`? Both as whole words, so a part of a word is not. */
const wordsIn = (s: string[], text: string[]) => s.length > 0 && ` ${text.join(" ")} `.includes(` ${s.join(" ")} `);

/** What the person wrote lately: their messages' text (voice notes as transcripts) and the names of the files they sent. */
export interface PersonWords {
  texts: string[];
  files: string[];
}

export interface AskedCheck {
  ok: boolean;
  /** For the audit log: why the words count, or why the card is still needed. */
  reason: string;
}

/**
 * Do the person's words (`input.asked`, checked against what they wrote lately) ask for this very call? Pure: the
 * gateway gathers what the person wrote.
 */
/** Words of paying, ordering, booking or signing up in a text (a control's label, a card's line): always the person's. */
export function moneyIn(text: string): boolean {
  return MONEY.test(words(text).join(" "));
}

/** Words of sending something to people or publishing it in a text. */
export function sendsOrPublishes(text: string): boolean {
  const said = words(text).join(" ");
  return KINDS.send.test(said) || KINDS.publish.test(said);
}

export function checkAsked(spec: AskedSpec, input: unknown, person: PersonWords): AskedCheck {
  const no = (reason: string): AskedCheck => ({ ok: false, reason });
  const field = (name: string | undefined) => (name && input && typeof input === "object" ? (input as Record<string, unknown>)[name] : undefined);
  const quote = typeof field("asked") === "string" ? words(field("asked") as string) : [];
  if (!quote.length) return no("no words of the person were given");
  const amount = field(spec.amount);
  if (amount !== undefined && amount !== null) return no("it spends money");
  const label = typeof field(spec.label) === "string" ? (field(spec.label) as string) : "";
  if (!label && !spec.kind) return no("the tool says nothing about what the action is");
  if (label && MONEY.test(label.toLowerCase())) return no("its control pays, orders or signs up: money always asks");

  // «Post this photo» says nothing of which file: only ones the person sent go without a card.
  if (spec.files) {
    const files = field(spec.files);
    const list = (Array.isArray(files) ? files : [files]).filter((f): f is string => typeof f === "string" && !!f.trim());
    const theirs = new Set(person.files.map(baseName));
    if (!list.length) return no("the action sends no files");
    const other = list.find((f) => !theirs.has(baseName(f)));
    if (other) return no(`«${baseName(other)}» is not a file the person sent`);
  }

  const texts = person.texts.map(words);
  if (!texts.some((t) => wordsIn(quote, t))) return no("the quoted words are not in the person's messages");

  const said = quote.join(" ");
  const kinds = spec.kind ? [spec.kind] : (Object.keys(KINDS) as AskedKind[]).filter((k) => KINDS[k].test(words(label).join(" ")));
  const kind = kinds.find((k) => KINDS[k].test(said));
  if (!kind) return no(`the words do not ask for ${label ? `«${label}»` : spec.kind}`);
  // The rest of the control's name must be in the person's words as well (by its stem: «records» ← «record»).
  for (const w of words(label)) {
    if (w.length < 3 || FILLER.has(w) || Object.values(KINDS).some((re) => re.test(w))) continue;
    const stem = w.slice(0, 5);
    if (!quote.some((q) => q.startsWith(stem))) return no(`«${w}» on the control is not in the words`);
  }

  const site = siteOf(String(field(spec.site) ?? ""));
  if (!site) return no("the action has no site");
  const all = ` ${texts.map((t) => t.join(" ")).join(" ")} `;
  const named = wordsIn(words(site.domain), all.trim().split(" ")) || (site.name.length >= 4 && all.includes(site.name));
  if (!named) return no(`the person did not name ${site.domain}`);
  return { ok: true, reason: `the person asked for it: ${kind} on ${site.domain}` };
}
