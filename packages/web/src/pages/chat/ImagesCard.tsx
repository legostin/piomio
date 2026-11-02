// Pictures an agent shows (an `images` part): one image as a card, more as a swipeable carousel; both open the
// media viewer on the chat's pictures. Sources go through the hub (lib/media.ts), so the page CSP stays strict.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, ImageOff } from "lucide-react";
import type { ImageItem } from "@piomio/shared";
import { activeSlide, mediaSrc } from "../../lib/media";
import { partKey } from "../../lib/gallery";
import { openViewer } from "../../state/viewer";
import { cx } from "../../components/ui";
import { PictureGate } from "../../components/picture";
import { t } from "../../i18n";

type Shown = ImageItem & { url: string; key: string };

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * An image that fades in once loaded, with a quiet placeholder while it loads and when it cannot. `failed` (from a
 * PictureGate) says whether the hub held it: then the gate shows the Show line instead.
 */
function Picture({ src, alt, fit, className, failed }: { src: string; alt: string; fit: "contain" | "cover"; className?: string; failed?: () => Promise<boolean> }) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const img = useRef<HTMLImageElement>(null);
  useEffect(() => {
    setState("loading");
    // Already in the browser cache: the load event may have fired before React listened.
    if (img.current?.complete && img.current.naturalWidth > 0) setState("ok");
  }, [src]);
  if (state === "error") {
    return (
      <div className={cx("flex min-h-40 flex-col items-center justify-center gap-1.5 bg-surface-2 p-4 text-center text-xs text-muted", className)}>
        <ImageOff className="size-5" />
        {t("message.images.failed")}
      </div>
    );
  }
  return (
    <div className={cx("relative overflow-hidden bg-surface-2", state === "loading" && "min-h-40 min-w-56 animate-pulse", className)}>
      <img
        ref={img}
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => setState("ok")}
        onError={() => void (failed?.() ?? Promise.resolve(false)).then((held) => !held && setState("error"))}
        className={cx(
          "block transition-opacity duration-300 ease-out",
          fit === "cover" ? "h-full w-full object-cover" : "max-h-[420px] w-auto max-w-full object-contain",
          state === "ok" ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

function SingleImage({ item, onOpen }: { item: Shown; onOpen: () => void }) {
  return (
    <figure className="inline-flex max-w-full flex-col overflow-hidden rounded-[22px] border border-hairline bg-surface shadow-card sm:max-w-md">
      <PictureGate src={item.url} className="m-2">
        {(src, failed) => (
          <button type="button" data-media-key={item.key} onClick={onOpen} aria-label={item.alt || item.caption || t("message.images.open")} className="group block cursor-zoom-in overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <Picture src={src} alt={item.alt ?? item.caption ?? ""} fit="contain" failed={failed} className="transition-transform duration-300 ease-out group-hover:scale-[1.01]" />
          </button>
        )}
      </PictureGate>
      {item.caption && <figcaption className="px-3.5 py-2.5 text-[13px] leading-snug text-muted">{item.caption}</figcaption>}
    </figure>
  );
}

function Carousel({ items, onOpen }: { items: Shown[]; onOpen: (i: number) => void }) {
  const strip = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const [active, setActive] = useState(0);
  const [edges, setEdges] = useState({ start: true, end: false });

  const measure = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const lefts = Array.from(el.children, (c) => (c as HTMLElement).offsetLeft);
    setActive(activeSlide(lefts, el.scrollLeft, max));
    setEdges({ start: el.scrollLeft <= 2, end: el.scrollLeft >= max - 2 });
  }, []);

  useEffect(() => {
    measure();
    const el = strip.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [measure, items.length]);

  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(measure);
  };

  const go = (i: number) => {
    const el = strip.current;
    const slide = el?.children[Math.max(0, Math.min(items.length - 1, i))] as HTMLElement | undefined;
    if (el && slide) el.scrollTo({ left: slide.offsetLeft, behavior: reducedMotion() ? "auto" : "smooth" });
  };

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      go(active + (e.key === "ArrowRight" ? 1 : -1));
    }
  };

  const arrow = "glass absolute top-1/2 z-10 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-hairline text-fg shadow-card transition duration-200 hover:bg-surface focus-visible:opacity-100";
  return (
    <div className="group/carousel relative max-w-full sm:max-w-xl" role="region" aria-roledescription="carousel" aria-label={t("message.images.carousel", { n: items.length })}>
      <div className="relative">
        <div
          ref={strip}
          onScroll={onScroll}
          onKeyDown={onKey}
          tabIndex={0}
          className="no-scrollbar relative flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {items.map((it, i) => (
            <figure key={`${i}-${it.src}`} className="w-[82%] shrink-0 snap-start sm:w-[68%]" aria-roledescription="slide" aria-label={t("message.images.slide", { n: i + 1, total: items.length })}>
              <PictureGate src={it.url} className="aspect-[4/3] w-full justify-center">
                {(src, failed) => (
                  <button
                    type="button"
                    data-media-key={it.key}
                    onClick={() => onOpen(i)}
                    aria-label={it.alt || it.caption || t("message.images.open")}
                    className="group block w-full cursor-zoom-in overflow-hidden rounded-[20px] border border-hairline bg-surface shadow-card outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <Picture src={src} alt={it.alt ?? it.caption ?? ""} fit="cover" failed={failed} className="aspect-[4/3] w-full transition-transform duration-300 ease-out group-hover:scale-[1.015]" />
                  </button>
                )}
              </PictureGate>
              {it.caption && <figcaption className="mt-1.5 truncate px-1 text-[13px] text-muted" title={it.caption}>{it.caption}</figcaption>}
            </figure>
          ))}
        </div>
        {!edges.start && (
          <button type="button" aria-label={t("message.images.prev")} onClick={() => go(active - 1)} className={cx(arrow, "left-2 opacity-0 group-hover/carousel:opacity-100 max-md:hidden")}>
            <ChevronLeft className="size-4" />
          </button>
        )}
        {!edges.end && (
          <button type="button" aria-label={t("message.images.next")} onClick={() => go(active + 1)} className={cx(arrow, "right-2 opacity-0 group-hover/carousel:opacity-100 max-md:hidden")}>
            <ChevronRight className="size-4" />
          </button>
        )}
      </div>
      <div className="mt-2 flex justify-center gap-1.5">
        {items.map((_, i) => (
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
    </div>
  );
}

export function ImagesCard({ items, messageId, part, conversationId }: { items: ImageItem[]; messageId: string; part: number; conversationId: string }) {
  const shown: Shown[] = items.flatMap((it, i) => {
    const url = mediaSrc(it.src);
    return url ? [{ ...it, url, key: partKey(messageId, part, i) }] : [];
  });
  if (!shown.length) return null;
  const open = (i: number) => openViewer({ kind: "chat", conversationId }, shown[i].key);
  return <div className="my-2">{shown.length === 1 ? <SingleImage item={shown[0]} onOpen={() => open(0)} /> : <Carousel items={shown} onOpen={open} />}</div>;
}
