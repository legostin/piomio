// The trigger and webhook-subscription calls of the Composio API client against a tiny fake Composio: trigger types
// (paged by next_cursor, limit 50), instance upsert / list / enable / disable / delete, the project webhook
// subscription (a 409 finds the existing one and updates it) and the realtime credentials on the internal v3 path.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { composioApi, ComposioError, type ComposioApi } from "../server/api.ts";

type Call = { method: string; path: string; query: URLSearchParams; body: any; raw: string; type: string | undefined; key: string | undefined };
let calls: Call[];
let server: Server;
let api: ComposioApi;
const state = { subscriptionExists: false, upsertStatus: 201, oldUrl: "https://old.example/h", malformed: false };

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
      if (req.method === "POST" && p === "/api/v3.1/webhook_subscriptions") {
        return state.subscriptionExists
          ? send(409, { error: { message: "already exists" } })
          : send(201, { id: "whs_1", webhook_url: body.webhook_url, secret: "sec_new", enabled_events: body.enabled_events });
      }
      if (req.method === "GET" && p === "/api/v3.1/webhook_subscriptions")
        return send(200, {
          items: [
            { id: "whs_other", webhook_url: "https://other.example/h", enabled_events: ["composio.connected_account.expired"] },
            { id: "whs_old", webhook_url: "https://old.example/h", enabled_events: ["composio.trigger.message"] },
          ],
          next_cursor: null,
        });
      if (req.method === "PATCH" && p === "/api/v3.1/webhook_subscriptions/whs_old") {
        state.oldUrl = body.webhook_url;
        return send(200, { id: "whs_old", webhook_url: body.webhook_url, enabled_events: body.enabled_events });
      }
      if (req.method === "GET" && p === "/api/v3.1/webhook_subscriptions/whs_old") return send(200, { id: "whs_old", webhook_url: state.oldUrl, secret: "sec_old", enabled_events: ["composio.trigger.message"] });
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
  state.subscriptionExists = false;
  state.upsertStatus = 201;
  state.oldUrl = "https://old.example/h";
  state.malformed = false;
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
  it("creates one for trigger messages (V3) and returns its secret", async () => {
    const r = await api.createWebhookSubscription("https://hub.example/hooks/composio/events");
    expect(r).toEqual({ id: "whs_1", url: "https://hub.example/hooks/composio/events", secret: "sec_new" });
    expect(calls[0]!.body).toEqual({ webhook_url: "https://hub.example/hooks/composio/events", enabled_events: ["composio.trigger.message"], version: "V3" });
  });

  it("on 409 finds the existing subscription for trigger messages, points it at the new URL and returns its secret", async () => {
    state.subscriptionExists = true;
    const r = await api.createWebhookSubscription("https://hub.example/h");
    expect(r).toEqual({ id: "whs_old", url: "https://hub.example/h", secret: "sec_old" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/v3.1/webhook_subscriptions",
      "GET /api/v3.1/webhook_subscriptions",
      "PATCH /api/v3.1/webhook_subscriptions/whs_old",
      "GET /api/v3.1/webhook_subscriptions/whs_old",
    ]);
    expect(calls[2]!.body).toEqual({ webhook_url: "https://hub.example/h", enabled_events: ["composio.trigger.message"] });
  });

  it("reads one subscription with its secret", async () => {
    expect(await api.getWebhookSubscription("whs_old")).toEqual({ id: "whs_old", url: "https://old.example/h", secret: "sec_old" });
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
