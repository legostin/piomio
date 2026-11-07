// Where signals come from (docs/superpowers/specs/2026-11-07-unified-triggers-design.md, section 1): core's own four
// sources (builtin-sources.ts) and each plugin's, declared in its manifest (contributes.signals) and exposed as
// <pluginId>.<type>; the hub's own (hub.*, from the bus) start and stop with this registry too.
//
// A plugin's signal is checked here: its rate, that its type is declared, the subscription it came by, the intake's
// caps (50 levels, 256 KB) and its data schema. Then it goes to the enabled triggers that listen, through the pipeline's
// arrival-time intake (the sink, TriggerPipeline.deliver), which still matches, dedups and counts floods for each.
// Subscribe-mode sources work only while a trigger subscribes: one plugin subscription per distinct (type, canonical
// config) among the enabled triggers, stopped when none is left, made again when the plugin restarts, and tried again
// with a growing pause when the plugin fails to take it.
//
// A declared schema runs on the hub's thread against outside content, so it is checked once, when the declarations
// are first read: its patterns compile on V8's linear-time engine (match.ts), and what could take more than linear time
// (uniqueItems, $ref, long enums, many patterns) or work asynchronously is refused, with the reason in the plugin's log.

import { randomBytes } from "node:crypto";
import { Ajv, type ValidateFunction } from "ajv";
import type { Locale, SignalDecl } from "@piomio/shared";
import type { EventBus } from "../bus.ts";
import { hubLocale, tFor } from "../i18n.ts";
import { BUILTIN_SOURCES_INFO } from "./builtin-sources.ts";
import { HUB_SOURCES, listenToHub, type HubListenDeps, type MachineView } from "./hub-sources.ts";
import { linearRegExp } from "./match.ts";
import { canonicalJson, dataProblem, newSignalId } from "./pipeline.ts";
import { BUILTIN_SOURCES, type Signal, type Trigger } from "./types.ts";

/** Signals one plugin may emit a minute; past it they are refused before anything else is looked at. */
export const EMITS_PER_MINUTE = 600;
/** A subscription the plugin did not take is tried again after these pauses, then every 30 minutes. */
export const RETRY_MS = [30_000, 120_000, 600_000, 1_800_000];
const RATE_MS = 60_000;
const KEY_MAX = 200;
const SUBJECT_MAX = 500;
/** Room kept past a key's or subject's bound before redacting: a known secret that starts within the bound stays whole. */
const LINE_SPARE = 4096;
/** A declared schema, at most: as JSON, its nesting, an enum's values, its patterns. */
const SCHEMA_MAX = 16 * 1024;
const SCHEMA_DEPTH = 32;
const ENUM_MAX = 1000;
const PATTERNS_MAX = 100;
/** Config checks kept per declaration (by canonical config). */
const CONFIG_CHECKS_KEPT = 1000;
/** The hub's own sources are hub.*: no plugin's. */
const HUB = "hub";
/** Types no plugin's source may take: core's own sources and the signals they bring. */
const RESERVED = new Set<string>([...BUILTIN_SOURCES, "time.tick"]);
/** Keywords whose value maps names to schemas (the names are no keywords), and keywords whose value is data. */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]);
const DATA_KEYWORDS = new Set(["enum", "const", "default", "examples", "$comment", "title", "description"]);
const REFS = ["$ref", "$dynamicRef", "$recursiveRef"];

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
  /** Known secrets taken out of what a plugin sends (the vault's redactor); unset: kept as it came. */
  redact?: <T>(v: T) => T;
  /** What went wrong beyond one plugin; unset: the console. */
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

/** A declared type as checked once: its compiled schemas, or why it is refused. */
type Checked = { data?: ValidateFunction; config?: ValidateFunction } | { refused: string };

interface Source {
  pluginId: string;
  decl: SignalDecl;
  checked: Exclude<Checked, { refused: string }>;
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

/** Patterns of a declared schema run on V8's linear-time engine (match.ts); one it cannot run is refused at compile. */
const linearPatterns = Object.assign((pattern: string, flags: string) => linearRegExp(pattern, flags), { code: "linearRegExp" });

/** Why a declared schema is refused before it is compiled; undefined when it may be. */
function schemaRefusal(schema: unknown): string | undefined {
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(schema));
  } catch {
    return "is not JSON";
  }
  if (size > SCHEMA_MAX) return `is over ${SCHEMA_MAX / 1024} KB`;
  let patterns = 0;
  const stack: Array<[unknown, number]> = [[schema, 0]];
  while (stack.length) {
    const [s, depth] = stack.pop()!;
    if (!s || typeof s !== "object") continue;
    if (depth > SCHEMA_DEPTH) return `is nested deeper than ${SCHEMA_DEPTH} levels`;
    if (Array.isArray(s)) {
      for (const x of s) stack.push([x, depth + 1]);
      continue;
    }
    const o = s as Record<string, unknown>;
    if (o.uniqueItems === true) return "uses uniqueItems (its check takes quadratic time)";
    if ("$async" in o) return "uses $async (signals are checked as they come)";
    for (const k of REFS) if (k in o) return `uses ${k} (write the schema out in full: a reference can make its check exponential)`;
    if (Array.isArray(o.enum) && o.enum.length > ENUM_MAX) return `has an enum of more than ${ENUM_MAX} values`;
    if (typeof o.pattern === "string") patterns++;
    if (o.patternProperties && typeof o.patternProperties === "object") patterns += Object.keys(o.patternProperties).length;
    if (patterns > PATTERNS_MAX) return `has more than ${PATTERNS_MAX} patterns`;
    for (const [k, v] of Object.entries(o)) {
      if (DATA_KEYWORDS.has(k)) continue;
      if (SCHEMA_MAPS.has(k) && v && typeof v === "object" && !Array.isArray(v)) for (const x of Object.values(v)) stack.push([x, depth + 1]);
      else stack.push([v, depth + 1]);
    }
  }
  return undefined;
}

function checkDecl(ajv: Ajv, pluginId: string, decl: SignalDecl): Checked {
  if (pluginId === HUB || RESERVED.has(`${pluginId}.${decl.type}`)) return { refused: "it takes the name of one of the hub's own sources" };
  const out: { data?: ValidateFunction; config?: ValidateFunction } = {};
  for (const what of ["data", "config"] as const) {
    const schema = decl[what];
    if (!schema) continue;
    const bad = schemaRefusal(schema);
    if (bad) return { refused: `its ${what} schema ${bad}` };
    try {
      out[what] = ajv.compile(schema);
    } catch (e) {
      return { refused: `its ${what} schema does not compile: ${message(e)}` };
    }
  }
  return out;
}

/** Each plugin's declarations, checked once when first read (they change only with its layout), by type. */
const checkedDecls = new WeakMap<SignalDecl[], Map<string, Checked>>();

function checkDecls(pluginId: string, decls: SignalDecl[], onRefused?: (type: string, why: string) => void): Map<string, Checked> {
  let out = checkedDecls.get(decls);
  if (out) return out;
  out = new Map();
  // One Ajv per plugin's declarations: their $ids cannot clash with another plugin's.
  const ajv = new Ajv({ strict: false, validateFormats: false, logger: false, unicodeRegExp: false, code: { regExp: linearPatterns } });
  for (const decl of decls) {
    const c = checkDecl(ajv, pluginId, decl);
    out.set(decl.type, c);
    if ("refused" in c) onRefused?.(decl.type, c.refused);
  }
  checkedDecls.set(decls, out);
  return out;
}

/** The first thing a compiled schema found wrong, in one line. */
function mismatch(v: ValidateFunction, what: string): string {
  const e = v.errors?.[0];
  return `${what} does not match the declared schema${e ? `: ${e.instancePath || "(top)"} ${e.message ?? "is invalid"}` : ""}`;
}

const configChecks = new WeakMap<ValidateFunction, Map<string, { problem?: string }>>();
const FITS: { problem?: string } = Object.freeze({});

/**
 * A subscription's config against its source's config schema, checked once per (declaration, canonical config): a
 * sync or a boot reads the answer. `problem` says why it does not fit.
 */
export function checkedConfig(pluginId: string, decls: SignalDecl[], type: string, config: Record<string, unknown>): { problem?: string } {
  const c = checkDecls(pluginId, decls).get(type);
  if (!c) return { problem: `signal type "${type}" is not declared` };
  if ("refused" in c) return { problem: `signal type ${pluginId}.${type} is refused: ${c.refused}` };
  const v = c.config;
  if (!v) return FITS;
  let kept = configChecks.get(v);
  if (!kept) configChecks.set(v, (kept = new Map()));
  const canon = canonicalJson(config);
  let r = kept.get(canon);
  if (!r) {
    r = v(config) ? FITS : { problem: mismatch(v, "its config") };
    if (kept.size >= CONFIG_CHECKS_KEPT) kept.delete(kept.keys().next().value!);
    kept.set(canon, r);
  }
  return r;
}

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
  /** Subscriptions whose config their source refuses, said once. */
  private refused = new Set<string>();

  constructor(d: SignalSourcesDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
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
    this.refused.clear();
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
          if (!this.refused.has(key)) this.pluginLog(src.pluginId, `${sub.type}: not subscribed for trigger ${t.id}: ${problem}`);
          this.refused.add(key);
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
   * to those whose entry has the config of the subscription it came by. Nothing listens while the engine is stopped.
   */
  fromPlugin(pluginId: string, m: PluginEmit): EmitResult {
    if (!this.take(pluginId)) return refuse(`too many signals: at most ${EMITS_PER_MINUTE} a minute from one plugin; this one was dropped`);
    const type = typeof m?.type === "string" ? m.type : "";
    const full = `${pluginId}.${type}`;
    const plugin = this.d.plugins.declared().find((p) => p.pluginId === pluginId);
    const decl = plugin?.decls.find((d) => d.type === type);
    if (!plugin || !decl) return refuse(`signal type "${type}" is not declared in contributes.signals`);
    const checked = this.checked(plugin).get(type);
    if (!checked || "refused" in checked) return refuse(`signal type ${full} is refused: ${checked && "refused" in checked ? checked.refused : "not checked"}`);
    let live: Live | undefined;
    if (decl.mode === "subscribe") {
      if (m.subscription === undefined) return refuse(`${full} is a subscribe-mode source: its signals come only by a subscription the hub made (the emit its provider is given)`);
      live = this.byId.get(String(m.subscription));
      if (!live || live.pluginId !== pluginId || live.local !== type) return refuse(`subscription ${String(m.subscription)} is not active for ${full}`);
    }
    if (m.key !== undefined && typeof m.key !== "string") return refuse(`${full}: key must be a string`);
    if (m.subject !== undefined && typeof m.subject !== "string") return refuse(`${full}: subject must be a string`);
    const data = m.data === undefined ? null : m.data;
    const problem = dataProblem(data) ?? (checked.data && !checked.data(data) ? mismatch(checked.data, "its data") : undefined);
    if (problem) return refuse(`${full} was refused: ${problem}`);
    if (!this.started) return OK;
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
  private checked(p: PluginSignals): Map<string, Checked> {
    return checkDecls(p.pluginId, p.decls, (type, why) => this.pluginLog(p.pluginId, `signal type ${p.pluginId}.${type} is refused and left out: ${why}`));
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
