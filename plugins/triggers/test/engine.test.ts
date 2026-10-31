// In-process engine tests with a fake plugin context (persistence across "restarts", catch-up, limits, feedback).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@piomio/plugin-sdk";
import { TriggerEngine } from "../server/engine.ts";
import type { Trigger } from "../server/types.ts";

function fakeCtx(kv = new Map<string, unknown>(), tz = "Europe/Moscow") {
  const calls: Array<{ method: string; params: any }> = [];
  let n = 0;
  const ctx = {
    pluginId: "triggers",
    hubUrl: "http://127.0.0.1:8080",
    settings: {},
    i18n: { locale: () => "en", t: (key: string) => (key === "heartbeat.defaultName" ? "Daily review" : key), onChange() {} },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    ui: { emit() {}, onMessage() {} },
    storage: {
      get: async (k: string) => structuredClone(kv.get(k)),
      set: async (k: string, v: unknown) => void kv.set(k, structuredClone(v)),
      delete: async (k: string) => void kv.delete(k),
      list: async (prefix = "") => [...kv.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })),
    },
    core: {
      call: async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === "settings.get") return { timezone: tz, publicUrl: "https://bot.example.com", defaultAgent: "assistant" };
        if (method === "tasks.create") return { id: `task_${++n}` };
        if (method === "tasks.list") return [];
        if (method === "agents.list") return [{ id: "assistant", name: "A" }];
        if (method === "machines.list")
          return [
            { id: "local", name: "MacBook-Pro-legostin", status: "online" },
            { id: "m_studio", name: "Studio", status: "offline" },
          ];
        return {};
      },
    },
  } as unknown as PluginContext;
  return { ctx, kv, calls, created: () => calls.filter((c) => c.method === "tasks.create"), notified: () => calls.filter((c) => c.method === "notify") };
}

const base = (over: Partial<Trigger>): Trigger => ({
  id: "t_x",
  kind: "schedule",
  name: "Daily",
  prompt: "Do the daily thing",
  agentId: "assistant",
  enabled: true,
  maxRunsPerDay: 24,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  createdBy: "user",
  state: {},
  ...over,
});

describe("trigger engine", () => {
  it("creates the default heartbeat once, on first activation", async () => {
    const f = fakeCtx();
    const e = new TriggerEngine(f.ctx);
    await e.start();
    const hb = e.list().filter((t) => t.kind === "heartbeat");
    expect(hb).toHaveLength(1);
    expect(hb[0]).toMatchObject({ agentId: "assistant", enabled: true, times: ["10:00", "18:00"], weekdays: [1, 2, 3, 4, 5] });
    expect(hb[0].prompt).toMatch(/silent/);
    expect(hb[0].state.nextRunAt).toBeTruthy();
    e.stop();

    // Restarting does not add a second one, and deleting it is respected on the next start.
    const e2 = new TriggerEngine(f.ctx);
    await e2.start();
    expect(e2.list().filter((t) => t.kind === "heartbeat")).toHaveLength(1);
    await e2.remove(hb[0].id);
    e2.stop();
    const e3 = new TriggerEngine(f.ctx);
    await e3.start();
    expect(e3.list()).toHaveLength(0);
    e3.stop();
  });

  it("gives triggers saved before reports existed their default once, and keeps it", async () => {
    const kv = new Map<string, unknown>([["initialized", true]]);
    kv.set("trigger:t_daily", base({ id: "t_daily", cron: "0 8 * * *" }));
    kv.set("trigger:t_hourly", base({ id: "t_hourly", cron: "0 * * * *" }));
    kv.set("trigger:t_choice", base({ id: "t_choice", cron: "0 * * * *", report: true }));
    const f = fakeCtx(kv);
    const e = new TriggerEngine(f.ctx);
    await e.start();
    expect([e.get("t_daily")!.report, e.get("t_hourly")!.report, e.get("t_choice")!.report]).toEqual([true, false, true]);
    expect([(kv.get("trigger:t_daily") as Trigger).report, (kv.get("trigger:t_hourly") as Trigger).report]).toEqual([true, false]);
    e.stop();
  });

  it("tells the person once which schedules now send their report as a message, and how to undo it in the chat", async () => {
    const kv = new Map<string, unknown>([["initialized", true]]);
    kv.set("trigger:t_daily", base({ id: "t_daily", name: "Morning brief", cron: "0 8 * * *" }));
    kv.set("trigger:t_evening", base({ id: "t_evening", name: "Evening summary", cron: "0 19 * * *" }));
    // Stays a quiet check; already saved as a report; paused; a reminder that already fired: none of them is news.
    kv.set("trigger:t_hourly", base({ id: "t_hourly", name: "Hourly check", cron: "0 * * * *" }));
    kv.set("trigger:t_saved", base({ id: "t_saved", name: "Saved report", cron: "0 9 * * *", report: true }));
    kv.set("trigger:t_paused", base({ id: "t_paused", name: "Paused brief", cron: "0 7 * * *", enabled: false }));
    kv.set("trigger:t_fired", base({ id: "t_fired", kind: "once", name: "Fired reminder", cron: undefined, at: "2026-10-02T09:00:00Z", enabled: false, state: { done: true } }));
    const f = fakeCtx(kv);
    (f.ctx.i18n as any).t = (key: string, p?: Record<string, unknown>) => (p ? `${key} ${JSON.stringify(p)}` : key);
    const e = new TriggerEngine(f.ctx);
    await e.start();
    expect([e.get("t_daily")!.report, e.get("t_evening")!.report, e.get("t_paused")!.report, e.get("t_fired")!.report]).toEqual([true, true, true, true]);
    const told = f.notified();
    expect(told).toHaveLength(1);
    expect(told[0].params).toMatchObject({ level: "notify", title: 'notify.nowReports.title {"n":2}' });
    expect(told[0].params.agentId).toBeUndefined();
    const body: string = told[0].params.body;
    expect(body).toMatch(/^notify\.nowReports\.body /);
    for (const name of ["Morning brief", "Evening summary"]) expect(body).toContain(name);
    for (const name of ["Hourly check", "Saved report", "Paused brief", "Fired reminder"]) expect(body).not.toContain(name);
    e.stop();

    // They are saved with their report now: the next start announces nothing.
    const again = new TriggerEngine(f.ctx);
    await again.start();
    expect(f.notified()).toHaveLength(1);
    again.stop();
  });

  it("says nothing when no schedule became a report", async () => {
    const kv = new Map<string, unknown>([["initialized", true]]);
    kv.set("trigger:t_hourly", base({ id: "t_hourly", cron: "0 * * * *" }));
    kv.set("trigger:t_saved", base({ id: "t_saved", cron: "0 9 * * *", report: false }));
    const f = fakeCtx(kv);
    const e = new TriggerEngine(f.ctx);
    await e.start();
    expect(f.notified()).toEqual([]);
    e.stop();
  });

  it("runs at most one catch-up for missed runs after a restart", async () => {
    const now = Date.now();
    const kv = new Map<string, unknown>([["initialized", true]]);
    kv.set("trigger:t_missed", base({ id: "t_missed", cron: "0 9 * * *", state: { nextRunAt: new Date(now - 3 * 86400_000).toISOString() } }));
    kv.set("trigger:t_future", base({ id: "t_future", cron: "0 9 * * *", state: { nextRunAt: new Date(now + 3600_000).toISOString() } }));
    kv.set("trigger:t_once", base({ id: "t_once", kind: "once", cron: undefined, at: new Date(now - 5 * 60_000).toISOString() }));
    kv.set("trigger:t_off", base({ id: "t_off", enabled: false, cron: "0 9 * * *", state: { nextRunAt: new Date(now - 86400_000).toISOString() } }));
    const f = fakeCtx(kv);
    const e = new TriggerEngine(f.ctx);
    await e.start();
    await e.boot();
    const created = f.created();
    expect(created.map((c) => c.params.triggerId).sort()).toEqual(["t_missed", "t_once"]);
    expect(created[0].params).toMatchObject({ agentId: "assistant", background: true, title: "Daily" });
    expect(created.find((c) => c.params.triggerId === "t_missed")!.params.goal).toMatch(/catch-up/);
    expect(Date.parse(e.get("t_missed")!.state.nextRunAt!)).toBeGreaterThan(now);
    expect(e.get("t_once")).toMatchObject({ enabled: false, state: { done: true } });
    expect((await e.runs("t_missed"))[0]).toMatchObject({ reason: "catch-up", status: "started", taskId: expect.any(String) });
    e.stop();

    // Restart again: nothing is missed any more.
    const e2 = new TriggerEngine(f.ctx);
    await e2.start();
    await e2.boot();
    expect(f.created()).toHaveLength(2);
    e2.stop();
  });

  it("enforces the daily run limit", async () => {
    const kv = new Map<string, unknown>([["initialized", true]]);
    kv.set("trigger:t_lim", base({ id: "t_lim", maxRunsPerDay: 2, cron: "0 9 * * *" }));
    const f = fakeCtx(kv);
    const e = new TriggerEngine(f.ctx);
    await e.start();
    expect((await e.runNow("t_lim")).status).toBe("started");
    expect((await e.runNow("t_lim")).status).toBe("started");
    const third = await e.runNow("t_lim");
    expect(third).toMatchObject({ status: "skipped", detail: expect.stringContaining("limit"), code: "dailyLimit", params: { max: 2 } });
    expect(e.get("t_lim")!.state).toMatchObject({ lastStatus: "skipped", lastErrorCode: "dailyLimit" });
    expect((await e.runNow("t_lim", { force: true })).status).toBe("started"); // the user from the UI
    expect(f.created()).toHaveLength(3);
    const runs = await e.runs("t_lim");
    expect(runs).toHaveLength(4);
    expect(runs[1].status).toBe("skipped");
    e.stop();
  });

  it("keeps only the last 20 runs", async () => {
    const kv = new Map<string, unknown>([["initialized", true]]);
    kv.set("trigger:t_many", base({ id: "t_many", maxRunsPerDay: 100 }));
    const f = fakeCtx(kv);
    const e = new TriggerEngine(f.ctx);
    await e.start();
    for (let i = 0; i < 25; i++) await e.runNow("t_many");
    expect(await e.runs("t_many")).toHaveLength(20);
    e.stop();
  });

  it("applies feedback: off disables, less slows watches and drops heartbeat slots", async () => {
    const kv = new Map<string, unknown>([["initialized", true]]);
    kv.set("trigger:t_w", base({ id: "t_w", kind: "watch", cron: undefined, url: "https://e.com", intervalMinutes: 30 }));
    kv.set("trigger:t_h", base({ id: "t_h", kind: "heartbeat", cron: undefined, times: ["10:00", "18:00"], weekdays: [1, 2, 3, 4, 5] }));
    kv.set("trigger:t_s", base({ id: "t_s" }));
    const f = fakeCtx(kv);
    const e = new TriggerEngine(f.ctx);
    await e.start();
    await e.onFeedback({ id: "n1", triggerId: "t_w", feedback: "less" });
    expect(e.get("t_w")!.intervalMinutes).toBe(60);
    await e.onFeedback({ id: "n2", triggerId: "t_h", feedback: "less", createdAt: "2026-10-26T15:02:00Z" });
    expect(e.get("t_h")!.times).toEqual(["10:00"]);
    await e.onFeedback({ id: "n3", triggerId: "t_h", feedback: "less" });
    expect(e.get("t_h")!.times).toEqual(["10:00"]); // keeps at least one slot
    await e.onFeedback({ id: "n4", triggerId: "t_s", feedback: "off" });
    expect(e.get("t_s")).toMatchObject({ enabled: false, state: { nextRunAt: undefined, lastFeedback: { value: "off" } } });
    expect((kv.get("trigger:t_s") as Trigger).enabled).toBe(false);
    await e.onFeedback({ id: "n5", triggerId: "t_unknown", feedback: "off" });
    e.stop();
  });

  it("skips a scheduled run while the previous task is still running", async () => {
    const kv = new Map<string, unknown>([["initialized", true]]);
    kv.set("trigger:t_busy", base({ id: "t_busy", cron: "* * * * *", state: { lastTaskId: "task_busy", nextRunAt: new Date(Date.now() - 10).toISOString() } }));
    const f = fakeCtx(kv);
    const call = f.ctx.core.call;
    (f.ctx.core as any).call = async (m: string, p: any) => (m === "tasks.list" ? [{ id: "task_busy", status: "running" }] : call(m, p));
    const e = new TriggerEngine(f.ctx);
    await e.start();
    await e.boot(); // the planned run is within the catch-up grace period: it is just due, not missed
    await new Promise((r) => setTimeout(r, 200));
    const runs = await e.runs("t_busy");
    expect(runs[0]).toMatchObject({ status: "skipped", detail: expect.stringContaining("not finished"), code: "previousRunning" });
    expect(f.created()).toHaveLength(0);
    e.stop();
  });
  it("runs a skill the person taught: its tasks carry the skill, and it can be changed or cleared", async () => {
    const f = fakeCtx(new Map<string, unknown>([["initialized", true]]));
    const e = new TriggerEngine(f.ctx);
    await e.start();
    const t = await e.create({ kind: "schedule", name: "Water", prompt: "Order water as usual", cron: "0 9 * * 5", skill: " order-water " }, { createdBy: "agent:assistant" });
    expect(t.skill).toBe("order-water");
    await e.runNow(t.id);
    expect(f.created()[0].params).toMatchObject({ skill: "order-water", triggerId: t.id, background: true });
    await expect(e.create({ kind: "schedule", name: "X", prompt: "x", cron: "0 9 * * *", skill: 5 as unknown as string }, { createdBy: "user" })).rejects.toMatchObject({ code: "notString" });
    expect((await e.update(t.id, { skill: "order-water-v2" })).skill).toBe("order-water-v2");
    const cleared = await e.update(t.id, { skill: "" });
    expect(cleared.skill).toBeUndefined();
    await e.runNow(t.id);
    expect(f.created()[1].params.skill).toBeUndefined();
    e.stop();
  });

  it("runs on the computer the trigger names, and says so when that computer cannot take a run", async () => {
    const now = Date.now();
    const f = fakeCtx(new Map<string, unknown>([["initialized", true]]));
    const e = new TriggerEngine(f.ctx);
    await e.start();

    // By name, any case and part of it; stored as the computer's id.
    const t = await e.create({ kind: "schedule", name: "Measure", prompt: "Measure the battery", cron: "0 9 * * *", machine: "macbook" }, { createdBy: "agent:assistant" });
    expect(t).toMatchObject({ machine: "local", machineName: "MacBook-Pro-legostin" });
    await e.runNow(t.id);
    expect(f.created()[0].params).toMatchObject({ machine: "local", triggerId: t.id });
    expect(f.created()[0].params.goal).toContain("- Computer: MacBook-Pro-legostin");

    await expect(e.create({ kind: "schedule", name: "X", prompt: "x", cron: "0 9 * * *", machine: "atlantis" }, { createdBy: "user" })).rejects.toMatchObject({
      code: "unknownMachine",
      message: expect.stringContaining("MacBook-Pro-legostin (local), Studio (m_studio, offline)"),
    });

    // An offline computer can be chosen; its runs do not start, and a scheduled one tells the user.
    await e.update(t.id, { machine: "m_studio" });
    expect(await e.runNow(t.id)).toMatchObject({ status: "error", code: "machineOffline", params: { machine: "Studio" } });
    expect(f.notified()).toHaveLength(0); // asked for now: whoever asked hears it in the answer
    e.stop();

    const kv = new Map(f.kv);
    const missed = { ...(kv.get(`trigger:${t.id}`) as Trigger) };
    kv.set(`trigger:${t.id}`, { ...missed, state: { ...missed.state, nextRunAt: new Date(now - 3600_000).toISOString() } });
    const f2 = fakeCtx(kv);
    const e2 = new TriggerEngine(f2.ctx);
    await e2.start();
    await e2.boot();
    expect(f2.created()).toHaveLength(0);
    expect(f2.notified()[0].params).toMatchObject({ level: "notify", title: "notify.notRun", body: "error.machineOffline" });
    expect(e2.get(t.id)!.state).toMatchObject({ lastStatus: "error", lastErrorCode: "machineOffline" });

    // Cleared: the agent's usual brain again.
    const cleared = await e2.update(t.id, { machine: "" });
    expect(cleared.machine).toBeUndefined();
    expect(cleared.machineName).toBeUndefined();
    await e2.runNow(t.id);
    expect(f2.created()[0].params.machine).toBeUndefined();
    e2.stop();
  });
});

// The hub on several machines (cluster.ts): the Mac leads and sleeps, the VPS leads meanwhile and runs the planned slot,
// and the Mac wakes still leading. A sleeping computer's wall clock runs on while its timers stand still: here
// `vi.setSystemTime` moves the wall clock alone, and advancing the timers moves both.
describe("a replica that slept through a planned run", () => {
  const clocks = { toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] as Array<"setTimeout"> };
  const brief = () => base({ id: "t_brief", name: "Morning brief", cron: "0 8 * * *", state: { nextRunAt: "2026-10-31T03:00:00.000Z" } });
  afterEach(() => vi.useRealTimers());

  /** The Mac leads from 07:58 Almaty; the VPS (its own storage, or the same one when given) runs 08:00 while the Mac sleeps. */
  async function vpsRunsWhileMacSleeps(macKv: Map<string, unknown>, vpsKv = macKv) {
    vi.useFakeTimers(clocks);
    vi.setSystemTime(new Date("2026-10-31T02:58:00Z"));
    const mac = fakeCtx(macKv, "Asia/Almaty");
    const macEngine = new TriggerEngine(mac.ctx);
    await macEngine.start();
    await macEngine.boot();
    vi.setSystemTime(new Date("2026-10-31T03:00:00Z")); // asleep
    const vps = fakeCtx(vpsKv, "Asia/Almaty");
    const vpsEngine = new TriggerEngine(vps.ctx);
    await vpsEngine.start();
    await vpsEngine.boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(vps.created()).toHaveLength(1);
    vpsEngine.stop(); // the Mac is back: the VPS stands by
    return { mac, macEngine };
  }

  it("does not run it again when what the other replica wrote is already here", async () => {
    const kv = new Map<string, unknown>([["initialized", true], ["trigger:t_brief", brief()]]);
    const { mac, macEngine } = await vpsRunsWhileMacSleeps(kv);
    vi.setSystemTime(new Date("2026-10-31T03:02:53Z")); // wakes: its timer fires at once
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(mac.created()).toHaveLength(0);
    expect(await macEngine.runs("t_brief")).toHaveLength(1);
    expect(macEngine.get("t_brief")!.state).toMatchObject({ nextRunAt: "2026-11-01T03:00:00.000Z", runsToday: { count: 1 } });
    macEngine.stop();
  });

  it("waits for what the other replica wrote before running a slot it slept through", async () => {
    const macKv = new Map<string, unknown>([["initialized", true], ["trigger:t_brief", brief()]]);
    const vpsKv = new Map(macKv);
    const { mac, macEngine } = await vpsRunsWhileMacSleeps(macKv, vpsKv);
    vi.setSystemTime(new Date("2026-10-31T03:02:53Z"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mac.created()).toHaveLength(0);
    for (const [k, v] of vpsKv) macKv.set(k, structuredClone(v)); // replicated, seconds after the wake
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(mac.created()).toHaveLength(0);
    expect(macEngine.get("t_brief")!.state.nextRunAt).toBe("2026-11-01T03:00:00.000Z");
    macEngine.stop();
  });

  it("waits as well for a slot that comes right after it woke, while the other replica may still lead", async () => {
    vi.useFakeTimers(clocks);
    vi.setSystemTime(new Date("2026-10-31T02:56:00Z"));
    const macKv = new Map<string, unknown>([["initialized", true], ["trigger:t_brief", brief()]]);
    const vpsKv = new Map(macKv);
    const mac = fakeCtx(macKv, "Asia/Almaty");
    const macEngine = new TriggerEngine(mac.ctx);
    await macEngine.start();
    await macEngine.boot();
    vi.setSystemTime(new Date("2026-10-31T02:58:50Z")); // asleep
    await vi.advanceTimersByTimeAsync(60_000); // wakes at 07:59:50; its timer notices
    const vps = fakeCtx(vpsKv, "Asia/Almaty"); // still leads for a few seconds
    const vpsEngine = new TriggerEngine(vps.ctx);
    await vpsEngine.start();
    await vpsEngine.boot();
    await vi.advanceTimersByTimeAsync(10_000); // 08:00 on both
    expect(vps.created()).toHaveLength(1);
    expect(mac.created()).toHaveLength(0);
    vpsEngine.stop();
    for (const [k, v] of vpsKv) macKv.set(k, structuredClone(v));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(mac.created()).toHaveLength(0);
    macEngine.stop();
  });

  it("runs a slot it slept through once, after the wait, when no other replica ran it", async () => {
    vi.useFakeTimers(clocks);
    vi.setSystemTime(new Date("2026-10-31T02:58:00Z"));
    const f = fakeCtx(new Map<string, unknown>([["initialized", true], ["trigger:t_brief", brief()]]), "Asia/Almaty");
    const e = new TriggerEngine(f.ctx);
    await e.start();
    await e.boot();
    vi.setSystemTime(new Date("2026-10-31T03:02:53Z"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.created()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(f.created()).toHaveLength(1);
    expect((await e.runs("t_brief"))[0]).toMatchObject({ reason: "schedule", status: "started" });
    expect(e.get("t_brief")!.state).toMatchObject({ lastSlot: "2026-10-31T03:00:00.000Z", nextRunAt: "2026-11-01T03:00:00.000Z" });
    e.stop();
  });

  it("never runs a slot twice, even when it is planned again (the clock set back, then an edit)", async () => {
    vi.useFakeTimers(clocks);
    vi.setSystemTime(new Date("2026-10-31T02:59:30Z"));
    const f = fakeCtx(new Map<string, unknown>([["initialized", true], ["trigger:t_brief", brief()]]), "Asia/Almaty");
    const e = new TriggerEngine(f.ctx);
    await e.start();
    await e.boot();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(f.created()).toHaveLength(1);
    vi.setSystemTime(new Date("2026-10-31T02:58:30Z"));
    expect((await e.update("t_brief", { name: "Brief" })).state.nextRunAt).toBe("2026-10-31T03:00:00.000Z");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(f.created()).toHaveLength(1);
    expect(e.get("t_brief")!.state.nextRunAt).toBe("2026-11-01T03:00:00.000Z");
    e.stop();
  });
});
