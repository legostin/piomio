// An agent's library as the page shows it (GET /api/library): where each item's picture and file load from, what
// the media viewer gets, and how the "All" view splits it into shelves.

import type { LibraryItem, LibraryKind } from "@piomio/shared";
import { fileHref, imageDownload, mediaKind, type MediaItem } from "./gallery";
import { mediaSrc } from "./media";

export type LibraryFilter = "all" | LibraryKind;
export const LIBRARY_SHELVES: LibraryKind[] = ["page", "media", "file", "audio"];

/** How many items a shelf shows in the "All" view before "Show all". */
export const SHELF_PREVIEW: Record<LibraryKind, number> = { page: 4, media: 12, file: 5, audio: 4 };

export interface LibraryPageData {
  items: LibraryItem[];
  more: boolean;
}

/** The query string of a library request. */
export function libraryQuery(agentId: string, opts: { kind?: LibraryFilter; q?: string; before?: string; limit?: number } = {}): string {
  const p = new URLSearchParams({ agent: agentId });
  if (opts.kind && opts.kind !== "all") p.set("kind", opts.kind);
  if (opts.q?.trim()) p.set("q", opts.q.trim());
  if (opts.before) p.set("before", opts.before);
  if (opts.limit) p.set("limit", String(opts.limit));
  return `/api/library?${p}`;
}

/** Whether an item is a picture or a video, and which. */
export function itemMediaKind(it: LibraryItem): "image" | "video" | undefined {
  if (it.kind !== "media") return undefined;
  if (it.src && !it.path) return "image";
  return mediaKind(it.mimeType) ?? (it.src ? "image" : undefined);
}

/** The small picture of an item: a workspace file's preview, a web picture through the proxy, a page's cover. */
export function thumbSrc(it: LibraryItem): string | undefined {
  if (it.kind === "page") return it.src ? mediaSrc(it.src) : undefined;
  if (it.path && itemMediaKind(it) === "image") return `${fileHref(it.path)}&preview=1`;
  if (it.src) return mediaSrc(it.src);
  return undefined;
}

/** Where the file itself loads from (open or play it). */
export function itemHref(it: LibraryItem, download = false): string | undefined {
  if (it.path) return fileHref(it.path, download);
  if (it.src && !download) return mediaSrc(it.src);
  if (it.src) return imageDownload(it.src);
  return undefined;
}

/** The library's pictures and videos as the media viewer shows them, in the library's order. */
export function libraryMedia(items: LibraryItem[]): MediaItem[] {
  const out: MediaItem[] = [];
  for (const it of items) {
    const kind = itemMediaKind(it);
    const src = kind ? itemHref(it) : undefined;
    if (!kind || !src) continue;
    out.push({
      key: `library:${it.id}`,
      kind,
      src,
      name: it.name,
      ...(it.caption && it.caption !== it.name ? { caption: it.caption } : {}),
      ...(itemHref(it, true) ? { download: itemHref(it, true) } : {}),
      ...(it.src && /^https?:\/\//i.test(it.src) ? { original: it.src } : {}),
    });
  }
  return out;
}

/** The items of each shelf, in order, with only the shelves that hold something. */
export function shelves(items: LibraryItem[]): Array<{ kind: LibraryKind; items: LibraryItem[] }> {
  return LIBRARY_SHELVES.map((kind) => ({ kind, items: items.filter((it) => it.kind === kind) })).filter((s) => s.items.length > 0);
}
