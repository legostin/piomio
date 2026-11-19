// A task's thread for the agent who asks how it goes (task_status): one line per thing that happened there, oldest
// first. The task's own words, each tool call in a few words, what its starter and the person wrote to it. The runner
// adds the header (state, the step it is on now, its last update) around these lines.

import type { MachineWork, Message } from "@piomio/shared";
import { detailOfTool, stepOfTool } from "./activity.ts";

/** Entries task_status shows when the caller names no number, and the most it shows at once. */
export const THREAD_LAST = 20;
export const THREAD_LAST_MAX = 80;

/** One entry, and all of them together, in characters. */
const LINE_MAX = 500;
const TAIL_MAX = 12_000;

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string, max = LINE_MAX) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** A turn's step for the model: "command: npm test", "thinking". */
export function stepLine(work: Pick<MachineWork, "step" | "detail">): string {
  return work.detail ? `${work.step}: ${work.detail}` : work.step;
}

/**
 * The thread's entries, oldest first: the newest `last` of them after leaving out the `skip` newest (to read further
 * back). `total` counts them all, `from` is the place of the first one returned (1 is the oldest). The first message,
 * the task's goal, is left out: task_status prints the goal itself.
 */
export function threadLines(messages: Message[], o: { last?: number; skip?: number } = {}): { lines: string[]; total: number; from: number } {
  const failed = new Set(messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "tool_result" && p.isError ? [p.id] : []))));
  const all: string[] = [];
  for (const m of messages.slice(1)) {
    for (const p of m.parts) {
      let line: string | undefined;
      if (p.type === "text") {
        const said = flat(p.text);
        if (!said) continue;
        if (m.role === "assistant") line = `Task: ${said}`;
        else if (m.role === "system") line = said.replace(/^\[System\] /, "");
        else line = m.agentId ? `${m.agentId} writes: ${said}` : `The user: ${said}`;
      } else if (p.type === "tool_call") {
        const detail = detailOfTool(p.name, p.input);
        line = `→ ${stepOfTool(p.name)}${detail ? `: ${detail}` : ""}${failed.has(p.id) ? " (failed)" : ""}`;
      } else if (p.type === "error") line = `Error: ${flat(p.message)}`;
      else if (p.type === "approval") line = `Approval “${flat(p.summary)}”: ${p.status}`;
      else if (p.type === "attachment") line = `File: ${p.name}`;
      if (line) all.push(cut(line));
    }
  }
  const last = Math.min(Math.max(Math.trunc(o.last ?? THREAD_LAST) || THREAD_LAST, 1), THREAD_LAST_MAX);
  const skip = Math.min(Math.max(Math.trunc(o.skip ?? 0) || 0, 0), all.length);
  const end = all.length - skip;
  let start = Math.max(end - last, 0);
  // The whole tail stays readable in one go: the oldest entries of a long one wait for the next call.
  let size = 0;
  for (let i = end - 1; i >= start; i--) {
    size += all[i].length + 1;
    if (size > TAIL_MAX) {
      start = i + 1;
      break;
    }
  }
  return { lines: all.slice(start, end), total: all.length, from: start + 1 };
}
