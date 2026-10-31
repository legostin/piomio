// What makes the app talk to the demo hub instead of a real one, installed before the app's modules run: `fetch` of
// this origin's /api/* goes to the hub in this page, and a WebSocket to /api/ws is the hub's DemoSocket. Everything else
// (the demo's own files) goes to the network as usual.

import { DemoSocket, type SocketPeer } from "./hub/socket";

export interface ApiPeer {
  handle(method: string, url: URL, body: unknown): Promise<{ status: number; body: unknown }>;
}

function isApi(url: URL): boolean {
  return url.origin === location.origin && url.pathname.startsWith("/api/");
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
  if (raw == null) return undefined;
  if (typeof raw !== "string") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * The demo lives in a frame of the site's page. A browser's scrollIntoView() and focus() scroll every scrolling box
 * around the element, the page outside the frame included: the director's pointer and the app's own focusing would
 * pull the visitor's page back to the demo while they read further down. Here both scroll only this document.
 */
function keepScrollInside(): void {
  const realFocus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (this: HTMLElement, opts?: FocusOptions) {
    realFocus.call(this, { ...opts, preventScroll: true });
  };

  const scrollable = (el: Element) => {
    const s = getComputedStyle(el);
    return (/(auto|scroll|overlay)/.test(s.overflowY) && el.scrollHeight > el.clientHeight) || (/(auto|scroll|overlay)/.test(s.overflowX) && el.scrollWidth > el.clientWidth);
  };
  const offset = (start: number, end: number, boxStart: number, boxEnd: number, where: ScrollLogicalPosition) => {
    if (where === "start") return start - boxStart;
    if (where === "end") return end - boxEnd;
    if (where === "center") return (start + end) / 2 - (boxStart + boxEnd) / 2;
    // "nearest": only as far as it takes to show it.
    if (start < boxStart) return start - boxStart;
    if (end > boxEnd) return Math.min(end - boxEnd, start - boxStart);
    return 0;
  };
  Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
    const o: ScrollIntoViewOptions = typeof arg === "object" ? arg : { block: arg === false ? "end" : "start" };
    const block = o.block ?? "start";
    const inline = o.inline ?? "nearest";
    for (let box = this.parentElement; box; box = box.parentElement) {
      if (!scrollable(box)) continue;
      const r = this.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      const top = offset(r.top, r.bottom, b.top, b.bottom, block);
      const left = offset(r.left, r.right, b.left, b.right, inline);
      if (top || left) box.scrollBy({ top, left, behavior: o.behavior ?? "auto" });
    }
  };
}

export function installShims(api: ApiPeer, sockets: SocketPeer): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, location.href);
    if (!isApi(url)) return realFetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const res = await api.handle(method, url, await readBody(input, init));
    return new Response(res.body === undefined ? "" : JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  };

  // Sign-in pages of services open nowhere in the demo (the hub answers a .invalid address for them).
  const realOpen = window.open.bind(window);
  window.open = (url?: string | URL, target?: string, features?: string) => {
    if (url && /^https:\/\/[^/]*\.invalid\//.test(String(url))) return null;
    return realOpen(url, target, features);
  };

  // The demo's "microphone": a silent stream, so teach mode shows the mic on without asking the visitor for theirs.
  // What the person says appears as captions (director/person.ts speak()). Replaced on the prototype: Safari ignores an
  // own property set on navigator.mediaDevices and would ask for the real microphone.
  const silent = async () => new AudioContext().createMediaStreamDestination().stream;
  if (typeof MediaDevices !== "undefined") Object.defineProperty(MediaDevices.prototype, "getUserMedia", { value: silent, configurable: true, writable: true });
  if (navigator.mediaDevices) Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: silent, configurable: true, writable: true });

  keepScrollInside();

  const RealWebSocket = window.WebSocket;
  const Shim = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const u = new URL(String(url), location.href);
    if (u.pathname === "/api/ws") return new DemoSocket(u.href, sockets);
    return new RealWebSocket(url, protocols);
  } as unknown as typeof WebSocket;
  Object.assign(Shim, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Shim;
}
