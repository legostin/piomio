// A session's life (docs/superpowers/specs/2026-11-18-session-life-design.md). A conversation resumes in the same brain
// session for as long as that is cheap: the model's provider keeps the conversation so far in its prompt cache, and a
// turn then reads it at a fraction of the price. The cache is lost when nothing was said for its lifetime or when what
// comes before the conversation (the instructions, the tools) changes; resuming then writes the whole history again.
// So a session whose history is long starts afresh from the hub's recap (continuity.ts) instead, and one that grew past
// the person's cap does too, however warm. Between those, a session keeps the system prompt it started with: what
// changes meanwhile (the team, the rules for where work goes) comes as a message.

import { createHash } from "node:crypto";

/** How long a prompt cache lives without a read: Claude Code asks for the one-hour one on a subscription. */
export const CACHE_LIFETIME_MS = 60 * 60_000;
/** A history under this share of the cap resumes when the cache is lost: little to write again, nothing forgotten. */
const COLD_SHARE = 1 / 3;

export interface LifeState {
  /** The session has a conversation to resume (a resume token). */
  resumable: boolean;
  /** The prompt of its last model call, in tokens; undefined when its brain does not say. */
  contextTokens?: number;
  /** The prompt of the first model call of this life: the instructions, the tools, the recap. */
  baseTokens?: number;
  /** When its prompt was last rendered or a turn of it ended. */
  usedAt?: string;
  /** It was opened with what it would be opened with now (the agent, the tools, the connections). */
  stampSame: boolean;
}

/**
 * `keep`: go on with the prompt it has; `reopen`: resume with a newly rendered prompt; `fresh`: drop the conversation
 * and start from the recap with a new prompt.
 */
export type LifePlan = "keep" | "reopen" | "fresh";

/** What was said and done in a session, in tokens: its context without the instructions and tools it started with. */
export function historyTokens(s: Pick<LifeState, "contextTokens" | "baseTokens">): number {
  return Math.max(0, (s.contextTokens ?? 0) - (s.baseTokens ?? 0));
}

/** `cap`: the history a session may reach, in tokens (Infinity: never start afresh, a task's). */
export function lifePlan(s: LifeState, o: { now: number; cap: number }): LifePlan {
  const used = s.usedAt ? Date.parse(s.usedAt) : NaN;
  const lost = !s.stampSame || (Number.isFinite(used) && o.now - used > CACHE_LIFETIME_MS);
  if (!s.resumable) return lost ? "reopen" : "keep";
  const history = historyTokens(s);
  if (history > o.cap) return "fresh";
  if (!lost) return "keep";
  return history > o.cap * COLD_SHARE ? "fresh" : "reopen";
}

/**
 * A session's base after a model call with a prompt of `tokens`: the first call of a life sets it (`first`), and a
 * context smaller than it means the brain started the conversation over by itself.
 */
export function nextBase(base: number | undefined, tokens: number, first: boolean): number | undefined {
  if (base === undefined) return first ? tokens : undefined;
  return Math.min(base, tokens);
}

/** A short fingerprint of what a session was opened with or told, kept with it. */
export function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}
