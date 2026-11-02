// Auto mode's reviewer (policy/reviewer.ts): which brain and model review, and what happens when one cannot.
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainEvent, BrainSessionOptions, ProbeResult } from "@piomio/shared";
import type { BrainHandle, BrainRegistry } from "../src/brains.ts";
import { brainReviewer, cheapestModel, reviewModel } from "../src/policy/reviewer.ts";

describe("the model a brain reviews with", () => {
  it("is Codex's newest Luna, the person's pick", () => {
    expect(reviewModel("codex", { models: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-5.6-luna"] })).toBe("gpt-6-luna");
    expect(reviewModel("codex", { models: ["gpt-6-astra", "gpt-6-luna", "gpt-6.1-luna", "gpt-5.6-luna"] })).toBe("gpt-6.1-luna");
    expect(reviewModel("codex", { models: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] })).toBe("gpt-5.6-luna");
    // No Luna at all: its cheapest.
    expect(reviewModel("codex", { models: ["gpt-6-astra", "gpt-5.6-terra"] })).toBe("gpt-5.6-terra");
  });

  it("is the cheapest elsewhere, older generations included", () => {
    expect(reviewModel("claude-code", { models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] })).toBe("claude-haiku-5-5");
    expect(reviewModel("claude-code", {})).toBe("haiku");
    expect(cheapestModel({ models: ["k3", "k3-highspeed", "kimi-for-coding-highspeed"] })).toBe("kimi-for-coding-highspeed");
    expect(reviewModel("kimi", {})).toBeUndefined();
  });
});

/** Brains that answer as told: `answers[brainId]` is the text, or an error event when it starts with "!". */
function registry(probes: Record<string, Partial<ProbeResult>>, answers: Record<string, string>) {
  const opened: Array<{ ref: string; opts: BrainSessionOptions }> = [];
  const brains = {
    has: (ref: string) => ref.split("@")[0] in probes,
    probe: async (ref: string) => ({ available: true, authenticated: true, ...probes[ref.split("@")[0]] }) as ProbeResult,
    create: async (ref: string, opts: BrainSessionOptions): Promise<BrainHandle> => {
      opened.push({ ref, opts });
      const said = answers[ref.split("@")[0]] ?? "";
      return {
        ref,
        async send(_turn, onEvent: (e: BrainEvent) => void) {
          if (said.startsWith("!")) onEvent({ type: "error", message: said.slice(1) });
          else onEvent({ type: "text", delta: said });
        },
        steer: async () => false,
        warm: async () => {},
        close: async () => {},
      } as unknown as BrainHandle;
    },
  } as unknown as BrainRegistry;
  return { brains, opened };
}

describe("the reviewer", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "piomio-reviewer-"));
  const lineups = {
    "claude-code": { models: ["claude-sonnet-5-5", "claude-haiku-5-5"], efforts: ["low", "medium", "high"] },
    codex: { models: ["gpt-6-astra", "gpt-6-luna", "gpt-5.6-luna"], efforts: ["low", "medium", "high", "xhigh"] },
  };

  it("runs on the reviewed session's own brain, bare, with its review model; the second look thinks longer", async () => {
    const { brains, opened } = registry(lineups, { "claude-code": "CLAUDE", codex: "CODEX" });
    const review = brainReviewer({ brains, dataDir })()!;
    expect(await review("p", 1, "codex")).toBe("CODEX");
    expect(await review("p", 2, "codex")).toBe("CODEX");
    const used = opened.filter((o) => !o.opts.keepWarm);
    expect(used.map((o) => [o.ref, o.opts.model, o.opts.effort, o.opts.bare])).toEqual([
      ["codex@local", "gpt-6-luna", "low", true],
      ["codex@local", "gpt-6-luna", "medium", true],
    ]);
    expect(used[0].opts.workspace).toBe(join(dataDir, "auto-review", "codex"));
    // Another brain's session (Kimi on a hub without it, an API brain): the first that can.
    expect(await review("p", 1, "api")).toBe("CLAUDE");
    expect(opened.at(-1)?.opts.model).toBe("claude-haiku-5-5");
  });

  it("hands the review to the next brain when one cannot, and lets that one rest", async () => {
    const { brains, opened } = registry({ ...lineups, kimi: {} }, { kimi: "!no Kimi Code plan", "claude-code": "ALLOW" });
    const review = brainReviewer({ brains, dataDir })()!;
    expect(await review("p", 1, "kimi")).toBe("ALLOW");
    const before = opened.length;
    expect(await review("p", 1, "kimi")).toBe("ALLOW");
    expect(opened.slice(before).some((o) => o.ref === "kimi@local" && !o.opts.keepWarm)).toBe(false);
  });

  it("leaves out brains that are not signed in, and fails when none can", async () => {
    const { brains } = registry({ codex: { authenticated: false } }, { codex: "ALLOW" });
    const review = brainReviewer({ brains, dataDir })()!;
    await expect(review("p", 1, "codex")).rejects.toThrow(/signed in/);
    expect(brainReviewer({ brains: registry({}, {}).brains, dataDir })()).toBeUndefined();
  });
});
