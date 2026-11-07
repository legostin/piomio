// composio.event: the person's connected apps' events (a new Gmail message, a Slack message, a GitHub push…) as one
// subscribe-mode signal source. A subscription's config names a Composio trigger type, optionally the app and the
// account, and that type's own config:
//   { trigger: "GMAIL_NEW_GMAIL_MESSAGE", app?: "gmail", account?: "ca_…", config?: { … } }
//
// Subscribing upserts the trigger instance on the app's connected account (one per type and account at Composio:
// subscriptions with the same one share it, one with another config is refused) and enables it again when it was;
// when the last subscription on it stops, it is disabled. Events reach the hub one of two ways:
//   1. a project webhook at <publicUrl>/hooks/composio/events, when the hub has a public https address: registered
//      once, its secret kept in the plugin's storage (never in settings or logs), every request checked by its
//      Standard Webhooks signature over the raw body;
//   2. otherwise Composio's realtime channel (realtime.ts), which Composio calls internal.
// Either way an event goes, by the trigger instance it names, to the subscriptions on that instance, once (keyed by
// its id), with Composio's data plus { trigger, app, account }.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PluginContext, PluginHttpRequest, PluginHttpResponse, SignalEmitOptions, SignalProvider } from "@piomio/plugin-sdk";
import { ComposioError, type ComposioApi } from "./api.ts";
import { RealtimeChannel } from "./realtime.ts";

/** The webhook's path under /hooks/composio. */
export const WEBHOOK_PATH = "/events";
/** Signatures older (or newer) than this are refused, in seconds. */
export const TOLERANCE_S = 300;
/** As the hub's intake cap: an event's data bigger than this is not sent. */
const DATA_MAX = 256 * 1024;
const SUBJECT_MAX = 120;
/** Event ids remembered, so a retried or doubly delivered event is emitted once. */
const SEEN_MAX = 2000;
/** How long close() waits for the instances being disabled. */
const CLOSE_WAIT_MS = 2000;
const SLUG_RE = /^[A-Za-z0-9_]{1,128}$/;
const APP_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
/** Keys of a V2 event's data that are Composio's, not the app's. */
const V2_META = ["trigger_nano_id", "trigger_id", "connection_nano_id", "connection_id", "connected_account_id", "user_id", "log_id", "trigger_name"];

export interface TriggerDeps {
  ctx: PluginContext;
  api: () => ComposioApi;
  hasKey: () => Promise<boolean>;
  /** The connected (working) account of an app. */
  account: (app: string) => string | undefined;
  /** The apps in the catalog (the manifest's and those added from the chat). */
  apps: () => string[];
  nameOf: (app: string) => string;
  /** The realtime channel's address instead of Pusher's (tests only). */
  pusherBase?: string;
  /** The realtime channel's first reconnect pause (tests only). */
  reconnectMs?: number;
  now?: () => number;
}

/** One hub subscription, on one instance. */
interface Holder {
  trigger: string;
  app: string;
  emit: (data: unknown, o?: SignalEmitOptions) => void;
}

/** A trigger instance at Composio (one per type and account) and the subscriptions on it. */
interface Instance {
  /** Composio's ti_… id; unset until the first upsert answered. */
  id?: string;
  trigger: string;
  account: string;
  /** Its trigger_config, canonical. */
  config: string;
  holders: Map<string, Holder>;
}

/** An event, whatever version of Composio's envelope it came in. */
interface Incoming {
  /** Ids it may name its instance by (the ti_… one first). */
  instances: string[];
  id?: string;
  trigger?: string;
  account?: string;
  data: unknown;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** JSON with its object keys sorted: two configs that say the same are the same text. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObject(v))
    return `{${Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** A header's value, whatever its case. */
function header(headers: Record<string, unknown>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === name) return String(Array.isArray(v) ? v[0] : (v ?? ""));
  return undefined;
}

/**
 * A Standard Webhooks signature, as Composio signs: HMAC-SHA256 over "{webhook-id}.{webhook-timestamp}.{raw body}"
 * with the secret as UTF-8 bytes, base64; the header holds "v1,<signature>" entries separated by spaces (any one may
 * match), and a timestamp more than 300 s away is refused. Undefined when it holds, else why not.
 */
export function signatureProblem(headers: Record<string, unknown>, rawBody: string, secret: string, nowMs: number): string | undefined {
  const id = header(headers, "webhook-id");
  const ts = header(headers, "webhook-timestamp");
  const sig = header(headers, "webhook-signature");
  if (!id || !ts || !sig) return "missing signature headers";
  const t = Number(ts);
  if (!/^\d{1,12}$/.test(ts) || Math.abs(nowMs / 1000 - t) > TOLERANCE_S) return "stale or invalid timestamp";
  const expected = createHmac("sha256", Buffer.from(secret, "utf8")).update(`${id}.${ts}.${rawBody}`).digest();
  for (const entry of sig.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma >= 0 && entry.slice(0, comma) !== "v1") continue;
    const given = Buffer.from(comma >= 0 ? entry.slice(comma + 1) : entry, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return undefined;
  }
  return "invalid signature";
}

/** An event in V3 (what the webhook is registered for), V2 or V1 form; undefined when it is none. */
export function incoming(raw: unknown): Incoming | undefined {
  if (!isObject(raw)) return undefined;
  const meta = isObject(raw.metadata) ? raw.metadata : undefined;
  // V3: { id, type, metadata: { trigger_id, trigger_slug, connected_account_id, log_id… }, data, timestamp }.
  if (meta && str(meta.trigger_id)) {
    return { instances: [meta.trigger_id as string], id: str(raw.id) ?? str(meta.log_id), trigger: str(meta.trigger_slug), account: str(meta.connected_account_id), data: raw.data };
  }
  // V2: { type: "<trigger, lowercase>", data: { …, trigger_nano_id, trigger_id, connection_nano_id… }, log_id? }.
  if (isObject(raw.data) && (str(raw.data.trigger_nano_id) || str(raw.data.trigger_id)) && str(raw.type)) {
    const d = raw.data;
    const data = Object.fromEntries(Object.entries(d).filter(([k]) => !V2_META.includes(k)));
    const instances = [str(d.trigger_nano_id), str(d.trigger_id)].filter((x): x is string => !!x);
    return { instances, id: str(raw.id) ?? str(raw.log_id) ?? str(d.log_id), trigger: (raw.type as string).toUpperCase(), account: str(d.connection_nano_id) ?? str(d.connected_account_id), data };
  }
  // V1: { trigger_name, trigger_id, connection_id, payload, log_id }.
  if (str(raw.trigger_id) && str(raw.trigger_name)) {
    return { instances: [raw.trigger_id as string], id: str(raw.log_id) ?? str(raw.id), trigger: str(raw.trigger_name), account: str(raw.connection_id), data: raw.payload };
  }
  // The SDK's oldest form on the channel: { appName, payload, metadata: { id, nanoId, triggerName, connection: { id } } }.
  if (meta && str(raw.appName) && (str(meta.nanoId) || str(meta.id))) {
    const connection = isObject(meta.connection) ? meta.connection : {};
    const instances = [str(meta.nanoId), str(meta.id)].filter((x): x is string => !!x);
    return { instances, trigger: str(meta.triggerName), account: str(connection.connectedAccountNanoId) ?? str(connection.id), data: raw.payload };
  }
  return undefined;
}

/** The payload's obvious one-line summary (subject, title, text or name), at most 120 characters. */
export function subjectOf(data: unknown): string | undefined {
  if (!isObject(data)) return undefined;
  for (const k of ["subject", "title", "text", "name"]) {
    const v = data[k];
    if (typeof v !== "string") continue;
    const line = v.replace(/\s+/g, " ").trim();
    if (line) return line.slice(0, SUBJECT_MAX);
  }
  return undefined;
}

/** Whether Composio can reach this address: https on a public name, not loopback, a private range or a local name. */
export function isPublicHttps(url: string | undefined): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host.includes(".") || host.includes(":")) return false;
  if (/(^|\.)(localhost|local|internal|lan|home\.arpa)$/.test(host)) return false;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
  }
  return true;
}

/** What a subscription's config says, checked (the hub checked it against the declared schema too). */
function parseConfig(c: Record<string, unknown>): { trigger: string; app?: string; account?: string; config: Record<string, unknown> } {
  const trigger = String(c.trigger ?? "").trim().toUpperCase();
  if (!SLUG_RE.test(trigger)) throw new Error("composio.event: config.trigger must be a Composio trigger type, e.g. GMAIL_NEW_GMAIL_MESSAGE (see composio_triggers)");
  const app = c.app === undefined ? undefined : String(c.app).trim().toLowerCase().replace(/^composio:/, "");
  if (app !== undefined && !APP_RE.test(app)) throw new Error("composio.event: config.app must be an app's slug, e.g. gmail");
  const account = c.account === undefined ? undefined : String(c.account).trim();
  if (c.config !== undefined && !isObject(c.config)) throw new Error("composio.event: config.config must be an object (the trigger type's own config)");
  return { trigger, ...(app ? { app } : {}), ...(account ? { account } : {}), config: (c.config as Record<string, unknown> | undefined) ?? {} };
}

export interface ComposioTriggers {
  provider: SignalProvider;
  /** The plugin's HTTP: the webhook, at POST /hooks/composio/events. */
  http(req: PluginHttpRequest): Promise<PluginHttpResponse>;
  /** The plugin stops: the channel closes; instances being disabled are waited for a little. */
  close(): Promise<void>;
}

export function composioTriggers(d: TriggerDeps): ComposioTriggers {
  const { ctx } = d;
  const now = d.now ?? Date.now;
  /** Instances by "TRIGGER\0account", and by their Composio id. */
  const pairs = new Map<string, Instance>();
  const byId = new Map<string, Instance>();
  /** One upsert, enable or disable at a time per instance, in order. */
  const queues = new Map<string, Promise<unknown>>();
  const seen = new Set<string>();
  let address: Promise<string | undefined> | undefined;
  let mode: "webhook" | "realtime" | undefined;
  let webhook: Promise<void> | undefined;
  let secret: string | undefined;
  let closed = false;

  const realtime = new RealtimeChannel({
    credentials: () => d.api().realtimeCredentials(),
    auth: (socketId, channel) => d.api().realtimeAuth(socketId, channel),
    onEvent: (e) => accept(e),
    log: (level, msg) => ctx.log[level](msg),
    ...(d.pusherBase ? { base: d.pusherBase } : {}),
    ...(d.reconnectMs ? { reconnectMs: d.reconnectMs } : {}),
  });

  function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return run;
  }

  const holders = () => [...pairs.values()].reduce((n, i) => n + i.holders.size, 0);

  /** The webhook's address when the hub has a public https one (it does not change while the hub runs). */
  function webhookUrl(): Promise<string | undefined> {
    address ??= ctx.core.call<{ publicUrl?: string }>("settings.get").then(
      (s) => (isPublicHttps(s?.publicUrl) ? `${String(s.publicUrl).replace(/\/+$/, "")}/hooks/${ctx.pluginId}${WEBHOOK_PATH}` : undefined),
      () => undefined,
    );
    return address;
  }

  /** The project's webhook at this hub's address, registered once (and again when the address changed). */
  async function registerWebhook(url: string): Promise<void> {
    const kept = await ctx.storage.get<{ id: string; url: string; secret: string }>("webhook");
    if (kept?.url === url && kept.secret) {
      secret = kept.secret;
      return;
    }
    let sub = await d.api().createWebhookSubscription(url);
    if (!sub.secret) sub = await d.api().getWebhookSubscription(sub.id);
    if (!sub.secret) throw new ComposioError(502, "Composio gave no secret for the webhook subscription", "other");
    await ctx.storage.set("webhook", { id: sub.id, url, secret: sub.secret });
    secret = sub.secret;
    ctx.log.info(`composio: the apps' events come by webhook to ${url}`);
  }

  /**
   * How the events come: by webhook (registered here) when the hub has a public https address, else over the realtime
   * channel (opened once a subscription holds an instance).
   */
  async function delivery(): Promise<"webhook" | "realtime"> {
    if (mode) return mode;
    const url = await webhookUrl();
    if (!url) return (mode = "realtime");
    webhook ??= registerWebhook(url).catch((e) => {
      webhook = undefined;
      throw e;
    });
    try {
      await webhook;
      return (mode = "webhook");
    } catch (e) {
      // Composio refused the address itself: the realtime channel is the way left.
      if (!(e instanceof ComposioError && e.kind === "other")) throw e;
      ctx.log.warn(`composio: Composio did not take the webhook at the hub's public address (${e.message}); using its realtime channel instead`);
      return (mode = "realtime");
    }
  }

  /** The app a trigger type belongs to: the one named, else the app its slug starts with, else Composio's word. */
  async function appOf(trigger: string, app: string | undefined, account: string | undefined): Promise<string> {
    if (app) return app;
    if (account) {
      const owner = d.apps().find((a) => d.account(a) === account);
      if (owner) return owner;
    }
    const byPrefix = d
      .apps()
      .sort((x, y) => y.length - x.length)
      .find((a) => trigger.startsWith(`${a.toUpperCase()}_`));
    if (byPrefix) return byPrefix;
    try {
      const t = await d.api().getTriggerType(trigger);
      if (t.toolkit) return t.toolkit;
    } catch (e) {
      if (!(e instanceof ComposioError && e.status === 404)) throw e;
      throw new Error(`composio.event: Composio has no trigger type ${trigger} (see composio_triggers)`);
    }
    throw new Error(`composio.event: could not tell which app ${trigger} is for: give config.app`);
  }

  async function subscribe(id: string, raw: Record<string, unknown>, emit: Holder["emit"]): Promise<{ stop(): void }> {
    if (closed) throw new Error("composio.event: the plugin is stopping");
    const c = parseConfig(raw);
    if (!(await d.hasKey())) throw new Error("composio.event: Composio has no key yet (its card, hub_integration_connect id composio)");
    const app = await appOf(c.trigger, c.app, c.account);
    const own = d.account(app);
    if (!own) throw new Error(`composio.event: ${d.nameOf(app)} is not connected through Composio (sign in on its card, composio:${app})`);
    if (c.account && c.account !== own) throw new Error(`composio.event: ${c.account} is not an account of ${d.nameOf(app)} connected on this hub`);
    const account = own;
    const how = await delivery();
    const pair = `${c.trigger}\u0000${account}`;
    const config = canonical(c.config);
    await serial(pair, async () => {
      let inst = pairs.get(pair);
      if (inst?.holders.size) {
        if (inst.config !== config) throw new Error(`composio.event: ${c.trigger} on ${d.nameOf(app)}'s account is already listened to with another config (${inst.config}); Composio keeps one per account`);
        inst.holders.set(id, { trigger: c.trigger, app, emit });
        return;
      }
      const r = await d.api().upsertTriggerInstance(c.trigger, { connectedAccountId: account, config: c.config });
      // An instance that was there may be disabled (a subscription stopped): enabled again.
      if (!r.created) await d.api().setTriggerEnabled(r.id, true);
      if (r.fallbackReason) ctx.log.info(`composio: Composio polls ${c.trigger} instead of a webhook: ${r.fallbackReason}`);
      if (!inst) pairs.set(pair, (inst = { trigger: c.trigger, account, config, holders: new Map() }));
      if (inst.id && inst.id !== r.id) byId.delete(inst.id);
      inst.id = r.id;
      inst.config = config;
      byId.set(r.id, inst);
      inst.holders.set(id, { trigger: c.trigger, app, emit });
    });
    // Only now, with the holder in: a release meanwhile cannot close the channel under it.
    if (how === "realtime") realtime.start();
    return { stop: () => release(id, pair) };
  }

  /** A subscription stopped: its instance is disabled when nothing else listens to it, the channel closed when nothing does. */
  function release(id: string, pair: string): void {
    const inst = pairs.get(pair);
    if (!inst?.holders.delete(id)) return;
    if (!holders()) realtime.stop();
    if (inst.holders.size) return;
    void serial(pair, async () => {
      if (inst.holders.size || !inst.id) return;
      await d.api().setTriggerEnabled(inst.id, false);
    }).catch((e) => ctx.log.warn(`composio: could not disable ${inst.trigger}'s trigger ${inst.id}: ${message(e)}`));
  }

  /** An event from either way: to the subscriptions on the instance it names, once. */
  function accept(raw: unknown, fallbackId?: string): void {
    const ev = incoming(raw);
    if (!ev) return;
    const inst = ev.instances.map((i) => byId.get(i)).find((i) => i?.holders.size);
    if (!inst) return;
    const key = (ev.id ?? fallbackId ?? createHash("sha256").update(canonical(raw)).digest("hex").slice(0, 32)).slice(0, 200);
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value!);
    const first = inst.holders.values().next().value!;
    const data = { ...(isObject(ev.data) ? ev.data : ev.data === undefined ? {} : { data: ev.data }), trigger: first.trigger, app: first.app, account: inst.account };
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(data));
    } catch {
      return;
    }
    if (size > DATA_MAX) {
      ctx.log.warn(`composio: event ${key} of ${first.trigger} is over ${DATA_MAX / 1024} KB: not delivered`);
      return;
    }
    const subject = subjectOf(ev.data);
    for (const h of inst.holders.values()) h.emit(data, { key, ...(subject ? { subject } : {}) });
  }

  async function http(req: PluginHttpRequest): Promise<PluginHttpResponse> {
    if (!req.public || req.path !== WEBHOOK_PATH) return { status: 404, body: { error: "not found" } };
    if (req.method !== "POST") return { status: 405, body: { error: "POST only" } };
    if (typeof req.rawBody !== "string") return { status: 400, body: { error: "no raw body to check the signature against" } };
    secret ??= (await ctx.storage.get<{ secret?: string }>("webhook"))?.secret;
    if (!secret) return { status: 401, body: { error: "no webhook is registered here" } };
    const problem = signatureProblem(req.headers, req.rawBody, secret, now());
    if (problem) return { status: 401, body: { error: problem } };
    let body: unknown;
    try {
      body = JSON.parse(req.rawBody);
    } catch {
      return { status: 400, body: { error: "the body is not JSON" } };
    }
    accept(body, header(req.headers, "webhook-id"));
    return { status: 200, body: { ok: true } };
  }

  return {
    provider: { subscribe: (sub, emit) => subscribe(sub.id, sub.config ?? {}, emit) },
    http,
    async close() {
      closed = true;
      realtime.stop();
      const pending = [...queues.values()];
      if (pending.length) await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, CLOSE_WAIT_MS))]);
    },
  };
}
