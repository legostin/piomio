import { describe, expect, it } from "vitest";
import type { AgentDef } from "../src/types.ts";
import { modelLabel } from "../src/models.ts";
import { brainsFor, brainSpeed, expandBrains, fitEffort, onMachines, parseThinking, patchChoice, resolveThinking, taskThinking, thinkingFor, withChoice, workKind } from "../src/thinking.ts";

const presets = { fast: { model: "sonnet", effort: "low" }, balanced: { model: "opus", effort: "medium" }, deep: { model: "opus", effort: "xhigh" } };
const claude = { presets, efforts: ["low", "medium", "high", "xhigh", "max"] };
const agent = (thinking: AgentDef["thinking"], brains = ["claude-code@local", "codex@local"]) => ({ brains, thinking });

describe("thinking per kind of work", () => {
  it("tells the kind of work from the task", () => {
    expect(workKind(undefined)).toBe("chat");
    expect(workKind({ kind: "message", createdBy: "agent" })).toBe("chat");
    expect(workKind({ createdBy: "agent" })).toBe("task");
    expect(workKind({ createdBy: "trigger" })).toBe("schedule");
    expect(workKind({ createdBy: "trigger", feedId: "f1" })).toBe("feed");
  });

  it("lets a kind follow the chat until it has its own choice", () => {
    const a = agent({ chat: { preset: "fast" }, task: { preset: "deep" }, feed: { brain: "codex" } });
    expect(thinkingFor(a, "chat")).toEqual({ preset: "fast" });
    expect(thinkingFor(a, "task")).toEqual({ preset: "deep" });
    expect(thinkingFor(a, "schedule")).toEqual({ preset: "fast" });
    // A brain alone keeps the chat's depth.
    expect(thinkingFor(a, "feed")).toEqual({ preset: "fast", brain: "codex" });
    // "codex" stands for the agent's own Codex.
    expect(brainsFor(a, "feed")).toEqual(["codex@local", "claude-code@local"]);
    expect(brainsFor(a, "chat")).toEqual(["claude-code@local", "codex@local"]);
    // No choice at all: every kind thinks "auto" (the hub decides per request); an agent-wide model from before keeps its way.
    expect(thinkingFor({ brains: [] }, "chat")).toEqual({ preset: "auto" });
    expect(thinkingFor({ brains: [] }, "task")).toEqual({ preset: "auto" });
    expect(thinkingFor({ brains: [], model: "old" }, "chat")).toEqual({});
  });

  it("lets an auto dialog take the quickest brain first, thinking fast", () => {
    const a = agent({ chat: { preset: "auto" }, task: { preset: "deep" } }, ["codex@local", "claude-code@mach_1", "claude-code@local", "api:anthropic"]);
    expect(brainsFor(a, "chat")).toEqual(["api:anthropic", "claude-code@local", "codex@local", "claude-code@mach_1"]);
    // Tasks keep the agent's order and their own depth.
    expect(brainsFor(a, "task")).toEqual(["codex@local", "claude-code@mach_1", "claude-code@local", "api:anthropic"]);
    expect(resolveThinking({ preset: "auto" }, "claude-code@local", claude)).toEqual({ model: "sonnet", effort: "low", preset: "auto" });
    expect(brainSpeed("api:openai")).toBeLessThan(brainSpeed("claude-code"));
    // A brain the person chose for the dialog still comes first.
    expect(brainsFor(agent({ chat: { preset: "auto", brain: "codex@local" } }), "chat")).toEqual(["codex@local", "claude-code@local"]);
  });

  it("gives a task the brain and depth whoever started it chose", () => {
    const a = agent({ task: { model: "opus", effort: "max", brain: "claude-code@local" } });
    expect(taskThinking(a, "task")).toEqual({ model: "opus", effort: "max", brain: "claude-code@local" });
    // A chosen depth replaces the exact model and effort; a chosen brain goes first.
    expect(taskThinking(a, "task", { preset: "fast" })).toEqual({ preset: "fast", brain: "claude-code@local" });
    const both = taskThinking(a, "task", { preset: "deep", brain: "codex" });
    expect(both).toEqual({ preset: "deep", brain: "codex" });
    expect(brainsFor(a, "task", both)).toEqual(["codex@local", "claude-code@local"]);
    expect(resolveThinking(both, "codex@local", { efforts: ["low", "high"], presets: { deep: { effort: "high" } } })).toEqual({ effort: "high", preset: "deep" });
  });

  it("resolves a preset on each brain, exact choices on their own brain, and the old agent-wide model last", () => {
    expect(resolveThinking({ preset: "deep" }, "claude-code@local", claude)).toEqual({ model: "opus", effort: "xhigh", preset: "deep" });
    expect(resolveThinking({ preset: "deep" }, "codex@local", { efforts: ["low", "medium", "high"], presets: { deep: { effort: "high" } } }, "gpt-x")).toEqual({ model: "gpt-x", effort: "high", preset: "deep" });
    const exact = { model: "haiku", effort: "low", brain: "claude-code" };
    expect(resolveThinking(exact, "claude-code@local", claude)).toEqual({ model: "haiku", effort: "low" });
    expect(resolveThinking(exact, "codex@local", { presets: {} })).toEqual({});
    expect(resolveThinking({ preset: "fast", effort: "max", brain: "claude-code@local" }, "claude-code@local", claude)).toEqual({ model: "sonnet", effort: "max" });
    // A brain without presets or efforts: the agent's old model, nothing else.
    expect(resolveThinking({ preset: "fast" }, "fake@local", undefined, "old")).toEqual({ model: "old", preset: "fast" });
  });

  it("fits an effort to what the brain takes", () => {
    expect(fitEffort("xhigh", ["low", "medium", "high"])).toBe("high");
    expect(fitEffort("minimal", ["low", "medium"])).toBe("low");
    expect(fitEffort("max", undefined)).toBe("max");
    expect(fitEffort("high", [])).toBeUndefined();
    expect(fitEffort("weird", ["low"])).toBeUndefined();
  });

  it("changes a choice the way people expect", () => {
    expect(patchChoice({ model: "haiku", effort: "low", brain: "b" }, { preset: "deep" })).toEqual({ preset: "deep", brain: "b" });
    expect(patchChoice({ preset: "deep", brain: "b" }, { model: "opus" })).toEqual({ model: "opus", brain: "b" });
    expect(patchChoice({ preset: "deep", model: "opus", brain: "b" }, { brain: "c" })).toEqual({ preset: "deep", brain: "c" });
    expect(patchChoice({ preset: "deep" }, { follow: true })).toBeUndefined();
    // "" goes back to the brain's default; from a preset, the other half stays exact.
    expect(patchChoice({ model: "opus", effort: "high", brain: "b" }, { model: "" })).toEqual({ effort: "high", brain: "b" });
    expect(patchChoice({ preset: "deep" }, { model: "", effort: "xhigh" })).toEqual({ effort: "xhigh" });
    expect(withChoice({ chat: { preset: "fast" }, task: { preset: "deep" } }, "task", undefined)).toEqual({ chat: { preset: "fast" } });
    expect(withChoice({ task: { preset: "deep" } }, "task", undefined)).toBeUndefined();
  });

  it("reads only what is valid from a file or a request", () => {
    expect(parseThinking({ chat: "fast", task: { preset: "deep", model: "--dangerous", effort: "HIGH" }, dreams: { preset: "deep" } })).toEqual({
      chat: { preset: "fast" },
      task: { preset: "deep", effort: "high" },
    });
    expect(parseThinking({ task: { preset: "slow" } })).toBeUndefined();
    expect(parseThinking("deep")).toBeUndefined();
  });

  it("names models for people", () => {
    expect(modelLabel("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(modelLabel("claude-fable-5-1")).toBe("Fable 5.1");
    expect(modelLabel("claude-opus-4-20250514")).toBe("Opus 4");
    expect(modelLabel("haiku")).toBe("Haiku");
    expect(modelLabel("deepseek-chat")).toBe("deepseek-chat");
  });
});

describe("the pool of machines", () => {
  const listed = ["claude-code@local", "codex@local", "api:openai@local", "claude-code@mach_vps", "codex@mach_vps", "codex@mach_pc"];

  it("adds the same brain on every machine after the agent's own order", () => {
    expect(expandBrains(["claude-code@local", "api:*"], listed)).toEqual(["claude-code@local", "api:openai@local", "claude-code@mach_vps"]);
    expect(expandBrains(["codex"], listed)).toEqual(["codex", "codex@mach_vps", "codex@mach_pc"]);
  });

  it("keeps a machine the agent named where it put it and adds nothing for it", () => {
    expect(expandBrains(["codex@mach_pc", "codex@local"], listed)).toEqual(["codex@mach_pc", "codex@local", "codex@mach_vps"]);
  });
});

describe("agents bound to computers", () => {
  const refs = ["claude-code@local", "api:anthropic@local", "claude-code@mach_vps", "codex@mach_vps", "codex@mach_box"];

  it("keeps every brain when the agent is bound to nothing", () => {
    expect(onMachines(refs, undefined, "local")).toEqual(refs);
    expect(onMachines(refs, [], "rep_mac")).toEqual(refs);
  });

  it("keeps the brains of its computers only, the hub's own by its replica id or local", () => {
    expect(onMachines(refs, ["mach_vps"], "rep_mac")).toEqual(["claude-code@mach_vps", "codex@mach_vps"]);
    expect(onMachines(refs, ["rep_mac"], "rep_mac")).toEqual(["claude-code@local", "api:anthropic@local"]);
    expect(onMachines(refs, ["local", "mach_box"], "rep_vps")).toEqual(["claude-code@local", "api:anthropic@local", "codex@mach_box"]);
    // Bound to the Mac while the VPS leads: nothing here is the Mac.
    expect(onMachines(refs, ["rep_mac"], "rep_vps")).toEqual([]);
    expect(onMachines(["codex"], ["local"], "local")).toEqual(["codex"]);
  });
});
