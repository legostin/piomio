// What a voice reads of an agent's Markdown: the words, without markup, code, links' addresses or pictures.

/** Longest text spoken at once. */
export const MAX_SPOKEN_CHARS = 1000;

/** Markdown → plain sentences for speaking, cut at `max` characters (at a sentence or word end). */
export function speakable(markdown: string, max = MAX_SPOKEN_CHARS): string {
  let s = String(markdown ?? "").replace(/\r\n?/g, "\n");
  // Code blocks are not read out.
  s = s.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]*\1[^\n]*$|(?![\s\S]))/gm, "\n");
  s = s.replace(/<[^>\n]+>/g, " ");
  // Pictures and links: their words, not their addresses.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  s = s.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "");
  s = s.replace(/\bhttps?:\/\/\S+/g, " ");
  const lines: string[] = [];
  for (let line of s.split("\n")) {
    // Rules and table separators carry no words.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) continue;
    line = line
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s*>+\s?/, "")
      .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?/, "");
    // A table row: its cells as a list.
    if (/^\s*\|.*\|\s*$/.test(line))
      line = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean)
        .join(", ");
    line = line
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
      .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1$2")
      .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
      .replace(/`+([^`]*)`+/g, "$1")
      .replace(/\p{Extended_Pictographic}️?/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!line) continue;
    // A heading or a list item ends where its line does: a pause before the next.
    lines.push(/[.!?…:;,]$/.test(line) ? line : `${line}.`);
  }
  return cut(lines.join(" "), max);
}

function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.lastIndexOf("… "));
  if (sentence > max / 2) return head.slice(0, sentence + 1);
  const space = head.lastIndexOf(" ");
  return (space > max / 2 ? head.slice(0, space) : head).trimEnd();
}
