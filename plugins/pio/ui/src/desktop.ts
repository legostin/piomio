// The desktop app around Pio's window (packages/desktop, src/pio): its commands, granted to this window and the hub's
// origin only, and what it tells the page. Spec: docs/superpowers/plans/2026-11-03-pio-always-on.md, "Stream A".

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Frontmost {
  app: string;
  bundleId?: string;
  title?: string;
  pid: number;
  bounds: Rect;
}

/** The person's window as text (Accessibility; never a password field's). */
export interface WindowText {
  app: string;
  title?: string;
  url?: string;
  document?: string;
  selected?: string;
  focused?: string;
  text: string;
  truncated: boolean;
}

export interface Capture {
  jpeg: string;
  width: number;
  height: number;
  origin: { x: number; y: number };
  scale: number;
}

export type DesktopEvent = { type: "pio-control-ended"; why: "esc" | "mouse" | "timeout" | "ended" } | { type: "pio-hotkey"; state: "pressed" | "released" };

export interface PioDesktop {
  scheme: string;
  pio: boolean;
}

export function desktopOf(w: unknown = globalThis): PioDesktop | undefined {
  const d = (w as { piomioDesktop?: { scheme?: unknown; pio?: unknown } }).piomioDesktop;
  return d && typeof d.scheme === "string" && /^piomio(-test)?$/.test(d.scheme) ? { scheme: d.scheme, pio: d.pio === true } : undefined;
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const ipc = (globalThis as { __TAURI_INTERNALS__?: { invoke?: (c: string, a?: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!ipc?.invoke) return Promise.reject(new Error("not in the desktop app"));
  return ipc.invoke(cmd, args);
}

export const desk = {
  frontmost: () => invoke<Frontmost | null>("pio_frontmost"),
  capture: (target: "window" | "screen", maxSide = 1440) => invoke<Capture>("pio_capture", { target, maxSide }),
  windowText: () => invoke<WindowText>("pio_window_text"),
  frame: (f: { expanded?: boolean; width?: number; height?: number }) => invoke<null>("pio_frame", f),
  permissions: () => invoke<{ screen: boolean; accessibility: boolean }>("pio_permissions"),
  openSettings: (pane: "screen" | "accessibility" | "microphone") => invoke<null>("pio_open_settings", { pane }),
  controlBegin: (reason: string) => invoke<boolean>("pio_control_begin", { reason }),
  controlEnd: () => invoke<null>("pio_control_end"),
  act: (a: Record<string, unknown>) => invoke<null>("pio_act", a),
  hotkey: (on: boolean) => invoke<null>("pio_hotkey", { on }),
  hide: () => invoke<null>("pio_hide"),
};

export function onDesktop(cb: (e: DesktopEvent) => void): () => void {
  const h = (e: Event) => {
    const d = (e as CustomEvent).detail;
    if (d && typeof d.type === "string" && d.type.startsWith("pio-")) cb(d as DesktopEvent);
  };
  addEventListener("piomio-desktop", h);
  return () => removeEventListener("piomio-desktop", h);
}

/** A point of a look (its pixels) on the screen (points). */
export function toScreen(x: number, y: number, c: Pick<Capture, "origin" | "scale">): { x: number; y: number } {
  const s = c.scale > 0 ? c.scale : 1;
  return { x: Math.round((c.origin.x + x / s) * 10) / 10, y: Math.round((c.origin.y + y / s) * 10) / 10 };
}
