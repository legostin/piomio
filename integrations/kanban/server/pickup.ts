// Agents taking cards by themselves. The engine does the taking, not an agent that wakes up to look: an empty queue costs
// nothing. Off until the person turns it on, and then only for agents with a rule. See the spec for why each limit is here.

import type { PluginContext } from "@piomio/plugin-sdk";
import { rankOf, type Board, type Storage } from "./board.ts";
import { KanbanError } from "./errors.ts";
import { PRIORITIES, type AgentInfo, type Card, type PickupRule, type Priority, type RuleState, type RuleView } from "./types.ts";
import type { Work } from "./work.ts";

const TICK_MS = 60_000;
/** Initiative "Acts": below it a background run can only read. */
export const ACTS = 2;
const COOLDOWN_MS = 15 * 60_000;
const MAX_COOLDOWN_MS = 6 * 3600_000;
const MAX_PARALLEL = 10;

export interface RuleInput {
  enabled?: boolean;
  projects?: string[];
  labels?: string[];
  minPriority?: string | null;
  parallel?: number;
}

/** Most urgent first, then the nearest due date, then the board's own order. */
function byOrder(a: Card, b: Card): number {
  const due = (a.due ?? "9999") < (b.due ?? "9999") ? -1 : (a.due ?? "9999") > (b.due ?? "9999") ? 1 : 0;
  return rankOf(a.priority) - rankOf(b.priority) || due || a.position - b.position || a.createdAt.localeCompare(b.createdAt);
}

export class Pickup {
  on = false;
  rules = new Map<string, PickupRule>();
  private ctx: PluginContext;
  private board: Board;
  private work: Work;
  private storage: Storage;
  private cooldowns = new Map<string, { until: number; fails: number }>();
  private noBudget = new Map<string, string>();
  private asleep = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private ticking = false;
  private again = false;

  constructor(ctx: PluginContext, board: Board, work: Work) {
    this.ctx = ctx;
    this.board = board;
    this.work = work;
    this.storage = ctx.storage;
  }

  async load(): Promise<void> {
    this.on = (await this.ctx.storage.get<boolean>("pickup:on")) === true;
    for (const { value } of await this.storage.list("rule:")) {
      const r = value as PickupRule;
      this.rules.set(r.agentId, r);
    }
  }

  start(): void {
    this.interval = setInterval(() => void this.minute(), TICK_MS);
    this.interval.unref();
    void this.minute();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
  }

  private async minute(): Promise<void> {
    await this.work.reconcile();
    this.kick();
  }

  /** Look soon: several changes at once are one look. */
  kick(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, 50);
    this.timer.unref?.();
  }

  async setOn(on: boolean): Promise<void> {
    this.on = on;
    await this.storage.set("pickup:on", on);
    this.board.onChange({});
    this.kick();
  }

  async setRule(agentId: string, input: RuleInput): Promise<PickupRule> {
    const old = this.rules.get(agentId);
    const parallel = input.parallel ?? old?.parallel ?? 1;
    if (!Number.isInteger(parallel) || parallel < 1 || parallel > MAX_PARALLEL) throw new KanbanError("parallelInvalid", { max: MAX_PARALLEL });
    const minPriority = input.minPriority === undefined ? old?.minPriority : input.minPriority || undefined;
    if (minPriority && !PRIORITIES.includes(minPriority as Priority)) throw new KanbanError("priorityInvalid", { priority: minPriority, known: PRIORITIES.join(", ") });
    const at = new Date().toISOString();
    const rule: PickupRule = {
      agentId,
      enabled: input.enabled ?? old?.enabled ?? true,
      projects: input.projects ? input.projects.map((p) => this.board.project(p).id) : (old?.projects ?? []),
      labels: input.labels ? [...new Set(input.labels.map((l) => String(l).trim().toLowerCase()).filter(Boolean))] : (old?.labels ?? []),
      ...(minPriority ? { minPriority: minPriority as Priority } : {}),
      parallel,
      createdAt: old?.createdAt ?? at,
      updatedAt: at,
    };
    this.rules.set(agentId, rule);
    await this.storage.set(`rule:${agentId}`, rule);
    this.cooldowns.delete(agentId);
    this.board.onChange({});
    this.kick();
    return rule;
  }

  async removeRule(agentId: string): Promise<void> {
    if (!this.rules.delete(agentId)) return;
    await this.storage.delete(`rule:${agentId}`);
    this.board.onChange({});
  }

  /** A run ended: it frees a place, and a failure makes the agent wait before the next card. */
  settled(agentId: string, ok: boolean | undefined): void {
    if (ok === true) this.cooldowns.delete(agentId);
    if (ok === false) {
      const fails = (this.cooldowns.get(agentId)?.fails ?? 0) + 1;
      this.cooldowns.set(agentId, { fails, until: Date.now() + Math.min(COOLDOWN_MS * 2 ** (fails - 1), MAX_COOLDOWN_MS) });
    }
    this.kick();
  }

  /** The next card this rule takes. */
  next(rule: PickupRule): Card | undefined {
    const candidates: Card[] = [];
    for (const project of this.board.projectList()) {
      if (rule.projects.length && !rule.projects.includes(project.id)) continue;
      const active = this.board.firstOfType(project, "active");
      if (active?.limit && this.board.columnCards(active.id).length >= active.limit) continue;
      for (const column of project.columns) {
        if (column.type !== "queue") continue;
        for (const card of this.board.columnCards(column.id)) {
          if (card.assignee && card.assignee !== rule.agentId) continue;
          if (rule.labels.length && !card.labels.some((l) => rule.labels.includes(l))) continue;
          if (rule.minPriority && rankOf(card.priority) > rankOf(rule.minPriority)) continue;
          if (card.outside && !card.allowed) continue;
          if (this.work.taken(card) || this.board.openBlockers(card).length) continue;
          candidates.push(card);
        }
      }
    }
    return candidates.sort(byOrder)[0];
  }

  private cooling(agentId: string): number | undefined {
    const c = this.cooldowns.get(agentId);
    return c && c.until > Date.now() ? c.until : undefined;
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private async tick(): Promise<void> {
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    try {
      await this.round();
    } catch (e: any) {
      this.ctx.log.warn(`taking cards failed: ${e?.message ?? e}`);
    } finally {
      this.ticking = false;
      if (this.again) {
        this.again = false;
        this.kick();
      }
    }
  }

  private async round(): Promise<void> {
    if (!this.on) return;
    const rules = [...this.rules.values()].filter((r) => r.enabled && !this.cooling(r.agentId) && this.next(r)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!rules.length) return;
    const agents = await this.work.agents();
    for (const rule of rules) {
      const agent = agents.find((a) => a.id === rule.agentId);
      if (!agent || agent.initiative < ACTS) continue;
      await this.fill(rule);
    }
  }

  /** Takes cards until the agent's places are full. */
  private async fill(rule: PickupRule): Promise<void> {
    const by = { actor: rule.agentId };
    while (this.work.busy(rule.agentId) < rule.parallel) {
      const card = this.next(rule);
      if (!card) return;
      try {
        const r = await this.work.start(card, rule.agentId, { mode: "auto" }, { by });
        if (r.skipped === "budgetExhausted") this.noBudget.set(rule.agentId, this.today());
        else this.noBudget.delete(rule.agentId);
        if (r.skipped === "agentArchived") this.asleep.add(rule.agentId);
        else this.asleep.delete(rule.agentId);
        if (r.skipped) return;
      } catch (e: any) {
        // The hub said no (not the budget, not an archived agent): the card stays, and the agent waits like after a failure.
        this.ctx.log.warn(`${rule.agentId} could not take ${this.board.keyOf(card)}: ${e?.message ?? e}`);
        this.settled(rule.agentId, false);
        return;
      }
    }
  }

  // ---------- what people and agents read ----------

  private stateOf(rule: PickupRule, agent: AgentInfo | undefined): { state: RuleState; until?: string } {
    if (!agent) return { state: "agentGone" };
    if (!this.on) return { state: "off" };
    if (!rule.enabled) return { state: "paused" };
    if (agent.initiative < ACTS) return { state: "initiative" };
    if (this.asleep.has(rule.agentId)) return { state: "asleep" };
    const until = this.cooling(rule.agentId);
    if (until) return { state: "cooldown", until: new Date(until).toISOString() };
    if (this.noBudget.get(rule.agentId) === this.today()) return { state: "budget" };
    return { state: "ready" };
  }

  views(agents: AgentInfo[]): RuleView[] {
    return [...this.rules.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => ({ ...r, ...this.stateOf(r, agents.find((a) => a.id === r.agentId)), running: this.work.busy(r.agentId) }));
  }
}
