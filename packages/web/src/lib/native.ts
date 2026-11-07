// The Piomio iOS app's bridge (docs/superpowers/specs/2026-10-26-ios-client-design.md, "Chat in a WebView").
//
// The app adds a WKScriptMessageHandlerWithReply named "piomio": the page is in native mode when
// window.webkit.messageHandlers.piomio exists. A call is postMessage({ type, ... }), a Promise of the reply object
// (rejected with the app's reason). The app talks back with `piomio-native` CustomEvents on window.
// Also exported to UI plugins as `native` from "@piomio/ui" (undefined in a browser).

import type { NativeBridge, NativeEvent } from "@piomio/ui";
import { toast } from "../state/toast";
import { t } from "../i18n";

export type { NativeBridge, NativeEvent };

/** The part of `window` the bridge needs (a parameter, so tests can hand in their own). */
export interface NativeHost {
  webkit?: { messageHandlers?: { piomio?: { postMessage(message: unknown): unknown } } };
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
}

export const NATIVE_EVENT = "piomio-native";

/** The reason a bridge call failed, as text (WebKit rejects with an Error carrying the app's message). */
export function nativeErrorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") return (e as { message: string }).message;
  return String(e);
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(nativeErrorText(e));
}

/** The bridge over `host`, or undefined when the page is not inside the app. */
export function createNative(host: NativeHost | undefined): NativeBridge | undefined {
  const handler = host?.webkit?.messageHandlers?.piomio;
  if (!host || !handler || typeof handler.postMessage !== "function") return undefined;

  const call = <T = Record<string, unknown>>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
    let sent: unknown;
    try {
      sent = handler.postMessage({ ...payload, type });
    } catch (e) {
      return Promise.reject(asError(e));
    }
    return Promise.resolve(sent).then(
      (reply) => (reply && typeof reply === "object" ? reply : {}) as T,
      (e: unknown) => {
        throw asError(e);
      },
    );
  };

  return {
    call,
    // `show`: this page can switch to another chat when the app says so (a warm page the app keeps ready).
    ready: (conversationId) => call("ready", { conversationId, show: true }),
    approve: (approvalId) => call("approve", { approvalId }),
    deny: (approvalId) => call("deny", { approvalId }),
    dictation: {
      start: () => call("dictation.start"),
      stop: () => call<{ text?: unknown }>("dictation.stop").then((r) => ({ text: typeof r.text === "string" ? r.text : "" })),
    },
    openURL: (url) => call("openURL", { url }),
    haptic: (kind) => call("haptic", { kind }),
    reauth: () => {
      // No reply: the app gets a new ticket and reloads the page.
      call("reauth").catch(() => {});
    },
    onEvent: (listener) => {
      const h = (e: Event) => {
        const detail = (e as CustomEvent<unknown>).detail as NativeEvent | undefined;
        if (detail && typeof detail === "object" && typeof detail.type === "string") listener(detail);
      };
      host.addEventListener(NATIVE_EVENT, h);
      return () => host.removeEventListener(NATIVE_EVENT, h);
    },
  };
}

/** This page's bridge: set when the page runs inside the Piomio app, undefined in a browser. */
export const native: NativeBridge | undefined = createNative(typeof window === "undefined" ? undefined : (window as unknown as NativeHost));

/**
 * Where a link goes when it leaves the hub (another origin, or mailto:/tel:…), as an absolute URL for Safari;
 * undefined for the hub's own pages and for script/data/blob URLs.
 */
export function outsideUrl(href: string, base: string): string | undefined {
  let url: URL;
  let from: URL;
  try {
    from = new URL(base);
    url = new URL(href, from);
  } catch {
    return undefined;
  }
  if (url.protocol === "javascript:" || url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") return undefined;
  if ((url.protocol === "http:" || url.protocol === "https:") && url.origin === from.origin) return undefined;
  return url.href;
}

/**
 * An <a>'s onClick: inside the app, a link that leaves the hub opens in Safari (the WebView would otherwise try to
 * open it itself). In a browser, or for the hub's own pages, the link works as usual.
 */
export function openOutside(e: { preventDefault(): void; defaultPrevented?: boolean }, href: string | undefined, bridge: NativeBridge | undefined = native): void {
  if (!bridge || !href || e.defaultPrevented) return;
  const url = outsideUrl(href, window.location.href);
  if (!url) return;
  e.preventDefault();
  bridge.openURL(url).catch((err: unknown) => toast(t("link.openFailed", { error: nativeErrorText(err) }), "error"));
}
