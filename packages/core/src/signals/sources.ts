// Where signals come from (docs/superpowers/specs/2026-11-07-unified-triggers-design.md, section 1): core's own four
// sources (builtin-sources.ts) and each plugin's, declared in its manifest (contributes.signals) and exposed as
// <pluginId>.<type>; the hub's own (hub.*, from the bus) start and stop with this registry too.
//
// A plugin's signal is checked here: its rate, that its type is declared, the subscription it came by, the intake's
// caps (50 levels, 256 KB) and its data schema. Then it goes to the enabled triggers that listen, through the pipeline's
// arrival-time intake (the sink, TriggerPipeline.deliver), which still matches, dedups and counts floods for each.
// Subscribe-mode sources work only while a trigger subscribes: one plugin subscription per distinct (type, canonical
// config) among the enabled triggers, stopped when none is left, made again when the plugin restarts.

import { randomBytes } from "node:crypto";
import { Ajv, type ValidateFunction } from "ajv";
import type { Locale, SignalDecl } from "@piomio/shared";
import type { EventBus } from "../bus.ts";
import { hubLocale, tFor } from "../i18n.ts";
import { BUILTIN_SOURCES_INFO } from "./builtin-sources.ts";
import { canonicalJson, dataProblem, newSignalId } from "./pipeline.ts";
import { BUILTIN_SOURCES, type Signal, type Trigger } from "./types.ts";

/** Signals one plugin may emit a minute; past it they are refused before anything else is looked at. */
export const EMITS_PER_MINUTE = 600;
const RATE_MS = 60_000;
const KEY_MAX = 200;
const SUBJECT_MAX = 500;
/** The hub's own sources are hub.*: no plugin's. */
const HUB = "hub";
/** Types no plugin's source may take: core's own sources and the signals they bring. */
const RESERVED = new Set<string>([...BUILTIN_SOURCES, "time.tick"]);

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A source as the person and the agents see it (trigger_sources; `title` in the person's language). */
export interface SourceInfo {
  type: string;
  /** "hub", or the plugin's id. */
  source: string;
  mode: "broadcast" | "subscribe";
  title: string;
  /** English, for the model. */
  description: string;
  /** JSON Schema of a subscription's config. */
  config?: unknown;
  /** JSON Schema of a signal's data. */
  data?: unknown;
  sample?: unknown;
  external: boolean;
  /** Its plugin runs (core's own are always online). */
  online: boolean;
}

/** Where a signal goes: the pipeline's arrival-time intake for one trigger (CoreTriggers.deliver). */
export interface SourceSink {
  deliver(triggerId: string, signals: Signal[], reason: "signal", o?: { via?: { config?: string } }): Promise<unknown>;
}

/** One plugin's declared signals, as the plugin host knows them. */
export interface PluginSignals {
  pluginId: string;
  decls: SignalDecl[];
  /** Its process runs and is activated. */
  running: boolean;
  /** A declared title ("%key%") in `locale` (default: the hub language). */
  title(key: string, locale?: Locale): string;
}

/** The plugin host, as the registry reaches it: what is declared, and its providers' subscriptions (RPC). */
export interface SourcePlugins {
  declared(): PluginSignals[];
  subscribe(pluginId: string, id: string, type: string, config: Record<string, unknown>): Promise<void>;
  stop(pluginId: string, id: string): Promise<void>;
}

export interface SignalSourcesDeps {
  plugins: SourcePlugins;
  /** The trigger engine's triggers (none while it does not run). */
  triggers: () => Trigger[];
  sink: SourceSink;
  bus: EventBus;
  now?: () => number;
  /** Known secrets taken out of what a plugin sends (the vault's redactor); unset: kept as it came. */
  redact?: <T>(v: T) => T;
  /** What went wrong (a subscription that failed, a config its source refuses); unset: the console. */
  log?: (msg: string) => void;
}

/** What a plugin sent with ctx.signals (its emit, or its provider's). */
export interface PluginEmit {
  type: string;
  data: unknown;
  key?: string;
  subject?: string;
  /** The subscription a provider's signal came by (signals.subscribe's id). */
  subscription?: string;
}

export type EmitResult = { ok: true } | { ok: false; error: string };

interface Source {
  pluginId: string;
  decl: SignalDecl;
  decls: SignalDecl[];
  running: boolean;
  title: PluginSignals["title"];
}

/** A plugin subscription the hub keeps: one per (type, canonical config) the enabled triggers use. */
interface Live {
  key: string;
  type: string;
  pluginId: string;
  /** The type as the plugin declared it (without its id). */
  local: string;
  config: Record<string, unknown>;
  canon: string;
  /** Its id in the plugin's current run; unset while it has none there. */
  id?: string;
  /** The plugin's run it was made (or tried) in: not again until the plugin restarts. */
  epoch?: number;
}

const OK: EmitResult = { ok: true };
const refuse = (error: string): EmitResult => ({ ok: false, error });

/** One Ajv per plugin's declarations (their $ids cannot clash with another plugin's), each schema compiled once. */
const ajvs = new WeakMap<SignalDecl[], Ajv>();
const compiled = new WeakMap<object, ValidateFunction | Error>();

/** Why `value` does not fit `schema`, in one line; undefined when it does, or there is no schema. */
function schemaProblem(decls: SignalDecl[], schema: object | undefined, value: unknown, what: string): string | undefined {
  if (!schema) return undefined;
  let v = compiled.get(schema);
  if (!v) {
    let ajv = ajvs.get(decls);
    if (!ajv) ajvs.set(decls, (ajv = new Ajv({ strict: false, validateFormats: false, logger: false })));
    try {
      v = ajv.compile(schema);
    } catch (e) {
      v = e instanceof Error ? e : new Error(String(e));
    }
    compiled.set(schema, v);
  }
  if (v instanceof Error) return `the declared schema of ${what} does not compile: ${v.message}`;
  if (v(value)) return undefined;
  const e = v.errors?.[0];
  return `${what} does not match the declared schema${e ? `: ${e.instancePath || "(top)"} ${e.message ?? "is invalid"}` : ""}`;
}

export class SignalSources {
  private d: SignalSourcesDeps;
  private now: () => number;
  private started = false;
  /** Live subscriptions by (type, canonical config), and by their ids in the plugins. */
  private live = new Map<string, Live>();
  private byId = new Map<string, Live>();
  /** Each plugin's run: bumped when it starts or stops, so what was subscribed in an earlier run is made again. */
  private epochs = new Map<string, number>();
  /** Emits in the current minute, by plugin. */
  private rates = new Map<string, { from: number; count: number }>();
  /** Subscriptions whose config their source refuses, said once. */
  private refused = new Set<string>();

  constructor(d: SignalSourcesDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
  }

  /** The trigger engine started: signals are routed, subscriptions made. */
  start(): void {
    this.started = true;
    void this.sync().catch((e) => this.log(`sync failed: ${message(e)}`));
  }

  /** The engine stopped: every plugin subscription is stopped, nothing more is routed. */
  stop(): void {
    this.started = false;
    for (const l of this.live.values()) this.close(l);
    this.live.clear();
    this.byId.clear();
    this.refused.clear();
  }

  /** Core's own sources, then each enabled plugin's. */
  list(locale: Locale = hubLocale()): SourceInfo[] {
    const t = tFor(locale);
    const out: SourceInfo[] = BUILTIN_SOURCES_INFO.map((b) => ({
      type: b.type,
      source: "hub",
      // Each works for its trigger's own config (a time, a page, an address).
      mode: "subscribe",
      title: t(`triggers.source.${b.type}`),
      description: b.description,
      ...(b.config !== undefined ? { config: b.config } : {}),
      ...(b.sample !== undefined ? { sample: b.sample } : {}),
      external: !!b.external,
      online: true,
    }));
    for (const [type, s] of this.sources()) {
      const { decl } = s;
      out.push({
        type,
        source: s.pluginId,
        mode: decl.mode,
        title: s.title(decl.title, locale),
        description: decl.description,
        ...(decl.config !== undefined ? { config: decl.config } : {}),
        ...(decl.data !== undefined ? { data: decl.data } : {}),
        ...(decl.sample !== undefined ? { sample: decl.sample } : {}),
        external: decl.external,
        online: s.running,
      });
    }
    return out;
  }

  /**
   * The live subscriptions follow the enabled triggers' `on` (after a trigger is made, changed, turned on or off,
   * deleted; at boot; when a plugin comes back). The maps change synchronously, so syncs that overlap never subscribe
   * twice; resolves once the plugins answered.
   */
  async sync(): Promise<void> {
    if (!this.started) return;
    const sources = this.sources();
    const wanted = new Map<string, Live>();
    for (const t of this.d.triggers()) {
      if (!t.enabled) continue;
      for (const sub of t.on ?? []) {
        const src = sources.get(sub.type);
        if (!src || src.decl.mode !== "subscribe") continue;
        const config = sub.config ?? {};
        const canon = canonicalJson(config);
        const key = `${sub.type}\u0000${canon}`;
        if (wanted.has(key)) continue;
        const bad = schemaProblem(src.decls, src.decl.config, config, "its config");
        if (bad) {
          if (!this.refused.has(key)) this.log(`${sub.type}: not subscribed for trigger ${t.id}: ${bad}`);
          this.refused.add(key);
          continue;
        }
        wanted.set(key, { key, type: sub.type, pluginId: src.pluginId, local: src.decl.type, config, canon });
      }
    }
    for (const [key, l] of this.live) {
      if (wanted.has(key)) continue;
      this.live.delete(key);
      this.close(l);
    }
    const calls: Array<Promise<void>> = [];
    for (const [key, w] of wanted) {
      let l = this.live.get(key);
      if (!l) this.live.set(key, (l = w));
      if (sources.get(l.type)?.running && l.epoch !== this.epoch(l.pluginId)) calls.push(this.open(l));
    }
    await Promise.allSettled(calls);
  }

  /** The plugin (re)started: its subscriptions are made again, with new ids. */
  pluginUp(pluginId: string): Promise<void> {
    this.reset(pluginId);
    return this.sync();
  }

  /** The plugin stopped: its subscriptions went with its process, and signals by them are refused. */
  pluginDown(pluginId: string): void {
    this.reset(pluginId);
  }

  /**
   * A signal a plugin sent: refused with an English error (the plugin logs it) when it may not send it, else routed to
   * the enabled triggers listening. A broadcast goes to every trigger with an entry of its type; a provider's goes only
   * to those whose entry has the config of the subscription it came by. Nothing listens while the engine is stopped.
   */
  fromPlugin(pluginId: string, m: PluginEmit): EmitResult {
    if (!this.take(pluginId)) return refuse(`too many signals: at most ${EMITS_PER_MINUTE} a minute from one plugin; this one was dropped`);
    const type = typeof m?.type === "string" ? m.type : "";
    const full = `${pluginId}.${type}`;
    if (pluginId === HUB || RESERVED.has(full)) return refuse(`signal type ${full} is the hub's own: a plugin cannot send it`);
    const plugin = this.d.plugins.declared().find((p) => p.pluginId === pluginId);
    const decl = plugin?.decls.find((d) => d.type === type);
    if (!plugin || !decl) return refuse(`signal type "${type}" is not declared in contributes.signals`);
    let live: Live | undefined;
    if (decl.mode === "subscribe") {
      if (m.subscription === undefined) return refuse(`${full} is a subscribe-mode source: its signals come only by a subscription the hub made (the emit its provider is given)`);
      live = this.byId.get(String(m.subscription));
      if (!live || live.pluginId !== pluginId || live.local !== type) return refuse(`subscription ${String(m.subscription)} is not active for ${full}`);
    }
    if (m.key !== undefined && typeof m.key !== "string") return refuse(`${full}: key must be a string`);
    if (m.subject !== undefined && typeof m.subject !== "string") return refuse(`${full}: subject must be a string`);
    const data = m.data === undefined ? null : m.data;
    const problem = dataProblem(data) ?? schemaProblem(plugin.decls, decl.data, data, "its data");
    if (problem) return refuse(`${full} was refused: ${problem}`);
    if (!this.started) return OK;
    const redact = this.d.redact ?? (<T>(v: T) => v);
    const key = m.key ? redact(m.key).slice(0, KEY_MAX) : undefined;
    const subject = m.subject?.trim() ? redact(m.subject.trim()).slice(0, SUBJECT_MAX) : undefined;
    const signal: Signal = {
      id: newSignalId(),
      type: full,
      source: pluginId,
      at: new Date(this.now()).toISOString(),
      data: redact(data),
      ...(key ? { key } : {}),
      ...(subject ? { subject } : {}),
      external: decl.external,
    };
    const via = live ? { config: live.canon } : {};
    for (const t of this.d.triggers()) {
      if (!t.enabled || !(t.on ?? []).some((s) => s.type === full && (!live || canonicalJson(s.config ?? {}) === live.canon))) continue;
      try {
        void this.d.sink.deliver(t.id, [{ ...signal }], "signal", { via }).catch((e) => this.log(`${full} did not reach trigger ${t.id}: ${message(e)}`));
      } catch (e) {
        this.log(`${full} did not reach trigger ${t.id}: ${message(e)}`);
      }
    }
    return OK;
  }

  // ---------- internals ----------

  /** The plugins' sources by their full type; one that would take a type of the hub's own is left out. */
  private sources(): Map<string, Source> {
    const out = new Map<string, Source>();
    for (const p of this.d.plugins.declared()) {
      if (p.pluginId === HUB) continue;
      for (const decl of p.decls) {
        const type = `${p.pluginId}.${decl.type}`;
        if (!RESERVED.has(type)) out.set(type, { pluginId: p.pluginId, decl, decls: p.decls, running: p.running, title: (key, locale) => p.title(key, locale) });
      }
    }
    return out;
  }

  private epoch(pluginId: string): number {
    return this.epochs.get(pluginId) ?? 0;
  }

  private reset(pluginId: string): void {
    this.epochs.set(pluginId, this.epoch(pluginId) + 1);
    for (const l of this.live.values()) {
      if (l.pluginId !== pluginId || !l.id) continue;
      this.byId.delete(l.id);
      l.id = undefined;
    }
  }

  /** Subscribes `l` in its plugin's current run. Its id counts before the plugin answers: a provider may emit first. */
  private open(l: Live): Promise<void> {
    const id = `sub_${randomBytes(8).toString("hex")}`;
    l.id = id;
    l.epoch = this.epoch(l.pluginId);
    this.byId.set(id, l);
    return this.d.plugins.subscribe(l.pluginId, id, l.local, l.config).catch((e) => {
      // Not tried again until the plugin restarts; what it may still send by it is refused.
      if (this.byId.get(id) === l) this.byId.delete(id);
      if (l.id === id) l.id = undefined;
      this.log(`${l.type}: the plugin did not subscribe: ${message(e)}`);
    });
  }

  /** Stops `l`'s subscription in its plugin, when it has one there. */
  private close(l: Live): void {
    const id = l.id;
    if (!id) return;
    this.byId.delete(id);
    l.id = undefined;
    void this.d.plugins.stop(l.pluginId, id).catch((e) => this.log(`${l.type}: the plugin did not stop subscription ${id}: ${message(e)}`));
  }

  /** Counts one emit against the plugin's minute; false past the limit. */
  private take(pluginId: string): boolean {
    const now = this.now();
    let r = this.rates.get(pluginId);
    if (!r || now - r.from >= RATE_MS) this.rates.set(pluginId, (r = { from: now, count: 0 }));
    return ++r.count <= EMITS_PER_MINUTE;
  }

  private log(msg: string): void {
    if (this.d.log) this.d.log(msg);
    else console.warn(`[piomio] signals: ${msg}`);
  }
}
