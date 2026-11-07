// Auto mode's reviewer on the person's own brain (policy/auto.ts): a local CLI brain that is signed in — the reviewed
// session's own (Claude Code, Codex or Kimi) when it can, else the first of the others that can — thinking with that
// brain's cheapest model (Codex: its newest Luna, the person's pick), the second look with more effort. Every review is a bare session of its own
// (BrainSessionOptions.bare): no tools, no hub, none of the person's settings, no memory of other reviews. One
// stage-1 session is kept started, so a review does not wait for the CLI to come up. The bare-question machinery
// is shared with trigger triage: bare-ask.ts.

import { askOn, BARE_BRAINS, openBare, quickCandidates, REST_MS } from "../bare-ask.ts";
import type { BareThinking } from "../bare-ask.ts";
import type { BrainHandle, BrainRegistry } from "../brains.ts";
import type { Reviewer } from "./auto.ts";

export { cheapestModel, reviewModel } from "../bare-ask.ts";

/** Stage 1 answers at once; stage 2 is the second look. */
const EFFORT: Record<1 | 2, string> = { 1: "low", 2: "medium" };

const SESSION = {
  system: "You are the hub's auto mode reviewer. You only answer in text, exactly in the form the message asks for.",
  folder: "auto-review",
  idPrefix: "review_",
  agent: { id: "auto-review", name: "Auto mode", description: "Reviews actions instead of an approval card" },
};

export interface BrainReviewerDeps {
  brains: BrainRegistry;
  dataDir: string;
  /** The brain's environment: the hub's egress proxy, as for any brain session. */
  env?: () => Record<string, string>;
  log?: (m: string) => void;
}

/** The reviewer, or undefined when this hub has none of the brains that can review. */
export function brainReviewer(d: BrainReviewerDeps): () => Reviewer | undefined {
  const resting = new Map<string, number>();
  let ready: { key: string; handle: Promise<BrainHandle> } | undefined;

  const key = (t: BareThinking) => `${t.ref} ${t.model ?? ""} ${t.effort ?? ""}`;

  const open = (t: BareThinking, warm: boolean) => openBare(d, t, { ...SESSION, warm });

  /** Let go of the session kept started, when no review will take it. */
  const drop = () => {
    void ready?.handle.then((h) => h.close()).catch(() => {});
    ready = undefined;
  };

  /** Start the next stage-1 session now, for the review after this one. */
  const prepare = (t: BareThinking) => {
    drop();
    const handle = open(t, true);
    handle.catch(() => {});
    ready = { key: key(t), handle };
  };

  const ask = async (t: BareThinking, prompt: string, stage: 1 | 2): Promise<string> => {
    let handle: BrainHandle;
    if (stage === 1 && ready?.key === key(t)) {
      handle = await ready.handle.catch(() => open(t, false));
      ready = undefined;
    } else handle = await open(t, false);
    if (stage === 1) prepare(t);
    return askOn(handle, prompt);
  };

  const review: Reviewer = async (prompt, stage, prefer) => {
    const tried: string[] = [];
    for (const t of await quickCandidates(d, { prefer, effort: EFFORT[stage], resting })) {
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

  return () => (BARE_BRAINS.some((b) => d.brains.has(`${b}@local`)) ? review : undefined);
}
