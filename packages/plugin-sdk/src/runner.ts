// Plugin process entry: `node runner.ts <absolute path to plugin server entry>`.
// Talks JSON-RPC (NDJSON) with the core over stdin/stdout; console output goes to stderr.

import { pathToFileURL } from "node:url";
import { createRpcPeer, ndjsonTransport, DEFAULT_LOCALE, isLocale, translator } from "@piomio/shared";
import type { ToolCallContext, ToolResult, BrainSessionOptions, BrainTurn, OutboundMessage, Catalog, CatalogEntryState, Locale, Translate } from "@piomio/shared";
import type {
  BrainLoginImpl,
  BrainProviderImpl,
  BrainSessionImpl,
  ChannelImpl,
  PluginContext,
  PluginHttpRequest,
  PluginHttpResponse,
  PluginModule,
  ToolHandler,
} from "./types.ts";

// Keep stdout clean for RPC.
const toStderr = (...args: unknown[]) => process.stderr.write(args.map(fmt).join(" ") + "\n");
function fmt(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack ?? a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
console.warn = toStderr;

const entry = process.argv[2];
if (!entry) {
  toStderr("usage: runner.ts <plugin entry>");
  process.exit(2);
}

const peer = createRpcPeer(ndjsonTransport(process.stdin, process.stdout));
peer.onClose(() => process.exit(0));

const toolHandlers = new Map<string, ToolHandler>();
const brains = new Map<string, BrainProviderImpl>();
const brainSessions = new Map<string, BrainSessionImpl>();
const brainLogins = new Map<string, BrainLoginImpl>();
const channels = new Map<string, ChannelImpl>();
const hookHandlers = new Map<string, (p: any) => any>();
const eventHandlers = new Map<string, Array<(p: any) => void>>();
const settingsCbs: Array<(s: Record<string, any>) => void> = [];
const uiMessageCbs: Array<(p: any) => void> = [];
/** Cards shown by the tool calls in progress (ctx.widgets.show), by call id: they travel in the result's _meta. */
const callWidgets = new Map<string, Array<{ kind: string; data: unknown }>>();
const localeCbs: Array<(l: Locale) => void> = [];
let hubLocale: Locale = DEFAULT_LOCALE;
let messages: Catalog = {};
const translators = new Map<Locale, Translate>();
const translate = (locale: Locale): Translate => {
  let t = translators.get(locale);
  if (!t) translators.set(locale, (t = translator(messages, locale)));
  return t;
};
let httpHandler: ((req: PluginHttpRequest) => Promise<PluginHttpResponse> | PluginHttpResponse) | undefined;
let signInHandler: ((entryId: string) => Promise<{ url: string }> | { url: string }) | undefined;
let signOutHandler: ((entryId: string) => Promise<void> | void) | undefined;
let mod: PluginModule | undefined;

/** Hub events this process hears: one subscription per name, however many handlers (the hub sends each event once). */
const subscribed = new Set<string>();
function subscribe(name: string): Promise<void> {
  if (subscribed.has(name)) return Promise.resolve();
  subscribed.add(name);
  return peer.request("events.subscribe", { names: [name] }).then(
    () => undefined,
    () => void subscribed.delete(name),
  );
}

// ---------- vault: an item that does not exist is remembered until the vault changes ----------
// Plugins ask for their keys whenever they need them (a Telegram bot waiting for its token, a brain probed for its API
// key): without this every such ask reaches the hub and its audit log. The answer "no such item" is kept until the hub
// says the vault changed, and at most an hour in case an event was missed.

const VAULT_EVENTS = ["vault.updated", "vault.state"] as const;
const VAULT_MISSING_TTL_MS = 3600_000;
const vaultMissing = new Map<string, { error: unknown; at: number }>();
let vaultWatched = false;

const vaultIdOf = (ref: unknown) => String(ref ?? "").replace(/^vault:\/\//, "");

function forgetMissing(name: string, payload: any): void {
  if (name === "vault.updated" && Array.isArray(payload?.ids)) for (const id of payload.ids) vaultMissing.delete(vaultIdOf(id));
  else vaultMissing.clear();
}

async function vaultGet(ref: string, opts: Record<string, unknown> | undefined): Promise<Record<string, string>> {
  const id = vaultIdOf(ref);
  const missing = vaultMissing.get(id);
  if (missing && Date.now() - missing.at < VAULT_MISSING_TTL_MS) throw missing.error;
  vaultMissing.delete(id);
  try {
    return await peer.request<Record<string, string>>("vault.get", { ref, ...opts });
  } catch (e: any) {
    if (e?.data?.key !== "vault.notFound") throw e;
    if (!vaultWatched) {
      // Start hearing about changes, then ask once more: the item may have been stored in between.
      vaultWatched = true;
      await Promise.all(VAULT_EVENTS.map(subscribe));
      return vaultGet(ref, opts);
    }
    vaultMissing.set(id, { error: e, at: Date.now() });
    throw e;
  }
}

peer.handle("plugin.activate", async (p: { pluginId: string; dataDir: string; pluginDir: string; hubUrl: string; appRoot: string; settings: any; locale?: string; messages?: Catalog }) => {
  hubLocale = isLocale(p.locale) ? p.locale : DEFAULT_LOCALE;
  messages = p.messages ?? {};
  translators.clear();
  const imported = await import(pathToFileURL(entry).href);
  mod = (imported.default ?? imported) as PluginModule;
  if (typeof mod.activate !== "function") throw new Error("plugin module must export activate(ctx)");
  const log = (level: string) => (...args: unknown[]) => peer.notify("log", { level, msg: args.map(fmt).join(" ") });
  const ctx: PluginContext = {
    pluginId: p.pluginId,
    pluginDir: p.pluginDir,
    dataDir: p.dataDir,
    hubUrl: p.hubUrl,
    appRoot: p.appRoot,
    settings: p.settings ?? {},
    onSettingsChange: (cb) => settingsCbs.push(cb),
    i18n: {
      locale: () => hubLocale,
      t: (key, params, locale) => translate(locale && isLocale(locale) ? locale : hubLocale)(key, params),
      onChange: (cb) => localeCbs.push(cb),
    },
    log: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    tools: {
      register(tool) {
        const { handler, ...spec } = tool;
        toolHandlers.set(spec.name, handler);
        void peer.request("register.tool", { spec });
      },
      unregister(name) {
        toolHandlers.delete(name);
        void peer.request("unregister.tool", { name });
      },
    },
    catalog: {
      update(entries: CatalogEntryState[]) {
        void peer.request("catalog.update", { entries: JSON.parse(JSON.stringify(entries ?? [])) }).catch((e) => toStderr("catalog.update failed", e));
      },
      onSignIn(handler) {
        signInHandler = handler;
      },
      onSignOut(handler) {
        signOutHandler = handler;
      },
    },
    brains: {
      register(provider) {
        brains.set(provider.id, provider);
        void peer.request("register.brain", { id: provider.id, label: provider.label, variants: provider.variants, login: typeof provider.login === "function" });
      },
    },
    channels: {
      register(channel) {
        channels.set(channel.id, channel);
        void peer.request("register.channel", { id: channel.id, label: channel.label });
      },
    },
    events: {
      on(name, cb) {
        const list = eventHandlers.get(name) ?? [];
        list.push(cb);
        eventHandlers.set(name, list);
        void subscribe(name);
      },
    },
    hooks: {
      on(hook, handler) {
        hookHandlers.set(hook, handler as (p: any) => any);
        void peer.request("register.hook", { hook });
      },
    },
    http: {
      handle(handler) {
        httpHandler = handler;
        void peer.request("register.http", {});
      },
    },
    signals: {
      emit() {
        throw new Error("signals arrive in the next task");
      },
      provide() {
        throw new Error("signals arrive in the next task");
      },
    },
    widgets: {
      show(call, kind, data) {
        const list = call?.callId ? callWidgets.get(call.callId) : undefined;
        if (!list) throw new Error("widgets.show: call it inside a tool handler, with the handler's context");
        list.push({ kind: String(kind), data: JSON.parse(JSON.stringify(data ?? null)) });
      },
    },
    ui: {
      emit(channel, payload) {
        void peer.request("core.call", { method: "ui.emit", params: { channel, payload } }).catch(() => {});
      },
      onMessage(cb) {
        uiMessageCbs.push(cb);
      },
    },
    vault: {
      get: (ref, opts) => vaultGet(ref, opts),
    },
    storage: {
      get: (key) => peer.request("storage.get", { key }),
      set: async (key, value) => {
        await peer.request("storage.set", { key, value });
      },
      delete: async (key) => {
        await peer.request("storage.delete", { key });
      },
      list: (prefix) => peer.request("storage.list", { prefix }),
    },
    core: {
      call: (method, params) => peer.request("core.call", { method, params }),
    },
  };
  ctx.settings = p.settings ?? {};
  await mod.activate(ctx);
  // Registration requests above are fire-and-forget; flush them before reporting ready.
  await peer.request("plugin.ready", {});
  return {};
});

peer.handle("plugin.deactivate", async () => {
  try {
    await mod?.deactivate?.();
  } finally {
    setTimeout(() => process.exit(0), 50);
  }
  return {};
});

peer.onNotification("settings.changed", (p: { settings: Record<string, any> }) => {
  for (const cb of settingsCbs) cb(p.settings);
});

peer.onNotification("locale.changed", (p: { locale: Locale }) => {
  if (!isLocale(p.locale)) return;
  hubLocale = p.locale;
  for (const cb of localeCbs) cb(p.locale);
});

peer.onNotification("event", (p: { name: string; payload: unknown }) => {
  // First the runner's own memory of missing items, so a handler that asks the vault again gets a fresh answer.
  if ((VAULT_EVENTS as readonly string[]).includes(p.name)) forgetMissing(p.name, p.payload);
  for (const cb of eventHandlers.get(p.name) ?? []) {
    try {
      cb(p.payload);
    } catch (e) {
      toStderr("event handler error", e);
    }
  }
});

peer.onNotification("ui.message", (p: { payload: unknown }) => {
  for (const cb of uiMessageCbs) cb(p.payload);
});

peer.handle("tool.invoke", async (p: { name: string; input: unknown; context: ToolCallContext }): Promise<ToolResult> => {
  const h = toolHandlers.get(p.name);
  if (!h) throw new Error(`unknown tool ${p.name}`);
  const callId = p.context?.callId;
  const widgets: Array<{ kind: string; data: unknown }> = [];
  if (callId) callWidgets.set(callId, widgets);
  try {
    const r = await h(p.input ?? {}, p.context);
    const result: ToolResult = typeof r === "string" ? { content: [{ type: "text", text: r }] } : r;
    if (!widgets.length) return result;
    return { ...result, _meta: { ...result._meta, widgets: [...(result._meta?.widgets ?? []), ...widgets] } };
  } catch (e: any) {
    return { content: [{ type: "text", text: `Error: ${e?.message ?? String(e)}` }], isError: true };
  } finally {
    if (callId && callWidgets.get(callId) === widgets) callWidgets.delete(callId);
  }
});

peer.handle("hook.run", async (p: { hook: string; payload: unknown }) => {
  const h = hookHandlers.get(p.hook);
  return h ? ((await h(p.payload)) ?? null) : null;
});

peer.handle("catalog.signin", async (p: { entryId: string }) => {
  if (!signInHandler) throw new Error("this plugin has no catalog sign-in");
  const r = await signInHandler(String(p.entryId));
  if (!r?.url) throw new Error("the plugin gave no sign-in address");
  return { url: String(r.url) };
});

peer.handle("catalog.signout", async (p: { entryId: string }) => {
  if (!signOutHandler) throw new Error("this plugin has no catalog sign-out");
  await signOutHandler(String(p.entryId));
  return {};
});

peer.handle("http.request", async (req: PluginHttpRequest) => {
  if (!httpHandler) return { status: 404, body: { error: "no http handler" } };
  return (await httpHandler(req)) ?? { status: 204 };
});

peer.handle("channel.send", async (p: { channelId: string; message: OutboundMessage }) => {
  const ch = channels.get(p.channelId);
  if (!ch) throw new Error(`unknown channel ${p.channelId}`);
  return (await ch.send(p.message)) ?? {};
});

peer.handle("channel.status", async (p: { channelId: string }) => {
  const ch = channels.get(p.channelId);
  if (!ch) throw new Error(`unknown channel ${p.channelId}`);
  return ch.status ? await ch.status() : { connected: true };
});

peer.handle("brain.probe", async (p: { brainId: string; variant?: string }) => {
  const b = brains.get(p.brainId);
  if (!b) throw new Error(`unknown brain ${p.brainId}`);
  return b.probe(p.variant);
});

peer.handle("brain.create", async (p: { brainId: string; opts: BrainSessionOptions }) => {
  const b = brains.get(p.brainId);
  if (!b) throw new Error(`unknown brain ${p.brainId}`);
  const s = await b.createSession(p.opts);
  brainSessions.set(p.opts.sessionId, s);
  return {};
});

peer.handle("brain.send", async (p: { sessionId: string; turn: BrainTurn }) => {
  const s = brainSessions.get(p.sessionId);
  if (!s) throw new Error(`unknown brain session ${p.sessionId}`);
  try {
    for await (const event of s.send(p.turn)) {
      peer.notify("brain.event", { sessionId: p.sessionId, event });
    }
  } catch (e: any) {
    peer.notify("brain.event", { sessionId: p.sessionId, event: { type: "error", message: e?.message ?? String(e), fatal: true } });
  }
  return {};
});

// More input for the turn in progress; `accepted: false` sends it as the next turn (also brains without steer()).
peer.handle("brain.steer", async (p: { sessionId: string; turn: BrainTurn }) => {
  const s = brainSessions.get(p.sessionId);
  return { accepted: !!(s?.steer && (await s.steer(p.turn))) };
});

peer.handle("brain.warm", async (p: { sessionId: string }) => {
  await brainSessions.get(p.sessionId)?.warm?.();
  return {};
});

peer.handle("brain.interrupt", async (p: { sessionId: string }) => {
  await brainSessions.get(p.sessionId)?.interrupt();
  return {};
});

peer.handle("brain.close", async (p: { sessionId: string }) => {
  const s = brainSessions.get(p.sessionId);
  brainSessions.delete(p.sessionId);
  await s?.close();
  return {};
});

// Sign-in from the chat: updates go to the hub as "brain.login" notifications, the final one included.
peer.handle("brain.login.start", async (p: { brainId: string; loginId: string; env?: Record<string, string> }) => {
  const b = brains.get(p.brainId);
  if (!b?.login) throw new Error(`brain ${p.brainId} cannot sign in from the chat`);
  const notify = (update: unknown) => peer.notify("brain.login", { loginId: p.loginId, update });
  const login = await b.login({ env: p.env ?? {}, onUpdate: notify });
  brainLogins.set(p.loginId, login);
  void login.done
    .catch((e: any) => ({ status: "failed" as const, error: e?.message ?? String(e) }))
    .then((final) => {
      brainLogins.delete(p.loginId);
      notify(final);
    });
  return {};
});

peer.handle("brain.login.code", async (p: { loginId: string; code: string }) => {
  const login = brainLogins.get(p.loginId);
  if (!login?.submitCode) throw new Error("this sign-in does not take a code");
  await login.submitCode(String(p.code ?? ""));
  return {};
});

peer.handle("brain.login.cancel", async (p: { loginId: string }) => {
  brainLogins.get(p.loginId)?.cancel();
  return {};
});

process.on("uncaughtException", (e) => toStderr("uncaught", e));
process.on("unhandledRejection", (e) => toStderr("unhandled rejection", e));
