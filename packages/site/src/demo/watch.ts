// Any part of the page can play a chapter in the live window at the top: it asks with an event, Stage listens.

import type { ChapterId } from "./protocol";

export const WATCH_EVENT = "piomio:watch";

export function watchInDemo(id: ChapterId): void {
  window.dispatchEvent(new CustomEvent<ChapterId>(WATCH_EVENT, { detail: id }));
}
