// Where a menu opens: at the pointer (a right click, a long press), or under the thing it belongs to (a "⋯" button,
// the keyboard's menu key), and always whole on the screen.

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A point (the menu opens there, right and down) or a box (under it, its right edges lined up). */
export type MenuAnchor = { x: number; y: number } | { box: Box };

/** Kept between a menu and the edges of the window. */
const MARGIN = 8;
/** Between a box and the menu under (or over) it. */
const GAP = 4;

/** The menu's top-left corner: flipped to the other side of the anchor when it does not fit, then kept inside. */
export function placeMenu(anchor: MenuAnchor, size: { width: number; height: number }, viewport: { width: number; height: number }): { left: number; top: number } {
  let left: number;
  let top: number;
  if ("box" in anchor) {
    const b = anchor.box;
    left = b.right - size.width;
    top = b.bottom + GAP;
    if (top + size.height > viewport.height - MARGIN && b.top - GAP - size.height >= MARGIN) top = b.top - GAP - size.height;
  } else {
    left = anchor.x;
    top = anchor.y;
    if (left + size.width > viewport.width - MARGIN) left = anchor.x - size.width;
    if (top + size.height > viewport.height - MARGIN) top = anchor.y - size.height;
  }
  const clamp = (v: number, max: number) => Math.max(MARGIN, Math.min(v, max - MARGIN));
  return { left: clamp(left, viewport.width - size.width), top: clamp(top, viewport.height - size.height) };
}
