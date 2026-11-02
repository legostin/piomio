// The docs' Markdown (docs/guide/README.md says which part of it): front matter, `##`–`####` headings, paragraphs,
// `-` and `1.` lists (nested by indentation), fenced code, tables, `>` notes and `---`; inline `code`, **bold**,
// *italic* and [links](url). It runs on both sides: the prerender and the browser parse the same source, so the page
// hydrates without a mismatch. No HTML: a `<` is text.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] };

export type Block =
  | { t: "h"; level: 2 | 3 | 4; c: Inline[]; id: string }
  | { t: "p"; c: Inline[] }
  | { t: "list"; ordered: boolean; start: number; tight: boolean; items: Block[][] }
  | { t: "code"; lang: string; code: string }
  | { t: "table"; align: Array<"left" | "center" | "right" | undefined>; head: Inline[][]; rows: Inline[][][] }
  | { t: "note"; c: Block[] }
  | { t: "hr" };

export interface Meta {
  title: string;
  /** A shorter title for the sidebar. */
  nav?: string;
  description: string;
}

export interface Doc {
  meta: Meta;
  blocks: Block[];
}

/** The front matter (`---` / `key: value` lines / `---`) and the body after it. */
export function frontMatter(source: string): { meta: Record<string, string>; body: string } {
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { meta, body: text.slice(m[0].length) };
}

export function parseDoc(source: string): Doc {
  const { meta, body } = frontMatter(source);
  const ids = new Map<string, number>();
  return {
    meta: { title: meta.title ?? "", ...(meta.nav ? { nav: meta.nav } : {}), description: meta.description ?? "" },
    blocks: parseBlocks(body.split("\n"), ids),
  };
}

// ---- blocks

const FENCE = /^ {0,3}(`{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^ {0,3}(#{2,4})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const HR = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const QUOTE = /^ {0,3}>[ ]?/;
const ITEM = /^( {0,3})([-*+]|(\d{1,9})[.)])([ \t]+|$)(.*)$/;
const TABLE_RULE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const blank = (s: string | undefined) => s === undefined || s.trim() === "";
/** Leading spaces, a tab counting as four. */
const indentOf = (s: string) => s.match(/^[ \t]*/)![0].replace(/\t/g, "    ").length;

/** A line that starts a block of its own, so a paragraph ends before it. */
function startsBlock(line: string): boolean {
  if (FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line)) return true;
  const item = ITEM.exec(line);
  return !!item && item[5].trim() !== "" && (item[3] === undefined || item[3] === "1");
}

function parseBlocks(lines: string[], ids: Map<string, number>): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const indent = indentOf(line);
      const code: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}\`{${fence[1].length},}\\s*$`).test(lines[i])) {
        code.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ""));
        i++;
      }
      i++; // the closing fence (or the end)
      out.push({ t: "code", lang: fence[2], code: code.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const c = parseInline(heading[2]);
      out.push({ t: "h", level: heading[1].length as 2 | 3 | 4, c, id: uniqueId(slugify(plainText(c)), ids) });
      i++;
      continue;
    }

    if (HR.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(lines[i++].replace(QUOTE, ""));
      out.push({ t: "note", c: parseBlocks(inner, ids) });
      continue;
    }

    if (line.includes("|") && TABLE_RULE.test(lines[i + 1] ?? "") && lines[i + 1].includes("-")) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => {
        const s = c.trim();
        return s.startsWith(":") && s.endsWith(":") ? "center" : s.endsWith(":") ? "right" : s.startsWith(":") ? "left" : undefined;
      });
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && !blank(lines[i]) && lines[i].includes("|")) {
        const row = cells(lines[i++]);
        rows.push(head.map((_, k) => parseInline(row[k] ?? "")));
      }
      out.push({ t: "table", align: head.map((_, k) => align[k]), head: head.map((h) => parseInline(h)), rows });
      continue;
    }

    if (ITEM.test(line)) {
      i = parseList(lines, i, out, ids);
      continue;
    }

    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && !blank(lines[i]) && !startsBlock(lines[i])) para.push(lines[i++].trim());
    out.push({ t: "p", c: parseInline(para.join("\n")) });
  }
  return out;
}

/** A list from line `i`: its items, each parsed as blocks of its own. Returns the line after it. */
function parseList(lines: string[], i: number, out: Block[], ids: Map<string, number>): number {
  const first = ITEM.exec(lines[i])!;
  const ordered = first[3] !== undefined;
  const base = first[1].length;
  const marker = ordered ? first[2].slice(-1) : first[2];
  const items: Block[][] = [];
  let tight = true;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || m[1].length !== base || (m[3] !== undefined) !== ordered || (ordered ? m[2].slice(-1) : m[2]) !== marker) break;
    // The item's text starts after the marker and one to four spaces; that is where its other lines are indented to.
    const gap = m[4].length > 4 || m[5] === "" ? 1 : m[4].length;
    const width = base + m[2].length + gap;
    const body: string[] = [m[5]];
    i++;
    let gapInside = false;
    while (i < lines.length) {
      const l = lines[i];
      if (blank(l)) {
        // A blank line stays in the item when what follows is indented into it.
        let j = i;
        while (j < lines.length && blank(lines[j])) j++;
        if (j < lines.length && indentOf(lines[j]) >= width) {
          for (; i < j; i++) body.push("");
          gapInside = true;
          continue;
        }
        break;
      }
      if (indentOf(l) >= width) body.push(l.slice(Math.min(width, l.length - l.trimStart().length)));
      else if (!ITEM.test(l) && !startsBlock(l) && !blank(body[body.length - 1])) body.push(l.trim()); // a lazy continuation
      else break;
      i++;
    }
    const blocks = parseBlocks(body, ids);
    if (gapInside && blocks.length > 1) tight = false;
    items.push(blocks);
    // A blank line between two items makes the list loose.
    let j = i;
    while (j < lines.length && blank(lines[j])) j++;
    const next = j < lines.length ? ITEM.exec(lines[j]) : null;
    if (j > i && next && next[1].length === base && (next[3] !== undefined) === ordered) tight = false;
    if (!next || next[1].length !== base) break;
    i = j;
  }
  out.push({ t: "list", ordered, start: ordered ? Number(first[3]) : 1, tight, items });
  return i;
}

/** A table row's cells; `\|` is a pipe inside a cell. */
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    if (s[k] === "\\" && s[k + 1] === "|") {
      cur += "|";
      k++;
    } else if (s[k] === "|") {
      out.push(cur.trim());
      cur = "";
    } else cur += s[k];
  }
  out.push(cur.trim());
  return out;
}

// ---- inline

const INLINE = /\\([\\`*_[\]()#+\-.!|>~])|(`+)([\s\S]*?[^`])\2(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|\[((?:[^\][]|\\[\][])+)\]\(\s*<?([^)\s>]+)>?\s*\)|\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const push = (v: string) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last?.t === "text") last.v += v;
    else out.push({ t: "text", v });
  };
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    push(text.slice(at, m.index).replace(/\n/g, " "));
    if (m[1] !== undefined) push(m[1]);
    else if (m[2] !== undefined) out.push({ t: "code", v: m[3].replace(/\n/g, " ").replace(/^ (.+) $/, "$1") });
    else if (m[4] !== undefined) out.push({ t: "strong", c: parseInline(m[4]) });
    else if (m[5] !== undefined) out.push({ t: "link", href: m[6], c: parseInline(m[5]) });
    else out.push({ t: "em", c: parseInline(m[7]) });
    at = m.index + m[0].length;
  }
  push(text.slice(at).replace(/\n/g, " "));
  return out;
}

export function plainText(c: Inline[]): string {
  return c.map((n) => (n.t === "text" || n.t === "code" ? n.v : plainText(n.c))).join("");
}

/** A heading's anchor as GitHub makes it: lower case, punctuation dropped, each space a `-`. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

function uniqueId(id: string, ids: Map<string, number>): string {
  const n = ids.get(id);
  ids.set(id, (n ?? -1) + 1);
  return n === undefined ? id : `${id}-${n + 1}`;
}

/** The page's "On this page" list: its `##` and `###` headings. */
export function outline(blocks: Block[]): Array<{ level: 2 | 3; id: string; text: string }> {
  return blocks.flatMap((b) => (b.t === "h" && b.level <= 3 ? [{ level: b.level as 2 | 3, id: b.id, text: plainText(b.c) }] : []));
}

/** Every link in the page, for the checks. */
export function links(blocks: Block[]): string[] {
  const fromInline = (c: Inline[]): string[] => c.flatMap((n) => (n.t === "link" ? [n.href, ...fromInline(n.c)] : n.t === "strong" || n.t === "em" ? fromInline(n.c) : []));
  return blocks.flatMap((b): string[] => {
    switch (b.t) {
      case "h":
      case "p":
        return fromInline(b.c);
      case "list":
        return b.items.flatMap((item) => links(item));
      case "note":
        return links(b.c);
      case "table":
        return [...b.head, ...b.rows.flat()].flatMap(fromInline);
      default:
        return [];
    }
  });
}

/** Every anchor a page has (headings), for the checks. */
export function anchors(blocks: Block[]): string[] {
  return blocks.flatMap((b): string[] => (b.t === "h" ? [b.id] : b.t === "list" ? b.items.flatMap(anchors) : b.t === "note" ? anchors(b.c) : []));
}
