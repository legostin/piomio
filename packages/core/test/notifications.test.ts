// Notifications as an Inbox: storage, intake, reports, the digest the assistant writes, the Inbox read model
// (docs/superpowers/specs/2026-10-31-notifications-inbox-design.md).

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { EventBus } from "../src/bus.ts";
import { Store } from "../src/store.ts";
import { nowIso, type MessagePart, type OutboundMessage, type Task } from "@piomio/shared";
import { Settings, type CoreSettings } from "../src/settings.ts";
import { HookRegistry } from "../src/hooks.ts";
import type { ChannelRegistry } from "../src/channels.ts";
import { humanFailure, Notifier, notifyInputError, notifyRefusal } from "../src/notifier.ts";
import { buildSystemPrompt, taskEnding } from "../src/prompt.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { registerCoreTools, type CoreToolDeps } from "../src/tools/core-tools.ts";

describe("notification storage", () => {
  it("gives old notifications a kind, turns unknown levels silent and counts them read", () => {
    const file = join(mkdtempSync(join(tmpdir(), "piomio-notif-db-")), "piomio.db");
    const old = openDb(file);
    // The schema before the Inbox: no kinds, no read state, no task delivery.
    old.exec(`
      drop index notifications_kind;
      alter table notifications drop column kind; alter table notifications drop column reason;
      alter table notifications drop column message_id; alter table notifications drop column read_at;
      alter table notifications drop column digest_id; alter table notifications drop column superseded_by;
      alter table tasks drop column deliver;
      drop table skill_agents;
      update schema_version set v = v - 2;`);
    const ins = old.prepare("insert into notifications(id, level, title, body, created_at, delivered_at) values (?,?,?,?,?,?)");
    ins.run("n1", "notify", "A", "a", "2026-10-30T10:00:00.000Z", "2026-10-30T10:00:01.000Z");
    ins.run("n2", "digest", "B", "b", "2026-10-30T11:00:00.000Z", null);
    ins.run("n3", "normal", "", "", "2026-10-30T12:00:00.000Z", null);
    ins.run("n4", "ask", "D", "d", "2026-10-30T13:00:00.000Z", "2026-10-30T13:00:00.000Z");
    old.close();

    const db = openDb(file);
    const rows = db.prepare("select id, level, kind, read_at from notifications order by id").all();
    expect(rows).toEqual([
      { id: "n1", level: "notify", kind: "alert", read_at: "2026-10-30T10:00:01.000Z" },
      { id: "n2", level: "digest", kind: "item", read_at: "2026-10-30T11:00:00.000Z" },
      { id: "n3", level: "silent", kind: "item", read_at: "2026-10-30T12:00:00.000Z" },
      { id: "n4", level: "ask", kind: "question", read_at: "2026-10-30T13:00:00.000Z" },
    ]);
    db.close();
  });

  it("keeps how a task's result reaches the person", () => {
    const store = new Store(openDb(":memory:"), new EventBus());
    const report = store.createTask({ agentId: "assistant", title: "Brief", goal: "g", background: true, createdBy: "trigger", deliver: "report" });
    expect(store.getTask(report.id)?.deliver).toBe("report");
    const plain = store.createTask({ agentId: "assistant", title: "x", goal: "g", background: true, createdBy: "user" });
    expect("deliver" in store.getTask(plain.id)!).toBe(false);
  });
});

type Started = { agentId: string; title: string; goal: string; deliver: "digest" };

/** A notifier over an in-memory hub: the channels' messages, the digest tasks it starts, and its Inbox events. */
function setup(opts: { settings?: Partial<CoreSettings>; digestWriteMs?: number; startTask?: boolean; publicUrl?: string } = {}) {
  const db = openDb(":memory:");
  const bus = new EventBus();
  const settings = new Settings(db, "UTC");
  settings.update({ quietHours: { enabled: false, start: "23:00", end: "08:00" }, ...opts.settings });
  const store = new Store(db, bus);
  const hooks = new HookRegistry();
  const sent: OutboundMessage[] = [];
  const channels = { broadcast: async (m: OutboundMessage) => void sent.push(m) } as unknown as ChannelRegistry;
  const started: Started[] = [];
  const events: Array<{ unread: number }> = [];
  bus.on("inbox.changed", (e) => events.push(e));
  const cancelled: string[] = [];
  const notifier = new Notifier({
    db,
    bus,
    settings,
    channels,
    hooks,
    store,
    sign: (p) => `sig:${p}`,
    publicUrl: opts.publicUrl ?? "https://hub.example.com",
    hasAgent: (id) => id === "assistant" || id === "scout",
    cancelTask: (id) => void cancelled.push(id),
    agentName: (id) => (id === "assistant" ? "Assistant" : id === "scout" ? "Scout" : id),
    digestWriteMs: opts.digestWriteMs,
    ...(opts.startTask === false
      ? {}
      : {
          startTask: (t: Started) => {
            started.push(t);
            return { id: `t_digest_${started.length}` };
          },
        }),
  });
  const notes = (agentId = "assistant") =>
    store
      .listMessages(store.agentConversation(agentId).id, { limit: 100 })
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "notification") as Array<Extract<MessagePart, { type: "notification" }>>;
  const row = (id: string) => db.prepare("select * from notifications where id = ?").get(id) as any;
  return { db, bus, settings, store, hooks, notifier, sent, started, events, cancelled, notes, row };
}

describe("notification intake", () => {
  it("files each level under its kind and delivers alerts and questions as cards that know their notification", async () => {
    const { notifier, notes, row, sent, events } = setup();
    const a = await notifier.notify({ level: "notify", title: "Ботсад закрыт 2 ноября", body: "Весь день.", agentId: "scout" });
    const q = await notifier.notify({ level: "ask", title: "Залить антифриз?", body: "", agentId: "scout" });
    const d = await notifier.notify({ level: "digest", title: "Новости", body: "3 поста", agentId: "scout" });
    const s = await notifier.notify({ level: "silent", title: "Ничего срочного", body: "", agentId: "scout" });
    expect([a.kind, q.kind, d.kind, s.kind]).toEqual(["alert", "question", "item", "item"]);
    expect(notes("scout").find((p) => p.notificationId === a.id)).toMatchObject({ kind: "alert", title: "Ботсад закрыт 2 ноября" });
    expect(notes("scout").find((p) => p.notificationId === q.id)).toMatchObject({ kind: "question" });
    expect(notes("scout")).toHaveLength(2);
    expect(row(a.id).message_id).toBeTruthy();
    expect(row(d.id).delivered_at).toBeNull();
    expect(sent).toHaveLength(2);
    expect(events.at(-1)).toEqual({ unread: 2 });
  });

  it("refuses an unknown level or an empty title", async () => {
    const { notifier, db } = setup();
    expect(notifyInputError("normal", "x")).toMatch(/level must be one of silent, digest, notify, ask/);
    expect(notifyInputError("notify", "  ")).toMatch(/title is required/);
    expect(notifyInputError("digest", "Ok")).toBeUndefined();
    await expect(notifier.notify({ level: "normal" as never, title: "", body: "" })).rejects.toThrow(/level must be one of/);
    expect((db.prepare("select count(*) as n from notifications").get() as { n: number }).n).toBe(0);
  });

  it("holds a notify back in quiet hours as a digest item and says why", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T03:00:00Z"));
    try {
      const { notifier, row, sent } = setup({ settings: { quietHours: { enabled: true, start: "23:00", end: "08:00" } } });
      const n = await notifier.notify({ level: "notify", title: "Курс доллара", body: "480", agentId: "assistant" });
      expect(n).toMatchObject({ effectiveLevel: "digest", kind: "item" });
      expect(row(n.id).reason).toMatch(/quiet hours/);
      expect(sent).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces a digest item from the same schedule that has not gone out yet", async () => {
    const { notifier, row } = setup();
    const first = await notifier.notify({ level: "digest", title: "☀️ Алматы, 31 октября", body: "+6°", agentId: "assistant", triggerId: "t_brief" });
    const second = await notifier.notify({ level: "digest", title: "☀️ Алматы, сб 31 октября", body: "+6°, туман", agentId: "assistant", triggerId: "t_brief" });
    expect(row(first.id)).toMatchObject({ superseded_by: second.id, digested: 1 });
    expect(row(first.id).reason).toMatch(/newer/);
    expect(row(second.id)).toMatchObject({ superseded_by: null, digested: 0 });
  });

  it("sends the approval push to the channels only: the approval's own card is already in the chat", async () => {
    const { notifier, notes, sent, row, events } = setup();
    const n = await notifier.notify({ level: "notify", kind: "approval", title: "Waiting for your approval", body: "Unlock the vault on vps", agentId: "assistant" });
    expect(n.kind).toBe("approval");
    expect(notes()).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(row(n.id).delivered_at).toBeTruthy();
    // It is no Inbox row: the apps' badges are not told about it.
    expect(events).toEqual([]);
  });

  it("keeps an approval push it holds back out of the digest: it stays silent, the approval waits in the chat", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T03:00:00Z"));
    try {
      const quiet = setup({ settings: { quietHours: { enabled: true, start: "23:00", end: "08:00" } } });
      const night = await quiet.notifier.notify({ level: "notify", kind: "approval", title: "Waiting for your approval", body: "Send the mail", agentId: "assistant" });
      expect(night).toMatchObject({ effectiveLevel: "silent", kind: "approval", reason: "quiet hours — not pushed" });
      expect(quiet.row(night.id)).toMatchObject({ level: "silent", kind: "approval", delivered_at: null });
      expect(quiet.sent).toHaveLength(0);
      expect(quiet.notifier.nextDigest()).toBeUndefined();

      vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
      const busy = setup({ settings: { notifyRatePerHour: 1 } });
      await busy.notifier.notify({ level: "notify", title: "An alert", body: "x", agentId: "assistant" });
      const held = await busy.notifier.notify({ level: "notify", kind: "approval", title: "Waiting for your approval", body: "Send the mail", agentId: "assistant" });
      expect(held).toMatchObject({ effectiveLevel: "silent", kind: "approval", reason: "rate limit — not pushed" });
      expect(busy.notifier.nextDigest()).toBeUndefined();
      expect(busy.notifier.behind().find((b) => b.id === held.id)).toMatchObject({ kind: "approval", waiting: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("files a notification under item and keeps it silent when a hook turns it into a level the hub does not know", async () => {
    const { notifier, hooks, row, notes } = setup();
    hooks.register("notify.before", "test", async () => ({ level: "urgent" }));
    const n = await notifier.notify({ level: "digest", title: "Odd", body: "level from a hook" });
    expect(n.kind).toBe("item");
    expect(n.effectiveLevel).toBe("silent");
    expect(row(n.id).kind).toBe("item");
    expect(row(n.id).level).toBe("silent");
    expect(notes()).toHaveLength(0);
  });

  it("finds a duplicate even when the title comes with spaces around it", async () => {
    const { notifier, row } = setup();
    await notifier.notify({ level: "digest", title: "Курс доллара", body: "480", agentId: "assistant" });
    const again = await notifier.notify({ level: "notify", title: "  Курс доллара ", body: "480", agentId: "assistant" });
    expect(again.effectiveLevel).toBe("silent");
    expect(row(again.id).reason).toMatch(/duplicate/);
  });
});

describe("who may notify, and how a background run ends", () => {
  it("lets checks notify; channel runs, reports and the digest put their words elsewhere", () => {
    expect(notifyRefusal(undefined)).toBeUndefined();
    expect(notifyRefusal({})).toBeUndefined();
    expect(notifyRefusal({ feedId: "f_1" })).toMatch(/posts you publish/);
    expect(notifyRefusal({ deliver: "report" })).toMatch(/final reply is delivered to the user as this report/);
    expect(notifyRefusal({ deliver: "digest" })).toMatch(/final reply is the digest/);
  });

  it("ends each kind of task with how its result reaches the person", () => {
    expect(taskEnding({ background: false })).toMatch(/passed to whoever created the task/);
    expect(taskEnding({ background: true })).toMatch(/call notify \(once\)/);
    expect(taskEnding({ background: true, feedId: "f_1" })).not.toMatch(/notify/);
    expect(taskEnding({ background: true, deliver: "report" })).toMatch(/report the user receives/);
    expect(taskEnding({ background: true, deliver: "digest" })).toMatch(/digest the user receives/);
  });
});

describe("the notify tool and the background rules", () => {
  /** The hub's `notify` tool over a notifier of its own, as an agent in `taskId` would call it. */
  function toolSetup() {
    const h = setup();
    const registry = new ToolRegistry();
    registerCoreTools({ registry, store: h.store, notifier: h.notifier } as unknown as CoreToolDeps);
    const call = (input: object, taskId?: string) =>
      registry.get("notify")!.invoke(input, { agentId: "assistant", taskId, conversationId: "c_1" } as never);
    return { ...h, call };
  }
  const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");

  it("tells the model what is wrong instead of throwing, and records nothing", async () => {
    const { call, db } = toolSetup();
    const badLevel = await call({ level: "normal", title: "x" });
    expect(badLevel.isError).toBe(true);
    expect(textOf(badLevel)).toMatch(/Nothing was sent: level must be one of/);
    const noTitle = await call({ level: "notify", title: " " });
    expect(noTitle.isError).toBe(true);
    expect(textOf(noTitle)).toMatch(/title is required/);
    expect((db.prepare("select count(*) as n from notifications").get() as { n: number }).n).toBe(0);
  });

  it("refuses a report run, a digest run and a channel run, and records nothing", async () => {
    const { call, store, db } = toolSetup();
    const make = (extra: object) => store.createTask({ agentId: "assistant", title: "t", goal: "g", background: true, createdBy: "trigger", ...extra }).id;
    const report = await call({ level: "notify", title: "Brief" }, make({ deliver: "report" }));
    expect(textOf(report)).toMatch(/final reply is delivered to the user as this report/);
    expect(report.isError).toBeUndefined();
    expect(textOf(await call({ level: "notify", title: "Brief" }, make({ deliver: "digest" })))).toMatch(/final reply is the digest/);
    expect(textOf(await call({ level: "notify", title: "Brief" }, make({ feedId: "f_1" })))).toMatch(/posts you publish/);
    expect((db.prepare("select count(*) as n from notifications").get() as { n: number }).n).toBe(0);
  });

  it("trims the title before cutting it to length", async () => {
    const { call, db } = toolSetup();
    const r = await call({ level: "silent", title: `${" ".repeat(250)}Курс доллара  ` });
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toBe("Notification recorded (level: silent).");
    expect((db.prepare("select title from notifications").get() as { title: string }).title).toBe("Курс доллара");
  });

  it("lets a check notify, with the trigger it ran for", async () => {
    const { call, store, db, row } = toolSetup();
    const task = store.createTask({ agentId: "assistant", title: "t", goal: "g", background: true, createdBy: "trigger", triggerId: "t_check" });
    const r = await call({ level: "digest", title: "Курс доллара вырос", body: "480" }, task.id);
    expect(textOf(r)).toBe("Notification recorded (level: digest).");
    const stored = db.prepare("select id from notifications").get() as { id: string };
    expect(row(stored.id)).toMatchObject({ trigger_id: "t_check", task_id: task.id });
  });

  describe("the system prompt", () => {
    const agent = { id: "owl", name: "Owl", description: "", brains: [], initiative: 1 as const, tools: ["*"], skills: [], policyProfile: "default", budget: { backgroundRunsPerDay: 1 }, prompt: "", source: "builtin" };
    const base = { agent, timezone: "UTC", language: "en", consoleUrl: "http://x", background: true, skills: [], nativeSkills: false, appended: [] };
    const task = (extra: object) => ({ id: "t1", title: "t", goal: "g", background: true, ...extra }) as never;

    it("tells a report run and a digest run that their final reply is the message, and a check to call notify", () => {
      expect(buildSystemPrompt({ ...base, task: task({ deliver: "report" }) })).toMatch(/scheduled REPORT[^\n]*final reply is delivered to them[^\n]*Do not call `notify`/);
      expect(buildSystemPrompt({ ...base, task: task({ deliver: "digest" }) })).toMatch(/writing the user's digest[^\n]*Do not call `notify`/);
      expect(buildSystemPrompt({ ...base, task: task({}) })).toMatch(/call `notify` exactly once[\s\S]*the title is the news itself/);
    });

    it("keeps the note for a taught skill on a report run, pointing at the reply", () => {
      const skills = [{ name: "rate", description: "d", dir: "/x", source: "user", taught: true, sites: [] }];
      const p = buildSystemPrompt({ ...base, skills, task: task({ deliver: "report", skill: "rate" }) });
      expect(p).toContain("follows the skill `rate`");
      expect(p).toContain("say so in your reply");
      const check = buildSystemPrompt({ ...base, skills, task: task({ skill: "rate" }) });
      expect(check).toContain("say so in your notify");
      expect(check).not.toContain("initiative level only allows");
    });
  });
});

describe("scheduled reports", () => {
  const task = (over: Partial<Task> = {}): Task => ({
    id: "t_r1",
    conversationId: "c_t",
    agentId: "assistant",
    title: "Утренняя сводка по Алматы",
    goal: "g",
    status: "done",
    createdBy: "trigger",
    triggerId: "t_brief",
    background: true,
    deliver: "report",
    result: "Сейчас +6°, туман.\n\n**Перекрытия**\n- Центральная",
    createdAt: "2026-10-31T03:00:00.000Z",
    updatedAt: "2026-10-31T03:01:00.000Z",
    ...over,
  });

  it("delivers the final reply whole, as the agent's message, silently in quiet hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T03:00:00Z"));
    try {
      const { notifier, notes, sent, row } = setup({ settings: { quietHours: { enabled: true, start: "23:00", end: "08:00" } } });
      const n = await notifier.deliverReport(task());
      expect(notes()[0]).toMatchObject({ kind: "report", title: "Утренняя сводка по Алматы", body: task().result, caption: "scheduled, 03:00", notificationId: n!.id });
      expect(row(n!.id)).toMatchObject({ kind: "report", level: "notify", trigger_id: "t_brief" });
      expect(row(n!.id).message_id).toBeTruthy();
      expect(sent[0]).toMatchObject({ kind: "notification", silent: true });
      expect(sent[0].text).toContain("Утренняя сводка по Алматы · scheduled, 03:00\n\nСейчас +6°, туман.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never holds a report back for the rate limit: the next one from the same schedule arrives as well", async () => {
    const { notifier, notes, sent, row } = setup({ settings: { notifyRatePerHour: 1 } });
    const first = await notifier.deliverReport(task());
    const second = await notifier.deliverReport(task({ id: "t_r2", result: "Через час +8°, туман уходит." }));
    expect(notes().map((p) => [p.kind, p.body])).toEqual([
      ["report", task().result],
      ["report", "Через час +8°, туман уходит."],
    ]);
    expect(sent.map((m) => [m.kind, m.silent])).toEqual([
      ["notification", false],
      ["notification", false],
    ]);
    expect([row(first!.id), row(second!.id)]).toMatchObject([
      { level: "notify", kind: "report", trigger_id: "t_brief" },
      { level: "notify", kind: "report", trigger_id: "t_brief" },
    ]);
    // Reports do not spend the schedule's budget of alerts: an ordinary notify from it still arrives.
    const alert = await notifier.notify({ level: "notify", title: "Ещё новость", body: "x", agentId: "assistant", triggerId: "t_brief" });
    expect(alert).toMatchObject({ effectiveLevel: "notify", kind: "alert" });
  });

  it("counts only alerts against the hour's budget: delivered reports and approval pushes leave it whole", async () => {
    const { notifier } = setup({ settings: { notifyRatePerHour: 2 } });
    for (let i = 0; i < 3; i++) await notifier.deliverReport(task({ id: `t_r${i}`, result: `Отчёт ${i}` }));
    for (let i = 0; i < 3; i++) await notifier.notify({ level: "notify", kind: "approval", title: `Approve ${i}`, body: "x", agentId: "scout" });
    // The schedule's two alerts arrive; the third one is over the budget.
    const fromSchedule = [];
    for (let i = 0; i < 3; i++) fromSchedule.push(await notifier.notify({ level: "notify", title: `Schedule alert ${i}`, body: `${i}`, agentId: "assistant", triggerId: "t_brief" }));
    expect(fromSchedule.map((n) => n.effectiveLevel)).toEqual(["notify", "notify", "digest"]);
    // The same for an agent's own alerts after its approval pushes.
    const fromAgent = [];
    for (let i = 0; i < 3; i++) fromAgent.push(await notifier.notify({ level: "notify", title: `Agent alert ${i}`, body: `${i}`, agentId: "scout" }));
    expect(fromAgent.map((n) => n.effectiveLevel)).toEqual(["notify", "notify", "digest"]);
  });

  it("does not deliver the same report twice when a schedule fires twice", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T03:00:00Z"));
    try {
      const { notifier, notes, sent, db, bus, events } = setup();
      const created: string[] = [];
      bus.on("notification.created", (n) => created.push(n.id));
      const first = await notifier.deliverReport(task());
      const rows = () => (db.prepare("select count(*) as n from notifications where kind = 'report'").get() as { n: number }).n;
      const unread = events.length;

      // The same run twice a minute apart: the second one writes nothing and hands back the first.
      vi.setSystemTime(new Date("2026-10-31T03:01:00Z"));
      const again = await notifier.deliverReport(task({ id: "t_r2" }));
      expect(again?.id).toBe(first!.id);
      expect(notes()).toHaveLength(1);
      expect(sent).toHaveLength(1);
      expect(rows()).toBe(1);
      expect(events).toHaveLength(unread);
      expect(created).toEqual([first!.id]);

      // Another text from the same schedule is its own report.
      await notifier.deliverReport(task({ id: "t_r3", result: "Уже +7°." }));
      expect(rows()).toBe(2);

      // A schedule without an id cannot be told apart, so nothing is guarded.
      await notifier.deliverReport(task({ id: "t_r4", triggerId: undefined, result: "Без расписания" }));
      await notifier.deliverReport(task({ id: "t_r5", triggerId: undefined, result: "Без расписания" }));
      expect(rows()).toBe(4);

      // Past the window the same text is news again.
      vi.setSystemTime(new Date("2026-10-31T03:11:00Z"));
      const later = await notifier.deliverReport(task({ id: "t_r6" }));
      expect(later!.id).not.toBe(first!.id);
      expect(rows()).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a schedule the person muted quiet: the report is still written and stored, but pushed silently", async () => {
    const { notifier, notes, sent, row, db } = setup();
    db.prepare("insert into notifications(id, level, title, body, trigger_id, created_at, feedback) values (?,?,?,?,?,?,?)").run(
      "n_old",
      "notify",
      "Вчерашняя сводка",
      "старая",
      "t_brief",
      "2026-10-30T03:00:00.000Z",
      "off",
    );
    const n = await notifier.deliverReport(task());
    expect(n).toMatchObject({ kind: "report", level: "notify", reason: "the trigger is muted by the user" });
    expect(notes()).toHaveLength(1);
    expect(row(n!.id)).toMatchObject({ kind: "report", trigger_id: "t_brief", reason: "the trigger is muted by the user" });
    expect(row(n!.id).message_id).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "notification", silent: true });

    // Another schedule is not affected; an ordinary notify from the muted one is still silent.
    const other = await notifier.deliverReport(task({ id: "t_r2", triggerId: "t_other", result: "Другая сводка" }));
    expect(other!.reason).toBeUndefined();
    expect(sent[1]).toMatchObject({ silent: false });
    const quiet = await notifier.notify({ level: "notify", title: "Новость", body: "x", agentId: "assistant", triggerId: "t_brief" });
    expect(quiet).toMatchObject({ effectiveLevel: "silent", reason: "the trigger is muted by the user" });
  });

  it("says so when a report came back empty", async () => {
    const { notifier, notes } = setup();
    expect(await notifier.deliverReport(task({ result: "  " }))).toBeUndefined();
    expect(notes()[0]).toMatchObject({ kind: "alert", title: "“Утренняя сводка по Алматы” came back empty" });
  });

  it("puts a failure in one plain sentence", () => {
    expect(humanFailure("Can't start the agent “Assistant”: claude-code@local: not signed in", "no-brain", "Assistant")).toBe(
      "Assistant isn't signed in to any brain yet. Sign in from its chat.",
    );
    expect(humanFailure("The page did not load. Then it timed out.", undefined, "Assistant")).toBe("The page did not load.");
    expect(humanFailure("x".repeat(300), undefined, "Assistant")).toHaveLength(200);
  });
});

describe("the digest", () => {
  /** What waits: an item replaced by a newer one from the same schedule, the newer one, a silent note, a channel post and a calendar section. */
  const seed = async (n: ReturnType<typeof setup>) => {
    const brief = n.store.createTask({ agentId: "assistant", title: "Утренняя сводка по Алматы", goal: "g", background: true, createdBy: "trigger", triggerId: "t_brief" });
    await n.notifier.notify({ level: "digest", title: "☀️ Алматы, утро", body: "старое", agentId: "assistant", triggerId: "t_brief", taskId: brief.id });
    await n.notifier.notify({ level: "digest", title: "☀️ Алматы, сб 31 октября", body: "Сейчас +6°, туман.\nДнём +13°.", agentId: "assistant", triggerId: "t_brief", taskId: brief.id });
    await n.notifier.notify({ level: "silent", title: "Ничего срочного", body: "", agentId: "assistant" });
    n.db.prepare("insert into feeds(id, title, brief, agent_id, times, created_at, updated_at) values ('f_almaty', 'Новости Алматы', 'b', 'assistant', '[]', ?, ?)").run(nowIso(), nowIso());
    n.db.prepare("insert into feed_posts(id, feed_id, title, text, created_at) values ('p1', 'f_almaty', 'Ботсад закрыт 2 ноября', 't', ?)").run(nowIso());
    n.hooks.register("digest.compose", "calendar", async () => ({ title: "Calendar", body: "10:00 Dentist" }));
  };
  const digestRow = (n: ReturnType<typeof setup>) => n.db.prepare("select * from notifications where kind = 'digest'").get() as any;

  it("sends nothing when nothing waits; channel posts alone make no digest", async () => {
    const n = setup();
    expect(await n.notifier.flushDigest()).toBe(0);
    n.db.prepare("insert into feeds(id, title, brief, agent_id, times, created_at, updated_at) values ('f1', 'X', 'b', 'assistant', '[]', ?, ?)").run(nowIso(), nowIso());
    n.db.prepare("insert into feed_posts(id, feed_id, title, text, created_at) values ('p1', 'f1', 'Post', 't', ?)").run(nowIso());
    expect(await n.notifier.flushDigest()).toBe(0);
    expect(n.started).toHaveLength(0);
  });

  it("gathers what waits and has the default agent write it, once", async () => {
    const n = setup();
    await seed(n);
    expect(await n.notifier.flushDigest()).toBe(2);
    expect(n.started).toHaveLength(1);
    expect(n.started[0]).toMatchObject({ agentId: "assistant", deliver: "digest" });
    expect(n.started[0].title).toMatch(/digest · /);
    expect(n.started[0].goal).toContain("Сейчас +6°, туман.\nДнём +13°.");
    expect(n.started[0].goal).not.toContain("старое");
    expect(n.started[0].goal).toContain("Ботсад закрыт 2 ноября");
    expect(n.started[0].goal).toContain("10:00 Dentist");
    const d = digestRow(n);
    expect(d).toMatchObject({ task_id: "t_digest_1", delivered_at: null });
    expect((n.db.prepare("select count(*) as c from notifications where digest_id = ?").get(d.id) as { c: number }).c).toBe(1);
    // Asked again while it is being written (the timer and "Collect now"): the same digest, no second task.
    expect(await Promise.all([n.notifier.flushDigest(), n.notifier.flushDigest()])).toEqual([2, 2]);
    expect(n.started).toHaveLength(1);
    n.notifier.stop();
  });

  it("starts one digest when asked twice at the same moment, from nothing open", async () => {
    const n = setup();
    await seed(n);
    // Both calls pass the "is one open?" check before either has filed its digest: only the guard keeps them to one.
    expect(await Promise.all([n.notifier.flushDigest(), n.notifier.flushDigest()])).toEqual([2, 2]);
    expect(n.started).toHaveLength(1);
    expect((n.db.prepare("select count(*) as c from notifications where kind = 'digest'").get() as { c: number }).c).toBe(1);
    n.notifier.stop();
  });

  it("keeps a digest out of the list until it is written: its body is raw material before that", async () => {
    const n = setup();
    await seed(n);
    await n.notifier.flushDigest();
    expect(n.notifier.list().some((x) => x.kind === "digest")).toBe(false);
    // The rest of the notifications are still listed.
    expect(n.notifier.list().length).toBeGreaterThan(0);
    await n.notifier.digestWritten("t_digest_1", "Спокойный день.");
    expect(n.notifier.list().filter((x) => x.kind === "digest")).toMatchObject([{ body: "Спокойный день.", deliveredAt: expect.any(String) }]);
  });

  it("delivers what the assistant wrote, with the sources the hub knows, once", async () => {
    const n = setup();
    await seed(n);
    await n.notifier.flushDigest();
    const text = "Спокойный день.\n\n**Город**\n- Ботсад закрыт 2 ноября";
    await n.notifier.digestWritten("t_digest_1", text);
    await n.notifier.digestWritten("t_digest_1", "again");
    const parts = n.notes().filter((p) => p.kind === "digest");
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      body: text,
      sources: [{ label: "Утренняя сводка по Алматы", href: expect.stringMatching(/^\/tasks\//) }, { label: "Calendar" }, { label: "Новости Алматы", count: 1, href: "/channels/f_almaty" }],
    });
    expect(digestRow(n)).toMatchObject({ body: text, agent_id: "assistant" });
    expect(digestRow(n).delivered_at).toBeTruthy();
    expect(digestRow(n).message_id).toBeTruthy();
    const out = n.sent.find((m) => m.kind === "digest")!;
    expect(out.text).toContain("Спокойный день.");
    expect(out.text).toContain("From: [Утренняя сводка по Алматы](https://hub.example.com/tasks/");
    expect(out.text).toContain("Calendar · [Новости Алматы](https://hub.example.com/channels/f_almaty)");
    expect(n.events.at(-1)).toEqual({ unread: 1 });
    // The writer's own reply went out: there is nothing to stop.
    expect(n.cancelled).toEqual([]);
  });

  it("sends the card when the assistant could not write it, every item whole with its line breaks", async () => {
    const n = setup();
    await seed(n);
    await n.notifier.flushDigest();
    await n.notifier.digestWritten("t_digest_1", undefined);
    const body = n.notes().find((p) => p.kind === "digest")!.body;
    expect(body).toContain("### Schedules and checks");
    // Markdown hard break (two spaces) keeps the line break the brief had.
    expect(body).toContain("Сейчас +6°, туман.  \nДнём +13°.");
    expect(body).toContain("### Calendar\n\n10:00 Dentist");
    expect(body).toContain("### Channels\n\n**Новости Алматы**\n- Ботсад закрыт 2 ноября");
    expect(digestRow(n).body).toBe(body);
  });

  it("sends the card when the assistant says nothing", async () => {
    const n = setup();
    await seed(n);
    await n.notifier.flushDigest();
    await n.notifier.digestWritten("t_digest_1", "  \n ");
    expect(n.notes().find((p) => p.kind === "digest")!.body).toContain("### Schedules and checks");
  });

  it("sends the card when no reply came in time, and drops a late reply", async () => {
    vi.useFakeTimers();
    try {
      const n = setup({ digestWriteMs: 20_000 });
      await seed(n);
      await n.notifier.flushDigest();
      await vi.advanceTimersByTimeAsync(19_999);
      expect(digestRow(n).delivered_at).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(digestRow(n).delivered_at).toBeTruthy();
      // The card went out: the writer is stopped, so a slow or rate-limited one spends no run on a reply nobody gets.
      expect(n.cancelled).toEqual(["t_digest_1"]);
      await n.notifier.digestWritten("t_digest_1", "late");
      const parts = n.notes().filter((p) => p.kind === "digest");
      expect(parts).toHaveLength(1);
      expect(parts[0].body).toContain("### Schedules and checks");
      expect(n.cancelled).toEqual(["t_digest_1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a writer that is still on its way when the card goes out, and leaves one that already ended alone", async () => {
    vi.useFakeTimers();
    try {
      const n = setup({ digestWriteMs: 20_000 });
      const writers: string[] = [];
      (n.notifier as any).startTask = (t: Started) => {
        const task = n.store.createTask({ agentId: t.agentId, title: t.title, goal: t.goal, background: true, createdBy: "trigger", deliver: "digest" });
        writers.push(task.id);
        return { id: task.id };
      };
      await seed(n);
      // A rate-limited writer waits for its limit: the card goes out on time, and the writer is stopped.
      await n.notifier.flushDigest();
      n.store.updateTask(writers[0], { status: "paused", resumeAt: new Date(Date.now() + 3600_000).toISOString() });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(n.cancelled).toEqual([writers[0]]);

      // A writer that failed or said nothing has ended: the card goes out and nothing is stopped.
      await n.notifier.notify({ level: "digest", title: "Ещё новость", body: "x", agentId: "assistant" });
      await n.notifier.flushDigest();
      n.store.updateTask(writers[1], { status: "failed", error: "no brain" });
      await n.notifier.digestWritten(writers[1], undefined);
      await n.notifier.notify({ level: "digest", title: "И ещё", body: "y", agentId: "assistant" });
      await n.notifier.flushDigest();
      n.store.updateTask(writers[2], { status: "done", result: " " });
      await n.notifier.digestWritten(writers[2], " ");
      expect(n.notes().filter((p) => p.kind === "digest")).toHaveLength(3);
      expect(n.cancelled).toEqual([writers[0]]);
      n.notifier.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the card at once when there is nobody to write it", async () => {
    const n = setup({ startTask: false });
    await seed(n);
    expect(await n.notifier.flushDigest()).toBe(2);
    expect(n.notes().some((p) => p.kind === "digest")).toBe(true);
    expect(digestRow(n).delivered_at).toBeTruthy();
  });

  it("sends the card at once when the writer could not be started, says why in the log, and does not stay open", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const n = setup({ startTask: false });
      (n.notifier as any).startTask = () => {
        throw new Error("no room");
      };
      await seed(n);
      expect(await n.notifier.flushDigest()).toBe(2);
      expect(digestRow(n).delivered_at).toBeTruthy();
      expect(n.notes().filter((p) => p.kind === "digest")).toHaveLength(1);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[piomio\] digest: .*no room/));
    } finally {
      log.mockRestore();
    }
  });

  it("after a restart, a digest left unwritten goes out as the card", async () => {
    vi.useFakeTimers();
    try {
      const n = setup({ digestWriteMs: 60_000 });
      await seed(n);
      await n.notifier.flushDigest();
      n.notifier.stop();
      const stopped: string[] = [];
      const restarted = new Notifier({
        db: n.db,
        bus: n.bus,
        settings: n.settings,
        channels: { broadcast: async () => {} } as unknown as ChannelRegistry,
        hooks: n.hooks,
        store: n.store,
        sign: (p) => p,
        publicUrl: "http://localhost:8080",
        hasAgent: () => true,
        digestWriteMs: 20_000,
        cancelTask: (id) => void stopped.push(id),
      });
      restarted.startDigestTimer();
      await vi.advanceTimersByTimeAsync(19_999);
      expect(digestRow(n).delivered_at).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      restarted.stop();
      expect(digestRow(n).delivered_at).toBeTruthy();
      // The writer the hub may have queued again after the restart is stopped with it.
      expect(stopped).toEqual(["t_digest_1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands the material over oldest first, a section with no text left out, and a post as one line", async () => {
    const n = setup();
    // Inserted newest first: the order comes from the time, not from the rows.
    const ins = n.db.prepare("insert into notifications(id, level, kind, title, body, agent_id, created_at) values (?, 'digest', 'item', ?, ?, 'scout', ?)");
    ins.run("n_late", "Second thing", "later", "2026-10-31T11:00:00.000Z");
    ins.run("n_early", "First thing", "earlier", "2026-10-31T09:00:00.000Z");
    n.hooks.register("digest.compose", "empty", async () => ({ title: "Empty section", body: "  \n " }));
    n.hooks.register("digest.compose", "calendar", async () => ({ title: "Calendar", body: "10:00 Dentist" }));
    n.db.prepare("insert into feeds(id, title, brief, agent_id, times, created_at, updated_at) values ('f1', 'News', 'b', 'assistant', '[]', ?, ?)").run(nowIso(), nowIso());
    n.db.prepare("insert into feed_posts(id, feed_id, title, text, created_at) values ('p1', 'f1', 'A long\nheadline\r\n  in three lines', 't', ?)").run(nowIso());
    expect(await n.notifier.flushDigest()).toBe(3);
    const goal = n.started[0].goal;
    expect(goal.indexOf("### First thing (09:00, Scout)")).toBeGreaterThan(-1);
    expect(goal.indexOf("### First thing")).toBeLessThan(goal.indexOf("### Second thing"));
    expect(goal).toContain("### Calendar");
    expect(goal).not.toContain("Empty section");
    expect(goal).toContain("- A long headline in three lines");
    n.notifier.stop();
  });

  it("caps channels and posts but keeps the true totals, so \"and N more\" is right", async () => {
    const n = setup({ startTask: false });
    await n.notifier.notify({ level: "digest", title: "Something", body: "x", agentId: "assistant" });
    const feed = n.db.prepare("insert into feeds(id, title, brief, agent_id, times, created_at, updated_at) values (?, ?, 'b', 'assistant', '[]', ?, ?)");
    const post = n.db.prepare("insert into feed_posts(id, feed_id, title, text, created_at) values (?, ?, ?, 't', ?)");
    // Channel f0 has 8 new posts, the other seven one each, every post a millisecond apart: newest first, 8 channels, two over the cap.
    const base = Date.now();
    const at = (ms: number) => new Date(base + ms).toISOString();
    for (let i = 0; i < 8; i++) feed.run(`f${i}`, `Channel ${i}`, nowIso(), nowIso());
    for (let i = 0; i < 8; i++) post.run(`p0_${i}`, "f0", `Headline ${i}`, at(100 + i));
    for (let i = 1; i < 8; i++) post.run(`p${i}`, `f${i}`, `Only ${i}`, at(10 - i));
    expect(await n.notifier.flushDigest()).toBe(1);
    const body = digestRow(n).body as string;
    expect(body).toContain("**Channel 0**");
    // The newest five headlines, the rest counted.
    expect(body).toContain("- Headline 7\n- Headline 6\n- Headline 5\n- Headline 4\n- Headline 3");
    expect(body).not.toContain("Headline 2");
    expect(body).toContain("and 3 more");
    expect(body.match(/\*\*Channel \d\*\*/g)).toHaveLength(6);
    expect(body).toContain("**Channel 5**");
    expect(body).not.toContain("Channel 6");
    expect(body).not.toContain("Channel 7");
  });

  it("does not bring a delivered digest's items again, and the next one reaches back only to the last", async () => {
    const n = setup({ startTask: false });
    await n.notifier.notify({ level: "digest", title: "First news", body: "one", agentId: "assistant" });
    expect(await n.notifier.flushDigest()).toBe(1);
    expect(await n.notifier.flushDigest()).toBe(0);
    await n.notifier.notify({ level: "digest", title: "Second news", body: "two", agentId: "assistant" });
    expect(await n.notifier.flushDigest()).toBe(1);
    const bodies = (n.db.prepare("select body from notifications where kind = 'digest' order by created_at").all() as Array<{ body: string }>).map((r) => r.body);
    expect(bodies[0]).toContain("First news");
    expect(bodies[1]).toContain("Second news");
    expect(bodies[1]).not.toContain("First news");
  });

  it("brings what landed while a digest was being written into the next one: a post and an alert", async () => {
    vi.useFakeTimers();
    try {
      const n = setup({ digestWriteMs: 10 * 60_000 });
      n.db.prepare("insert into feeds(id, title, brief, agent_id, times, created_at, updated_at) values ('f1', 'News', 'b', 'assistant', '[]', ?, ?)").run(nowIso(), nowIso());
      const post = (id: string, title: string) => n.db.prepare("insert into feed_posts(id, feed_id, title, text, created_at) values (?, 'f1', ?, 't', ?)").run(id, title, nowIso());
      post("p_before", "Landed before the digest");
      await n.notifier.notify({ level: "digest", title: "First news", body: "one", agentId: "assistant" });
      await vi.advanceTimersByTimeAsync(1000);
      // The first digest goes to its writer, and the writer takes a while.
      expect(await n.notifier.flushDigest()).toBe(1);
      expect(n.started[0].goal).toContain("Landed before the digest");
      await vi.advanceTimersByTimeAsync(30_000);
      post("p_during", "Landed while it was written");
      await n.notifier.notify({ level: "notify", title: "Alert while it was written", body: "x", agentId: "assistant" });
      await vi.advanceTimersByTimeAsync(10_000);
      await n.notifier.digestWritten("t_digest_1", "Done");
      await vi.advanceTimersByTimeAsync(10_000);
      await n.notifier.notify({ level: "digest", title: "Second news", body: "two", agentId: "assistant" });
      expect(await n.notifier.flushDigest()).toBe(1);
      // What landed in those 40 seconds is in no digest yet: this one brings it. What the first digest had already is not repeated.
      const goal = n.started[1].goal;
      expect(goal).toContain("Landed while it was written");
      expect(goal).toContain("Alert while it was written");
      expect(goal).not.toContain("Landed before the digest");
      n.notifier.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the assistant what already reached the person since the last digest", async () => {
    const n = setup();
    await n.notifier.notify({ level: "notify", title: "Ботсад закрыт 2 ноября", body: "Весь день.", agentId: "assistant" });
    await n.notifier.notify({ level: "digest", title: "Курс доллара", body: "480", agentId: "assistant" });
    await n.notifier.flushDigest();
    expect(n.started[0].goal).toMatch(/Already told[^\n]*\n- \d\d:\d\d Ботсад закрыт 2 ноября/);
    n.notifier.stop();
  });

  it("links the sources only on a hub reachable from outside, and keeps a source's name from making a link of its own", async () => {
    const digestText = async (publicUrl: string, feed = "Новости Алматы") => {
      const n = setup({ startTask: false, publicUrl });
      n.hooks.register("digest.compose", "calendar", async () => ({ title: "Calendar", body: "10:00 Dentist" }));
      n.db.prepare("insert into feeds(id, title, brief, agent_id, times, created_at, updated_at) values ('f1', ?, 'b', 'assistant', '[]', ?, ?)").run(feed, nowIso(), nowIso());
      n.db.prepare("insert into feed_posts(id, feed_id, title, text, created_at) values ('p1', 'f1', 'Post', 't', ?)").run(nowIso());
      await n.notifier.flushDigest();
      return n.sent.find((m) => m.kind === "digest")!.text.split("\n\n").at(-1)!;
    };
    expect(await digestText("https://piomio.tail1234.ts.net")).toBe("From: Calendar · [Новости Алматы](https://piomio.tail1234.ts.net/channels/f1)");
    // On the home network, on the tailnet's own addresses or on this computer the links would not open from a phone outside.
    for (const url of ["https://192.168.1.20:8080", "https://10.0.0.5", "https://100.101.102.103", "https://mymac.local", "https://mymac", "https://localhost:8080", "http://hub.example.com"])
      expect(await digestText(url)).toBe("From: Calendar · Новости Алматы");
    // A channel named like a Markdown link stays plain text, linked or not.
    const crafted = "Evil](https://evil.example) [x";
    expect(await digestText("https://hub.example.com", crafted)).toBe("From: Calendar · [Evil\\](https://evil.example) \\[x](https://hub.example.com/channels/f1)");
    expect(await digestText("https://192.168.1.20", crafted)).toBe("From: Calendar · Evil\\](https://evil.example) \\[x");
    expect(await digestText("https://hub.example.com", "C:\\")).toBe("From: Calendar · [C:\\\\](https://hub.example.com/channels/f1)");
  });

  it("brings channel posts of the last day at most, however long ago the last digest was", async () => {
    const n = setup({ startTask: false });
    const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    // The last digest went out three days ago.
    n.db.prepare("insert into notifications(id, level, kind, title, body, created_at, delivered_at) values ('n_old_digest', 'digest', 'digest', 'Old digest', 'old', ?, ?)").run(ago(72), ago(72));
    n.db.prepare("insert into feeds(id, title, brief, agent_id, times, created_at, updated_at) values ('f1', 'News', 'b', 'assistant', '[]', ?, ?)").run(nowIso(), nowIso());
    const post = n.db.prepare("insert into feed_posts(id, feed_id, title, text, created_at) values (?, 'f1', ?, 't', ?)");
    post.run("p_stale", "Two days old headline", ago(48));
    post.run("p_fresh", "This morning's headline", ago(2));
    await n.notifier.notify({ level: "digest", title: "Курс доллара", body: "480", agentId: "assistant" });
    await n.notifier.flushDigest();
    const body = (n.db.prepare("select body from notifications where kind = 'digest' and id != 'n_old_digest'").get() as { body: string }).body;
    expect(body).toContain("This morning's headline");
    expect(body).not.toContain("Two days old headline");
  });

  it("leaves out an item replaced while the digest was gathered: it is replaced, not in the digest", async () => {
    const n = setup();
    const old = await n.notifier.notify({ level: "digest", title: "☀️ Утро", body: "старое", agentId: "assistant", triggerId: "t_brief" });
    const other = await n.notifier.notify({ level: "digest", title: "Курс доллара", body: "480", agentId: "assistant" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    n.hooks.register("digest.compose", "slow", async () => {
      await gate;
      return { title: "Calendar", body: "10:00 Dentist" };
    });
    const flushing = n.notifier.flushDigest();
    // While a plugin's section is on its way, the schedule brings a newer item: it replaces the old one.
    const newer = await n.notifier.notify({ level: "digest", title: "☀️ Утро, уточнение", body: "новое", agentId: "assistant", triggerId: "t_brief" });
    release();
    expect(await flushing).toBe(2);
    const d = digestRow(n);
    expect(n.row(old.id)).toMatchObject({ superseded_by: newer.id, digest_id: null });
    expect(n.row(other.id)).toMatchObject({ digest_id: d.id, digested: 1 });
    expect(n.row(newer.id)).toMatchObject({ digest_id: null, digested: 0, superseded_by: null });
    expect(n.started[0].goal).not.toContain("старое");
    expect(n.started[0].goal).toContain("480");
    expect(JSON.parse(d.body).items.map((it: { id: string }) => it.id)).toEqual([other.id]);
    n.notifier.stop();
  });

  it("clears its timers when stopped", async () => {
    vi.useFakeTimers();
    try {
      const n = setup({ digestWriteMs: 1000 });
      await n.notifier.notify({ level: "digest", title: "Курс доллара", body: "480", agentId: "assistant" });
      await n.notifier.flushDigest();
      expect(vi.getTimerCount()).toBe(1);
      n.notifier.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(digestRow(n).delivered_at).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("files nothing for a digest still being gathered when it is stopped, and files it on the next flush once started", async () => {
    vi.useFakeTimers();
    try {
      const n = setup({ digestWriteMs: 1000 });
      const item = await n.notifier.notify({ level: "digest", title: "Курс доллара", body: "480", agentId: "assistant" });
      // A plugin's section keeps the gathering open while the notifier is stopped (a cluster standby, a shutdown).
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      n.hooks.register("digest.compose", "slow", async () => {
        await gate;
        return { title: "Slow", body: "late section" };
      });
      const flushing = n.notifier.flushDigest();
      n.notifier.stop();
      release();
      // Stopped meanwhile: no digest row, no writer, no timer; the item keeps waiting.
      expect(await flushing).toBe(0);
      expect(digestRow(n)).toBeUndefined();
      expect(n.started).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(n.row(item.id)).toMatchObject({ digested: 0, digest_id: null });
      // Led again: the next flush files the digest and starts its writer.
      n.notifier.startDigestTimer();
      expect(vi.getTimerCount()).toBe(1);
      expect(await n.notifier.flushDigest()).toBe(2);
      expect(digestRow(n).delivered_at).toBeNull();
      expect(n.started).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(digestRow(n).delivered_at).toBeTruthy();
      n.notifier.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the digest_now tool", () => {
  it("sends the digest now, and says so when nothing waits", async () => {
    const h = setup();
    const registry = new ToolRegistry();
    registerCoreTools({ registry, store: h.store, notifier: h.notifier } as unknown as CoreToolDeps);
    const call = () => registry.get("digest_now")!.invoke({}, { agentId: "assistant", conversationId: "c_1" } as never);
    const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");
    expect(textOf(await call())).toBe("Nothing waits for a digest: nothing was sent.");
    await h.notifier.notify({ level: "digest", title: "Курс доллара", body: "480", agentId: "assistant" });
    expect(textOf(await call())).toMatch(/being written from 1 item\(s\)/);
    expect(h.started).toHaveLength(1);
    h.notifier.stop();
  });
});

describe("the inbox_view tool", () => {
  const toolSetup = (opts: Parameters<typeof setup>[0] = {}) => {
    const h = setup(opts);
    const registry = new ToolRegistry();
    registerCoreTools({ registry, store: h.store, notifier: h.notifier } as unknown as CoreToolDeps);
    const view = async () => {
      const r = await registry.get("inbox_view")!.invoke({}, { agentId: "assistant", conversationId: "c_1" } as never);
      return r.content.map((c: { text?: string }) => c.text ?? "").join("");
    };
    return { ...h, registry, view };
  };

  it("is read-only", () => {
    const { registry } = toolSetup();
    expect(registry.get("inbox_view")!.descriptor.effect).toBe("read");
  });

  it("reads the Inbox to the agent: unread questions, the next digest, what came in, and what stayed behind the scenes and why", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T10:00:00Z"));
    try {
      const h = toolSetup({ settings: { digestTimes: ["19:00"] } });
      expect(await h.view()).toBe(
        [
          "The user's Inbox (times are UTC).",
          "Unread questions: none.",
          "Next digest: nothing waits for it.",
          "Recent entries: none.",
          "Behind the scenes: nothing.",
        ].join("\n"),
      );
      await h.notifier.notify({ level: "ask", title: "Залить антифриз?", body: "", agentId: "scout" });
      const alert = await h.notifier.notify({ level: "notify", title: "Ботсад закрыт\n2 ноября", body: "x", agentId: "assistant" });
      h.notifier.markInboxRead([alert.id]);
      vi.setSystemTime(new Date("2026-10-31T10:01:00Z"));
      await h.notifier.notify({ level: "notify", title: "From the hub", body: "y" });
      vi.setSystemTime(new Date("2026-10-31T10:05:00Z"));
      await h.notifier.notify({ level: "digest", title: "Курс доллара", body: "480", agentId: "scout" });
      await h.notifier.notify({ level: "silent", title: "Ничего срочного", body: "", agentId: "scout" });
      await h.notifier.notify({ level: "digest", title: "Утро", body: "1", agentId: "assistant", triggerId: "t_brief" });
      await h.notifier.notify({ level: "digest", title: "Утро 2", body: "2", agentId: "assistant", triggerId: "t_brief" });
      await h.notifier.notify({ level: "notify", kind: "approval", title: "Waiting for your approval", body: "Send", agentId: "assistant" });
      h.db.prepare("insert into notifications(id, level, kind, title, body, created_at, digested) values ('n_legacy', 'digest', 'item', 'Old item', 'o', '2026-10-01T10:00:00.000Z', 1)").run();
      await h.notifier.notify({ level: "notify", title: "Курс доллара", body: "480", agentId: "scout" });

      const out = await h.view();
      expect(out).toContain('Unread questions (1):\n- "Залить антифриз?" from Scout, 2026-10-31 10:00');
      expect(out).toContain("Next digest: at 19:00, 2 item(s) waiting.");
      expect(out).toContain('Recent entries (newest first):\n- alert "From the hub" from Assistant, 2026-10-31 10:01, unread\n- alert "Ботсад закрыт 2 ноября" from Assistant, 2026-10-31 10:00, read');
      expect(out).toContain("Behind the scenes (newest first; these did not reach the user):");
      expect(out).toContain('- item "Курс доллара" from Scout, 2026-10-31 10:05: silent (duplicate)');
      expect(out).toContain('- item "Курс доллара" from Scout, 2026-10-31 10:05: waits for the next digest');
      expect(out).toContain('- item "Ничего срочного" from Scout, 2026-10-31 10:05: silent, just for the record');
      expect(out).toContain('- item "Утро" from Assistant, 2026-10-31 10:05: replaced by a newer one');
      expect(out).toContain('- item "Утро 2" from Assistant, 2026-10-31 10:05: waits for the next digest');
      expect(out).toContain('- approval "Waiting for your approval" from Assistant, 2026-10-31 10:05: an approval push; the approval itself is in the chat');
      expect(out).toContain('- item "Old item", 2026-10-01 10:00: went into an earlier digest');

      // Once a digest is out, its items say which one.
      await h.notifier.flushDigest();
      await h.notifier.digestWritten("t_digest_1", "Сводка");
      const later = await h.view();
      expect(later).toMatch(/- item "Утро 2" from Assistant, 2026-10-31 10:05: went into the digest "Morning digest · [^"]+" \(2026-10-31 10:05\)/);
      expect(later).toMatch(/- digest "Morning digest · [^"]+" from Assistant, 2026-10-31 10:05, unread/);
      expect(later).toContain("Next digest: nothing waits for it.");
      h.notifier.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays short: the 20 newest entries and behind-the-scenes rows, and says there are more", async () => {
    const h = toolSetup();
    const put = h.db.prepare("insert into notifications(id, level, kind, title, body, created_at, delivered_at) values (?,?,?,?,?,?,?)");
    for (let i = 0; i < 30; i++) {
      const at = new Date(Date.UTC(2026, 9, 31, 3, i)).toISOString();
      put.run(`n_a${i}`, "notify", "alert", `Alert ${i}`, "", at, at);
      put.run(`n_i${i}`, "silent", "item", `Item ${i}`, "", at, null);
    }
    const out = await h.view();
    expect(out.match(/^- alert /gm)).toHaveLength(20);
    expect(out.match(/^- item /gm)).toHaveLength(20);
    expect(out).toContain('"Alert 29"');
    expect(out).not.toContain('"Alert 9"');
    expect(out).toContain("Older entries are not shown.");
    expect(out).toContain("Behind the scenes (newest first; these did not reach the user; 30 in all, older ones not shown):");
  });
});

describe("the Inbox", () => {
  const digestOf = (n: ReturnType<typeof setup>) => n.db.prepare("select * from notifications where kind = 'digest'").get() as any;
  /** The Inbox the way an app reads it: a page, then the next one before its last entry, until nothing more. */
  const walkInbox = (n: ReturnType<typeof setup>, limit: number) => {
    const pages: ReturnType<Notifier["inbox"]>[] = [];
    for (let before: string | undefined; pages.length < 30; ) {
      const page = n.notifier.inbox({ before, limit });
      pages.push(page);
      if (!page.hasMore) return pages;
      before = page.entries.at(-1)!.createdAt;
    }
    throw new Error("the Inbox never ended");
  };
  const walkBehind = (n: ReturnType<typeof setup>, limit: number) => {
    const rows: ReturnType<Notifier["behind"]> = [];
    for (let before: string | undefined, pages = 0; pages < 30; pages++) {
      const page = n.notifier.behind({ before, limit });
      rows.push(...page);
      if (!page.length) return rows;
      before = page.at(-1)!.createdAt;
    }
    throw new Error("behind the scenes never ended");
  };

  it("lists what came in, unread questions first, and the rest behind the scenes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T03:00:00Z"));
    try {
      const n = setup();
      const a = await n.notifier.notify({ level: "notify", title: "Ботсад закрыт", body: "2 ноября", agentId: "assistant", triggerId: "t_watch" });
      vi.setSystemTime(new Date("2026-10-31T03:01:00Z"));
      const q = await n.notifier.notify({ level: "ask", title: "Залить антифриз?", body: "", agentId: "assistant" });
      await n.notifier.notify({ level: "silent", title: "Ничего срочного", body: "", agentId: "assistant" });
      await n.notifier.notify({ level: "digest", title: "Новости", body: "3", agentId: "assistant" });
      const v = n.notifier.inbox();
      expect(v.questions.map((e) => e.id)).toEqual([q.id]);
      expect(v.entries.map((e) => e.id)).toEqual([a.id]);
      expect(v.entries[0]).toMatchObject({ kind: "alert", unread: true, feedbackable: true, conversationId: n.store.agentConversation("assistant").id });
      expect(v).toMatchObject({ unread: 2, behindCount: 2, hasMore: false, next: { time: "09:00", count: 1 } });

      n.notifier.markInboxRead([q.id]);
      const after = n.notifier.inbox();
      expect(after.questions).toEqual([]);
      expect(after.entries.map((e) => e.id)).toEqual([q.id, a.id]);
      expect(after.unread).toBe(1);
      expect(n.events.at(-1)).toEqual({ unread: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts an entry read once its chat is read", async () => {
    const n = setup();
    await n.notifier.notify({ level: "notify", title: "A", body: "a", agentId: "assistant" });
    expect(n.notifier.unreadCount()).toBe(1);
    n.store.markRead(n.store.agentConversation("assistant").id);
    expect(n.notifier.unreadCount()).toBe(0);
  });

  it("says behind the scenes why each item did not reach the person, and shows the digest with its sources", async () => {
    const n = setup();
    const old = await n.notifier.notify({ level: "digest", title: "Утро", body: "1", agentId: "assistant", triggerId: "t_brief" });
    const cur = await n.notifier.notify({ level: "digest", title: "Утро 2", body: "2", agentId: "assistant", triggerId: "t_brief" });
    await n.notifier.flushDigest();
    await n.notifier.digestWritten("t_digest_1", "Сводка");
    const behind = n.notifier.behind();
    expect(behind.find((b) => b.id === old.id)).toMatchObject({ supersededBy: cur.id });
    expect(behind.find((b) => b.id === cur.id)?.digest?.title).toMatch(/digest · /);
    expect(n.notifier.inbox().entries[0]).toMatchObject({ kind: "digest", body: "Сводка", agentId: "assistant", sources: [{ label: "Assistant" }] });
  });

  it("says which items still wait for the digest, apart from those that went into an earlier one", async () => {
    const n = setup();
    const waits = await n.notifier.notify({ level: "digest", title: "Waits", body: "w", agentId: "assistant" });
    const quiet = await n.notifier.notify({ level: "silent", title: "Quiet", body: "q", agentId: "assistant" });
    const replaced = await n.notifier.notify({ level: "digest", title: "Brief", body: "1", agentId: "assistant", triggerId: "t_brief" });
    const brief = await n.notifier.notify({ level: "digest", title: "Brief 2", body: "2", agentId: "assistant", triggerId: "t_brief" });
    // An item from a digest sent before digests were linked to their items: digested, with no digest to point at.
    n.db.prepare("insert into notifications(id, level, kind, title, body, created_at, digested) values ('n_legacy', 'digest', 'item', 'Old', 'o', ?, 1)").run("2026-10-01T10:00:00.000Z");
    const why = () => new Map(n.notifier.behind().map((b) => [b.id, b]));
    const before = why();
    expect([waits.id, brief.id, quiet.id, replaced.id, "n_legacy"].map((id) => before.get(id)!.waiting)).toEqual([true, true, false, false, false]);
    expect(before.get("n_legacy")!.digest).toBeUndefined();
    // Once they go into a digest they wait no more.
    await n.notifier.flushDigest();
    await n.notifier.digestWritten("t_digest_1", "Сводка");
    const after = why();
    expect([waits.id, brief.id].map((id) => after.get(id)!.waiting)).toEqual([false, false]);
    expect(after.get(waits.id)!.digest).toBeTruthy();
  });

  it("says an item in a digest still being written waits for it, and links the digest once it is out", async () => {
    const n = setup();
    const item = await n.notifier.notify({ level: "digest", title: "Курс доллара", body: "480", agentId: "assistant" });
    await n.notifier.flushDigest();
    const open = n.db.prepare("select * from notifications where kind = 'digest'").get() as any;
    expect(open.delivered_at).toBeNull();
    expect(n.row(item.id)).toMatchObject({ digested: 1, digest_id: open.id });
    const writing = n.notifier.behind().find((b) => b.id === item.id)!;
    expect(writing.waiting).toBe(true);
    expect(writing.digest).toBeUndefined();
    await n.notifier.digestWritten("t_digest_1", "Сводка");
    const out = n.notifier.behind().find((b) => b.id === item.id)!;
    expect(out.waiting).toBe(false);
    expect(out.digest).toMatchObject({ id: open.id });
  });

  it("names the agent whose dialog an entry landed in when nobody in particular raised it", async () => {
    const n = setup();
    const a = await n.notifier.notify({ level: "notify", title: "From the hub", body: "x" });
    expect(n.notifier.inbox().entries.find((e) => e.id === a.id)).toMatchObject({ agentId: "assistant", conversationId: n.store.agentConversation("assistant").id });
  });

  it("never shows a digest that is still being written: its body is raw material", async () => {
    const n = setup();
    await n.notifier.notify({ level: "digest", title: "Курс доллара", body: "480", agentId: "assistant" });
    await n.notifier.flushDigest();
    const open = digestOf(n);
    expect(open.delivered_at).toBeNull();
    expect(open.body).toContain("partOfDay");

    const v = n.notifier.inbox();
    expect(v).toMatchObject({ questions: [], entries: [], unread: 0, hasMore: false, behindCount: 1 });
    expect(v.next).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain("partOfDay");
    // The item that went into it is behind the scenes; the open digest is not, and is not pointed at either.
    const behind = n.notifier.behind();
    expect(behind).toHaveLength(1);
    expect(behind[0].id).not.toBe(open.id);
    expect(behind[0].digest).toBeUndefined();
    expect(JSON.stringify(behind)).not.toContain("partOfDay");

    await n.notifier.digestWritten("t_digest_1", "Сводка");
    expect(n.notifier.inbox().entries.map((e) => e.id)).toEqual([open.id]);
    expect(n.notifier.behind()[0].digest).toMatchObject({ id: open.id });
    expect(n.notifier.unreadCount()).toBe(1);
  });

  it("pages the entries newest first by their time, with the questions on the first page only", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T03:00:00Z"));
    try {
      const n = setup();
      const ids: string[] = [];
      for (const title of ["A", "B", "C"]) {
        ids.push((await n.notifier.notify({ level: "notify", title, body: title, agentId: "assistant" })).id);
        vi.setSystemTime(new Date(Date.now() + 60_000));
      }
      const q = await n.notifier.notify({ level: "ask", title: "Q", body: "", agentId: "assistant" });
      const first = n.notifier.inbox({ limit: 2 });
      expect(first.questions.map((e) => e.id)).toEqual([q.id]);
      // The unread question stands in "Waiting for you": it is not listed twice, and it does not take a place on the page.
      expect(first.entries.map((e) => e.id)).toEqual([ids[2], ids[1]]);
      expect(first.hasMore).toBe(true);
      const second = n.notifier.inbox({ before: first.entries.at(-1)!.createdAt, limit: 2 });
      expect(second.questions).toEqual([]);
      expect(second.next).toBeUndefined();
      expect(second.entries.map((e) => e.id)).toEqual([ids[0]]);
      expect(second.hasMore).toBe(false);
      // The limit stays between 1 and 200.
      expect(n.notifier.inbox({ limit: 0 })).toMatchObject({ entries: [{ id: ids[2] }], hasMore: true });
      expect(n.notifier.inbox({ limit: 1000 }).entries).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists an unread question once, in Waiting for you, whichever page is read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T03:00:00Z"));
    try {
      const n = setup();
      // The question is the oldest thing in the Inbox; three alerts came after it.
      const q = await n.notifier.notify({ level: "ask", title: "Old question", body: "", agentId: "assistant" });
      const alerts: string[] = [];
      for (const title of ["A1", "A2", "A3"]) {
        vi.setSystemTime(new Date(Date.now() + 60_000));
        alerts.push((await n.notifier.notify({ level: "notify", title, body: title, agentId: "assistant" })).id);
      }
      const pages = walkInbox(n, 2);
      expect(pages).toHaveLength(2);
      // On the first page only, and never again in the list by day.
      expect(pages.map((p) => p.questions.map((e) => e.id))).toEqual([[q.id], []]);
      expect(pages.map((p) => p.entries.map((e) => e.id))).toEqual([[alerts[2], alerts[1]], [alerts[0]]]);
      expect(pages.flatMap((p) => p.entries).some((e) => e.id === q.id)).toBe(false);
      // Once it is read it is an entry like the others, at its own time.
      n.notifier.markInboxRead([q.id]);
      const read = walkInbox(n, 2);
      expect(read.flatMap((p) => p.questions)).toEqual([]);
      expect(read.flatMap((p) => p.entries.map((e) => e.id))).toEqual([alerts[2], alerts[1], alerts[0], q.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an unread question that does not fit in Waiting for you in the list by day, not lost", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T03:00:00Z"));
    try {
      const n = setup();
      const asked: string[] = [];
      for (let i = 0; i < 22; i++) {
        vi.setSystemTime(new Date(Date.now() + 60_000));
        asked.push((await n.notifier.notify({ level: "ask", title: `Question ${i}`, body: "", agentId: "assistant" })).id);
      }
      const pages = walkInbox(n, 5);
      // The twenty newest wait on the first page; the two oldest are listed by their time, once each.
      expect(pages[0].questions.map((e) => e.id)).toEqual(asked.slice(2).reverse());
      expect(pages.slice(1).flatMap((p) => p.questions)).toEqual([]);
      const listed = pages.flatMap((p) => p.entries.map((e) => e.id));
      expect(listed).toEqual([asked[1], asked[0]]);
      expect(n.notifier.unreadCount()).toBe(22);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never skips entries from one moment between pages, and hands each over once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T03:00:00Z"));
    try {
      const n = setup();
      const old = await n.notifier.notify({ level: "notify", title: "Older", body: "o", agentId: "assistant" });
      // Three at the very same millisecond, as a burst of notifications from one run lands.
      vi.setSystemTime(new Date("2026-10-31T03:05:00Z"));
      const burst: string[] = [];
      for (const title of ["B1", "B2", "B3"]) burst.push((await n.notifier.notify({ level: "notify", title, body: title, agentId: "assistant" })).id);
      expect(new Set(burst.map((id) => n.row(id).created_at)).size).toBe(1);

      const pages = walkInbox(n, 1);
      const listed = pages.flatMap((p) => p.entries.map((e) => e.id));
      expect(listed).toHaveLength(4);
      expect(new Set(listed)).toEqual(new Set([...burst, old.id]));
      // A page ends between moments, never inside one: the burst comes whole, then the older one, and the last page says it is the last.
      expect(pages.map((p) => p.entries.length)).toEqual([3, 1]);
      expect(pages.map((p) => p.hasMore)).toEqual([true, false]);
      expect(pages[1].entries[0].id).toBe(old.id);
      // A page that takes the burst as its last stop still says whether more lies behind it.
      const whole = n.notifier.inbox({ limit: 3 });
      expect(whole.entries.map((e) => e.id).sort()).toEqual([...burst].sort());
      expect(whole.hasMore).toBe(true);
      expect(n.notifier.inbox({ limit: 4 })).toMatchObject({ hasMore: false });
      // The same walk with a wider page, and the burst alone.
      expect(walkInbox(n, 2).flatMap((p) => p.entries.map((e) => e.id)).sort()).toEqual([...burst, old.id].sort());
      n.db.prepare("delete from notifications where id = ?").run(old.id);
      const alone = walkInbox(n, 1);
      expect(alone).toHaveLength(1);
      expect(alone[0]).toMatchObject({ hasMore: false });
      expect(alone[0].entries.map((e) => e.id).sort()).toEqual([...burst].sort());
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps a page to 1..200, however many are asked for", () => {
    const n = setup();
    const put = n.db.prepare("insert into notifications(id, level, kind, title, body, created_at, delivered_at) values (?,?,?,?,?,?,?)");
    for (let i = 0; i < 250; i++) {
      const at = new Date(Date.UTC(2026, 9, 31, 3, 0, i)).toISOString();
      put.run(`n_a${i}`, "notify", "alert", `Alert ${i}`, "", at, at);
      put.run(`n_i${i}`, "silent", "item", `Item ${i}`, "", at, null);
    }
    expect(n.notifier.inbox({ limit: 1000 })).toMatchObject({ entries: { length: 200 }, hasMore: true });
    expect(n.notifier.inbox({ limit: -5 }).entries).toHaveLength(1);
    expect(n.notifier.inbox({ limit: Number.NaN }).entries).toHaveLength(50);
    expect(n.notifier.behind({ limit: 1000 })).toHaveLength(200);
    expect(n.notifier.behind({ limit: 0 })).toHaveLength(1);
    expect(n.notifier.behind({ limit: Number.NaN })).toHaveLength(50);
  });

  it("pages behind the scenes the same way and says what held an item back", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T03:00:00Z"));
    try {
      const n = setup();
      const a = await n.notifier.notify({ level: "silent", title: "A", body: "a", agentId: "assistant", taskId: "t_1" });
      vi.setSystemTime(new Date("2026-10-31T03:01:00Z"));
      const b = await n.notifier.notify({ level: "digest", title: "B", body: "b", agentId: "scout" });
      vi.setSystemTime(new Date("2026-10-31T03:02:00Z"));
      await n.notifier.notify({ level: "notify", title: "Ping", body: "p", agentId: "assistant", kind: "approval" });
      expect(n.notifier.behind().map((e) => e.title)).toEqual(["Ping", "B", "A"]);
      expect(n.notifier.behind({ limit: 1 }).map((e) => e.title)).toEqual(["Ping"]);
      // A limit below 1 is one item, not none.
      expect(n.notifier.behind({ limit: 0 }).map((e) => e.title)).toEqual(["Ping"]);
      const older = n.notifier.behind({ before: n.notifier.get(b.id)!.createdAt });
      expect(older).toMatchObject([{ id: a.id, level: "silent", kind: "item", agentId: "assistant", taskId: "t_1" }]);
      expect(n.notifier.behind().find((e) => e.id === b.id)).toMatchObject({ level: "digest", kind: "item", agentId: "scout" });
      // Alerts, questions and digests reached the person: they are not behind the scenes.
      await n.notifier.notify({ level: "notify", title: "Alert", body: "x", agentId: "assistant" });
      expect(n.notifier.behind().map((e) => e.title)).toEqual(["Ping", "B", "A"]);
      expect(n.notifier.inbox().behindCount).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never skips items from one moment between pages behind the scenes either", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T03:00:00Z"));
    try {
      const n = setup();
      const old = await n.notifier.notify({ level: "silent", title: "Older", body: "o", agentId: "assistant" });
      vi.setSystemTime(new Date("2026-10-31T03:05:00Z"));
      const burst: string[] = [];
      for (const title of ["B1", "B2", "B3"]) burst.push((await n.notifier.notify({ level: "silent", title, body: title, agentId: "assistant" })).id);
      expect(new Set(burst.map((id) => n.row(id).created_at)).size).toBe(1);
      const rows = walkBehind(n, 1);
      expect(rows.map((r) => r.id).sort()).toEqual([...burst, old.id].sort());
      expect(rows.at(-1)!.id).toBe(old.id);
      // The burst comes whole in one page, then the older item.
      expect(n.notifier.behind({ limit: 1 })).toHaveLength(3);
      expect(n.notifier.behind({ limit: 3 })).toHaveLength(3);
      expect(n.notifier.behind({ limit: 4 })).toHaveLength(4);
      expect(n.notifier.behind({ before: n.row(burst[0]).created_at, limit: 1 }).map((r) => r.id)).toEqual([old.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells when the next digest comes: its time, and how many items wait", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const n = setup({ settings: { digestTimes: ["19:00", "09:00"] } });
      expect(n.notifier.nextDigest()).toBeUndefined();
      await n.notifier.notify({ level: "digest", title: "A", body: "a", agentId: "assistant" });
      await n.notifier.notify({ level: "silent", title: "S", body: "s", agentId: "assistant" });
      vi.setSystemTime(new Date("2026-10-31T10:00:00Z"));
      expect(n.notifier.nextDigest()).toEqual({ time: "19:00", count: 1 });
      // Past the last one today: the first one tomorrow.
      vi.setSystemTime(new Date("2026-10-31T20:00:00Z"));
      expect(n.notifier.nextDigest()).toEqual({ time: "09:00", count: 1 });
      // Without times the digest only goes out when asked.
      n.settings.update({ digestTimes: [] });
      expect(n.notifier.nextDigest()).toEqual({ count: 1 });
      // A digest that went out has taken its items with it.
      await n.notifier.flushDigest();
      expect(n.notifier.nextDigest()).toBeUndefined();
      n.notifier.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a report its caption and a card that is not from a check no rating", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T03:00:00Z"));
    try {
      const n = setup();
      const r = await n.notifier.deliverReport({
        id: "t_r1",
        conversationId: "c_t",
        agentId: "assistant",
        title: "Утренняя сводка",
        goal: "g",
        status: "done",
        createdBy: "trigger",
        triggerId: "t_brief",
        background: true,
        deliver: "report",
        result: "Туман.",
        createdAt: "2026-10-31T03:00:00.000Z",
        updatedAt: "2026-10-31T03:01:00.000Z",
      });
      const alert = await n.notifier.notify({ level: "notify", title: "Просто так", body: "x", agentId: "assistant" });
      const byId = new Map(n.notifier.inbox().entries.map((e) => [e.id, e]));
      expect(byId.get(r!.id)).toMatchObject({ kind: "report", caption: "scheduled, 03:00", taskId: "t_r1", feedbackable: false });
      expect(byId.get(alert.id)).toMatchObject({ kind: "alert", feedbackable: false });
      expect("caption" in byId.get(alert.id)!).toBe(false);
      expect("sources" in byId.get(alert.id)!).toBe(false);
      n.notifier.feedback(r!.id, "useful");
      expect(n.notifier.inbox().entries.find((e) => e.id === r!.id)?.feedback).toBe("useful");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("what counts as unread in the Inbox", () => {
  const report = (n: ReturnType<typeof setup>, title: string, over: Partial<Task> = {}) =>
    n.notifier.deliverReport({
      id: `t_${title}`,
      conversationId: "c_t",
      agentId: "assistant",
      title,
      goal: "g",
      status: "done",
      createdBy: "trigger",
      background: true,
      deliver: "report",
      result: `${title} text`,
      createdAt: "2026-10-31T03:00:00.000Z",
      updatedAt: "2026-10-31T03:00:00.000Z",
      ...over,
    });
  const readMarker = (n: ReturnType<typeof setup>, conversationId: string) => (n.db.prepare("select read_at from conversations where id = ?").get(conversationId) as { read_at: string | null }).read_at;
  const unreadIds = (n: ReturnType<typeof setup>) => n.notifier.inbox().entries.filter((e) => e.unread).map((e) => e.title);

  it("counts a report read once its chat is read up to its message, and unread when its message is newer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T03:00:00Z"));
    try {
      const n = setup();
      const dialog = n.store.agentConversation("assistant").id;
      const first = await report(n, "First");
      expect(unreadIds(n)).toEqual(["First"]);
      // The chat was read exactly up to the message: it counts as read (at or after).
      vi.setSystemTime(new Date("2026-10-31T03:05:00Z"));
      n.store.markRead(dialog, n.store.getMessage(first!.messageId!)!.createdAt);
      expect(readMarker(n, dialog)).toBe("2026-10-31T03:00:00.000Z");
      expect(unreadIds(n)).toEqual([]);
      expect(n.notifier.unreadCount()).toBe(0);
      // A report that landed after that stays unread; the earlier one stays read.
      vi.setSystemTime(new Date("2026-10-31T03:10:00Z"));
      await report(n, "Second");
      expect(unreadIds(n)).toEqual(["Second"]);
      expect(n.notifier.unreadCount()).toBe(1);
      // Reading the chat later covers it.
      vi.setSystemTime(new Date("2026-10-31T03:15:00Z"));
      n.store.markRead(dialog);
      expect(unreadIds(n)).toEqual([]);
      expect(n.notifier.unreadCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks an entry read on its own, without reading its chat, and keeps the first time it was read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T03:00:00Z"));
    try {
      const n = setup();
      const dialog = n.store.agentConversation("assistant").id;
      const a = await report(n, "A");
      const b = await report(n, "B");
      vi.setSystemTime(new Date("2026-10-31T03:05:00Z"));
      n.notifier.markInboxRead([a!.id, "n_unknown"]);
      expect(n.row(a!.id).read_at).toBe("2026-10-31T03:05:00.000Z");
      expect(n.row(b!.id).read_at).toBeNull();
      // The chat itself was not read.
      expect(readMarker(n, dialog)).toBeNull();
      expect(unreadIds(n)).toEqual(["B"]);
      expect(n.events.at(-1)).toEqual({ unread: 1 });
      // Opening it again does not move the time, and tells the apps nothing: the count did not move.
      vi.setSystemTime(new Date("2026-10-31T04:00:00Z"));
      const told = n.events.length;
      n.notifier.markInboxRead([a!.id]);
      n.notifier.markInboxRead(["n_unknown"]);
      n.notifier.markInboxRead([]);
      expect(n.row(a!.id).read_at).toBe("2026-10-31T03:05:00.000Z");
      expect(n.events).toHaveLength(told);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts an entry with no chat message unread until it is opened", async () => {
    const n = setup();
    n.db
      .prepare("insert into notifications(id, level, kind, title, body, created_at, delivered_at) values ('n_orphan', 'notify', 'alert', 'Orphan', 'o', ?, ?)")
      .run(nowIso(), nowIso());
    expect(n.notifier.unreadCount()).toBe(1);
    expect(n.notifier.inbox().entries[0]).toMatchObject({ id: "n_orphan", unread: true });
    expect("conversationId" in n.notifier.inbox().entries[0]!).toBe(false);
    n.notifier.markInboxRead(["n_orphan"]);
    expect(n.notifier.unreadCount()).toBe(0);
  });
});
