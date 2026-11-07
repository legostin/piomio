// The trigger and webhook-subscription calls of the Composio API client against a tiny fake Composio: trigger types
// (paged by next_cursor, limit 50), instance upsert / list / enable / disable / delete, the project webhook
// subscription (a 409 reuses only the hub's own one and never touches the person's) and the realtime credentials and
// channel authorisation on the internal v3 path.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { composioApi, ComposioError, WebhookTaken, type ComposioApi } from "../server/api.ts";

type Call = { method: string; path: string; query: URLSearchParams; body: any; raw: string; type: string | undefined; key: string | undefined };
type Sub = { id: string; webhook_url: string; enabled_events: string[]; secret: string };
let calls: Call[];
let server: Server;
let api: ComposioApi;
const state = { upsertStatus: 201, malformed: false, subscriptions: [] as Sub[] };
const HUB_URL = "https://hub.example/hooks/composio/events";

const types = Array.from({ length: 3 }, (_, i) => ({
  slug: `GMAIL_T${i}`, name: `T${i}`, description: `d${i}`, instructions: "i", version: "1", types: ["poll"], toolkit: { slug: "gmail" },
  config: { properties: { label: { type: "string" } }, required: ["label"] }, payload: { type: "object" },
}));

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const u = new URL(req.url!, "http://x");
      const body = raw && req.headers["content-type"]?.startsWith("application/json") ? JSON.parse(raw) : undefined;
      calls.push({ method: req.method!, path: u.pathname, query: u.searchParams, body, raw, type: req.headers["content-type"], key: req.headers["x-api-key"] as string | undefined });
      const send = (status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
      const p = u.pathname;
      if (req.method === "GET" && p === "/api/v3.1/triggers_types") {
        return u.searchParams.get("cursor") === "c2"
          ? send(200, { items: [types[2]], next_cursor: null })
          : send(200, { items: types.slice(0, 2), next_cursor: "c2" });
      }
      if (req.method === "GET" && p === "/api/v3.1/triggers_types/GMAIL_T0") return send(200, types[0]);
      if (req.method === "GET" && p.startsWith("/api/v3.1/triggers_types/")) return send(404, { error: { message: "no such trigger type" } });
      if (req.method === "POST" && p === "/api/v3.1/trigger_instances/GMAIL_T0/upsert") return send(state.upsertStatus, state.malformed ? { ok: true } : { trigger_id: "ti_1", type: "poll", fallback_reason: null, polling_interval: 2 });
      if (req.method === "GET" && p === "/api/v3.1/trigger_instances/active") {
        return u.searchParams.get("cursor") === "c2"
          ? send(200, { items: [{ id: "ti_2", trigger_name: "GMAIL_T1", trigger_config: {}, connected_account_id: "ca_1", disabled_at: "2026-01-01T00:00:00Z" }], next_cursor: null })
          : send(200, { items: [{ id: "ti_1", trigger_name: "GMAIL_T0", trigger_config: { label: "x" }, connected_account_id: "ca_1", disabled_at: null }], next_cursor: "c2" });
      }
      if (req.method === "PATCH" && p === "/api/v3.1/trigger_instances/manage/ti_1") return send(200, { status: "success" });
      if (req.method === "DELETE" && p === "/api/v3.1/trigger_instances/manage/ti_1") return send(200, { status: "success" });
      if (req.method === "DELETE" && p === "/api/v3.1/trigger_instances/manage/ti_gone") return send(404, { error: { message: "no such trigger" } });
      // One webhook subscription per project, as Composio has it: a second POST is a 409.
      if (req.method === "POST" && p === "/api/v3.1/webhook_subscriptions") {
        if (state.subscriptions.length) return send(409, { error: { message: "already exists" } });
        const s = { id: "whs_1", webhook_url: body.webhook_url, enabled_events: body.enabled_events, secret: "sec_new" };
        state.subscriptions.push(s);
        return send(201, s);
      }
      if (req.method === "GET" && p === "/api/v3.1/webhook_subscriptions")
        return send(200, { items: state.subscriptions.map(({ secret: _, ...s }) => s), next_cursor: null });
      const sub = /^\/api\/v3\.1\/webhook_subscriptions\/(\w+)$/.exec(p);
      const s = sub && state.subscriptions.find((x) => x.id === sub[1]);
      if (sub && !s) return send(404, { error: { message: "no such subscription" } });
      if (req.method === "PATCH" && s) {
        Object.assign(s, body);
        return send(200, { id: s.id, webhook_url: s.webhook_url, enabled_events: s.enabled_events });
      }
      if (req.method === "GET" && s) return send(200, s);
      if (req.method === "GET" && p === "/api/v3/internal/sdk/realtime/credentials")
        return send(200, state.malformed ? { pusher_key: "k" } : { pusher_key: "k", project_id: "pr_1", pusher_cluster: "mt1" });
      if (req.method === "POST" && p === "/api/v3/internal/sdk/realtime/auth") {
        const form = new URLSearchParams(raw);
        return send(200, { auth: `k:${form.get("socket_id")}:${form.get("channel_name")}` });
      }
      send(404, { error: { message: `unexpected ${req.method} ${p}` } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  api = composioApi(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v3.1`, async () => "good");
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  calls = [];
  state.upsertStatus = 201;
  state.malformed = false;
  state.subscriptions = [];
});

describe("trigger types", () => {
  it("lists the types of the given apps, following next_cursor", async () => {
    expect(await api.listTriggerTypes([])).toEqual([]);
    expect(calls).toEqual([]);
    const all = await api.listTriggerTypes(["gmail", "slack"]);
    expect(all.map((t) => t.slug)).toEqual(["GMAIL_T0", "GMAIL_T1", "GMAIL_T2"]);
    expect(calls[0]!.query.get("toolkit_slugs")).toBe("gmail,slack");
    expect(calls[0]!.query.get("limit")).toBe("50");
    expect(calls[0]!.key).toBe("good");
    expect(calls[1]!.query.get("cursor")).toBe("c2");
    expect(all[0]).toMatchObject({ toolkit: "gmail", types: ["poll"], config: { required: ["label"] }, payload: { type: "object" } });
  });

  it("fetches one type; a missing one is an error", async () => {
    expect((await api.getTriggerType("GMAIL_T0")).slug).toBe("GMAIL_T0");
    await expect(api.getTriggerType("NOPE")).rejects.toMatchObject({ status: 404, kind: "other" });
  });
});

describe("trigger instances", () => {
  it("upserts an instance for a connected account and returns its id", async () => {
    const r = await api.upsertTriggerInstance("GMAIL_T0", { connectedAccountId: "ca_1", config: { label: "x" }, pollingInterval: 5 });
    expect(r).toEqual({ id: "ti_1", type: "poll", fallbackReason: null, pollingInterval: 2, created: true });
    expect(calls[0]!.body).toEqual({ connected_account_id: "ca_1", trigger_config: { label: "x" }, polling_interval: 5 });
    state.upsertStatus = 200;
    expect((await api.upsertTriggerInstance("GMAIL_T0", { userId: "u", config: {}, type: "webhook" })).created).toBe(false);
    expect(calls[1]!.body).toEqual({ user_id: "u", trigger_config: {}, type: "webhook" });
  });

  it("lists active instances (disabled ones on request) across pages", async () => {
    const all = await api.listActiveTriggers({ connectedAccountIds: ["ca_1"], showDisabled: true });
    expect(all.map((t) => [t.id, t.disabled])).toEqual([["ti_1", false], ["ti_2", true]]);
    expect(all[0]).toMatchObject({ trigger: "GMAIL_T0", account: "ca_1", config: { label: "x" } });
    expect(calls[0]!.query.get("connected_account_ids")).toBe("ca_1");
    expect(calls[0]!.query.get("show_disabled")).toBe("true");
    expect(calls[0]!.query.get("limit")).toBe("50");
  });

  it("enables, disables and deletes; one already gone is deleted", async () => {
    await api.setTriggerEnabled("ti_1", false);
    await api.setTriggerEnabled("ti_1", true);
    await api.deleteTrigger("ti_1");
    await api.deleteTrigger("ti_gone");
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["PATCH", "/api/v3.1/trigger_instances/manage/ti_1", { status: "disable" }],
      ["PATCH", "/api/v3.1/trigger_instances/manage/ti_1", { status: "enable" }],
      ["DELETE", "/api/v3.1/trigger_instances/manage/ti_1", undefined],
      ["DELETE", "/api/v3.1/trigger_instances/manage/ti_gone", undefined],
    ]);
  });
});

describe("webhook subscriptions", () => {
  const routes = () => calls.map((c) => `${c.method} ${c.path}`);

  it("creates one for trigger messages (V3) and returns its secret", async () => {
    const r = await api.createWebhookSubscription(HUB_URL);
    expect(r).toEqual({ id: "whs_1", url: HUB_URL, secret: "sec_new", events: ["composio.trigger.message"] });
    expect(calls[0]!.body).toEqual({ webhook_url: HUB_URL, enabled_events: ["composio.trigger.message"], version: "V3" });
  });

  it("on 409 reuses the subscription that already goes to this hub, adding only the trigger event to the ones it has", async () => {
    state.subscriptions = [{ id: "whs_here", webhook_url: HUB_URL, enabled_events: ["composio.connected_account.expired"], secret: "sec_here" }];
    const r = await api.createWebhookSubscription(HUB_URL);
    expect(r).toEqual({ id: "whs_here", url: HUB_URL, secret: "sec_here", events: ["composio.connected_account.expired", "composio.trigger.message"] });
    expect(routes()).toEqual(["POST /api/v3.1/webhook_subscriptions", "GET /api/v3.1/webhook_subscriptions", "PATCH /api/v3.1/webhook_subscriptions/whs_here", "GET /api/v3.1/webhook_subscriptions/whs_here"]);
    expect(calls[2]!.body).toEqual({ enabled_events: ["composio.connected_account.expired", "composio.trigger.message"] });
  });

  it("on 409 points the hub's own subscription (the id it kept) at its new address, and changes nothing when nothing differs", async () => {
    state.subscriptions = [{ id: "whs_old", webhook_url: "https://old-hub.example/hooks/composio/events", enabled_events: ["composio.trigger.message"], secret: "sec_old" }];
    const r = await api.createWebhookSubscription(HUB_URL, "whs_old");
    expect(r).toMatchObject({ id: "whs_old", url: HUB_URL, secret: "sec_old" });
    expect(calls[2]).toMatchObject({ method: "PATCH", body: { webhook_url: HUB_URL } });
    calls = [];
    await api.createWebhookSubscription(HUB_URL, "whs_old");
    expect(routes()).toEqual(["POST /api/v3.1/webhook_subscriptions", "GET /api/v3.1/webhook_subscriptions", "GET /api/v3.1/webhook_subscriptions/whs_old"]);
  });

  it("never changes a subscription the person set up: it says where theirs goes instead", async () => {
    state.subscriptions = [{ id: "whs_theirs", webhook_url: "https://their.example/composio", enabled_events: ["composio.connected_account.expired"], secret: "theirs" }];
    await expect(api.createWebhookSubscription(HUB_URL)).rejects.toMatchObject({ host: "their.example", kind: "other" });
    // Not even when the kept id names it: they pointed it somewhere of their own since.
    await expect(api.createWebhookSubscription(HUB_URL, "whs_theirs")).rejects.toBeInstanceOf(WebhookTaken);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(state.subscriptions[0]).toMatchObject({ webhook_url: "https://their.example/composio", enabled_events: ["composio.connected_account.expired"] });
  });

  it("reads one subscription with its secret, and lists them without", async () => {
    state.subscriptions = [{ id: "whs_old", webhook_url: "https://old.example/h", enabled_events: ["composio.trigger.message"], secret: "sec_old" }];
    expect(await api.getWebhookSubscription("whs_old")).toEqual({ id: "whs_old", url: "https://old.example/h", secret: "sec_old", events: ["composio.trigger.message"] });
    expect(await api.listWebhookSubscriptions()).toEqual([{ id: "whs_old", url: "https://old.example/h", secret: "", events: ["composio.trigger.message"] }]);
    await expect(api.getWebhookSubscription("whs_gone")).rejects.toMatchObject({ status: 404 });
  });
});

describe("realtime credentials", () => {
  it("come from the internal v3 path, not the v3.1 base", async () => {
    expect(await api.realtimeCredentials()).toEqual({ pusherKey: "k", projectId: "pr_1", cluster: "mt1" });
    expect(calls[0]!.path).toBe("/api/v3/internal/sdk/realtime/credentials");
    expect(calls[0]!.key).toBe("good");
  });

  it("authorise the private channel with a form like pusher-js sends", async () => {
    expect(await api.realtimeAuth("123.456", "private-pr_1_triggers")).toBe("k:123.456:private-pr_1_triggers");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v3/internal/sdk/realtime/auth", key: "good", type: "application/x-www-form-urlencoded", raw: "socket_id=123.456&channel_name=private-pr_1_triggers" });
  });
});

describe("errors", () => {
  it("surface as ComposioError", async () => {
    await expect(api.setTriggerEnabled("ti_zzz", true)).rejects.toBeInstanceOf(ComposioError);
  });

  it("a 2xx answer without what it should hold is the request's problem, not an outage", async () => {
    state.malformed = true;
    await expect(api.upsertTriggerInstance("GMAIL_T0", { config: {} })).rejects.toMatchObject({ kind: "other" });
    await expect(api.realtimeCredentials()).rejects.toMatchObject({ kind: "other" });
  });
});
