// A session's life (docs/superpowers/specs/2026-11-18-session-life-design.md): when a conversation goes on in the same
// brain session, when it resumes with a new prompt, and when it starts afresh from the hub's recap.
import { describe, expect, it } from "vitest";
import { CACHE_LIFETIME_MS, historyTokens, lifePlan, nextBase } from "../src/session-life.ts";

const now = Date.parse("2026-11-18T12:00:00Z");
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const plan = (s: Partial<Parameters<typeof lifePlan>[0]>, cap = 120_000) =>
  lifePlan({ resumable: true, stampSame: true, usedAt: ago(1), ...s }, { now, cap });

describe("a session's life", () => {
  it("keeps a warm session whose prompt is the same", () => {
    expect(plan({ contextTokens: 90_000, baseTokens: 30_000 })).toBe("keep");
    // The brain reports no size (Codex, Kimi): never renewed by size.
    expect(plan({})).toBe("keep");
  });

  it("starts afresh once the history is past the cap, however warm", () => {
    expect(plan({ contextTokens: 151_000, baseTokens: 30_000 })).toBe("fresh");
    expect(plan({ contextTokens: 150_000, baseTokens: 30_000 })).toBe("keep");
    // The instructions and tools are not history: a big base alone renews nothing.
    expect(plan({ contextTokens: 140_000, baseTokens: 130_000 })).toBe("keep");
  });

  it("starts afresh when the cache is cold or the prompt changes and the history is more than a third of the cap", () => {
    expect(plan({ contextTokens: 80_000, baseTokens: 30_000, usedAt: ago(61) })).toBe("fresh");
    expect(plan({ contextTokens: 80_000, baseTokens: 30_000, stampSame: false })).toBe("fresh");
    // A short history resumes with the new prompt: little to rewrite, nothing forgotten.
    expect(plan({ contextTokens: 60_000, baseTokens: 30_000, usedAt: ago(61) })).toBe("reopen");
    expect(plan({ contextTokens: 60_000, baseTokens: 30_000, stampSame: false })).toBe("reopen");
    expect(plan({ usedAt: ago(600) })).toBe("reopen");
    expect(CACHE_LIFETIME_MS).toBe(60 * 60_000);
  });

  it("counts all of a session's context as history when it has no base (one from before sizes were kept)", () => {
    expect(historyTokens({ contextTokens: 150_000 })).toBe(150_000);
    expect(plan({ contextTokens: 150_000 })).toBe("fresh");
    expect(plan({ contextTokens: 50_000, usedAt: ago(90) })).toBe("fresh");
  });

  it("never starts a task afresh: its cap is infinite", () => {
    expect(plan({ contextTokens: 450_000, baseTokens: 30_000, usedAt: ago(600) }, Infinity)).toBe("reopen");
    expect(plan({ contextTokens: 450_000, baseTokens: 30_000 }, Infinity)).toBe("keep");
  });

  it("has nothing to decide for a session with no conversation to resume", () => {
    expect(plan({ resumable: false, contextTokens: 500_000, usedAt: ago(600), stampSame: false })).toBe("reopen");
    expect(plan({ resumable: false })).toBe("keep");
  });

  it("takes the first call of a life as its base, and a smaller context after that (the brain started over)", () => {
    expect(nextBase(undefined, 31_000, true)).toBe(31_000);
    // A session that resumed without a base keeps none: all of its context is history.
    expect(nextBase(undefined, 150_000, false)).toBeUndefined();
    expect(nextBase(31_000, 60_000, false)).toBe(31_000);
    expect(nextBase(31_000, 28_000, false)).toBe(28_000);
  });
});
