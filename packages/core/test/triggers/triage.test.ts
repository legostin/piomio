// Triage: a quick model decides whether an event deserves an agent's attention (signals/triage.ts, bare-ask.ts).
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainEvent, BrainSessionOptions, ProbeResult } from "@piomio/shared";
import type { BrainHandle, BrainRegistry } from "../../src/brains.ts";
import { quickModel } from "../../src/bare-ask.ts";
import type { QuickModel } from "../../src/bare-ask.ts";
import { parseTriage, triage, triagePrompt } from "../../src/signals/triage.ts";
import type { Signal } from "../../src/signals/triage.ts";

const signal = (over: Partial<Signal> = {}): Signal => ({
  id: "s1",
  type: "web.page",
  source: "web",
  at: "2026-11-07T10:00:00Z",
  data: { price: 42 },
  subject: "Price of the lamp changed",
  external: true,
  ...over,
});

describe("parseTriage", () => {
  it("reads a fenced JSON answer and one wrapped in prose", () => {
    expect(parseTriage('```json\n{"decision":"wake","why":"big drop","summary":"Lamp is 42"}\n```')).toEqual({
      decision: "wake",
      why: "big drop",
      summary: "Lamp is 42",
    });
    expect(parseTriage('Sure! Here you go: {"decision":"note","why":"minor","summary":"s"} Hope that helps.')?.decision).toBe("note");
  });

  it("rejects a decision outside the three, and text with no object", () => {
    expect(parseTriage('{"decision":"maybe","why":"x","summary":"y"}')).toBeUndefined();
    expect(parseTriage("no json here")).toBeUndefined();
    expect(parseTriage("{broken")).toBeUndefined();
  });
});

describe("triagePrompt", () => {
  it("carries the brief, the subjects and the recent notes, and fences external data", () => {
    const p = triagePrompt({
      trigger: { name: "Lamp", brief: "Tell me when the lamp gets cheaper" },
      signals: [signal(), signal({ id: "s2", subject: "Own note", external: false, data: { a: 1 } })],
      recentNotes: ["Price was 50 yesterday"],
    });
    expect(p).toContain("Tell me when the lamp gets cheaper");
    expect(p).toContain("Price of the lamp changed");
    expect(p).toContain("Price was 50 yesterday");
    expect(p).toContain("<<<SIGNAL_DATA");
    expect(p).toContain("SIGNAL_DATA>>>");
    expect(p).toMatch(/"decision"/);
  });

  it("trims signals to 6 KB in all", () => {
    const big = "x".repeat(50_000);
    const p = triagePrompt({
      trigger: { name: "T", brief: "b" },
      signals: [signal({ data: big }), signal({ id: "s2", data: big })],
      recentNotes: [],
    });
    expect(p.length).toBeLessThan(10_000);
  });
});

describe("triage", () => {
  const fake = (answers: string[]): QuickModel & { asked: number } => ({
    asked: 0,
    async ask() {
      return { text: answers[this.asked++] ?? "", ref: "claude-code@local" };
    },
  });
  const input = { trigger: { name: "T", brief: "b" }, signals: [signal()], recentNotes: [] };

  it("retries once on an unparseable answer", async () => {
    const m = fake(["I think so", '{"decision":"drop","why":"noise","summary":""}']);
    expect(await triage(m, input)).toEqual({ decision: "drop", why: "noise", summary: "", ref: "claude-code@local" });
    expect(m.asked).toBe(2);
  });

  it("throws unparseable after two bad answers", async () => {
    const m = fake(["nope", "still nope"]);
    await expect(triage(m, input)).rejects.toThrow("unparseable");
    expect(m.asked).toBe(2);
  });
});

/** Brains as in reviewer.test.ts: `answers[brainId]` is the text, or an error event when it starts with "!" (limit_hit with "~"). */
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
          if (said.startsWith("~")) onEvent({ type: "limit_hit", detail: said.slice(1) });
          else if (said.startsWith("!")) onEvent({ type: "error", message: said.slice(1) });
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

describe("quickModel", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "piomio-quick-"));

  it("skips a brain that is not signed in, asks bare on the cheapest model at low effort", async () => {
    const { brains, opened } = registry(
      {
        "claude-code": { authenticated: false },
        codex: { models: ["gpt-6-astra", "gpt-6-luna"], efforts: ["low", "medium"] },
      },
      { codex: "ANSWER" },
    );
    const r = await quickModel({ brains, dataDir }).ask("q");
    expect(r).toEqual({ text: "ANSWER", ref: "codex@local" });
    expect(opened.map((o) => [o.ref, o.opts.model, o.opts.effort, o.opts.bare])).toEqual([["codex@local", "gpt-6-luna", "low", true]]);
  });

  it("rests a brain that reported limit_hit and falls to the next", async () => {
    const { brains, opened } = registry({ "claude-code": {}, codex: {} }, { "claude-code": "~over its limit", codex: "OK" });
    const m = quickModel({ brains, dataDir });
    expect((await m.ask("q")).ref).toBe("codex@local");
    const before = opened.length;
    expect((await m.ask("q")).ref).toBe("codex@local");
    expect(opened.slice(before).some((o) => o.ref === "claude-code@local")).toBe(false);
  });

  it("throws when no quick model is signed in", async () => {
    const { brains } = registry({ "claude-code": { authenticated: false } }, {});
    await expect(quickModel({ brains, dataDir }).ask("q")).rejects.toThrow("no quick model is signed in");
  });
});
