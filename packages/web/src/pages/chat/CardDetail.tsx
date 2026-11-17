// A position of the agent's cards, full screen: its pictures, why it fits, the description, the facts, pros and cons,
// where it is on a map, its links, and "Choose", which sends its title to the agent as the person's message. The
// arrows in the header (and ← →) go to the positions beside it without going back to the chat.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronLeft, ChevronRight, Clock, MapPin, Minus, Plus, Sparkles, Star, X } from "lucide-react";
import type { CardItem } from "@piomio/shared";
import { api, errorText } from "../../lib/api";
import { cardMap, cardMedia, linkLabel, type CardsPart } from "../../lib/cards";
import { holdFullscreen } from "../../lib/fullscreen";
import type { MediaItem } from "../../lib/gallery";
import { useStrip } from "../../lib/strip";
import { toast } from "../../state/toast";
import { openViewer, viewer } from "../../state/viewer";
import { FullscreenPanel } from "../../components/WindowTitlebar";
import { Markdown } from "../../components/markdown";
import { PictureGate } from "../../components/picture";
import { cx, Spinner } from "../../components/ui";
import { formatNumber, t } from "../../i18n";
import { Picture } from "./ImagesCard";
import { MapCard } from "./MapCard";

export function Rating({ value, className }: { value: number; className?: string }) {
  const n = formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return (
    <span className={cx("inline-flex items-center gap-1 font-medium tabular-nums", className)} aria-label={t("cards.rating", { n })}>
      <Star className="size-[0.95em] fill-accent text-accent" aria-hidden="true" />
      {n}
    </span>
  );
}

/** The position's pictures: one wide, more as a strip; each opens the media viewer on them. */
function Photos({ media, title }: { media: MediaItem[]; title: string }) {
  const { strip, active, fits, onScroll, onKey, go } = useStrip(media.length);
  const open = (i: number) => openViewer({ kind: "list", items: media }, media[i].key);
  const shot = (m: MediaItem, i: number, frame: string) => (
    <PictureGate src={m.src} className="m-3">
      {(src, failed) => (
        <button type="button" data-media-key={m.key} onClick={() => open(i)} aria-label={t("message.images.open")} className={cx("group block w-full cursor-zoom-in overflow-hidden rounded-[22px] bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-accent", frame)}>
          <Picture src={src} alt={m.caption ?? title} fit="cover" failed={failed} className="size-full transition-transform duration-500 ease-out group-hover:scale-[1.015]" />
        </button>
      )}
    </PictureGate>
  );
  if (media.length === 1) return shot(media[0], 0, "aspect-[16/10]");
  return (
    <div role="region" aria-roledescription="carousel" aria-label={t("message.images.carousel", { n: media.length })}>
      <div ref={strip} onScroll={onScroll} onKeyDown={onKey} tabIndex={0} className="no-scrollbar flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain rounded-[22px] outline-none focus-visible:ring-2 focus-visible:ring-accent">
        {media.map((m, i) => (
          <div key={m.key} className="flex aspect-[4/3] w-[86%] shrink-0 snap-start items-center sm:w-[72%]">
            {shot(m, i, "h-full")}
          </div>
        ))}
      </div>
      {!fits && (
        <div className="mt-2 flex justify-center gap-1.5">
          {media.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={t("message.images.goto", { n: i + 1 })}
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

function Points({ title, items, tone }: { title: string; items: string[]; tone: "pro" | "con" }) {
  const Icon = tone === "pro" ? Plus : Minus;
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-semibold tracking-wide text-muted uppercase">{title}</h2>
      <ul className="flex flex-col gap-1.5 text-[14.5px] leading-snug">
        {items.map((x, i) => (
          <li key={i} className="flex gap-2.5">
            <span className={cx("mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full", tone === "pro" ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>
              <Icon className="size-3" strokeWidth={2.6} />
            </span>
            <span className="min-w-0">{x}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Fact({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 text-[14.5px] leading-snug [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted">
      {icon}
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function Position({ item, media }: { item: CardItem; media: MediaItem[] }) {
  const place = cardMap(item);
  return (
    <article className="animate-fade mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 pt-4 pb-8 sm:px-6 sm:pt-6">
      {!!media.length && <Photos media={media} title={item.title} />}

      <header className="flex flex-col gap-1.5">
        {item.badge && <span className="candy self-start rounded-full px-2.5 py-0.5 text-[12px] font-semibold">{item.badge}</span>}
        <h1 className="text-[22px] leading-tight font-semibold text-balance sm:text-2xl">{item.title}</h1>
        {item.subtitle && <p className="text-[15px] text-muted">{item.subtitle}</p>}
        {(item.price || item.rating !== undefined) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
            {item.price && <span className="text-lg font-semibold">{item.price}</span>}
            {item.rating !== undefined && <Rating value={item.rating} className="text-[15px]" />}
          </div>
        )}
        {!!item.tags?.length && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {item.tags.map((tag, i) => (
              <span key={i} className="rounded-full bg-surface-2 px-2.5 py-1 text-[12.5px] text-muted">
                {tag}
              </span>
            ))}
          </div>
        )}
      </header>

      {item.why && (
        <p className="flex gap-2.5 rounded-2xl bg-accent-soft px-3.5 py-3 text-[14.5px] leading-snug text-accent-text">
          <Sparkles className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">{item.why}</span>
        </p>
      )}

      {item.text && <Markdown text={item.text} className="text-[15px] leading-relaxed" />}

      {!!item.specs?.length && (
        <section>
          <h2 className="mb-2 text-[13px] font-semibold tracking-wide text-muted uppercase">{t("cards.specs")}</h2>
          <dl className="divide-y divide-border overflow-hidden rounded-2xl border border-hairline bg-surface">
            {item.specs.map((s, i) => (
              <div key={i} className="flex gap-4 px-3.5 py-2.5 text-sm">
                <dt className="w-2/5 shrink-0 text-muted">{s.label}</dt>
                <dd className="min-w-0 flex-1 font-medium break-words">{s.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {(!!item.pros?.length || !!item.cons?.length) && (
        <div className="grid gap-5 sm:grid-cols-2">
          {!!item.pros?.length && <Points title={t("cards.pros")} items={item.pros} tone="pro" />}
          {!!item.cons?.length && <Points title={t("cards.cons")} items={item.cons} tone="con" />}
        </div>
      )}

      {(item.address || item.hours || place) && (
        <section className="flex flex-col gap-2.5">
          {item.address && <Fact icon={<MapPin />}>{item.address}</Fact>}
          {item.hours && <Fact icon={<Clock />}>{item.hours}</Fact>}
          {place && <MapCard part={place} />}
        </section>
      )}

      {!!item.links?.length && (
        <div className="flex flex-wrap gap-2">
          {item.links.map((l, i) => (
            <a key={i} href={l.url} target="_blank" rel="noopener noreferrer" className="press inline-flex h-10 max-w-full items-center gap-1.5 rounded-full border border-border bg-surface px-4 text-sm font-medium hover:bg-surface-2">
              <span className="min-w-0 truncate">{linkLabel(l)}</span>
              <ArrowUpRight className="size-4 shrink-0 text-muted" />
            </a>
          ))}
        </div>
      )}
    </article>
  );
}

export function CardDetail({ part, messageId, partIndex, index, onIndex, onClose }: { part: CardsPart; messageId: string; partIndex: number; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const item = part.items[index];
  const total = part.items.length;
  const chosen = part.chosen === index;
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const step = useRef((_by: number) => {});
  step.current = (by) => {
    const next = index + by;
    if (next >= 0 && next < total) onIndex(next);
  };

  // Nothing over the page (lib/fullscreen.ts); Escape closes it, ← → go to the positions beside it.
  useEffect(() => {
    const release = holdFullscreen();
    const key = (e: KeyboardEvent) => {
      // A picture in the viewer or the map full screen is over this page: the keys are theirs.
      if (viewer.get() || document.querySelector("[data-map-full]")) return;
      if (e.key === "Escape") close.current();
      else if (e.key === "ArrowRight") step.current(1);
      else if (e.key === "ArrowLeft") step.current(-1);
    };
    document.addEventListener("keydown", key);
    // The keys are the page's while it is open (the card behind it sits in a strip with arrow keys of its own),
    // and the card's again after.
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    scroller.current?.focus({ preventScroll: true });
    return () => {
      release();
      document.removeEventListener("keydown", key);
      before?.focus({ preventScroll: true });
    };
  }, []);

  // Another position starts from its top.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [index]);

  if (!item) return null;

  const choose = async () => {
    setBusy(true);
    try {
      await api.post(`/api/messages/${encodeURIComponent(messageId)}/pick`, { part: partIndex, index });
      onClose();
    } catch (e) {
      toast(errorText(e), "error");
      setBusy(false);
    }
  };

  const nav = "flex size-10 items-center justify-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <FullscreenPanel className="z-50" role="dialog" aria-label={item.title}>
      <header className="flex items-center gap-1 border-b border-border px-2 pt-[env(safe-area-inset-top)]">
        <button type="button" onClick={onClose} aria-label={t("page.close")} title={t("page.close")} className="flex size-11 items-center justify-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-fg">
          <X className="size-5" />
        </button>
        <span className="min-w-0 flex-1 truncate pr-2 text-[15px] font-semibold">{part.title ?? item.title}</span>
        {total > 1 && (
          <div className="flex shrink-0 items-center">
            <button type="button" className={nav} disabled={index === 0} onClick={() => step.current(-1)} aria-label={t("cards.prev")} title={t("cards.prev")}>
              <ChevronLeft className="size-5" />
            </button>
            <span className="min-w-11 text-center text-[13px] text-muted tabular-nums" aria-label={t("cards.slide", { n: index + 1, total })}>
              {index + 1} / {total}
            </span>
            <button type="button" className={nav} disabled={index === total - 1} onClick={() => step.current(1)} aria-label={t("cards.next")} title={t("cards.next")}>
              <ChevronRight className="size-5" />
            </button>
          </div>
        )}
      </header>
      <div ref={scroller} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none">
        <Position key={index} item={item} media={cardMedia(item, messageId, partIndex, index)} />
      </div>
      {part.pick !== false && (
        <footer className="border-t border-border bg-bg px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
          <button
            type="button"
            disabled={busy || chosen}
            onClick={() => void choose()}
            className={cx("press mx-auto flex h-12 w-full max-w-2xl items-center justify-center gap-2 rounded-2xl text-[15px] font-semibold", chosen ? "bg-surface-2 text-muted" : "candy")}
          >
            {busy ? <Spinner size={16} className="text-current" /> : chosen ? <Check className="size-4" strokeWidth={2.6} /> : null}
            {chosen ? t("cards.chosen") : t("cards.choose")}
          </button>
        </footer>
      )}
    </FullscreenPanel>
  );
}
