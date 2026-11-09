// What the media viewer shows: the pictures and videos of a chat in order (files people sent, pictures agents
// showed), each with where the page loads it from and how it is saved.

import type { Message } from "@piomio/shared";
import { mediaSrc } from "./media";

export type MediaKind = "image" | "video";

export interface MediaItem {
  /** Unique in its gallery; the thumbnail in the chat carries it as `data-media-key`, so the viewer opens from it and closes back into it. */
  key: string;
  kind: MediaKind;
  /** What the page loads. */
  src: string;
  name?: string;
  caption?: string;
  /** A hub link that saves the file (Content-Disposition: attachment). */
  download?: string;
  /** The web page a web picture comes from. */
  original?: string;
  /** A picture waiting in the composer (its pending file's id): it can be marked up before it is sent. */
  fileId?: string;
}

/** Pictures the browser shows itself (SVG too: from the hub it comes sandboxed). */
const IMAGE = /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/i;
const VIDEO = /^video\/(mp4|quicktime|webm)$/i;

/** Whether the viewer shows a file of this type, and as what. */
export function mediaKind(mimeType: string | undefined): MediaKind | undefined {
  if (!mimeType) return undefined;
  if (IMAGE.test(mimeType)) return "image";
  if (VIDEO.test(mimeType)) return "video";
  return undefined;
}

const TEXT_EXT = /\.(txt|log|csv|tsv|json|jsonl|ya?ml|toml|xml|ini|conf|env|sh|zsh|bash|py|js|mjs|cjs|ts|tsx|jsx|go|rs|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sql|css|scss|html?|svg|diff|patch)$/i;

/**
 * How the in-app viewer shows a file that is not a picture or a video: Markdown drawn, other text as it is, a PDF in
 * the browser's own viewer. Undefined: it is saved instead.
 */
export function docKind(mimeType: string | undefined, name: string | undefined): "markdown" | "text" | "pdf" | undefined {
  const n = name ?? "";
  if (/\.(md|markdown)$/i.test(n) || mimeType === "text/markdown") return "markdown";
  if (/\.pdf$/i.test(n) || mimeType === "application/pdf") return "pdf";
  if (TEXT_EXT.test(n) || mimeType?.startsWith("text/") || /^application\/(json|xml|x-yaml|yaml|toml|x-sh)/i.test(mimeType ?? "")) return "text";
  return undefined;
}

/** A workspace file as the page loads it, and as it is saved. */
export function fileHref(path: string, download = false): string {
  return `/api/files?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
}

/** How a picture an agent showed is saved: a workspace file or a web image through the hub, under its own name. */
export function imageDownload(src: string): string | undefined {
  const s = src.trim();
  if (s.startsWith("file:") && s.length > 5) return fileHref(s.slice(5), true);
  if (/^https?:\/\//i.test(s)) return `/api/media?url=${encodeURIComponent(s)}&download=1`;
  return undefined;
}

/** The key of a message's file, or of one picture in its `images` part. */
export function partKey(messageId: string, part: number, item?: number): string {
  return item === undefined ? `${messageId}/${part}` : `${messageId}/${part}/${item}`;
}

/** Every picture and video of the chat, oldest first. */
export function chatMedia(messages: Message[]): MediaItem[] {
  const out: MediaItem[] = [];
  for (const m of messages) {
    m.parts.forEach((p, i) => {
      if (p.type === "attachment") {
        const kind = mediaKind(p.mimeType);
        if (!kind || p.kind === "voice") return;
        out.push({ key: partKey(m.id, i), kind, src: fileHref(p.path), name: p.name, download: fileHref(p.path, true) });
      } else if (p.type === "images") {
        p.items.forEach((it, j) => {
          const src = mediaSrc(it.src);
          if (!src) return;
          const web = /^https?:\/\//i.test(it.src.trim());
          out.push({
            key: partKey(m.id, i, j),
            kind: "image",
            src,
            caption: it.caption,
            name: it.alt,
            download: imageDownload(it.src),
            original: web ? it.src.trim() : undefined,
          });
        });
      }
    });
  }
  return out;
}

/** The place of `key` in `items`, or -1. */
export function indexOfKey(items: MediaItem[], key: string): number {
  return items.findIndex((it) => it.key === key);
}
