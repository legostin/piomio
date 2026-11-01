// Auto mode's reviewer on the person's own brain (policy/auto.ts): the local Claude Code, signed in, thinking with its
// quickest model for stage 1 and a stronger one for stage 2 (model-router.ts). Every review is a bare session of its
// own (BrainSessionOptions.bare): no tools, no hub, none of the person's settings, no memory of other reviews. One
// stage-1 session is kept started, so a review does not wait for the CLI to come up.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentDef, BrainSessionOptions } from "@piomio/shared";
import { newId } from "@piomio/shared";
import type { BrainHandle, BrainRegistry } from "../brains.ts";
import { route, type Need } from "../model-router.ts";
import type { Reviewer } from "./auto.ts";

const BRAIN = "claude-code@local";
/** When the brain publishes no models: Claude Code's own aliases. */
const FALLBACK: Record<1 | 2, string> = { 1: "haiku", 2: "sonnet" };
const NEED: Record<1 | 2, Need> = { 1: "light", 2: "quick" };

/** Nobody: the session belongs to no agent of the team. */
const REVIEWER: AgentDef = {
  id: "auto-review",
  name: "Auto mode",
  description: "Reviews actions instead of an approval card",
  brains: [BRAIN],
  initiative: 0,
  tools: [],
  skills: [],
  policyProfile: "strict",
  budget: { backgroundRunsPerDay: 0 },
  prompt: "",
  source: "builtin",
};

export interface BrainReviewerDeps {
  brains: BrainRegistry;
  dataDir: string;
  /** The brain's environment: the hub's egress proxy, as for any brain session. */
  env?: () => Record<string, string>;
  log?: (m: string) => void;
}

/** The reviewer, or undefined when this hub has no Claude Code of its own. */
export function brainReviewer(d: BrainReviewerDeps): () => Reviewer | undefined {
  const dir = join(d.dataDir, "auto-review");
  let ready: { model: string; handle: Promise<BrainHandle> } | undefined;

  const model = async (stage: 1 | 2): Promise<string> => {
    const probe = await d.brains.probe(BRAIN, 10 * 60_000);
    if (!probe.available || !probe.authenticated) throw new Error(`Claude Code on this computer is ${probe.available ? "not signed in" : "not available"}`);
    return route([{ ref: BRAIN, probe }], { need: NEED[stage] })[0]?.model ?? FALLBACK[stage];
  };

  const open = async (m: string, warm: boolean): Promise<BrainHandle> => {
    mkdirSync(dir, { recursive: true });
    const opts: BrainSessionOptions = {
      sessionId: newId("review_"),
      agent: REVIEWER,
      model: m,
      workspace: dir,
      mcp: { url: "", token: "", bridgeCommand: [] },
      systemPrompt: "You are the hub's auto mode reviewer. You only answer in text, exactly in the form the message asks for.",
      env: d.env?.() ?? {},
      background: true,
      bare: true,
      ...(warm ? { keepWarm: true } : {}),
    };
    const handle = await d.brains.create(BRAIN, opts);
    if (warm) await handle.warm();
    return handle;
  };

  /** Start the next stage-1 session now, for the review after this one. */
  const prepare = (m: string) => {
    const handle = open(m, true);
    handle.catch(() => {});
    ready = { model: m, handle };
  };

  const review: Reviewer = async (prompt, stage) => {
    const m = await model(stage);
    let handle: BrainHandle;
    if (stage === 1 && ready?.model === m) {
      handle = await ready.handle.catch(() => open(m, false));
      ready = undefined;
    } else handle = await open(m, false);
    if (stage === 1) prepare(m);
    let text = "";
    let failed: string | undefined;
    try {
      await handle.send({ text: prompt }, (e) => {
        if (e.type === "text") text += e.delta;
        else if (e.type === "error") failed = e.message;
        else if (e.type === "limit_hit") failed = e.detail;
      });
    } finally {
      void handle.close();
    }
    if (!text.trim() && failed) throw new Error(failed);
    d.log?.(`[auto] stage ${stage} on ${m}: ${text.trim().slice(0, 80)}`);
    return text;
  };

  return () => (d.brains.has(BRAIN) ? review : undefined);
}
