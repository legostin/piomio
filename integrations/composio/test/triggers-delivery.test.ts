// How composio.event's events keep coming, in one process with a fake clock: Composio in memory, a stand-in for the
// realtime channel, and the hub's public address as the plugin's own check sees it. While the events come by webhook
// the hub checks every 15 minutes that its address still reaches it and that its subscription at Composio is as it
// made it; on a problem the realtime channel opens again and the subscription is set right. When the address goes or
// stops reaching the hub, the hub's own webhook is deleted from the person's project (never their own), and made again
// once an address works. A webhook whose signature fails makes the hub read the secret again, at most every 5 minutes.
// Problems that may repeat are logged at most once per 10 minutes each, without the event's content; a check the
// egress proxy refused says so. Without a key the channel closes and webhooks are answered without their events. A
// subscription stopped while it moves to a new account stays stopped. An app's own trigger, app or account field is kept.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { PluginContext, PluginHttpRequest } from "@piomio/plugin-sdk";
import { ComposioError, hostOf, ownWebhook, TRIGGER_MESSAGE, WebhookTaken, type ComposioApi, type WebhookSubscription } from "../server/api.ts";
import { RealtimeChannel, type RealtimeDeps } from "../server/realtime.ts";
import { composioTriggers, type ComposioTriggers } from "../server/triggers.ts";

const MIN = 60_000;
const GMAIL = "GMAIL_NEW_GMAIL_MESSAGE";
const HUB = "https://hub.example.com";
const HOOK = `${HUB}/hooks/composio/events`;
const THEIRS = "https://their.example/composio";

/** Composio in memory: trigger instances, the project's webhook subscriptions (one per project), and what was asked. */
function fakeComposio() {
  const calls: string[] = [];
  const subs: WebhookSubscription[] = [];
  const instances = new Map<string, string>();
  const state = { n: 0, hold: undefined as Promise<void> | undefined, holdGet: undefined as Promise<void> | undefined };
  const api = {
    async upsertTriggerInstance(slug: string, o: { connectedAccountId?: string }) {
      calls.push(`upsert ${slug} ${o.connectedAccountId}`);
      if (state.hold) await state.hold;
      const pair = `${slug}|${o.connectedAccountId}`;
      const created = !instances.has(pair);
      if (created) instances.set(pair, `ti_${instances.size + 1}`);
      return { id: instances.get(pair)!, type: "poll", fallbackReason: null, pollingInterval: 2, created };
    },
    async setTriggerEnabled(id: string, on: boolean) {
      calls.push(`${on ? "enable" : "disable"} ${id}`);
    },
    async listActiveTriggers() {
      return [];
    },
    async createWebhookSubscription(url: string, keptId?: string) {
      calls.push(`create webhook ${url}`);
      if (!subs.length) {
        const s = { id: `whs_${++state.n}`, url, secret: `secret-${state.n}`, events: [TRIGGER_MESSAGE] };
        subs.push(s);
        return { ...s, events: [...s.events] };
      }
      const { mine, theirs } = ownWebhook(subs, url, keptId);
      if (!mine) throw new WebhookTaken(hostOf(theirs!.url));
      mine.url = url;
      if (!mine.events.includes(TRIGGER_MESSAGE)) mine.events.push(TRIGGER_MESSAGE);
      return { ...mine, events: [...mine.events] };
    },
    async getWebhookSubscription(id: string) {
      calls.push(`get webhook ${id}`);
      if (state.holdGet) await state.holdGet;
      const s = subs.find((x) => x.id === id);
      if (!s) throw new ComposioError(404, "no such subscription");
      return { ...s, events: [...s.events] };
    },
    async deleteWebhookSubscription(id: string) {
      calls.push(`delete webhook ${id}`);
      const i = subs.findIndex((x) => x.id === id);
      if (i >= 0) subs.splice(i, 1);
    },
    async listWebhookSubscriptions() {
      return subs.map((s) => ({ ...s, secret: "" }));
    },
  };
  return { api: api as unknown as ComposioApi, calls, subs, state };
}

const request = (o: Partial<PluginHttpRequest>): PluginHttpRequest => ({ method: "GET", path: "/", query: {}, headers: {}, body: null, public: true, locale: "en", ...o });

/** A V3 trigger message; its key is its log id. */
const event = (ti: string, id: string, data: unknown, account = "ca_gmail") => ({
  id,
  type: "composio.trigger.message",
  metadata: { log_id: `log_${id}`, trigger_slug: GMAIL, trigger_id: ti, connected_account_id: account },
  data,
  timestamp: "2026-11-08T10:00:00Z",
});

const sign = (secret: string, id: string, ts: number, body: string) => createHmac("sha256", Buffer.from(secret, "utf8")).update(`${id}.${ts}.${body}`).digest("base64");

/** Lets every promise chain the fake clock started run to its end (setImmediate is not faked). */
async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise<void>((r) => setImmediate(r));
}
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

/**
 * One plugin's triggers with Gmail and Slack connected. `door`: what the hub's public address answers to the plugin's
 * own check (its ping, the address gone, or the hub's egress proxy refusing it in either of the two ways it can).
 */
function setup(o: { publicUrl?: string; storage?: Array<[string, unknown]> } = {}) {
  const fake = fakeComposio();
  const storage = new Map<string, unknown>(o.storage ?? []);
  const logs: string[] = [];
  /** settingsDown: the hub's settings.get fails (a hiccup of the core, the hub shutting down). */
  const hub = { publicUrl: o.publicUrl, settingsDown: false };
  const say = (level: string) => (...a: unknown[]) => void logs.push(`[${level}] ${a.join(" ")}`);
  const ctx = {
    pluginId: "composio",
    log: { debug: say("debug"), info: say("info"), warn: say("warn"), error: say("error") },
    storage: {
      get: async (k: string) => (storage.has(k) ? structuredClone(storage.get(k)) : undefined),
      set: async (k: string, v: unknown) => void storage.set(k, structuredClone(v)),
      delete: async (k: string) => void storage.delete(k),
      list: async (prefix = "") => [...storage].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    },
    core: {
      call: async (m: string) => {
        if (m !== "settings.get") return {};
        if (hub.settingsDown) throw new Error("the hub is stopping");
        return { publicUrl: hub.publicUrl };
      },
    },
  } as unknown as PluginContext;
  const door = { mode: "hub" as "hub" | "gone" | "proxy" | "proxy-tunnel", hits: 0 };
  const channel = { running: false, starts: 0, deps: undefined as RealtimeDeps | undefined };
  const accounts: Record<string, string | undefined> = { gmail: "ca_gmail", slack: "ca_slack" };
  const key = { present: true };
  let t!: ComposioTriggers;
  const probeFetch = (async () => {
    door.hits++;
    if (door.mode === "gone") return new Response("not found", { status: 404 });
    if (door.mode === "proxy") return new Response("egress to hub.example.com is not allowed: it resolves to a private address", { status: 403 });
    if (door.mode === "proxy-tunnel") throw Object.assign(new TypeError("fetch failed"), { cause: new Error("Proxy response (403) !== 200 when HTTP Tunneling") });
    const r = await t.http(request({ path: "/ping" }));
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  t = composioTriggers({
    ctx,
    api: () => fake.api,
    hasKey: async () => key.present,
    account: (app) => accounts[app],
    apps: () => ["gmail", "slack"],
    nameOf: (app) => app,
    fetch: probeFetch,
    channel: (deps) => {
      channel.deps = deps;
      return {
        start() {
          if (!channel.running) channel.starts++;
          channel.running = true;
        },
        stop() {
          channel.running = false;
        },
      };
    },
  });
  const emitted: Array<{ sub: string; data: any; key?: string }> = [];
  const failed: Array<{ sub: string; error: string }> = [];
  let n = 0;
  async function subscribe(config: Record<string, unknown>) {
    const id = `sub_${++n}`;
    const handle = await t.provider.subscribe({ id, config }, (data, e) => void emitted.push({ sub: id, data, ...(e?.key ? { key: e.key } : {}) }), (error) => void failed.push({ sub: id, error }));
    return { id, stop: () => handle.stop() };
  }
  /** The hub's public webhook request, signed with `secret` (headers as given otherwise). */
  function webhook(secret: string, ev: Record<string, unknown>, headers?: Record<string, string>) {
    const raw = JSON.stringify(ev);
    const id = String(ev.id ?? "msg");
    const ts = Math.floor(Date.now() / 1000);
    return t.http(request({ method: "POST", path: "/events", rawBody: raw, body: ev, headers: headers ?? { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${sign(secret, id, ts, raw)}` } }));
  }
  return { t, fake, storage, logs, hub, door, channel, accounts, key, emitted, failed, subscribe, webhook };
}

const lines = (logs: string[], text: string) => logs.filter((l) => l.includes(text));

describe("composio.event's delivery (a fake clock)", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: new Date("2026-11-08T10:00:00Z") });
  });
  afterEach(async () => {
    await s?.t.close();
    vi.useRealTimers();
  });

  /** Webhook mode with the first signed webhook in: the safety-net channel is closed. */
  async function verified() {
    s = setup({ publicUrl: HUB });
    const sub = await s.subscribe({ trigger: GMAIL });
    expect(s.fake.calls).toContain(`create webhook ${HOOK}`);
    expect(s.channel.running).toBe(true);
    expect((await s.webhook("secret-1", event("ti_1", "m0", { subject: "First" }))).status).toBe(200);
    expect(s.channel.running).toBe(false);
    return sub;
  }

  describe("while the events come by webhook, every 15 minutes", () => {
    it("checks that the address still reaches the hub and that its subscription is as it made it; nothing changes when all is well", async () => {
      await verified();
      const asked = s.fake.calls.length;
      await advance(15 * MIN - 1000);
      expect(s.door.hits).toBe(1);
      await advance(1000);
      expect(s.door.hits).toBe(2);
      expect(s.fake.calls.slice(asked)).toEqual(["get webhook whs_1"]);
      expect(s.channel.running).toBe(false);
      await advance(15 * MIN);
      expect(s.door.hits).toBe(3);
      expect(lines(s.logs, "stopped working")).toEqual([]);
    });

    it("opens the realtime channel again when its subscription changed at Composio, says so once, and sets it right", async () => {
      await verified();
      // Composio rotated the secret: the hub takes the new one, and listens the other way until a signed webhook comes.
      s.fake.subs[0]!.secret = "rotated";
      await advance(15 * MIN);
      expect(s.channel.running).toBe(true);
      expect(s.storage.get("webhook")).toEqual({ id: "whs_1", url: HOOK, secret: "rotated" });
      expect(lines(s.logs, "stopped working")).toEqual([expect.stringContaining("its secret changed at Composio")]);
      expect((await s.webhook("rotated", event("ti_1", "m1", { subject: "Signed anew" }))).status).toBe(200);
      expect(s.channel.running).toBe(false);
      // Deleted at Composio: made again.
      s.fake.subs.splice(0);
      await advance(15 * MIN);
      expect(s.channel.running).toBe(true);
      expect(s.storage.get("webhook")).toEqual({ id: "whs_2", url: HOOK, secret: "secret-2" });
      // Another event type only: the trigger messages are added again.
      expect((await s.webhook("secret-2", event("ti_1", "m2", { subject: "Again" }))).status).toBe(200);
      s.fake.subs[0]!.events = ["composio.connected_account.expired"];
      await advance(15 * MIN);
      expect(s.fake.subs[0]!.events).toContain(TRIGGER_MESSAGE);
      expect(lines(s.logs, "stopped working")).toHaveLength(3);
      // No secret in the log.
      expect(s.logs.join("\n")).not.toMatch(/secret-1|secret-2|rotated/);
    });

    it("removes the hub's own webhook from the person's project when the address goes, and makes one again once an address works", async () => {
      await verified();
      s.hub.publicUrl = undefined;
      await advance(15 * MIN);
      expect(s.fake.calls).toContain("delete webhook whs_1");
      expect(s.fake.subs).toEqual([]);
      expect(s.storage.has("webhook")).toBe(false);
      expect(s.channel.running).toBe(true);
      expect(lines(s.logs, "removed the hub's webhook")).toHaveLength(1);
      // A webhook signed with the old secret is not taken any more.
      expect((await s.webhook("secret-1", event("ti_1", "m1", { subject: "Late" }))).status).toBe(401);
      // Nothing more is asked of Composio while there is no address.
      const asked = s.fake.calls.length;
      await advance(15 * MIN);
      expect(s.fake.calls.length).toBe(asked);
      // The address back: registered again; the channel listens until a signed webhook comes.
      s.hub.publicUrl = HUB;
      await advance(15 * MIN);
      expect(s.fake.calls.filter((c) => c.startsWith("create webhook"))).toHaveLength(2);
      expect(s.storage.get("webhook")).toEqual({ id: "whs_2", url: HOOK, secret: "secret-2" });
      expect(s.channel.running).toBe(true);
      expect((await s.webhook("secret-2", event("ti_1", "m3", { subject: "Back" }))).status).toBe(200);
      expect(s.channel.running).toBe(false);
    });

    it("removes it when the address stops reaching the hub", async () => {
      await verified();
      s.door.mode = "gone";
      await advance(15 * MIN);
      expect(s.fake.calls).toContain("delete webhook whs_1");
      expect(s.storage.has("webhook")).toBe(false);
      expect(s.channel.running).toBe(true);
      expect(s.logs.some((l) => /does not reach its webhooks: it answers HTTP 404/.test(l))).toBe(true);
    });

    it("opens no channel when the key went, or the last trigger stopped, while the check was asking", async () => {
      for (const meanwhile of ["the key removed", "the last trigger stopped"] as const) {
        const sub = await verified();
        // A problem the check will find, and its read at Composio held until something else happened.
        s.fake.subs[0]!.secret = "rotated";
        let release!: () => void;
        s.fake.state.holdGet = new Promise<void>((r) => (release = r));
        await advance(15 * MIN);
        expect(s.fake.calls.at(-1), meanwhile).toBe("get webhook whs_1");
        if (meanwhile === "the key removed") {
          s.key.present = false;
          s.t.keyChanged(false);
        } else sub.stop();
        s.fake.state.holdGet = undefined;
        release();
        await flush();
        expect(s.channel.running, meanwhile).toBe(false);
        expect(lines(s.logs, "stopped working"), meanwhile).toEqual([]);
        await s.t.close();
      }
    });

    it("keeps the webhook and the way events come when the hub's settings cannot be read, and checks again next time", async () => {
      await verified();
      s.hub.settingsDown = true;
      await advance(15 * MIN);
      expect(s.fake.calls.filter((c) => c.startsWith("delete"))).toEqual([]);
      expect(s.storage.get("webhook")).toEqual({ id: "whs_1", url: HOOK, secret: "secret-1" });
      expect(s.channel.running).toBe(false);
      expect(lines(s.logs, "settings could not be read")).toHaveLength(1);
      expect((await s.webhook("secret-1", event("ti_1", "m1", { subject: "Still by webhook" }))).status).toBe(200);
      expect(s.emitted.at(-1)).toMatchObject({ key: "log_m1" });
      s.hub.settingsDown = false;
      const asked = s.fake.calls.length;
      await advance(15 * MIN);
      expect(s.fake.calls.slice(asked)).toEqual(["get webhook whs_1"]);
      expect(lines(s.logs, "stopped working")).toEqual([]);
    });

    it("keeps a webhook from before when the first subscription cannot read the settings, and decides at the next check", async () => {
      const stale = "https://old.example.com/hooks/composio/events";
      s = setup({ storage: [["webhook", { id: "whs_old", url: stale, secret: "old" }]] });
      s.fake.subs.push({ id: "whs_old", url: stale, secret: "old", events: [TRIGGER_MESSAGE] });
      s.hub.settingsDown = true;
      await s.subscribe({ trigger: GMAIL });
      // Over the channel for now, nothing deleted.
      expect(s.channel.running).toBe(true);
      expect(s.fake.calls.filter((c) => c.includes("webhook"))).toEqual([]);
      expect(s.storage.has("webhook")).toBe(true);
      // The settings answer, with no public address: now the hub's webhook goes.
      s.hub.settingsDown = false;
      await advance(15 * MIN);
      expect(s.fake.calls).toContain("delete webhook whs_old");
      expect(s.storage.has("webhook")).toBe(false);
    });
  });

  describe("the hub's webhook from before", () => {
    it("is removed when the first subscription finds no public address, or one that does not reach the hub", async () => {
      for (const [publicUrl, mode] of [[undefined, "hub"], [HUB, "gone"], ["https://new.example.com", "gone"]] as const) {
        s = setup({ publicUrl, storage: [["webhook", { id: "whs_old", url: "https://old.example.com/piomio/hooks/composio/events", secret: "old" }]] });
        s.fake.subs.push({ id: "whs_old", url: "https://old.example.com/piomio/hooks/composio/events", secret: "old", events: [TRIGGER_MESSAGE] });
        s.door.mode = mode;
        await s.subscribe({ trigger: GMAIL });
        expect(s.fake.calls, `${publicUrl} ${mode}`).toContain("delete webhook whs_old");
        expect(s.fake.subs).toEqual([]);
        expect(s.storage.has("webhook")).toBe(false);
        expect(s.channel.running).toBe(true);
        await s.t.close();
      }
    });

    it("is never the person's own: one they pointed at their server is only forgotten, and theirs is never deleted", async () => {
      s = setup({ storage: [["webhook", { id: "whs_1", url: HOOK, secret: "s" }]] });
      // The hub's subscription, pointed at the person's own server since.
      s.fake.subs.push({ id: "whs_1", url: THEIRS, secret: "theirs", events: [TRIGGER_MESSAGE] });
      await s.subscribe({ trigger: GMAIL });
      expect(s.fake.calls.filter((c) => c.startsWith("delete"))).toEqual([]);
      expect(s.fake.subs).toHaveLength(1);
      expect(s.storage.has("webhook")).toBe(false);
      await s.t.close();
      // A webhook of theirs and nothing of the hub's kept.
      s = setup({ publicUrl: HUB });
      s.fake.subs.push({ id: "whs_theirs", url: THEIRS, secret: "theirs", events: [TRIGGER_MESSAGE] });
      await s.subscribe({ trigger: GMAIL });
      s.hub.publicUrl = undefined;
      await advance(15 * MIN);
      expect(s.fake.calls.filter((c) => c.startsWith("delete"))).toEqual([]);
      expect(s.fake.subs).toEqual([{ id: "whs_theirs", url: THEIRS, secret: "theirs", events: [TRIGGER_MESSAGE] }]);
    });
  });

  describe("a webhook whose signature fails", () => {
    it("makes the hub read the secret again, at most every 5 minutes, and only for well-formed headers", async () => {
      await verified();
      const gets = () => s.fake.calls.filter((c) => c === "get webhook whs_1").length;
      s.fake.subs[0]!.secret = "rotated";
      expect((await s.webhook("rotated", event("ti_1", "m1", { subject: "One" }))).status).toBe(200);
      expect(gets()).toBe(1);
      expect(s.emitted.map((e) => e.key)).toContain("log_m1");
      expect(s.storage.get("webhook")).toMatchObject({ secret: "rotated" });
      s.fake.subs[0]!.secret = "rotated-2";
      expect((await s.webhook("rotated-2", event("ti_1", "m2", { subject: "Two" }))).status).toBe(401);
      expect(gets()).toBe(1);
      await advance(5 * MIN);
      expect((await s.webhook("rotated-2", event("ti_1", "m3", { subject: "Three" }))).status).toBe(200);
      expect(gets()).toBe(2);
      // A bare signature or no timestamp: refused without asking Composio.
      await advance(5 * MIN);
      const raw = JSON.stringify(event("ti_1", "m4", {}));
      expect((await s.webhook("x", event("ti_1", "m4", {}), { "webhook-id": "m4", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": "bare" })).status).toBe(401);
      expect((await s.webhook("x", event("ti_1", "m4", {}), { "webhook-id": "m4", "webhook-signature": `v1,${sign("x", "m4", 1, raw)}` })).status).toBe(401);
      expect(gets()).toBe(2);
      expect(s.logs.join("\n")).not.toMatch(/rotated/);
    });
  });

  describe("problems that may repeat", () => {
    it("are logged at most once per 10 minutes each, without the event's content", async () => {
      s = setup();
      await s.subscribe({ trigger: GMAIL });
      const on = s.channel.deps!.onEvent;
      // Keys that are no field of Composio's can be anything (an address, an id): only counted.
      const strange = { "aigerim@example.com": "Dear Aigerim, the bank code is 4417", type: "x", metadata: { trigger_slug: GMAIL, ca_private_42: 1 } };
      on(strange);
      on(strange);
      on(event("ti_somebody", "x1", { subject: "Someone else's letter" }));
      on(event("ti_somebody", "x2", { subject: "Someone else's letter" }));
      const odd = lines(s.logs, "in no form the hub knows");
      expect(odd).toHaveLength(1);
      expect(odd[0]).toContain("(keys: type, metadata and 1 other; metadata keys: trigger_slug and 1 other)");
      expect(odd[0]).not.toMatch(/aigerim|ca_private_42/);
      const unrouted = lines(s.logs, "no subscription here");
      expect(unrouted).toHaveLength(1);
      expect(unrouted[0]).toContain("ti_somebody");
      // The channel's refused authorisation, as realtime.ts reports it.
      s.channel.deps!.log("warn", "composio: Composio refused the realtime channel's authorisation (HTTP 403)", "realtime-auth");
      s.channel.deps!.log("warn", "composio: Composio refused the realtime channel's authorisation (HTTP 403)", "realtime-auth");
      expect(lines(s.logs, "refused the realtime channel's authorisation")).toHaveLength(1);
      await advance(10 * MIN);
      on({ weird: "again", other: 1 });
      s.channel.deps!.log("warn", "composio: Composio refused the realtime channel's authorisation (HTTP 403)", "realtime-auth");
      expect(lines(s.logs, "in no form the hub knows")).toHaveLength(2);
      expect(lines(s.logs, "in no form the hub knows")[1]).toContain("(keys: none of Composio's and 2 others)");
      expect(lines(s.logs, "in no form the hub knows")[1]).toContain("1 more like it");
      expect(s.logs.join("\n")).not.toContain("weird");
      expect(lines(s.logs, "refused the realtime channel's authorisation")).toHaveLength(2);
      expect(s.logs.join("\n")).not.toMatch(/4417|Someone else/);
    });

    it("a refused webhook signature among them", async () => {
      await verified();
      const ev = event("ti_1", "m1", { subject: "Forged: your password is hunter2" });
      await s.webhook("wrong", ev);
      await s.webhook("wrong", ev);
      expect(lines(s.logs, "webhook request was refused")).toEqual([expect.stringContaining("invalid signature")]);
      expect(s.logs.join("\n")).not.toContain("hunter2");
    });
  });

  describe("the check of the public address", () => {
    it("says when the hub's own egress proxy refused it, not that the address answered 403", async () => {
      for (const mode of ["proxy", "proxy-tunnel"] as const) {
        s = setup({ publicUrl: HUB });
        s.door.mode = mode;
        await s.subscribe({ trigger: GMAIL });
        const line = s.logs.find((l) => l.includes("does not reach its webhooks"));
        expect(line, mode).toMatch(/the hub's egress proxy refused the check \(HTTP 403\)/);
        expect(line).not.toMatch(/it answers HTTP 403/);
        expect(await s.t.deliveryNote()).toMatch(/egress proxy/);
        expect(s.channel.running).toBe(true);
        await s.t.close();
      }
    });
  });

  describe("without a key", () => {
    it("closes the realtime channel (said once), answers webhooks without their events, asks Composio nothing, and comes back with the key", async () => {
      s = setup({ publicUrl: HUB });
      await s.subscribe({ trigger: GMAIL });
      // The safety net is open: no signed webhook came yet.
      expect(s.channel.running).toBe(true);
      s.key.present = false;
      s.t.keyChanged(false);
      s.t.keyChanged(false);
      expect(s.channel.running).toBe(false);
      expect(lines(s.logs, "no key")).toHaveLength(1);
      const before = s.emitted.length;
      expect((await s.webhook("secret-1", event("ti_1", "m1", { subject: "While keyless" }))).status).toBe(200);
      expect(s.emitted).toHaveLength(before);
      const asked = s.fake.calls.length;
      await advance(15 * MIN);
      expect(s.fake.calls.length).toBe(asked);
      s.key.present = true;
      s.t.keyChanged(true);
      expect((await s.webhook("secret-1", event("ti_1", "m2", { subject: "With the key" }))).status).toBe(200);
      expect(s.emitted.at(-1)).toMatchObject({ key: "log_m2" });
    });

    it("over the realtime channel: closed while there is none, open again with it", async () => {
      s = setup();
      await s.subscribe({ trigger: GMAIL });
      expect(s.channel.running).toBe(true);
      s.t.keyChanged(false);
      expect(s.channel.running).toBe(false);
      s.t.keyChanged(true);
      expect(s.channel.running).toBe(true);
    });
  });

  describe("a subscription stopped while it moves to a new account", () => {
    it("stays stopped: nothing holds the new instance, which is disabled after the grace", async () => {
      s = setup();
      const sub = await s.subscribe({ trigger: GMAIL });
      s.accounts.gmail = "ca_gmail_2";
      let release!: () => void;
      s.fake.state.hold = new Promise<void>((r) => (release = r));
      s.t.accountsChanged();
      await flush();
      expect(s.fake.calls).toContain(`upsert ${GMAIL} ca_gmail_2`);
      sub.stop();
      s.fake.state.hold = undefined;
      release();
      await flush();
      s.channel.deps!.onEvent(event("ti_2", "m1", { subject: "To nobody" }, "ca_gmail_2"));
      expect(s.emitted).toEqual([]);
      expect(s.channel.running).toBe(false);
      await advance(3 * MIN);
      expect(s.fake.calls).toContain("disable ti_2");
      expect(s.failed).toEqual([]);
    });
  });

  describe("an event's data", () => {
    it("is the app's payload with trigger, app and account added only where the payload has no such field", async () => {
      s = setup();
      await s.subscribe({ trigger: GMAIL });
      s.channel.deps!.onEvent(event("ti_1", "m1", { subject: "Hi", app: "the app's own", trigger: 5 }));
      s.channel.deps!.onEvent(event("ti_1", "m2", { subject: "Plain" }));
      expect(s.emitted.map((e) => e.data)).toEqual([
        { subject: "Hi", app: "the app's own", trigger: 5, account: "ca_gmail" },
        { subject: "Plain", trigger: GMAIL, app: "gmail", account: "ca_gmail" },
      ]);
    });
  });
});

describe("the realtime channel's refusals", () => {
  let wss: WebSocketServer;
  let url = "";
  beforeAll(async () => {
    wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => wss.once("listening", () => r()));
    url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ event: "pusher:connection_established", data: JSON.stringify({ socket_id: "1.2", activity_timeout: 120 }) }));
      ws.on("message", (m) => {
        const f = JSON.parse(String(m));
        if (f.event === "pusher:subscribe") ws.send(JSON.stringify({ event: "pusher:subscription_error", channel: f.data?.channel, data: JSON.stringify({ type: "AuthError", error: "signature private-text", status: 401 }) }));
      });
    });
  });
  afterAll(() => {
    for (const c of wss.clients) c.terminate();
    wss.close();
  });

  async function run(auth: RealtimeDeps["auth"]) {
    const said: Array<{ msg: string; reason?: string }> = [];
    const ch = new RealtimeChannel({
      credentials: async () => ({ pusherKey: "pk", projectId: "pr_1", cluster: "mt1" }),
      auth,
      onEvent: () => {},
      log: (_level, msg, reason) => void said.push({ msg, ...(reason ? { reason } : {}) }),
      base: url,
      reconnectMs: 5000,
    });
    ch.start();
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && !said.some((x) => x.reason === "realtime-auth")) await new Promise((r) => setTimeout(r, 20));
    ch.stop();
    return said.filter((x) => x.reason === "realtime-auth");
  }

  it("say only the status Composio or Pusher answered, as a line that may repeat", async () => {
    const byComposio = await run(async () => {
      throw new ComposioError(403, "the key sk_live_very_private has no access");
    });
    expect(byComposio).toEqual([{ msg: "composio: Composio refused the realtime channel's authorisation (HTTP 403)", reason: "realtime-auth" }]);
    const byPusher = await run(async (socket, channel) => `pk:sig-${socket}-${channel}`);
    expect(byPusher).toEqual([{ msg: "composio: Pusher refused the realtime channel's subscription (HTTP 401)", reason: "realtime-auth" }]);
  });
});
