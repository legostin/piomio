// Built-in plugins that ship turned off may carry an offer (manifest `offer`, English for the model). Once the person
// and the hub have met (the intro is over), the default agent puts each one to them with buttons, once per plugin. The
// ids offered are kept in the settings table ("plugin_offers"), which every replica shares.

import type { PluginRecord } from "./host.ts";

export const OFFERS_KEY = "plugin_offers";

export interface PluginOffer {
  id: string;
  offer: string;
}

/** Built-in plugins that are off, carry an offer and were not offered yet. */
export function pendingOffers(records: PluginRecord[], offered: string[]): PluginOffer[] {
  return records
    .filter((r) => r.source === "builtin" && !r.enabled && !!r.layout?.manifest.offer && !offered.includes(r.id))
    .map((r) => ({ id: r.id, offer: r.layout!.manifest.offer! }));
}

/** The note for the default agent: one message, buttons, and how to turn each plugin on. */
export function offerNote(offers: PluginOffer[]): string {
  const list = offers.map((o) => `- ${o.id}: ${o.offer}`).join("\n");
  return (
    "[System] New in Piomio, waiting turned off until the person wants it:\n" +
    `${list}\n` +
    "Offer it to the person now, in one short warm message in their language: what it gives them, in plain words. " +
    'Put the choice as buttons with show_choices (e.g. "Turn on" / "Not now"). On a yes, turn it on with ' +
    "hub_plugin_enable {id, enabled: true} and tell them what happens next; on a no, leave it: they can ask for it any time. " +
    "Offer it only this once."
  );
}
