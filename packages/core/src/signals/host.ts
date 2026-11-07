// What the trigger engine needs from where it runs: the part of a plugin's context it used when it was the triggers
// plugin. Core gives it one (core-host.ts); tests give it a fake. Keeping that shape lets the engine and its tests move
// unchanged (docs/superpowers/specs/2026-11-07-unified-triggers-design.md, phase 1).

import type { CoreMethod, Locale, Params, ToolCallContext, ToolResult, ToolSpec } from "@piomio/shared";

export interface TriggerHttpRequest {
  method: string;
  /** Path after /api/plugins/triggers/http (or /hooks/triggers for public requests), starting with "/". */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
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
  handler: (input: any, ctx: ToolCallContext) => Promise<ToolResult | string> | ToolResult | string;
}

/** A GET the watch makes (watch.ts fetchPage): the global fetch, or core's through the egress proxy (net.ts). */
export type FetchLike = (url: string, init: { redirect?: "manual"; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

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
  core: { call<T = any>(method: CoreMethod, params?: unknown): Promise<T> };
  /** How the watch loads pages; unset: the global fetch. */
  fetch?: FetchLike;
}
