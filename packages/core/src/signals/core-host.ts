// The trigger engine's host in core (host.ts): plugin_kv under "triggers" for its storage (where the plugin kept it),
// core's own calls, the hub bus, the tool registry (tools named trigger_*, owned by "triggers" as the plugin's were),
// the Triggers card's switch and settings, and page loads through the egress proxy. Its pipeline reaches the agents'
// read tools through the gateway, the quick model, and a fetch of its own per script run through the egress proxy. The
// hub starts it while it leads and stops it when it stands down; it runs only while the Triggers card exists and is on.

import type { CoreMethod, ToolResult } from "@piomio/shared";
import type { QuickModel } from "../bare-ask.ts";
import type { EventBus } from "../bus.ts";
import { tx, type Db } from "../db.ts";
import type { EgressProxy } from "../egress.ts";
import { hubLocale, tFor } from "../i18n.ts";
import { pluginKv } from "../plugins/kv.ts";
import type { ToolGateway } from "../tools/gateway.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { TriggerEngine } from "./engine.ts";
import type { FetchLike, PipelineServices, TriggerHost, TriggerHttpRequest, TriggerHttpResponse } from "./host.ts";
import { startTriggers } from "./index.ts";
import { proxiedGet } from "./net.ts";
import { gatewayReads } from "./pio.ts";
import { migrateRunLists, sqlStore, type NoteQuery, type NoteRow, type TriggerStore } from "./store.ts";

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
  /**
   * How the watch loads pages (net.ts proxiedGet); unset: the global fetch. Made afresh on every start; `release` is
   * called when that start's engine stops (its egress token is revoked, its connections closed).
   */
  fetch?: () => { fetch: FetchLike; release?(): void };
  /** A trigger's script reads with its agent's tools through this (ToolGateway.callRead); unset: it reads nothing. */
  gateway?: Pick<ToolGateway, "callRead">;
  /** The quick model of triage and pio.llm.ask (bare-ask.ts); unset: unavailable. */
  quick?: QuickModel;
  /**
   * The egress proxy a script's fetches go through, and its port on loopback: each run gets a token of its own (owner
   * trigger:<id>, allowlist the trigger's hosts, no session context), revoked when the run ends. Unset: no fetches.
   */
  egress?: { proxy: Pick<EgressProxy, "issueToken" | "revoke">; port: number };
  /** The vault: a webhook's signing secret is read from it (`vault.access`, actor trigger:<id>). Unset: signed webhooks answer 503. */
  vault?: { access(ref: string, req: { actor: string }): Record<string, string> };
}

/** What one start registered: released together, so a stop during a start takes back exactly that start's. */
interface Session {
  offs: Array<() => void>;
  toolNames: string[];
  handler?: (req: TriggerHttpRequest) => Promise<TriggerHttpResponse> | TriggerHttpResponse;
  /** The session's guarded store (refused once closed). */
  store?: TriggerStore;
  /**
   * Released: what its engine still does (a page load in flight, a stale start, a boot on the next turn) goes nowhere,
   * as it did when a stopped plugin's process was gone. Storage and core calls reject, UI events and logs are dropped.
   */
  closed: boolean;
  /** Script runs' egress tokens not yet let go: they go with the session. */
  nets: Set<() => void>;
}

/** What a released session's storage and core calls reject with (the plugin's closed RPC peer did the same). */
const STOPPED = "the trigger engine was stopped";

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
    const s: Session = { offs: [], toolNames: [], closed: false, nets: new Set() };
    const p: Promise<void> = (async () => {
      await prev?.catch(() => {});
      if (this.gen !== gen) return;
      this.session = s;
      try {
        const store = this.store(s);
        s.store = store;
        // The run lists the plugin kept in storage move into the journal, once, before the engine reads them.
        migrateRunLists(pluginKv(this.d.db, TRIGGERS_ID), store, {
          atomically: (fn) => tx(this.d.db, fn),
          warn: (m) => console.warn(`[piomio] triggers warn: ${m}`),
        });
        const engine = await startTriggers(this.host(s, store));
        if (this.gen !== gen) {
          engine.stop();
          this.release(s);
          return;
        }
        this.engine = engine;
      } catch (e) {
        this.release(s);
        if (this.session === s) this.session = undefined;
        // Stopped while it started: its calls were cut off, which is no failure to start.
        if (this.gen !== gen) return;
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

  /** An agent's notes (store.ts), for the turns' `[Signals]` block; none while the engine does not run. */
  notes(q: NoteQuery): NoteRow[] {
    const s = this.session;
    if (!this.engine || !s || s.closed || !s.store) return [];
    try {
      return s.store.notes(q);
    } catch {
      return [];
    }
  }

  /** Its HTTP API (/api/plugins/triggers/http/*) and webhooks (/hooks/triggers/*): 404 while it does not run. */
  async http(req: TriggerHttpRequest): Promise<TriggerHttpResponse> {
    const handler = this.engine ? this.session?.handler : undefined;
    if (!handler) return { status: 404, body: { error: "not found" } };
    return handler(req);
  }

  private release(s: Session): void {
    s.closed = true;
    for (const off of s.offs.splice(0)) off();
    for (const name of s.toolNames.splice(0)) this.d.tools.unregister(name, TRIGGERS_ID);
    for (const release of [...s.nets]) release();
    s.handler = undefined;
  }

  /** The journal, notes and script state on the hub's database; refused once the session is closed, as `storage` is. */
  private store(s: Session): TriggerStore {
    const inner = sqlStore(this.d.db);
    const guard =
      <A extends unknown[], R>(fn: (...a: A) => R) =>
      (...a: A): R => {
        if (s.closed) throw new Error(STOPPED);
        return fn(...a);
      };
    return {
      runs: guard(inner.runs),
      run: guard(inner.run),
      addRun: guard(inner.addRun),
      signal: guard(inner.signal),
      recentSignals: guard(inner.recentSignals),
      dropRuns: guard(inner.dropRuns),
      addNote: guard(inner.addNote),
      notes: guard(inner.notes),
      stateGet: guard(inner.stateGet),
      stateSet: guard(inner.stateSet),
      stateDelete: guard(inner.stateDelete),
      dropState: guard(inner.dropState),
    };
  }

  private host(s: Session, store: TriggerStore): TriggerHost {
    const d = this.d;
    const kv = pluginKv(d.db, TRIGGERS_ID);
    // As the plugin's logs were: debug and info stay quiet, what went wrong reaches the hub's console.
    const say =
      (level: "warn" | "error") =>
      (...a: unknown[]) =>
        s.closed ? undefined : console[level](`[piomio] triggers ${level}: ${a.map(String).join(" ")}`);
    /** Run `fn` while the session is open; a call that was in flight when it closed has its answer dropped. */
    const open = async <T>(fn: () => T | Promise<T>, settle = false): Promise<T> => {
      if (s.closed) throw new Error(STOPPED);
      const out = await fn();
      if (settle && s.closed) throw new Error(STOPPED);
      return out;
    };
    /** A listener added after the release is taken back at once. */
    const keep = (off: () => void) => void (s.closed ? off() : s.offs.push(off));
    const net = d.fetch?.();
    if (net?.release) keep(net.release);
    const fetch = net?.fetch;
    const pipeline: PipelineServices = {
      callRead: (as, name, input) =>
        open(async () => {
          if (!d.gateway) {
            const result: ToolResult = { content: [{ type: "text", text: `Tool ${name} is not available to triggers on this hub` }], isError: true, _meta: { status: "denied" } };
            return { result, source: false };
          }
          return gatewayReads(d.gateway, as)(name, input);
        }, true),
      fetchFor: (triggerId, hosts) => {
        if (s.closed) throw new Error(STOPPED);
        const egress = d.egress;
        if (!egress) return { fetch: () => Promise.reject(new Error("pio.fetch is not available on this hub")), release() {} };
        // No NetworkContext: nothing in an unattended script's run may raise a network card (hub_network_request).
        const token = egress.proxy.issueToken(`trigger:${triggerId}`, [...hosts]);
        const get = proxiedGet(`http://${token}:x@127.0.0.1:${egress.port}`);
        const release = () => {
          if (!s.nets.delete(release)) return;
          egress.proxy.revoke(token);
          get.close();
        };
        s.nets.add(release);
        return { fetch: (url, init) => open(() => get(url, init)), release };
      },
      quick: {
        ask: (prompt, o) => open(() => (d.quick ? d.quick.ask(prompt, o) : Promise.reject(new Error("no quick model on this hub"))), true),
      },
    };
    return {
      pluginId: TRIGGERS_ID,
      hubUrl: d.hubUrl,
      settings: { ...(d.card.get()?.settings ?? {}) },
      onSettingsChange: (cb) => keep(d.card.onSettings(cb)),
      i18n: { locale: hubLocale, t: (key, params, locale) => tFor(locale ?? hubLocale())(`triggers.${key}`, params) },
      log: { debug() {}, info() {}, warn: say("warn"), error: say("error") },
      tools: {
        register: (r) => {
          if (s.closed) return;
          const { handler, name: short, fullName, effectOf, describe, ...spec } = r;
          const name = fullName ?? `${TOOL_PREFIX}_${short}`;
          // As the plugin runner did: a string is the text, a throw is an error result.
          // Owned by the card, as the plugin's were: "always allow", the catalog's uses and its tool list go by the owner.
          // A call's own effect (a new script host is an outside action) and its card's text go to the registry as a
          // core tool's do.
          d.tools.register(
            { ...spec, name, owner: TRIGGERS_ID },
            async (input, ctx): Promise<ToolResult> => {
              try {
                const out = await handler(input ?? {}, ctx);
                return typeof out === "string" ? { content: [{ type: "text", text: out }] } : out;
              } catch (e: any) {
                return { content: [{ type: "text", text: `Error: ${e?.message ?? String(e)}` }], isError: true };
              }
            },
            describe,
            effectOf && ((input, ctx) => effectOf(input ?? {}, ctx)),
          );
          s.toolNames.push(name);
        },
      },
      events: { on: (name, cb) => keep(d.bus.on(name, cb)) },
      http: { handle: (h) => void (s.closed || (s.handler = h)) },
      ui: { emit: (channel, payload) => void (s.closed || d.coreCall(TRIGGERS_ID, "ui.emit", { channel, payload }).catch(() => {})) },
      storage: {
        get: (key) => open(() => (kv.get(key) ?? undefined) as any),
        set: (key, value) => open(() => kv.set(key, value)),
        delete: (key) => open(() => kv.delete(key)),
        list: (prefix) => open(() => kv.list(prefix)),
      },
      store,
      ...(d.vault ? { vault: { get: (ref: string, actor: string) => open(async () => d.vault!.access(ref, { actor })) } } : {}),
      core: { call: (method, params) => open(() => d.coreCall(TRIGGERS_ID, method, params) as Promise<any>, true) },
      ...(fetch ? { fetch: (url, init) => open(() => fetch(url, init)) } : {}),
      pipeline,
    };
  }
}
