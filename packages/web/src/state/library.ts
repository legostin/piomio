// The agent's library over the app (components/LibrarySheet.tsx): whose library is open, and a stamp that goes up
// when something new may be in it (a file, a picture or a page came), so an open library reloads.

import { createStore } from "../lib/store";

export const libraryView = createStore<{ agentId: string } | null>(null);
export const libraryStamp = createStore(0);

export function openLibrary(agentId: string): void {
  libraryView.set({ agentId });
}

export function closeLibrary(): void {
  libraryView.set(null);
}

/** Something that belongs in a library came or changed; only an open library cares. */
export function touchLibrary(): void {
  if (libraryView.get()) libraryStamp.set((n) => n + 1);
}
