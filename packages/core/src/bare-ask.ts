// Bare questions to a quick model: one question in a session of its own on the person's signed-in local CLI brain
// (Claude Code, Codex or Kimi), thinking with that brain's cheapest model. No tools, no hub, none of the person's
// settings, no memory of other questions (BrainSessionOptions.bare). Auto mode's reviewer (policy/reviewer.ts) and
// trigger triage (signals/triage.ts) both ask this way.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentDef, BrainSessionOptions, ProbeResult } from "@piomio/shared";
import { fitEffort, newId } from "@piomio/shared";
import type { BrainHandle, BrainRegistry } from "./brains.ts";
import { modelsOf } from "./model-router.ts";

/** The brains that can answer, in the order tried after the preferred one. */
export const BARE_BRAINS = ["claude-code", "codex", "kimi"];
/** When a brain publishes no models: Claude Code's own alias for its cheapest. */
const FALLBACK: Record<string, string> = { "claude-code": "haiku" };
/** The person's pick of model family, by brain; the newest the brain lists is taken (GPT-6.1 Luna once there). */
const PICKED: Record<string, RegExp> = { codex: /luna/i };
/** A brain that said it cannot (not signed in, no plan, over a limit) is left alone this long. */
export const REST_MS = 5 * 60_000;

export interface BareThinking {
  ref: string;
  model?: string;
  effort?: string;
}

export interface BareAskDeps {
  brains: BrainRegistry;
  dataDir: string;
  /** The brain's environment: the hub's egress proxy, as for any brain session. */
  env?: () => Record<string, string>;
}

type Lineup = Pick<ProbeResult, "models" | "modelNames" | "catalog" | "presets">;

/** The cheapest model a brain lists, older generations included; of models as cheap, the lightest and quickest. */
export function cheapestModel(probe: Lineup): string | undefined {
  const models = modelsOf({ ref: "review", probe });
  return models.sort((a, z) => a.cost - z.cost || a.tier - z.tier || z.speed - a.speed)[0]?.id;
}

/** The version in a model's name, as numbers ("gpt-6.1-luna" → [6, 1]). */
const versionOf = (id: string) => (/\d+(?:\.\d+)*/.exec(id)?.[0] ?? "0").split(".").map(Number);

function newer(a: string, z: string): number {
  const va = versionOf(a);
  const vz = versionOf(z);
  for (let i = 0; i < Math.max(va.length, vz.length); i++) if ((va[i] ?? 0) !== (vz[i] ?? 0)) return (vz[i] ?? 0) - (va[i] ?? 0);
  return 0;
}

/** The model `brain` answers with: the newest of the person's pick when it lists one, else its cheapest. */
export function reviewModel(brain: string, probe: Lineup): string | undefined {
  const pick = PICKED[brain];
  const ids = [...new Set([...(probe.models ?? []), ...(probe.catalog ?? []).map((m) => m.id)])];
  return (pick ? ids.filter((id) => pick.test(id)).sort(newer)[0] : undefined) ?? cheapestModel(probe) ?? FALLBACK[brain];
}

/** Nobody: the session belongs to no agent of the team. */
const BARE_AGENT: AgentDef = {
  id: "bare-ask",
  name: "Quick model",
  description: "Answers one bare question",
  brains: [],
  initiative: 0,
  tools: [],
  skills: [],
  policyProfile: "strict",
  budget: { backgroundRunsPerDay: 0 },
  prompt: "",
  source: "builtin",
};

export interface BareOpen {
  system: string;
  /** Folder under the data dir the session works in. */
  folder: string;
  /** Keep the session started ahead of the question (the CLI is up before it is asked). */
  warm?: boolean;
  /** Who the session belongs to, for logs and the session list. */
  agent?: Partial<Pick<AgentDef, "id" | "name" | "description">>;
  idPrefix?: string;
}

/** Open a bare session on `t`; `warm` also brings the CLI up now. */
export async function openBare(d: BareAskDeps, t: BareThinking, o: BareOpen): Promise<BrainHandle> {
  const dir = join(d.dataDir, o.folder, t.ref.split("@")[0]);
  mkdirSync(dir, { recursive: true });
  const opts: BrainSessionOptions = {
    sessionId: newId(o.idPrefix ?? "bare_"),
    agent: { ...BARE_AGENT, ...o.agent, brains: [t.ref] },
    ...(t.model ? { model: t.model } : {}),
    ...(t.effort ? { effort: t.effort } : {}),
    workspace: dir,
    mcp: { url: "", token: "", bridgeCommand: [] },
    systemPrompt: o.system,
    env: d.env?.() ?? {},
    background: true,
    bare: true,
    ...(o.warm ? { keepWarm: true } : {}),
  };
  const handle = await d.brains.create(t.ref, opts);
  if (o.warm) await handle.warm();
  return handle;
}

/** Why an aborted question stopped (the abort's reason when it gave one). */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("the question was cancelled");
}

/**
 * Send one question on an open session and close it; rejects with `rest: true` when the brain said it cannot. With a
 * `signal`, an abort interrupts and closes the session at once (its CLI does not run on) and rejects.
 */
export async function askOn(handle: BrainHandle, prompt: string, signal?: AbortSignal): Promise<string> {
  let text = "";
  let failed: string | undefined;
  const stop = () => {
    void handle.interrupt().catch(() => {});
    void handle.close().catch(() => {});
  };
  try {
    if (signal?.aborted) throw abortError(signal);
    const sent = handle.send({ text: prompt }, (e) => {
      if (e.type === "text") text += e.delta;
      else if (e.type === "error") failed = e.message;
      else if (e.type === "limit_hit") failed = e.detail ?? "over its limit";
    });
    if (signal) {
      signal.addEventListener("abort", stop, { once: true });
      sent.catch(() => {});
      await Promise.race([sent, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(abortError(signal)), { once: true }))]);
    } else await sent;
  } finally {
    signal?.removeEventListener("abort", stop);
    void handle.close();
  }
  if (!text.trim()) throw Object.assign(new Error(failed ?? "no answer"), { rest: !!failed });
  return text;
}

/** One question in a session of its own: no tools, no hub, no memory. Rejects with `rest: true` when the brain said it cannot; `signal` closes it. */
export async function bareAsk(d: BareAskDeps, t: BareThinking, prompt: string, o: BareOpen, signal?: AbortSignal): Promise<string> {
  const handle = await openBare(d, t, o);
  return askOn(handle, prompt, signal);
}

/** The local CLI brains that are signed in, cheapest model each, effort `low`; those resting left out. */
export async function quickCandidates(
  d: BareAskDeps,
  o: { prefer?: string; effort?: string; resting?: Map<string, number> } = {},
): Promise<BareThinking[]> {
  const order = o.prefer && BARE_BRAINS.includes(o.prefer) ? [o.prefer, ...BARE_BRAINS.filter((b) => b !== o.prefer)] : BARE_BRAINS;
  const out: BareThinking[] = [];
  for (const id of order) {
    const ref = `${id}@local`;
    if (!d.brains.has(ref) || (o.resting?.get(ref) ?? 0) > Date.now()) continue;
    const probe = await d.brains.probe(ref, 10 * 60_000).catch(() => undefined);
    if (!probe?.available || !probe.authenticated) continue;
    const model = reviewModel(id, probe);
    const effort = probe.efforts?.length ? fitEffort(o.effort ?? "low", probe.efforts) : undefined;
    out.push({ ref, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
  }
  return out;
}

export interface QuickModel {
  /** `signal`: the asker stopped waiting; the session is closed (its CLI does not run on). */
  ask(prompt: string, o?: { system?: string; signal?: AbortSignal }): Promise<{ text: string; ref: string }>;
}

const QUICK_SYSTEM = "You answer a short question exactly in the form it asks for, in text only.";
/** Questions the quick model takes at once; one past that is refused at once (each holds a CLI session). */
export const QUICK_IN_FLIGHT = 2;

/**
 * The quick model: tries the signed-in brains in order; one that said it cannot rests 5 minutes. At most
 * `maxInFlight` questions at once across everything that asks it (the hub has one for its triggers); past that it is
 * unavailable at once. An aborted question closes its session and is not tried on the next brain.
 */
export function quickModel(d: BareAskDeps, o: { maxInFlight?: number } = {}): QuickModel {
  const resting = new Map<string, number>();
  const max = o.maxInFlight ?? QUICK_IN_FLIGHT;
  let inFlight = 0;
  return {
    async ask(prompt, q = {}) {
      if (inFlight >= max) throw new Error(`the quick model is busy (${max} questions at once)`);
      inFlight++;
      try {
        if (q.signal?.aborted) throw abortError(q.signal);
        const candidates = await quickCandidates(d, { resting });
        if (!candidates.length) throw new Error("no quick model is signed in");
        const tried: string[] = [];
        for (const t of candidates) {
          try {
            const text = await bareAsk(d, t, prompt, { system: q.system ?? QUICK_SYSTEM, folder: "quick" }, q.signal);
            return { text, ref: t.ref };
          } catch (e) {
            if (q.signal?.aborted) throw abortError(q.signal);
            if ((e as { rest?: boolean }).rest) resting.set(t.ref, Date.now() + REST_MS);
            tried.push(`${t.ref}: ${(e as Error).message}`);
          }
        }
        throw new Error(tried.join("; "));
      } finally {
        inFlight--;
      }
    },
  };
}
