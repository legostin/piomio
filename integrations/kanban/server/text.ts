// The board as the model reads it: short lines, in English.

import type { Board } from "./board.ts";
import { ME, type Card, type PickupRule, type Project, type RuleState, type RuleView } from "./types.ts";

const who = (id: string): string => (id === ME ? "the person" : id);

export function projectLine(board: Board, p: Project): string {
  const columns = p.columns.map((c) => {
    const n = board.columnCards(c.id).length;
    return `${c.name} [${c.type}]: ${n}${c.limit ? `/${c.limit}` : ""}`;
  });
  return `${p.name} (key ${p.key}${p.archived ? ", archived" : ""}): ${columns.join(", ")}${p.description.trim() ? `\n  notes: ${p.description.trim().replace(/\s+/g, " ").slice(0, 300)}` : ""}`;
}

export function cardLine(board: Board, c: Card): string {
  const parts = [board.keyOf(c), `[${board.columnOf(c).name}]`];
  if (c.priority !== "none") parts.push(c.priority);
  parts.push(`“${c.title}”`);
  if (c.assignee) parts.push(`@${c.assignee}`);
  for (const l of c.labels) parts.push(`#${l}`);
  if (c.due) parts.push(`due ${c.due}`);
  const waits = board.openBlockers(c).map((b) => board.keyOf(b));
  if (waits.length) parts.push(`waits for ${waits.join(", ")}`);
  if (c.external) parts.push(`${c.external.source}:${c.external.id}`);
  const last = c.runs.at(-1);
  if (last) parts.push(`run ${last.status}`);
  if (c.outside && !c.allowed) parts.push("(outside content, not allowed to run yet)");
  return parts.join(" ");
}

export function cardText(board: Board, c: Card): string {
  const p = board.projects.get(c.projectId)!;
  const lines = [cardLine(board, c), `Project: ${p.name}. Columns: ${p.columns.map((x) => `${x.name} [${x.type}]`).join(", ")}.`];
  if (c.external?.url) lines.push(`Outside: ${c.external.url}`);
  if (c.description.trim()) lines.push("", "Description:", c.description.trim());
  if (c.blockedBy.length) {
    lines.push("", `Waits for: ${c.blockedBy.flatMap((id) => {
      const b = board.cards.get(id);
      return b ? [`${board.keyOf(b)}${board.isClosed(b) ? " (closed)" : ""}`] : [];
    }).join(", ")}`);
  }
  if (c.attachments.length) {
    lines.push("", "Attachments:");
    for (const a of c.attachments) lines.push(`- ${a.name} (${a.id}, ${a.size} bytes)`);
  }
  if (c.comments.length) {
    lines.push("", "Comments:");
    for (const m of c.comments.slice(-30)) lines.push(`- ${who(m.author)}, ${m.createdAt.slice(0, 10)}: ${m.text}`);
  }
  if (c.runs.length) {
    lines.push("", "Runs:");
    for (const r of c.runs.slice(-5)) {
      lines.push(`- task ${r.taskId}, ${r.agentId}: ${r.status}${r.auto ? " (took it by itself)" : ""}${r.question ? `; asks: ${r.question}` : ""}${r.error ? `; error: ${r.error}` : ""}`);
      if (r.result) lines.push(`  result: ${r.result.slice(0, 2000)}`);
    }
  }
  return lines.join("\n");
}

const WHY: Record<RuleState, string> = {
  ready: "ready",
  off: "waiting: the board's switch is off",
  paused: "paused by the person",
  initiative: "not taking: its initiative is below Acts (2), and below that a background run can only read. The person can raise it",
  agentGone: "not taking: there is no such agent any more",
  asleep: "not taking: the agent is in the archive",
  budget: "waiting: today's budget of background runs is spent; it goes on tomorrow",
  cooldown: "waiting after a failed run",
};

function ruleScope(board: Board, r: PickupRule): string {
  const projects = r.projects.flatMap((id) => {
    const p = board.projects.get(id);
    return p ? [p.name] : [];
  });
  const scope = [projects.length ? `from ${projects.join(", ")}` : "from every project", `${r.parallel} at once`];
  if (r.labels.length) scope.push(`labels ${r.labels.join(", ")}`);
  if (r.minPriority) scope.push(`at least ${r.minPriority}`);
  return scope.join(", ");
}

export function pickupText(board: Board, on: boolean, rules: RuleView[]): string {
  const lines = [`Agents taking cards by themselves: ${on ? "on" : "off"}.`];
  if (!rules.length) lines.push("No agent has a rule yet.");
  for (const r of rules) lines.push(`- ${r.agentId}: ${ruleScope(board, r)}; ${r.running} running; ${WHY[r.state]}${r.until ? ` until ${r.until}` : ""}.`);
  return lines.join("\n");
}
