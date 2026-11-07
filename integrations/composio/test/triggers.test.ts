// composio.event, the apps' events as trigger signals, against a fake Composio and a fake Pusher (a local `ws` server
// speaking the few frames Composio's realtime channel uses). A subscription upserts a trigger instance on the app's
// account with its config and takes a lease on it in storage; the last stop disables it only after a grace, unless
// another process holds a fresh lease by then; a reconcile disables the hub's instances nothing holds any more.
// Without a public https address the events come over the realtime channel (credentials, private-channel auth,
// trigger_to_client and its chunked form, ping, handshake timeout, reconnect); with one, over a project webhook the hub
// registers (never the person's own), checked by its signature, with the channel as a safety net until the first
// signed webhook. While the plugin warms up, a webhook for one of the hub's instances not held yet is answered 503. An
// event goes to the subscription whose instance it names, once, keyed by its log id. Subscriptions follow their
// app's account: moved on a new sign-in, failed on a sign-out. composio_triggers lists the types and says how events
// come.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { startPlugin, type PluginHarness } from "@piomio/testkit";
import { checkedConfig } from "../../../packages/core/src/signals/sources.ts";
import { canonical, incoming, isPublicHttps, signatureProblem, subjectOf } from "../server/triggers.ts";

const dir = join(import.meta.dirname, "..");
const SECRET = "composio-webhook-secret-for-tests";
const GMAIL = "GMAIL_NEW_GMAIL_MESSAGE";
const SLACK = "SLACK_RECEIVE_MESSAGE";
const HUB = "https://hub.example.com";
const HOOK = `${HUB}/hooks/composio/events`;

const triggerTypes = [
  {
    slug: GMAIL, name: "New Gmail message", description: "A new message in the inbox", instructions: "", types: ["poll"], toolkit: { slug: "gmail" },
    config: { type: "object", properties: { labelIds: { type: "string" }, interval: { type: "number" } } }, payload: { type: "object" },
  },
  {
    slug: SLACK, name: "Message received", description: "A message in a channel", instructions: "", types: ["webhook"], toolkit: { slug: "slack" },
    config: { type: "object", properties: { channel: { type: "string" } } }, payload: { type: "object" },
  },
];

type Sub = { id: string; webhook_url: string; enabled_events: string[]; secret: string };

function fakeComposio() {
  const upserts: Array<{ slug: string; body: any }> = [];
  const patches: Array<{ id: string; status: string }> = [];
  const webhooks: any[] = [];
  const auths: Array<{ socket: string | null; channel: string | null }> = [];
  const paths: string[] = [];
  const actives: string[] = [];
  const instances = new Map<string, string>();
  /** Instances that are on, connected accounts and their status, the project's webhook subscriptions. */
  const on = new Set<string>();
  const accounts = new Map<string, string>([["ca_gmail", "ACTIVE"], ["ca_slack", "ACTIVE"]]);
  const subs: Sub[] = [];
  const state = { hold: undefined as Promise<void> | undefined, n: 0 };
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const u = new URL(req.url!, "http://x");
      const json = raw && String(req.headers["content-type"]).startsWith("application/json") ? JSON.parse(raw) : undefined;
      const send = (status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
      if (req.headers["x-api-key"] !== "good") return send(401, { error: { message: "Invalid API key" } });
      const p = u.pathname;
      paths.push(`${req.method} ${p}`);
      let m: RegExpExecArray | null;
      if (req.method === "POST" && p === "/api/v3.1/connected_accounts/link") {
        const id = `ca_${String(json.auth_config_id).slice(3)}_${++state.n + 1}`;
        accounts.set(id, "INITIATED");
        return send(201, { redirect_url: `https://connect.composio.dev/link/${id}`, connected_account_id: id, expires_at: new Date(Date.now() + 600_000).toISOString() });
      }
      if ((m = /^\/api\/v3\.1\/connected_accounts\/(\w+)$/.exec(p))) {
        if (state.hold) await state.hold;
        const status = accounts.get(m[1]!);
        if (!status) return send(404, { error: { message: "no such account" } });
        if (req.method === "DELETE") {
          accounts.delete(m[1]!);
          return send(200, { success: true });
        }
        return send(200, { id: m[1], status, toolkit: { slug: m[1]!.split("_")[1] } });
      }
      if (req.method === "GET" && p === "/api/v3.1/tools") return send(200, { items: [] });
      if (req.method === "GET" && (m = /^\/api\/v3\.1\/toolkits\/(\w+)$/.exec(p))) return send(200, { slug: m[1], name: m[1], composio_managed_auth_schemes: ["OAUTH2"] });
      if (req.method === "POST" && p === "/api/v3.1/auth_configs") return send(201, { auth_config: { id: `ac_${json.toolkit.slug}` } });
      if (req.method === "GET" && p === "/api/v3.1/triggers_types") {
        const kits = (u.searchParams.get("toolkit_slugs") ?? "").split(",");
        return send(200, { items: triggerTypes.filter((t) => kits.includes(t.toolkit.slug)), next_cursor: null });
      }
      if (req.method === "GET" && (m = /^\/api\/v3\.1\/triggers_types\/(\w+)$/.exec(p))) {
        const t = triggerTypes.find((x) => x.slug === m![1]);
        return t ? send(200, t) : send(404, { error: { message: "no such trigger type" } });
      }
      if (req.method === "POST" && (m = /^\/api\/v3\.1\/trigger_instances\/(\w+)\/upsert$/.exec(p))) {
        upserts.push({ slug: m[1]!, body: json });
        const pair = `${m[1]}|${json.connected_account_id}`;
        const created = !instances.has(pair);
        if (created) instances.set(pair, `ti_${instances.size + 1}`);
        if (created) on.add(instances.get(pair)!);
        return send(created ? 201 : 200, { trigger_id: instances.get(pair), type: "poll", fallback_reason: null, polling_interval: 2 });
      }
      if (req.method === "GET" && p === "/api/v3.1/trigger_instances/active") {
        actives.push(u.searchParams.get("trigger_ids") ?? "");
        const ids = (u.searchParams.get("trigger_ids") ?? "").split(",");
        return send(200, { items: ids.filter((id) => on.has(id)).map((id) => ({ id, trigger_name: GMAIL, trigger_config: {}, connected_account_id: "ca_gmail", disabled_at: null })), next_cursor: null });
      }
      if (req.method === "PATCH" && (m = /^\/api\/v3\.1\/trigger_instances\/manage\/(\w+)$/.exec(p))) {
        patches.push({ id: m[1]!, status: json.status });
        if (json.status === "enable") on.add(m[1]!);
        else on.delete(m[1]!);
        return send(200, { status: "success" });
      }
      // One webhook subscription per project, as Composio has it: a second POST is a 409.
      if (req.method === "POST" && p === "/api/v3.1/webhook_subscriptions") {
        webhooks.push(json);
        if (subs.length) return send(409, { error: { message: "a webhook subscription exists" } });
        const s = { id: `whs_${webhooks.length}`, webhook_url: json.webhook_url, enabled_events: json.enabled_events, secret: SECRET };
        subs.push(s);
        return send(201, s);
      }
      if (req.method === "GET" && p === "/api/v3.1/webhook_subscriptions") return send(200, { items: subs.map(({ secret: _, ...s }) => s), next_cursor: null });
      const ws = /^\/api\/v3\.1\/webhook_subscriptions\/(\w+)$/.exec(p);
      const sub = ws && subs.find((s) => s.id === ws[1]);
      if (ws && !sub) return send(404, { error: { message: "no such subscription" } });
      if (req.method === "PATCH" && sub) return send(200, Object.assign(sub, json));
      if (req.method === "GET" && sub) return send(200, sub);
      if (req.method === "GET" && p === "/api/v3/internal/sdk/realtime/credentials") return send(200, { pusher_key: "pk_test", project_id: "pr_1", pusher_cluster: "mt1" });
      if (req.method === "POST" && p === "/api/v3/internal/sdk/realtime/auth") {
        const form = new URLSearchParams(raw);
        auths.push({ socket: form.get("socket_id"), channel: form.get("channel_name") });
        return send(200, { auth: `pk_test:sig-${form.get("socket_id")}` });
      }
      send(404, { error: { message: `no route ${req.method} ${p}` } });
    });
  });
  const instanceOf = (slug: string, account: string) => instances.get(`${slug}|${account}`);
  const listen = () => new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v3.1`)));
  return { server, listen, upserts, patches, webhooks, auths, paths, actives, instanceOf, on, accounts, subs, state };
}

/** Pusher's side of the few frames used: connection, private-channel subscribe (checked against the auth), ping. */
function fakePusher() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  type Sock = { ws: WsSocket; url: string; socketId: string; channel?: string; frames: any[] };
  const sockets: Sock[] = [];
  const state = { silent: false };
  wss.on("connection", (ws, req) => {
    const s: Sock = { ws, url: req.url ?? "", socketId: `${1000 + sockets.length}.${4242 + sockets.length}`, frames: [] };
    sockets.push(s);
    ws.on("message", (m) => {
      const f = JSON.parse(String(m));
      s.frames.push(f);
      if (f.event === "pusher:subscribe") {
        if (f.data?.auth === `pk_test:sig-${s.socketId}`) {
          s.channel = f.data.channel;
          ws.send(JSON.stringify({ event: "pusher_internal:subscription_succeeded", channel: f.data.channel, data: "{}" }));
        } else ws.send(JSON.stringify({ event: "pusher:subscription_error", channel: f.data?.channel, data: JSON.stringify({ type: "AuthError", status: 401 }) }));
      }
    });
    // A server that never says the connection is established: the client gives up on it.
    if (!state.silent) ws.send(JSON.stringify({ event: "pusher:connection_established", data: JSON.stringify({ socket_id: s.socketId, activity_timeout: 120 }) }));
  });
  const live = () => sockets.filter((s) => s.channel && s.ws.readyState === 1);
  const open = () => sockets.filter((s) => s.ws.readyState === 1);
  const push = (event: string, data: unknown) => {
    for (const s of live()) s.ws.send(JSON.stringify({ event, channel: s.channel, data: typeof data === "string" ? data : JSON.stringify(data) }));
  };
  const ready = new Promise<void>((r) => wss.once("listening", () => r()));
  const close = () => {
    for (const s of sockets) s.ws.terminate();
    wss.close();
  };
  return { wss, sockets, state, live, open, push, ready, close, url: () => `ws://127.0.0.1:${(wss.address() as AddressInfo).port}` };
}

/**
 * The hub's public address as the outside sees it: GET /hooks/composio/ping goes to the plugin (as the hub's public
 * route does), or the address answers 404 (like the Access from anywhere link), or another server answers.
 */
function frontDoor() {
  const state = { mode: "hub" as "hub" | "404" | "stranger", hits: [] as string[], h: undefined as PluginHarness | undefined };
  const server = createServer(async (req, res) => {
    state.hits.push(`${req.method} ${req.url}`);
    if (state.mode === "404" || req.url !== "/hooks/composio/ping" || !state.h) return res.writeHead(404).end("not found");
    if (state.mode === "stranger") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, nonce: "a-stale-hub" }));
    const r = await state.h.http({ method: "GET", path: "/ping", public: true });
    res.writeHead(r.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(r.body));
  });
  const listen = () => new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  return { server, state, listen };
}

/** A V3 trigger message, as Composio sends it by webhook and over the channel; its key is its log id. */
const message = (ti: string, id: string, data: Record<string, unknown>, slug = GMAIL, account = "ca_gmail") => ({
  id,
  type: "composio.trigger.message",
  metadata: { log_id: `log_${id}`, trigger_slug: slug, trigger_id: ti, connected_account_id: account, auth_config_id: "ac_1", user_id: "piomio-test" },
  data,
  timestamp: "2026-11-08T10:00:00Z",
});

async function until<T>(fn: () => T | undefined | false, what: string, timeoutMs = 10_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const sign = (id: string, ts: number, body: string, secret = SECRET) => createHmac("sha256", Buffer.from(secret, "utf8")).update(`${id}.${ts}.${body}`).digest("base64");
const nowS = () => Math.floor(Date.now() / 1000);

/** The hub's public webhook request, with the body exactly as it came, signed unless told otherwise. */
function post(h: PluginHarness, raw: string, headers?: Record<string, string>) {
  const id = JSON.parse(raw).id ?? "msg";
  const ts = nowS();
  const req = {
    method: "POST",
    path: "/events",
    public: true,
    headers: { "content-type": "application/json", ...(headers ?? { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${sign(id, ts, raw)}` }) },
    body: JSON.parse(raw),
    rawBody: raw,
  };
  return h.http(req);
}

/** The plugin's storage with Gmail and Slack signed in already, and anything else given. */
function signedIn(more: Array<[string, unknown]> = []): Map<string, unknown> {
  return new Map<string, unknown>([
    ["userId", "piomio-test"],
    ["apps", { gmail: { accountId: "ca_gmail", status: "ACTIVE" }, slack: { accountId: "ca_slack", status: "ACTIVE" } }],
    ...more,
  ]);
}

/** `door`: a front door the plugin checks its public address through, instead of the address itself. */
async function start(api: string, o: { storage?: Map<string, unknown>; publicUrl?: string | (() => string); pusher?: string; minuteMs?: number; door?: ReturnType<typeof frontDoor> }) {
  const door = o.door ? await o.door.listen() : undefined;
  const h = await startPlugin({
    dir,
    storage: o.storage ?? signedIn(),
    vault: { composio: { value: "good" } },
    core: (method) => (method === "settings.get" ? { publicUrl: (typeof o.publicUrl === "function" ? o.publicUrl() : o.publicUrl) ?? "http://localhost:8080" } : {}),
    env: {
      PIOMIO_COMPOSIO_API: api,
      PIOMIO_COMPOSIO_PUSHER: o.pusher ?? "ws://127.0.0.1:1",
      PIOMIO_COMPOSIO_RECONNECT_MS: "30",
      PIOMIO_COMPOSIO_POLL_MS: "30",
      PIOMIO_COMPOSIO_MINUTE_MS: String(o.minuteMs ?? 400),
      ...(door ? { PIOMIO_COMPOSIO_PROBE_URL: door } : {}),
    },
  });
  if (o.door) o.door.state.h = h;
  return h;
}

describe("the declaration", () => {
  const manifest = JSON.parse(readFileSync(join(dir, ".piomio-plugin", "plugin.json"), "utf8"));
  const decl = manifest.contributes.signals?.find((s: any) => s.type === "event");

  it("is one subscribe-mode source of outside content, with the webhook route and the channel's hosts", () => {
    expect(decl).toMatchObject({ type: "event", mode: "subscribe", external: true, title: "%signal.event.title%" });
    expect(decl.description).toMatch(/2 minutes/);
    expect(manifest.contributes.http).toBe(true);
    expect(manifest.permissions.network).toEqual(expect.arrayContaining(["backend.composio.dev", "*.pusher.com"]));
    expect(manifest.permissions.core).toContain("settings.get");
    for (const locale of ["en", "ru"]) {
      const m = JSON.parse(readFileSync(join(dir, ".piomio-plugin", "locales", `${locale}.json`), "utf8"));
      expect(m["signal.event.title"]).toBeTruthy();
      // The card says the hub registers a webhook in the person's project, and what the other way is.
      expect(m["via.about"]).toMatch(locale === "en" ? /registers a webhook in your Composio project/ : /регистрирует вебхук в вашем проекте Composio/);
    }
  });

  it("has schemas the hub accepts (linear-time, no references) that take a trigger and refuse anything else", () => {
    const decls = manifest.contributes.signals ?? [];
    expect(checkedConfig("composio", decls, "event", { trigger: GMAIL, config: { labelIds: "INBOX" } })).toEqual({});
    expect(checkedConfig("composio", decls, "event", { trigger: SLACK, app: "slack", account: "ca_slack" })).toEqual({});
    expect(checkedConfig("composio", decls, "event", {}).problem).toMatch(/does not match/);
    expect(checkedConfig("composio", decls, "event", { trigger: "GMAIL; DROP" }).problem).toMatch(/does not match/);
    expect(checkedConfig("composio", decls, "event", { trigger: GMAIL, other: 1 }).problem).toMatch(/does not match/);
  });
});

describe("reading events and addresses", () => {
  it("reads Composio's V3, V2 and V1 envelopes and the SDK's oldest form, keyed by the log id first", () => {
    expect(incoming(message("ti_1", "msg_1", { subject: "Hi" }))).toEqual({ instances: ["ti_1"], id: "log_msg_1", trigger: GMAIL, account: "ca_gmail", data: { subject: "Hi" } });
    const { log_id: _, ...noLog } = message("ti_1", "msg_1", {}).metadata;
    expect(incoming({ ...message("ti_1", "msg_1", {}), metadata: noLog })!.id).toBe("msg_1");
    expect(
      incoming({ type: "gmail_new_gmail_message", log_id: "log_2", data: { subject: "Hi", trigger_nano_id: "ti_2", trigger_id: "uuid-2", connection_nano_id: "ca_g", connection_id: "uuid-c", user_id: "u" } }),
    ).toEqual({ instances: ["ti_2", "uuid-2"], id: "log_2", trigger: GMAIL, account: "ca_g", data: { subject: "Hi" } });
    expect(incoming({ trigger_name: GMAIL, trigger_id: "ti_3", connection_id: "ca_g", payload: { title: "T" }, log_id: "log_3" })).toEqual({
      instances: ["ti_3"], id: "log_3", trigger: GMAIL, account: "ca_g", data: { title: "T" },
    });
    expect(incoming({ appName: "gmail", payload: { a: 1 }, metadata: { id: "uuid-4", nanoId: "ti_4", triggerName: GMAIL, connection: { id: "ca_g" } } })).toEqual({
      instances: ["ti_4", "uuid-4"], trigger: GMAIL, account: "ca_g", data: { a: 1 },
    });
    expect(incoming({ type: "composio.connected_account.expired", data: {} })).toBeUndefined();
    expect(incoming("text")).toBeUndefined();
  });

  it("takes a one-line subject from the payload's obvious field", () => {
    expect(subjectOf({ name: "N", text: "  two\n lines " })).toBe("two lines");
    expect(subjectOf({ subject: "x".repeat(200) })).toHaveLength(120);
    expect(subjectOf({ body: "no obvious one" })).toBeUndefined();
    expect(subjectOf("text")).toBeUndefined();
  });

  it("takes only a public https address for a webhook: a Tailscale name only on Funnel's port", () => {
    for (const url of [HUB, "https://piomio.tail1234.ts.net/", "https://piomio.tail1234.ts.net:443/", "https://hub.example.com:8443"]) expect(isPublicHttps(url)).toBe(true);
    for (const url of [
      "http://hub.example.com", "https://my-box.tailnet.ts.net:8080", "https://localhost:8080", "https://127.0.0.1", "https://[::1]", "https://192.168.1.5", "https://10.0.0.2",
      "https://100.101.1.1", "https://mac.local", "https://hub", "not a url", undefined,
    ]) {
      expect(isPublicHttps(url)).toBe(false);
    }
  });

  it("takes only v1 signatures and treats configs that say the same as the same", () => {
    const ts = nowS();
    const sig = createHmac("sha256", SECRET).update(`m.${ts}.{}`).digest("base64");
    const at = Date.now();
    expect(signatureProblem({ "Webhook-Id": "m", "Webhook-Timestamp": String(ts), "Webhook-Signature": `v1,${sig}` }, "{}", SECRET, at)).toBeUndefined();
    expect(signatureProblem({ "webhook-id": "m", "webhook-timestamp": String(ts), "webhook-signature": sig }, "{}", SECRET, at)).toBe("invalid signature");
    expect(signatureProblem({ "webhook-id": "m", "webhook-timestamp": String(ts), "webhook-signature": `v2,${sig}` }, "{}", SECRET, at)).toBe("invalid signature");
    expect(signatureProblem({ "webhook-id": "m", "webhook-timestamp": String(ts + 400), "webhook-signature": `v1,${sig}` }, "{}", SECRET, at)).toMatch(/stale/);
    expect(canonical({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(canonical({ a: { d: [1, { x: 1, y: 2 }] }, b: 1 }));
  });
});

describe("composio.event over Composio's realtime channel (no public address)", () => {
  let fake: ReturnType<typeof fakeComposio>;
  let pusher: ReturnType<typeof fakePusher>;
  let h: PluginHarness;
  let gmailSub = "";
  let gmailTi = "";

  beforeAll(async () => {
    fake = fakeComposio();
    pusher = fakePusher();
    const api = await fake.listen();
    await pusher.ready;
    h = await start(api, { pusher: pusher.url() });
  });

  afterAll(async () => {
    await h?.stop();
    pusher?.close();
    fake?.server.close();
  });

  it("subscribes by upserting the trigger instance on the app's account with its config, leases it, and opens the channel", async () => {
    gmailSub = await h.subscribeSignal("event", { trigger: GMAIL, config: { labelIds: "INBOX" } });
    expect(fake.upserts).toEqual([{ slug: GMAIL, body: { connected_account_id: "ca_gmail", trigger_config: { labelIds: "INBOX" } } }]);
    gmailTi = fake.instanceOf(GMAIL, "ca_gmail")!;
    // A new instance is enabled as it is made.
    expect(fake.patches).toEqual([]);
    expect(h.storage.get(`inst:${gmailTi}`)).toEqual({ holder: expect.any(String), config: '{"labelIds":"INBOX"}', at: expect.any(Number), trigger: GMAIL, account: "ca_gmail" });
    const sock = await until(() => pusher.live()[0], "the subscribed channel");
    expect(sock.url).toBe("/app/pk_test?protocol=7&client=js&version=8.4.0&flash=false");
    expect(sock.channel).toBe("private-pr_1_triggers");
    expect(fake.auths).toEqual([{ socket: sock.socketId, channel: "private-pr_1_triggers" }]);
    // No webhook without a public address.
    expect(fake.webhooks).toEqual([]);
  });

  it("emits an event the channel brings, keyed by its log id, with the app's data, the trigger, app and account", async () => {
    pusher.push("trigger_to_client", message(gmailTi, "msg_1", { subject: "Lunch on\nFriday?", sender: "aigerim@example.com", messageText: "At noon?" }));
    const s = await until(() => h.signals[0], "the signal");
    expect(s).toEqual({
      type: "event",
      subscription: gmailSub,
      key: "log_msg_1",
      subject: "Lunch on Friday?",
      data: { subject: "Lunch on\nFriday?", sender: "aigerim@example.com", messageText: "At noon?", trigger: GMAIL, app: "gmail", account: "ca_gmail" },
    });
  });

  it("emits an event once, however often it comes", async () => {
    pusher.push("trigger_to_client", message(gmailTi, "msg_1", { subject: "Lunch on Friday?" }));
    pusher.push("trigger_to_client", message(gmailTi, "msg_2", { title: "Second" }));
    await until(() => h.signals.length >= 2, "the second event");
    await settle();
    expect(h.signals.map((s) => [s.key, s.subject])).toEqual([["log_msg_1", "Lunch on Friday?"], ["log_msg_2", "Second"]]);
  });

  it("puts a chunked event back together, whatever order its chunks come in, within its limits", async () => {
    const text = JSON.stringify(message(gmailTi, "msg_big", { subject: "Big one", body: "x".repeat(5000) }));
    const parts = [text.slice(0, 2000), text.slice(2000, 4000), text.slice(4000)];
    pusher.push("chunked-trigger_to_client", { id: "chunk_1", index: 2, chunk: parts[2], final: true });
    pusher.push("chunked-trigger_to_client", { id: "chunk_1", index: 0, chunk: parts[0], final: false });
    await settle(100);
    expect(h.signals).toHaveLength(2);
    pusher.push("chunked-trigger_to_client", { id: "chunk_1", index: 1, chunk: parts[1], final: false });
    const s = await until(() => h.signals[2], "the chunked event");
    expect(s).toMatchObject({ key: "log_msg_big", subject: "Big one", subscription: gmailSub, data: { body: "x".repeat(5000), trigger: GMAIL } });
    // A chunk that is not one, an event over 300 KB in chunks, and a frame over 1 MB are left out; the channel goes on.
    pusher.push("chunked-trigger_to_client", { id: "chunk_2", chunk: "{" });
    pusher.push("chunked-trigger_to_client", { id: "chunk_3", index: 0, chunk: "y".repeat(160 * 1024), final: false });
    pusher.push("chunked-trigger_to_client", { id: "chunk_3", index: 1, chunk: "y".repeat(160 * 1024), final: true });
    pusher.push("trigger_to_client", "z".repeat(1100 * 1024));
    await until(() => h.logs.some((l) => l.includes("over 1024 KB")), "the frame left out");
    const logs = h.logs.join("\n");
    expect(logs).toContain("invalid chunked");
    expect(logs).toContain("over 300 KB");
    pusher.push("trigger_to_client", message(gmailTi, "msg_after_big", { subject: "Still here" }));
    await until(() => h.signals.some((x) => x.key === "log_msg_after_big"), "an event after the big ones");
  });

  it("routes each event by its trigger instance to the subscription that made it, and drops the others", async () => {
    const slackSub = await h.subscribeSignal("event", { trigger: SLACK, app: "slack" });
    const slackTi = fake.instanceOf(SLACK, "ca_slack")!;
    expect(slackTi).not.toBe(gmailTi);
    const before = h.signals.length;
    pusher.push("trigger_to_client", message(slackTi, "msg_s1", { text: "hello from #general", channel: "C1" }, SLACK, "ca_slack"));
    pusher.push("trigger_to_client", message("ti_somebody_else", "msg_x", { text: "not ours" }));
    await until(() => h.signals.length > before, "the slack event");
    await settle();
    expect(h.signals.slice(before)).toEqual([
      { type: "event", subscription: slackSub, key: "log_msg_s1", subject: "hello from #general", data: { text: "hello from #general", channel: "C1", trigger: SLACK, app: "slack", account: "ca_slack" } },
    ]);
    await h.stopSignal(slackSub);
    // Disabled only after the grace (3 minutes; 1.2 s here), and its lease is gone with it.
    await settle(300);
    expect(fake.patches.some((p) => p.id === slackTi)).toBe(false);
    expect(h.storage.get(`inst:${slackTi}`)).toMatchObject({ released: true });
    await until(() => fake.patches.some((p) => p.id === slackTi && p.status === "disable"), "slack's instance disabled");
    await until(() => !h.storage.has(`inst:${slackTi}`), "slack's lease forgotten");
  });

  it("answers the channel's ping", async () => {
    const sock = pusher.live()[0]!;
    sock.ws.send(JSON.stringify({ event: "pusher:ping", data: {} }));
    await until(() => sock.frames.some((f) => f.event === "pusher:pong"), "the pong");
  });

  it("connects again when the socket drops, and goes on emitting", async () => {
    const first = pusher.live()[0]!;
    first.ws.terminate();
    const next = await until(() => pusher.live().find((s) => s !== first), "the new connection");
    expect(fake.auths.at(-1)).toEqual({ socket: next.socketId, channel: "private-pr_1_triggers" });
    const before = h.signals.length;
    pusher.push("trigger_to_client", message(gmailTi, "msg_after_drop", { subject: "Back" }));
    await until(() => h.signals.length > before, "the event after the drop");
    expect(h.signals.at(-1)).toMatchObject({ key: "log_msg_after_drop", subscription: gmailSub });
  });

  it("gives up on a connection that is never established (30 s; 200 ms here) and connects again", async () => {
    pusher.state.silent = true;
    const n = pusher.sockets.length;
    pusher.live()[0]!.ws.terminate();
    await until(() => pusher.sockets.length >= n + 2, "a silent connection given up and another tried");
    pusher.state.silent = false;
    await until(() => pusher.live().length === 1, "the channel back");
    expect(h.logs.join("\n")).toContain("did not answer in time");
  });

  it("refuses a second subscription to the same trigger and account with another config (Composio keeps one)", async () => {
    await expect(h.subscribeSignal("event", { trigger: GMAIL, config: { labelIds: "SPAM" } })).rejects.toThrow(/another config/);
    // The same one again shares the instance without asking Composio.
    const upserts = fake.upserts.length;
    const twin = await h.subscribeSignal("event", { trigger: GMAIL, app: "gmail", config: { labelIds: "INBOX" } });
    expect(fake.upserts).toHaveLength(upserts);
    await h.stopSignal(twin);
    await settle(1500);
    expect(fake.patches.filter((p) => p.id === gmailTi)).toEqual([]);
  });

  it("refuses an app that is not connected, or an account that is not one of the hub's", async () => {
    await expect(h.subscribeSignal("event", { trigger: "GITHUB_COMMIT_EVENT" })).rejects.toThrow(/not connected/);
    await expect(h.subscribeSignal("event", { trigger: GMAIL, account: "ca_stranger" })).rejects.toThrow(/not an account/);
  });

  it("keeps the instance on when it is subscribed again within the grace (a restart), without asking Composio", async () => {
    const upserts = fake.upserts.length;
    await h.stopSignal(gmailSub);
    gmailSub = await h.subscribeSignal("event", { trigger: GMAIL, config: { labelIds: "INBOX" } });
    await settle(1500);
    expect(fake.upserts).toHaveLength(upserts);
    expect(fake.patches.filter((p) => p.id === gmailTi)).toEqual([]);
    expect(h.storage.get(`inst:${gmailTi}`)).not.toHaveProperty("released");
  });

  it("disables the instance after the grace once nothing listens, closes the channel, and enables it on the next subscribe", async () => {
    await h.stopSignal(gmailSub);
    await until(() => !pusher.live().length, "the channel closed");
    await until(() => fake.patches.some((p) => p.id === gmailTi && p.status === "disable"), "gmail's instance disabled");
    const again = await h.subscribeSignal("event", { trigger: GMAIL, config: { labelIds: "INBOX" } });
    expect(fake.upserts.at(-1)).toEqual({ slug: GMAIL, body: { connected_account_id: "ca_gmail", trigger_config: { labelIds: "INBOX" } } });
    expect(fake.patches.at(-1)).toEqual({ id: gmailTi, status: "enable" });
    await until(() => pusher.live().length === 1, "the channel open again");
    await h.stopSignal(again);
  });

  it("lists the connected apps' trigger types with their config schemas, and says how the events come", async () => {
    const r = await h.invokeText("triggers", {});
    expect(r).toContain(`${GMAIL} — New Gmail message (Gmail; polled`);
    expect(r).toContain(`${SLACK} — Message received (Slack; instant`);
    expect(r).toContain('config: {"type":"object","properties":{"labelIds":{"type":"string"}');
    expect(r).toContain("composio.event");
    expect(r).toContain("no public https address");
    const only = await h.invokeText("triggers", { app: "composio:slack" });
    expect(only).toContain(SLACK);
    expect(only).not.toContain(GMAIL);
    expect(h.tools.get("triggers")).toMatchObject({ effect: "read", source: true });
    expect(h.tools.get("triggers")!.description).toMatch(/2 minutes/);
  });
});

describe("composio.event by webhook (a public https address)", () => {
  let fake: ReturnType<typeof fakeComposio>;
  let pusher: ReturnType<typeof fakePusher>;
  let h: PluginHarness;
  let sub = "";
  let ti = "";
  let publicUrl = HUB;
  const door = frontDoor();

  beforeAll(async () => {
    fake = fakeComposio();
    pusher = fakePusher();
    const api = await fake.listen();
    await pusher.ready;
    h = await start(api, { publicUrl: () => publicUrl, pusher: pusher.url(), door });
  });

  afterAll(async () => {
    await h?.stop();
    pusher?.close();
    fake?.server.close();
    door.server.close();
  });

  it("answers its own ping on the public route with the nonce it made at start", async () => {
    const r = await h.http({ method: "GET", path: "/ping", public: true });
    expect(r).toMatchObject({ status: 200, body: { ok: true, nonce: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
    expect((await h.http({ method: "GET", path: "/ping", public: true })).body).toEqual(r.body);
    expect((await h.http({ method: "GET", path: "/ping" })).status).toBe(404);
  });

  it("checks that its public address reaches it, then registers the project's webhook once there and keeps its secret in storage only", async () => {
    sub = await h.subscribeSignal("event", { trigger: GMAIL });
    ti = fake.instanceOf(GMAIL, "ca_gmail")!;
    expect(door.state.hits).toEqual(["GET /hooks/composio/ping"]);
    expect(fake.webhooks).toEqual([{ webhook_url: HOOK, enabled_events: ["composio.trigger.message"], version: "V3" }]);
    expect(h.storage.get("webhook")).toEqual({ id: "whs_1", url: HOOK, secret: SECRET });
    const other = await h.subscribeSignal("event", { trigger: SLACK });
    expect(fake.webhooks).toHaveLength(1);
    await h.stopSignal(other);
  });

  it("keeps the realtime channel open as a safety net until the first signed webhook arrives", async () => {
    await until(() => pusher.live().length === 1, "the safety-net channel");
  });

  it("takes an event with a good signature, keyed by its log id, and closes the safety net", async () => {
    const raw = JSON.stringify(message(ti, "msg_w1", { subject: "Invoice", sender: "billing@example.com" }));
    expect((await post(h, raw)).status).toBe(200);
    const s = await until(() => h.signals[0], "the signal");
    expect(s).toEqual({ type: "event", subscription: sub, key: "log_msg_w1", subject: "Invoice", data: { subject: "Invoice", sender: "billing@example.com", trigger: GMAIL, app: "gmail", account: "ca_gmail" } });
    await until(() => !pusher.open().length, "the safety net closed");
    // Composio's retry of the same message is answered and not emitted again.
    expect((await post(h, raw)).status).toBe(200);
    await settle();
    expect(h.signals).toHaveLength(1);
    // Another subscription does not open the channel again.
    const other = await h.subscribeSignal("event", { trigger: SLACK });
    await settle(300);
    expect(pusher.open()).toHaveLength(0);
    await h.stopSignal(other);
  });

  it("finds the good one among several signatures", async () => {
    const raw = JSON.stringify(message(ti, "msg_w2", { title: "Rotated" }));
    const ts = nowS();
    const header = `v1,${sign("msg_w2", ts, raw, "old-secret")} v1,${sign("msg_w2", ts, raw)}`;
    expect((await post(h, raw, { "webhook-id": "msg_w2", "webhook-timestamp": String(ts), "webhook-signature": header })).status).toBe(200);
    await until(() => h.signals.length === 2, "the second signal");
  });

  it("refuses a bad or bare signature, a changed body, a stale or missing timestamp, and a request without its raw body", async () => {
    const raw = JSON.stringify(message(ti, "msg_bad", { subject: "Forged" }));
    const ts = nowS();
    const good = sign("msg_bad", ts, raw);
    const tries = [
      await post(h, raw, { "webhook-id": "msg_bad", "webhook-timestamp": String(ts), "webhook-signature": `v1,${sign("msg_bad", ts, raw, "wrong")}` }),
      await post(h, raw, { "webhook-id": "msg_bad", "webhook-timestamp": String(ts), "webhook-signature": good }),
      await post(h, raw.replace("Forged", "Forgee"), { "webhook-id": "msg_bad", "webhook-timestamp": String(ts), "webhook-signature": `v1,${good}` }),
      await post(h, raw, { "webhook-id": "msg_bad", "webhook-timestamp": String(ts - 301), "webhook-signature": `v1,${sign("msg_bad", ts - 301, raw)}` }),
      await post(h, raw, { "webhook-id": "msg_bad", "webhook-signature": `v1,${good}` }),
      await h.http({ method: "POST", path: "/events", public: true, headers: { "webhook-id": "msg_bad", "webhook-timestamp": String(ts), "webhook-signature": `v1,${good}` }, body: JSON.parse(raw) }),
    ];
    expect(tries.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 400]);
    await settle();
    expect(h.signals.some((s) => s.key === "log_msg_bad")).toBe(false);
    // Only public requests to /events are webhooks.
    expect((await h.http({ method: "GET", path: "/events" })).status).toBe(404);
  });

  it("checks the kept webhook when the first subscription comes, and registers again when it is gone", async () => {
    await h.stopSignal(sub);
    fake.subs.splice(0);
    sub = await h.subscribeSignal("event", { trigger: GMAIL });
    expect(fake.paths).toContain("GET /api/v3.1/webhook_subscriptions/whs_1");
    expect(fake.webhooks).toHaveLength(2);
    expect(h.storage.get("webhook")).toEqual({ id: "whs_2", url: HOOK, secret: SECRET });
    // The same address is not checked again.
    expect(door.state.hits).toHaveLength(1);
  });

  it("checks again when the hub's public address changes, and points the hub's own webhook there", async () => {
    await h.stopSignal(sub);
    publicUrl = "https://hub2.example.com";
    sub = await h.subscribeSignal("event", { trigger: GMAIL });
    expect(door.state.hits).toHaveLength(2);
    expect(h.storage.get("webhook")).toEqual({ id: "whs_2", url: "https://hub2.example.com/hooks/composio/events", secret: SECRET });
    expect(fake.subs.map((s) => s.webhook_url)).toEqual(["https://hub2.example.com/hooks/composio/events"]);
  });

  it("never writes the secret to its log", () => {
    expect(h.logs.join("\n")).not.toContain(SECRET);
  });
});

for (const [mode, why] of [
  ["404", /does not reach its webhooks: it answers HTTP 404 there \(the Access from anywhere link does not carry webhooks\)/],
  ["stranger", /does not reach its webhooks: something answers there, but not this hub/],
] as const) {
  describe(`a public address that ${mode === "404" ? "answers 404 for the hub's webhooks" : "another server answers"}`, () => {
    let fake: ReturnType<typeof fakeComposio>;
    let pusher: ReturnType<typeof fakePusher>;
    let h: PluginHarness;
    const door = frontDoor();
    door.state.mode = mode;

    beforeAll(async () => {
      fake = fakeComposio();
      pusher = fakePusher();
      const api = await fake.listen();
      await pusher.ready;
      h = await start(api, { publicUrl: HUB, pusher: pusher.url(), door });
    });

    afterAll(async () => {
      await h?.stop();
      pusher?.close();
      fake?.server.close();
      door.server.close();
    });

    it("registers no webhook, uses the realtime channel, and says why in the log and in composio_triggers", async () => {
      const id = await h.subscribeSignal("event", { trigger: GMAIL });
      await until(() => pusher.live().length === 1, "the realtime channel");
      expect(door.state.hits).toEqual(["GET /hooks/composio/ping"]);
      expect(fake.webhooks).toEqual([]);
      expect(fake.paths.filter((p) => p.includes("webhook_subscriptions"))).toEqual([]);
      expect(h.logs.some((l) => why.test(l))).toBe(true);
      expect(await h.invokeText("triggers", {})).toMatch(/public address does not reach its webhooks.*realtime channel/);
      pusher.push("trigger_to_client", message(fake.instanceOf(GMAIL, "ca_gmail")!, "msg_rt", { subject: "Over the channel" }));
      await until(() => h.signals.find((s) => s.subscription === id), "the event over the channel");
    });
  });
}

describe("a webhook the person set up in their Composio project", () => {
  let fake: ReturnType<typeof fakeComposio>;
  let pusher: ReturnType<typeof fakePusher>;
  let h: PluginHarness;
  const door = frontDoor();

  beforeAll(async () => {
    fake = fakeComposio();
    fake.subs.push({ id: "whs_theirs", webhook_url: "https://their.example/composio", enabled_events: ["composio.connected_account.expired"], secret: "theirs" });
    pusher = fakePusher();
    const api = await fake.listen();
    await pusher.ready;
    h = await start(api, { publicUrl: HUB, pusher: pusher.url(), door });
  });

  afterAll(async () => {
    await h?.stop();
    pusher?.close();
    fake?.server.close();
    door.server.close();
  });

  it("is left alone: the events come over the realtime channel, the log names where theirs goes, composio_triggers says so", async () => {
    expect(await h.invokeText("triggers", {})).toContain("their.example");
    const id = await h.subscribeSignal("event", { trigger: GMAIL });
    await until(() => pusher.live().length === 1, "the realtime channel");
    expect(fake.paths.filter((p) => p.startsWith("PATCH /api/v3.1/webhook_subscriptions"))).toEqual([]);
    expect(fake.subs).toEqual([{ id: "whs_theirs", webhook_url: "https://their.example/composio", enabled_events: ["composio.connected_account.expired"], secret: "theirs" }]);
    expect(h.storage.has("webhook")).toBe(false);
    expect(h.logs.some((l) => l.includes("their.example") && l.includes("leaves it alone"))).toBe(true);
    const r = await h.invokeText("triggers", {});
    expect(r).toContain("their.example");
    expect(r).toContain("realtime channel");
    pusher.push("trigger_to_client", message(fake.instanceOf(GMAIL, "ca_gmail")!, "msg_rt", { subject: "Over the channel" }));
    await until(() => h.signals.find((s) => s.subscription === id), "the event over the channel");
  });
});

describe("two hub processes on one instance (a restart or a handover)", () => {
  let fake: ReturnType<typeof fakeComposio>;
  let pusher: ReturnType<typeof fakePusher>;
  let a: PluginHarness;
  let b: PluginHarness;
  let api = "";
  const storage = signedIn();

  beforeAll(async () => {
    fake = fakeComposio();
    pusher = fakePusher();
    api = await fake.listen();
    await pusher.ready;
    // One storage for both: plugin storage replicates between the hub's computers.
    [a, b] = await Promise.all([start(api, { storage, pusher: pusher.url(), minuteMs: 200 }), start(api, { storage, pusher: pusher.url(), minuteMs: 200 })]);
  });

  afterAll(async () => {
    await Promise.all([a?.stop(), b?.stop()]);
    pusher?.close();
    fake?.server.close();
  });

  it("leaves the instance on when the old holder's grace ends while the new holder's lease is fresh", async () => {
    const idA = await a.subscribeSignal("event", { trigger: GMAIL });
    const ti = fake.instanceOf(GMAIL, "ca_gmail")!;
    const leaseA = (storage.get(`inst:${ti}`) as any).holder;
    const idB = await b.subscribeSignal("event", { trigger: GMAIL });
    const leaseB = (storage.get(`inst:${ti}`) as any).holder;
    expect(leaseB).not.toBe(leaseA);
    // While both hold it, the old holder's refresh does not take it back.
    await settle(500);
    expect((storage.get(`inst:${ti}`) as any).holder).toBe(leaseB);
    await a.stopSignal(idA);
    // Past the grace (600 ms here) and well past it.
    await settle(1500);
    expect(fake.patches.filter((p) => p.id === ti && p.status === "disable")).toEqual([]);
    expect(a.logs.join("\n")).toContain("held by another hub process");
    expect((storage.get(`inst:${ti}`) as any).holder).toBe(leaseB);
    // The new holder's own stop disables it after its grace.
    await b.stopSignal(idB);
    await until(() => fake.patches.some((p) => p.id === ti && p.status === "disable"), "the instance disabled by its last holder");
    await until(() => !storage.has(`inst:${ti}`), "its lease forgotten");
  });

  it("disables nothing when the plugin stops: the next process takes the instance over", async () => {
    const c = await start(api, { storage, pusher: pusher.url(), minuteMs: 200 });
    await c.subscribeSignal("event", { trigger: SLACK });
    const ti = fake.instanceOf(SLACK, "ca_slack")!;
    await c.stop();
    await settle(1500);
    expect(fake.patches.filter((p) => p.id === ti)).toEqual([]);
    expect(storage.get(`inst:${ti}`)).toMatchObject({ trigger: SLACK, account: "ca_slack" });
  });
});

describe("the reconcile", () => {
  let fake: ReturnType<typeof fakeComposio>;
  let h: PluginHarness;
  let keepFresh: ReturnType<typeof setInterval>;
  const old = Date.now() - 600_000;
  const storage = signedIn([
    ["inst:ti_orphan", { holder: "a-process-gone", config: "{}", at: old, trigger: GMAIL, account: "ca_gmail", released: true }],
    ["inst:ti_off", { holder: "a-process-gone", config: "{}", at: old, trigger: SLACK, account: "ca_slack" }],
    ["inst:ti_elsewhere", { holder: "another-hub", config: "{}", at: Date.now(), trigger: GMAIL, account: "ca_other" }],
  ]);

  beforeAll(async () => {
    fake = fakeComposio();
    fake.on.add("ti_orphan");
    fake.on.add("ti_elsewhere");
    // Another process keeps its lease fresh.
    keepFresh = setInterval(() => storage.set("inst:ti_elsewhere", { ...(storage.get("inst:ti_elsewhere") as object), at: Date.now() }), 50);
    h = await start(await fake.listen(), { storage, minuteMs: 200 });
  });

  afterAll(async () => {
    clearInterval(keepFresh);
    await h?.stop();
    fake?.server.close();
  });

  it("disables the hub's instances that nothing holds and whose lease ran out, even with no subscription, and forgets them", async () => {
    await until(() => fake.patches.some((p) => p.id === "ti_orphan" && p.status === "disable"), "the orphan disabled", 5000);
    await until(() => !storage.has("inst:ti_orphan") && !storage.has("inst:ti_off"), "the stale leases forgotten");
    // Composio confirmed which were still on: the one already off is not touched, the one held elsewhere is kept.
    expect(fake.actives).toEqual(["ti_orphan,ti_off"]);
    expect(fake.patches).toEqual([{ id: "ti_orphan", status: "disable" }]);
    expect(storage.has("inst:ti_elsewhere")).toBe(true);
  });
});

describe("the warm-up after a start", () => {
  let fake: ReturnType<typeof fakeComposio>;
  let h: PluginHarness;
  let release!: () => void;
  const door = frontDoor();
  const storage = signedIn([
    ["webhook", { id: "whs_1", url: HOOK, secret: SECRET }],
    // The instance this hub made for a trigger before it restarted (the fake makes ti_1 first).
    ["inst:ti_1", { holder: "the-process-before", config: "{}", at: Date.now() - 1000, trigger: GMAIL, account: "ca_gmail", released: true }],
  ]);

  beforeAll(async () => {
    fake = fakeComposio();
    fake.subs.push({ id: "whs_1", webhook_url: HOOK, enabled_events: ["composio.trigger.message"], secret: SECRET });
    // The first account check waits: the plugin is still warming up.
    fake.state.hold = new Promise<void>((r) => (release = r));
    h = await start(await fake.listen(), { storage, publicUrl: HUB, minuteMs: 1000, door });
  });

  afterAll(async () => {
    release?.();
    await h?.stop();
    fake?.server.close();
    door.server.close();
  });

  it("answers 503 for one of the hub's instances not held yet, 200 for others, then delivers once it is held", async () => {
    const known = JSON.stringify(message("ti_1", "msg_early", { subject: "Early" }));
    const r = await post(h, known);
    expect(r).toMatchObject({ status: 503, headers: { "retry-after": "60" } });
    expect((await post(h, JSON.stringify(message("ti_unknown", "msg_u", { subject: "Not ours" })))).status).toBe(200);
    // The trigger subscribes again: Composio's retry is delivered.
    const id = await h.subscribeSignal("event", { trigger: GMAIL });
    expect(fake.instanceOf(GMAIL, "ca_gmail")).toBe("ti_1");
    expect((await post(h, known)).status).toBe(200);
    expect(h.signals).toEqual([expect.objectContaining({ subscription: id, key: "log_msg_early" })]);
    await h.stopSignal(id);
  });

  it("answers 200 once warmed up (the first account check done), the instance held or not", async () => {
    release();
    const t0 = Date.now();
    let status = 0;
    while (Date.now() - t0 < 8000) {
      status = (await post(h, JSON.stringify(message("ti_1", `msg_late_${Date.now()}`, { subject: "Late" })))).status!;
      if (status === 200) break;
      await settle(100);
    }
    expect(status).toBe(200);
  });
});

describe("an app's account changes", () => {
  let fake: ReturnType<typeof fakeComposio>;
  let h: PluginHarness;
  let id = "";
  const door = frontDoor();

  beforeAll(async () => {
    fake = fakeComposio();
    fake.subs.push({ id: "whs_1", webhook_url: HOOK, enabled_events: ["composio.trigger.message"], secret: SECRET });
    h = await start(await fake.listen(), { storage: signedIn([["webhook", { id: "whs_1", url: HOOK, secret: SECRET }]]), publicUrl: HUB, minuteMs: 200, door });
  });

  afterAll(async () => {
    await h?.stop();
    fake?.server.close();
    door.server.close();
  });

  it("moves its subscriptions to the new account when the app signs in again", async () => {
    id = await h.subscribeSignal("event", { trigger: GMAIL, config: { labelIds: "INBOX" } });
    const oldTi = fake.instanceOf(GMAIL, "ca_gmail")!;
    await h.catalogSignIn("gmail");
    const newAccount = [...fake.accounts.keys()].find((k) => k.startsWith("ca_gmail_"))!;
    fake.accounts.set(newAccount, "ACTIVE");
    const newTi = await until(() => fake.instanceOf(GMAIL, newAccount), "the instance on the new account");
    expect(fake.upserts.at(-1)).toEqual({ slug: GMAIL, body: { connected_account_id: newAccount, trigger_config: { labelIds: "INBOX" } } });
    expect((await post(h, JSON.stringify(message(newTi, "msg_new", { subject: "To the new account" }, GMAIL, newAccount)))).status).toBe(200);
    await until(() => h.signals.find((s) => s.key === "log_msg_new"), "the event on the new account");
    expect(h.signals.find((s) => s.key === "log_msg_new")).toMatchObject({ subscription: id, data: { account: newAccount } });
    // The old instance goes after its grace.
    await until(() => fake.patches.some((p) => p.id === oldTi && p.status === "disable"), "the old instance disabled");
    expect(h.signalFailures).toEqual([]);
  });

  it("fails its subscriptions when the app signs out, so the hub tries them again later", async () => {
    await h.catalogSignOut("gmail");
    const f = await until(() => h.signalFailures.find((x) => x.id === id), "the failure told to the hub");
    expect(f.error).toMatch(/no longer connected/);
  });
});
