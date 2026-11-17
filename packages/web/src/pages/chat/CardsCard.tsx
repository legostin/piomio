// Options an agent shows as cards (a `cards` part, show_cards): places, products, apps. One is a card, more a slider
// the person swipes; a card opens its position full screen (CardDetail), or the page the agent made for it.

import { useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight, LayoutGrid } from "lucide-react";
import type { CardItem } from "@piomio/shared";
import type { CardsPart } from "../../lib/cards";
import { mediaSrc } from "../../lib/media";
import { useStore } from "../../lib/store";
import { useStrip } from "../../lib/strip";
import { ensurePages, pages } from "../../state/pages";
import { cx } from "../../components/ui";
import { PictureGate } from "../../components/picture";
import { t } from "../../i18n";
import { CardDetail, Rating } from "./CardDetail";
import { Picture } from "./ImagesCard";
import { PageViewer } from "./PageCard";

function Tile({ item, chosen, onOpen }: { item: CardItem; chosen: boolean; onOpen: () => void }) {
  const cover = item.images?.[0] ? mediaSrc(item.images[0].src) : undefined;
  return (
    <article className={cx("group relative flex h-full flex-col overflow-hidden rounded-[20px] border bg-surface shadow-card transition", chosen ? "border-accent" : "border-hairline hover:border-fg/20")}>
      <div className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-surface-2">
        {cover ? (
          // Above the card's own button, so a held picture's "Show" can be pressed.
          <PictureGate src={cover} className="relative z-[2] mx-2">
            {(src, failed) => <Picture src={src} alt="" fit="cover" failed={failed} className="size-full transition-transform duration-500 ease-out group-hover:scale-[1.03]" />}
          </PictureGate>
        ) : (
          <span className="flex size-full items-center justify-center bg-gradient-to-br from-accent-soft via-surface-2 to-surface text-accent-text">
            <LayoutGrid className="size-7" strokeWidth={1.5} />
          </span>
        )}
        {item.badge && <span className="glass absolute top-2 left-2 max-w-[80%] truncate rounded-full border border-hairline px-2.5 py-1 text-[11.5px] font-semibold text-fg shadow-card">{item.badge}</span>}
        {chosen && (
          <span className="candy absolute top-2 right-2 flex size-7 items-center justify-center rounded-full" title={t("cards.chosen")}>
            <Check className="animate-pop size-4" strokeWidth={2.6} />
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
        <div className="line-clamp-2 text-[14.5px] leading-snug font-semibold text-balance">{item.title}</div>
        {item.subtitle && <div className="truncate text-[12.5px] text-muted">{item.subtitle}</div>}
        {(item.price || item.rating !== undefined) && (
          <div className="mt-auto flex items-center gap-2.5 pt-1.5 text-[13px]">
            {item.price && <span className="min-w-0 truncate font-semibold">{item.price}</span>}
            {item.rating !== undefined && <Rating value={item.rating} className="shrink-0 text-muted" />}
          </div>
        )}
        {!!item.tags?.length && (
          <div className="flex flex-wrap gap-1 pt-1">
            {item.tags.slice(0, 3).map((tag, i) => (
              <span key={i} className="max-w-full truncate rounded-full bg-surface-2 px-2 py-0.5 text-[11.5px] text-muted">
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
      <button type="button" onClick={onOpen} aria-label={t("cards.open", { title: item.title })} className="absolute inset-0 z-[1] cursor-pointer rounded-[20px] outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset" />
    </article>
  );
}

function Slider({ part, onOpen }: { part: CardsPart; onOpen: (i: number) => void }) {
  const total = part.items.length;
  const { strip, active, edges, fits, onScroll, onKey, go } = useStrip(total);
  const arrow = "glass absolute top-[38%] z-10 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-hairline text-fg shadow-card transition duration-200 hover:bg-surface focus-visible:opacity-100";
  return (
    <div className="group/carousel relative" role="region" aria-roledescription="carousel" aria-label={part.title ?? t("cards.label")}>
      <div className="relative">
        <div
          ref={strip}
          onScroll={onScroll}
          onKeyDown={onKey}
          tabIndex={0}
          className="no-scrollbar relative flex snap-x snap-mandatory gap-2.5 overflow-x-auto overscroll-x-contain rounded-[20px] pb-1.5 outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {part.items.map((item, i) => (
            <div key={i} className="w-[72%] shrink-0 snap-start sm:w-[44%]" aria-roledescription="slide" aria-label={t("cards.slide", { n: i + 1, total })}>
              <Tile item={item} chosen={part.chosen === i} onOpen={() => onOpen(i)} />
            </div>
          ))}
        </div>
        {!edges.start && (
          <button type="button" aria-label={t("cards.prev")} onClick={() => go(active - 1)} className={cx(arrow, "left-2 opacity-0 group-hover/carousel:opacity-100 max-md:hidden")}>
            <ChevronLeft className="size-4" />
          </button>
        )}
        {!edges.end && (
          <button type="button" aria-label={t("cards.next")} onClick={() => go(active + 1)} className={cx(arrow, "right-2 opacity-0 group-hover/carousel:opacity-100 max-md:hidden")}>
            <ChevronRight className="size-4" />
          </button>
        )}
      </div>
      {!fits && (
        <div className="mt-1.5 flex justify-center gap-1.5">
          {part.items.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={t("cards.goto", { n: i + 1 })}
              aria-current={i === active}
              onClick={() => go(i)}
              className={cx("h-1.5 rounded-full transition-all duration-300 ease-out", i === active ? "w-5 bg-accent" : "w-1.5 bg-surface-3 hover:bg-muted")}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function CardsCard({ part, messageId, index, conversationId }: { part: CardsPart; messageId: string; index: number; conversationId: string }) {
  const [open, setOpen] = useState<number>();
  const list = useStore(pages);
  const paged = part.items.some((it) => it.pageId);
  useEffect(() => {
    if (paged) ensurePages();
  }, [paged]);
  if (!part.items.length) return null;

  const shown = open !== undefined ? part.items[open] : undefined;
  // A position with the agent's own page opens that page; one whose page is gone, the built-in one.
  const page = shown?.pageId ? list?.find((p) => p.id === shown.pageId) : undefined;
  const waiting = !!shown?.pageId && !list;
  return (
    <section className="my-2 w-full max-w-full sm:max-w-xl">
      {part.title && <h3 className="mb-2 px-0.5 text-sm font-semibold">{part.title}</h3>}
      {part.items.length === 1 ? (
        <div className="w-full max-w-xs">
          <Tile item={part.items[0]} chosen={part.chosen === 0} onOpen={() => setOpen(0)} />
        </div>
      ) : (
        <Slider part={part} onOpen={setOpen} />
      )}
      {shown && !waiting && (page ? <PageViewer page={page} conversationId={conversationId} onClose={() => setOpen(undefined)} /> : <CardDetail part={part} messageId={messageId} partIndex={index} index={open!} onIndex={setOpen} onClose={() => setOpen(undefined)} />)}
    </section>
  );
}
