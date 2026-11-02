// How Pio behaves, as the person said it in the chat (pio_settings) or in its card: kept in the plugin's storage.

import { CHATTINESS, type Chattiness } from "./watch.ts";

export type ListenMode = "name" | "key" | "all";
export const LISTEN_MODES: readonly ListenMode[] = ["name", "key", "all"];

export interface Prefs {
  chattiness: Chattiness;
  listen: ListenMode;
}

export const DEFAULT_PREFS: Prefs = { chattiness: "normal", listen: "name" };

/** The valid part of stored or asked-for preferences over `base`. */
export function cleanPrefs(v: unknown, base: Prefs = DEFAULT_PREFS): Prefs {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    chattiness: CHATTINESS.includes(o.chattiness as Chattiness) ? (o.chattiness as Chattiness) : base.chattiness,
    listen: LISTEN_MODES.includes(o.listen as ListenMode) ? (o.listen as ListenMode) : base.listen,
  };
}
