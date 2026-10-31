// Test harness: runs a plugin's server entry in a real child process (through the SDK runner) and plays
// the role of the core over JSON-RPC. Use in vitest to test plugins end-to-end without the hub.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrainEvent, BrainSessionOptions, BrainTurn, CatalogEntryState, Locale, OutboundMessage, ProbeResult, ToolCallContext, ToolResult, ToolSpec } from "@piomio/shared";
import { createRpcPeer, ndjsonTransport, readPluginLayout, type RpcPeer } from "@piomio/shared";

const APP_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

export interface HarnessOptions {
  /** Plugin directory (contains .piomio-plugin/plugin.json). */
  dir: string;
  settings?: Record<string, unknown>;
  /** Vault items by id → fields. */
  vault?: Record<string, Record<string, string>>;
  /** Core API implementation (ctx.core.call). */
  core?: (method: string, params: any) => unknown | Promise<unknown>;
  dataDir?: string;
  hubUrl?: string;
  env?: Record<string, string>;
  /** Hub language the plugin starts with (default "en"). */
  locale?: Locale;
  /** The plugin's storage (ctx.storage); pass the same map to a restarted plugin to keep it. */
  storage?: Map<string, unknown>;
}

export interface PluginHarness {
  peer: RpcPeer;
  child: ChildProcess;
  dataDir: string;
  /** The plugin's storage (ctx.storage). */
  storage: Map<string, unknown>;
  tools: Map<string, ToolSpec>;
  brains: Map<string, string>;
  channels: Map<string, string>;
  hooks: Set<string>;
  subscriptions: Set<string>;
  logs: string[];
  coreCalls: Array<{ method: string; params: any }>;
  /** Ids of every vault.get that reached the "hub", in order. */
  vaultGets: string[];
  /** The plugin's last report of its catalog entries (ctx.catalog.update), and every report in order. */
  catalog: CatalogEntryState[];
  catalogReports: CatalogEntryState[][];
  /** The person pressed an entry's Sign in / Sign out. */
  catalogSignIn(entryId: string): Promise<{ url: string }>;
  catalogSignOut(entryId: string): Promise<void>;
  /**
   * Store (or with no fields, remove) a vault item, and tell the plugin like the hub does: a "vault.updated" event
   * when it subscribed to it.
   */
  setVault(id: string, fields?: Record<string, string>): void;
  invoke(name: string, input?: unknown, ctx?: Partial<ToolCallContext>): Promise<ToolResult>;
  /** Text of a tool result (all text parts joined). */
  invokeText(name: string, input?: unknown, ctx?: Partial<ToolCallContext>): Promise<string>;
  http(req: { method?: string; path: string; query?: Record<string, string>; headers?: Record<string, string>; body?: unknown; public?: boolean; locale?: Locale }): Promise<{ status?: number; headers?: Record<string, string>; body?: unknown }>;
  hook(name: string, payload: unknown): Promise<unknown>;
  emit(event: string, payload: unknown): void;
  uiMessage(payload: unknown): void;
  setSettings(settings: Record<string, unknown>): void;
  /** Change the hub language (ctx.i18n.onChange fires in the plugin). */
  setLocale(locale: Locale): void;
  channelSend(id: string, message: OutboundMessage): Promise<unknown>;
  brainProbe(id: string, variant?: string): Promise<ProbeResult>;
  brainCreate(id: string, opts: BrainSessionOptions): Promise<void>;
  brainSend(sessionId: string, turn: BrainTurn): Promise<BrainEvent[]>;
  /** More input for the turn in progress; resolves with whether the brain took it. */
  brainSteer(sessionId: string, turn: BrainTurn): Promise<boolean>;
  brainInterrupt(sessionId: string): Promise<void>;
  brainClose(sessionId: string): Promise<void>;
  stop(): Promise<void>;
}

export function defaultContext(over: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    sessionId: "s_test",
    conversationId: "c_test",
    agentId: "assistant",
    callId: "call_test",
    tainted: false,
    background: false,
    workspace: over.workspace ?? mkdtempSync(join(tmpdir(), "owl-ws-")),
    machineId: "local",
    ...over,
  };
}

export async function startPlugin(o: HarnessOptions): Promise<PluginHarness> {
  const layout = readPluginLayout(resolve(o.dir));
  if (!layout.serverEntry) throw new Error(`plugin at ${o.dir} has no server entry`);
  const dataDir = o.dataDir ?? mkdtempSync(join(tmpdir(), `owl-plugin-${layout.manifest.id}-`));
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(APP_ROOT, "packages", "plugin-sdk", "src", "runner.ts"), layout.serverEntry], {
    cwd: layout.dir,
    env: { ...process.env, HOME: dataDir, ...o.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const logs: string[] = [];
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (c: string) => logs.push(...c.split("\n").filter(Boolean)));
  const peer = createRpcPeer(ndjsonTransport(child.stdout!, child.stdin!));

  const tools = new Map<string, ToolSpec>();
  const brains = new Map<string, string>();
  const channels = new Map<string, string>();
  const hooks = new Set<string>();
  const subscriptions = new Set<string>();
  const kv = o.storage ?? new Map<string, unknown>();
  const coreCalls: Array<{ method: string; params: any }> = [];
  const brainEvents = new Map<string, BrainEvent[]>();

  peer.onNotification("log", (p: { level: string; msg: string }) => logs.push(`[${p.level}] ${p.msg}`));
  peer.onNotification("brain.event", (p: { sessionId: string; event: BrainEvent }) => brainEvents.get(p.sessionId)?.push(p.event));
  peer.handle("register.tool", (p: { spec: ToolSpec }) => {
    tools.set(p.spec.name, p.spec);
    return {};
  });
  peer.handle("unregister.tool", (p: { name: string }) => {
    tools.delete(p.name);
    return {};
  });
  const catalogReports: CatalogEntryState[][] = [];
  peer.handle("catalog.update", (p: { entries: CatalogEntryState[] }) => {
    catalogReports.push(p.entries);
    return {};
  });
  peer.handle("register.brain", (p: { id: string; label: string }) => {
    brains.set(p.id, p.label);
    return {};
  });
  peer.handle("register.channel", (p: { id: string; label: string }) => {
    channels.set(p.id, p.label);
    return {};
  });
  peer.handle("register.hook", (p: { hook: string }) => {
    hooks.add(p.hook);
    return {};
  });
  peer.handle("register.http", () => ({}));
  peer.handle("events.subscribe", (p: { names: string[] }) => {
    p.names.forEach((n) => subscriptions.add(n));
    return {};
  });
  const vault: Record<string, Record<string, string>> = o.vault ?? {};
  const vaultGets: string[] = [];
  peer.handle("vault.get", (p: { ref: string }) => {
    const id = p.ref.replace(/^vault:\/\//, "");
    vaultGets.push(id);
    const item = vault[id];
    if (!item) {
      // The hub's error: English message, key and hub-language text in the RPC error data.
      const text = `No vault item vault://${id}`;
      throw Object.assign(new Error(text), { rpcData: { key: "vault.notFound", params: { id }, text } });
    }
    return item;
  });
  peer.handle("storage.get", (p: { key: string }) => kv.get(p.key) ?? null);
  peer.handle("storage.set", (p: { key: string; value: unknown }) => {
    kv.set(p.key, p.value);
    return {};
  });
  peer.handle("storage.delete", (p: { key: string }) => {
    kv.delete(p.key);
    return {};
  });
  peer.handle("storage.list", (p: { prefix?: string }) =>
    [...kv.entries()].filter(([k]) => k.startsWith(p.prefix ?? "")).map(([key, value]) => ({ key, value })),
  );
  peer.handle("core.call", async (p: { method: string; params: any }) => {
    coreCalls.push(p);
    if (!o.core) return {};
    return (await o.core(p.method, p.params)) ?? {};
  });
  let currentLocale: Locale = o.locale ?? "en";
  let ready!: () => void;
  const readyP = new Promise<void>((r) => (ready = r));
  peer.handle("plugin.ready", () => {
    ready();
    return {};
  });

  await peer.request(
    "plugin.activate",
    {
      pluginId: layout.manifest.id,
      dataDir,
      pluginDir: layout.dir,
      hubUrl: o.hubUrl ?? "http://127.0.0.1:1",
      appRoot: APP_ROOT,
      settings: o.settings ?? {},
      locale: currentLocale,
      messages: layout.messages,
    },
    { timeoutMs: 60_000 },
  ).catch((e) => {
    throw new Error(`${e.message}\n--- plugin stderr ---\n${logs.join("\n")}`);
  });
  await readyP;

  const h: PluginHarness = {
    peer,
    child,
    dataDir,
    storage: kv,
    tools,
    brains,
    channels,
    hooks,
    subscriptions,
    logs,
    coreCalls,
    vaultGets,
    get catalog() {
      return catalogReports.at(-1) ?? [];
    },
    catalogReports,
    catalogSignIn: (entryId) => peer.request("catalog.signin", { entryId }, { timeoutMs: 60_000 }),
    catalogSignOut: async (entryId) => {
      await peer.request("catalog.signout", { entryId }, { timeoutMs: 60_000 });
    },
    setVault(id, fields) {
      if (fields) vault[id] = fields;
      else delete vault[id];
      if (subscriptions.has("vault.updated")) peer.notify("event", { name: "vault.updated", payload: { ids: [id] } });
    },
    invoke: (name, input = {}, ctx) => peer.request<ToolResult>("tool.invoke", { name, input, context: defaultContext(ctx) }, { timeoutMs: 120_000 }),
    async invokeText(name, input, ctx) {
      const r = await h.invoke(name, input, ctx);
      return r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
    },
    http: (req) => peer.request("http.request", { method: "GET", query: {}, headers: {}, body: null, public: false, locale: currentLocale, ...req }),
    hook: (name, payload) => peer.request("hook.run", { hook: name, payload }),
    emit: (event, payload) => peer.notify("event", { name: event, payload }),
    uiMessage: (payload) => peer.notify("ui.message", { payload }),
    setSettings: (settings) => peer.notify("settings.changed", { settings }),
    setLocale: (locale) => {
      currentLocale = locale;
      peer.notify("locale.changed", { locale });
    },
    channelSend: (id, message) => peer.request("channel.send", { channelId: id, message }),
    brainProbe: (id, variant) => peer.request("brain.probe", { brainId: id, variant }, { timeoutMs: 30_000 }),
    brainCreate: async (id, opts) => {
      await peer.request("brain.create", { brainId: id, opts }, { timeoutMs: 60_000 });
    },
    async brainSend(sessionId, turn) {
      const events: BrainEvent[] = [];
      brainEvents.set(sessionId, events);
      await peer.request("brain.send", { sessionId, turn }, { timeoutMs: 300_000 });
      brainEvents.delete(sessionId);
      return events;
    },
    brainSteer: async (sessionId, turn) => {
      const r = await peer.request<{ accepted: boolean }>("brain.steer", { sessionId, turn });
      return r.accepted;
    },
    brainInterrupt: async (sessionId) => {
      await peer.request("brain.interrupt", { sessionId });
    },
    brainClose: async (sessionId) => {
      await peer.request("brain.close", { sessionId });
    },
    async stop() {
      try {
        await peer.request("plugin.deactivate", {}, { timeoutMs: 3000 });
      } catch {
        /* already gone */
      }
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      peer.close();
    },
  };
  return h;
}
