// News an agent shows in its reply (a `news` part, show_news): a compact list of cards (title and link, a couple of
// lines, the source, a small picture), and the channel they come from, when they do.

import { Link } from "wouter";
import { ChevronRight, Newspaper } from "lucide-react";
import type { MessagePart } from "@piomio/shared";
import { useStore } from "../../lib/store";
import { feedPath } from "../../lib/feeds";
import { mediaSrc } from "../../lib/media";
import { QuietImg } from "../../components/picture";
import { shortTime } from "../../lib/format";
import { feeds } from "../../state/feeds";
import { t } from "../../i18n";
import { ChannelTile } from "../channels/ChannelTile";

type NewsPart = Extract<MessagePart, { type: "news" }>;

export function NewsCard({ part }: { part: NewsPart }) {
  const list = useStore(feeds);
  const channel = part.feedId ? list?.find((f) => f.id === part.feedId) : undefined;
  const heading = part.title ?? channel?.title;
  return (
    <figure className="w-full max-w-xl overflow-hidden rounded-[22px] border border-hairline bg-surface shadow-card" aria-label={heading ?? t("news.label")}>
      {(heading || part.feedId) && (
        <figcaption className="flex items-center gap-2.5 px-3.5 pt-3 pb-1 text-sm">
          {part.feedId ? <ChannelTile feedId={part.feedId} size={22} /> : <Newspaper className="size-4 shrink-0 text-muted" />}
          <span className="min-w-0 flex-1 truncate font-semibold">{heading ?? t("news.label")}</span>
          {part.feedId && (
            <Link href={feedPath(part.feedId)} className="press inline-flex shrink-0 items-center gap-0.5 rounded-full py-0.5 pr-1.5 pl-2.5 text-[12.5px] font-medium text-muted hover:bg-surface-2 hover:text-fg">
              {t("news.openChannel")}
              <ChevronRight className="size-3.5" />
            </Link>
          )}
        </figcaption>
      )}
      <ul className="px-1.5 pb-1.5">
        {part.items.map((item, i) => {
          const img = item.image ? mediaSrc(item.image) : undefined;
          const meta = [item.source, item.at ? shortTime(item.at) : ""].filter(Boolean).join(" · ");
          const body = (
            <>
              <div className="min-w-0 flex-1">
                <div className="text-[14.5px] leading-snug font-semibold text-balance">{item.title}</div>
                {item.text && <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-muted">{item.text.replace(/[*_`#>]/g, "")}</p>}
                {meta && <div className="mt-1 text-[11.5px] font-medium text-muted/80">{meta}</div>}
              </div>
              {img && <QuietImg src={img} alt="" loading="lazy" className="size-[68px] shrink-0 rounded-[14px] object-cover shadow-[inset_0_0_0_1px_rgb(0_0_0/0.06)]" />}
            </>
          );
          return (
            <li key={i}>
              {item.url ? (
                <a href={item.url} target="_blank" rel="noopener noreferrer" className="flex gap-3 rounded-2xl px-2 py-2.5 transition-colors hover:bg-surface-2/70">
                  {body}
                </a>
              ) : (
                <div className="flex gap-3 px-2 py-2.5">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
