// A task that starts with its skill's script and no model (Task.script, a trigger's scriptRun;
// docs/superpowers/specs/2026-11-24-code-mode-design.md, "Runs with no model"). The runner runs the script in a session
// of the task's own (runner.ts scriptFirst); this file is what it says about the run: to the person (the words a script
// returned) and to the agent that takes the task when the script could not finish. The notes are English: the agent
// reads them, and they stay in the task's thread, where a later run of the task finds how far its script got.

import type { Message } from "@piomio/shared";
import { describeRun, traceLines, type SkillScriptRun } from "./skill-scripts.ts";

/** The session a script runs in has no brain: this stands where a brain's id does (SessionRow.brainRef). */
export const SCRIPT_BRAIN = "script";

/** Every note of a script's run in its task's thread starts with it. */
export const SCRIPT_RUN_MARK = "[Script run]";
const STARTED = `${SCRIPT_RUN_MARK} started`;

/** A script's result kept as the task's, at most. */
const RESULT_CHARS = 4000;

/** Before the first call: a task found with only this note was cut off under its script (a restart). */
export const scriptStarted = (skill: string): string => `${STARTED}: the hub runs the script of the skill "${skill}" by itself, with no model.`;

/**
 * The words of a run for the person: a string the script returned, or the `message` of what it returned. A trigger
 * that reports delivers them as its report; with none the run says nothing by itself.
 */
export function scriptWords(value: unknown): string | undefined {
  const s = typeof value === "string" ? value : value && typeof value === "object" && !Array.isArray(value) ? (value as { message?: unknown }).message : undefined;
  return typeof s === "string" && s.trim() ? s.trim() : undefined;
}

/** What the script returned beside its words, as the task's result keeps it (JSON, cut). */
export function scriptValue(value: unknown): string | undefined {
  if (value === undefined || value === null || typeof value === "string") return undefined;
  let json: string;
  try {
    json = JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
  return json.length > RESULT_CHARS ? `${json.slice(0, RESULT_CHARS)}\n…` : json;
}

const head = (skill: string) => `${SCRIPT_RUN_MARK} The hub ran the script of the skill "${skill}" for this task by itself, with no model.`;

/** The script stopped by itself (a step failed, a refusal, the sandbox): what the agent takes the task with. */
export function scriptHandover(skill: string, run: SkillScriptRun, code: string): string {
  return `${head(skill)} It did not finish: you take the task from here.\n${describeRun(skill, run, code)}`;
}

/**
 * A step of the script waits for the person's tap longer than a call waits: the task waits with no model, and this is
 * what the agent reads once the person said yes and the hub did that step.
 */
export function scriptWaiting(skill: string, run: SkillScriptRun): string {
  const at = run.stoppedAt ?? run.trace.length - 1;
  const step = at >= 0 && run.trace[at] ? `call ${at + 1}, ${run.trace[at].call}(${run.trace[at].args})` : "a call";
  const done = traceLines(run.trace.slice(0, Math.max(0, at)));
  return (
    `${head(skill)} It stopped at ${step}: that step needs the person's yes on its card, and nothing after it ran.` +
    (done.length ? `\nCalls before it (done):\n${done.slice(-40).join("\n")}` : "") +
    "\nWhen the person says yes, the hub does that step itself. Then you do the remaining steps of the skill by hand from that point: " +
    "never repeat that step or the calls before it. The script is not at fault: do not change it for this."
  );
}

/** The hub stopped under the script: nobody knows which of its steps are done. */
export function scriptInterrupted(skill: string): string {
  return (
    `${head(skill)} The hub was restarted before the script finished, so some of its steps may be done and some not. ` +
    "Check where things stand before you do anything (the page the browser is on, what was sent or ordered): never repeat a step that may be done. " +
    "Then finish the task by hand as the skill's instructions say."
  );
}

/** The skill lost its script since the trigger was saved. */
export function scriptMissing(skill: string): string {
  return `${SCRIPT_RUN_MARK} The hub was to run the script of the skill "${skill}" for this task by itself, but the skill has no script now. Do the task by hand as the skill's instructions say.`;
}

/**
 * How far a task's script got, from its thread: undefined when it has not started; else the note the agent takes the
 * task with (the run's last note, or that it was cut off when only its start is there).
 */
export function scriptNoteIn(history: Message[], skill: string): string | undefined {
  let last: string | undefined;
  for (const m of history) {
    if (m.role !== "system") continue;
    for (const p of m.parts) if (p.type === "text" && p.text.startsWith(SCRIPT_RUN_MARK)) last = p.text;
  }
  if (last === undefined) return undefined;
  return last.startsWith(STARTED) ? scriptInterrupted(skill) : last;
}
