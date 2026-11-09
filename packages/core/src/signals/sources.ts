// Where signals come from (docs/superpowers/specs/2026-11-07-unified-triggers-design.md, section 1): core's own four
// sources (builtin-sources.ts) and each plugin's, declared in its manifest (contributes.signals) and exposed as
// <pluginId>.<type>; the hub's own (hub.*, from the bus) start and stop with this registry too.
//
// A plugin's signal is checked here: its rate, that its type is declared, the subscription it came by (decl-check.ts),
// then, only when an enabled trigger listens, the intake's caps (50 levels, 256 KB) and its data schema, within a
// budget of the hub's time per plugin. Then it goes to the enabled triggers that listen, through the pipeline's
// arrival-time intake (the sink, TriggerPipeline.deliver), which still matches, dedups and counts floods for each.
// Subscribe-mode sources work only while a trigger subscribes: one plugin subscription per distinct (type, canonical
// config) among the enabled triggers, stopped when none is left, made again when the plugin restarts, and tried again
// with a growing pause when the plugin fails to take it.
//
// A declaration whose schema could take more than linear time is refused when first read (decl-check.ts), with the
// reason in the plugin's log and in trigger_sources.

import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Locale, SignalDecl } from "@piomio/shared";
import type { EventBus } from "../bus.ts";
import { hubLocale, tFor } from "../i18n.ts";
import { BUILTIN_SOURCES_INFO } from "./builtin-sources.ts";
import { checkedConfig, checkSignalDecls, checkSignalEmit, HUB_SOURCE, refusedSignalDecls, signalDataProblem, type AcceptedDecl, type CheckedDecl, type PluginEmit } from "./decl-check.ts";
import type { SourceCheck } from "./host.ts";
import { HUB_SOURCES, listenToHub, type HubListenDeps, type MachineView } from "./hub-sources.ts";
import { canonicalJson, newSignalId } from "./pipeline.ts";
import { BUILTIN_SOURCES, type Signal, type Trigger } from "./types.ts";

export { checkedConfig, type PluginEmit };

/** Signals one plugin may emit a minute; past it they are refused before anything else is looked at. */
export const EMITS_PER_MINUTE = 600;
/** The hub's time one plugin's signals may take to check (their data against its schema) a minute; past it they are refused. */
export const CHECK_MS_PER_MINUTE = 1000;
/** A subscription the plugin did not take is tried again after these pauses, then every 30 minutes. */
export const RETRY_MS = [30_000, 120_000, 600_000, 1_800_000];
const RATE_MS = 60_000;
const KEY_MAX = 200;
const SUBJECT_MAX = 500;
/** Room kept past a key's or subject's bound before redacting: a known secret that starts within the bound stays whole. */
const LINE_SPARE = 4096;
const HUB = HUB_SOURCE;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pause = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

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
  /** It ships with the hub: only then is a declaration's `external: false` believed (an installed plugin's is outside content). */
  builtin: boolean;
  /** A declared title ("%key%") in `locale` (default: the hub language). */
  title(key: string, locale?: Locale): string;
}

/** The plugin host, as the registry reaches it: what is declared, its providers' subscriptions (RPC), its log. */
export interface SourcePlugins {
  declared(): PluginSignals[];
  subscribe(pluginId: string, id: string, type: string, config: Record<string, unknown>): Promise<void>;
  stop(pluginId: string, id: string): Promise<void>;
  /** A line in the plugin's own log (shown with the plugin); unset: the registry's log. */
  log?(pluginId: string, msg: string): void;
}

export interface SignalSourcesDeps {
  plugins: SourcePlugins;
  /** The trigger engine's triggers (none while it does not run). */
  triggers: () => Trigger[];
  sink: SourceSink;
  bus: EventBus;
  /** The computers and whether they are online now (the baseline for hub.machine.*); unset: none known. */
  machines?: () => MachineView[];
  /** Whether a task carries outside content (hub.task.*): its own mark, or its conversation's sessions'; unset: its own mark. */
  taskTainted?: HubListenDeps["taskTainted"];
  /** A task by its id, for the self-loop guard to follow subtasks and approvals to a trigger's own wake task. */
  task?: HubListenDeps["task"];
  now?: () => number;
  /** A monotonic clock in ms, for the time a plugin's signals take to check; unset: performance.now. */
  clock?: () => number;
  /** Known secrets taken out of what a plugin sends (the vault's redactor); unset: kept as it came. */
  redact?: <T>(v: T) => T;
  /** What went wrong beyond one plugin; unset: the console. */
  log?: (msg: string) => void;
}

export type EmitResult = { ok: true } | { ok: false; error: string };

interface Source {
  pluginId: string;
  decl: SignalDecl;
  checked: AcceptedDecl;
  running: boolean;
  external: boolean;
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
  /** The plugin's run it was made (or tried) in: a sync makes it again only in a new run. */
  epoch?: number;
  /** Failed tries in a row, and the timer of the next. */
  failures: number;
  timer?: NodeJS.Timeout;
}

const OK: EmitResult = { ok: true };
const refuse = (error: string): EmitResult => ({ ok: false, error });
const BUILTIN_TYPES = new Set<string>(BUILTIN_SOURCES);

export class SignalSources {
  private d: SignalSourcesDeps;
  private now: () => number;
  private started = false;
  /** Stops the listeners on the bus (the hub's own sources), while the engine runs. */
  private unlisten: (() => void) | undefined;
  /** Live subscriptions by (type, canonical config), and by their ids in the plugins. */
  private live = new Map<string, Live>();
  private byId = new Map<string, Live>();
  /** Each plugin's run: bumped when it starts or stops, so what was subscribed in an earlier run is made again. */
  private epochs = new Map<string, number>();
  /** Emits in the current minute, by plugin. */
  private rates = new Map<string, { from: number; count: number }>();
  /** The time each plugin's signals took to check in the current minute (ms), and whether its log was told it ran out. */
  private checking = new Map<string, { from: number; ms: number; said: boolean }>();
  private clock: () => number;
  /** Subscriptions whose config their source refuses, said once. */
  private refusedConfigs = new Set<string>();

  constructor(d: SignalSourcesDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.clock = d.clock ?? (() => performance.now());
  }

  /** The trigger engine started: signals are routed, subscriptions made. */
  start(): void {
    this.started = true;
    this.unlisten?.();
    this.unlisten = listenToHub(this.d.bus, (type, s, skip) => this.fromHub(type, s, skip), {
      machines: () => this.d.machines?.() ?? [],
      now: this.now,
      ...(this.d.taskTainted ? { taskTainted: this.d.taskTainted } : {}),
      ...(this.d.task ? { task: this.d.task } : {}),
    });
    void this.sync().catch((e) => this.log(`sync failed: ${message(e)}`));
  }

  /** The engine stopped: every plugin subscription is stopped (and none is tried again), nothing more is routed. */
  stop(): void {
    this.started = false;
    this.unlisten?.();
    this.unlisten = undefined;
    for (const l of this.live.values()) this.close(l);
    this.live.clear();
    this.byId.clear();
    this.refusedConfigs.clear();
  }

  /** Core's own sources, then each enabled plugin's (one whose declaration is refused is left out). */
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
    for (const h of HUB_SOURCES) {
      out.push({ type: h.type, source: "hub", mode: "broadcast", title: t(`triggers.source.${h.type}`), description: h.description, data: h.data, sample: h.sample, external: h.external, online: true });
    }
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
        external: s.external,
        online: s.running,
      });
    }
    return out;
  }

  /** The sources the enabled plugins declare that the hub refuses, with why: they bring no signal until the plugin is fixed. */
  refused(): Array<{ type: string; source: string; why: string }> {
    const out: Array<{ type: string; source: string; why: string }> = [];
    for (const p of this.d.plugins.declared()) {
      this.checked(p);
      for (const r of refusedSignalDecls(p.pluginId, p.decls)) out.push({ type: `${p.pluginId}.${r.type}`, source: p.pluginId, why: r.why });
    }
    return out;
  }

  /**
   * What a trigger's `on` entry of `type` with `config` would get: "ok"; "config" when its source refuses the config
   * (`problem`); "unknown" when no source has the type (a plugin off or not installed); "offline" when its plugin does
   * not run now; "refused" when its plugin's declaration is refused (`why`).
   */
  check(type: string, config: Record<string, unknown> = {}): SourceCheck {
    if (BUILTIN_TYPES.has(type) || HUB_SOURCES.some((h) => h.type === type)) return { status: "ok" };
    for (const p of this.d.plugins.declared()) {
      if (!type.startsWith(`${p.pluginId}.`)) continue;
      const local = type.slice(p.pluginId.length + 1);
      const decl = p.decls.find((x) => x.type === local);
      if (!decl) continue;
      const c = this.checked(p).get(local);
      if (!c || "refused" in c) return { status: "refused", source: p.pluginId, why: c && "refused" in c ? c.refused : "not checked" };
      if (decl.mode === "subscribe") {
        const { problem } = checkedConfig(p.pluginId, p.decls, local, config);
        if (problem) return { status: "config", source: p.pluginId, problem };
      }
      return p.running ? { status: "ok" } : { status: "offline", source: p.pluginId };
    }
    return { status: "unknown" };
  }

  /** The live plugin subscriptions, as they are now: their type and config, whether the plugin holds them, failed tries. */
  subscriptions(): Array<{ type: string; config: Record<string, unknown>; active: boolean; failures: number }> {
    return [...this.live.values()].map((l) => ({ type: l.type, config: structuredClone(l.config), active: !!l.id, failures: l.failures }));
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
        const { problem } = checkedConfig(src.pluginId, this.declsOf(src.pluginId), src.decl.type, config);
        if (problem) {
          if (!this.refusedConfigs.has(key)) this.pluginLog(src.pluginId, `${sub.type}: not subscribed for trigger ${t.id}: ${problem}`);
          this.refusedConfigs.add(key);
          continue;
        }
        wanted.set(key, { key, type: sub.type, pluginId: src.pluginId, local: src.decl.type, config, canon, failures: 0 });
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

  /** The plugin (re)started: its declarations are checked (once per layout), its subscriptions made again with new ids. */
  pluginUp(pluginId: string): Promise<void> {
    this.reset(pluginId);
    this.sources();
    return this.sync();
  }

  /** The plugin stopped: its subscriptions went with its process, and signals by them are refused. */
  pluginDown(pluginId: string): void {
    this.reset(pluginId);
  }

  /** The plugin's provider failed a subscription after it was taken (a provide() that threw later): tried again later. */
  failed(pluginId: string, subscription: string, error: string): void {
    const l = this.byId.get(subscription);
    if (l && l.pluginId === pluginId) this.failure(l, subscription, `its provider failed: ${error}`);
  }

  /**
   * A signal a plugin sent: refused with an English error (the plugin logs it) when it may not send it, else routed to
   * the enabled triggers listening. A broadcast goes to every trigger with an entry of its type; a provider's goes only
   * to those whose entry has the config of the subscription it came by. Nothing listens while the engine is stopped,
   * and a signal nobody listens to is taken without checking its data (that costs the hub's time for nothing); one
   * that is checked counts against the plugin's minute of checking (CHECK_MS_PER_MINUTE).
   */
  fromPlugin(pluginId: string, m: PluginEmit): EmitResult {
    if (!this.take(pluginId)) return refuse(`too many signals: at most ${EMITS_PER_MINUTE} a minute from one plugin; this one was dropped`);
    const plugin = this.d.plugins.declared().find((p) => p.pluginId === pluginId);
    if (!plugin) return refuse(`signal type "${typeof m?.type === "string" ? m.type : ""}" is not declared in contributes.signals`);
    let live: Live | undefined;
    const shape = checkSignalEmit(pluginId, plugin.decls, m, {
      subscribed: (id, type) => {
        live = this.byId.get(id);
        return !!live && live.pluginId === pluginId && live.local === type;
      },
      onRefused: (type, why) => this.refusedLog(pluginId, type, why),
    });
    if (!shape.ok) return refuse(shape.error);
    const { decl, checked } = shape;
    const full = `${pluginId}.${decl.type}`;
    if (!this.started) return OK;
    const listening = this.d.triggers().filter((t) => t.enabled && (t.on ?? []).some((s) => s.type === full && (!live || canonicalJson(s.config ?? {}) === live.canon)));
    if (!listening.length) return OK;
    const data = m.data === undefined ? null : m.data;
    const spent = this.checkTime(pluginId);
    if (spent.ms >= CHECK_MS_PER_MINUTE) {
      const why = `${full} was refused: this plugin's signals took over ${CHECK_MS_PER_MINUTE} ms of the hub's time to check in the last minute (keep their data small and the schema plain); signals are taken again when the minute is over`;
      if (!spent.said) this.pluginLog(pluginId, why);
      spent.said = true;
      return refuse(why);
    }
    const from = this.clock();
    let problem: string | undefined;
    try {
      problem = signalDataProblem(pluginId, decl.type, checked, data);
    } finally {
      spent.ms += Math.max(0, this.clock() - from);
    }
    if (problem) return refuse(problem);
    const key = this.line(m.key, KEY_MAX);
    const subject = this.line(m.subject, SUBJECT_MAX);
    const signal: Signal = {
      id: newSignalId(),
      type: full,
      source: pluginId,
      at: new Date(this.now()).toISOString(),
      data: this.redact(data),
      ...(key ? { key } : {}),
      ...(subject ? { subject } : {}),
      external: decl.external || !plugin.builtin,
    };
    const via = live ? { config: (live as Live).canon } : {};
    for (const t of listening) {
      try {
        void this.d.sink.deliver(t.id, [{ ...signal }], "signal", { via }).catch((e) => this.log(`${full} did not reach trigger ${t.id}: ${message(e)}`));
      } catch (e) {
        this.log(`${full} did not reach trigger ${t.id}: ${message(e)}`);
      }
    }
    return OK;
  }

  // ---------- internals ----------

  /** A hub event as a signal, to every enabled trigger with an entry of its type except those `skip` names. */
  private fromHub(type: string, s: Pick<Signal, "data" | "key" | "external" | "subject">, skip?: (triggerId: string) => boolean): void {
    if (!this.started) return;
    const key = this.line(s.key, KEY_MAX);
    const subject = this.line(s.subject, SUBJECT_MAX);
    const signal: Signal = {
      id: newSignalId(),
      type,
      source: HUB,
      at: new Date(this.now()).toISOString(),
      data: this.redact(s.data),
      ...(key ? { key } : {}),
      ...(subject ? { subject } : {}),
      external: s.external,
    };
    for (const t of this.d.triggers()) {
      if (!t.enabled || skip?.(t.id) || !(t.on ?? []).some((e) => e.type === type)) continue;
      try {
        void this.d.sink.deliver(t.id, [{ ...signal }], "signal").catch((e) => this.log(`${type} did not reach trigger ${t.id}: ${message(e)}`));
      } catch (e) {
        this.log(`${type} did not reach trigger ${t.id}: ${message(e)}`);
      }
    }
  }

  private redact<T>(v: T): T {
    return this.d.redact ? this.d.redact(v) : v;
  }

  /**
   * A signal's key or subject as kept: cut to its bound with room to spare (so redacting costs no more than that), then
   * known secrets taken out (one that starts within the bound is still whole in the spare room), then cut to `max`.
   */
  private line(v: string | undefined, max: number): string | undefined {
    if (typeof v !== "string") return undefined;
    const kept = this.redact(v.trim().slice(0, max + LINE_SPARE)).slice(0, max).trim();
    return kept || undefined;
  }

  /** A plugin's declarations, checked (and a refused one said in its log) the first time they are read. */
  private checked(p: PluginSignals): Map<string, CheckedDecl> {
    return checkSignalDecls(p.pluginId, p.decls, (type, why) => this.refusedLog(p.pluginId, type, why));
  }

  private refusedLog(pluginId: string, type: string, why: string): void {
    this.pluginLog(pluginId, `signal type ${pluginId}.${type} is refused and left out: ${why}`);
  }

  /** The plugin's checking time in the current minute (a new minute starts afresh). */
  private checkTime(pluginId: string): { from: number; ms: number; said: boolean } {
    const now = this.now();
    let c = this.checking.get(pluginId);
    if (!c || now - c.from >= RATE_MS) this.checking.set(pluginId, (c = { from: now, ms: 0, said: false }));
    return c;
  }

  private declsOf(pluginId: string): SignalDecl[] {
    return this.d.plugins.declared().find((p) => p.pluginId === pluginId)?.decls ?? [];
  }

  /** The plugins' sources by their full type; a refused declaration is left out. */
  private sources(): Map<string, Source> {
    const out = new Map<string, Source>();
    for (const p of this.d.plugins.declared()) {
      const checked = this.checked(p);
      for (const decl of p.decls) {
        const c = checked.get(decl.type);
        if (!c || "refused" in c) continue;
        out.set(`${p.pluginId}.${decl.type}`, {
          pluginId: p.pluginId,
          decl,
          checked: c,
          running: p.running,
          external: decl.external || !p.builtin,
          title: (key, locale) => p.title(key, locale),
        });
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
      if (l.pluginId !== pluginId) continue;
      clearTimeout(l.timer);
      l.timer = undefined;
      l.failures = 0;
      if (!l.id) continue;
      this.byId.delete(l.id);
      l.id = undefined;
    }
  }

  /** Subscribes `l` in its plugin's current run. Its id counts before the plugin answers: a provider may emit first. */
  private open(l: Live): Promise<void> {
    const id = `sub_${randomBytes(8).toString("hex")}`;
    clearTimeout(l.timer);
    l.timer = undefined;
    l.id = id;
    l.epoch = this.epoch(l.pluginId);
    this.byId.set(id, l);
    return this.d.plugins.subscribe(l.pluginId, id, l.local, l.config).then(
      () => {
        if (l.id === id) l.failures = 0;
      },
      (e) => this.failure(l, id, `the plugin did not take the subscription: ${message(e)}`),
    );
  }

  /**
   * Subscription `id` failed (the plugin refused it, did not answer in time, or its provider threw): it is stopped in
   * the plugin, in case the plugin still holds it, and tried again after a pause while an enabled trigger uses it.
   */
  private failure(l: Live, id: string, why: string): void {
    // Stopped, made again, or its plugin went away meanwhile: nothing more to do for this id.
    if (l.id !== id) return;
    this.byId.delete(id);
    l.id = undefined;
    void this.d.plugins.stop(l.pluginId, id).catch(() => {});
    l.failures++;
    const wait = RETRY_MS[Math.min(l.failures, RETRY_MS.length) - 1];
    const listening = this.started && this.live.get(l.key) === l;
    this.pluginLog(l.pluginId, `${l.type}: ${why}${listening ? `; trying again in ${pause(wait)}` : ""}`);
    if (!listening) return;
    clearTimeout(l.timer);
    l.timer = setTimeout(() => {
      l.timer = undefined;
      // A trigger still listens, the engine runs, and the plugin does (else its start makes it again).
      if (!this.started || this.live.get(l.key) !== l || l.id || !this.sources().get(l.type)?.running) return;
      void this.open(l);
    }, wait);
    l.timer.unref?.();
  }

  /** Stops `l`'s subscription in its plugin, when it has one there; no try is made again. */
  private close(l: Live): void {
    clearTimeout(l.timer);
    l.timer = undefined;
    const id = l.id;
    if (!id) return;
    this.byId.delete(id);
    l.id = undefined;
    void this.d.plugins.stop(l.pluginId, id).catch((e) => this.pluginLog(l.pluginId, `${l.type}: the plugin did not stop subscription ${id}: ${message(e)}`));
  }

  /** Counts one emit against the plugin's minute; false past the limit. */
  private take(pluginId: string): boolean {
    const now = this.now();
    let r = this.rates.get(pluginId);
    if (!r || now - r.from >= RATE_MS) this.rates.set(pluginId, (r = { from: now, count: 0 }));
    return ++r.count <= EMITS_PER_MINUTE;
  }

  private pluginLog(pluginId: string, msg: string): void {
    if (this.d.plugins.log) this.d.plugins.log(pluginId, msg);
    else this.log(`${pluginId}: ${msg}`);
  }

  private log(msg: string): void {
    if (this.d.log) this.d.log(msg);
    else console.warn(`[piomio] signals: ${msg}`);
  }
}
