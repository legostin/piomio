import type { HTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { dragRegion } from "../lib/desktop";

/** An opaque, draggable strip above panel controls. Zero height outside a windowed macOS shell.
 * Only the strip is a drag region: buttons, fields and embedded pages below it remain interactive. */
export function WindowTitlebar({ className = "" }: { className?: string }) {
  return <div {...dragRegion()} aria-hidden="true" className={`window-titlebar ${className}`} />;
}

/** Portals escape sheets' clipping/stacking contexts and cover the entire window, including its titlebar. */
export function FullscreenPanel({ children, className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return createPortal(
    <div {...props} className={`window-overlay fixed inset-0 flex flex-col bg-bg ${className}`}>
      <WindowTitlebar />
      {children}
    </div>,
    document.body,
  );
}
