// A menu that opens where it is asked for: at the pointer (a right click, a long press on a touch screen) or under a
// "⋯" button. Arrow keys, Home and End move through it, Enter picks, Escape and Tab close it, as do a click elsewhere,
// a scroll and a resize. It gives the focus back to what had it.

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { placeMenu, type MenuAnchor } from "../lib/menu";
import { cx } from "./ui";

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Red: it destroys something. */
  danger?: boolean;
  /** A thin line above it. */
  divider?: boolean;
  onSelect: () => void;
}

export function ContextMenu({ anchor, items, label, onClose }: { anchor: MenuAnchor; items: MenuItem[]; label?: string; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [restoreTo] = useState(() => document.activeElement as HTMLElement | null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setPos(placeMenu(anchor, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
  }, [anchor]);

  // The first item takes the focus (the keyboard goes on from there); leaving gives it back.
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const el = box.current;
    return () => {
      const lost = !document.activeElement || document.activeElement === document.body || el?.contains(document.activeElement);
      if (lost && restoreTo?.isConnected) restoreTo.focus({ preventScroll: true });
    };
  }, [restoreTo]);

  useEffect(() => {
    const outside = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) closeRef.current();
    };
    const close = () => closeRef.current();
    // Escape also when the focus did not come in (Safari does not focus a clicked button).
    const escape = (e: globalThis.KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", outside, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    const list = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = list.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => list[(n + list.length) % list.length]?.focus();
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      go(i + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      go(i < 0 ? -1 : i - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      go(0);
    } else if (e.key === "End") {
      e.preventDefault();
      go(-1);
    }
  };

  return createPortal(
    <div
      ref={box}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}
      className="animate-zoom fixed z-50 flex w-max max-w-[min(18rem,calc(100vw-16px))] min-w-52 flex-col rounded-2xl border border-hairline bg-surface p-1.5 shadow-pop select-none"
    >
      {items.map((item) => (
        <Fragment key={item.id}>
          {item.divider && <div role="separator" className="mx-2 my-1 h-px bg-hairline" />}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className={cx(
              "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13.5px] outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2",
              item.danger ? "text-danger" : "text-fg",
            )}
          >
            {item.icon && <span className={cx("flex size-4 shrink-0 items-center justify-center", item.danger ? "text-danger" : "text-muted")}>{item.icon}</span>}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}

/** Where a right click (or the keyboard's menu key, which has no pointer) asks for a menu. */
export function menuAnchorFor(e: MouseEvent<HTMLElement>): MenuAnchor {
  const r = e.currentTarget.getBoundingClientRect();
  // The menu key may fire at (0, 0): open under the element instead.
  const byKeyboard = e.clientX === 0 && e.clientY === 0;
  return byKeyboard ? { box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } } : { x: e.clientX, y: e.clientY };
}

/** How long a finger rests on a row before its menu opens. */
const LONG_PRESS_MS = 480;
/** A finger that moves farther than this scrolls instead. */
const SLOP = 10;

/**
 * A long press on a touch screen opens a menu at the finger; the tap that ends it does not also follow the link.
 * Spread the handlers on the element (with `-webkit-touch-callout: none` so iOS does not show its own preview).
 */
export function useLongPress(onLongPress: (anchor: MenuAnchor) => void) {
  const timer = useRef<number | undefined>(undefined);
  const start = useRef({ x: 0, y: 0 });
  const fired = useRef(false);
  const cb = useRef(onLongPress);
  cb.current = onLongPress;
  const clear = () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  useEffect(() => clear, []);
  return {
    onPointerDown: (e: PointerEvent) => {
      fired.current = false;
      if (e.pointerType !== "touch") return;
      start.current = { x: e.clientX, y: e.clientY };
      clear();
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        fired.current = true;
        cb.current({ x: start.current.x, y: start.current.y });
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: PointerEvent) => {
      if (timer.current !== undefined && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > SLOP) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onClickCapture: (e: MouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}
