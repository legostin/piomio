// Composio's REST API v3.1, the part the integration uses: apps (toolkits), sign-ins (auth configs, connect links,
// connected accounts), tools and running them. Every request carries the key as x-api-key; failures come back as a
// ComposioError whose kind says what the person or the agent can do about it.

import type { JsonSchema } from "@piomio/shared";

export const DEFAULT_API = "https://backend.composio.dev/api/v3.1";

/**
 * key: the key was refused (401); limit: the plan's calls are used up (402); rate: too many calls just now (429);
 * down: Composio is unreachable or failing; other: the request itself (403 is an account without access to that
 * channel or repository, not a bad key).
 */
export type ComposioErrorKind = "key" | "limit" | "rate" | "down" | "other";

export class ComposioError extends Error {
  status: number;
  kind: ComposioErrorKind;
  /** `kind` defaults to what the status says. */
  constructor(status: number, message: string, kind?: ComposioErrorKind) {
    super(message);
    this.status = status;
    this.kind = kind ?? (status === 401 ? "key" : status === 402 ? "limit" : status === 429 ? "rate" : status === 0 || status >= 500 ? "down" : "other");
  }
}

/** A success answer without what it should hold: Composio answered, so it is the request's problem, not an outage. */
const malformed = (message: string) => new ComposioError(502, message, "other");

/**
 * The project's webhook subscription goes somewhere this hub did not set up (the person's own server): the hub leaves
 * it alone. `host` is where it goes.
 */
export class WebhookTaken extends ComposioError {
  host: string;
  constructor(host: string) {
    super(409, `Composio's project already sends its webhook to ${host}, which this hub did not set up; the hub leaves it alone`, "other");
    this.host = host;
  }
}

/** A hub's own webhook address (any hub's: an earlier address of this one, or another replica's). */
const HUB_HOOK_RE = /^https:\/\/[^/]+\/hooks\/composio\/events$/;

/** The webhook event the hub's subscription is for. */
export const TRIGGER_MESSAGE = "composio.trigger.message";

/**
 * Of the project's webhook subscriptions, the hub's own one for `url` (it goes there, or it is the kept one and still
 * goes to a hub's address), else the one that is someone else's.
 */
export function ownWebhook(list: WebhookSubscription[], url: string, keptId?: string): { mine?: WebhookSubscription; theirs?: WebhookSubscription } {
  const kept = keptId ? list.find((w) => w.id === keptId) : undefined;
  const mine = list.find((w) => w.url === url) ?? (kept && HUB_HOOK_RE.test(kept.url) ? kept : undefined);
  if (mine) return { mine };
  const theirs = kept ?? list.find((w) => w.events.includes(TRIGGER_MESSAGE)) ?? list[0];
  return theirs ? { theirs } : {};
}

/** Where a webhook goes, for people and logs: its host. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || "another address";
  } catch {
    return "another address";
  }
}

/** An app of Composio's (a toolkit). `managed`: Composio signs in to it with its own OAuth app. */
export interface Toolkit {
  slug: string;
  name: string;
  description: string;
  managed: boolean;
}

export interface ComposioTool {
  /** "SLACK_SEND_MESSAGE". */
  slug: string;
  /** "Send message". */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  tags: string[];
  version?: string;
  toolkit: string;
}

/** A connected account: ACTIVE works; INITIATED / INITIALIZING wait for the sign-in; anything else stopped working. */
export interface Account {
  id: string;
  status: string;
  toolkit: string;
  reason?: string;
}

export interface Link {
  url: string;
  accountId: string;
  expiresAt?: string;
}

export interface ComposioApi {
  toolkits(search: string, limit?: number): Promise<Toolkit[]>;
  toolkit(slug: string): Promise<Toolkit>;
  createAuthConfig(slug: string): Promise<string>;
  link(authConfigId: string, userId: string): Promise<Link>;
  account(id: string): Promise<Account>;
  deleteAccount(id: string): Promise<void>;
  tools(slug: string, opts: { important?: boolean; query?: string; limit: number }): Promise<ComposioTool[]>;
  execute(tool: string, opts: { userId: string; accountId: string; args: Record<string, unknown>; version?: string }): Promise<{ ok: boolean; data: unknown; error?: string }>;
  /** Trigger types of the given apps (all pages; Composio pages by 50). */
  listTriggerTypes(toolkits: string[]): Promise<TriggerType[]>;
  getTriggerType(slug: string): Promise<TriggerType>;
  /** Creates the trigger instance, or updates the one that matches (same type and account). */
  upsertTriggerInstance(slug: string, opts: { connectedAccountId?: string; userId?: string; config: Record<string, unknown>; type?: "poll" | "webhook"; pollingInterval?: number }): Promise<TriggerUpsert>;
  listActiveTriggers(filters?: { connectedAccountIds?: string[]; userIds?: string[]; triggerIds?: string[]; triggerNames?: string[]; showDisabled?: boolean }): Promise<TriggerInstance[]>;
  setTriggerEnabled(id: string, enabled: boolean): Promise<void>;
  deleteTrigger(id: string): Promise<void>;
  /**
   * The project's webhook subscription for trigger messages at `url`, made when there is none. Composio keeps one per
   * project (a second is a 409): the one there is used only when it is the hub's own (it goes to `url`, or it is
   * `keptId` and still goes to a hub's address), and only `url` and the trigger-message event are added to it, its other
   * events kept. Any other is left as it is: WebhookTaken says where it goes.
   */
  createWebhookSubscription(url: string, keptId?: string): Promise<WebhookSubscription>;
  getWebhookSubscription(id: string): Promise<WebhookSubscription>;
  /** The project's webhook subscriptions, without their secrets. */
  listWebhookSubscriptions(): Promise<WebhookSubscription[]>;
  /** Composio's internal realtime channel (Pusher) for projects without a public address. Undocumented, may change. */
  realtimeCredentials(): Promise<RealtimeCredentials>;
  /** The private channel's authorisation for one socket (Pusher's `auth`), asked for as pusher-js does. */
  realtimeAuth(socketId: string, channel: string): Promise<string>;
}

/** What a trigger type listens to: its settings (`config`, a JSON schema) and the shape of its events (`payload`). */
export interface TriggerType {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  /** "webhook" (instant) and / or "poll" (up to the polling interval; 2 minutes at the shortest). */
  types: string[];
  toolkit: string;
  config: JsonSchema;
  payload: JsonSchema;
  /** The upstream provider needs a Composio-issued URL registered by hand. */
  requiresWebhookSetup: boolean;
}

export interface TriggerUpsert {
  id: string;
  type: string;
  /** Set when a webhook trigger was downgraded to polling. */
  fallbackReason: string | null;
  pollingInterval: number | null;
  created: boolean;
}

export interface TriggerInstance {
  id: string;
  trigger: string;
  account: string;
  config: Record<string, unknown>;
  disabled: boolean;
}

export interface WebhookSubscription {
  id: string;
  url: string;
  /** Returned by create and by get (not by the list); kept only in hub storage. */
  secret: string;
  /** The events it is for ("composio.trigger.message"…). */
  events: string[];
}

export interface RealtimeCredentials {
  pusherKey: string;
  projectId: string;
  cluster: string;
}

const PAGE = 50;
const TRIGGER_EVENT = TRIGGER_MESSAGE;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function toolkitOf(t: any): Toolkit {
  return {
    slug: str(t?.slug).toLowerCase(),
    name: str(t?.name) || str(t?.slug),
    description: str(t?.meta?.description),
    managed: Array.isArray(t?.composio_managed_auth_schemes) && t.composio_managed_auth_schemes.length > 0,
  };
}

function toolOf(t: any): ComposioTool {
  const schema = t?.input_parameters && typeof t.input_parameters === "object" ? t.input_parameters : { type: "object", properties: {} };
  return {
    slug: str(t?.slug),
    name: str(t?.name) || str(t?.slug),
    description: str(t?.description) || str(t?.human_description),
    inputSchema: { type: "object", ...schema },
    tags: Array.isArray(t?.tags) ? t.tags.filter((x: unknown) => typeof x === "string") : [],
    ...(str(t?.version) ? { version: str(t.version) } : {}),
    toolkit: str(t?.toolkit?.slug).toLowerCase(),
  };
}

function triggerTypeOf(t: any): TriggerType {
  return {
    slug: str(t?.slug),
    name: str(t?.name) || str(t?.slug),
    description: str(t?.description),
    instructions: str(t?.instructions),
    types: Array.isArray(t?.types) ? t.types.filter((x: unknown) => typeof x === "string") : [],
    toolkit: str(t?.toolkit?.slug).toLowerCase(),
    config: t?.config && typeof t.config === "object" ? t.config : { type: "object", properties: {} },
    payload: t?.payload && typeof t.payload === "object" ? t.payload : { type: "object", properties: {} },
    requiresWebhookSetup: t?.requires_webhook_endpoint_setup === true,
  };
}

function accountOf(a: any): Account {
  return { id: str(a?.id), status: str(a?.status).toUpperCase(), toolkit: str(a?.toolkit?.slug).toLowerCase(), ...(str(a?.status_reason) ? { reason: str(a.status_reason) } : {}) };
}

/** The API at `base` with the key `key()` gives (read from the vault on every request, so a new key works at once). */
export function composioApi(base: string, key: () => Promise<string>): ComposioApi {
  const root = base.replace(/\/+$/, "");
  // The internal SDK endpoints live under /api/v3, whatever version the rest of the calls use.
  const internalRoot = root.replace(/\/api\/v3(\.\d+)?$/, "/api/v3");
  /** A request; a URLSearchParams body goes as a form, any other as JSON. */
  async function call(method: string, path: string, body?: unknown, from = root): Promise<{ status: number; json: any }> {
    const form = body instanceof URLSearchParams;
    let res: Response;
    try {
      res = await fetch(`${from}${path}`, {
        method,
        headers: {
          "x-api-key": await key(),
          accept: "application/json",
          ...(body !== undefined ? { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" } : {}),
        },
        ...(body !== undefined ? { body: form ? body.toString() : JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e: any) {
      throw new ComposioError(0, e?.cause?.message ?? e?.message ?? String(e));
    }
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { message: text.slice(0, 300) };
    }
    if (!res.ok) throw new ComposioError(res.status, str(json?.error?.message) || str(json?.message) || str(json?.error) || `HTTP ${res.status}`);
    return { status: res.status, json };
  }
  const req = async <T = any>(method: string, path: string, body?: unknown, from?: string): Promise<T> => (await call(method, path, body, from)).json as T;
  /** Every item of a list call, following next_cursor. */
  async function pages(path: string, params: Record<string, string | number | boolean | undefined>): Promise<any[]> {
    const items: any[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 100; i++) {
      const r = await req("GET", `${path}?${q({ ...params, limit: PAGE, cursor })}`);
      if (Array.isArray(r?.items)) items.push(...r.items);
      cursor = str(r?.next_cursor) || undefined;
      if (!cursor) break;
    }
    return items;
  }
  const subscriptionOf = (r: any): WebhookSubscription => ({
    id: str(r?.id),
    url: str(r?.webhook_url),
    secret: str(r?.secret),
    events: Array.isArray(r?.enabled_events) ? r.enabled_events.filter((x: unknown) => typeof x === "string") : [],
  });
  const subscriptions = async () => (await pages("/webhook_subscriptions", {})).map(subscriptionOf).filter((s) => s.id);
  const q = (params: Record<string, string | number | boolean | undefined>) =>
    new URLSearchParams(Object.entries(params).flatMap(([k, v]): Array<[string, string]> => (v === undefined || v === "" ? [] : [[k, String(v)]]))).toString();

  return {
    async toolkits(search, limit = 10) {
      const r = await req("GET", `/toolkits?${q({ search, limit })}`);
      return (Array.isArray(r?.items) ? r.items : []).map(toolkitOf).filter((t: Toolkit) => t.slug);
    },
    async toolkit(slug) {
      return toolkitOf(await req("GET", `/toolkits/${encodeURIComponent(slug)}`));
    },
    async createAuthConfig(slug) {
      const r = await req("POST", "/auth_configs", { toolkit: { slug }, auth_config: { type: "use_composio_managed_auth" } });
      const id = str(r?.auth_config?.id) || str(r?.id);
      if (!id) throw malformed("Composio created no auth config");
      return id;
    },
    async link(authConfigId, userId) {
      const r = await req("POST", "/connected_accounts/link", { auth_config_id: authConfigId, user_id: userId });
      const url = str(r?.redirect_url);
      const accountId = str(r?.connected_account_id);
      if (!url || !accountId) throw malformed("Composio gave no sign-in link");
      return { url, accountId, ...(str(r?.expires_at) ? { expiresAt: str(r.expires_at) } : {}) };
    },
    async account(id) {
      return accountOf(await req("GET", `/connected_accounts/${encodeURIComponent(id)}`));
    },
    async deleteAccount(id) {
      try {
        await req("DELETE", `/connected_accounts/${encodeURIComponent(id)}`);
      } catch (e) {
        if (!(e instanceof ComposioError && e.status === 404)) throw e;
      }
    },
    async tools(slug, opts) {
      const r = await req("GET", `/tools?${q({ toolkit_slug: slug, important: opts.important ? "true" : undefined, query: opts.query, limit: opts.limit })}`);
      return (Array.isArray(r?.items) ? r.items : []).map(toolOf).filter((t: ComposioTool) => t.slug);
    },
    async execute(tool, opts) {
      const r = await req("POST", `/tools/execute/${encodeURIComponent(tool)}`, {
        connected_account_id: opts.accountId,
        user_id: opts.userId,
        arguments: opts.args,
        ...(opts.version ? { version: opts.version } : {}),
      });
      return { ok: r?.successful !== false && !r?.error, data: r?.data ?? null, ...(r?.error ? { error: typeof r.error === "string" ? r.error : JSON.stringify(r.error) } : {}) };
    },
    async listTriggerTypes(toolkits) {
      if (!toolkits.length) return [];
      return (await pages("/triggers_types", { toolkit_slugs: toolkits.join(","), toolkit_versions: "latest" })).map(triggerTypeOf).filter((t) => t.slug);
    },
    async getTriggerType(slug) {
      return triggerTypeOf(await req("GET", `/triggers_types/${encodeURIComponent(slug)}`));
    },
    async upsertTriggerInstance(slug, opts) {
      const { status, json } = await call("POST", `/trigger_instances/${encodeURIComponent(slug)}/upsert`, {
        ...(opts.connectedAccountId ? { connected_account_id: opts.connectedAccountId } : {}),
        ...(opts.userId ? { user_id: opts.userId } : {}),
        trigger_config: opts.config,
        ...(opts.type ? { type: opts.type } : {}),
        ...(opts.pollingInterval ? { polling_interval: opts.pollingInterval } : {}),
      });
      const id = str(json?.trigger_id);
      if (!id) throw malformed("Composio created no trigger");
      return { id, type: str(json?.type), fallbackReason: str(json?.fallback_reason) || null, pollingInterval: typeof json?.polling_interval === "number" ? json.polling_interval : null, created: status === 201 };
    },
    async listActiveTriggers(filters = {}) {
      const items = await pages("/trigger_instances/active", {
        connected_account_ids: filters.connectedAccountIds?.join(","),
        user_ids: filters.userIds?.join(","),
        trigger_ids: filters.triggerIds?.join(","),
        trigger_names: filters.triggerNames?.join(","),
        show_disabled: filters.showDisabled ? "true" : undefined,
      });
      return items
        .map((t): TriggerInstance => ({ id: str(t?.id), trigger: str(t?.trigger_name), account: str(t?.connected_account_id), config: t?.trigger_config && typeof t.trigger_config === "object" ? t.trigger_config : {}, disabled: !!t?.disabled_at }))
        .filter((t) => t.id);
    },
    async setTriggerEnabled(id, enabled) {
      await req("PATCH", `/trigger_instances/manage/${encodeURIComponent(id)}`, { status: enabled ? "enable" : "disable" });
    },
    async deleteTrigger(id) {
      try {
        await req("DELETE", `/trigger_instances/manage/${encodeURIComponent(id)}`);
      } catch (e) {
        if (!(e instanceof ComposioError && e.status === 404)) throw e;
      }
    },
    async createWebhookSubscription(url, keptId) {
      try {
        const r = subscriptionOf(await req("POST", "/webhook_subscriptions", { webhook_url: url, enabled_events: [TRIGGER_EVENT], version: "V3" }));
        if (!r.id) throw malformed("Composio created no webhook subscription");
        return r;
      } catch (e) {
        if (!(e instanceof ComposioError && e.status === 409)) throw e;
      }
      // One subscription per project, and it is there already: the hub's own one is used; the person's is never
      // changed (not its address, not its events).
      const { mine, theirs } = ownWebhook(await subscriptions(), url, keptId);
      if (!mine) {
        if (!theirs) throw new ComposioError(409, "Composio says a webhook subscription exists but lists none", "other");
        throw new WebhookTaken(hostOf(theirs.url));
      }
      const patch: Record<string, unknown> = {};
      if (mine.url !== url) patch.webhook_url = url;
      if (!mine.events.includes(TRIGGER_EVENT)) patch.enabled_events = [...mine.events, TRIGGER_EVENT];
      if (Object.keys(patch).length) await req("PATCH", `/webhook_subscriptions/${encodeURIComponent(mine.id)}`, patch);
      return subscriptionOf(await req("GET", `/webhook_subscriptions/${encodeURIComponent(mine.id)}`));
    },
    async getWebhookSubscription(id) {
      return subscriptionOf(await req("GET", `/webhook_subscriptions/${encodeURIComponent(id)}`));
    },
    listWebhookSubscriptions: subscriptions,
    async realtimeCredentials() {
      const r = await req("GET", "/internal/sdk/realtime/credentials", undefined, internalRoot);
      const c = { pusherKey: str(r?.pusher_key), projectId: str(r?.project_id), cluster: str(r?.pusher_cluster) };
      if (!c.pusherKey || !c.projectId || !c.cluster) throw malformed("Composio gave no realtime credentials");
      return c;
    },
    async realtimeAuth(socketId, channel) {
      const r = await req("POST", "/internal/sdk/realtime/auth", new URLSearchParams({ socket_id: socketId, channel_name: channel }), internalRoot);
      const auth = str(r?.auth);
      if (!auth) throw malformed("Composio gave no channel authorisation");
      return auth;
    },
  };
}
