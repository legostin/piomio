// What each conversation and task spends (spend.ts; docs/superpowers/specs/2026-11-23-thread-spend-design.md): a row
// per turn, dollars from the brain or the list prices, a report by thread, agent and model, the API and the chat tool.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "@piomio/testkit";
import { priceOf, turnCost, type SpendReport } from "@piomio/shared";
import { EventBus } from "../src/bus.ts";
import { openDb } from "../src/db.ts";
import { Store } from "../src/store.ts";
import { periodStart, priceTurn, recordSpend, spendReport, spendText, SPEND_KEEP_DAYS, type SpendEntry } from "../src/spend.ts";
import { Hub, loadConfig } from "../src/index.ts";
import { MAIN_TABLES } from "../src/cluster.ts";
import { DbReplicator, type ReplEntry } from "@piomio/replica";

const turn = (o: Partial<SpendEntry> = {}): SpendEntry => ({
  agentId: "assistant",
  brainRef: "claude-code@local",
  inputTokens: 100_000,
  outputTokens: 2000,
  cacheReadTokens: 80_000,
  cacheWriteTokens: 15_000,
  ...o,
});

describe("pricing a turn", () => {
  it("takes the brain's own figure, else the list price, else none", () => {
    expect(priceTurn(turn({ costUsd: 0.42 }))).toEqual({ usd: 0.42, estimated: false });
    // Claude Code writes the one-hour cache: Fable 5.2's writes are $16 per million.
    const fable = { input: 5000, cacheRead: 80_000, cacheWrite: 15_000, output: 2000 };
    expect(priceTurn(turn({ model: "claude-fable-5-2" }))).toEqual({ usd: turnCost(fable, priceOf("claude-fable-5-2")!, { longCache: true }), estimated: true });
    expect(turnCost(fable, priceOf("claude-fable-5-2")!, { longCache: true })).toBeCloseTo((5000 * 8 + 80_000 * 0.2 + 15_000 * 16 + 2000 * 40) / 1e6, 9);
    // Another brain's writes are the five-minute kind.
    expect(priceTurn(turn({ brainRef: "api@local", model: "claude-sonnet-5-5" })).usd).toBeCloseTo((5000 * 2 + 80_000 * 0.1 + 15_000 * 2.5 + 2000 * 10) / 1e6, 9);
    expect(priceTurn(turn({ model: "some-local-model" }))).toEqual({ estimated: false });
    expect(priceTurn(turn())).toEqual({ estimated: false });
  });

  it("knows the families and aliases", () => {
    expect(priceOf("claude-opus-5-5")).toMatchObject({ input: 4, output: 20, cacheRead: 0.2 });
    expect(priceOf("opus")).toMatchObject({ input: 4 });
    expect(priceOf("claude-opus-4-8")).toMatchObject({ input: 5, output: 25 });
    expect(priceOf("claude-opus-4-1-20250805")).toMatchObject({ input: 15, output: 75 });
    expect(priceOf("claude-sonnet-5-5[1m]")).toMatchObject({ input: 2, cacheRead: 0.1 });
    expect(priceOf("claude-sonnet-4-6")).toMatchObject({ input: 3, output: 15 });
    expect(priceOf("claude-haiku-5-5")).toMatchObject({ input: 0.1, output: 0.5 });
    expect(priceOf("haiku")).toMatchObject({ input: 0.1 });
    expect(priceOf("claude-fable-5-1")).toMatchObject({ input: 10, cacheRead: 0.25 });
    expect(priceOf("gpt-6.1-sol")).toMatchObject({ input: 2, output: 10 });
    expect(priceOf("gpt-6-luna")).toMatchObject({ input: 0.1 });
    expect(priceOf("gpt-6")).toMatchObject({ input: 10, output: 50 });
    expect(priceOf("kimi-code/k3")).toMatchObject({ input: 3, output: 15 });
    expect(priceOf("k3.1-pro")).toMatchObject({ input: 2, output: 10 });
    expect(priceOf("kimi-for-coding")).toBeUndefined();
    expect(priceOf(undefined)).toBeUndefined();
  });
});

describe("the period", () => {
  it("starts at midnight in the hub's time zone, or 7 and 30 days back", () => {
    const now = new Date("2026-11-23T03:30:00Z");
    // 09:30 in Almaty (UTC+5): today began at 19:00 UTC the day before.
    expect(periodStart("today", "Asia/Almaty", now).toISOString()).toBe("2026-11-22T19:00:00.000Z");
    expect(periodStart("today", "UTC", now).toISOString()).toBe("2026-11-23T00:00:00.000Z");
    expect(periodStart("7d", "UTC", now).toISOString()).toBe("2026-11-16T03:30:00.000Z");
    expect(periodStart("30d", "UTC", now).toISOString()).toBe("2026-10-24T03:30:00.000Z");
    // A broken zone falls back to UTC's day.
    expect(periodStart("today", "Nowhere/Land", now).toISOString()).toBe("2026-11-23T00:00:00.000Z");
  });
});

describe("the report", () => {
  const db = openDb(":memory:");
  const store = new Store(db, new EventBus());
  const now = new Date("2026-11-23T12:00:00Z");
  const at = (h: number) => new Date(now.getTime() - h * 3600_000);
  const dialog = store.agentConversation("assistant");
  const task = store.createTask({ agentId: "coder", title: "Refactor the parser", goal: "x", createdBy: "user", background: false });
  const group = store.createConversation({ kind: "group", title: "Planning", agentId: "assistant", members: ["assistant", "coder"] });
  const s = store.createSession({ conversationId: task.conversationId, taskId: task.id, agentId: "coder", brainRef: "claude-code@local", background: false }).row;
  store.updateSession(s.id, { contextTokens: 310_000, usedAt: at(1).toISOString() });
  const d = store.createSession({ conversationId: dialog.id, agentId: "assistant", brainRef: "claude-code@local", background: false }).row;
  store.updateSession(d.id, { contextTokens: 95_000, usedAt: at(2).toISOString() });

  // The task: two Fable turns priced by Claude Code, one Haiku turn from the list.
  recordSpend(db, turn({ agentId: "coder", conversationId: task.conversationId, taskId: task.id, sessionId: s.id, model: "claude-fable-5-2", effort: "xhigh", costUsd: 2 }), at(3));
  recordSpend(db, turn({ agentId: "coder", conversationId: task.conversationId, taskId: task.id, sessionId: s.id, model: "claude-fable-5-2", effort: "xhigh", costUsd: 1 }), at(2));
  recordSpend(db, turn({ agentId: "coder", conversationId: task.conversationId, taskId: task.id, model: "claude-haiku-5-5" }), at(2));
  // The person talking in the task's thread without the task: still the task's.
  recordSpend(db, turn({ agentId: "coder", conversationId: task.conversationId, model: "claude-fable-5-2", effort: "xhigh", costUsd: 0.5 }), at(1));
  // The dialog: one Opus turn; a group chat turn from a model nobody prices.
  recordSpend(db, turn({ conversationId: dialog.id, sessionId: d.id, model: "claude-opus-5-5", effort: "medium", costUsd: 0.8 }), at(4));
  recordSpend(db, turn({ agentId: "coder", conversationId: group.id, brainRef: "kimi@local", model: "kimi-for-coding" }), at(5));
  // Auto mode's reviewer, with no conversation.
  recordSpend(db, turn({ agentId: "auto-review", purpose: "auto-review", model: "claude-haiku-5-5", effort: "low" }), at(1));
  // Yesterday (in UTC): outside "today".
  recordSpend(db, turn({ conversationId: dialog.id, model: "claude-opus-5-5", costUsd: 9 }), at(13));

  it("ranks the threads by dollars, with their models, efforts, context and title", () => {
    const r = spendReport(db, { period: "today", timezone: "UTC", now, agentName: (id) => (id === "assistant" ? "Pio" : undefined) });
    expect(r.threads.map((t) => [t.kind, t.title])).toEqual([
      ["task", "Refactor the parser"],
      ["dialog", "Pio"],
      ["hub", "Quick model (auto-review)"],
      ["group", "Planning"],
    ]);
    const [t, dl, hub, gr] = r.threads;
    expect(t).toMatchObject({ id: task.id, taskId: task.id, agentId: "coder", turns: 4, contextTokens: 310_000, lastAt: at(1).toISOString() });
    expect(t.usd).toBeCloseTo(3.5 + priceTurn(turn({ model: "claude-haiku-5-5" })).usd!, 6);
    expect(t.estimatedUsd).toBeCloseTo(priceTurn(turn({ model: "claude-haiku-5-5" })).usd!, 6);
    expect(t.models.map((m) => [m.model, m.effort, m.turns])).toEqual([
      ["claude-fable-5-2", "xhigh", 3],
      ["claude-haiku-5-5", undefined, 1],
    ]);
    expect(t).toMatchObject({ input: 4 * 5000, cacheRead: 4 * 80_000, cacheWrite: 4 * 15_000, output: 4 * 2000 });
    expect(dl).toMatchObject({ conversationId: dialog.id, usd: 0.8, estimatedUsd: 0, contextTokens: 95_000 });
    expect(hub).toMatchObject({ id: "hub:auto-review", purpose: "auto-review", agentId: "auto-review" });
    expect(gr).toMatchObject({ usd: 0, unpriced: 1, turns: 1 });
    expect(gr.contextTokens).toBeUndefined();
    expect(r.total.turns).toBe(7);
    expect(r.total.unpriced).toBe(1);
    expect(r.total.usd).toBeCloseTo(t.usd + dl.usd + hub.usd, 6);
    expect(r.agents.map((a) => a.agentId)).toEqual(["coder", "assistant", "auto-review"]);
    expect(r.models[0]).toMatchObject({ model: "claude-fable-5-2", turns: 3, usd: 3.5 });
    expect(r.moreThreads).toBe(0);
  });

  it("takes yesterday into 7 days, one agent alone, and a limit", () => {
    const week = spendReport(db, { period: "7d", timezone: "UTC", now });
    expect(week.total.turns).toBe(8);
    expect(week.threads[0]).toMatchObject({ kind: "dialog", usd: 9.8 });
    const coder = spendReport(db, { period: "today", timezone: "UTC", now, agentId: "coder", limit: 1 });
    expect(coder.threads.map((t) => t.kind)).toEqual(["task"]);
    expect(coder.moreThreads).toBe(1);
    expect(coder.agents.map((a) => a.agentId)).toEqual(["coder"]);
  });

  it("says it for the model, with the caveat about dollars", () => {
    const text = spendText(spendReport(db, { period: "today", timezone: "UTC", now }), { agentName: (id) => (id === "coder" ? "Coder" : undefined) });
    expect(text).toContain("API-price equivalent");
    expect(text).toContain('1. Task "Refactor the parser"');
    expect(text).toContain("agent Coder (coder)");
    expect(text).toContain("claude-fable-5-2 xhigh $3.50 (3)");
    expect(text).toContain("context now 310k");
    expect(text).toContain("1 turn(s) with no known price");
    expect(spendText(spendReport(openDb(":memory:"), { period: "today", timezone: "UTC", now }))).toContain("Nothing was spent in this period.");
  });

  it("keeps 90 days and records nothing for a turn without tokens", () => {
    const db2 = openDb(":memory:");
    recordSpend(db2, turn({ costUsd: 1 }), new Date(now.getTime() - (SPEND_KEEP_DAYS + 1) * 86_400_000));
    recordSpend(db2, turn({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), now);
    expect((db2.prepare("select count(*) as n from spend").get() as { n: number }).n).toBe(1);
    // The next day's first turn prunes the old one.
    recordSpend(db2, turn({ costUsd: 1 }), new Date(now.getTime() + 2 * 86_400_000));
    expect((db2.prepare("select count(*) as n from spend").get() as { n: number }).n).toBe(1);
  });
});

describe("spend across hub replicas", () => {
  it("reaches every replica, and turns recorded by different leaders never collide", () => {
    const tables = MAIN_TABLES.filter((t) => t.name === "spend");
    expect(tables).toHaveLength(1);
    const replica = (origin: string) => {
      const db = openDb(":memory:");
      const r = new DbReplicator({ db, origin, tables });
      r.install();
      return { db, r };
    };
    const pull = (to: ReturnType<typeof replica>, from: ReturnType<typeof replica>) => {
      from.r.drain();
      to.r.apply(JSON.parse(JSON.stringify(from.r.changesSince(to.r.vector(), 100).entries)) as ReplEntry[]);
    };
    const now = new Date();
    const a = replica("a");
    const b = replica("b");
    recordSpend(a.db, turn({ costUsd: 1 }), now);
    recordSpend(b.db, turn({ costUsd: 2 }), now);
    pull(a, b);
    pull(b, a);
    for (const x of [a, b]) expect(spendReport(x.db, { period: "today", timezone: "UTC", now }).total).toMatchObject({ usd: 3, turns: 2 });
  });
});

// ---------- In the hub: the runner records, the API and the chat tool report ----------

const fixtures = join(import.meta.dirname, "fixtures");

async function until<T>(fn: () => T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("spend in the hub (integration)", () => {
  let hub: Hub;
  let base = "";
  let cookie = "";
  let csrf = "";

  const req = async (method: string, path: string, body?: unknown): Promise<any> => {
    const r = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), origin: base, ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf": csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const json = await r.json();
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(json)}`);
    return json;
  };

  /** Say something in the default agent's dialog; the text of its reply. */
  const say = async (text: string, starts = "fake heard:"): Promise<string> => {
    const c = hub.store.agentConversation("assistant").id;
    const before = hub.store.listMessages(c, { limit: 500 }).length;
    await hub.runner.userMessage(c, text, { channel: "web" });
    const m = await until(
      () => hub.store.listMessages(c, { limit: 500 }).slice(before).find((x) => x.role === "assistant" && x.status !== "streaming" && x.parts.some((p) => p.type === "text" && p.text.startsWith(starts))),
      `the reply to ${text}`,
    );
    await until(() => !hub.runner.isRunning(c), "the turn to end");
    return (m.parts.find((p) => p.type === "text" && p.text.startsWith(starts)) as { text: string }).text;
  };

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "piomio-spend-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    await until(() => hub.brains.has("fake@local"), "the fake brain");
    base = config.publicUrl;
    await req("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    csrf = (await req("GET", "/api/bootstrap")).csrf;
    hub.saveAgent({ ...hub.agents.get("assistant")!, brains: ["fake@local"], source: "user" }, "user");
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("records each turn with its conversation, model and effort, and a task's with its task", async () => {
    await say("CONTEXT 42000");
    await say("SPEND claude-opus-5-5 0.42");
    const dialog = hub.store.agentConversation("assistant").id;
    const rows = hub.db.prepare("select * from spend where model = 'claude-opus-5-5'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent_id: "assistant", conversation_id: dialog, task_id: null, brain_ref: "fake@local", input: 100, cache_read: 600, cache_write: 300, output: 50, usd: 0.42, estimated: 0 });
    expect(rows[0].session_id).toBeTruthy();

    const task = hub.runner.createTask({ agentId: "assistant", title: "Sum it up", goal: "SPEND claude-sonnet-5-5", createdBy: "user", background: false });
    await until(() => hub.store.getTask(task.id)?.status === "done", "the task");
    const t = hub.db.prepare("select * from spend where task_id = ?").get(task.id) as any;
    expect(t).toMatchObject({ conversation_id: task.conversationId, model: "claude-sonnet-5-5", estimated: 1 });
    expect(t.usd).toBeCloseTo((100 * 2 + 600 * 0.1 + 300 * 2.5 + 50 * 10) / 1e6, 9);

    const r: SpendReport = await req("GET", "/api/spend?period=today");
    expect(r.period).toBe("today");
    expect(r.threads[0]).toMatchObject({ kind: "dialog", conversationId: dialog, contextTokens: 42_000 });
    expect(r.threads[0].models.find((m) => m.model === "claude-opus-5-5")).toMatchObject({ usd: 0.42, turns: 1 });
    expect(r.threads.find((x) => x.kind === "task")).toMatchObject({ taskId: task.id, title: "Sum it up" });
    // An unknown period is today's.
    expect((await req("GET", "/api/spend?period=forever")).period).toBe("today");
  });

  it("answers in the chat through hub_usage_report", async () => {
    const said = await say('CALL hub_usage_report {"period":"7d"}', "tool said:");
    expect(said).toContain("Spend the last 7 days");
    expect(said).toContain("API-price equivalent");
    expect(said).toContain("claude-opus-5-5");
    expect(said).toContain('Task "Sum it up"');
  });
});
