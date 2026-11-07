// What a trigger does with what came in before, or instead of, waking its agent
// (docs/superpowers/specs/2026-11-07-unified-triggers-design.md, section 3): match → dedup → flood → batch → script →
// quick check (triage) → outcome. The outcome is a note for the agent, a wake (a task, as before) or nothing. A pass that
// gets past dedup leaves one run in the journal with what each stage did. All of it runs inside the engine's lock for
// the trigger. An open batch lives in trigger_state under "__batch" (keys starting with "__" are the engine's own), so
// a restart, or another replica taking the lead, carries it on.

import { randomBytes } from "node:crypto";
import type { QuickModel } from "../bare-ask.ts";
import type { TriggerEngine } from "./engine.ts";
import type { FetchLike, PipelineServices } from "./host.ts";
import { matches } from "./match.ts";
import { pioFor } from "./pio.ts";
import { truncateBytes } from "./prompt.ts";
import { runScript, SCRIPT_LIMITS, type ScriptResult } from "./sandbox.ts";
import { localDate } from "./schedule.ts";
import { MAX_STATE_BYTES, type NoteRow, type TriggerStore } from "./store.ts";
import { triage } from "./triage.ts";
import type { Outcome, RunReason, Signal, StageRecord, Trigger, TriggerRun } from "./types.ts";
import { DEFAULT_TRIAGE_PER_DAY } from "./validate.ts";

/** A delivery key seen this recently on the same trigger is a repeat; at most DEDUP_KEYS are kept, the oldest go. */
const DEDUP_MS = 24 * 3600_000;
const DEDUP_KEYS = 1000;
const KEY_MAX = 200;
/** Over FLOOD_BATCH signals a minute a trigger batches them for a minute by itself; over FLOOD_DROP they are dropped. */
const FLOOD_MS = 60_000;
const FLOOD_BATCH = 60;
const FLOOD_DROP = 1000;
const FLOOD_WINDOW_SEC = 60;
/** Failed runs in a row before the person hears of it, once. */
export const FAILING_AFTER = 5;
/** Where an open batch is kept, in trigger_state. */
export const BATCH_KEY = "__batch";
/** A signal's data at most, as JSON, and how deep it may nest: past either it is replaced (`trimmed`). */
export const SIGNAL_DATA_MAX = 256 * 1024;
export const SIGNAL_DATA_DEPTH = 50;
/** How much of a run's signals' data the journal keeps; past it, a signal is kept without its data. */
const RUN_DATA_KEPT = 1024 * 1024;
const NOTE_MAX = 8 * 1024;
const ERROR_MAX = 2000;
const RECENT_NOTES = 5;
const NOT_KEPT = "(not kept: this run's signals were too large to keep in full)";

const newRunId = () => `r_${randomBytes(4).toString("hex")}`;
export const newSignalId = () => `sig_${randomBytes(8).toString("hex")}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function jsonOf(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "null";
  } catch {
    return String(v);
  }
}

/** A signal from one of core's own sources (time.tick, web.page, web.webhook, manual). */
export function builtinSignal(type: string, data: unknown, o: { at: Date; external: boolean; key?: string; subject?: string }): Signal {
  return {
    id: newSignalId(),
    type,
    source: "hub",
    at: o.at.toISOString(),
    data,
    ...(o.key ? { key: o.key.slice(0, KEY_MAX) } : {}),
    ...(o.subject ? { subject: o.subject } : {}),
    external: o.external,
  };
}

/** Nested deeper than `max` levels (an object or a list is a level), found without recursion. */
function deeperThan(v: unknown, max: number): boolean {
  const stack: Array<[unknown, number]> = [[v, 0]];
  while (stack.length) {
    const [x, depth] = stack.pop()!;
    if (x === null || typeof x !== "object") continue;
    if (depth + 1 > max) return true;
    for (const child of Array.isArray(x) ? x : Object.values(x)) if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
  }
  return false;
}

/**
 * A signal as the pipeline takes it in: data nested past 50 levels or over 256 KB as JSON is replaced with
 * `{ truncated: true, reason }` (a script could not pass it on in a verdict, the sandbox could not even be given it).
 */
export function trimmed(s: Signal): Signal {
  let reason: string | undefined;
  if (deeperThan(s.data, SIGNAL_DATA_DEPTH)) reason = `its data is nested deeper than ${SIGNAL_DATA_DEPTH} levels`;
  else if (Buffer.byteLength(jsonOf(s.data)) > SIGNAL_DATA_MAX) reason = `its data is over ${SIGNAL_DATA_MAX / 1024} KB`;
  return reason ? { ...s, data: { truncated: true, reason } } : s;
}

const wasTrimmed = (s: Signal): boolean => {
  const d = s.data as Record<string, unknown> | null;
  return !!d && typeof d === "object" && !Array.isArray(d) && d.truncated === true && typeof d.reason === "string" && Object.keys(d).length === 2;
};

/** The journal line for signals whose data was replaced on the way in. */
function trimLine(signals: Signal[]): StageRecord | undefined {
  const cut = signals.filter(wasTrimmed);
  if (!cut.length) return undefined;
  const why = cut
    .slice(0, 5)
    .map((s) => `${s.id}: ${(s.data as { reason: string }).reason}`)
    .join("; ");
  return { stage: "match", verdict: "trimmed", why: `data replaced (${why}${cut.length > 5 ? `; and ${cut.length - 5} more` : ""})` };
}

/** A value for a signal's data within `max` bytes as JSON: as it is, or its text cut short. */
export function within(v: unknown, max: number): { value: unknown; truncated: boolean } {
  const text = typeof v === "string" ? v : jsonOf(v);
  if (Buffer.byteLength(text) + (typeof v === "string" ? 2 : 0) <= max) return { value: v, truncated: false };
  return { value: truncateBytes(text, max).text, truncated: true };
}

export interface DeliverOptions {
  /** As the engine's fire: past the daily limit (a one-time reminder, the person's run from the UI). */
  force?: boolean;
  /** As the engine's fire: skipped while the previous task still runs (schedules). */
  skipIfBusy?: boolean;
  /** catch-up: the slot that was missed (the goal says so). */
  missedAt?: string;
  /** Now, whatever the batch: an open batch goes along (a run now, a one-time reminder). */
  immediate?: boolean;
}

/** What became of signals given to the pipeline: the run it wrote, and why it held them (then there may be none). */
export interface Delivery {
  run?: TriggerRun;
  held?: "filtered" | "duplicate" | "batch" | "flood";
}

/** A test run's path (trigger_test): what each stage did and what the outcome would be; nothing is carried out. */
export interface DryRun {
  stages: StageRecord[];
  outcome?: Outcome;
  summary?: string;
  context?: unknown;
  external: boolean;
  /** The script failed: there is no outcome. */
  error?: string;
}

interface PendingBatch {
  /** ms */
  openedAt: number;
  windowSec: number;
  max?: number;
  reason: RunReason;
  force?: boolean;
  skipIfBusy?: boolean;
  signals: Signal[];
}

interface Pass {
  /** The script gets a list (the trigger batches, or a flood made it). */
  batched: boolean;
  /** A test run: no state written, no quick checks counted. */
  dry: boolean;
  force?: boolean;
}

interface RunOptions extends Pass {
  skipIfBusy?: boolean;
  missedAt?: string;
  /** A batch's window (seconds), for its journal line. */
  window?: number;
}

/** What the stages decided, before the outcome is carried out; `why` goes on the outcome's journal line. */
interface Judgement extends DryRun {
  why?: string;
}

/** For a host that gives the pipeline nothing (tests of the old engine): scripts' calls fail, the quick model is unavailable. */
export const NO_SERVICES: PipelineServices = {
  callRead: async (_as, name) => ({
    result: { content: [{ type: "text", text: `Tool ${name} is not available to triggers here` }], isError: true, _meta: { status: "denied" } },
    source: false,
  }),
  fetchFor: () => ({ fetch: () => Promise.reject(new Error("pio.fetch is not available here")), release() {} }),
  quick: { ask: () => Promise.reject(new Error("no quick model is available here")) },
};

const briefOf = (s: Signal) => ({ id: s.id, type: s.type, ...(s.subject ? { subject: s.subject } : {}) });

/** The signals the journal keeps with a run: in full up to 1 MB of data, the rest without it. */
function keptData(signals: Signal[]): Signal[] {
  let left = RUN_DATA_KEPT;
  return signals.map((s) => {
    const size = Buffer.byteLength(jsonOf(s.data));
    if (size <= left) {
      left -= size;
      return s;
    }
    return { ...s, data: NOT_KEPT };
  });
}

/** A note's text when no summary was made: what came in, by type and subject. */
function describe(signals: Signal[]): string {
  const head = signals
    .slice(0, 5)
    .map((s) => (s.subject ? `${s.type}: ${s.subject}` : s.type))
    .join("; ");
  return `Not looked at by the quick model: ${head}${signals.length > 5 ? `; and ${signals.length - 5} more` : ""}`;
}

/** The store as a test run's script sees it: its state writes stay in the run, the rest is read as it is. */
function dryStore(store: TriggerStore): TriggerStore {
  const local = new Map<string, string | undefined>();
  const at = (id: string, k: string) => `${id}\u0000${k}`;
  return {
    ...store,
    addRun() {},
    dropRuns() {},
    dropState() {},
    addNote() {
      throw new Error("a test run keeps no notes");
    },
    stateGet(id, k) {
      if (!local.has(at(id, k))) return store.stateGet(id, k);
      const v = local.get(at(id, k));
      return v === undefined ? undefined : JSON.parse(v);
    },
    stateSet(id, k, value) {
      const text = JSON.stringify(value ?? null);
      if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new RangeError("trigger state is limited to 1 MB");
      local.set(at(id, k), text);
    },
    stateDelete(id, k) {
      local.set(at(id, k), undefined);
    },
  };
}

export class TriggerPipeline {
  private e: TriggerEngine;
  private s: PipelineServices;
  /** Open batches' timers, by trigger. */
  private timers = new Map<string, NodeJS.Timeout>();
  /** When signals came in the last minute, by trigger (at most FLOOD_DROP + 1 of them). */
  private arrivals = new Map<string, number[]>();
  /** When the last flood line went into the journal, by trigger. */
  private floodLine = new Map<string, number>();
  private stopped = false;

  constructor(e: TriggerEngine, s: PipelineServices) {
    this.e = e;
    this.s = s;
  }

  private get store(): TriggerStore {
    return this.e.ctx.store;
  }

  /** One or more signals for a trigger; returns the run written to the journal (or undefined when match/dedup let nothing through, or a batch is still open). */
  async deliver(t: Trigger, signals: Signal[], reason: RunReason, o: DeliverOptions = {}): Promise<TriggerRun | undefined> {
    return (await this.take(t, signals, reason, o)).run;
  }

  /** deliver, saying why no run was written when none was (the webhook's answer tells the sender). */
  async take(t: Trigger, signals: Signal[], reason: RunReason, o: DeliverOptions = {}): Promise<Delivery> {
    const now = this.e.now();
    let held: Delivery["held"];
    const passed: Signal[] = [];
    for (const sig of signals.map(trimmed)) {
      if (!this.passes(t, sig)) {
        t.state.filtered = (t.state.filtered ?? 0) + 1;
        held = "filtered";
      } else if (sig.key !== undefined && this.seen(t, sig.key, now, true)) held = "duplicate";
      else passed.push(sig);
    }
    if (!passed.length) {
      await this.e.save(t);
      return { held };
    }
    const pending = this.pending(t.id);
    if (o.immediate) {
      if (!pending) return { run: await this.run(t, passed, reason, { ...o, dry: false, batched: !!t.batch || passed.length > 1 }) };
      // What the open batch gathered goes along.
      this.closeBatch(t.id);
      return { run: await this.run(t, [...pending.signals, ...passed], reason, { ...o, dry: false, batched: true, window: pending.windowSec }) };
    }
    const rate = this.arrive(t.id, now, passed.length);
    if (rate > FLOOD_DROP) return this.flood(t, passed, reason, now);
    const cfg = pending ? { windowSec: pending.windowSec, max: pending.max } : (t.batch ?? (rate > FLOOD_BATCH ? { windowSec: FLOOD_WINDOW_SEC } : undefined));
    if (!cfg) return { run: await this.run(t, passed, reason, { ...o, dry: false, batched: passed.length > 1 }) };
    return this.hold(t, passed, reason, o, cfg, pending, now);
  }

  /** The same path with no outcome: what each stage did (trigger_test). The script runs for real; its state writes stay in the test. */
  async dryRun(t: Trigger, signals: Signal[]): Promise<DryRun> {
    const now = this.e.now();
    const stages: StageRecord[] = [];
    const kept: Signal[] = [];
    for (const s of signals.map(trimmed)) {
      if (!this.passes(t, s)) stages.push({ stage: "match", verdict: "drop", why: `${s.id}: the filter (where) leaves it out` });
      else if (s.key !== undefined && this.seen(t, s.key, now, false)) stages.push({ stage: "dedup", verdict: "drop", why: `${s.id}: its key was seen in the last 24 h` });
      else kept.push(s);
    }
    if (!kept.length) return { stages, outcome: "drop", external: signals.some((s) => s.external) };
    const { why: _why, ...j } = await this.judge(t, kept, { batched: !!t.batch || kept.length > 1, dry: true });
    const cut = trimLine(kept);
    return { ...j, stages: [...stages, ...(cut ? [cut] : []), ...j.stages] };
  }

  /** Open batches found at start (in trigger_state "__batch") get their timers back. */
  async resume(): Promise<void> {
    for (const t of this.e.list()) {
      if (this.stopped) return;
      const b = this.pending(t.id);
      if (b) this.arm(t.id, b);
    }
  }

  /** Every open batch whose window has closed goes on now (the timers do this; tests call it with their own clock). */
  async flushDue(): Promise<TriggerRun[]> {
    const out: TriggerRun[] = [];
    for (const t of this.e.list()) {
      const run = await this.e.withLock(t.id, () => this.flushIfDue(t.id));
      if (run) out.push(run);
    }
    return out;
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** The trigger was deleted: its timer and counters go (its stored batch went with its state). */
  forget(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.arrivals.delete(id);
    this.floodLine.delete(id);
  }

  // ---------- match, dedup, flood ----------

  /** A signal passes when it came by no subscription (core's own sources) or one of its type whose filter it meets. */
  private passes(t: Trigger, s: Signal): boolean {
    const subs = (t.on ?? []).filter((x) => x.type === s.type);
    return !subs.length || subs.some((x) => matches(x.where, s));
  }

  /** The key came in the last 24 h; `record` keeps it (at most 1000 keys, the oldest go). */
  private seen(t: Trigger, key: string, now: number, record: boolean): boolean {
    const k = key.slice(0, KEY_MAX);
    // Through a Map: a key like "__proto__" is a key like any other.
    const keys = new Map(Object.entries(t.state.seenKeys ?? {}).filter(([, at]) => typeof at === "number" && now - at < DEDUP_MS));
    const hit = keys.has(k);
    if (!record) return hit;
    if (!hit) keys.set(k, now);
    t.state.seenKeys = Object.fromEntries([...keys].sort((a, z) => a[1] - z[1]).slice(-DEDUP_KEYS));
    return hit;
  }

  /** How many signals came in the last minute, these included. */
  private arrive(id: string, now: number, n: number): number {
    const list = (this.arrivals.get(id) ?? []).filter((at) => now - at < FLOOD_MS);
    for (let i = 0; i < n; i++) list.push(now);
    if (list.length > FLOOD_DROP + 1) list.splice(0, list.length - (FLOOD_DROP + 1));
    this.arrivals.set(id, list);
    return list.length;
  }

  /** Over 1000 a minute: dropped, with one journal line a minute. */
  private async flood(t: Trigger, signals: Signal[], reason: RunReason, now: number): Promise<Delivery> {
    await this.e.save(t);
    if (now - (this.floodLine.get(t.id) ?? -Infinity) < FLOOD_MS) return { held: "flood" };
    this.floodLine.set(t.id, now);
    const run: TriggerRun = {
      id: newRunId(),
      at: new Date(now).toISOString(),
      reason,
      status: "skipped",
      detail: `Over ${FLOOD_DROP} signals a minute: they are dropped until fewer come`,
      signals: signals.map(briefOf),
      stages: [{ stage: "outcome", verdict: "drop", why: "flood" }],
      outcome: "drop",
      external: signals.some((s) => s.external),
    };
    await this.e.addRun(t.id, run);
    this.e.emit(t.id);
    this.e.ctx.log.warn(`trigger ${t.id}: over ${FLOOD_DROP} signals a minute, dropping them`);
    return { run, held: "flood" };
  }

  // ---------- batches ----------

  private pending(id: string): PendingBatch | undefined {
    const b = this.store.stateGet(id, BATCH_KEY) as PendingBatch | undefined;
    return b && typeof b === "object" && Array.isArray(b.signals) && Number.isFinite(b.openedAt) && Number.isFinite(b.windowSec) ? b : undefined;
  }

  private closeBatch(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.store.stateDelete(id, BATCH_KEY);
  }

  private async hold(
    t: Trigger,
    signals: Signal[],
    reason: RunReason,
    o: DeliverOptions,
    cfg: { windowSec: number; max?: number },
    pending: PendingBatch | undefined,
    now: number,
  ): Promise<Delivery> {
    const opened: PendingBatch = pending ?? {
      openedAt: now,
      windowSec: cfg.windowSec,
      ...(cfg.max !== undefined ? { max: cfg.max } : {}),
      reason,
      ...(o.force ? { force: true } : {}),
      ...(o.skipIfBusy ? { skipIfBusy: true } : {}),
      signals: [],
    };
    const b: PendingBatch = { ...opened, signals: [...opened.signals, ...signals] };
    if (b.max !== undefined && b.signals.length >= b.max) {
      // Full: it goes on now.
      this.closeBatch(t.id);
      return { run: await this.flushed(t, b) };
    }
    try {
      this.store.stateSet(t.id, BATCH_KEY, b);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      // Too big to keep beside the trigger's state: what was gathered goes on now, and so do these.
      this.closeBatch(t.id);
      if (pending) await this.flushed(t, pending);
      return { run: await this.run(t, signals, reason, { ...o, dry: false, batched: true }) };
    }
    await this.e.save(t);
    this.arm(t.id, b);
    return { held: "batch" };
  }

  private arm(id: string, b: PendingBatch): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    if (this.stopped) return;
    const delay = Math.max(0, b.openedAt + b.windowSec * 1000 - this.e.now());
    const timer: NodeJS.Timeout = setTimeout(() => {
      if (this.timers.get(id) === timer) this.timers.delete(id);
      void this.e.withLock(id, () => this.flushIfDue(id)).catch((err) => this.e.ctx.log.error(`trigger ${id}: its batch failed: ${message(err)}`));
    }, delay);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private async flushIfDue(id: string): Promise<TriggerRun | undefined> {
    if (this.stopped) return undefined;
    const b = this.pending(id);
    if (!b) return undefined;
    const t = this.e.get(id);
    if (!t) {
      this.closeBatch(id);
      return undefined;
    }
    if (this.e.now() < b.openedAt + b.windowSec * 1000) {
      this.arm(id, b);
      return undefined;
    }
    this.closeBatch(id);
    // Turned off meanwhile: what it gathered goes with it.
    if (!t.enabled) return undefined;
    return this.flushed(t, b);
  }

  private flushed(t: Trigger, b: PendingBatch): Promise<TriggerRun> {
    return this.run(t, b.signals, b.reason, { dry: false, batched: true, force: b.force, skipIfBusy: b.skipIfBusy, window: b.windowSec });
  }

  // ---------- a run ----------

  private async run(t: Trigger, signals: Signal[], reason: RunReason, o: RunOptions): Promise<TriggerRun> {
    const at = new Date(this.e.now()).toISOString();
    const j = await this.judge(t, signals, o);
    const cut = trimLine(signals);
    const stages: StageRecord[] = [
      ...(cut ? [cut] : []),
      ...(o.window !== undefined ? [{ stage: "batch" as const, verdict: "flush", why: `${signals.length} signal(s) gathered over ${o.window} s` }] : []),
      ...j.stages,
    ];
    const journal = { signals: signals.map(briefOf), stages, external: j.external };
    const signalData = keptData(signals);
    if (j.error !== undefined) return this.failed(t, reason, at, journal, signalData, j.error);
    t.state.errorsInRow = 0;
    const outcome: Outcome = j.outcome ?? "wake";
    stages.push({ stage: "outcome", verdict: outcome, ...(j.why ? { why: j.why } : {}) });
    if (outcome === "wake") {
      const pipeline = { summary: j.summary ?? "", ...(j.context !== undefined ? { context: j.context } : {}), signals: journal.signals, external: j.external };
      return this.e.fire(t, reason, { pipeline, ...(o.missedAt ? { missedAt: o.missedAt } : {}) }, {
        force: o.force,
        skipIfBusy: o.skipIfBusy,
        tainted: j.external,
        journal: { ...journal, outcome },
        signalData,
      });
    }
    const run: TriggerRun = { id: newRunId(), at, reason, status: "started", ...journal, outcome };
    if (outcome === "note") {
      const text = truncateBytes(j.summary?.trim() || describe(signals), NOTE_MAX).text;
      run.noteId = this.store.addNote({ agentId: t.agentId, triggerId: t.id, triggerName: t.name, text, signalIds: signals.map((s) => s.id), external: j.external }).id;
    }
    t.state.lastRunAt = at;
    t.state.lastStatus = "ok";
    t.state.lastError = t.state.lastErrorCode = t.state.lastErrorParams = undefined;
    await this.e.save(t);
    await this.e.addRun(t.id, run, signalData);
    this.e.emit(t.id);
    return run;
  }

  /** The script failed: an error run; after the fifth in a row the person hears of it, once. */
  private async failed(
    t: Trigger,
    reason: RunReason,
    at: string,
    journal: Pick<TriggerRun, "signals" | "stages" | "external">,
    signalData: Signal[],
    error: string,
  ): Promise<TriggerRun> {
    const run: TriggerRun = { id: newRunId(), at, reason, status: "error", detail: error, ...journal };
    t.state.errorsInRow = (t.state.errorsInRow ?? 0) + 1;
    t.state.lastStatus = "error";
    t.state.lastError = error;
    t.state.lastErrorCode = t.state.lastErrorParams = undefined;
    await this.e.save(t);
    await this.e.addRun(t.id, run, signalData);
    this.e.emit(t.id);
    this.e.ctx.log.info(`trigger ${t.id} error: ${error}`);
    if (t.state.errorsInRow === FAILING_AFTER) await this.tellFailing(t, error);
    return run;
  }

  private async tellFailing(t: Trigger, error: string): Promise<void> {
    try {
      // The title in the person's language; the script's error (English, no code) as it is.
      await this.e.ctx.core.call("notify", { level: "notify", title: this.e.ctx.i18n.t("notify.failing", { name: t.name }), body: error, triggerId: t.id, agentId: t.agentId });
    } catch (e) {
      this.e.ctx.log.warn(`notify failed: ${message(e)}`);
    }
  }

  // ---------- the stages ----------

  /** The script, then the quick check: the outcome they decide on, or the script's error. */
  private async judge(t: Trigger, signals: Signal[], p: Pass): Promise<Judgement> {
    const stages: StageRecord[] = [];
    let external = signals.some((s) => s.external);
    let context: unknown;
    let asked = false;
    if (t.script) {
      const r = await this.script(t, signals, p);
      external ||= r.external;
      // pio calls the script left running when its wall time ran out (reported by the sandbox when it knows).
      const dropped = (r as ScriptResult & { droppedCalls?: number }).droppedCalls;
      const logs = dropped ? [...r.logs, `[piomio] ${dropped} pio call(s) the script did not wait for were dropped at the wall time`] : r.logs;
      const rec: StageRecord = { stage: "script", ms: r.ms, ...(logs.length ? { logs } : {}), ...(r.tokens ? { tokens: r.tokens } : {}) };
      if (r.error !== undefined) {
        const error = clip(r.error, ERROR_MAX);
        stages.push({ ...rec, error });
        return { stages, external, error };
      }
      const v = r.verdict;
      if (v && "drop" in v) return { stages: [{ ...rec, verdict: "drop", why: v.drop }], external, outcome: "drop", why: "the script dropped it" };
      if (v && "note" in v) return { stages: [{ ...rec, verdict: "note", why: v.note }], external, outcome: "note", summary: v.note, why: "the script kept a note" };
      if (v && "wake" in v) {
        return { stages: [{ ...rec, verdict: "wake", why: v.wake }], external, outcome: "wake", summary: v.wake, ...(v.context !== undefined ? { context: v.context } : {}), why: "the script woke the agent" };
      }
      if (v && "triage" in v) {
        context = v.triage;
        asked = true;
      }
      stages.push({ ...rec, verdict: asked ? "triage" : "none" });
      if (!t.triage) {
        const why = asked ? "the script asked for a quick check, but this trigger has none" : "the script returned nothing and there is no quick check";
        return { stages, external, outcome: "wake", ...(context !== undefined ? { context } : {}), why };
      }
    } else if (!t.triage) return { stages, external, outcome: "wake", why: "no script and no quick check" };
    const q = await this.quickCheck(t, signals, context, p);
    stages.push(q.stage);
    return { stages, external: external || q.external, outcome: q.outcome, summary: q.summary, why: q.why, ...(context !== undefined ? { context } : {}) };
  }

  private async script(t: Trigger, signals: Signal[], p: Pass): Promise<ScriptResult & { external: boolean; tokens: number }> {
    const sc = t.script!;
    const hosts = [...(sc.hosts ?? [])];
    const t0 = performance.now();
    let net: { fetch: FetchLike; release(): void };
    try {
      net = this.s.fetchFor(t.id, hosts);
    } catch (e) {
      return { error: `the script could not start: ${message(e)}`, logs: [], ms: 0, calls: 0, external: false, tokens: 0 };
    }
    const deadline = t0 + SCRIPT_LIMITS.wallMs;
    const pio = pioFor({
      trigger: t,
      tz: this.e.tz,
      now: () => new Date(this.e.now()),
      callRead: (name, input) => this.s.callRead({ agentId: t.agentId, triggerId: t.id, hosts }, name, input),
      fetch: net.fetch,
      release: net.release,
      allowPrivate: this.e.settings.allowPrivateUrls,
      quick: this.s.quick,
      triageBudget: () => (p.dry ? this.triageLeft(t) > 0 : this.takeTriage(t)),
      store: p.dry ? dryStore(this.store) : this.store,
    });
    let r: ScriptResult;
    try {
      const input = p.batched ? { signals, now: pio.now() } : { signal: signals[0], now: pio.now() };
      r = await runScript(sc.code, input, pio.host);
    } catch (e) {
      r = { error: message(e), logs: [], ms: Math.round(performance.now() - t0), calls: 0 };
    } finally {
      // On every path, before anything reads what the run reached: calls still out are waited for (only as long as
      // the run's wall time has left), fetches cut off, the run's egress token let go.
      await pio.close(Math.max(0, deadline - performance.now()));
    }
    return { ...r, external: pio.external(), tokens: pio.tokens() };
  }

  private async quickCheck(
    t: Trigger,
    signals: Signal[],
    context: unknown,
    p: Pass,
  ): Promise<{ stage: StageRecord; outcome: Outcome; summary?: string; why: string; external: boolean }> {
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    if (!(p.dry ? this.triageLeft(t) > 0 : this.takeTriage(t))) {
      const why = "this trigger's quick checks for today are used up (triagePerDay)";
      return { stage: { stage: "triage", verdict: "unavailable", why }, ...this.fallback(t, signals, why, p), external: false };
    }
    let chars = 0;
    const counted: QuickModel = {
      ask: async (prompt, o) => {
        const r = await this.s.quick.ask(prompt, o);
        chars += prompt.length + (o?.system?.length ?? 0) + r.text.length;
        return r;
      },
    };
    // Earlier notes, so it does not repeat itself; one made from outside content brings it into this run.
    const notes: NoteRow[] = this.store.notes({ triggerId: t.id, limit: RECENT_NOTES });
    const external = notes.some((n) => n.external);
    try {
      const a = await triage(counted, { trigger: { name: t.name, brief: t.triage!.brief }, signals, ...(context !== undefined ? { context } : {}), recentNotes: notes.map((n) => n.text) });
      return {
        stage: { stage: "triage", verdict: a.decision, why: a.why, ms: ms(), tokens: Math.ceil(chars / 4) },
        outcome: a.decision,
        summary: a.summary || a.why,
        why: "the quick check decided",
        external,
      };
    } catch (e) {
      const error = clip(message(e), ERROR_MAX);
      return {
        stage: { stage: "triage", error, ms: ms(), ...(chars ? { tokens: Math.ceil(chars / 4) } : {}) },
        ...this.fallback(t, signals, `the quick model is unavailable (${error})`, p),
        external,
      };
    }
  }

  /** No quick check could be made: the agent is woken while the day's wakes last, else it becomes a note. */
  private fallback(t: Trigger, signals: Signal[], why: string, p: Pass): { outcome: Outcome; summary?: string; why: string } {
    if (p.force || this.wakesUsed(t) < t.maxRunsPerDay) return { outcome: "wake", why: `${why}: woken while the day's wakes last` };
    return { outcome: "note", summary: describe(signals), why: `${why}, and the day's wakes are used up: kept as a note` };
  }

  private today(): string {
    return localDate(new Date(this.e.now()), this.e.tz);
  }

  private wakesUsed(t: Trigger): number {
    return t.state.runsToday?.date === this.today() ? t.state.runsToday.count : 0;
  }

  private triageUsed(t: Trigger): number {
    return t.state.triageToday?.date === this.today() ? t.state.triageToday.count : 0;
  }

  private triageLeft(t: Trigger): number {
    return (t.triagePerDay ?? DEFAULT_TRIAGE_PER_DAY) - this.triageUsed(t);
  }

  /** Takes one of the day's quick checks (triage, pio.llm.ask); false when none is left. */
  private takeTriage(t: Trigger): boolean {
    if (this.triageLeft(t) <= 0) return false;
    t.state.triageToday = { date: this.today(), count: this.triageUsed(t) + 1 };
    return true;
  }
}
