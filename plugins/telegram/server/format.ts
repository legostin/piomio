// Text formatting for the Telegram Bot API (parse_mode HTML): escaping, a small markdown → HTML converter,
// message splitting under the 4096-character limit, and entities → HTML for editing received messages.

import { isPublicHttpUrl } from "@piomio/shared";

export const TELEGRAM_LIMIT = 4096;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

// Telegram rejects text links and URL buttons it cannot open: the hub's rule for a link that opens from anywhere.
export { isPublicHttpUrl };

const PH = "\u0000";

/** Convert inline markdown (bold, italic, strike, inline code, links) of one line/paragraph to Telegram HTML. */
function inlineToHtml(text: string): string {
  const slots: string[] = [];
  const held = new RegExp(`${PH}(\\d+)${PH}`, "g");
  // What is held may hold more (an escaped bracket in a link's label): it is filled in when it is held.
  const hold = (html: string) => `${PH}${slots.push(html.replace(held, (_, i: string) => slots[Number(i)])) - 1}${PH}`;

  // Inline code first: its content is literal.
  let s = text.replace(/`([^`\n]+)`/g, (_, code: string) => hold(`<code>${escapeHtml(code)}</code>`));
  // Escaped brackets and backslashes are text: "\[" never opens a link, "\]" never closes its label.
  s = s.replace(/\\([\\[\]])/g, (_, c: string) => hold(c));
  // Images ![alt](url): Telegram has no inline images, so a link with a picture sign.
  s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_, alt: string, url: string) => {
    const label = `🖼 ${escapeHtml(alt || url)}`;
    return hold(isPublicHttpUrl(url) ? `<a href="${escapeAttr(url)}">${label}</a>` : label);
  });
  // Links [label](url): keep URLs away from the emphasis regexes.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) =>
    isPublicHttpUrl(url) ? hold(`<a href="${escapeAttr(url)}">${emphasis(escapeHtml(label))}</a>`) : hold(`${emphasis(escapeHtml(label))} (${escapeHtml(url)})`),
  );
  // Bare URLs: Telegram links them itself; just protect them from emphasis.
  s = s.replace(/\bhttps?:\/\/[^\s<>()\u0000]+/g, (url) => hold(escapeHtml(url)));
  s = emphasis(escapeHtml(s));
  return s.replace(held, (_, i: string) => slots[Number(i)]);
}

function emphasis(s: string): string {
  return s
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^\w])__(?=\S)([^_\n]*?\S)__(?![\w])/g, "$1<b>$2</b>")
    .replace(/~~(?=\S)([^~\n]*?\S)~~/g, "<s>$1</s>")
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, "$1<i>$2</i>")
    .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w])/g, "$1<i>$2</i>");
}

/** A markdown table row's cells, without the outer pipes. */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Cell text without markdown marks: tables become monospace blocks, where marks would show as is. */
function plainCell(cell: string): string {
  return cell
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|[^\w])[*_](\S(?:.*?\S)?)[*_](?!\w)/g, "$1$2");
}

/** Telegram has no tables: a markdown table becomes an aligned monospace block. */
function tableBlock(rows: string[][]): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const cells = rows.map((r) => Array.from({ length: cols }, (_, i) => plainCell(r[i] ?? "")));
  const width = Array.from({ length: cols }, (_, i) => Math.max(...cells.map((r) => [...r[i]].length)));
  const line = (r: string[]) => r.map((c, i) => c + " ".repeat(width[i] - [...c].length)).join("  ").trimEnd();
  const [head, ...body] = cells;
  return `<pre>${escapeHtml([line(head), width.map((w) => "─".repeat(w)).join("  "), ...body.map(line)].join("\n"))}</pre>`;
}

/** Markdown (the subset models usually produce) → Telegram HTML. Unclosed code fences run to the end. */
export function markdownToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  // Tables first (a header row, a |---| rule, then rows with pipes); fences are left alone.
  for (let i = 0, inFence = false; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) inFence = !inFence;
    if (inFence || !lines[i].includes("|") || !TABLE_RULE.test(lines[i + 1] ?? "")) continue;
    let end = i + 2;
    while (end < lines.length && lines[end].includes("|") && lines[end].trim()) end++;
    const rows = [lines[i], ...lines.slice(i + 2, end)].map(tableCells);
    lines.splice(i, end - i, `${PH}table${PH}${JSON.stringify(rows)}`);
  }
  let code: string[] | null = null;
  let lang = "";
  for (const line of lines) {
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    if (code) {
      if (fence && !fence[1]) {
        out.push(preBlock(code.join("\n"), lang));
        code = null;
      } else code.push(line);
      continue;
    }
    if (fence) {
      code = [];
      lang = fence[1];
      continue;
    }
    if (line.startsWith(`${PH}table${PH}`)) {
      out.push(tableBlock(JSON.parse(line.slice(PH.length * 2 + 5))));
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push(`<b>${inlineToHtml(heading[1])}</b>`);
      continue;
    }
    const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (task) {
      out.push(`${task[1]}${task[2] === " " ? "☐" : "☑"} ${inlineToHtml(task[3])}`);
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`${bullet[1]}• ${inlineToHtml(bullet[2])}`);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      out.push(`<blockquote>${inlineToHtml(quote[1])}</blockquote>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("———");
      continue;
    }
    out.push(inlineToHtml(line));
  }
  if (code) out.push(preBlock(code.join("\n"), lang));
  // Merge adjacent blockquote lines into one quote.
  return out.join("\n").replace(/<\/blockquote>\n<blockquote>/g, "\n");
}

function preBlock(code: string, lang: string): string {
  const body = escapeHtml(code);
  return lang ? `<pre><code class="language-${escapeAttr(lang)}">${body}</code></pre>` : `<pre>${body}</pre>`;
}

/**
 * Split markdown into chunks of at most `limit` characters, preferring paragraph and line boundaries.
 * A chunk cut inside a code fence is closed and the fence is reopened in the next chunk.
 * Converted HTML never has more visible characters than its markdown source, so each chunk fits the limit.
 */
export function splitMarkdown(md: string, limit = TELEGRAM_LIMIT - 96): string[] {
  const text = md.replace(/\r\n?/g, "\n");
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let lines: string[] = [];
  let len = 0;
  let fence: string | null = null; // language of the open code fence, null outside fences

  const push = (line: string) => {
    len += (lines.length ? 1 : 0) + line.length;
    lines.push(line);
  };
  const flush = () => {
    const body = lines.join("\n") + (fence !== null ? "\n```" : "");
    if (body.trim()) chunks.push(body);
    lines = [];
    len = 0;
    if (fence !== null) push("```" + fence);
  };

  const pieceSize = Math.max(100, limit - 64);
  for (const raw of text.split("\n")) {
    const m = FENCE.exec(raw);
    const closesFence = !!m && fence !== null && !m[1];
    for (let i = 0; i < raw.length || i === 0; i += pieceSize) {
      const piece = raw.slice(i, i + pieceSize);
      const reserve = fence !== null && !closesFence ? 4 : 0;
      if (lines.length && len + 1 + piece.length + reserve > limit) flush();
      push(piece);
    }
    if (m) fence = fence === null ? m[1] : m[1] ? fence : null;
  }
  const rest = lines.join("\n");
  if (rest.trim() && rest.trim() !== "```" + (fence ?? "")) chunks.push(rest);
  return chunks;
}

const FENCE = /^\s*```\s*([\w+#.-]*)\s*$/;

export interface MessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
}

/** Rebuild Telegram HTML from a received message's text + entities (offsets are UTF-16, like JS strings). */
export function entitiesToHtml(text: string, entities: MessageEntity[] = []): string {
  const tags: Record<string, [string, string] | ((e: MessageEntity) => [string, string])> = {
    bold: ["<b>", "</b>"],
    italic: ["<i>", "</i>"],
    underline: ["<u>", "</u>"],
    strikethrough: ["<s>", "</s>"],
    spoiler: ["<tg-spoiler>", "</tg-spoiler>"],
    code: ["<code>", "</code>"],
    blockquote: ["<blockquote>", "</blockquote>"],
    expandable_blockquote: ["<blockquote expandable>", "</blockquote>"],
    pre: (e) => (e.language ? [`<pre><code class="language-${escapeAttr(e.language)}">`, "</code></pre>"] : ["<pre>", "</pre>"]),
    text_link: (e) => [`<a href="${escapeAttr(e.url ?? "")}">`, "</a>"],
  };
  const opens = new Map<number, Array<{ end: number; tag: string }>>();
  const closes = new Map<number, string[]>();
  const sorted = [...entities].filter((e) => tags[e.type]).sort((a, b) => a.offset - b.offset || b.length - a.length);
  for (const e of sorted) {
    const t = tags[e.type];
    const [open, close] = typeof t === "function" ? t(e) : t;
    const end = e.offset + e.length;
    (opens.get(e.offset) ?? opens.set(e.offset, []).get(e.offset)!).push({ end, tag: open });
    (closes.get(end) ?? closes.set(end, []).get(end)!).unshift(close);
  }
  let out = "";
  for (let i = 0; i <= text.length; i++) {
    const c = closes.get(i);
    if (c) out += c.join("");
    const o = opens.get(i);
    if (o) out += o.map((x) => x.tag).join("");
    if (i < text.length) out += escapeHtml(text[i]);
  }
  return out;
}

/** Strip tags and decode entities: plain-text fallback when Telegram rejects our HTML. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}
