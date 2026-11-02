// Auto mode's reviewer on the person's own brain (policy/auto.ts): a local CLI brain that is signed in — the reviewed
// session's own (Claude Code, Codex or Kimi) when it can, else the first of the others that can — thinking with that
// brain's cheapest model (Codex: its newest Luna, the person's pick), the second look with more effort. Every review is a bare session of its own
// (BrainSessionOptions.bare): no tools, no hub, none of the person's settings, no memory of other reviews. One
// stage-1 session is kept started, so a review does not wait for the CLI to come up.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentDef, BrainSessionOptions, ProbeResult } from "@piomio/shared";
import { fitEffort, newId } from "@piomio/shared";
import type { BrainHandle, BrainRegistry } from "../brains.ts";
import { modelsOf } from "../model-router.ts";
import type { Reviewer } from "./auto.ts";

/** The brains that can review, in the order tried after the reviewed session's own. */
const BRAINS = ["claude-code", "codex", "kimi"];
/** When a brain publishes no models: Claude Code's own alias for its cheapest. */
const FALLBACK: Record<string, string> = { "claude-code": "haiku" };
/** The person's pick of model family for reviews, by brain; the newest the brain lists is taken (GPT-6.1 Luna once there). */
const PICKED: Record<string, RegExp> = { codex: /luna/i };
/** Stage 1 answers at once; stage 2 is the second look. */
const EFFORT: Record<1 | 2, string> = { 1: "low", 2: "medium" };
/** A brain that said it cannot (not signed in, no plan, over a limit) is left alone this long. */
const REST_MS = 5 * 60_000;

/** Nobody: the session belongs to no agent of the team. */
const REVIEWER: AgentDef = {
  id: "auto-review",
  name: "Auto mode",
  description: "Reviews actions instead of an approval card",
  brains: [],
  initiative: 0,
  tools: [],
  skills: [],
  policyProfile: "strict",
  budget: { backgroundRunsPerDay: 0 },
  prompt: "",
  source: "builtin",
};

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

/** The model `brain` reviews with: the newest of the person's pick when it lists one, else its cheapest. */
export function reviewModel(brain: string, probe: Lineup): string | undefined {
  const pick = PICKED[brain];
  const ids = [...new Set([...(probe.models ?? []), ...(probe.catalog ?? []).map((m) => m.id)])];
  return (pick ? ids.filter((id) => pick.test(id)).sort(newer)[0] : undefined) ?? cheapestModel(probe) ?? FALLBACK[brain];
}

export interface BrainReviewerDeps {
  brains: BrainRegistry;
  dataDir: string;
  /** The brain's environment: the hub's egress proxy, as for any brain session. */
  env?: () => Record<string, string>;
  log?: (m: string) => void;
}

interface Thinking {
  ref: string;
  model?: string;
  effort?: string;
}

/** The reviewer, or undefined when this hub has none of the brains that can review. */
export function brainReviewer(d: BrainReviewerDeps): () => Reviewer | undefined {
  const resting = new Map<string, number>();
  let ready: { key: string; handle: Promise<BrainHandle> } | undefined;

  /** The brains to try, the preferred one first, each with its review model; those not signed in left out. */
  const candidates = async (stage: 1 | 2, prefer?: string): Promise<Thinking[]> => {
    const order = prefer && BRAINS.includes(prefer) ? [prefer, ...BRAINS.filter((b) => b !== prefer)] : BRAINS;
    const out: Thinking[] = [];
    for (const id of order) {
      const ref = `${id}@local`;
      if (!d.brains.has(ref) || (resting.get(ref) ?? 0) > Date.now()) continue;
      const probe = await d.brains.probe(ref, 10 * 60_000).catch(() => undefined);
      if (!probe?.available || !probe.authenticated) continue;
      const model = reviewModel(id, probe);
      const effort = probe.efforts?.length ? fitEffort(EFFORT[stage], probe.efforts) : undefined;
      out.push({ ref, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    }
    return out;
  };

  const key = (t: Thinking) => `${t.ref} ${t.model ?? ""} ${t.effort ?? ""}`;

  const open = async (t: Thinking, warm: boolean): Promise<BrainHandle> => {
    const dir = join(d.dataDir, "auto-review", t.ref.split("@")[0]);
    mkdirSync(dir, { recursive: true });
    const opts: BrainSessionOptions = {
      sessionId: newId("review_"),
      agent: { ...REVIEWER, brains: [t.ref] },
      ...(t.model ? { model: t.model } : {}),
      ...(t.effort ? { effort: t.effort } : {}),
      workspace: dir,
      mcp: { url: "", token: "", bridgeCommand: [] },
      systemPrompt: "You are the hub's auto mode reviewer. You only answer in text, exactly in the form the message asks for.",
      env: d.env?.() ?? {},
      background: true,
      bare: true,
      ...(warm ? { keepWarm: true } : {}),
    };
    const handle = await d.brains.create(t.ref, opts);
    if (warm) await handle.warm();
    return handle;
  };

  /** Let go of the session kept started, when no review will take it. */
  const drop = () => {
    void ready?.handle.then((h) => h.close()).catch(() => {});
    ready = undefined;
  };

  /** Start the next stage-1 session now, for the review after this one. */
  const prepare = (t: Thinking) => {
    drop();
    const handle = open(t, true);
    handle.catch(() => {});
    ready = { key: key(t), handle };
  };

  const ask = async (t: Thinking, prompt: string, stage: 1 | 2): Promise<string> => {
    let handle: BrainHandle;
    if (stage === 1 && ready?.key === key(t)) {
      handle = await ready.handle.catch(() => open(t, false));
      ready = undefined;
    } else handle = await open(t, false);
    if (stage === 1) prepare(t);
    let text = "";
    let failed: string | undefined;
    try {
      await handle.send({ text: prompt }, (e) => {
        if (e.type === "text") text += e.delta;
        else if (e.type === "error") failed = e.message;
        else if (e.type === "limit_hit") failed = e.detail ?? "over its limit";
      });
    } finally {
      void handle.close();
    }
    if (!text.trim()) throw Object.assign(new Error(failed ?? "no answer"), { rest: !!failed });
    return text;
  };

  const review: Reviewer = async (prompt, stage, prefer) => {
    const tried: string[] = [];
    for (const t of await candidates(stage, prefer)) {
      try {
        const text = await ask(t, prompt, stage);
        d.log?.(`[auto] stage ${stage} on ${t.ref} ${t.model ?? ""}: ${text.trim().slice(0, 80)}`);
        return text;
      } catch (e) {
        // The next brain takes it; one that said it cannot rests a while.
        if ((e as { rest?: boolean }).rest) resting.set(t.ref, Date.now() + REST_MS);
        if (ready?.key === key(t)) drop();
        tried.push(`${t.ref}: ${(e as Error).message}`);
      }
    }
    throw new Error(tried.length ? tried.join("; ") : "no brain on this computer is signed in to review");
  };

  return () => (BRAINS.some((b) => d.brains.has(`${b}@local`)) ? review : undefined);
}
