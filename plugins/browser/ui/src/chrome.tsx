// Small pieces of the browser's frame shared by the desktop and the phone layouts.

import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { Copy, ExternalLink, Globe, GraduationCap, Hand, Loader2, Monitor, MoreHorizontal } from "lucide-react";
import { host, iconSrc, openOutside, send, t } from "./host.ts";

export function IconButton(props: {
  label: string;
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  disabled?: boolean;
  pressed?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`obb-ib${props.className ? ` ${props.className}` : ""}`}
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

/** Icons that did not load (a site without favicon.ico): every tab, row and tile shows a globe without asking again. */
const broken = new Set<string>();

/** A site's icon, a spinner while its page loads, a globe when it has none. */
export function Favicon({ icon, loading }: { icon?: string; loading?: boolean }) {
  const [, setFailed] = useState(0);
  if (loading) return <Loader2 className="obb-glyph obb-spin" aria-hidden />;
  const src = iconSrc(icon);
  if (!src || broken.has(src)) return <Globe className="obb-glyph" aria-hidden />;
  return (
    <img
      className="obb-icon"
      src={src}
      alt=""
      draggable={false}
      onError={() => {
        broken.add(src);
        setFailed((n) => n + 1);
      }}
    />
  );
}

/** Close a popup on a press outside it or on Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Close the menu, not the live view.
      e.preventDefault();
      close();
    };
    document.addEventListener("pointerdown", onDown, true);
    // Capture: ahead of the live view's own Escape, which would close the whole window.
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  return ref;
}

/**
 * "⋯": copy the page's link, open it in the person's own browser, and teach the agent (`onTeach`, left out while a
 * demonstration runs). `up`: the menu opens above the button (the phone's bottom bar).
 */
export function MoreMenu({ url, onTeach, up }: { url: string; onTeach?: () => void; up?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const web = /^https?:\/\//i.test(url);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <IconButton label={t("ui.menu.more")} pressed={open} disabled={!web && !onTeach} onClick={() => setOpen(!open)}>
        <MoreHorizontal />
      </IconButton>
      {open && (
        <div className={`obb-menu${up ? " is-up" : ""}`} role="menu">
          {web && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void navigator.clipboard?.writeText(url).then(
                  () => host.toast(t("ui.menu.copied"), "success"),
                  () => host.toast(url),
                );
              }}
            >
              <Copy aria-hidden />
              {t("ui.menu.copy")}
            </button>
          )}
          {web && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                openOutside(url);
              }}
            >
              <ExternalLink aria-hidden />
              {t("ui.menu.open")}
            </button>
          )}
          {onTeach && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onTeach();
              }}
            >
              <GraduationCap aria-hidden />
              {t("ui.teach.start")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Take control of the browser (a captcha, a sign-in) or hand it back to the agent. */
export function ControlButton({ control, short }: { control: boolean; short?: boolean }) {
  const label = control ? t(short ? "ui.control.returnShort" : "ui.control.return") : t(short ? "ui.control.takeShort" : "ui.control.take");
  return (
    <button
      type="button"
      className={`obb-btn${control ? " is-on" : ""}`}
      title={control ? t("ui.control.return") : t("ui.control.take")}
      onClick={() => send({ type: "control", on: !control })}
    >
      <Hand aria-hidden />
      {label}
    </button>
  );
}

/** Which computer this browser runs on (the hub has several): its sign-ins and history are that computer's own. */
export function MachineChip({ machine }: { machine?: string }) {
  if (!machine) return null;
  return (
    <span className="obb-machine" title={t("ui.machine.hint", { machine })}>
      <Monitor aria-hidden />
      <span className="obb-trunc">{machine}</span>
    </span>
  );
}
