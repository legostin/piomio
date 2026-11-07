// The registry of signal sources (signals/sources.ts): core's own four, and each plugin's from its manifest. It refuses
// what a plugin may not emit, keeps one plugin subscription per distinct (type, config) among the enabled triggers,
// and routes each signal to the triggers listening through the pipeline's intake (the sink).

import { describe, expect, it } from "vitest";
import { SignalDeclSchema, type Locale, type SignalDecl } from "@piomio/shared";
import { EventBus } from "../../src/bus.ts";
import { renderPrompt } from "../../src/signals/prompt.ts";
import { SignalSources } from "../../src/signals/sources.ts";
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

function setup(o: { decls?: Record<string, SignalDecl[]>; triggers?: Trigger[]; start?: boolean; redact?: (v: unknown) => unknown } = {}) {
  const decls = o.decls ?? { mail: MAIL, quotes: QUOTES };
  const running = new Set(Object.keys(decls));
  const calls: Array<{ op: "subscribe" | "stop"; pluginId: string; id: string; type?: string; config?: unknown }> = [];
  const deliveries: Delivery[] = [];
  const triggers: Trigger[] = [...(o.triggers ?? [])];
  const clock = { now: Date.parse("2026-11-08T10:00:00Z") };
  const plugins = {
    declared: () =>
      Object.entries(decls).map(([pluginId, d]) => ({
        pluginId,
        decls: d,
        running: running.has(pluginId),
        title: (key: string, locale?: Locale) => (key === "%signal.message%" ? (locale === "ru" ? "Новое письмо" : "New message") : key),
      })),
    subscribe: async (pluginId: string, id: string, type: string, config: unknown) => void calls.push({ op: "subscribe", pluginId, id, type, config }),
    stop: async (pluginId: string, id: string) => void calls.push({ op: "stop", pluginId, id }),
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
  });
  if (o.start !== false) s.start();
  const subscribed = () => calls.filter((c) => c.op === "subscribe");
  const stopped = () => calls.filter((c) => c.op === "stop");
  return { s, calls, deliveries, triggers, running, clock, subscribed, stopped };
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
