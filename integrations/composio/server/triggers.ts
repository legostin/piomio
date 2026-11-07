// composio.event: the person's connected apps' events (a new Gmail message, a Slack message, a GitHub push…) as one
// subscribe-mode signal source. A subscription's config names a Composio trigger type, optionally the app and the
// account, and that type's own config:
//   { trigger: "GMAIL_NEW_GMAIL_MESSAGE", app?: "gmail", account?: "ca_…", config?: { … } }
//
// Subscribing upserts the trigger instance on the app's connected account (one per type and account: subscriptions
// with the same one share it; an instance the person made there already is taken over) and enables it again when it
// was off. Events reach the hub one of two ways:
//   1. a project webhook at <publicUrl>/hooks/composio/events, when the hub has a public https address that really
//      reaches it (the plugin's GET <publicUrl>/hooks/composio/ping must come back to this process with the nonce it
//      made at start; the Access from anywhere link, for one, does not carry webhooks): registered once, its secret
//      kept in the plugin's storage (never in settings or logs), every request checked by its Standard Webhooks
//      signature over the raw body. A webhook the person set up in the project themselves is never changed: then the
//      events come the other way. Every 15 minutes the address is checked again and the subscription at Composio read
//      (its address, secret and events); on a problem the realtime channel opens again and the subscription is set
//      right. When the address goes or stops reaching this hub, the hub's own subscription (its kept id, still at a
//      hub's hook route) is deleted from the person's project: every event would still go there, whole, to whoever
//      has that address next (settings that cannot be read say nothing about the address: then nothing changes until
//      the next check). It is made again once an address works. A well-formed webhook whose signature fails
//      makes the hub read the secret again (Composio may have rotated it), at most every 5 minutes.
//   2. otherwise Composio's realtime channel (realtime.ts), which Composio calls internal. It is also kept open in
//      webhook mode until the first signed webhook arrives, in case the public address is not reachable from outside.
// Either way an event goes, by the trigger instance it names, to the subscriptions on that instance, once (keyed by
// its log id), with Composio's data plus { trigger, app, account } where the app's payload has no field of that name.
// What cannot be read or routed is logged at most once per 10 minutes per reason, without the event's content.
// Without a key (removed, not a locked vault) the channel closes and webhooks are answered without their events.
//
// Instances outlive a restart and a leader handover. The plugin stops its subscriptions before it stops, and the next
// process (on this computer or another replica: plugin storage replicates) subscribes again a moment later, so:
//   - the last subscription's stop disables its instance only after a grace period (3 minutes), and a subscribe
//     meanwhile, or the plugin stopping, cancels that;
//   - each instance has a lease in storage, inst:<ti> = { holder, config, at }, taken on subscribe and refreshed every
//     minute while held; a deferred disable leaves the instance on when another process holds a fresh lease;
//   - 5 minutes after the first subscriptions, instances the hub made whose lease ran out and that nothing holds (their
//     trigger went while the plugin was off, or their disable failed) are disabled;
//   - while the plugin warms up, a webhook for one of the hub's instances that is not held yet is answered 503, so
//     Composio sends it again once it is.

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PluginContext, PluginHttpRequest, PluginHttpResponse, SignalEmitOptions, SignalProvider } from "@piomio/plugin-sdk";
import { ComposioError, hostOf, isHubHook, ownWebhook, TRIGGER_MESSAGE, WebhookTaken, type ComposioApi, type WebhookSubscription } from "./api.ts";
import { RealtimeChannel, type RealtimeDeps } from "./realtime.ts";

/** The webhook's path under /hooks/composio, and the one the plugin checks its own public address by. */
export const WEBHOOK_PATH = "/events";
export const PING_PATH = "/ping";
/** How long the check of the public address may take, how much of its answer is read, and when a failed one is tried again. */
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_READ_MAX = 4096;
const PROBE_RETRY_MS = 10 * 60_000;
/**
 * How often webhook delivery is checked again (and a successful check of the address trusted), the least pause between
 * two reads of the webhook's secret after refused signatures, and between two log lines of one repeated problem.
 */
const CHECK_MS = 15 * 60_000;
const SECRET_READ_MS = 5 * 60_000;
const SAY_AGAIN_MS = 10 * 60_000;
/** What the hub's egress proxy says when it refuses a connection (its own words, not the address's). */
const PROXY_REFUSAL_RE = /^(egress to|Host) \S+ is not allowed/;
/** Signatures older (or newer) than this are refused, in seconds. */
export const TOLERANCE_S = 300;
/** Storage keys of the leases: inst:<ti>. */
export const LEASE_PREFIX = "inst:";
/** In minutes: the grace before a released instance is disabled, a lease's freshness, its refresh, the reconcile, warm-up. */
const GRACE_MIN = 3;
const LEASE_FRESH_MIN = 3;
const LEASE_REFRESH_MIN = 1;
const RECONCILE_MIN = 5;
const WARM_MIN_MIN = 1;
const WARM_MAX_MIN = 5;
/** As the hub's intake cap: an event's data bigger than this is not sent. */
const DATA_MAX = 256 * 1024;
const SUBJECT_MAX = 120;
/** Event ids remembered, so a retried or doubly delivered event is emitted once. */
const SEEN_MAX = 2000;
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
  /** How long a minute of the timings above is (tests only). */
  minuteMs?: number;
  /** Where the public address is checked instead of the address itself (tests only). */
  probeBase?: string;
  /** What checks the public address instead of fetch (tests only). */
  fetch?: typeof fetch;
  /** The realtime channel instead of Composio's (tests only). */
  channel?: (d: RealtimeDeps) => Channel;
  /** How often webhook delivery is checked again instead of every 15 minutes (tests only). */
  checkMs?: number;
  now?: () => number;
}

/** What the plugin does with the realtime channel. */
type Channel = Pick<RealtimeChannel, "start" | "stop">;

/** The hub's webhook subscription as storage keeps it ("webhook"). */
interface KeptWebhook {
  id: string;
  url: string;
  secret: string;
}

/** One hub subscription, on one instance. */
interface Holder {
  trigger: string;
  app: string;
  /** The trigger type's own config, as the subscription gave it (to move it to a new account). */
  config: Record<string, unknown>;
  emit: (data: unknown, o?: SignalEmitOptions) => void;
  fail: (error: string) => void;
}

/** A trigger instance at Composio (one per type and account) and the subscriptions on it here. */
interface Instance {
  /** Composio's ti_… id; unset until the first upsert answered. */
  id?: string;
  trigger: string;
  account: string;
  /** Its trigger_config, canonical. */
  config: string;
  holders: Map<string, Holder>;
}

/** Who holds an instance (a process's nonce) and since when it said so; released: its last subscription there stopped. */
interface Lease {
  holder: string;
  config: string;
  at: number;
  trigger: string;
  account: string;
  released?: boolean;
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

/** The hub's settings could not be read: whether it has a public address is not known now. */
class SettingsUnread extends Error {
  constructor(why: string) {
    super(`the hub's settings could not be read (${why})`);
  }
}
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const pairKey = (trigger: string, account: string) => `${trigger}\u0000${account}`;

/** The fields of Composio's envelopes (incoming() reads them), at the top and in metadata: the only key names logged. */
const ENVELOPE_KEYS = new Set(["id", "type", "metadata", "data", "timestamp", "log_id", "trigger_name", "trigger_id", "connection_id", "payload", "appName"]);
const METADATA_KEYS = new Set(["log_id", "trigger_slug", "trigger_id", "connected_account_id", "auth_config_id", "user_id", "id", "nanoId", "triggerName", "connection"]);

/**
 * What an event looks like without what it says, for the log: its kind, or which of Composio's envelope fields it has
 * (at the top and in its metadata). Any other key is only counted: its name may be anything (an address, an id).
 */
function shapeOf(raw: unknown): string {
  if (!isObject(raw)) return Array.isArray(raw) ? "a list" : raw === null ? "null" : `a ${typeof raw}`;
  const keys = (o: Record<string, unknown>, known: Set<string>) => {
    const all = Object.keys(o);
    const mine = all.filter((k) => known.has(k));
    const others = all.length - mine.length;
    return `${mine.join(", ") || "none of Composio's"}${others ? ` and ${others} other${others === 1 ? "" : "s"}` : ""}`;
  };
  if (!Object.keys(raw).length) return "an empty object";
  return `keys: ${keys(raw, ENVELOPE_KEYS)}${isObject(raw.metadata) ? `; metadata keys: ${keys(raw.metadata, METADATA_KEYS)}` : ""}`;
}

/**
 * Why a second config of a trigger type on one account is refused (to the hub, and to fail() for a subscription moved
 * to a new account): Composio's upsert keeps one instance per type and account, so a second config would overwrite the
 * first one's. Not checked live: Composio's knowledge base suggests two may work for some types (Google Calendar).
 */
export function oneListener(trigger: string, app: string, config: string): string {
  return (
    `composio.event: Composio keeps one listener per trigger type per app account, and ${trigger} on ${app}'s account already listens with another config (${config.slice(0, 300)}). ` +
    "To listen to two of its sources (two repositories, two channels), use one trigger whose config covers both, if the type's config allows it, with a filter or script that tells their events apart."
  );
}

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
 * match; other versions and bare values are ignored, as Composio's SDK does), and a timestamp more than 300 s away is
 * refused. Undefined when it holds, else why not.
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
    if (!entry.startsWith("v1,")) continue;
    const given = Buffer.from(entry.slice(3), "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return undefined;
  }
  return "invalid signature";
}

/**
 * An event in V3 (what the webhook is registered for), V2, V1 or the SDK's oldest form; undefined when it is none.
 * Its id is Composio's log id when there is one: it is the event's, whichever way and envelope it came by.
 */
export function incoming(raw: unknown): Incoming | undefined {
  if (!isObject(raw)) return undefined;
  const meta = isObject(raw.metadata) ? raw.metadata : undefined;
  // V3: { id, type, metadata: { trigger_id, trigger_slug, connected_account_id, log_id… }, data, timestamp }.
  if (meta && str(meta.trigger_id)) {
    return { instances: [meta.trigger_id as string], id: str(meta.log_id) ?? str(raw.id), trigger: str(meta.trigger_slug), account: str(meta.connected_account_id), data: raw.data };
  }
  // V2: { type: "<trigger, lowercase>", data: { …, trigger_nano_id, trigger_id, connection_nano_id… }, log_id? }.
  if (isObject(raw.data) && (str(raw.data.trigger_nano_id) || str(raw.data.trigger_id)) && str(raw.type)) {
    const d = raw.data;
    const data = Object.fromEntries(Object.entries(d).filter(([k]) => !V2_META.includes(k)));
    const instances = [str(d.trigger_nano_id), str(d.trigger_id)].filter((x): x is string => !!x);
    return { instances, id: str(raw.log_id) ?? str(d.log_id) ?? str(raw.id), trigger: (raw.type as string).toUpperCase(), account: str(d.connection_nano_id) ?? str(d.connected_account_id), data };
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

/**
 * Whether Composio can reach this address: https on a public name, not loopback, a private range or a local name. A
 * Tailscale name (*.ts.net) is public only on 443, the port Funnel serves; on any other it is the tailnet's alone.
 */
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
  if (host.endsWith(".ts.net") && u.port && u.port !== "443") return false;
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
  /** The plugin's first check of its accounts is done (part of the warm-up). */
  synced(): void;
  /** An app signed in again or out: its subscriptions move to its new account, or fail (the hub tries them again later). */
  accountsChanged(): void;
  /** How the events come, for the model (composio_triggers): the realtime channel, and why, or the webhook. */
  deliveryNote(): Promise<string>;
  /**
   * Whether Composio has a key: false when it was removed (not when the vault is locked). Without one the realtime
   * channel closes and webhooks are answered without their events; all comes back with a key.
   */
  keyChanged(present: boolean): void;
  /** The plugin stops: timers and the channel stop; nothing is disabled (the next process takes the instances over). */
  close(): Promise<void>;
}

export function composioTriggers(d: TriggerDeps): ComposioTriggers {
  const { ctx } = d;
  const now = d.now ?? Date.now;
  const minute = d.minuteMs ?? 60_000;
  const checkMs = d.checkMs ?? CHECK_MS;
  /** This process, in the leases. */
  const nonce = randomUUID();
  /** What this process answers on its public ping: only it can, so a stale or another server cannot pass the check. */
  const pingNonce = randomUUID();
  /** The checks of the public address, by webhook URL: why it does not reach this hub (undefined: it does). */
  const probes = new Map<string, { at: number; result: Promise<string | undefined>; why?: string; done: boolean }>();
  /** Why the public address does not reach this hub's webhooks, when the last check found so. */
  let unreachable: string | undefined;
  const started = now();
  /** Instances by pairKey(trigger, account), and by their Composio id; each subscription's pair. */
  const pairs = new Map<string, Instance>();
  const byId = new Map<string, Instance>();
  const holderPair = new Map<string, string>();
  /** One upsert, enable or disable at a time per instance, in order. */
  const queues = new Map<string, Promise<unknown>>();
  /** Released instances waiting for their grace to end, by pair. */
  const disableTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const seen = new Set<string>();
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  let reconcileRescheduled = false;
  /** How this process's subscriptions get their events now, and the check that decides it. */
  let current: "webhook" | "realtime" | undefined;
  let deciding: Promise<"webhook" | "realtime"> | undefined;
  /** Where the project's webhook goes when it is the person's own (the hub left it alone). */
  let taken: string | undefined;
  let secret: string | undefined;
  /**
   * A signed webhook arrived since the webhook was last made, pointed or found wrong: the address is reachable, the
   * safety-net channel is closed.
   */
  let webhookVerified = false;
  /**
   * Why the events come over the realtime channel: the address (none, or it does not reach this hub), the person's own
   * webhook, or Composio refused the hub's. Only the first is looked at again (every 15 minutes) while it lasts.
   */
  let realtimeWhy: "address" | "taken" | "refused" | undefined;
  /** Composio has no key (it was removed): the channel is closed, webhooks are answered without their events. */
  let noKey = false;
  let checkTimer: ReturnType<typeof setInterval> | undefined;
  /** When the webhook's secret was last read again after a refused signature, and that read while it runs. */
  let secretReadAt = -Infinity;
  let secretRead: Promise<boolean> | undefined;
  /** Repeated problems by reason: when each was last logged, and how many like it were not since. */
  const said = new Map<string, { at: number; more: number }>();
  let accountsSynced = false;
  let warmed = false;
  /** Subscribes under way, and subscriptions being moved to a new account (by id, and those of them stopped meanwhile). */
  let subscribing = 0;
  let moving = 0;
  const inMove = new Set<string>();
  const stoppedInMove = new Set<string>();
  let closed = false;

  /**
   * A problem that may repeat (an event, a request, a reconnect): logged at most once per 10 minutes per reason, with
   * how many like it came since. Its line never holds an event's content.
   */
  function sayOnce(reason: string, msg: string, level: "info" | "warn" = "warn"): void {
    const t = now();
    const last = said.get(reason);
    if (last && t - last.at < SAY_AGAIN_MS) {
      last.more++;
      return;
    }
    if (!last && said.size >= 100) said.delete(said.keys().next().value!);
    said.set(reason, { at: t, more: 0 });
    ctx.log[level](last?.more ? `${msg} (${last.more} more like it in the last ${Math.max(1, Math.round((t - last.at) / 60_000))} minutes)` : msg);
  }

  const channelDeps: RealtimeDeps = {
    credentials: () => d.api().realtimeCredentials(),
    auth: (socketId, channel) => d.api().realtimeAuth(socketId, channel),
    onEvent: (e) => void route(e, undefined, "channel"),
    log: (level, msg, reason) => (reason ? sayOnce(reason, msg, level) : ctx.log[level](msg)),
    ...(d.pusherBase ? { base: d.pusherBase } : {}),
    ...(d.reconnectMs ? { reconnectMs: d.reconnectMs } : {}),
    ...(d.minuteMs ? { handshakeMs: d.minuteMs / 2 } : {}),
  };
  const realtime: Channel = d.channel ? d.channel(channelDeps) : new RealtimeChannel(channelDeps);

  const warn = (what: string) => (e: unknown) => ctx.log.warn(`composio: ${what}: ${message(e)}`);

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
  const leaseKey = (ti: string) => `${LEASE_PREFIX}${ti}`;
  /** Another process holds it, and said so lately. */
  const heldElsewhere = (l: Lease | undefined | null) => !!l && l.holder !== nonce && !l.released && now() - l.at < LEASE_FRESH_MIN * minute;
  const fresh = (l: Lease | undefined | null) => !!l && typeof l.at === "number" && now() - l.at < LEASE_FRESH_MIN * minute;

  /** The realtime channel is wanted: the way events come, or the safety net until a signed webhook arrived; not without a key. */
  const wantChannel = () => !noKey && (current === "realtime" || !webhookVerified);

  // ---------- delivery ----------

  /**
   * The hub's public address when it is a public https one (read each time: it may change), else undefined. Throws
   * SettingsUnread when the settings cannot be read (a hiccup of the core, the hub shutting down): that says nothing
   * about the address, so nothing is decided on it.
   */
  async function hubBase(): Promise<string | undefined> {
    let s: { publicUrl?: string } | undefined;
    try {
      s = await ctx.core.call<{ publicUrl?: string }>("settings.get");
    } catch (e) {
      throw new SettingsUnread(message(e));
    }
    return isPublicHttps(s?.publicUrl) ? String(s!.publicUrl).replace(/\/+$/, "") : undefined;
  }
  const hookUrl = (base: string) => `${base}/hooks/${ctx.pluginId}${WEBHOOK_PATH}`;

  /** At most `max` bytes of a response's body, as text. */
  async function head(res: Response, max: number): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (size < max) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks).subarray(0, max).toString("utf8");
  }

  /**
   * Whether the hub's public address reaches this very process: its ping there (through the hub's egress proxy, as any
   * request of the plugin) must answer 200 with the nonce made at start. Undefined when it does, else why not.
   */
  async function ping(base: string): Promise<string | undefined> {
    const target = `${(d.probeBase ?? base).replace(/\/+$/, "")}/hooks/${ctx.pluginId}${PING_PATH}`;
    /** The hub's own egress proxy answered instead of the address: the address was never asked. */
    const byProxy = (status: number) =>
      status === 502 ? "the hub's egress proxy could not reach it (HTTP 502)" : `the hub's egress proxy refused the check (HTTP ${status}), so the address was never asked`;
    let res: Response;
    try {
      res = await (d.fetch ?? fetch)(target, { redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    } catch (e: any) {
      const why = String(e?.cause?.message ?? e?.message ?? e);
      // An https address goes through the proxy's CONNECT: its refusal comes as fetch's error.
      const proxy = /Proxy response \((\d{3})\)/.exec(why);
      if (proxy) return byProxy(Number(proxy[1]));
      return `it could not be reached from the hub (${why})`;
    }
    const text = await head(res, PROBE_READ_MAX).catch(() => "");
    if ((res.status === 403 || res.status === 407) && PROXY_REFUSAL_RE.test(text)) return byProxy(res.status);
    if (res.status === 502 && text.startsWith("cannot reach ")) return byProxy(502);
    if (res.status !== 200) return `it answers HTTP ${res.status} there${res.status === 404 ? " (the Access from anywhere link does not carry webhooks)" : ""}`;
    let answer: unknown;
    try {
      answer = JSON.parse(text);
    } catch {
      /* not this hub's answer */
    }
    if (!isObject(answer) || answer.nonce !== pingNonce) return "something answers there, but not this hub (a stale or another server)";
    return undefined;
  }

  /** The check of an address, kept for a while (a failed one 10 minutes, a passed one 15); a new address is checked anew. */
  function probe(base: string): Promise<string | undefined> {
    const url = hookUrl(base);
    const kept = probes.get(url);
    if (kept && (!kept.done || now() - kept.at < (kept.why ? PROBE_RETRY_MS : checkMs))) return kept.result;
    const entry: { at: number; result: Promise<string | undefined>; why?: string; done: boolean } = { at: now(), result: Promise.resolve(undefined), done: false };
    entry.result = ping(base).then((why) => {
      entry.why = why;
      entry.done = true;
      return why;
    });
    probes.set(url, entry);
    return entry.result;
  }

  /**
   * The project's webhook goes to this hub: the kept one is checked (it may have been deleted, or pointed elsewhere),
   * and registered again when it is not there or not right. The person's own is never changed (WebhookTaken). Whether
   * it was not as the hub left it (made, pointed here, or its secret changed).
   */
  async function ensureWebhook(url: string): Promise<boolean> {
    const kept = await ctx.storage.get<KeptWebhook>("webhook");
    if (kept?.id) {
      let sub: WebhookSubscription | undefined;
      try {
        sub = await d.api().getWebhookSubscription(kept.id);
      } catch (e) {
        if (!(e instanceof ComposioError && e.status === 404)) throw e;
      }
      if (sub && sub.url === url && sub.secret && sub.events.includes(TRIGGER_MESSAGE)) {
        const changed = sub.secret !== kept.secret || kept.url !== url;
        if (changed) await ctx.storage.set("webhook", { id: sub.id, url, secret: sub.secret } satisfies KeptWebhook);
        secret = sub.secret;
        return changed;
      }
    }
    let sub = await d.api().createWebhookSubscription(url, kept?.id);
    if (!sub.secret) sub = await d.api().getWebhookSubscription(sub.id);
    if (!sub.secret) throw new ComposioError(502, "Composio gave no secret for the webhook subscription", "other");
    await ctx.storage.set("webhook", { id: sub.id, url, secret: sub.secret } satisfies KeptWebhook);
    secret = sub.secret;
    ctx.log.info(`composio: the apps' events come by webhook to ${url}`);
    return true;
  }

  /**
   * The hub's own webhook taken out of the person's project: its address no longer reaches this hub, and every event
   * would still go there with its whole payload (to whoever has that address next). Only the kept subscription, and only
   * while Composio says it still goes to a hub's hook route; one the person pointed at their own server since is only
   * forgotten. Made again once an address works (decide).
   */
  async function dropHubWebhook(): Promise<void> {
    const kept = await ctx.storage.get<KeptWebhook>("webhook");
    if (!kept?.id) return;
    let sub: WebhookSubscription | undefined;
    try {
      sub = await d.api().getWebhookSubscription(kept.id);
    } catch (e) {
      if (!(e instanceof ComposioError && e.status === 404)) throw e;
    }
    if (sub?.id === kept.id && isHubHook(sub.url) && isHubHook(kept.url)) {
      await d.api().deleteWebhookSubscription(sub.id);
      ctx.log.info(`composio: removed the hub's webhook (to ${hostOf(sub.url)}) from Composio's project: that address no longer reaches this hub`);
    }
    await ctx.storage.delete("webhook");
    secret = undefined;
  }

  /** How the events come: decided when this process has no subscription yet (the first one, or after all stopped). */
  function delivery(): Promise<"webhook" | "realtime"> {
    if (current && holders() > 0) return Promise.resolve(current);
    return redecide();
  }

  /** decide(), once at a time. */
  function redecide(): Promise<"webhook" | "realtime"> {
    deciding ??= decide().finally(() => (deciding = undefined));
    return deciding;
  }

  /** The realtime channel, because no address reaches this hub's webhooks: the hub's own webhook goes. */
  async function overTheChannel(): Promise<"realtime"> {
    await dropHubWebhook().catch((e) => sayOnce("webhook-remove", `composio: could not remove the hub's webhook from Composio's project (tried again later): ${message(e)}`));
    realtimeWhy = "address";
    return (current = "realtime");
  }

  async function decide(): Promise<"webhook" | "realtime"> {
    const was = current;
    let base: string | undefined;
    try {
      base = await hubBase();
    } catch (e) {
      if (!(e instanceof SettingsUnread)) throw e;
      // Not known now: the webhook and the way events come stay as they are (the realtime channel when nothing was
      // decided yet), and the next check decides.
      sayOnce("settings", `composio: ${e.message}; how the apps' events come is left as it is and checked again in 15 minutes`);
      if (current) return current;
      realtimeWhy = "address";
      return (current = "realtime");
    }
    if (!base) return overTheChannel();
    const url = hookUrl(base);
    // Never a webhook that cannot arrive: the address must reach this hub's webhooks before one is made or pointed there.
    const why = await probe(base);
    if (why) {
      if (unreachable !== why) ctx.log.warn(`composio: the hub's public address ${hostOf(base)} does not reach its webhooks: ${why}; the apps' events come over Composio's realtime channel`);
      unreachable = why;
      return overTheChannel();
    }
    unreachable = undefined;
    try {
      const changed = await ensureWebhook(url);
      taken = undefined;
      realtimeWhy = undefined;
      // A webhook made, pointed here or with a new secret is not proven until a signed one arrives: the channel listens.
      if (changed || was !== "webhook") webhookVerified = false;
      return (current = "webhook");
    } catch (e) {
      if (e instanceof WebhookTaken) {
        if (taken !== e.host) ctx.log.warn(`composio: Composio's project already sends its webhook to ${e.host}, which this hub did not set up; the hub leaves it alone and uses Composio's realtime channel`);
        taken = e.host;
        realtimeWhy = "taken";
        return (current = "realtime");
      }
      // Composio refused the address itself: the realtime channel is the way left.
      if (!(e instanceof ComposioError && e.kind === "other")) throw e;
      ctx.log.warn(`composio: Composio did not take the webhook at the hub's public address (${e.message}); using its realtime channel instead`);
      realtimeWhy = "refused";
      return (current = "realtime");
    }
  }

  /** What is wrong with the webhook this process gets its events by: its address, or its subscription at Composio. */
  async function webhookProblem(): Promise<string | undefined> {
    const base = await hubBase();
    if (!base) return "the hub has no public https address any more";
    const url = hookUrl(base);
    const kept = await ctx.storage.get<KeptWebhook>("webhook");
    if (!kept?.id) return "the hub's webhook is not registered any more";
    if (kept.url !== url) return "the hub's public address changed";
    // A fresh look, not the one kept from before.
    probes.delete(url);
    const why = await probe(base);
    if (why) return `the hub's public address does not reach it any more: ${why}`;
    let sub: WebhookSubscription;
    try {
      sub = await d.api().getWebhookSubscription(kept.id);
    } catch (e) {
      if (e instanceof ComposioError && e.status === 404) return "its subscription is gone from Composio's project";
      throw e;
    }
    if (sub.url !== url) return `its subscription at Composio goes to ${hostOf(sub.url)} now`;
    if (!sub.events.includes(TRIGGER_MESSAGE)) return "its subscription at Composio no longer has the trigger event";
    if (!sub.secret || sub.secret !== kept.secret) return "its secret changed at Composio";
    return undefined;
  }

  /**
   * Every 15 minutes while something here listens. By webhook: is it still as the hub set it up? When not, the realtime
   * channel listens again (until a signed webhook arrives) and the webhook is set right, or goes with its address. Over
   * the channel because of the address: does an address work now? Then the webhook is made again.
   */
  async function recheck(): Promise<void> {
    if (closed || noKey || !holders() || deciding) return;
    if (current === "webhook") {
      let problem: string | undefined;
      try {
        problem = await webhookProblem();
      } catch (e) {
        // The settings could not be read: nothing is known about the address, so the webhook stays as it is.
        if (!(e instanceof SettingsUnread)) throw e;
        sayOnce("settings", `composio: ${e.message}; how the apps' events come is left as it is and checked again in 15 minutes`);
        return;
      }
      // The key went, the plugin stopped, or the last trigger did while the check asked: nothing to open the channel for.
      if (!problem || closed || noKey || !holders()) return;
      webhookVerified = false;
      ctx.log.warn(`composio: the apps' webhook stopped working as the hub set it up (${problem}); Composio's realtime channel listens again until it works`);
      realtime.start();
    } else if (current === "realtime" && realtimeWhy === "address") probes.clear();
    else return;
    await redecide();
    if (!closed && holders() && wantChannel()) realtime.start();
  }

  function startCheck(): void {
    if (checkTimer || closed) return;
    checkTimer = setInterval(() => void recheck().catch((e) => sayOnce("check", `composio: could not check how the apps' events come (tried again in 15 minutes): ${message(e)}`)), checkMs);
    checkTimer.unref?.();
  }

  function stopCheck(): void {
    clearInterval(checkTimer);
    checkTimer = undefined;
  }

  /**
   * The kept webhook's secret read again from Composio after a well-formed request failed its signature (Composio may
   * have rotated it), at most every 5 minutes; whether a new one came.
   */
  function readSecretAgain(): Promise<boolean> {
    if (secretRead) return secretRead;
    if (noKey || now() - secretReadAt < SECRET_READ_MS) return Promise.resolve(false);
    secretReadAt = now();
    secretRead = (async () => {
      const kept = await ctx.storage.get<KeptWebhook>("webhook");
      if (!kept?.id) return false;
      const sub = await d.api().getWebhookSubscription(kept.id);
      if (!sub.secret || sub.secret === kept.secret || !isHubHook(sub.url)) return false;
      await ctx.storage.set("webhook", { ...kept, secret: sub.secret } satisfies KeptWebhook);
      secret = sub.secret;
      ctx.log.info("composio: the webhook's secret changed at Composio; the hub took the new one");
      return true;
    })()
      .catch((e) => {
        sayOnce("webhook-secret", `composio: could not read the webhook's secret again: ${message(e)}`);
        return false;
      })
      .finally(() => (secretRead = undefined));
    return secretRead;
  }

  async function deliveryNote(): Promise<string> {
    const channel = "Composio's realtime channel, which Composio calls internal (it may change without notice)";
    let base: string | undefined;
    try {
      base = await hubBase();
    } catch (e) {
      if (!(e instanceof SettingsUnread)) throw e;
      return "How the apps' events come could not be told just now: the hub's settings did not answer.";
    }
    if (!base) return `The hub has no public https address, so the apps' events come over ${channel}.`;
    const url = hookUrl(base);
    // Checking the address is a read (and done once per address): it may run here.
    const why = await probe(base);
    if (why) return `The hub's public address does not reach its webhooks (${why}), so the apps' events come over ${channel}.`;
    let host = taken;
    if (!host && !current) {
      // Nothing decided yet: look, without changing anything.
      try {
        const kept = await ctx.storage.get<{ id: string }>("webhook");
        const { mine, theirs } = ownWebhook(await d.api().listWebhookSubscriptions(), url, kept?.id);
        if (!mine && theirs) host = hostOf(theirs.url);
      } catch {
        /* the answer goes without it */
      }
    }
    if (host)
      return (
        `Composio's project already sends its webhook to ${host}, which the user set up outside this hub. The hub never changes it, so the apps' events come over ${channel}. ` +
        "Tell the user when it matters; their webhook is untouched."
      );
    return "The apps' events come by webhook to the hub's public address.";
  }

  // ---------- leases, the grace before a disable, the reconcile ----------

  async function takeLease(inst: Instance): Promise<void> {
    if (!inst.id) return;
    const lease: Lease = { holder: nonce, config: inst.config, at: now(), trigger: inst.trigger, account: inst.account };
    await ctx.storage.set(leaseKey(inst.id), lease);
  }

  /** Every held instance says so again; one another process took over meanwhile is left to it. */
  async function refreshLeases(): Promise<void> {
    for (const inst of pairs.values()) {
      if (!inst.holders.size || !inst.id) continue;
      const l = await ctx.storage.get<Lease>(leaseKey(inst.id));
      // Released meanwhile (its release writes the lease itself), or taken over by another process.
      if (!inst.holders.size || heldElsewhere(l)) continue;
      await takeLease(inst);
    }
  }

  function startRefresh(): void {
    if (refreshTimer || closed) return;
    refreshTimer = setInterval(() => void refreshLeases().catch(warn("could not refresh the trigger leases")), LEASE_REFRESH_MIN * minute);
    refreshTimer.unref?.();
  }

  function stopRefresh(): void {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }

  async function releaseLease(inst: Instance): Promise<void> {
    if (!inst.id) return;
    const l = await ctx.storage.get<Lease>(leaseKey(inst.id));
    if (l?.holder === nonce) await ctx.storage.set(leaseKey(inst.id), { ...l, at: now(), released: true } satisfies Lease);
  }

  async function disable(ti: string): Promise<void> {
    try {
      await d.api().setTriggerEnabled(ti, false);
    } catch (e) {
      // Gone already (its account was deleted): nothing to disable.
      if (!(e instanceof ComposioError && e.status === 404)) throw e;
    }
  }

  /** The grace ended with nothing here holding it: disabled, unless another process holds it now. */
  async function disableIfFree(inst: Instance): Promise<void> {
    if (closed || inst.holders.size || !inst.id) return;
    const key = leaseKey(inst.id);
    if (heldElsewhere(await ctx.storage.get<Lease>(key))) {
      ctx.log.info(`composio: ${inst.trigger}'s trigger ${inst.id} is held by another hub process now; left on`);
      return;
    }
    await disable(inst.id);
    if (!heldElsewhere(await ctx.storage.get<Lease>(key))) await ctx.storage.delete(key);
  }

  function scheduleDisable(pair: string, inst: Instance): void {
    clearTimeout(disableTimers.get(pair));
    const t = setTimeout(() => {
      disableTimers.delete(pair);
      void serial(pair, () => disableIfFree(inst)).catch(warn(`could not disable ${inst.trigger}'s trigger ${inst.id}`));
    }, GRACE_MIN * minute);
    t.unref?.();
    disableTimers.set(pair, t);
  }

  /** The last subscription here on `inst` stopped. */
  function emptied(pair: string, inst: Instance): void {
    if (closed) return;
    // In the instance's queue: a subscribe right after takes the lease after this, not before.
    void serial(pair, async () => {
      if (!inst.holders.size) await releaseLease(inst);
    }).catch(warn("could not release a trigger lease"));
    scheduleDisable(pair, inst);
  }

  /** Nothing here listens any more: the channel, the lease refresh and the check stop (unless subscriptions are being moved). */
  function idle(): void {
    if (holders() || moving) return;
    realtime.stop();
    stopRefresh();
    stopCheck();
  }

  function scheduleReconcile(): void {
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => void reconcile().catch(warn("the trigger reconcile failed")), RECONCILE_MIN * minute);
    reconcileTimer.unref?.();
  }

  /**
   * The hub's instances (those with a lease in storage) that nothing holds and whose lease ran out: disabled when
   * Composio says they are still on, and forgotten.
   */
  async function reconcile(): Promise<void> {
    if (closed || !(await d.hasKey())) return;
    const rows = await ctx.storage.list(LEASE_PREFIX);
    const due = rows.flatMap(({ key, value }) => {
      const ti = key.slice(LEASE_PREFIX.length);
      const inst = byId.get(ti);
      if (!ti || inst?.holders.size) return [];
      if (inst && disableTimers.has(pairKey(inst.trigger, inst.account))) return [];
      const l = value as Lease | null;
      return fresh(l) ? [] : [{ ti, key, l }];
    });
    if (!due.length) return;
    let on: Set<string>;
    try {
      on = new Set((await d.api().listActiveTriggers({ triggerIds: due.map((x) => x.ti) })).filter((t) => !t.disabled).map((t) => t.id));
    } catch (e) {
      ctx.log.warn(`composio: could not check the hub's triggers at Composio, left as they are: ${message(e)}`);
      return;
    }
    for (const { ti, key, l } of due) {
      await serial(pairKey(l?.trigger ?? "", l?.account ?? ti), async () => {
        if (closed || byId.get(ti)?.holders.size || fresh(await ctx.storage.get<Lease>(key))) return;
        if (on.has(ti)) {
          await disable(ti);
          ctx.log.info(`composio: disabled ${l?.trigger ?? "a"} trigger ${ti} that no trigger of the hub uses any more`);
        }
        await ctx.storage.delete(key);
      }).catch(warn(`could not disable trigger ${ti}`));
    }
  }
  // When no subscription ever comes (every trigger went while the plugin was off), the reconcile still runs.
  scheduleReconcile();

  /** Still warming up: the first account check or the first subscriptions are not done, within 1 to 5 minutes. */
  function warm(): boolean {
    if (warmed) return false;
    const age = now() - started;
    if (age >= WARM_MAX_MIN * minute || (accountsSynced && !subscribing && age >= WARM_MIN_MIN * minute)) warmed = true;
    return !warmed;
  }

  // ---------- subscriptions ----------

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

  /** Puts subscription `id` on the instance of its trigger on `account`, made, updated or enabled as needed. */
  async function attach(id: string, h: Holder, account: string): Promise<void> {
    const pair = pairKey(h.trigger, account);
    const config = canonical(h.config);
    await serial(pair, async () => {
      if (closed) throw new Error("composio.event: the plugin is stopping");
      let inst = pairs.get(pair);
      if (inst?.holders.size) {
        // One instance per trigger type and account is what Composio's upsert says (it updates "the one that
        // matches"): another config would overwrite this one's, so it is refused (see oneListener).
        if (inst.config !== config) throw new Error(oneListener(h.trigger, d.nameOf(h.app), inst.config));
      } else {
        const pending = disableTimers.get(pair);
        clearTimeout(pending);
        disableTimers.delete(pair);
        // Released a moment ago with the same config and not disabled yet: it is still on, as it was.
        if (!(pending && inst?.id && inst.config === config)) {
          const r = await d.api().upsertTriggerInstance(h.trigger, { connectedAccountId: account, config: h.config });
          // An instance that was there may be disabled: enabled again.
          if (!r.created) await d.api().setTriggerEnabled(r.id, true);
          if (r.fallbackReason) ctx.log.info(`composio: Composio polls ${h.trigger} instead of a webhook: ${r.fallbackReason}`);
          if (!inst) pairs.set(pair, (inst = { trigger: h.trigger, account, config, holders: new Map() }));
          if (inst.id && inst.id !== r.id) byId.delete(inst.id);
          inst.id = r.id;
          inst.config = config;
          byId.set(r.id, inst);
        }
      }
      // Stopped while it was being moved here: it stays stopped, and the instance goes after the grace when nothing
      // else here holds it.
      if (stoppedInMove.has(id)) {
        if (!inst!.holders.size) emptied(pair, inst!);
        return;
      }
      inst!.holders.set(id, h);
      holderPair.set(id, pair);
      await takeLease(inst!).catch(warn("could not take a trigger lease"));
      startRefresh();
      startCheck();
    });
  }

  async function subscribe(id: string, raw: Record<string, unknown>, emit: Holder["emit"], fail: Holder["fail"]): Promise<{ stop(): void }> {
    subscribing++;
    try {
      if (closed) throw new Error("composio.event: the plugin is stopping");
      const c = parseConfig(raw);
      if (!(await d.hasKey())) throw new Error("composio.event: Composio has no key yet (its card, hub_integration_connect id composio)");
      const app = await appOf(c.trigger, c.app, c.account);
      const own = d.account(app);
      if (!own) throw new Error(`composio.event: ${d.nameOf(app)} is not connected through Composio (sign in on its card, composio:${app})`);
      if (c.account && c.account !== own) throw new Error(`composio.event: ${c.account} is not an account of ${d.nameOf(app)} connected on this hub`);
      // The reconcile waits for the hub's subscriptions: 5 minutes from the first one.
      if (!reconcileRescheduled) {
        reconcileRescheduled = true;
        scheduleReconcile();
      }
      await delivery();
      await attach(id, { trigger: c.trigger, app, config: c.config, emit, fail }, own);
      // Only now, with the holder in: a release meanwhile cannot close the channel under it.
      if (wantChannel()) realtime.start();
      return { stop: () => release(id) };
    } finally {
      subscribing--;
    }
  }

  /** A subscription stopped: its instance is disabled after the grace when nothing else here listens to it. */
  function release(id: string): void {
    const pair = holderPair.get(id);
    if (!pair) {
      // Being moved to a new account (accountsChanged): it is not put there.
      if (inMove.has(id)) stoppedInMove.add(id);
      return;
    }
    holderPair.delete(id);
    const inst = pairs.get(pair);
    if (!inst?.holders.delete(id)) return;
    if (!inst.holders.size) emptied(pair, inst);
    idle();
  }

  /** Each subscription whose app's account is not its instance's any more: moved to the new one, or failed. */
  function accountsChanged(): void {
    for (const [pair, inst] of pairs) {
      if (!inst.holders.size) continue;
      for (const [id, h] of [...inst.holders]) {
        const account = d.account(h.app);
        if (account === inst.account) continue;
        inst.holders.delete(id);
        holderPair.delete(id);
        if (!account) {
          h.fail(`${d.nameOf(h.app)} is no longer connected through Composio: sign in again on its card (composio:${h.app})`);
          continue;
        }
        moving++;
        inMove.add(id);
        void attach(id, h, account)
          .then(
            () => {
              if (holders() && wantChannel()) realtime.start();
            },
            (e) => {
              if (!stoppedInMove.has(id)) h.fail(`${d.nameOf(h.app)} signed in with another account and its trigger could not move to it: ${message(e)}`);
            },
          )
          .finally(() => {
            inMove.delete(id);
            stoppedInMove.delete(id);
            moving--;
            idle();
          });
      }
      if (!inst.holders.size) emptied(pair, inst);
    }
    idle();
  }

  // ---------- events ----------

  type Outcome = "emitted" | "seen" | "unrouted" | "invalid";

  /**
   * An event from either way: to the subscriptions on the instance it names, once. One in no known form, or for no
   * subscription here, is logged now and then by what it looks like and the trigger it names, never by what it says
   * (the channel brings every trigger of the person's project, not only the hub's).
   */
  function route(raw: unknown, fallbackId: string | undefined, via: "channel" | "webhook", quiet?: (r: { outcome: Outcome; instances: string[] }) => boolean): { outcome: Outcome; instances: string[] } {
    const from = via === "channel" ? "from the realtime channel" : "by webhook";
    const ev = incoming(raw);
    if (!ev) {
      sayOnce(`${via}-form`, `composio: an event ${from} is in no form the hub knows (${shapeOf(raw)}); left out`);
      return { outcome: "invalid", instances: [] };
    }
    const inst = ev.instances.map((i) => byId.get(i)).find((i) => i?.holders.size);
    if (!inst) {
      const r = { outcome: "unrouted" as const, instances: ev.instances };
      if (!quiet?.(r)) {
        const names = ev.instances.slice(0, 3).map((i) => i.replace(/[^A-Za-z0-9_-]/g, "?").slice(0, 64));
        const trigger = ev.trigger && SLUG_RE.test(ev.trigger) ? ` (${ev.trigger})` : "";
        sayOnce(`${via}-unrouted`, `composio: an event ${from} names trigger ${names.join(", ") || "none"}${trigger}, which no subscription here listens to; left out`, "info");
      }
      return r;
    }
    const key = (ev.id ?? fallbackId ?? createHash("sha256").update(canonical(raw)).digest("hex").slice(0, 32)).slice(0, 200);
    if (seen.has(key)) return { outcome: "seen", instances: ev.instances };
    seen.add(key);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value!);
    const first = inst.holders.values().next().value!;
    const data: Record<string, unknown> = { ...(isObject(ev.data) ? ev.data : ev.data === undefined ? {} : { data: ev.data }) };
    // Where it came from, unless the app's payload has fields of those names: they stay the app's.
    for (const [k, v] of [["trigger", first.trigger], ["app", first.app], ["account", inst.account]] as const) if (!Object.hasOwn(data, k)) data[k] = v;
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(data));
    } catch {
      return { outcome: "invalid", instances: ev.instances };
    }
    if (size > DATA_MAX) {
      ctx.log.warn(`composio: event ${key} of ${first.trigger} is over ${DATA_MAX / 1024} KB: not delivered`);
      return { outcome: "invalid", instances: ev.instances };
    }
    const subject = subjectOf(ev.data);
    for (const h of inst.holders.values()) h.emit(data, { key, ...(subject ? { subject } : {}) });
    return { outcome: "emitted", instances: ev.instances };
  }

  async function http(req: PluginHttpRequest): Promise<PluginHttpResponse> {
    // The plugin's own check that its public address reaches it (see ping()).
    if (req.public && req.path === PING_PATH && req.method === "GET") return { status: 200, headers: { "cache-control": "no-store" }, body: { ok: true, nonce: pingNonce } };
    if (!req.public || req.path !== WEBHOOK_PATH) return { status: 404, body: { error: "not found" } };
    if (req.method !== "POST") return { status: 405, body: { error: "POST only" } };
    if (typeof req.rawBody !== "string") return { status: 400, body: { error: "no raw body to check the signature against" } };
    secret ??= (await ctx.storage.get<KeptWebhook>("webhook"))?.secret;
    if (!secret) {
      sayOnce("webhook-none", "composio: a webhook request came, but no webhook of the hub's is registered now; refused");
      return { status: 401, body: { error: "no webhook is registered here" } };
    }
    let problem = signatureProblem(req.headers, req.rawBody, secret, now());
    // Well-formed, but not signed with the secret kept here: Composio may have rotated it.
    if (problem === "invalid signature" && /(^| )v1,/.test(header(req.headers, "webhook-signature") ?? "") && (await readSecretAgain()))
      problem = signatureProblem(req.headers, req.rawBody, secret ?? "", now());
    if (problem) {
      sayOnce(`webhook-${problem}`, `composio: a webhook request was refused: ${problem}`);
      return { status: 401, body: { error: problem } };
    }
    if (!webhookVerified) {
      webhookVerified = true;
      // The address is reachable from outside: the safety net is not needed.
      if (current === "webhook") {
        realtime.stop();
        ctx.log.info("composio: a signed webhook arrived; the realtime channel is closed");
      }
    }
    // Without a key nothing comes of an event; answered, so Composio does not send it again.
    if (noKey) return { status: 200, body: { ok: true } };
    let body: unknown;
    try {
      body = JSON.parse(req.rawBody);
    } catch {
      return { status: 400, body: { error: "the body is not JSON" } };
    }
    // One of the hub's instances whose subscription has not come back yet (a restart, a handover): sent again later.
    const starting = (r: { outcome: Outcome }) => r.outcome === "unrouted" && warm();
    const r = route(body, header(req.headers, "webhook-id"), "webhook", starting);
    if (starting(r)) {
      for (const ti of r.instances) {
        if (await ctx.storage.get(leaseKey(ti))) return { status: 503, headers: { "retry-after": "60" }, body: { error: "the hub is starting; send it again" } };
      }
    }
    return { status: 200, body: { ok: true } };
  }

  return {
    provider: { subscribe: (sub, emit, fail) => subscribe(sub.id, sub.config ?? {}, emit, fail) },
    http,
    synced() {
      accountsSynced = true;
    },
    accountsChanged,
    deliveryNote,
    keyChanged(present) {
      if (present === !noKey) return;
      noKey = !present;
      // Said only when a trigger listens: a hub that never had a key has nothing to say.
      if (noKey) {
        realtime.stop();
        if (holders())
          ctx.log.warn("composio: Composio has no key now: the apps' events are not taken (its realtime channel is closed, webhooks are answered and left out) until a key is stored again");
        return;
      }
      if (!holders()) return;
      ctx.log.info("composio: Composio has a key again: the apps' events are taken again");
      if (wantChannel()) realtime.start();
    },
    async close() {
      closed = true;
      for (const t of disableTimers.values()) clearTimeout(t);
      disableTimers.clear();
      clearTimeout(reconcileTimer);
      stopRefresh();
      stopCheck();
      realtime.stop();
    },
  };
}
