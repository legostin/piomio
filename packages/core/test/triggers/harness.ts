// The old plugin's end-to-end harness, in process: the engine on a fake TriggerHost with the surface the SDK harness
// gave (tools, invoke, http, emit, coreCalls, subscriptions, setLocale), so the old tests read the same.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locale, ToolCallContext, ToolResult, ToolSpec } from "@piomio/shared";
import { tFor } from "../../src/i18n.ts";
import type { TriggerEngine } from "../../src/signals/engine.ts";
import type { TriggerHost, TriggerHttpRequest, TriggerHttpResponse, TriggerToolRegistration } from "../../src/signals/host.ts";
import { startTriggers } from "../../src/signals/index.ts";
import { memoryStore } from "../../src/signals/store.ts";

export interface TriggerHarnessOptions {
  settings?: Record<string, unknown>;
  /** The hub language (default "en"). */
  locale?: Locale;
  /** Answers the engine's core calls; undefined for the rest. */
  core?: (method: string, params: any) => unknown;
}

export interface TriggerHarness {
  engine: TriggerEngine;
  storage: Map<string, unknown>;
  /** Tools by short name. */
  tools: Map<string, ToolSpec>;
  /** Bus events the engine listens to. */
  subscriptions: Set<string>;
  /** Core calls and UI events (as method "ui.emit"), in order. */
  coreCalls: Array<{ method: string; params: any }>;
  invoke(name: string, input?: unknown, ctx?: Partial<ToolCallContext>): Promise<ToolResult>;
  invokeText(name: string, input?: unknown, ctx?: Partial<ToolCallContext>): Promise<string>;
  http(req: { method?: string; path: string; query?: Record<string, string>; headers?: Record<string, string>; body?: unknown; public?: boolean; locale?: Locale }): Promise<TriggerHttpResponse>;
  emit(event: string, payload: unknown): void;
  /** Change the hub language (and the default language of requests). */
  setLocale(locale: Locale): void;
  stop(): Promise<void>;
}

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

export async function startTriggerHarness(o: TriggerHarnessOptions = {}): Promise<TriggerHarness> {
  let locale: Locale = o.locale ?? "en";
  const storage = new Map<string, unknown>();
  const tools = new Map<string, ToolSpec>();
  const handlers = new Map<string, TriggerToolRegistration["handler"]>();
  const listeners = new Map<string, Array<(payload: any) => void>>();
  const subscriptions = new Set<string>();
  const coreCalls: Array<{ method: string; params: any }> = [];
  let handle: ((req: TriggerHttpRequest) => Promise<TriggerHttpResponse> | TriggerHttpResponse) | undefined;

  const host: TriggerHost = {
    pluginId: "triggers",
    hubUrl: "http://127.0.0.1:8080",
    settings: { ...(o.settings ?? {}) },
    onSettingsChange() {},
    i18n: { locale: () => locale, t: (key, params, l) => tFor(l ?? locale)(`triggers.${key}`, params) },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    tools: {
      register(r) {
        const { handler, ...spec } = r;
        tools.set(r.name, spec);
        handlers.set(r.name, handler);
      },
    },
    events: {
      on(name, cb) {
        subscriptions.add(name);
        listeners.set(name, [...(listeners.get(name) ?? []), cb]);
      },
    },
    http: { handle: (h) => void (handle = h) },
    ui: { emit: (channel, payload) => void coreCalls.push({ method: "ui.emit", params: { channel, payload } }) },
    storage: {
      get: async (k) => clone(storage.get(k)) as any,
      set: async (k, v) => void storage.set(k, clone(v)),
      delete: async (k) => void storage.delete(k),
      list: async (prefix = "") => [...storage.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value: clone(value) })),
    },
    store: memoryStore(),
    core: {
      call: async (method, params) => {
        coreCalls.push({ method, params });
        return (await o.core?.(method, params)) as any;
      },
    },
  };

  const engine = await startTriggers(host);
  const context = (over: Partial<ToolCallContext> = {}): ToolCallContext => ({
    sessionId: "s_test",
    conversationId: "c_test",
    agentId: "assistant",
    callId: "call_test",
    tainted: false,
    background: false,
    workspace: over.workspace ?? mkdtempSync(join(tmpdir(), "owl-ws-")),
    machineId: "local",
    ...over,
  });

  const h: TriggerHarness = {
    engine,
    storage,
    tools,
    subscriptions,
    coreCalls,
    async invoke(name, input = {}, ctx) {
      const fn = handlers.get(name);
      if (!fn) throw new Error(`unknown tool ${name}`);
      try {
        const r = await fn(input, context(ctx));
        return typeof r === "string" ? { content: [{ type: "text", text: r }] } : r;
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e?.message ?? String(e)}` }], isError: true };
      }
    },
    async invokeText(name, input, ctx) {
      const r = await h.invoke(name, input, ctx);
      return r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
    },
    async http(req) {
      if (!handle) throw new Error("the engine registered no HTTP handler");
      return handle({ method: "GET", query: {}, headers: {}, body: null, public: false, locale, ...req });
    },
    emit(event, payload) {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
    setLocale(l) {
      locale = l;
    },
    async stop() {
      engine.stop();
    },
  };
  return h;
}
