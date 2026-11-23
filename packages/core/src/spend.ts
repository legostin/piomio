// What each conversation and task spends (docs/superpowers/specs/2026-11-23-thread-spend-design.md): one row per turn
// with the model and effort, tokens by kind, and dollars at API prices. A brain that prices its own turns (Claude Code)
// gives the dollars; otherwise they come from the list prices (KNOWN_PRICES) and count as an estimate; a model nobody
// prices has tokens and no dollars. Dollars are an API-price equivalent, never what a subscription bills.

import type { SpendModel, SpendPeriod, SpendReport, SpendThread, SpendTotals } from "@piomio/shared";
import { priceOf, turnCost } from "@piomio/shared";
import type { Db } from "./db.ts";
import { localDate, parseDateTime } from "./signals/schedule.ts";

/** How long turns are kept. */
export const SPEND_KEEP_DAYS = 90;
const DAY_MS = 24 * 60 * 60_000;

/** One turn as the runner (or a bare session) saw it. */
export interface SpendEntry {
  agentId: string;
  brainRef: string;
  conversationId?: string;
  taskId?: string;
  sessionId?: string;
  model?: string;
  effort?: string;
  /** A bare session's folder ("quick", "review"): what the hub's quick model was asked for. */
  purpose?: string;
  /** The whole input, as the brain's usage event gives it; the cache parts are inside it. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The brain's own figure for the turn at API prices. */
  costUsd?: number;
}

/** Tokens by kind with the input read fresh apart from the cache's parts. */
export function splitTokens(e: Pick<SpendEntry, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">) {
  const cacheRead = Math.max(0, Math.round(e.cacheReadTokens || 0));
  const cacheWrite = Math.max(0, Math.round(e.cacheWriteTokens || 0));
  return { input: Math.max(0, Math.round(e.inputTokens || 0) - cacheRead - cacheWrite), cacheRead, cacheWrite, output: Math.max(0, Math.round(e.outputTokens || 0)) };
}

/** Dollars for a turn and whether the hub estimated them; usd undefined when nobody knows the model's price. */
export function priceTurn(e: SpendEntry): { usd?: number; estimated: boolean } {
  if (typeof e.costUsd === "number" && Number.isFinite(e.costUsd) && e.costUsd >= 0) return { usd: e.costUsd, estimated: false };
  const price = priceOf(e.model);
  if (!price) return { estimated: false };
  // Claude Code asks for the one-hour prompt cache on a subscription: its writes cost twice the input.
  return { usd: turnCost(splitTokens(e), price, { longCache: e.brainRef.startsWith("claude-code") }), estimated: true };
}

const pruned = new WeakMap<Db, number>();

/** Records a turn (nothing for a turn with no tokens). Turns older than SPEND_KEEP_DAYS go once a day. */
export function recordSpend(db: Db, e: SpendEntry, now: Date = new Date()): void {
  const t = splitTokens(e);
  const { usd, estimated } = priceTurn(e);
  if (!t.input && !t.cacheRead && !t.cacheWrite && !t.output && !usd) return;
  db.prepare(
    "insert into spend(at, agent_id, conversation_id, task_id, session_id, brain_ref, model, effort, purpose, input, cache_read, cache_write, output, usd, estimated) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    now.toISOString(),
    e.agentId,
    e.conversationId ?? null,
    e.taskId ?? null,
    e.sessionId ?? null,
    e.brainRef,
    e.model ?? null,
    e.effort ?? null,
    e.purpose ?? null,
    t.input,
    t.cacheRead,
    t.cacheWrite,
    t.output,
    usd ?? null,
    estimated ? 1 : 0,
  );
  const last = pruned.get(db) ?? 0;
  if (now.getTime() - last > DAY_MS) {
    pruned.set(db, now.getTime());
    db.prepare("delete from spend where at < ?").run(new Date(now.getTime() - SPEND_KEEP_DAYS * DAY_MS).toISOString());
  }
}

/** Where a period starts: midnight today in `tz`, or 7 or 30 days back. */
export function periodStart(period: SpendPeriod, tz: string, now: Date = new Date()): Date {
  if (period === "7d") return new Date(now.getTime() - 7 * DAY_MS);
  if (period === "30d") return new Date(now.getTime() - 30 * DAY_MS);
  try {
    return parseDateTime(`${localDate(now, tz)}T00:00`, tz) ?? new Date(now.getTime() - DAY_MS);
  } catch {
    return parseDateTime(`${localDate(now, "UTC")}T00:00`, "UTC")!;
  }
}

export interface SpendReportOptions {
  period: SpendPeriod;
  timezone: string;
  now?: Date;
  /** Only this agent's turns. */
  agentId?: string;
  /** Threads listed (the rest are counted in moreThreads); default 50. */
  limit?: number;
  /** An agent's name for people, for a dialog's title. */
  agentName?: (id: string) => string | undefined;
}

const zero = (): SpendTotals => ({ usd: 0, estimatedUsd: 0, turns: 0, unpriced: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

interface Group {
  conversation_id: string | null;
  task_id: string | null;
  purpose: string | null;
  agent_id: string;
  model: string | null;
  effort: string | null;
  turns: number;
  priced: number;
  usd: number;
  estimated_usd: number;
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  last_at: string;
}

function add(into: SpendTotals, g: Group): void {
  into.usd += g.usd;
  into.estimatedUsd += g.estimated_usd;
  into.turns += g.turns;
  into.unpriced += g.turns - g.priced;
  into.input += g.input;
  into.cacheRead += g.cache_read;
  into.cacheWrite += g.cache_write;
  into.output += g.output;
}

const round = <T extends SpendTotals>(x: T): T => ({ ...x, usd: Math.round(x.usd * 1e6) / 1e6, estimatedUsd: Math.round(x.estimatedUsd * 1e6) / 1e6 });
const tokens = (x: SpendTotals) => x.input + x.cacheRead + x.cacheWrite + x.output;
const byMost = (a: SpendTotals, b: SpendTotals) => b.usd - a.usd || tokens(b) - tokens(a);

/** What was spent in a period: totals, threads by dollars, by agent and by model. */
export function spendReport(db: Db, o: SpendReportOptions): SpendReport {
  const now = o.now ?? new Date();
  const since = periodStart(o.period, o.timezone, now);
  const groups = db
    .prepare(
      `select conversation_id, task_id, purpose, agent_id, model, effort, count(*) as turns, count(usd) as priced,
        coalesce(sum(usd), 0) as usd, coalesce(sum(case when estimated = 1 then usd end), 0) as estimated_usd,
        sum(input) as input, sum(cache_read) as cache_read, sum(cache_write) as cache_write, sum(output) as output, max(at) as last_at
       from spend where at >= ?${o.agentId ? " and agent_id = ?" : ""}
       group by conversation_id, task_id, purpose, agent_id, model, effort`,
    )
    .all(...[since.toISOString(), ...(o.agentId ? [o.agentId] : [])]) as unknown as Group[];

  const conv = db.prepare("select id, kind, title, agent_id, task_id from conversations where id = ?");
  const task = db.prepare("select id, title, agent_id, conversation_id from tasks where id = ?");
  const convs = new Map<string, { kind: string; title: string; agent_id: string; task_id: string | null } | undefined>();
  const convOf = (id: string) => {
    if (!convs.has(id)) convs.set(id, conv.get(id) as any);
    return convs.get(id);
  };

  const total = zero();
  const threads = new Map<string, SpendThread & { models: SpendModel[] }>();
  const agents = new Map<string, SpendTotals & { agentId: string }>();
  const models = new Map<string, SpendTotals & { model: string }>();

  for (const g of groups) {
    add(total, g);
    const a = agents.get(g.agent_id) ?? { agentId: g.agent_id, ...zero() };
    add(a, g);
    agents.set(g.agent_id, a);
    const modelName = g.model ?? "unknown";
    const m = models.get(modelName) ?? { model: modelName, ...zero() };
    add(m, g);
    models.set(modelName, m);

    // A turn in a task's thread without the task (the person talking there) belongs to the task all the same.
    const c = g.conversation_id ? convOf(g.conversation_id) : undefined;
    const taskId = g.task_id ?? (c?.kind === "task" ? (c.task_id ?? undefined) : undefined);
    const key = taskId ?? g.conversation_id ?? `hub:${g.purpose ?? "quick"}`;
    let th = threads.get(key);
    if (!th) {
      th = {
        id: key,
        kind: taskId ? "task" : g.conversation_id ? (c?.kind === "group" ? "group" : "dialog") : "hub",
        title: "",
        agentId: c?.agent_id ?? g.agent_id,
        ...(g.conversation_id ? { conversationId: g.conversation_id } : {}),
        ...(taskId ? { taskId } : {}),
        ...(!g.conversation_id && !taskId ? { purpose: g.purpose ?? "quick" } : {}),
        models: [],
        lastAt: g.last_at,
        ...zero(),
      };
      threads.set(key, th);
    }
    add(th, g);
    if (g.last_at > th.lastAt) th.lastAt = g.last_at;
    let tm = th.models.find((x) => x.model === modelName && (x.effort ?? null) === g.effort);
    if (!tm) {
      tm = { model: modelName, ...(g.effort ? { effort: g.effort } : {}), ...zero() };
      th.models.push(tm);
    }
    add(tm, g);
  }

  const ranked = [...threads.values()].sort(byMost);
  const limit = Math.max(1, o.limit ?? 50);
  const listed = ranked.slice(0, limit);
  const ctxTask = db.prepare("select context_tokens from sessions where task_id = ? and context_tokens is not null order by coalesce(used_at, updated_at) desc limit 1");
  const ctxConv = db.prepare(
    "select context_tokens from sessions where conversation_id = ? and task_id is null and context_tokens is not null order by coalesce(used_at, updated_at) desc limit 1",
  );
  for (const th of listed) {
    if (th.kind === "task") {
      const r = task.get(th.taskId!) as { title: string; agent_id: string; conversation_id: string } | undefined;
      th.title = r?.title ?? th.taskId!;
      if (r) {
        th.agentId = r.agent_id;
        th.conversationId ??= r.conversation_id;
      }
    } else if (th.kind === "hub") th.title = `Quick model (${th.purpose})`;
    else {
      const c = convOf(th.conversationId!);
      th.title = th.kind === "dialog" && c?.kind === "main" ? (o.agentName?.(th.agentId) ?? c.title) : (c?.title ?? th.conversationId!);
    }
    const ctx = (th.kind === "task" ? ctxTask.get(th.taskId!) : th.conversationId ? ctxConv.get(th.conversationId) : undefined) as { context_tokens: number } | undefined;
    if (ctx) th.contextTokens = ctx.context_tokens;
    th.models = th.models.map(round).sort(byMost);
  }

  return {
    period: o.period,
    since: since.toISOString(),
    timezone: o.timezone,
    total: round(total),
    threads: listed.map(round),
    moreThreads: ranked.length - listed.length,
    agents: [...agents.values()].map(round).sort(byMost),
    models: [...models.values()].map(round).sort(byMost),
  };
}

// ---------- For the model (hub_usage_report) ----------

const usd = (n: number) => (n >= 0.005 ? `$${n.toFixed(2)}` : n > 0 ? "<$0.01" : "$0");
export const kTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const split = (x: SpendTotals) => `fresh input ${kTokens(x.input)}, cache read ${kTokens(x.cacheRead)}, cache write ${kTokens(x.cacheWrite)}, output ${kTokens(x.output)}`;
const money = (x: SpendTotals) =>
  `${usd(x.usd)}${x.estimatedUsd > 0 ? ` (${usd(x.estimatedUsd)} of it estimated from list prices)` : ""}${x.unpriced ? `, ${x.unpriced} turn(s) with no known price` : ""}`;
const PERIOD: Record<SpendPeriod, string> = { today: "today", "7d": "the last 7 days", "30d": "the last 30 days" };

/** The report as text for the model: what to tell the person, with the caveat about dollars. */
export function spendText(r: SpendReport, o: { agentName?: (id: string) => string | undefined } = {}): string {
  const name = (id: string) => (o.agentName?.(id) ? `${o.agentName(id)} (${id})` : id);
  const head = [
    `Spend ${PERIOD[r.period]} (since ${r.since}, time zone ${r.timezone}).`,
    "Dollars are an API-price equivalent: what the same tokens would cost on the providers' APIs. A subscription is billed differently, and Anthropic does not publish how subscription limits are counted; say so when you give dollars.",
  ];
  if (!r.total.turns) return [...head, "Nothing was spent in this period."].join("\n");
  const lines = [...head, "", `Total: ${money(r.total)} over ${r.total.turns} turn(s). Tokens: ${split(r.total)}.`, "", "Threads by spend:"];
  r.threads.forEach((t, i) => {
    const what = t.kind === "task" ? `Task "${t.title}" (task ${t.taskId})` : t.kind === "group" ? `Group chat "${t.title}"` : t.kind === "dialog" ? `Dialog with ${t.title}` : `The hub's quick model (${t.purpose})`;
    const ms = t.models.map((m) => `${m.model}${m.effort ? ` ${m.effort}` : ""} ${usd(m.usd)} (${m.turns})`).join(", ");
    lines.push(
      `${i + 1}. ${what}, agent ${name(t.agentId)}: ${money(t)}, ${t.turns} turn(s); models: ${ms}; ${split(t)}${t.contextTokens !== undefined ? `; context now ${kTokens(t.contextTokens)}` : ""}; last turn ${t.lastAt}.`,
    );
  });
  if (r.moreThreads) lines.push(`…and ${r.moreThreads} more thread(s).`);
  lines.push("", "By agent:", ...r.agents.map((a) => `- ${name(a.agentId)}: ${money(a)}, ${a.turns} turn(s)`));
  lines.push("", "By model:", ...r.models.map((m) => `- ${m.model}: ${money(m)}, ${m.turns} turn(s); ${split(m)}`));
  lines.push(
    "",
    "What usually drives it: cache writes (a long session resumed after more than an hour idle, or whose instructions changed, writes its whole context again), " +
      "the biggest models (Fable) and high efforts, and long contexts read on every turn. The person sees the same in Settings → Spend.",
  );
  return lines.join("\n");
}
