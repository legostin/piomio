// Runs: a card's work as tasks of the hub. A run starts in one of three ways, and how it started says who hears about it:
//   person: the board's Start. The hub tells them "Done: …" or "Failed: …" itself, like any task they started.
//   dialog: an agent's kanban_start. Its result goes back to that conversation, like task_delegate's.
//   auto:   the engine took the card. Nobody is waiting: the board tells the person when it is finished; a failure the
//           hub tells them. It is background work, under the agent's initiative and the day's budget.
// When a run ends the board moves the card on, unless someone already moved it out of work.

import type { PluginContext } from "@piomio/plugin-sdk";
import type { Task, ToolCallContext } from "@piomio/shared";
import type { Board, By } from "./board.ts";
import { KanbanError } from "./errors.ts";
import { composeGoal } from "./goal.ts";
import { ME, type AgentInfo, type Card, type Run } from "./types.ts";

export type StartHow = { mode: "person" } | { mode: "auto" } | { mode: "dialog"; call: ToolCallContext };

export interface StartResult {
  taskId?: string;
  /** Nothing started, and that is no error: the budget is spent or the agent sleeps. */
  skipped?: string;
}

const CLOSED = new Set(["done", "failed", "cancelled"]);
const WAITING = new Set(["waiting_approval", "waiting_input"]);
const MAX_RESULT = 20_000;

export const isOpen = (r: Run): boolean => !CLOSED.has(r.status);
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export class Work {
  /** A run ended: `ok` it succeeded; undefined when neither (the person cancelled it). */
  onSettled: (agentId: string, ok: boolean | undefined) => void = () => {};
  private ctx: PluginContext;
  private board: Board;
  /** Cards on their way to a run (the hub has not answered yet), and whose. */
  private claiming = new Map<string, string>();
  private byTask = new Map<string, string>();
  /** What the hub said about tasks while a start waited for its answer: a run can end before tasks.create returns. */
  private early = new Map<string, Task>();

  constructor(ctx: PluginContext, board: Board) {
    this.ctx = ctx;
    this.board = board;
    for (const card of board.cards.values()) for (const r of card.runs) this.byTask.set(r.taskId, card.id);
  }

  async agents(): Promise<AgentInfo[]> {
    const list = await this.ctx.core.call<AgentInfo[]>("agents.list");
    return Array.isArray(list) ? list : [];
  }

  /** The agent exists: its id, or the error the model and the page can act on. */
  async requireAgent(ref: string): Promise<AgentInfo> {
    const list = await this.agents();
    const low = String(ref ?? "").trim().toLowerCase();
    const found = list.find((a) => a.id === ref) ?? list.find((a) => a.name.toLowerCase() === low);
    if (!found) throw new KanbanError("agentNotFound", { agent: ref, known: list.map((a) => a.id).join(", ") });
    return found;
  }

  /** The agent's cards it is working on now. One waiting for the person does not hold its place. */
  busy(agentId: string): number {
    let n = 0;
    for (const a of this.claiming.values()) if (a === agentId) n++;
    for (const card of this.board.cards.values()) {
      if (card.runs.some((r) => r.agentId === agentId && isOpen(r) && !WAITING.has(r.status))) n++;
    }
    return n;
  }

  /** Someone is already at it. */
  taken(card: Card): boolean {
    return this.claiming.has(card.id) || card.runs.some(isOpen);
  }

  /** May this run go ahead with what the card says? Outside text runs only once the person let it. */
  private clearOutside(card: Card, how: StartHow, by: By): void {
    if (!card.outside || card.allowed) return;
    const asked = how.mode === "person" || (how.mode === "dialog" && !how.call.background && !how.call.tainted);
    if (!asked) throw new KanbanError("outsideNotAllowed", { card: this.board.keyOf(card) });
    this.board.allow(card, by);
  }

  async start(card: Card, agentId: string, how: StartHow, o: { by: By; note?: string }): Promise<StartResult> {
    const key = this.board.keyOf(card);
    if (this.taken(card)) throw new KanbanError("cardBusy", { card: key });
    this.clearOutside(card, how, o.by);
    const project = this.board.projects.get(card.projectId)!;
    const background = how.mode === "auto" || (how.mode === "dialog" && how.call.background);
    const tainted = card.outside || (how.mode === "dialog" && how.call.tainted);
    this.claiming.set(card.id, agentId);
    try {
      const task = await this.ctx.core.call<{ id?: string; status?: string; skipped?: string }>("tasks.create", {
        agentId,
        title: `${key}: ${card.title}`,
        goal: composeGoal(this.board, card, project, { background, ...(o.note ? { note: o.note } : {}) }),
        background,
        ...(how.mode === "person" ? {} : { byAgent: true }),
        ...(how.mode === "auto" ? { skipIfNoBudget: true } : {}),
        ...(how.mode === "dialog" ? { parentConversationId: how.call.conversationId } : {}),
        ...(tainted ? { tainted: true } : {}),
      });
      if (task?.skipped) return { skipped: task.skipped };
      if (!task?.id) throw new Error("the hub did not start a task");
      this.byTask.set(task.id, card.id);
      card.runs.push({ taskId: task.id, agentId, status: task.status ?? "queued", auto: how.mode === "auto", startedAt: new Date().toISOString() });
      card.assignee = agentId;
      this.board.note(card, o.by, "started", { agent: agentId });
      const active = this.board.firstOfType(project, "active");
      if (active && this.board.columnOf(card).type !== "active") this.board.move(card, active, { by: o.by });
      else this.board.saveCard(card);
      const early = this.early.get(task.id);
      if (early) this.onTask(early);
      return { taskId: task.id };
    } finally {
      this.claiming.delete(card.id);
      if (!this.claiming.size) this.early.clear();
    }
  }

  /** The hub says what became of a task. */
  onTask(task: Task): void {
    const cardId = this.byTask.get(task.id);
    if (!cardId) {
      if (this.claiming.size) this.early.set(task.id, task);
      return;
    }
    const card = this.board.cards.get(cardId);
    const run = card?.runs.find((r) => r.taskId === task.id);
    if (!card || !run) {
      this.byTask.delete(task.id);
      return;
    }
    const was = run.status;
    if (was === task.status && (task.question ?? undefined) === run.question) return;
    run.status = task.status;
    if (task.question) run.question = clip(task.question, 2000);
    else delete run.question;
    if (!CLOSED.has(task.status)) {
      // Going again after it ended (someone wrote on the task's page): it ends again later.
      delete run.endedAt;
      this.board.saveCard(card);
      this.onSettled(run.agentId, undefined);
      return;
    }
    if (CLOSED.has(was)) {
      this.board.saveCard(card);
      return;
    }
    run.endedAt = new Date().toISOString();
    if (task.status === "done") this.finished(card, run, task);
    else if (task.status === "failed") this.failed(card, run, task);
    else {
      this.board.note(card, { actor: run.agentId }, "cancelled");
      this.board.saveCard(card);
      this.onSettled(run.agentId, undefined);
    }
  }

  private finished(card: Card, run: Run, task: Task): void {
    run.result = clip(task.result ?? "", MAX_RESULT);
    delete run.error;
    const by: By = { actor: run.agentId, ...(task.tainted ? { tainted: true } : {}) };
    this.board.written(card, by);
    this.board.note(card, by, "finished");
    const project = this.board.projects.get(card.projectId)!;
    // The agent or the person may have moved it already: it stays where they put it.
    if (this.board.columnOf(card).type === "active") {
      const next = this.board.firstOfType(project, "review") ?? this.board.firstOfType(project, "done");
      if (next) this.board.move(card, next, { by });
      else this.board.saveCard(card);
    } else this.board.saveCard(card);
    if (run.auto) void this.tell(card, run);
    this.onSettled(run.agentId, true);
  }

  private failed(card: Card, run: Run, task: Task): void {
    run.error = clip(task.error ?? "", 2000);
    this.board.note(card, { actor: run.agentId }, "failed");
    this.board.saveCard(card);
    this.onSettled(run.agentId, false);
  }

  /** The engine took this card by itself: the person hears how it ended. */
  private async tell(card: Card, run: Run): Promise<void> {
    const column = this.board.columnOf(card);
    const kind = column.type === "review" ? "review" : column.type === "done" ? "done" : "stopped";
    try {
      await this.ctx.core.call("notify", {
        level: kind === "done" ? "digest" : "notify",
        title: this.ctx.i18n.t(`notify.${kind}`, { card: this.board.keyOf(card), title: card.title, column: column.name }),
        body: clip(run.result ?? "", 1500),
        agentId: run.agentId,
        taskId: run.taskId,
      });
    } catch (e: any) {
      this.ctx.log.warn(`could not tell about ${card.id}: ${e?.message ?? e}`);
    }
  }

  /** Catches up with tasks that moved on while this plugin was not listening. */
  async reconcile(): Promise<void> {
    for (const card of [...this.board.cards.values()]) {
      for (const run of card.runs.filter(isOpen)) {
        try {
          const task = await this.ctx.core.call<Task | null>("tasks.get", { id: run.taskId });
          if (task?.id) this.onTask(task);
          else if (this.board.cards.has(card.id)) this.onTask({ id: run.taskId, status: "cancelled" } as Task);
        } catch (e: any) {
          this.ctx.log.warn(`could not look at task ${run.taskId}: ${e?.message ?? e}`);
        }
      }
    }
  }

  accept(card: Card, by: By): Card {
    const project = this.board.projects.get(card.projectId)!;
    const done = this.board.firstOfType(project, "done");
    if (!done) throw new KanbanError("noDoneColumn", { project: project.name });
    this.board.note(card, by, "accepted");
    return this.board.move(card, done, { by });
  }

  /**
   * Back to work with what is missing: a new run for whoever did it. With nobody to hand it to (the person worked on it,
   * the agent is gone) it waits in the queue.
   */
  async returnToWork(card: Card, comment: string, how: StartHow, by: By): Promise<StartResult> {
    if (!String(comment ?? "").trim()) throw new KanbanError("commentRequired");
    if (this.taken(card)) throw new KanbanError("cardBusy", { card: this.board.keyOf(card) });
    this.board.comment(card, comment, by);
    this.board.note(card, by, "returned");
    const agents = await this.agents();
    const known = (id: string | undefined) => (id && id !== ME && agents.some((a) => a.id === id) ? id : undefined);
    const who = known(card.assignee) ?? known(card.runs.at(-1)?.agentId);
    if (who) return this.start(card, who, how, { by, note: comment.trim() });
    const project = this.board.projects.get(card.projectId)!;
    const back = this.board.firstOfType(project, "queue") ?? this.board.firstOfType(project, "backlog") ?? project.columns[0];
    this.board.move(card, back, { by });
    return {};
  }
}
