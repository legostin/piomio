// A docs page's body: the parsed Markdown (markdown.ts) in the site's look. Code blocks are the guide's CopyBlock;
// links to other pages (`brains.md#…`) go to that page in the same copy of the docs.

import { createContext, useContext, type ReactNode } from "react";
import { CopyBlock } from "../components/CopyBlock";
import type { Block, Inline } from "./markdown";

const LinkContext = createContext<(href: string) => string>((href) => href);

export function DocBody({ blocks, link }: { blocks: Block[]; link: (href: string) => string }) {
  return (
    <LinkContext.Provider value={link}>
      <div className="flex flex-col">{blocks.map((b, i) => renderBlock(b, i, true))}</div>
    </LinkContext.Provider>
  );
}

/** Space above a block: more above a section, none above the first. */
function space(b: Block, i: number, top: boolean): string {
  if (i === 0) return "";
  if (b.t === "h") return b.level === 2 ? (top ? "mt-14" : "mt-8") : "mt-9";
  return top ? "mt-5" : "mt-3";
}

function renderBlock(b: Block, i: number, top: boolean): ReactNode {
  const cls = space(b, i, top);
  switch (b.t) {
    case "h": {
      const Tag = `h${b.level}` as "h2" | "h3" | "h4";
      const size =
        b.level === 2
          ? "font-display text-[clamp(1.4rem,2.4vw,1.8rem)] leading-[1.15] font-extrabold tracking-[-0.02em]"
          : b.level === 3
            ? "font-display text-[18.5px] leading-tight font-bold tracking-[-0.01em]"
            : "text-[16px] font-semibold";
      return (
        <Tag key={i} id={b.id} className={`group scroll-mt-32 text-balance lg:scroll-mt-24 ${size} ${cls}`}>
          <Inlines c={b.c} />
          <a href={`#${b.id}`} aria-hidden="true" tabIndex={-1} className="ml-2 font-sans text-[0.8em] font-normal text-muted opacity-0 transition-opacity group-hover:opacity-100">
            #
          </a>
        </Tag>
      );
    }
    case "p":
      return (
        <p key={i} className={`text-[16px] leading-relaxed text-fg-2 text-pretty ${cls}`}>
          <Inlines c={b.c} />
        </p>
      );
    case "list": {
      const Tag = b.ordered ? "ol" : "ul";
      return (
        <Tag
          key={i}
          start={b.ordered && b.start !== 1 ? b.start : undefined}
          className={`flex flex-col ${b.tight ? "gap-1.5" : "gap-3"} pl-6 text-[16px] leading-relaxed text-fg-2 ${b.ordered ? "list-decimal marker:font-semibold marker:text-muted" : "list-disc marker:text-accent"} ${cls}`}
        >
          {b.items.map((item, k) => (
            <li key={k} className="pl-1 text-pretty">
              {b.tight && item.length > 0 && item[0].t === "p" ? (
                <>
                  <Inlines c={item[0].c} />
                  {item.slice(1).map((inner, j) => renderBlock(inner, j + 1, false))}
                </>
              ) : (
                item.map((inner, j) => renderBlock(inner, j, false))
              )}
            </li>
          ))}
        </Tag>
      );
    }
    case "code":
      return (
        <div key={i} className={cls}>
          <CopyBlock code={b.code} />
        </div>
      );
    case "table":
      return (
        <div key={i} className={`overflow-x-auto rounded-[18px] bg-surface shadow-[var(--shadow)] ${cls}`}>
          <table className="w-full border-collapse text-left text-[14.5px] leading-snug">
            <thead>
              <tr>
                {b.head.map((c, k) => (
                  <th key={k} style={{ textAlign: b.align[k] }} className="px-4 py-3 align-bottom text-[13.5px] font-semibold text-fg">
                    <Inlines c={c} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r} className="border-t border-hairline">
                  {row.map((c, k) => (
                    <td key={k} style={{ textAlign: b.align[k] }} className={`px-4 py-2.5 align-top text-pretty ${k === 0 ? "text-fg" : "text-fg-2"}`}>
                      <Inlines c={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "note":
      return (
        <div key={i} className={`rounded-2xl border-l-4 border-accent bg-accent-soft/60 px-5 py-4 [&_p]:text-fg ${cls}`}>
          {b.c.map((inner, j) => renderBlock(inner, j, false))}
        </div>
      );
    case "hr":
      return <hr key={i} className={`border-hairline ${cls}`} />;
  }
}

function Inlines({ c }: { c: Inline[] }) {
  const link = useContext(LinkContext);
  return (
    <>
      {c.map((n, k) => {
        switch (n.t) {
          case "text":
            return n.v;
          case "code":
            return (
              <code key={k} className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[0.86em] break-words text-fg">
                {n.v}
              </code>
            );
          case "strong":
            return (
              <strong key={k} className="font-semibold text-fg">
                <Inlines c={n.c} />
              </strong>
            );
          case "em":
            return (
              <em key={k}>
                <Inlines c={n.c} />
              </em>
            );
          case "link":
            return (
              <a key={k} href={link(n.href)} className="font-semibold text-accent-text underline-offset-4 hover:underline">
                <Inlines c={n.c} />
              </a>
            );
        }
      })}
    </>
  );
}
