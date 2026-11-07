// composio.event, the apps' events as trigger signals, against a fake Composio and a fake Pusher (a local `ws` server
// speaking the few frames Composio's realtime channel uses). A subscription upserts a trigger instance on the app's
// account with its config; stop disables it and the next subscribe enables it again. Without a public https address
// the events come over the realtime channel (credentials, private-channel auth, trigger_to_client and its chunked
// form, ping, reconnect); with one, over a project webhook registered once and checked by its signature. Either way an
// event goes to the subscription whose instance it names, once, keyed by its id. composio_triggers lists the types.
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

function fakeComposio() {
  const upserts: Array<{ slug: string; body: any }> = [];
  const patches: Array<{ id: string; status: string }> = [];
  const webhooks: any[] = [];
  const auths: Array<{ socket: string | null; channel: string | null }> = [];
  const paths: string[] = [];
  const instances = new Map<string, string>();
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const u = new URL(req.url!, "http://x");
      const json = raw && String(req.headers["content-type"]).startsWith("application/json") ? JSON.parse(raw) : undefined;
      const send = (status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
      if (req.headers["x-api-key"] !== "good") return send(401, { error: { message: "Invalid API key" } });
      const p = u.pathname;
      paths.push(`${req.method} ${p}`);
      let m: RegExpExecArray | null;
      if (req.method === "GET" && (m = /^\/api\/v3\.1\/connected_accounts\/(ca_(\w+))$/.exec(p))) return send(200, { id: m[1], status: "ACTIVE", toolkit: { slug: m[2] } });
      if (req.method === "GET" && p === "/api/v3.1/tools") return send(200, { items: [] });
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
        return send(created ? 201 : 200, { trigger_id: instances.get(pair), type: "poll", fallback_reason: null, polling_interval: 2 });
      }
      if (req.method === "PATCH" && (m = /^\/api\/v3\.1\/trigger_instances\/manage\/(\w+)$/.exec(p))) {
        patches.push({ id: m[1]!, status: json.status });
        return send(200, { status: "success" });
      }
      if (req.method === "POST" && p === "/api/v3.1/webhook_subscriptions") {
        webhooks.push(json);
        return send(201, { id: "whs_1", webhook_url: json.webhook_url, secret: SECRET, enabled_events: json.enabled_events });
      }
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
  return { server, upserts, patches, webhooks, auths, paths, instanceOf };
}

/** Pusher's side of the few frames used: connection, private-channel subscribe (checked against the auth), ping. */
function fakePusher() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  type Sock = { ws: WsSocket; url: string; socketId: string; channel?: string; frames: any[] };
  const sockets: Sock[] = [];
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
    ws.send(JSON.stringify({ event: "pusher:connection_established", data: JSON.stringify({ socket_id: s.socketId, activity_timeout: 120 }) }));
  });
  const live = () => sockets.filter((s) => s.channel && s.ws.readyState === 1);
  const push = (event: string, data: unknown) => {
    for (const s of live()) s.ws.send(JSON.stringify({ event, channel: s.channel, data: typeof data === "string" ? data : JSON.stringify(data) }));
  };
  return { wss, sockets, live, push, port: () => (wss.address() as AddressInfo).port };
}

/** A V3 trigger message, as Composio sends it by webhook and over the channel. */
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

/** The plugin with Gmail and Slack signed in already (as its storage keeps them) and the key in the vault. */
function signedIn(): Map<string, unknown> {
  return new Map<string, unknown>([
    ["userId", "piomio-test"],
    ["apps", { gmail: { accountId: "ca_gmail", status: "ACTIVE" }, slack: { accountId: "ca_slack", status: "ACTIVE" } }],
  ]);
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
  it("reads Composio's V3, V2 and V1 envelopes and the SDK's oldest form", () => {
    expect(incoming(message("ti_1", "msg_1", { subject: "Hi" }))).toEqual({ instances: ["ti_1"], id: "msg_1", trigger: GMAIL, account: "ca_gmail", data: { subject: "Hi" } });
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

  it("takes only a public https address for a webhook", () => {
    expect(isPublicHttps("https://hub.example.com")).toBe(true);
    expect(isPublicHttps("https://piomio.tail1234.ts.net/")).toBe(true);
    for (const url of ["http://hub.example.com", "https://localhost:8080", "https://127.0.0.1", "https://[::1]", "https://192.168.1.5", "https://10.0.0.2", "https://100.101.1.1", "https://mac.local", "https://hub", "not a url", undefined]) {
      expect(isPublicHttps(url)).toBe(false);
    }
  });

  it("checks a signature's version and treats configs that say the same as the same", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", SECRET).update(`m.${ts}.{}`).digest("base64");
    const at = Date.now();
    expect(signatureProblem({ "Webhook-Id": "m", "Webhook-Timestamp": String(ts), "Webhook-Signature": `v1,${sig}` }, "{}", SECRET, at)).toBeUndefined();
    expect(signatureProblem({ "webhook-id": "m", "webhook-timestamp": String(ts), "webhook-signature": sig }, "{}", SECRET, at)).toBeUndefined();
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
    await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", r));
    pusher = fakePusher();
    await new Promise<void>((r) => pusher.wss.once("listening", () => r()));
    h = await startPlugin({
      dir,
      storage: signedIn(),
      vault: { composio: { value: "good" } },
      core: (method) => (method === "settings.get" ? { publicUrl: "http://localhost:8080" } : {}),
      env: {
        PIOMIO_COMPOSIO_API: `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}/api/v3.1`,
        PIOMIO_COMPOSIO_PUSHER: `ws://127.0.0.1:${pusher.port()}`,
        PIOMIO_COMPOSIO_RECONNECT_MS: "30",
      },
    });
  });

  afterAll(async () => {
    await h?.stop();
    for (const s of pusher?.sockets ?? []) s.ws.terminate();
    pusher?.wss.close();
    fake?.server.close();
  });

  it("subscribes by upserting the trigger instance on the app's account with its config, and opens the channel", async () => {
    gmailSub = await h.subscribeSignal("event", { trigger: GMAIL, config: { labelIds: "INBOX" } });
    expect(fake.upserts).toEqual([{ slug: GMAIL, body: { connected_account_id: "ca_gmail", trigger_config: { labelIds: "INBOX" } } }]);
    gmailTi = fake.instanceOf(GMAIL, "ca_gmail")!;
    // A new instance is enabled as it is made.
    expect(fake.patches).toEqual([]);
    const sock = await until(() => pusher.live()[0], "the subscribed channel");
    expect(sock.url).toBe("/app/pk_test?protocol=7&client=js&version=8.4.0&flash=false");
    expect(sock.channel).toBe("private-pr_1_triggers");
    expect(fake.auths).toEqual([{ socket: sock.socketId, channel: "private-pr_1_triggers" }]);
    // No webhook without a public address.
    expect(fake.webhooks).toEqual([]);
  });

  it("emits an event the channel brings, keyed by its id, with the app's data, the trigger, app and account", async () => {
    pusher.push("trigger_to_client", message(gmailTi, "msg_1", { subject: "Lunch on\nFriday?", sender: "aigerim@example.com", messageText: "At noon?" }));
    const s = await until(() => h.signals[0], "the signal");
    expect(s).toEqual({
      type: "event",
      subscription: gmailSub,
      key: "msg_1",
      subject: "Lunch on Friday?",
      data: { subject: "Lunch on\nFriday?", sender: "aigerim@example.com", messageText: "At noon?", trigger: GMAIL, app: "gmail", account: "ca_gmail" },
    });
  });

  it("emits an event once, however often it comes", async () => {
    pusher.push("trigger_to_client", message(gmailTi, "msg_1", { subject: "Lunch on Friday?" }));
    pusher.push("trigger_to_client", message(gmailTi, "msg_2", { title: "Second" }));
    await until(() => h.signals.length >= 2, "the second event");
    await settle();
    expect(h.signals.map((s) => [s.key, s.subject])).toEqual([["msg_1", "Lunch on Friday?"], ["msg_2", "Second"]]);
  });

  it("puts a chunked event back together, whatever order its chunks come in", async () => {
    const text = JSON.stringify(message(gmailTi, "msg_big", { subject: "Big one", body: "x".repeat(5000) }));
    const parts = [text.slice(0, 2000), text.slice(2000, 4000), text.slice(4000)];
    pusher.push("chunked-trigger_to_client", { id: "chunk_1", index: 2, chunk: parts[2], final: true });
    pusher.push("chunked-trigger_to_client", { id: "chunk_1", index: 0, chunk: parts[0], final: false });
    await settle(100);
    expect(h.signals).toHaveLength(2);
    pusher.push("chunked-trigger_to_client", { id: "chunk_1", index: 1, chunk: parts[1], final: false });
    const s = await until(() => h.signals[2], "the chunked event");
    expect(s).toMatchObject({ key: "msg_big", subject: "Big one", subscription: gmailSub, data: { body: "x".repeat(5000), trigger: GMAIL } });
    // A chunk that is not one is left out without breaking the channel.
    pusher.push("chunked-trigger_to_client", { id: "chunk_2", chunk: "{" });
    await settle(100);
    expect(h.logs.join("\n")).toContain("invalid chunked");
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
      { type: "event", subscription: slackSub, key: "msg_s1", subject: "hello from #general", data: { text: "hello from #general", channel: "C1", trigger: SLACK, app: "slack", account: "ca_slack" } },
    ]);
    await h.stopSignal(slackSub);
    await until(() => fake.patches.some((p) => p.id === slackTi && p.status === "disable"), "slack's instance disabled");
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
    expect(h.signals.at(-1)).toMatchObject({ key: "msg_after_drop", subscription: gmailSub });
  });

  it("refuses a second subscription to the same trigger and account with another config (Composio keeps one)", async () => {
    await expect(h.subscribeSignal("event", { trigger: GMAIL, config: { labelIds: "SPAM" } })).rejects.toThrow(/another config/);
    // The same one again shares the instance without asking Composio.
    const upserts = fake.upserts.length;
    const twin = await h.subscribeSignal("event", { trigger: GMAIL, app: "gmail", config: { labelIds: "INBOX" } });
    expect(fake.upserts).toHaveLength(upserts);
    await h.stopSignal(twin);
    await settle();
    expect(fake.patches.filter((p) => p.id === gmailTi)).toEqual([]);
  });

  it("refuses an app that is not connected, or an account that is not one of the hub's", async () => {
    await expect(h.subscribeSignal("event", { trigger: "GITHUB_COMMIT_EVENT" })).rejects.toThrow(/not connected/);
    await expect(h.subscribeSignal("event", { trigger: GMAIL, account: "ca_stranger" })).rejects.toThrow(/not an account/);
  });

  it("disables the instance on stop, enables it again on the next subscribe, and closes the channel when nothing listens", async () => {
    await h.stopSignal(gmailSub);
    await until(() => fake.patches.some((p) => p.id === gmailTi && p.status === "disable"), "gmail's instance disabled");
    await until(() => !pusher.live().length, "the channel closed");
    const again = await h.subscribeSignal("event", { trigger: GMAIL, config: { labelIds: "INBOX" } });
    expect(fake.upserts.at(-1)).toEqual({ slug: GMAIL, body: { connected_account_id: "ca_gmail", trigger_config: { labelIds: "INBOX" } } });
    expect(fake.patches.at(-1)).toEqual({ id: gmailTi, status: "enable" });
    await until(() => pusher.live().length === 1, "the channel open again");
    await h.stopSignal(again);
  });

  it("lists the connected apps' trigger types with their config schemas", async () => {
    const r = await h.invokeText("triggers", {});
    expect(r).toContain(`${GMAIL} — New Gmail message (Gmail; polled`);
    expect(r).toContain(`${SLACK} — Message received (Slack; instant`);
    expect(r).toContain('config: {"type":"object","properties":{"labelIds":{"type":"string"}');
    expect(r).toContain("composio.event");
    const only = await h.invokeText("triggers", { app: "composio:slack" });
    expect(only).toContain(SLACK);
    expect(only).not.toContain(GMAIL);
    expect(h.tools.get("triggers")).toMatchObject({ effect: "read", source: true });
    expect(h.tools.get("triggers")!.description).toMatch(/2 minutes/);
  });
});

describe("composio.event by webhook (a public https address)", () => {
  let fake: ReturnType<typeof fakeComposio>;
  let h: PluginHarness;
  let sub = "";
  let ti = "";
  const now = () => Math.floor(Date.now() / 1000);
  const sign = (id: string, ts: number, body: string, secret = SECRET) => createHmac("sha256", Buffer.from(secret, "utf8")).update(`${id}.${ts}.${body}`).digest("base64");
  /** The hub's public webhook request, with the body exactly as it came. */
  const post = (raw: string, headers: Record<string, string>) => {
    const req = { method: "POST", path: "/events", public: true, headers: { "content-type": "application/json", ...headers }, body: JSON.parse(raw), rawBody: raw };
    return h.http(req);
  };

  beforeAll(async () => {
    fake = fakeComposio();
    await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", r));
    h = await startPlugin({
      dir,
      storage: signedIn(),
      vault: { composio: { value: "good" } },
      core: (method) => (method === "settings.get" ? { publicUrl: "https://hub.example.com" } : {}),
      env: { PIOMIO_COMPOSIO_API: `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}/api/v3.1`, PIOMIO_COMPOSIO_PUSHER: "ws://127.0.0.1:1" },
    });
  });

  afterAll(async () => {
    await h?.stop();
    fake?.server.close();
  });

  it("registers the project's webhook once, at the hub's public address, and keeps its secret in storage only", async () => {
    sub = await h.subscribeSignal("event", { trigger: GMAIL });
    ti = fake.instanceOf(GMAIL, "ca_gmail")!;
    expect(fake.webhooks).toEqual([{ webhook_url: "https://hub.example.com/hooks/composio/events", enabled_events: ["composio.trigger.message"], version: "V3" }]);
    expect(h.storage.get("webhook")).toEqual({ id: "whs_1", url: "https://hub.example.com/hooks/composio/events", secret: SECRET });
    const other = await h.subscribeSignal("event", { trigger: SLACK });
    expect(fake.webhooks).toHaveLength(1);
    await h.stopSignal(other);
    // The realtime channel is not used.
    expect(fake.paths.filter((p) => p.includes("/internal/sdk/realtime"))).toEqual([]);
  });

  it("takes an event with a good signature, keyed by its id", async () => {
    const raw = JSON.stringify(message(ti, "msg_w1", { subject: "Invoice", sender: "billing@example.com" }));
    const ts = now();
    const r = await post(raw, { "webhook-id": "msg_w1", "webhook-timestamp": String(ts), "webhook-signature": `v1,${sign("msg_w1", ts, raw)}` });
    expect(r.status).toBe(200);
    const s = await until(() => h.signals[0], "the signal");
    expect(s).toEqual({ type: "event", subscription: sub, key: "msg_w1", subject: "Invoice", data: { subject: "Invoice", sender: "billing@example.com", trigger: GMAIL, app: "gmail", account: "ca_gmail" } });
    // Composio's retry of the same message is answered and not emitted again.
    expect((await post(raw, { "webhook-id": "msg_w1", "webhook-timestamp": String(ts), "webhook-signature": `v1,${sign("msg_w1", ts, raw)}` })).status).toBe(200);
    await settle();
    expect(h.signals).toHaveLength(1);
  });

  it("finds the good one among several signatures", async () => {
    const raw = JSON.stringify(message(ti, "msg_w2", { title: "Rotated" }));
    const ts = now();
    const header = `v1,${sign("msg_w2", ts, raw, "old-secret")} v1,${sign("msg_w2", ts, raw)}`;
    expect((await post(raw, { "webhook-id": "msg_w2", "webhook-timestamp": String(ts), "webhook-signature": header })).status).toBe(200);
    await until(() => h.signals.length === 2, "the second signal");
  });

  it("refuses a bad signature, a changed body, a stale or missing timestamp, and a request without its raw body", async () => {
    const raw = JSON.stringify(message(ti, "msg_bad", { subject: "Forged" }));
    const ts = now();
    const good = sign("msg_bad", ts, raw);
    const tries = [
      await post(raw, { "webhook-id": "msg_bad", "webhook-timestamp": String(ts), "webhook-signature": `v1,${sign("msg_bad", ts, raw, "wrong")}` }),
      await post(raw.replace("Forged", "Forgee"), { "webhook-id": "msg_bad", "webhook-timestamp": String(ts), "webhook-signature": `v1,${good}` }),
      await post(raw, { "webhook-id": "msg_bad", "webhook-timestamp": String(ts - 301), "webhook-signature": `v1,${sign("msg_bad", ts - 301, raw)}` }),
      await post(raw, { "webhook-id": "msg_bad", "webhook-signature": `v1,${good}` }),
      await h.http({ method: "POST", path: "/events", public: true, headers: { "webhook-id": "msg_bad", "webhook-timestamp": String(ts), "webhook-signature": `v1,${good}` }, body: JSON.parse(raw) }),
    ];
    expect(tries.map((r) => r.status)).toEqual([401, 401, 401, 401, 400]);
    await settle();
    expect(h.signals.some((s) => s.key === "msg_bad")).toBe(false);
    // Only public requests to /events are webhooks.
    expect((await h.http({ method: "GET", path: "/events" })).status).toBe(404);
  });

  it("never writes the secret to its log", () => {
    expect(h.logs.join("\n")).not.toContain(SECRET);
  });
});
