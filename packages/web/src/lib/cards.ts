// Cards an agent shows options with (a `cards` part): what a position's page needs from it that is not drawing: its
// pictures for the media viewer, its place as a map, how a link reads.

import type { CardItem, MessagePart } from "@piomio/shared";
import { imageDownload, partKey, type MediaItem } from "./gallery";
import { mediaSrc } from "./media";

export type CardsPart = Extract<MessagePart, { type: "cards" }>;
type MapPart = Extract<MessagePart, { type: "map" }>;

/** A link as its button reads: its label, else its host ("example.com"). */
export function linkLabel(link: { label?: string; url: string }): string {
  if (link.label?.trim()) return link.label.trim();
  try {
    return new URL(link.url).hostname.replace(/^www\./, "");
  } catch {
    return link.url;
  }
}

/** A position's pictures as the media viewer shows them; `index` is the position's place in the part. */
export function cardMedia(item: CardItem, messageId: string, part: number, index: number): MediaItem[] {
  return (item.images ?? []).flatMap((img, j) => {
    const src = mediaSrc(img.src);
    if (!src) return [];
    const web = /^https?:\/\//i.test(img.src.trim());
    return [{ key: `${partKey(messageId, part, index)}/${j}`, kind: "image" as const, src, caption: img.caption ?? item.title, name: img.alt, download: imageDownload(img.src), original: web ? img.src.trim() : undefined }];
  });
}

/** Where a position is, as a map with its one marker; nothing without coordinates. */
export function cardMap(item: CardItem): MapPart | undefined {
  if (typeof item.lat !== "number" || typeof item.lon !== "number") return undefined;
  return { type: "map", lat: item.lat, lon: item.lon, zoom: 15, title: item.title, markers: [{ lat: item.lat, lon: item.lon, label: item.title, ...(item.address ? { note: item.address } : {}) }] };
}
