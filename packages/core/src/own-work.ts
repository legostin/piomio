// What an agent said and did lately in its other sessions. An agent is one person, but a thread with a teammate or a
// task a teammate started opens as a new brain session that has heard nothing of the agent's dialog with the user or of
// the work it just finished: asked by a colleague about its own morning, it would say it knows nothing. The
// `[Your recent work]` block gives such a session the recent part before its first input and, before a later one, what
// is new since; self_recall looks further back (the dialog's messages and the agent's tasks that mention some words).
// The runner gathers the messages and tasks and marks the session when any of it read outside content.

import type { Message, Task } from "@piomio/shared";
import { truncate } from "@piomio/shared";
import { partsText } from "./continuity.ts";

/** The block: how much of the dialog it shows (characters in all, per message) and how much of a task's result. */
const DIALOG_CHARS = 6000;
const MESSAGE_CHARS = 1200;
const RESULT_CHARS = 600;
/** How many of the agent's finished tasks the block shows on a session's first turn, and how far back it looks for them. */
export const RECENT_TASKS = 6;
export const RECENT_TASKS_MS = 48 * 60 * 60_000;
/** How many of the dialog's newest messages the block is made from. */
export const RECENT_MESSAGES = 30;
/** self_recall: entries it shows by default and at most, and how far back in the dialog it reads. */
export const RECALL_DEFAULT = 12;
export const RECALL_MAX = 40;
export const RECALL_MESSAGES = 3000;
export const RECALL_TASKS = 500;
const RECALL_LINE_CHARS = 1500;

export interface OwnWork {
  /** The agent's dialog with the user, oldest first. */
  dialog: Message[];
  /** The agent's own tasks that ended, oldest first. */
  tasks: Task[];
  /** A moment in the user's time zone: "23:02", or "27 Oct, 23:02" on another day. */
  time: (iso: string) => string;
  /** Who started a task, as a tail for its line (" from the user", " from Owl"). */
  from?: (t: Task) => string;
}

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/** The dialog's own words: the person's and the agent's. Notes for the model and a reply still being written are not. */
function spoken(m: Message): boolean {
  if (m.status === "streaming" || m.quiet) return false;
  return m.role === "assistant" || (m.role === "user" && !m.agentId);
}

const words = (m: Message) => flat(partsText(m.parts));
const messageLine = (m: Message, w: OwnWork, max: number) => `- ${w.time(m.createdAt)} ${m.role === "user" ? "User" : "You"}: ${truncate(words(m), max)}`;

function taskLine(t: Task, w: OwnWork, max: number): string {
  const said = flat((t.status === "failed" ? t.error : t.result) ?? "");
  return `- ${t.id} “${flat(t.title)}”${w.from?.(t) ?? ""}, ${t.status === "failed" ? "failed" : "done"} ${w.time(t.updatedAt)}${said ? `: ${truncate(said, max)}` : ""}`;
}

/**
 * The `[Your recent work]` block, or undefined when there is nothing to show. `again`: the session heard the block
 * before, and these are only the messages and tasks that are new since.
 */
export function recentWork(w: OwnWork, o: { again?: boolean } = {}): string | undefined {
  const said = w.dialog.filter((m) => spoken(m) && words(m));
  // The newest messages that fit, oldest first.
  const lines: string[] = [];
  let used = 0;
  for (let i = said.length - 1; i >= 0; i--) {
    const line = messageLine(said[i], w, MESSAGE_CHARS);
    if (lines.length && used + line.length > DIALOG_CHARS) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  const left = said.length - lines.length;
  if (!lines.length && !w.tasks.length) return undefined;
  const out = [
    o.again
      ? "[Your recent work] New in your other sessions since this one last heard:"
      : "[Your recent work] What you said and did in your other sessions (they are all you): answer from it as from your own memory. `self_recall` looks further back, `task_status` shows a task whole.",
  ];
  if (lines.length) out.push(`Your dialog with the user${left > 0 ? ` (${left} older messages left out)` : ""}:`, ...lines);
  if (w.tasks.length) out.push("Tasks you finished:", ...w.tasks.map((t) => taskLine(t, w, RESULT_CHARS)));
  return out.join("\n");
}

/** A word without its ending, so that "filters" finds "filter" and "фильтрам" finds "фильтры". */
function stem(word: string): string {
  return word.length > 4 ? word.slice(0, Math.max(4, word.length - 2)) : word;
}

/** The query's words to look for; the shortest ones ("of", "по") say nothing. */
const stems = (query: string) => [...new Set(query.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x.length > 2).map(stem))];

/** How many of the query's words the text has, in any form and letter case. */
function hits(text: string, need: string[]): number {
  const hay = text.toLocaleLowerCase();
  return need.filter((s) => hay.includes(s)).length;
}

/** Whether the text has every word of the query. */
export function mentions(text: string, query: string): boolean {
  const need = stems(query);
  return need.length > 0 && hits(text, need) === need.length;
}

/** The part of a long text around the first word of the query. */
function around(text: string, query: string, max: number): string {
  if (text.length <= max) return text;
  const at = Math.min(...stems(query).map((s) => text.toLocaleLowerCase().indexOf(s)).filter((i) => i >= 0), text.length);
  const from = Math.max(0, Math.min(at - Math.floor(max / 4), text.length - max));
  return `${from > 0 ? "…" : ""}${truncate(text.slice(from), max)}`;
}

/**
 * self_recall's answer: the dialog's messages and the agent's tasks that mention the query, newest first (when none
 * has all its words, the ones that have the most of them); without a query, the latest of both. `shown` gets what it
 * lists: the runner marks the session by what those read.
 */
export function recallText(w: OwnWork, o: { query?: string; limit?: number; shown?: (tasks: Task[], messages: Message[]) => void }): string {
  const query = flat(o.query ?? "").slice(0, 200);
  const limit = Math.min(Math.max(Math.trunc(o.limit ?? RECALL_DEFAULT) || RECALL_DEFAULT, 1), RECALL_MAX);
  const said = w.dialog.filter((m) => spoken(m) && words(m));
  const taskWords = (t: Task) => [t.title, t.goal, t.result ?? "", t.error ?? ""].join("\n");
  const need = stems(query);
  const best = need.length ? Math.max(0, ...said.map((m) => hits(words(m), need)), ...w.tasks.map((t) => hits(taskWords(t), need))) : 0;
  const found = <T>(all: T[], text: (x: T) => string) => (need.length ? all.filter((x) => best > 0 && hits(text(x), need) === best) : query ? [] : all).slice(-limit).reverse();
  const messages = found(said, words);
  const tasks = found(w.tasks, taskWords);
  o.shown?.(tasks, messages);
  if (!messages.length && !tasks.length) {
    return query
      ? `Nothing in your dialog with the user or your tasks mentions "${query}". Try one or two other words, or no query for the latest.`
      : "Nothing yet: your dialog with the user is empty and you have finished no tasks.";
  }
  const out = [
    !query
      ? "The latest in your other sessions, newest first:"
      : best === need.length
        ? `What mentions "${query}" in your other sessions, newest first:`
        : `Nothing in your other sessions has all the words of "${query}"; the closest, newest first:`,
  ];
  if (messages.length) {
    out.push(
      "Your dialog with the user:",
      ...messages.map((m) => `- ${w.time(m.createdAt)} ${m.role === "user" ? "User" : "You"}: ${query ? around(words(m), query, RECALL_LINE_CHARS) : truncate(words(m), RECALL_LINE_CHARS)}`),
    );
  }
  if (tasks.length) out.push("Your tasks (task_status shows one whole):", ...tasks.map((t) => taskLine(t, w, RESULT_CHARS)));
  return out.join("\n");
}
