// A horizontal strip of slides that snap (pictures, cards): which slide it shows, whether it stands at an edge, and
// how to go to a slide: with the arrows, the dots, the keyboard.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { activeSlide } from "./media";

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useStrip(count: number) {
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
  }, [measure, count]);

  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(measure);
  };

  const go = (i: number) => {
    const el = strip.current;
    const slide = el?.children[Math.max(0, Math.min(count - 1, i))] as HTMLElement | undefined;
    if (el && slide) el.scrollTo({ left: slide.offsetLeft, behavior: reducedMotion() ? "auto" : "smooth" });
  };

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      go(active + (e.key === "ArrowRight" ? 1 : -1));
    }
  };

  /** Every slide is in view: nothing to scroll to. */
  const fits = edges.start && edges.end;
  return { strip, active, edges, fits, onScroll, onKey, go };
}
