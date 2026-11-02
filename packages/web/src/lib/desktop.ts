// The desktop app (packages/desktop) opens its window at `/#desktop=<ticket>`, a one-time sign-in ticket (see
// packages/core/src/desktop-login.ts), and connects its computer to a hub from an `piomio://pair` link. Its hub window
// announces itself as `window.piomioDesktop` and runs links of its scheme itself: `<scheme>://reset`, `<scheme>://quit`.

export interface DesktopApp {
  /** "piomio", or "piomio-test" in the test build. */
  scheme: string;
  test: boolean;
  /** macOS: the window has no title bar; its buttons sit over the page's top-left corner. */
  overlayTitleBar: boolean;
  /** The app's Pio window (the always-on companion floating over every app): it shows only bare plugin routes. */
  pio: boolean;
}

/** The desktop app whose window shows this page, if any. */
export function desktopApp(w: unknown = globalThis): DesktopApp | undefined {
  const d = (w as { piomioDesktop?: Partial<DesktopApp> }).piomioDesktop;
  return d && typeof d.scheme === "string" && /^piomio(-test)?$/.test(d.scheme)
    ? { scheme: d.scheme, test: d.test === true, overlayTitleBar: d.overlayTitleBar === true, pio: d.pio === true }
    : undefined;
}

/** In a window without a title bar: `<html class="owl-titlebar">` (the `titlebar:` variant) while the window's buttons
 * show, that is, not in full screen. */
export function applyDesktopDocument(app = desktopApp()): void {
  if (!app?.overlayTitleBar) return;
  const update = () => document.documentElement.classList.toggle("owl-titlebar", outerWidth < screen.width || outerHeight < screen.height);
  update();
  addEventListener("resize", update);
}

/** Where the window is dragged from when it has no title bar: the element itself, or ("deep") all of it but its
 * buttons, links and fields. */
export function dragRegion(deep = false, app = desktopApp()): { "data-tauri-drag-region"?: string } {
  return app?.overlayTitleBar ? { "data-tauri-drag-region": deep ? "deep" : "" } : {};
}

/** The sign-in ticket in an address fragment, if any. */
export function desktopTicketFrom(hash: string): string | undefined {
  return /^#desktop=([\w-]{32,128})$/.exec(hash)?.[1];
}

/** The link that makes the desktop app connect its computer to this hub as a machine. */
export function pairLink(hubUrl: string, code: string, scheme = desktopApp()?.scheme ?? "piomio"): string {
  return `${scheme}://pair?${new URLSearchParams({ hub: hubUrl, code })}`;
}

/** The web UI is open on a computer other than the hub's (not its own window, not a phone): that computer's desktop
 * app can be connected right here. */
export function onAnotherComputer(hostname: string, userAgent: string, w: unknown = globalThis): boolean {
  if (desktopApp(w)) return false;
  if (/iPhone|iPad|iPod|Android/i.test(userAgent)) return false;
  return !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(hostname);
}

/** Asks the desktop app to show its Pio window (the companion over every app) or to put it away. */
export function desktopPio(app: DesktopApp, show: boolean): void {
  location.href = `${app.scheme}://pio?show=${show ? 1 : 0}`;
}

/**
 * A command of the desktop app, from its Pio window only (the app grants them to that window and the hub's origin):
 * rejects elsewhere.
 */
export function desktopInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>, w: unknown = globalThis): Promise<T> {
  const ipc = (w as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
  if (!ipc?.invoke) return Promise.reject(new Error("not in the desktop app's Pio window"));
  return ipc.invoke(cmd, args);
}

/** Asks the desktop app around this page to quit, or to reset (it confirms that in its own window first). */
export function desktopAction(app: DesktopApp, what: "reset" | "quit"): void {
  location.href = `${app.scheme}://${what}`;
}
