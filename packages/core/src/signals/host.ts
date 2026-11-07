// What the trigger engine needs from where it runs: the part of a plugin's context it used when it was the triggers
// plugin. Core gives it one (core-host.ts); tests give it a fake. Keeping that shape lets the engine and its tests move
// unchanged (docs/superpowers/specs/2026-11-07-unified-triggers-design.md, phase 1).

import type { CoreMethod, Locale, Params, ToolCallContext, ToolEffect, ToolResult, ToolSpec } from "@piomio/shared";
import type { QuickModel } from "../bare-ask.ts";
import type { TriggerStore } from "./store.ts";

export interface TriggerHttpRequest {
  method: string;
  /** Path after /api/plugins/triggers/http (or /hooks/triggers for public requests), starting with "/". */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  /** The body as it came in, kept for public webhooks so a signature can be checked on the exact bytes. */
  rawBody?: string;
  /** True for unauthenticated public webhooks: the engine checks the trigger's secret itself. */
  public: boolean;
  /** Language of whoever made the request; the hub language for public webhooks. */
  locale: Locale;
}

export interface TriggerHttpResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface TriggerToolRegistration extends ToolSpec {
  /** Short name; the hub exposes it as `trigger_<name>`. */
  name: string;
  /** The tool's whole name, when it should not carry the `trigger_` prefix (`signals_recent`). */
  fullName?: string;
  handler: (input: any, ctx: ToolCallContext) => Promise<ToolResult | string> | ToolResult | string;
  /**
   * What this very call does, when it is more or less than `effect` (the registry's ToolEffectOf): a create or update
   * that gives the script a host it did not have is an outside action. Undefined keeps `effect`.
   */
  effectOf?: (input: any, ctx: ToolCallContext) => ToolEffect | undefined;
  /** The approval card's text for a call, in the hub language (the registry's ToolDescriber). */
  describe?: (input: any) => string;
}

/**
 * A signal source beyond core's own four (plugins and the hub, from phase 3), as trigger_sources lists it. `sample` is
 * the data of a sample signal, for test runs; `external` defaults to true.
 */
export interface TriggerSourceInfo {
  type: string;
  description: string;
  source?: string;
  /** subscribe: it works only while a trigger subscribes, for each config (sources.ts); unset: broadcast. */
  mode?: "broadcast" | "subscribe";
  /** JSON Schema of its signals' data. */
  data?: unknown;
  config?: unknown;
  sample?: unknown;
  external?: boolean;
  online?: boolean;
}

/**
 * A request the watch (watch.ts fetchPage) or a trigger's script (pio.ts) makes: the global fetch, or core's through the
 * egress proxy (net.ts). GET unless `method` says otherwise (a script's POST to a read API).
 */
export type FetchLike = (
  url: string,
  init: { method?: string; body?: string; redirect?: "manual"; signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<Response>;

/**
 * What a trigger's pipeline (pipeline.ts) reaches beyond the engine: its agent's tools that only read, a fetch of its
 * own through the egress proxy for each script run, and the quick model (triage, pio.llm.ask). Core gives the real
 * ones (core-host.ts); without them the script's calls and the quick check fail, and the pipeline goes on as it does
 * when they are unavailable.
 */
export interface PipelineServices {
  /** A hub tool called for the trigger's agent (ToolGateway.callRead), its addresses held to `hosts`; `source`: outside content came back. */
  callRead(as: { agentId: string; triggerId: string; hosts: string[] }, name: string, input: unknown): Promise<{ result: ToolResult; source: boolean }>;
  /** A fetch for one script run, with an egress token of its own (owner trigger:<id>, allowlist `hosts`); `release` lets it go. */
  fetchFor(triggerId: string, hosts: string[]): { fetch: FetchLike; release(): void };
  quick: QuickModel;
}

export interface TriggerHost {
  /** "triggers": the webhook addresses (/hooks/triggers/<id>) and the UI events carry it. */
  pluginId: string;
  /** The hub's own address, for webhook URLs when it has no public one. */
  hubUrl: string;
  /** The Triggers card's settings (allowPrivateUrls, watchTimeoutSec). */
  settings: Record<string, any>;
  onSettingsChange(cb: (settings: Record<string, any>) => void): void;
  i18n: {
    /** The hub language. */
    locale(): Locale;
    /** The engine's message `key` in `locale` (default: the hub language). */
    t(key: string, params?: Params, locale?: Locale): string;
  };
  log: { debug(...a: unknown[]): void; info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  tools: { register(tool: TriggerToolRegistration): void };
  events: { on(name: "notification.feedback" | "agent.removed", cb: (payload: any) => void): void };
  http: { handle(handler: (req: TriggerHttpRequest) => Promise<TriggerHttpResponse> | TriggerHttpResponse): void };
  /** Tell the web clients something changed ({type:"plugin.event", data:{pluginId, channel, payload}}). */
  ui: { emit(channel: string, payload: unknown): void };
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
  };
  /** The journal of runs, the agents' notes and the scripts' state (store.ts). */
  store: TriggerStore;
  /**
   * A vault item's fields, read for `actor` (trigger:<id>) on behalf of `agentId` (the trigger's agent: the item's scope
   * decides); throws when it is missing or refused.
   */
  vault?: { get(ref: string, actor: string, agentId?: string): Promise<Record<string, string>> };
  core: { call<T = any>(method: CoreMethod, params?: unknown): Promise<T> };
  /** How the watch loads pages; unset: the global fetch. */
  fetch?: FetchLike;
  /** What scripts and quick checks reach (pipeline.ts); unset: none of it is available. */
  pipeline?: PipelineServices;
  /**
   * Signal sources beyond core's own (sources.ts: plugins' and the hub's); unset: only core's four. `sync` brings the
   * plugins' live subscriptions in line with the enabled triggers' `on`, after each change to them and at boot.
   */
  sources?: { list(): TriggerSourceInfo[]; sync?(): Promise<void> };
}
