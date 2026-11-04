// Pictures in the chat from this device's cache (lib/cache.ts): a preview shown once is drawn from here next time,
// without the hub, and checked against the hub once per page load (a 304 when it is the same). Only the hub's own
// picture routes are kept; what fails to load is left to the <img> itself (its error shows as before).

import { useEffect, useState } from "react";
import { mediaGet, mediaPut, mediaTouch, onCacheCleared, type CachedMedia } from "./cache";

/** Pictures larger than this are shown but not kept. */
const MAX_KEPT = 6 * 1024 * 1024;
/** Object URLs the page holds at most; the oldest are let go. */
const MAX_URLS = 400;

/** Hub addresses worth keeping: workspace files (the chat asks for previews) and the hub's copies of web pictures. */
export function cacheable(url: string): boolean {
  return url.startsWith("/api/files?") || url.startsWith("/api/media?");
}

/** A workspace file's small copy for the chat (the hub's /api/files?preview=1); other addresses stay as they are. */
export function previewSrc(url: string): string {
  return url.startsWith("/api/files?") && !/[?&](preview|download)=/.test(url) ? `${url}&preview=1` : url;
}

const urls = new Map<string, string>();
const loading = new Map<string, Promise<string>>();
const checked = new Set<string>();
const listeners = new Map<string, Set<(u: string) => void>>();

function remember(url: string, blob: Blob): string {
  const old = urls.get(url);
  const obj = URL.createObjectURL(blob);
  urls.delete(url);
  urls.set(url, obj);
  if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
  while (urls.size > MAX_URLS) {
    const [k, v] = urls.entries().next().value as [string, string];
    urls.delete(k);
    URL.revokeObjectURL(v);
  }
  return obj;
}

onCacheCleared(() => {
  for (const v of urls.values()) URL.revokeObjectURL(v);
  urls.clear();
  checked.clear();
});

async function fetchPicture(url: string, etag?: string): Promise<Response> {
  return fetch(url, { credentials: "same-origin", headers: etag ? { "if-none-match": etag } : undefined });
}

async function keep(url: string, res: Response): Promise<string> {
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) throw new Error("not a picture");
  const etag = res.headers.get("etag") ?? undefined;
  if (blob.size <= MAX_KEPT) void mediaPut({ url, blob, etag, size: blob.size, at: Date.now() });
  return remember(url, blob);
}

/** Once a page load: the hub says whether the kept copy is still the picture, else the new one replaces it. */
async function revalidate(url: string, entry: CachedMedia): Promise<void> {
  if (checked.has(url)) return;
  checked.add(url);
  try {
    const res = await fetchPicture(url, entry.etag);
    if (res.status === 304) return void mediaTouch(entry);
    if (!res.ok) return;
    const obj = await keep(url, res);
    for (const cb of listeners.get(url) ?? []) cb(obj);
  } catch {
    // Offline: the kept copy stays.
  }
}

/** The address to draw `url` from: a kept copy, a fresh one (kept for next time) or, when that fails, `url` itself. */
function load(url: string): Promise<string> {
  let p = loading.get(url);
  if (p) return p;
  p = (async () => {
    const entry = await mediaGet(url);
    if (entry) {
      const obj = remember(url, entry.blob);
      void revalidate(url, entry);
      return obj;
    }
    try {
      const res = await fetchPicture(url);
      if (!res.ok) return url;
      checked.add(url);
      return await keep(url, res);
    } catch {
      return url;
    }
  })().finally(() => loading.delete(url));
  loading.set(url, p);
  return p;
}

/**
 * Where an <img> loads `url` from: at once when this page has it, after a moment from the device's cache, else from
 * the hub (then kept). Undefined until then: the caller draws its placeholder.
 */
export function useCachedImage(url: string): string | undefined {
  const keepable = cacheable(url);
  const [src, setSrc] = useState<string | undefined>(() => (keepable ? urls.get(url) : url));
  useEffect(() => {
    if (!keepable) return setSrc(url);
    let gone = false;
    const set = (u: string) => !gone && setSrc(u);
    const own = new Set(listeners.get(url));
    own.add(set);
    listeners.set(url, own);
    const hit = urls.get(url);
    if (hit) setSrc(hit);
    else {
      setSrc(undefined);
      void load(url).then(set);
    }
    return () => {
      gone = true;
      listeners.get(url)?.delete(set);
    };
  }, [url, keepable]);
  return src;
}
