// When Pio takes a quiet look on its own (spec: "Seeing and saying"): a window the person settled in, or long work on
// one window; never while they talk with Pio, while Pio drives or speaks, and not more often than the person's
// chattiness allows.

import type { Body, WindowSeen } from "./bodies.ts";

export type Chattiness = "quiet" | "normal" | "chatty";
export const CHATTINESS: readonly Chattiness[] = ["quiet", "normal", "chatty"];

const MIN = 60_000;
/** Between two looks, and after a remark Pio made (asked or not). */
export const GAPS: Record<Chattiness, { look: number; remark: number }> = {
  quiet: { look: 15 * MIN, remark: 30 * MIN },
  normal: { look: 5 * MIN, remark: 10 * MIN },
  chatty: { look: 2 * MIN, remark: 3 * MIN },
};
/** A new window counts once the person stayed in it this long. */
export const SETTLE_MS = 15_000;
/** Work on one window: a look after this long, then after twice that, … */
export const STEADY_MS = 5 * MIN;
/** At most this many looks at one window. */
export const MAX_PER_WINDOW = 3;
/** The person talked with Pio: no looks of its own for this long. */
export const TALK_QUIET_MS = 60_000;

export interface WatchState {
  lastLookAt?: number;
  lastRemarkAt?: number;
  lastTalkAt?: number;
  /** The window last looked at (windowKey) and how often. */
  looked?: { key: string; count: number; at: number };
}

export function windowKey(w: WindowSeen): string {
  return `${w.since}|${w.app}|${w.title ?? ""}`;
}

export function nextWatch(body: Body | undefined, s: WatchState, now: number, chattiness: Chattiness): { reason: "switch" | "steady" } | undefined {
  if (!body?.watching || body.control || body.speaking || body.hearing) return undefined;
  const cur = body.timeline.at(-1);
  if (!cur) return undefined;
  const gaps = GAPS[chattiness] ?? GAPS.normal;
  if (s.lastTalkAt !== undefined && now - s.lastTalkAt < TALK_QUIET_MS) return undefined;
  if (s.lastRemarkAt !== undefined && now - s.lastRemarkAt < gaps.remark) return undefined;
  if (s.lastLookAt !== undefined && now - s.lastLookAt < gaps.look) return undefined;
  if (now - cur.since < SETTLE_MS) return undefined;
  const key = windowKey(cur);
  if (s.looked?.key !== key) return { reason: "switch" };
  if (s.looked.count >= MAX_PER_WINDOW) return undefined;
  return now - cur.since >= STEADY_MS * s.looked.count ? { reason: "steady" } : undefined;
}

/** Note a look taken now at the body's current window. */
export function looked(s: WatchState, body: Body, now: number): void {
  const cur = body.timeline.at(-1);
  if (!cur) return;
  const key = windowKey(cur);
  s.lastLookAt = now;
  s.looked = s.looked?.key === key ? { key, count: s.looked.count + 1, at: now } : { key, count: 1, at: now };
}
