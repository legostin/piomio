// How an agent thinks (AgentDef.thinking): a plain-language preset or an exact model and effort per kind of work, and
// what that comes to on the brain a session runs on. Shared by the hub (sessions), the web UI and the agents' tools.

import type { AgentDef, AgentThinking, ProbeResult, ThinkingChoice, ThinkingPreset, WorkKind } from "./types.ts";
import { MODEL_SKILLS, type ModelSkill } from "./models.ts";

export const THINKING_PRESETS: readonly ThinkingPreset[] = ["auto", "fast", "balanced", "deep"];
export const WORK_KINDS: readonly WorkKind[] = ["chat", "task", "feed", "schedule"];

/** Efforts from least to most, as brains name them: an effort a brain lacks becomes the nearest one it has. */
export const EFFORT_SCALE = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** Models and efforts become CLI arguments: plain tokens only (no leading "-"). */
const TOKEN = /^[A-Za-z0-9][\w.:/@[\]-]{0,99}$/;

export const isThinkingPreset = (v: unknown): v is ThinkingPreset => typeof v === "string" && (THINKING_PRESETS as readonly string[]).includes(v);
export const isWorkKind = (v: unknown): v is WorkKind => typeof v === "string" && (WORK_KINDS as readonly string[]).includes(v);

/** The kind of work a session does: a task's, or the dialog's (teammates' threads read like a conversation). */
export function workKind(task?: { feedId?: string; createdBy?: string; kind?: string } | null): WorkKind {
  if (!task || task.kind === "message") return "chat";
  if (task.feedId) return "feed";
  if (task.createdBy === "trigger") return "schedule";
  return "task";
}

/** A valid choice from untrusted input (frontmatter, API, tool calls), or undefined when nothing in it is valid. */
export function parseThinkingChoice(v: unknown): ThinkingChoice | undefined {
  if (!v || typeof v !== "object") return isThinkingPreset(v) ? { preset: v } : undefined;
  const o = v as Record<string, unknown>;
  const out: ThinkingChoice = {};
  if (isThinkingPreset(o.preset)) out.preset = o.preset;
  if (typeof o.model === "string" && TOKEN.test(o.model.trim())) out.model = o.model.trim();
  if (typeof o.effort === "string" && TOKEN.test(o.effort.trim())) out.effort = o.effort.trim().toLowerCase();
  if (typeof o.brain === "string" && TOKEN.test(o.brain.trim())) out.brain = o.brain.trim();
  if (typeof o.skill === "string" && (MODEL_SKILLS as readonly string[]).includes(o.skill)) out.skill = o.skill as ModelSkill;
  return Object.keys(out).length ? out : undefined;
}

/** The valid part of an agent's `thinking`, or undefined. */
export function parseThinking(v: unknown): AgentThinking | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: AgentThinking = {};
  for (const k of WORK_KINDS) {
    const c = parseThinkingChoice((v as Record<string, unknown>)[k]);
    if (c) out[k] = c;
  }
  return Object.keys(out).length ? out : undefined;
}

/** A change to one kind's choice, as the header, the card and the agents' tool make it. */
export interface ThinkingPatch {
  preset?: ThinkingPreset;
  /** "" goes back to the brain's default model (and effort). */
  model?: string;
  effort?: string;
  brain?: string;
  /** Drop the kind's own choice: it follows the general one again (for "chat": the brain's defaults). */
  follow?: boolean;
}

/**
 * The choice after a change: a preset replaces an exact model and effort and vice versa, and a new brain drops the
 * exact ones made for the old brain (its preset stays).
 */
export function patchChoice(prev: ThinkingChoice | undefined, patch: ThinkingPatch): ThinkingChoice | undefined {
  if (patch.follow) return undefined;
  const p = parseThinkingChoice(patch) ?? {};
  const next: ThinkingChoice = { ...prev };
  const exact = p.model !== undefined || p.effort !== undefined;
  if (p.preset) {
    next.preset = p.preset;
    if (!exact) {
      delete next.model;
      delete next.effort;
    }
  }
  if (exact) {
    if (!p.preset) delete next.preset;
    if (p.model !== undefined) next.model = p.model;
    if (p.effort !== undefined) next.effort = p.effort;
  }
  if (p.brain && !(next.brain && sameBrain(next.brain, p.brain))) {
    if (!exact) {
      delete next.model;
      delete next.effort;
    }
    next.brain = p.brain;
  }
  if (patch.model === "") delete next.model;
  if (patch.effort === "") delete next.effort;
  return Object.keys(next).length ? next : undefined;
}

/** `prev` with the choice for `kind` replaced (undefined: the kind follows the general one again). */
export function withChoice(prev: AgentThinking | undefined, kind: WorkKind, choice: ThinkingChoice | undefined): AgentThinking | undefined {
  const next: AgentThinking = { ...prev };
  if (choice && Object.keys(choice).length) next[kind] = choice;
  else delete next[kind];
  return Object.keys(next).length ? next : undefined;
}

/** Whether the choice says how deeply to think (rather than only which brain). */
const hasDepth = (c: ThinkingChoice | undefined): c is ThinkingChoice => !!c && !!(c.preset || c.model || c.effort);

/**
 * The kind's own choice when it has one, else the general one (chat). An agent with neither a choice nor an agent-wide
 * model (from before `thinking`) thinks "auto": the hub decides per request for every kind (core/src/model-router.ts).
 */
export function thinkingFor(agent: Pick<AgentDef, "thinking" | "model">, kind: WorkKind): ThinkingChoice {
  const general = agent.thinking?.chat ?? (agent.model ? undefined : { preset: "auto" as const });
  const own = kind === "chat" ? general : agent.thinking?.[kind];
  const depth = hasDepth(own) ? own : general;
  const brain = own?.brain ?? (depth === general ? general?.brain : undefined);
  const preset = depth?.preset;
  return {
    ...(preset ? { preset } : {}),
    ...(depth?.model ? { model: depth.model } : {}),
    ...(depth?.effort ? { effort: depth.effort } : {}),
    ...(brain ? { brain } : {}),
  };
}

/**
 * How a task thinks: the brain and depth whoever started it chose (Task.thinking), over its kind's choice. A chosen
 * depth replaces the kind's exact model and effort; a chosen brain goes first.
 */
export function taskThinking(agent: Pick<AgentDef, "thinking" | "model">, kind: WorkKind, chosen?: ThinkingChoice): ThinkingChoice {
  const base = thinkingFor(agent, kind);
  if (!chosen) return base;
  const depth = chosen.preset ? { preset: chosen.preset } : { ...(base.preset ? { preset: base.preset } : {}), ...(base.model ? { model: base.model } : {}), ...(base.effort ? { effort: base.effort } : {}) };
  const brain = chosen.brain ?? base.brain;
  return { ...depth, ...(brain ? { brain } : {}), ...(chosen.skill ? { skill: chosen.skill } : {}) };
}

/**
 * An agent's brains with "api:*" (any brain id with ":*") as every variant of that brain the hub has: each provider
 * of the API brain, so a provider set up later is in without changing the agent. Listed order; each brain once.
 */
export function expandBrains(refs: readonly string[], listed: readonly string[]): string[] {
  const out: string[] = [];
  for (const ref of refs) {
    const wild = /^([\w-]+):\*(@[\w-]+)?$/.exec(ref);
    const add = wild ? listed.filter((l) => l.startsWith(`${wild[1]}:`) && (wild[2] ? l.endsWith(wild[2]) : l.endsWith("@local") || !l.includes("@"))) : [ref];
    for (const r of add) if (!out.some((o) => sameBrain(o, r))) out.push(r);
  }
  // The pool: a brain the hub runs itself also stands for the same brain on every connected machine, after the
  // agent's own order, so work goes to whichever machine can take it now.
  for (const ref of [...out]) {
    const at = ref.lastIndexOf("@");
    if (at > 0 && ref.slice(at + 1) !== "local") continue;
    const id = at > 0 ? ref.slice(0, at) : ref;
    for (const l of listed) if (l.startsWith(`${id}@`) && !l.endsWith("@local") && !out.some((o) => sameBrain(o, l))) out.push(l);
  }
  return out;
}

/** Whether an agent is bound to computers (AgentDef.machines). */
export function bound(machines: readonly string[] | undefined): machines is readonly string[] {
  return !!machines?.length;
}

/**
 * Whether a computer is one of an agent's (AgentDef.machines; every one when it is bound to none). The hub's own computer
 * is "local" in brain refs, and a binding names it by `here` (its replica id in a cluster) or "local".
 */
export function onMachine(machineId: string, machines: readonly string[] | undefined, here: string): boolean {
  if (!bound(machines)) return true;
  return machineId === "local" || machineId === here ? machines.includes("local") || machines.includes(here) : machines.includes(machineId);
}

/** The refs on an agent's computers (onMachine); all of them when it is bound to none. */
export function onMachines(refs: readonly string[], machines: readonly string[] | undefined, here: string): string[] {
  return refs.filter((r) => {
    const at = r.lastIndexOf("@");
    return onMachine(at > 0 ? r.slice(at + 1) : "local", machines, here);
  });
}

/** How soon a brain answers, for "auto" (lower first): the API at once, a CLI after starting a process; here before elsewhere. */
export function brainSpeed(ref: string): number {
  const r = ref.includes("@") ? ref : `${ref}@local`;
  const [id, machine] = [r.slice(0, r.lastIndexOf("@")), r.slice(r.lastIndexOf("@") + 1)];
  const kind = id.startsWith("api") ? 0 : id.startsWith("claude-code") ? 1 : id.startsWith("codex") ? 2 : 3;
  return (machine === "local" ? 0 : 10) + kind;
}

/** Mirrors parseBrainRef: "claude-code" and "claude-code@local" are the same brain. */
export function sameBrain(a: string, b: string): boolean {
  const norm = (r: string) => (r.includes("@") ? r : `${r}@local`);
  return norm(a.trim()) === norm(b.trim());
}

/**
 * The agent's brains in the order a kind of work tries them: the choice's brain first; for an "auto" dialog the
 * quickest first (brainSpeed). `choice` is the work's own (taskThinking), when it has one.
 */
export function brainsFor(agent: Pick<AgentDef, "brains" | "thinking" | "model">, kind: WorkKind, choice: ThinkingChoice = thinkingFor(agent, kind)): string[] {
  const first = choice.brain;
  if (first) {
    // A brain id ("codex") stands for the agent's brains of that kind, wherever they run.
    const named = first.includes("@") ? agent.brains.filter((b) => sameBrain(b, first)) : agent.brains.filter((b) => b.split("@")[0].split(":")[0] === first || b.split("@")[0] === first);
    const lead = named.length ? named : [first];
    return [...lead, ...agent.brains.filter((b) => !lead.some((l) => sameBrain(l, b)))];
  }
  if (kind === "chat" && choice.preset === "auto") return [...agent.brains].sort((a, b) => brainSpeed(a) - brainSpeed(b));
  return agent.brains;
}

/** The effort a brain takes nearest to `effort` (the next lower one first), or undefined when it takes none. */
export function fitEffort(effort: string | undefined, efforts: readonly string[] | undefined): string | undefined {
  if (!effort) return undefined;
  if (!efforts) return effort;
  if (!efforts.length) return undefined;
  if (efforts.includes(effort)) return effort;
  const rank = (e: string) => EFFORT_SCALE.indexOf(e);
  const want = rank(effort);
  if (want < 0) return undefined;
  const known = efforts.filter((e) => rank(e) >= 0).sort((a, b) => rank(a) - rank(b));
  return known.filter((e) => rank(e) <= want).at(-1) ?? known[0];
}

export interface ResolvedThinking {
  model?: string;
  effort?: string;
  /** The preset in effect (when the model and effort come from one). */
  preset?: ThinkingPreset;
}

/**
 * The model and effort a session gets on `brainRef`: the choice's exact ones (on the brain it was made for), else its
 * preset's on this brain, else the agent's old `model`; efforts fit the brain's list.
 */
export function resolveThinking(
  choice: ThinkingChoice,
  brainRef: string,
  probe?: Pick<ProbeResult, "presets" | "efforts"> | null,
  legacyModel?: string,
): ResolvedThinking {
  const exact = !choice.brain || sameBrain(choice.brain, brainRef);
  // "auto" thinks fast (other work following an auto dialog was made balanced by thinkingFor).
  const p = choice.preset ? probe?.presets?.[choice.preset === "auto" ? "fast" : choice.preset] : undefined;
  const model = (exact ? choice.model : undefined) ?? p?.model ?? legacyModel;
  const effort = fitEffort((exact ? choice.effort : undefined) ?? p?.effort, probe?.efforts);
  const fromPreset = !!choice.preset && !(exact && (choice.model || choice.effort));
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(fromPreset ? { preset: choice.preset } : {}) };
}

/** A brain the agent can think with, as the pickers offer it (GET /api/agents/:id/thinking). */
export interface ThinkingBrain {
  ref: string;
  label: string;
  /** Answers now: connected, signed in, not over a limit. */
  ready: boolean;
  models: Array<{ id: string; name: string }>;
  /** The model it uses when none is chosen. */
  model?: string;
  efforts: string[];
  presets: NonNullable<ProbeResult["presets"]>;
}

/** One kind of work: its own choice (or none: it follows the general one) and what that comes to now. */
export interface KindThinking {
  kind: WorkKind;
  own?: ThinkingChoice;
  /** The choice in effect (thinkingFor). */
  choice: ThinkingChoice;
  /** The brain its next session runs on: the first ready one in its order. */
  brain?: string;
  model?: string;
  effort?: string;
  preset?: ThinkingPreset;
}

/** How an agent thinks, for the header picker, the chat card and the phone. */
export interface ThinkingView {
  agentId: string;
  kinds: KindThinking[];
  /** The agent's brains first (in its order), then the hub's others. */
  brains: ThinkingBrain[];
}
