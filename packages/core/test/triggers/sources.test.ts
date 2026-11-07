// The registry of signal sources (signals/sources.ts): core's own four, and each plugin's from its manifest. It refuses
// what a plugin may not emit, keeps one plugin subscription per distinct (type, config) among the enabled triggers,
// and routes each signal to the triggers listening through the pipeline's intake (the sink).

import { describe, expect, it, vi } from "vitest";
import { SignalDeclSchema, type Locale, type SignalDecl } from "@piomio/shared";
import { EventBus } from "../../src/bus.ts";
import { renderPrompt } from "../../src/signals/prompt.ts";
import { checkedConfig, SignalSources } from "../../src/signals/sources.ts";
import type { Signal, Trigger } from "../../src/signals/types.ts";
import { startTriggerHarness } from "./harness.ts";

const decl = (d: Record<string, unknown>): SignalDecl => SignalDeclSchema.parse({ title: "T", description: "D", ...d });

const MAIL = [
  decl({ type: "message", title: "%signal.message%", description: "A new message", data: { type: "object", properties: { from: { type: "string" } }, required: ["from"] }, sample: { from: "a@b.c" } }),
  decl({ type: "other", description: "Something else" }),
];
const QUOTES = [
  decl({ type: "price", mode: "subscribe", external: false, description: "A price moved", config: { type: "object", properties: { sym: { type: "string" }, n: { type: "number" } }, required: ["sym"] } }),
];

const trigger = (id: string, on: Trigger["on"], over: Partial<Trigger> = {}): Trigger => ({
  id,
  kind: "signal",
  name: id,
  prompt: "Look.",
  agentId: "assistant",
  enabled: true,
  maxRunsPerDay: 24,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  createdBy: "user",
  state: {},
  on,
  ...over,
});

interface Delivery {
  triggerId: string;
  signals: Signal[];
  reason: string;
  o?: { via?: { config?: string } };
}

function setup(
  o: {
    decls?: Record<string, SignalDecl[]>;
    triggers?: Trigger[];
    start?: boolean;
    redact?: (v: unknown) => unknown;
    /** Plugins that were installed rather than shipped with the hub. */
    installed?: string[];
    /** How the plugin answers a subscribe (after it is recorded); default: it takes it. */
    subscribe?: () => Promise<void>;
    /** The monotonic clock checks are timed with. */
    clock?: () => number;
  } = {},
) {
  const decls = o.decls ?? { mail: MAIL, quotes: QUOTES };
  const running = new Set(Object.keys(decls));
  const calls: Array<{ op: "subscribe" | "stop"; pluginId: string; id: string; type?: string; config?: unknown }> = [];
  const deliveries: Delivery[] = [];
  const logs: Array<{ pluginId: string; msg: string }> = [];
  const triggers: Trigger[] = [...(o.triggers ?? [])];
  const clock = { now: Date.parse("2026-11-08T10:00:00Z") };
  const plugins = {
    declared: () =>
      Object.entries(decls).map(([pluginId, d]) => ({
        pluginId,
        decls: d,
        running: running.has(pluginId),
        builtin: !o.installed?.includes(pluginId),
        title: (key: string, locale?: Locale) => (key === "%signal.message%" ? (locale === "ru" ? "Новое письмо" : "New message") : key),
      })),
    subscribe: async (pluginId: string, id: string, type: string, config: unknown) => {
      calls.push({ op: "subscribe", pluginId, id, type, config });
      await o.subscribe?.();
    },
    stop: async (pluginId: string, id: string) => void calls.push({ op: "stop", pluginId, id }),
    log: (pluginId: string, msg: string) => void logs.push({ pluginId, msg }),
  };
  const s = new SignalSources({
    plugins,
    triggers: () => triggers,
    sink: {
      deliver: async (triggerId, signals, reason, opts) => {
        deliveries.push({ triggerId, signals, reason, ...(opts ? { o: opts } : {}) });
        return undefined;
      },
    },
    bus: new EventBus(),
    now: () => clock.now,
    ...(o.redact ? { redact: o.redact } : {}),
    ...(o.clock ? { clock: o.clock } : {}),
  });
  if (o.start !== false) s.start();
  const subscribed = () => calls.filter((c) => c.op === "subscribe");
  const stopped = () => calls.filter((c) => c.op === "stop");
  return { s, calls, deliveries, logs, triggers, running, clock, subscribed, stopped };
}

describe("signal sources", () => {
  it("refuses a type the plugin did not declare, and a plugin it does not know", () => {
    const f = setup();
    expect(f.s.fromPlugin("mail", { type: "nope", data: {} })).toEqual({ ok: false, error: expect.stringContaining("not declared") });
    expect(f.s.fromPlugin("ghost", { type: "message", data: { from: "x" } })).toEqual({ ok: false, error: expect.stringContaining("not declared") });
    expect(f.deliveries).toEqual([]);
  });

  it("refuses data over 256 KB, nested past 50 levels, or against its schema", () => {
    const f = setup({ triggers: [trigger("t1", [{ type: "mail.message" }])] });
    const big = f.s.fromPlugin("mail", { type: "message", data: { from: "a", body: "x".repeat(256 * 1024) } });
    expect(big).toEqual({ ok: false, error: expect.stringContaining("256 KB") });
    let deep: unknown = { from: "a" };
    for (let i = 0; i < 60; i++) deep = { from: "a", inner: deep };
    expect(f.s.fromPlugin("mail", { type: "message", data: deep })).toEqual({ ok: false, error: expect.stringContaining("50 levels") });
    const bad = f.s.fromPlugin("mail", { type: "message", data: { to: "a" } });
    expect(bad).toEqual({ ok: false, error: expect.stringContaining("from") });
    expect(f.s.fromPlugin("mail", { type: "message", data: { from: "a" }, key: 42 as unknown as string })).toEqual({ ok: false, error: expect.stringContaining("key") });
    expect(f.deliveries).toEqual([]);
    // A type that declares no schema takes any JSON.
    expect(f.s.fromPlugin("mail", { type: "other", data: [1, "two"] })).toEqual({ ok: true });
  });

  it("takes a signal nobody listens to without checking its data, and checks it once a trigger listens", () => {
    let timed = 0;
    const f = setup({ clock: () => ++timed });
    // Not declared is refused all the same: that costs nothing.
    expect(f.s.fromPlugin("mail", { type: "nope", data: {} })).toEqual({ ok: false, error: expect.stringContaining("not declared") });
    expect(f.s.fromPlugin("mail", { type: "message", data: { to: "a" } })).toEqual({ ok: true });
    expect(timed).toBe(0);
    f.triggers.push(trigger("t1", [{ type: "mail.message" }], { enabled: false }));
    expect(f.s.fromPlugin("mail", { type: "message", data: { to: "a" } })).toEqual({ ok: true });
    f.triggers.push(trigger("t2", [{ type: "mail.message" }]));
    expect(f.s.fromPlugin("mail", { type: "message", data: { to: "a" } })).toEqual({ ok: false, error: expect.stringContaining("from") });
    expect(timed).toBeGreaterThan(0);
    expect(f.deliveries).toEqual([]);
  });

  it("refuses a plugin's signals for the rest of the minute once checking them took over a second, and says so once", () => {
    let t = 0;
    const f = setup({ triggers: [trigger("t1", [{ type: "mail.message" }])], clock: () => (t += 300) });
    // Each check takes 300 ms on this clock: two fit, the third passes the second, the fourth is refused.
    for (let i = 0; i < 4; i++) expect(f.s.fromPlugin("mail", { type: "message", data: { from: `a${i}` } })).toEqual({ ok: true });
    const over = f.s.fromPlugin("mail", { type: "message", data: { from: "b" } });
    expect(over).toEqual({ ok: false, error: expect.stringContaining("1000 ms of the hub's time") });
    expect(f.s.fromPlugin("mail", { type: "message", data: { from: "c" } }).ok).toBe(false);
    expect(f.logs.filter((l) => l.msg.includes("1000 ms of the hub's time"))).toHaveLength(1);
    // Another plugin has its own minute; a new minute starts afresh.
    f.triggers.push(trigger("t2", [{ type: "quotes.price", config: { sym: "A" } }]));
    f.clock.now += 60_000;
    expect(f.s.fromPlugin("mail", { type: "message", data: { from: "d" } })).toEqual({ ok: true });
    expect(f.deliveries.map((d) => (d.signals[0].data as { from: string }).from)).toEqual(["a0", "a1", "a2", "a3", "d"]);
  });

  it("lists the declarations it refuses, with why", () => {
    const f = setup({ decls: { mail: [...MAIL, decl({ type: "slow", data: { type: "object", properties: { id: { type: "string", pattern: "^[A-Z0-9_-]{1,32}$" } } } })] } });
    expect(f.s.refused()).toEqual([{ type: "mail.slow", source: "mail", why: expect.stringContaining("linear time") }]);
    expect(f.s.list("en").some((x) => x.type === "mail.slow")).toBe(false);
  });

  it("says what a trigger's on entry would get: ok, a config its source refuses, an unknown type, a plugin that does not run, a refused declaration", () => {
    const f = setup({ decls: { mail: [...MAIL, decl({ type: "loop", data: { type: "object", uniqueItems: true } })], quotes: QUOTES } });
    expect(f.s.check("mail.message", {})).toEqual({ status: "ok" });
    expect(f.s.check("hub.task.failed", {})).toEqual({ status: "ok" });
    expect(f.s.check("quotes.price", { sym: "A" })).toEqual({ status: "ok" });
    expect(f.s.check("quotes.price", { n: 1 })).toEqual({ status: "config", source: "quotes", problem: expect.stringContaining("sym") });
    expect(f.s.check("quotes.nope", {})).toEqual({ status: "unknown" });
    expect(f.s.check("ghost.thing", {})).toEqual({ status: "unknown" });
    expect(f.s.check("mail.loop", {})).toEqual({ status: "refused", source: "mail", why: expect.stringContaining("uniqueItems") });
    f.running.delete("quotes");
    expect(f.s.check("quotes.price", { sym: "A" })).toEqual({ status: "offline", source: "quotes" });
  });

  it("routes a broadcast to every enabled trigger that subscribes to its type, and to no other", async () => {
    const f = setup({
      triggers: [
        trigger("t1", [{ type: "mail.message" }]),
        trigger("t2", [{ type: "mail.other" }, { type: "mail.message", where: { path: "data.from", contains: "@acme" } }], { kind: "schedule", cron: "0 9 * * *" }),
        trigger("t3", [{ type: "mail.other" }]),
        trigger("t4", [{ type: "mail.message" }], { enabled: false }),
      ],
    });
    expect(f.s.fromPlugin("mail", { type: "message", data: { from: "boss@acme.example" }, key: "m1", subject: "Invoice" })).toEqual({ ok: true });
    expect(f.deliveries.map((d) => d.triggerId)).toEqual(["t1", "t2"]);
    for (const d of f.deliveries) {
      expect(d.reason).toBe("signal");
      expect(d.o?.via?.config).toBeUndefined();
      expect(d.signals).toEqual([
        { id: expect.stringMatching(/^sig_/), type: "mail.message", source: "mail", at: "2026-11-08T10:00:00.000Z", data: { from: "boss@acme.example" }, key: "m1", subject: "Invoice", external: true },
      ]);
    }
    // One signal, the same id wherever it went.
    expect(f.deliveries[0].signals[0].id).toBe(f.deliveries[1].signals[0].id);
  });

  it("shares one plugin subscription between triggers with the same config, and stops it when none is left", async () => {
    const f = setup({
      triggers: [
        trigger("t1", [{ type: "quotes.price", config: { sym: "A", n: 1 } }]),
        trigger("t2", [{ type: "quotes.price", config: { n: 1, sym: "A" }, where: { path: "data.v", gt: 10 } }]),
        trigger("t3", [{ type: "quotes.price", config: { sym: "B" } }]),
      ],
    });
    // Two syncs at once subscribe once each.
    await Promise.all([f.s.sync(), f.s.sync()]);
    expect(f.subscribed().map((c) => [c.pluginId, c.type, c.config])).toEqual([
      ["quotes", "price", { sym: "A", n: 1 }],
      ["quotes", "price", { sym: "B" }],
    ]);
    const [a, b] = f.subscribed();
    expect(a.id).not.toBe(b.id);
    // A signal by A's subscription goes to the triggers with A's config, with that config named for their filters.
    expect(f.s.fromPlugin("quotes", { type: "price", data: { v: 11 }, subscription: a.id })).toEqual({ ok: true });
    expect(f.deliveries.map((d) => [d.triggerId, d.o?.via?.config])).toEqual([
      ["t1", '{"n":1,"sym":"A"}'],
      ["t2", '{"n":1,"sym":"A"}'],
    ]);
    expect(f.deliveries[0].signals[0]).toMatchObject({ type: "quotes.price", source: "quotes", external: false });
    // One of the two goes: the subscription stays.
    f.triggers.splice(0, 1);
    await f.s.sync();
    expect(f.stopped()).toEqual([]);
    // Both gone: it stops; nothing more is subscribed.
    f.triggers.splice(0, 1);
    await f.s.sync();
    expect(f.stopped()).toEqual([{ op: "stop", pluginId: "quotes", id: a.id }]);
    expect(f.subscribed()).toHaveLength(2);
    expect(f.s.fromPlugin("quotes", { type: "price", data: { v: 1 }, subscription: a.id })).toEqual({ ok: false, error: expect.stringContaining("not active") });
    // A trigger turned off counts as gone.
    f.triggers[0].enabled = false;
    await f.s.sync();
    expect(f.stopped().map((c) => c.id)).toEqual([a.id, b.id]);
  });

  it("subscribes again when the plugin comes back, and refuses signals by subscriptions it no longer has", async () => {
    const f = setup({ triggers: [trigger("t1", [{ type: "quotes.price", config: { sym: "A" } }])] });
    await f.s.sync();
    const first = f.subscribed()[0].id;
    f.running.delete("quotes");
    f.s.pluginDown("quotes");
    expect(f.s.fromPlugin("quotes", { type: "price", data: {}, subscription: first })).toMatchObject({ ok: false });
    // While it is away nothing is asked of it.
    await f.s.sync();
    expect(f.subscribed()).toHaveLength(1);
    f.running.add("quotes");
    await f.s.pluginUp("quotes");
    expect(f.subscribed()).toHaveLength(2);
    const second = f.subscribed()[1];
    expect(second).toMatchObject({ pluginId: "quotes", type: "price", config: { sym: "A" } });
    expect(second.id).not.toBe(first);
    expect(f.stopped()).toEqual([]);
    expect(f.s.fromPlugin("quotes", { type: "price", data: {}, subscription: second.id })).toEqual({ ok: true });
    expect(f.deliveries.map((d) => d.triggerId)).toEqual(["t1"]);
    // A restart it was not told about (up again, no down): subscribed afresh all the same.
    await f.s.pluginUp("quotes");
    expect(f.subscribed()).toHaveLength(3);
  });

  it("refuses a subscribe-mode signal without its subscription, or by another plugin's", async () => {
    const f = setup({
      decls: { mail: [...MAIL, decl({ type: "digest", mode: "subscribe" })], quotes: QUOTES },
      triggers: [trigger("t1", [{ type: "quotes.price", config: { sym: "A" } }]), trigger("t2", [{ type: "mail.digest" }])],
    });
    await f.s.sync();
    const [price, digest] = f.subscribed();
    expect(digest).toMatchObject({ pluginId: "mail", type: "digest", config: {} });
    expect(f.s.fromPlugin("quotes", { type: "price", data: {} })).toEqual({ ok: false, error: expect.stringContaining("subscription") });
    expect(f.s.fromPlugin("mail", { type: "digest", data: {}, subscription: price.id })).toMatchObject({ ok: false });
    expect(f.s.fromPlugin("quotes", { type: "price", data: {}, subscription: "sub_forged" })).toMatchObject({ ok: false });
    expect(f.deliveries).toEqual([]);
    expect(f.s.fromPlugin("mail", { type: "digest", data: {}, subscription: digest.id })).toEqual({ ok: true });
    expect(f.deliveries.map((d) => [d.triggerId, d.o?.via?.config])).toEqual([["t2", "{}"]]);
  });

  it("limits each plugin to 600 signals a minute, before their data is checked", () => {
    const f = setup({ triggers: [trigger("t1", [{ type: "mail.other" }])] });
    for (let i = 0; i < 600; i++) expect(f.s.fromPlugin("mail", { type: "other", data: { i } })).toEqual({ ok: true });
    // Past the limit even a bad one is refused for the rate, not looked at.
    expect(f.s.fromPlugin("mail", { type: "message", data: { to: "x" } })).toEqual({ ok: false, error: expect.stringContaining("600") });
    // Another plugin has its own count.
    expect(f.s.fromPlugin("quotes", { type: "price", data: {} })).toEqual({ ok: false, error: expect.stringContaining("subscription") });
    expect(f.deliveries).toHaveLength(600);
    f.clock.now += 60_000;
    expect(f.s.fromPlugin("mail", { type: "other", data: {} })).toEqual({ ok: true });
  });

  it("does nothing before it starts or after it stops: no subscriptions, no deliveries", async () => {
    const f = setup({ start: false, triggers: [trigger("t1", [{ type: "quotes.price", config: { sym: "A" } }]), trigger("t2", [{ type: "mail.other" }])] });
    await f.s.sync();
    expect(f.calls).toEqual([]);
    expect(f.s.fromPlugin("mail", { type: "other", data: {} })).toEqual({ ok: true });
    expect(f.deliveries).toEqual([]);
    f.s.start();
    await f.s.sync();
    expect(f.subscribed()).toHaveLength(1);
    f.s.stop();
    await Promise.resolve();
    expect(f.stopped().map((c) => c.id)).toEqual([f.subscribed()[0].id]);
    await f.s.sync();
    expect(f.subscribed()).toHaveLength(1);
    expect(f.s.fromPlugin("mail", { type: "other", data: {} })).toEqual({ ok: true });
    expect(f.deliveries).toEqual([]);
  });

  it("leaves out plugin types that would take a built-in's name, and a plugin named hub", async () => {
    const f = setup({
      decls: { web: [decl({ type: "page" }), decl({ type: "rss_item" })], time: [decl({ type: "tick" })], hub: [decl({ type: "task" })] },
      triggers: [trigger("t1", [{ type: "web.page" }]), trigger("t2", [{ type: "time.tick" }]), trigger("t3", [{ type: "hub.task" }]), trigger("t4", [{ type: "web.rss_item" }])],
    });
    const types = f.s.list().map((x) => x.type);
    expect(types).toContain("web.rss_item");
    expect(types.filter((t) => t === "web.page")).toHaveLength(1);
    expect(types).not.toContain("time.tick");
    expect(types).not.toContain("hub.task");
    for (const [pluginId, type] of [
      ["web", "page"],
      ["time", "tick"],
      ["hub", "task"],
    ])
      expect(f.s.fromPlugin(pluginId, { type, data: {} })).toMatchObject({ ok: false });
    expect(f.s.fromPlugin("web", { type: "rss_item", data: {} })).toEqual({ ok: true });
    expect(f.deliveries.map((d) => d.triggerId)).toEqual(["t4"]);
  });

  it("lists the four built-ins, online, and each plugin's sources, online while it runs", () => {
    const f = setup();
    f.running.delete("quotes");
    const list = f.s.list("ru");
    expect(list.slice(0, 4).map((x) => [x.type, x.online, x.external, x.source])).toEqual([
      ["time.cron", true, false, "hub"],
      ["time.at", true, false, "hub"],
      ["web.page", true, true, "hub"],
      ["web.webhook", true, true, "hub"],
    ]);
    // Each has a title in the person's language, from core's catalog.
    expect(list[0].title).not.toBe("");
    expect(list[0].title).not.toBe(f.s.list("en")[0].title);
    expect(list.find((x) => x.type === "mail.message")).toEqual({
      type: "mail.message",
      source: "mail",
      mode: "broadcast",
      title: "Новое письмо",
      description: "A new message",
      data: MAIL[0].data,
      sample: { from: "a@b.c" },
      external: true,
      online: true,
    });
    expect(list.find((x) => x.type === "quotes.price")).toMatchObject({ mode: "subscribe", config: QUOTES[0].config, external: false, online: false });
  });

  it("skips a subscription its source's config schema refuses", async () => {
    const f = setup({ triggers: [trigger("t1", [{ type: "quotes.price", config: { n: 1 } }]), trigger("t2", [{ type: "quotes.price", config: { sym: "B" } }])] });
    await f.s.sync();
    expect(f.subscribed().map((c) => c.config)).toEqual([{ sym: "B" }]);
  });

  it("cuts a long key and subject, and takes known secrets out of what came in", () => {
    const f = setup({
      triggers: [trigger("t1", [{ type: "mail.other" }])],
      redact: (v) => JSON.parse(JSON.stringify(v).replaceAll("hunter22", "[redacted: vault://pw]")),
    });
    expect(f.s.fromPlugin("mail", { type: "other", data: { text: "pw hunter22" }, key: "k".repeat(500), subject: `s ${"x".repeat(2000)} hunter22` })).toEqual({ ok: true });
    const sig = f.deliveries[0].signals[0];
    expect(sig.key).toHaveLength(200);
    expect(sig.subject!.length).toBeLessThanOrEqual(500);
    expect(sig.data).toEqual({ text: "pw [redacted: vault://pw]" });
  });

  it("cuts a huge key and subject before taking secrets out of them, and still takes out one cut across the bound", () => {
    const seen: number[] = [];
    const f = setup({
      triggers: [trigger("t1", [{ type: "mail.other" }])],
      redact: (v) => {
        if (typeof v === "string") seen.push(v.length);
        return JSON.parse(JSON.stringify(v).replaceAll("hunter22", "[redacted]"));
      },
    });
    const straddling = `${"k".repeat(195)}hunter22${"k".repeat(5_000_000)}`;
    expect(f.s.fromPlugin("mail", { type: "other", data: {}, key: straddling, subject: `${"s".repeat(495)}hunter22${"s".repeat(5_000_000)}` })).toEqual({ ok: true });
    const sig = f.deliveries[0].signals[0];
    // The secret's start is not kept as it was: the cut came after it was taken out.
    expect(sig.key).toBe(`${"k".repeat(195)}[reda`);
    expect(sig.subject).toBe(`${"s".repeat(495)}[reda`);
    expect(Math.max(...seen)).toBeLessThan(10_000);
  });

  it("runs a declared pattern in linear time on outside content, and checks a config once", async () => {
    const BAD = "^(\\w+\\s?)+$";
    const decls = [
      decl({ type: "note", data: { type: "object", properties: { text: { type: "string", pattern: BAD } } } }),
      decl({ type: "feed", mode: "subscribe", config: { type: "object", properties: { q: { type: "string", pattern: BAD } } } }),
    ];
    const f = setup({ decls: { lab: decls }, triggers: [trigger("t1", [{ type: "lab.note" }]), trigger("t2", [{ type: "lab.feed", config: { q: `${"a".repeat(7000)}!` } }])] });
    expect(f.s.list().map((x) => x.type)).toContain("lab.note");
    const t0 = performance.now();
    expect(f.s.fromPlugin("lab", { type: "note", data: { text: `${"a".repeat(10_000)}!` } })).toEqual({ ok: false, error: expect.stringContaining("pattern") });
    expect(performance.now() - t0).toBeLessThan(50);
    expect(f.s.fromPlugin("lab", { type: "note", data: { text: "hello world" } })).toEqual({ ok: true });
    const t1 = performance.now();
    for (let i = 0; i < 5; i++) await f.s.sync();
    expect(performance.now() - t1).toBeLessThan(50);
    expect(f.subscribed()).toEqual([]);
    expect(f.logs.filter((l) => l.msg.includes("not subscribed"))).toHaveLength(1);
    // The answer is kept per declaration and config (in any key order): a sync or a boot does not check it again.
    const bad = checkedConfig("lab", decls, "feed", { q: "x!", n: 1 });
    expect(bad.problem).toContain("pattern");
    expect(checkedConfig("lab", decls, "feed", { n: 1, q: "x!" })).toBe(bad);
    expect(checkedConfig("lab", decls, "feed", { q: "y!" })).not.toBe(bad);
    expect(checkedConfig("lab", decls, "feed", { q: "fine words" })).toEqual({});
  });

  it("refuses, when it first reads them, declarations whose schema could take more than linear time", () => {
    const lab = [
      decl({ type: "uniq", data: { type: "array", uniqueItems: true } }),
      decl({ type: "async", data: { $async: true, type: "object" } }),
      decl({ type: "backref", data: { type: "string", pattern: "(a)\\1" } }),
      decl({ type: "lookahead", mode: "subscribe", config: { type: "object", properties: { q: { type: "string", pattern: "(?=x)y" } } } }),
      decl({ type: "classes", data: { type: "string", pattern: "\\p{L}+" } }),
      decl({ type: "enumbig", data: { enum: Array.from({ length: 1001 }, (_, i) => i) } }),
      decl({ type: "ref", data: { $defs: { a: { type: "string" } }, $ref: "#/$defs/a" } }),
      decl({ type: "fine", data: { type: "object", properties: { uniqueItems: { type: "string" }, enum: { enum: [1, 2] } }, required: ["uniqueItems"] } }),
    ];
    const f = setup({ decls: { lab }, triggers: [trigger("t1", [{ type: "lab.fine" }]), trigger("t2", [{ type: "lab.uniq" }])] });
    f.s.list();
    expect(f.s.list().filter((x) => x.source === "lab").map((x) => x.type)).toEqual(["lab.fine"]);
    // Each said once in the plugin's log, with why.
    const said = (type: string) => f.logs.filter((l) => l.pluginId === "lab" && l.msg.includes(`lab.${type} `));
    for (const [type, why] of [
      ["uniq", "uniqueItems"],
      ["async", "$async"],
      ["backref", "linear time"],
      ["lookahead", "linear time"],
      ["classes", "\\p{…}"],
      ["enumbig", "1000"],
      ["ref", "$ref"],
    ]) {
      expect(said(type)).toHaveLength(1);
      expect(said(type)[0].msg).toContain(why);
    }
    expect(said("fine")).toEqual([]);
    expect(f.s.fromPlugin("lab", { type: "uniq", data: [] })).toEqual({ ok: false, error: expect.stringContaining("uniqueItems") });
    expect(f.s.fromPlugin("lab", { type: "fine", data: { uniqueItems: "x" } })).toEqual({ ok: true });
    expect(f.deliveries.map((d) => d.triggerId)).toEqual(["t1"]);
  });

  it("believes a source's external: false only from a plugin that ships with the hub", async () => {
    for (const installed of [false, true]) {
      const f = setup({ triggers: [trigger("t1", [{ type: "quotes.price", config: { sym: "A" } }])], ...(installed ? { installed: ["quotes"] } : {}) });
      await f.s.sync();
      expect(f.s.fromPlugin("quotes", { type: "price", data: {}, subscription: f.subscribed()[0].id })).toEqual({ ok: true });
      expect(f.deliveries[0].signals[0].external).toBe(installed);
      expect(f.s.list().find((x) => x.type === "quotes.price")!.external).toBe(installed);
    }
  });

  it("stops a subscription the plugin did not take, and tries it again with growing pauses while a trigger uses it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let fails = 4;
      const f = setup({
        triggers: [trigger("t1", [{ type: "quotes.price", config: { sym: "A" } }])],
        subscribe: async () => {
          if (fails-- > 0) throw new Error("provider down");
        },
      });
      await f.s.sync();
      const first = f.subscribed()[0].id;
      // Stopped in the plugin (it may still hold it after a timeout), said in its log, and not active.
      expect(f.stopped().map((c) => c.id)).toEqual([first]);
      expect(f.logs).toEqual([{ pluginId: "quotes", msg: expect.stringContaining("provider down; trying again in 30 s") }]);
      expect(f.s.subscriptions()).toEqual([{ type: "quotes.price", config: { sym: "A" }, active: false, failures: 1 }]);
      expect(f.s.fromPlugin("quotes", { type: "price", data: {}, subscription: first })).toMatchObject({ ok: false });
      // A sync does not try it before its pause is over.
      await f.s.sync();
      await vi.advanceTimersByTimeAsync(29_000);
      expect(f.subscribed()).toHaveLength(1);
      for (const [wait, next] of [
        [1_000, "2 min"],
        [120_000, "10 min"],
        [600_000, "30 min"],
      ] as const) {
        await vi.advanceTimersByTimeAsync(wait);
        expect(f.logs.at(-1)!.msg).toContain(`trying again in ${next}`);
      }
      expect(f.subscribed()).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(1_800_000);
      expect(f.subscribed()).toHaveLength(5);
      expect(f.s.subscriptions()).toEqual([{ type: "quotes.price", config: { sym: "A" }, active: true, failures: 0 }]);
      expect(f.s.fromPlugin("quotes", { type: "price", data: {}, subscription: f.subscribed()[4].id })).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("tries no more once no trigger uses the subscription, or the engine stops", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const f = setup({
        triggers: [trigger("t1", [{ type: "quotes.price", config: { sym: "A" } }]), trigger("t2", [{ type: "quotes.price", config: { sym: "B" } }])],
        subscribe: async () => {
          throw new Error("no");
        },
      });
      await f.s.sync();
      expect(f.subscribed()).toHaveLength(2);
      f.triggers.splice(0, 1);
      await f.s.sync();
      f.s.stop();
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(f.subscribed()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a provider's failure the plugin reports as a failed subscription, tried again later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const f = setup({ triggers: [trigger("t1", [{ type: "quotes.price", config: { sym: "A" } }])] });
      await f.s.sync();
      const id = f.subscribed()[0].id;
      // Another plugin cannot fail it.
      f.s.failed("mail", id, "nope");
      expect(f.stopped()).toEqual([]);
      f.s.failed("quotes", id, "boom");
      expect(f.stopped().map((c) => c.id)).toEqual([id]);
      expect(f.logs.at(-1)).toEqual({ pluginId: "quotes", msg: expect.stringContaining("its provider failed: boom; trying again in 30 s") });
      expect(f.s.fromPlugin("quotes", { type: "price", data: {}, subscription: id })).toMatchObject({ ok: false });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.subscribed()).toHaveLength(2);
      expect(f.s.subscriptions()[0]).toMatchObject({ active: true, failures: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the engine and its sources", () => {
  it("syncs its sources after create, update, enable, disable, delete and at boot", async () => {
    let syncs = 0;
    const h = await startTriggerHarness({ sources: [], onSourcesSync: () => void syncs++ });
    await new Promise((r) => setImmediate(r));
    await h.engine.pipeline.idle();
    expect(syncs).toBeGreaterThanOrEqual(1);
    const step = async (fn: () => Promise<unknown>) => {
      const before = syncs;
      await fn();
      expect(syncs).toBeGreaterThan(before);
    };
    let id = "";
    await step(async () => {
      id = (await h.engine.create({ kind: "signal", name: "Mail", prompt: "Look.", on: [{ type: "mail.message" }] }, { createdBy: "user" })).id;
    });
    await step(() => h.engine.update(id, { name: "Mail 2" }));
    await step(() => h.engine.update(id, { enabled: false }));
    await step(() => h.engine.update(id, { enabled: true }));
    await step(() => h.engine.onFeedback({ triggerId: id, feedback: "off" }));
    await step(() => h.engine.remove(id));
    await h.stop();
  });

  it("shows a source's data schema to the agents, cut to 4 KB", async () => {
    const props = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`field_${i}`, { type: "string", description: "x".repeat(20) }]));
    const h = await startTriggerHarness({
      sources: [
        { type: "mail.message", source: "mail", description: "A message", data: { type: "object", properties: { from: { type: "string" } } } },
        { type: "big.thing", source: "big", description: "Big", data: { type: "object", properties: props } },
      ],
    });
    const list = JSON.parse((await h.invokeText("sources")).replace(/^[^\n]*\n/, "")) as Array<{ type: string; dataSchema?: string }>;
    expect(list.find((s) => s.type === "mail.message")!.dataSchema).toBe('{"type":"object","properties":{"from":{"type":"string"}}}');
    const big = list.find((s) => s.type === "big.thing")!.dataSchema!;
    expect(big.length).toBeLessThanOrEqual(4096);
    expect(big.endsWith("…")).toBe(true);
    expect(list.find((s) => s.type === "time.cron")).not.toHaveProperty("dataSchema");
    await h.stop();
  });

  it("names where a signal came from in the goal", () => {
    const t = trigger("t1", [{ type: "mail.message" }]);
    const goal = renderPrompt(t, {
      reason: "signal",
      now: new Date("2026-11-08T10:00:00Z"),
      tz: "UTC",
      pipeline: { summary: "", signals: [{ id: "sig_1", type: "mail.message" }, { id: "sig_2", type: "quotes.price" }, { id: "sig_3", type: "mail.other" }] },
    });
    expect(goal).toContain("- Reason: a signal arrived from mail, quotes");
  });
});
