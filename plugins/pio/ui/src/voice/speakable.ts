// What Pio says out loud of a reply: its words without Markdown, code or links, cut at a sentence end.

export const SPEAK_MAX = 600;

export function speakable(text: string, max = SPEAK_MAX): string {
  let s = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= max) return s;
  s = s.slice(0, max);
  const end = Math.max(s.lastIndexOf(". "), s.lastIndexOf("! "), s.lastIndexOf("? "), s.lastIndexOf("… "));
  return end > max / 3 ? s.slice(0, end + 1) : `${s.replace(/\s+\S*$/, "")}…`;
}
