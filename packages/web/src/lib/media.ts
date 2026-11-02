// Where the pictures and maps of a message come from. The page CSP loads images from the hub only (img-src 'self'),
// so web images go through the hub's proxy and workspace files through /api/files.

/** OpenStreetMap tiles, fetched and cached by the hub. */
export const TILE_URL = "/api/map/tiles/{z}/{x}/{y}.png";
export const OSM_COPYRIGHT = "https://www.openstreetmap.org/copyright";

/** Sources the page may load as they are: same-origin paths, inline images and blobs. */
export function isLocalSrc(src: string): boolean {
  return (src.startsWith("/") && !src.startsWith("//")) || src.startsWith("data:image/") || src.startsWith("blob:");
}

const proxied = (url: string) => `/api/media?url=${encodeURIComponent(url)}`;

/**
 * The address the page loads an image part's `src` from, or undefined when it cannot be shown. The proxy fetches only
 * pictures the hub decided to show (policy/pictures.ts on the hub). A path is read as the browser will request it
 * ("/./p/…" is "/p/…"): only workspace files load as they are, the proxy in its own form; other hub routes do not
 * (a page's image route would fetch for an agent's words).
 */
export function mediaSrc(src: string): string | undefined {
  const s = src.trim();
  if (s.startsWith("file:")) return s.length > 5 ? `/api/files?path=${encodeURIComponent(s.slice(5))}` : undefined;
  if (/^https?:\/\//i.test(s)) return proxied(s);
  if (s.startsWith("data:image/") || s.startsWith("blob:")) return s;
  if (!isLocalSrc(s)) return undefined;
  let u: URL;
  try {
    u = new URL(s, "http://hub.invalid");
  } catch {
    return undefined;
  }
  if (u.host !== "hub.invalid") return undefined;
  if (u.pathname === "/api/files") return u.pathname + u.search;
  const url = u.pathname === "/api/media" ? u.searchParams.get("url") : null;
  return url && /^https?:\/\//i.test(url.trim()) ? proxied(url.trim()) : undefined;
}

/** For plugins' own UI (`@piomio/ui`): their pictures (a site's icon) load also when the hub never decided about them. */
export function pluginMediaSrc(src: string): string | undefined {
  const s = src.trim();
  if (/^https?:\/\//i.test(s)) return `${proxied(s)}&from=plugin`;
  return s.startsWith("file:") ? mediaSrc(s) : isLocalSrc(s) ? s : undefined;
}

/** The web address a proxied picture stands for, or undefined for any other source. */
export function proxiedUrl(shown: string): string | undefined {
  if (!shown.startsWith("/api/media?")) return undefined;
  const url = new URLSearchParams(shown.slice("/api/media?".length)).get("url");
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

/** The same place on openstreetmap.org, with a marker. */
export function osmLink(lat: number, lon: number, zoom = 16): string {
  const z = Math.max(1, Math.min(19, Math.round(zoom)));
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${z}/${lat}/${lon}`;
}

/** "48.8584, 2.2945": coordinates for people, five decimals at most. */
export function formatCoords(lat: number, lon: number): string {
  const f = (n: number) => String(Math.round(n * 1e5) / 1e5);
  return `${f(lat)}, ${f(lon)}`;
}

/** Index of the slide a carousel shows: the one whose left edge is nearest the scroll position (the last at the end). */
export function activeSlide(slideLefts: number[], scrollLeft: number, maxScroll: number): number {
  if (!slideLefts.length) return 0;
  if (maxScroll > 0 && scrollLeft >= maxScroll - 2) return slideLefts.length - 1;
  let best = 0;
  for (let i = 1; i < slideLefts.length; i++) if (Math.abs(slideLefts[i] - scrollLeft) < Math.abs(slideLefts[best] - scrollLeft)) best = i;
  return best;
}
