// Cards agents show options with (a `cards` part, tools/card-tools.ts): how a position reads in one line, for the
// model and for the channels that cannot draw a card.
import type { CardItem, MessagePart } from "@piomio/shared";

export type CardsPart = Extract<MessagePart, { type: "cards" }>;

const stars = (rating: number) => `★ ${rating.toFixed(1).replace(/\.0$/, "")}`;

/** A position for the model: its title with what tells it from the others (price, rating, address, first link). */
export function cardBrief(it: CardItem): string {
  const facts = [it.subtitle, it.price, it.rating !== undefined ? stars(it.rating) : undefined, it.address, it.links?.[0]?.url].filter(Boolean);
  return facts.length ? `${it.title} (${facts.join("; ")})` : it.title;
}

/** A position under its photo in a channel (Telegram): the title, price and rating, why, its first link. */
export function cardCaption(it: CardItem): string {
  const facts = [it.price, it.rating !== undefined ? stars(it.rating) : undefined].filter(Boolean).join(" · ");
  return [it.title, facts, it.why ?? it.subtitle, it.links?.[0]?.url].filter(Boolean).join("\n");
}

/** The cards as the model reads them later: "[showed cards: A; B; chosen: B]". */
export function cardsSummary(p: CardsPart): string {
  const chosen = p.chosen !== undefined ? p.items[p.chosen] : undefined;
  return `[showed cards${p.title ? ` “${p.title}”` : ""}: ${p.items.map((it) => it.title).join("; ")}${chosen ? `; chosen: ${chosen.title}` : ""}]`;
}
