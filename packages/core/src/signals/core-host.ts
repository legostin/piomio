// The trigger engine's host in core (host.ts): plugin_kv under "triggers" for its storage (where the plugin kept it),
// core's own calls, the hub bus, the tool registry (tools named trigger_*, owned by "triggers" as the plugin's were),
// the Triggers card's switch and settings, and page loads through the egress proxy. The hub starts it while it leads
// and stops it when it stands down; it runs only while the Triggers card exists and is on.

import type { CoreMethod, ToolResult } from "@piomio/shared";
import type { EventBus } from "../bus.ts";
import type { Db } from "../db.ts";
import { hubLocale, tFor } from "../i18n.ts";
import { pluginKv } from "../plugins/kv.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { TriggerEngine } from "./engine.ts";
import type { FetchLike, TriggerHost, TriggerHttpRequest, TriggerHttpResponse } from "./host.ts";
import { startTriggers } from "./index.ts";

/** The Triggers card's id: its storage, its webhook addresses (/hooks/triggers/…) and its UI events carry it. */
export const TRIGGERS_ID = "triggers";
/** Its tools are named trigger_<name>, as the plugin's were (manifest toolPrefix "trigger"). */
const TOOL_PREFIX = "trigger";

export interface CoreTriggersDeps {
  db: Db;
  bus: EventBus;
  tools: ToolRegistry;
  /** The Triggers card in Plugins: undefined when the hub has none (or its plugin filter leaves it out). */
  card: {
    get(): { enabled: boolean; settings: Record<string, unknown> } | undefined;
    onSettings(cb: (settings: Record<string, unknown>) => void): () => void;
  };
  /** Core calls as a plugin makes them (core-call.ts), on behalf of "triggers". */
  coreCall: (pluginId: string, method: CoreMethod, params: unknown) => Promise<unknown>;
  hubUrl: string;
  /** How the watch loads pages (net.ts proxiedGet); unset: the global fetch. Made once per start. */
  fetch?: () => FetchLike;
}

/** What one start registered: released together, so a stop during a start takes back exactly that start's. */
interface Session {
  offs: Array<() => void>;
  toolNames: string[];
  handler?: (req: TriggerHttpRequest) => Promise<TriggerHttpResponse> | TriggerHttpResponse;
}

export class CoreTriggers {
  engine?: TriggerEngine;
  private d: CoreTriggersDeps;
  private starting?: Promise<void>;
  /** Bumped by stop(): a start that finds it changed was stopped while it ran. */
  private gen = 0;
  private startGen = 0;
  private session?: Session;

  constructor(d: CoreTriggersDeps) {
    this.d = d;
  }

  /** The Triggers card exists and is on. */
  wanted(): boolean {
    return !!this.d.card.get()?.enabled;
  }

  /** Start the engine when it should run and does not; a call while it starts waits for that start. */
  start(): Promise<void> {
    if (this.engine || !this.wanted()) return this.starting ?? Promise.resolve();
    // A start still running after a stop() is stale: the new one waits for it to take its registrations back.
    if (this.starting && this.startGen === this.gen) return this.starting;
    const prev = this.starting;
    const gen = this.gen;
    const s: Session = { offs: [], toolNames: [] };
    const p: Promise<void> = (async () => {
      await prev?.catch(() => {});
      if (this.gen !== gen) return;
      this.session = s;
      try {
        const engine = await startTriggers(this.host(s));
        if (this.gen !== gen) {
          engine.stop();
          this.release(s);
          return;
        }
        this.engine = engine;
      } catch (e) {
        this.release(s);
        if (this.session === s) this.session = undefined;
        throw e;
      }
    })();
    this.starting = p;
    this.startGen = gen;
    const clear = () => {
      if (this.starting === p) this.starting = undefined;
    };
    p.then(clear, clear);
    return p;
  }

  /** Stop it: its timers, its tools, its bus and settings listeners, its HTTP. A start in flight is stopped too. */
  stop(): void {
    this.gen++;
    this.engine?.stop();
    this.engine = undefined;
    if (this.session) this.release(this.session);
    this.session = undefined;
  }

  /** Start or stop it to match the card (the person turned Triggers on or off). */
  async sync(): Promise<void> {
    if (this.wanted()) await this.start();
    else this.stop();
  }

  /** Its HTTP API (/api/plugins/triggers/http/*) and webhooks (/hooks/triggers/*): 404 while it does not run. */
  async http(req: TriggerHttpRequest): Promise<TriggerHttpResponse> {
    const handler = this.engine ? this.session?.handler : undefined;
    if (!handler) return { status: 404, body: { error: "not found" } };
    return handler(req);
  }

  private release(s: Session): void {
    for (const off of s.offs.splice(0)) off();
    for (const name of s.toolNames.splice(0)) this.d.tools.unregister(name, TRIGGERS_ID);
    s.handler = undefined;
  }

  private host(s: Session): TriggerHost {
    const d = this.d;
    const kv = pluginKv(d.db, TRIGGERS_ID);
    // As the plugin's logs were: debug and info stay quiet, what went wrong reaches the hub's console.
    const say =
      (level: "warn" | "error") =>
      (...a: unknown[]) =>
        console[level](`[piomio] triggers ${level}: ${a.map(String).join(" ")}`);
    const fetch = d.fetch?.();
    return {
      pluginId: TRIGGERS_ID,
      hubUrl: d.hubUrl,
      settings: { ...(d.card.get()?.settings ?? {}) },
      onSettingsChange: (cb) => void s.offs.push(d.card.onSettings(cb)),
      i18n: { locale: hubLocale, t: (key, params, locale) => tFor(locale ?? hubLocale())(`triggers.${key}`, params) },
      log: { debug() {}, info() {}, warn: say("warn"), error: say("error") },
      tools: {
        register: (r) => {
          const { handler, name: short, ...spec } = r;
          const name = `${TOOL_PREFIX}_${short}`;
          // As the plugin runner did: a string is the text, a throw is an error result.
          // Owned by the card, as the plugin's were: "always allow", the catalog's uses and its tool list go by the owner.
          d.tools.register({ ...spec, name, owner: TRIGGERS_ID }, async (input, ctx): Promise<ToolResult> => {
            try {
              const out = await handler(input ?? {}, ctx);
              return typeof out === "string" ? { content: [{ type: "text", text: out }] } : out;
            } catch (e: any) {
              return { content: [{ type: "text", text: `Error: ${e?.message ?? String(e)}` }], isError: true };
            }
          });
          s.toolNames.push(name);
        },
      },
      events: { on: (name, cb) => void s.offs.push(d.bus.on(name, cb)) },
      http: { handle: (h) => void (s.handler = h) },
      ui: { emit: (channel, payload) => void d.coreCall(TRIGGERS_ID, "ui.emit", { channel, payload }).catch(() => {}) },
      storage: {
        get: async (key) => (kv.get(key) ?? undefined) as any,
        set: async (key, value) => kv.set(key, value),
        delete: async (key) => kv.delete(key),
        list: async (prefix) => kv.list(prefix),
      },
      core: { call: (method, params) => d.coreCall(TRIGGERS_ID, method, params) as Promise<any> },
      ...(fetch ? { fetch } : {}),
    };
  }
}
