// The media viewer over the whole app: which gallery it shows (a chat's pictures and videos, the pictures waiting in
// a composer, or a list) and at which item, and saving an item (the browser's download, the desktop app's Downloads
// folder, the phone's share sheet).

import { useSyncExternalStore } from "react";
import { chatMedia, docKind, indexOfKey, type MediaItem } from "../lib/gallery";
import { isImage } from "../lib/attachments";
import { createStore } from "../lib/store";
import { native, nativeErrorText } from "../lib/native";
import { desktopApp } from "../lib/desktop";
import { messages } from "./app";
import { pendingStore } from "./attachments";
import { toast } from "./toast";
import { t } from "../i18n";

export type ViewerSource = { kind: "chat"; conversationId: string } | { kind: "pending"; conversationId: string } | { kind: "list"; items: MediaItem[] };

export interface ViewerState {
  source: ViewerSource;
  /** The item shown first. */
  key: string;
  /** Opens straight into marking the picture up (from a composer chip's pencil). */
  edit?: boolean;
  /** Each opening is a new viewer. */
  id: number;
}

export const viewer = createStore<ViewerState | null>(null);
let seq = 0;

export function openViewer(source: ViewerSource, key: string, opts: { edit?: boolean } = {}): void {
  viewer.set({ source, key, edit: opts.edit, id: ++seq });
}

export function closeViewer(): void {
  viewer.set(null);
}

/** A file that is not a picture or a video, opened in the app (FileViewer). */
export interface OpenFile {
  /** Where it loads from (the hub's /api/files). */
  src: string;
  /** Where it is saved from. */
  download: string;
  name: string;
  mimeType?: string;
  size?: number;
}

export const fileViewer = createStore<(OpenFile & { id: number }) | null>(null);

/**
 * Opens a file in the app: a document (Markdown, text, a PDF) in the document viewer, anything else saved (Downloads
 * on the desktop and in a browser, the share sheet inside the phone app). Never a new browser tab: outside the app
 * the hub does not know the person, and the desktop app hands new tabs to the system browser.
 */
export function openFile(file: OpenFile): void {
  const kind = docKind(file.mimeType, file.name);
  // Inside the phone app a PDF goes to the share sheet, whose preview shows it whole (the web view draws one page).
  if (!kind || (kind === "pdf" && native)) return saveMedia({ key: file.src, kind: "image", src: file.src, name: file.name, download: file.download });
  fileViewer.set({ ...file, id: ++seq });
}

export function closeFile(): void {
  fileViewer.set(null);
}

/** The pictures waiting in a composer, as the viewer shows them. */
export function pendingMedia(conversationId: string): MediaItem[] {
  return (pendingStore.get()[conversationId] ?? []).flatMap((f) =>
    f.preview && isImage(f.type) ? [{ key: `pending:${f.id}`, kind: "image" as const, src: f.preview, name: f.name, fileId: f.id }] : [],
  );
}

const cache = new WeakMap<object, MediaItem[]>();
const EMPTY: MediaItem[] = [];

/** A gallery's items, the same array while its messages or files do not change. */
function itemsOf(source: ViewerSource): MediaItem[] {
  if (source.kind === "list") return source.items;
  const from = source.kind === "chat" ? messages.get()[source.conversationId]?.messages : pendingStore.get()[source.conversationId];
  if (!from) return EMPTY;
  let items = cache.get(from);
  if (!items) {
    items = source.kind === "chat" ? chatMedia(messages.get()[source.conversationId].messages) : pendingMedia(source.conversationId);
    cache.set(from, items);
  }
  return items;
}

const subscribeBoth = (cb: () => void) => {
  const a = messages.subscribe(cb);
  const b = pendingStore.subscribe(cb);
  return () => {
    a();
    b();
  };
};

/** The live gallery of `source`: new messages and marked-up pictures show up while it is open. */
export function useGallery(source: ViewerSource): MediaItem[] {
  return useSyncExternalStore(subscribeBoth, () => itemsOf(source));
}

export { indexOfKey };

/** Saves an item: a download in the browser and the desktop app, the share sheet inside the phone app. */
export function saveMedia(item: MediaItem): void {
  if (!item.download) return;
  const name = item.name ?? "";
  if (native) {
    native.call("save", { url: new URL(item.download, location.href).href, name }).catch((e: unknown) => toast(t("viewer.saveFailed", { error: nativeErrorText(e) }), "error"));
    return;
  }
  const a = document.createElement("a");
  a.href = item.download;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
}

// The desktop app saves downloads into the Downloads folder by itself and says when one is done (window.rs).
if (typeof window !== "undefined" && desktopApp()) {
  window.addEventListener("piomio-desktop", (e) => {
    const d = (e as CustomEvent<{ type?: string; name?: string; ok?: boolean }>).detail;
    if (d?.type !== "download") return;
    if (d.ok) toast(t("viewer.saved", { name: d.name ?? "" }), "success");
    else toast(t("viewer.saveFailed", { error: d.name ?? "" }), "error");
  });
}
