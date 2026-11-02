// A catalog string with a little markup, for the guide's text: `code`, **bold** and [a link](url).

import type { ReactNode } from "react";

const TOKEN = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function Rich({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = out.length;
    if (m[1] !== undefined)
      out.push(
        <code key={key} className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[0.86em] break-words text-fg">
          {m[1]}
        </code>,
      );
    else if (m[2] !== undefined)
      out.push(
        <strong key={key} className="font-semibold text-fg">
          {m[2]}
        </strong>,
      );
    else
      out.push(
        <a key={key} href={m[4]} className="font-semibold text-accent-text underline-offset-4 hover:underline">
          {m[3]}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
