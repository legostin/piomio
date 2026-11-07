// What a trigger does with what came in before, or instead of, waking its agent
// (docs/superpowers/specs/2026-11-07-unified-triggers-design.md, section 3): match → dedup → flood → batch → script →
// quick check (triage) → outcome. The outcome is a note for the agent, a wake (a task, as before) or nothing. A pass that
// gets past dedup leaves one run in the journal with what each stage did.
//
// Signals are taken in when they arrive (`accept`): trimmed, matched, deduplicated, counted for floods, and put in the
// trigger's open batch or in its queue. All of that is synchronous, so a webhook is answered at once. What is queued is
// carried out in order, one run per turn of the engine's lock for the trigger (`kick`, `step`): the script, the quick
// check, the outcome. So an update or a delete never waits for more than one run. The open batch ("__batch") and the
// queue ("__queue") live in trigger_state (keys starting with "__" are the engine's own).
// A queued run keeps its journal id and leaves the queue only once its outcome is written, so a stop, a crash or
// another replica taking the lead carries it on, and a retry replaces its journal line instead of adding one.

import { randomBytes } from "node:crypto";
import type { QuickModel } from "../bare-ask.ts";
import type { TriggerEngine } from "./engine.ts";
import type { FetchLike, PipelineServices } from "./host.ts";
import { matches } from "./match.ts";
import { pioFor } from "./pio.ts";
import { truncateBytes } from "./prompt.ts";
import { runScript, SCRIPT_LIMITS, type ScriptResult } from "./sandbox.ts";
import { localDate } from "./schedule.ts";
import { checkState, stateBudget, type NoteRow, type StateBudget, type TriggerStore } from "./store.ts";
import { triage } from "./triage.ts";
import type { Outcome, RunReason, Signal, StageRecord, Trigger, TriggerRun } from "./types.ts";
import { DEFAULT_TRIAGE_PER_DAY, MAX_BATCH_SIGNALS } from "./validate.ts";

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
/** A batch that came due while the hub was away waits this long once for what another replica wrote (as engine.ts SETTLE_MS: its pulls are 30 s long polls). */
const SETTLE_MS = 45_000;
/** A queue step that failed outside its run is tried again after this long. */
const STEP_RETRY_MS = 5_000;
/** One question to the quick model (triage, pio.llm.ask) may take this long; past it the model is unavailable. */
export const QUICK_TIMEOUT_MS = 25_000;
/** trigger_state keys of the engine's own: the open batch, the runs waiting their turn, seen delivery keys, signals filtered out. */
export const BATCH_KEY = "__batch";
export const QUEUE_KEY = "__queue";
export const SEEN_KEY = "__seen";
export const FILTERED_KEY = "__filtered";
/** A signal's data at most, as JSON, and how deep it may nest: past either it is replaced (`trimmed`). */
export const SIGNAL_DATA_MAX = 256 * 1024;
export const SIGNAL_DATA_DEPTH = 50;
/** How much of a run's signals' data the journal keeps; past it, a signal is kept without its data. */
const RUN_DATA_KEPT = 1024 * 1024;
const NOTE_MAX = 8 * 1024;
const ERROR_MAX = 2000;
/** A verdict's text and a quick check's why, as the journal keeps them. */
const WHY_MAX = 2000;
const RECENT_NOTES = 5;
const NOT_KEPT = "(not kept: this run's signals were too large to keep in full)";
/** Codes of an engine's fire that skipped a wake: what came in is kept as a note instead. */
const SKIPPED_WAKES = new Set(["dailyLimit", "previousRunning"]);
const STOPPED = "the trigger engine was stopped";

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

const sizeOf = (v: unknown) => Buffer.byteLength(jsonOf(v));

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

/**
 * `data` within `max` bytes as JSON, its text `fields` cut (the longest first) until it fits; `truncated` when any was.
 * The cut is measured on the JSON the signal is kept as, escapes included, so what is cut is only what had to be.
 */
export function fitted(data: Record<string, unknown>, fields: string[], max = SIGNAL_DATA_MAX): { data: Record<string, unknown>; truncated: boolean } {
  let out = data;
  let truncated = false;
  for (let i = 0; i < 64; i++) {
    const over = sizeOf(out) - max;
    if (over <= 0) return { data: out, truncated };
    const field = fields
      .filter((f) => typeof out[f] === "string" && (out[f] as string).length > 0)
      .sort((a, z) => (out[z] as string).length - (out[a] as string).length)[0];
    if (!field) break;
    const text = out[field] as string;
    // Each byte cut takes at least one byte off the JSON (an escaped one takes more), so this converges.
    out = { ...out, [field]: truncateBytes(text, Math.max(0, Buffer.byteLength(text) - over)).text };
    truncated = true;
  }
  return { data: out, truncated };
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
  else if (sizeOf(s.data) > SIGNAL_DATA_MAX) reason = `its data is over ${SIGNAL_DATA_MAX / 1024} KB`;
  return reason ? { ...s, data: { truncated: true, reason } } : s;
}

const wasTrimmed = (s: Signal): boolean => {
  const d = s.data as Record<string, unknown> | null;
  return !!d && typeof d === "object" && !Array.isArray(d) && d.truncated === true && typeof d.reason === "string" && Object.keys(d).length === 2;
};

/** The journal line for signals whose data was replaced on the way in. */
function trimLine(signals: Signal[]): StageRecord[] {
  const cut = signals.filter(wasTrimmed);
  if (!cut.length) return [];
  const why = cut
    .slice(0, 5)
    .map((s) => `${s.id}: ${(s.data as { reason: string }).reason}`)
    .join("; ");
  return [{ stage: "match", verdict: "trimmed", why: `data replaced (${why}${cut.length > 5 ? `; and ${cut.length - 5} more` : ""})` }];
}

/** The slot a catch-up tick among the signals had missed (the goal says so), batched or not. */
function missedAtOf(signals: Signal[]): string | undefined {
  for (const s of signals) {
    const d = s.data as { reason?: unknown; missedAt?: unknown } | null;
    if (s.type === "time.tick" && d && d.reason === "catch-up" && typeof d.missedAt === "string") return d.missedAt;
  }
  return undefined;
}

export interface DeliverOptions {
  /** As the engine's fire: past the daily limit (a one-time reminder, the person's run from the UI). */
  force?: boolean;
  /** As the engine's fire: skipped while the previous task still runs (schedules). */
  skipIfBusy?: boolean;
  /** Now, whatever the batch: an open batch goes along (a run now, a one-time reminder). */
  immediate?: boolean;
  /** A watch's run now: its last known value, for the goal. */
  currentValue?: string;
  /** The caller holds the trigger's lock (the engine's timers, run now): the run is carried out right there. */
  locked?: boolean;
}

/** Signals taken in: those that go on, why they were held when they were, and the run once it is written. */
export interface Intake {
  signals: Signal[];
  held?: "filtered" | "duplicate" | "batch" | "flood" | "full";
  /** The run, once its outcome is written; undefined when nothing went on now, or the engine stopped first. */
  done: Promise<TriggerRun | undefined>;
}

/** A test run's path (trigger_test): what each stage did and what the outcome would be; nothing is carried out. */
export interface DryRun {
  stages: StageRecord[];
  outcome?: Outcome;
  summary?: string;
  context?: unknown;
  external: boolean;
  /**
   * Outside content came in during the test beyond the signals it was given: the script fetched, a source tool
   * answered, a state value or a note made from outside content was read (trigger_test marks its answer so).
   */
  read: boolean;
  /** The script failed: there is no outcome. */
  error?: string;
}

interface OpenBatch {
  /** Its journal line's id, given when it opens: a second flush (another replica, after a sleep) replaces that line. */
  runId?: string;
  /** ms */
  openedAt: number;
  windowSec: number;
  max: number;
  reason: RunReason;
  force?: boolean;
  skipIfBusy?: boolean;
  signals: Signal[];
}

/** A run waiting its turn in the trigger's queue; `runId` is its journal line's, kept across a stop. */
interface Work {
  runId: string;
  reason: RunReason;
  signals: Signal[];
  /** A batch's window (seconds), when the signals came as one. */
  window?: number;
  /** A batch that went on by itself (its window, or full), not because someone asked. */
  flush?: true;
  /** Taken now (a run now, a one-time reminder): carried out even when the trigger is off by then. */
  now?: true;
  force?: boolean;
  skipIfBusy?: boolean;
  currentValue?: string;
}

interface Pass {
  /** A test run: the script's state writes stay in it, nothing is carried out. */
  dry: boolean;
  force?: boolean;
  /** A test run's: set when the script or the quick check read outside content beyond the signals (DryRun.read). */
  read?: boolean;
  /** The script's state writes in this pass, committed with its outcome (none for a test run). */
  state: StateOverlay;
}

/** What the stages decided, before the outcome is carried out; `why` goes on the outcome's journal line. */
interface Judgement extends Omit<DryRun, "read"> {
  why?: string;
  /** The script could not run at all (the sandbox full or stopped): not the script's failure. */
  unavailable?: boolean;
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
    const size = sizeOf(s.data);
    if (size <= left) {
      left -= size;
      return s;
    }
    return { ...s, data: NOT_KEPT };
  });
}

/** A note's text when no summary was made: what came in, by type and subject. */
function describe(signals: Signal[], lead: string): string {
  const head = signals
    .slice(0, 5)
    .map((s) => (s.subject ? `${s.type}: ${s.subject}` : s.type))
    .join("; ");
  return `${lead}: ${head}${signals.length > 5 ? `; and ${signals.length - 5} more` : ""}`;
}

/** A run's script state, held until its outcome is written (stateOverlay). */
interface StateOverlay {
  /** The store as the run's script sees it. */
  store: TriggerStore;
  /** The run's state writes go to the store; a test run's never do. */
  commit(): void;
}

/**
 * The store as a run's script sees it: its state writes stay in the run, its reads see them, the rest is read as it is.
 * They reach the store only with the run's outcome (`commit`, in the same synchronous step as its journal line), so a
 * stop or a failure leaves the trigger's state as it was and a retry starts from it. Each write is held to the store's
 * cap as it would be once committed. `dry` (a test run): nothing is committed, and no note or journal line is made.
 */
function stateOverlay(store: TriggerStore, dry = false): StateOverlay {
  const local = new Map<string, Map<string, string | undefined>>();
  const mine = (id: string) => {
    let m = local.get(id);
    if (!m) local.set(id, (m = new Map()));
    return m;
  };
  const size = (k: string, v: string | undefined) => (v === undefined ? 0 : Buffer.byteLength(k) + Buffer.byteLength(v));
  /** The bytes a budget would take once committed, the keys in `except` left out. */
  const bytes = (id: string, budget: StateBudget, except: string[] = []): number => {
    const m = local.get(id) ?? new Map<string, string | undefined>();
    const held = [...m.keys()].filter((k) => stateBudget(k) === budget);
    let n = store.stateBytes(id, budget, [...except, ...held]);
    for (const k of held) if (!except.includes(k)) n += size(k, m.get(k));
    return n;
  };
  const view: TriggerStore = {
    ...store,
    ...(dry
      ? {
          addRun() {},
          dropRuns() {},
          dropState() {},
          addNote() {
            throw new Error("a test run keeps no notes");
          },
        }
      : {}),
    stateGet(id, k) {
      const m = local.get(id);
      if (!m?.has(k)) return store.stateGet(id, k);
      const v = m.get(k);
      return v === undefined ? undefined : JSON.parse(v);
    },
    stateSet(id, k, value) {
      mine(id).set(k, checkState(bytes(id, stateBudget(k), [k]), k, value));
    },
    stateDelete(id, k) {
      mine(id).set(k, undefined);
    },
    stateBytes: bytes,
  };
  return {
    store: view,
    commit() {
      if (dry) return;
      for (const [id, m] of local) {
        // Deletes first, then what shrinks, then what grows: no step passes the cap the end state is within.
        const writes = [...m].map(([k, v]) => {
          const now = store.stateGet(id, k);
          return { k, v, delta: size(k, v) - (now === undefined ? 0 : size(k, JSON.stringify(now))) };
        });
        for (const w of writes) if (w.v === undefined) store.stateDelete(id, w.k);
        for (const w of writes.filter((x) => x.v !== undefined).sort((a, z) => a.delta - z.delta)) store.stateSet(id, w.k, JSON.parse(w.v!));
      }
      local.clear();
    },
  };
}

export class TriggerPipeline {
  /** One question to the quick model, at most (ms); tests shorten it. */
  quickMs = QUICK_TIMEOUT_MS;
  private e: TriggerEngine;
  private s: PipelineServices;
  /** Open batches' timers, by trigger. */
  private timers = new Map<string, NodeJS.Timeout>();
  /** When signals came in the last minute, by trigger (at most FLOOD_DROP + 1 of them). */
  private arrivals = new Map<string, number[]>();
  /** When the last flood line went into the journal, by trigger. */
  private floodLine = new Map<string, number>();
  /** Who waits for a queued run's outcome, by its run id. */
  private waiters = new Map<string, { triggerId: string; resolve: (run: TriggerRun | undefined) => void }>();
  /** Steps and runs being carried out, for idle(). */
  private work = new Set<Promise<void>>();
  /** Triggers with a step waiting for (or holding) the lock. */
  private stepping = new Set<string>();
  /** Batches that came due while the hub slept or was down, waiting once for what another replica wrote: trigger → when the wait ends (ms). */
  private settling = new Map<string, { due: number; until: number }>();
  private stopped = false;

  constructor(e: TriggerEngine, s: PipelineServices) {
    this.e = e;
    this.s = s;
  }

  private get store(): TriggerStore {
    return this.e.ctx.store;
  }

  /** One or more signals for a trigger; resolves to the run written to the journal (undefined when match/dedup let nothing through, or a batch is still open). */
  deliver(t: Trigger, signals: Signal[], reason: RunReason, o: DeliverOptions = {}): Promise<TriggerRun | undefined> {
    return this.accept(t, signals, reason, o).done;
  }

  /**
   * Takes signals in, now and synchronously: trims their data, matches them to the subscription they came by, drops
   * repeats, counts them against floods, then adds them to the open batch or queues their run. The run itself (script,
   * quick check, outcome) follows under the trigger's lock: right here when the caller holds it, else in the background.
   */
  accept(t: Trigger, signals: Signal[], reason: RunReason, o: DeliverOptions = {}): Intake {
    const now = this.e.now();
    let held: Intake["held"];
    const passed: Signal[] = [];
    for (const sig of signals.map(trimmed)) {
      if (!this.passes(t, sig)) {
        this.countFiltered(t.id);
        held = "filtered";
      } else if (sig.key !== undefined && this.seen(t.id, sig.key, now, true)) held = "duplicate";
      else passed.push(sig);
    }
    const none: Promise<TriggerRun | undefined> = Promise.resolve(undefined);
    if (!passed.length) return { signals: [], held, done: none };
    // Refused (429): their keys go, so the sender's retry is taken in.
    const refused = (why: "full" | "flood", done = none): Intake => {
      this.unsee(t.id, passed);
      return { signals: passed, held: why, done };
    };
    const work = (signals: Signal[], extra: Partial<Work> = {}): Work => ({
      runId: newRunId(),
      reason,
      signals,
      ...(o.force ? { force: true } : {}),
      ...(o.skipIfBusy ? { skipIfBusy: true } : {}),
      ...(o.currentValue !== undefined ? { currentValue: o.currentValue } : {}),
      ...extra,
    });
    if (o.immediate) {
      // Now, with whatever the open batch gathered.
      const open = this.open(t.id);
      const w = work([...(open?.signals ?? []), ...passed], { now: true, ...(open ? { window: open.windowSec } : {}) });
      if (!this.enqueue(t.id, [w])) return refused("full");
      if (open) this.closeBatch(t.id);
      return { signals: passed, done: this.start(t.id, w.runId, !!o.locked) };
    }
    const rate = this.arrive(t.id, now, passed.length);
    if (rate > FLOOD_DROP) return refused("flood", Promise.resolve(this.flood(t, passed, reason, now)));
    const open = this.open(t.id);
    const cfg = open ? { windowSec: open.windowSec, max: open.max } : (t.batch ?? (rate > FLOOD_BATCH ? { windowSec: FLOOD_WINDOW_SEC } : undefined));
    if (!cfg) {
      const w = work(passed);
      if (!this.enqueue(t.id, [w])) return refused("full");
      return { signals: passed, done: this.start(t.id, w.runId, !!o.locked) };
    }
    // Into the batch: at most 500 signals, so adding one to it stays cheap.
    const b: OpenBatch = open
      ? { ...open, signals: [...open.signals, ...passed] }
      : {
          runId: newRunId(),
          openedAt: now,
          windowSec: cfg.windowSec,
          max: Math.min(cfg.max ?? MAX_BATCH_SIGNALS, MAX_BATCH_SIGNALS),
          reason,
          ...(o.force ? { force: true } : {}),
          ...(o.skipIfBusy ? { skipIfBusy: true } : {}),
          signals: passed,
        };
    if (b.signals.length >= b.max) {
      // Full: it goes on now.
      const w = this.workOf(b);
      if (!this.enqueue(t.id, [w])) return refused("full");
      this.closeBatch(t.id);
      return { signals: passed, done: this.start(t.id, w.runId, !!o.locked) };
    }
    try {
      this.store.stateSet(t.id, BATCH_KEY, b);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      // Too big to keep beside the trigger's state: what was gathered goes on now, and so do these.
      const ws = [...(open ? [this.workOf(open)] : []), work(passed, { window: cfg.windowSec })];
      if (!this.enqueue(t.id, ws)) return refused("full");
      this.closeBatch(t.id);
      return { signals: passed, done: this.start(t.id, ws[ws.length - 1].runId, !!o.locked) };
    }
    this.arm(t.id, b);
    return { signals: passed, held: "batch", done: none };
  }

  /**
   * The same path with no outcome: what each stage did (trigger_test). The script runs for real; its state writes stay
   * in the test. `replay`: the signals are the trigger's own from its journal, so their keys were seen: not dropped.
   */
  async dryRun(t: Trigger, signals: Signal[], o: { replay?: boolean } = {}): Promise<DryRun> {
    const now = this.e.now();
    const stages: StageRecord[] = [];
    const kept: Signal[] = [];
    for (const s of signals.map(trimmed)) {
      if (!this.passes(t, s)) stages.push({ stage: "match", verdict: "drop", why: `${s.id}: the filter (where) leaves it out` });
      else if (!o.replay && s.key !== undefined && this.seen(t.id, s.key, now, false)) stages.push({ stage: "dedup", verdict: "drop", why: `${s.id}: its key was seen in the last 24 h` });
      else kept.push(s);
    }
    if (!kept.length) return { stages, outcome: "drop", external: signals.some((s) => s.external), read: false };
    const asked = t.state.triageToday;
    const pass: Pass = { dry: true, state: stateOverlay(this.store, true) };
    const { why: _why, unavailable: _u, ...j } = await this.judge(t, kept, pass);
    // Its quick-model questions count against the day's, as a real run's do.
    if (t.state.triageToday !== asked) await this.e.save(t);
    return { ...j, read: !!pass.read, stages: [...stages, ...trimLine(kept), ...j.stages] };
  }

  /** At start: queued runs are carried out (again: one cut short by a stop is retried), open batches get their timers back. */
  async resume(): Promise<void> {
    for (const t of this.e.list()) {
      if (this.stopped) return;
      this.kick(t.id);
      const b = this.open(t.id);
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

  /** Until everything queued so far is carried out (tests, and a caller that wants the journal settled). */
  async idle(): Promise<void> {
    while (this.work.size) await Promise.allSettled([...this.work]);
  }

  /** What is in flight stops writing; queued runs stay queued for the next start. */
  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const w of this.waiters.values()) w.resolve(undefined);
    this.waiters.clear();
  }

  /** The trigger was deleted: its timer and counters go (its batch and queue went with its state). */
  forget(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.settling.delete(id);
    this.arrivals.delete(id);
    this.floodLine.delete(id);
    for (const [runId, w] of this.waiters) {
      if (w.triggerId !== id) continue;
      w.resolve(undefined);
      this.waiters.delete(runId);
    }
  }

  // ---------- match, dedup, flood ----------

  /** A signal passes when it came by no subscription (core's own sources) or one of its type whose filter it meets. */
  private passes(t: Trigger, s: Signal): boolean {
    const subs = (t.on ?? []).filter((x) => x.type === s.type);
    return !subs.length || subs.some((x) => matches(x.where, s));
  }

  private countFiltered(id: string): void {
    const n = this.store.stateGet(id, FILTERED_KEY);
    this.keep(id, FILTERED_KEY, (typeof n === "number" ? n : 0) + 1);
  }

  /** A bookkeeping key (seen keys, the filter's count): when the engine's state is full it is not kept, and that is all. */
  private keep(id: string, key: string, value: unknown): void {
    try {
      this.store.stateSet(id, key, value);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      this.e.ctx.log.warn(`trigger ${id}: ${key} not kept: ${e.message}`);
    }
  }

  /** The delivery keys seen in the last 24 h, oldest first; through a Map, so "__proto__" is a key like any other. */
  private seenKeys(id: string, now: number): Map<string, number> {
    const stored = this.store.stateGet(id, SEEN_KEY);
    const entries = stored && typeof stored === "object" && !Array.isArray(stored) ? Object.entries(stored as Record<string, unknown>) : [];
    return new Map(entries.filter((x): x is [string, number] => typeof x[1] === "number" && now - x[1] < DEDUP_MS));
  }

  /** The key came in the last 24 h; `record` keeps it when it did not (at most 1000 keys, the oldest go). */
  private seen(id: string, key: string, now: number, record: boolean): boolean {
    const k = key.slice(0, KEY_MAX);
    const keys = this.seenKeys(id, now);
    if (keys.has(k) || !record) return keys.has(k);
    keys.set(k, now);
    this.keep(id, SEEN_KEY, Object.fromEntries([...keys].sort((a, z) => a[1] - z[1]).slice(-DEDUP_KEYS)));
    return false;
  }

  /** A run that failed or was skipped lets its signals' keys go: the sender's retry is carried out. */
  private unsee(id: string, signals: Signal[]): void {
    const gone = signals.flatMap((s) => (s.key !== undefined ? [s.key.slice(0, KEY_MAX)] : []));
    if (!gone.length) return;
    const keys = this.seenKeys(id, this.e.now());
    for (const k of gone) keys.delete(k);
    this.keep(id, SEEN_KEY, Object.fromEntries(keys));
  }

  /** How many signals came in the last minute, these included (counted as they arrive). */
  private arrive(id: string, now: number, n: number): number {
    const list = (this.arrivals.get(id) ?? []).filter((at) => now - at < FLOOD_MS);
    for (let i = 0; i < n; i++) list.push(now);
    if (list.length > FLOOD_DROP + 1) list.splice(0, list.length - (FLOOD_DROP + 1));
    this.arrivals.set(id, list);
    return list.length;
  }

  /** Over 1000 a minute: dropped, with one journal line a minute. */
  private flood(t: Trigger, signals: Signal[], reason: RunReason, now: number): TriggerRun | undefined {
    if (now - (this.floodLine.get(t.id) ?? -Infinity) < FLOOD_MS) return undefined;
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
    this.journal(t.id, run, []);
    this.e.emit(t.id);
    this.e.ctx.log.warn(`trigger ${t.id}: over ${FLOOD_DROP} signals a minute, dropping them`);
    return run;
  }

  // ---------- the open batch ----------

  private open(id: string): OpenBatch | undefined {
    const b = this.store.stateGet(id, BATCH_KEY) as OpenBatch | undefined;
    if (!b || typeof b !== "object" || !Array.isArray(b.signals) || !Number.isFinite(b.openedAt) || !Number.isFinite(b.windowSec)) return undefined;
    return { ...b, max: Math.min(Number.isFinite(b.max) ? b.max : MAX_BATCH_SIGNALS, MAX_BATCH_SIGNALS) };
  }

  private closeBatch(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.store.stateDelete(id, BATCH_KEY);
  }

  private workOf(b: OpenBatch): Work {
    return {
      runId: b.runId ?? newRunId(),
      reason: b.reason,
      signals: b.signals,
      window: b.windowSec,
      flush: true,
      ...(b.force ? { force: true } : {}),
      ...(b.skipIfBusy ? { skipIfBusy: true } : {}),
    };
  }

  private arm(id: string, b: OpenBatch): void {
    this.armAt(id, this.settling.get(id)?.until ?? b.openedAt + b.windowSec * 1000);
  }

  /** The batch's timer, for `at` (ms). */
  private armAt(id: string, at: number): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    if (this.stopped) return;
    const delay = Math.max(0, at - this.e.now());
    const timer: NodeJS.Timeout = setTimeout(() => {
      if (this.timers.get(id) === timer) this.timers.delete(id);
      void this.e.withLock(id, () => this.flushIfDue(id, true)).catch((err) => this.e.ctx.log.error(`trigger ${id}: its batch failed: ${message(err)}`));
    }, delay);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  /** Under the trigger's lock: a batch whose window closed moves to the queue (it is never anywhere but stored) and is carried out. */
  /** `timer`: its timer just fired (the engine looks for a wake now). */
  private async flushIfDue(id: string, timer = false): Promise<TriggerRun | undefined> {
    if (this.stopped) return undefined;
    const b = this.open(id);
    if (!b) return undefined;
    if (!this.e.get(id)) {
      this.closeBatch(id);
      return undefined;
    }
    const now = this.e.now();
    const due = b.openedAt + b.windowSec * 1000;
    if (now < due) {
      this.arm(id, b);
      return undefined;
    }
    // Due while the hub was away (it slept, was down, or another replica led: the engine's wake detection, not how
    // late this is, since a busy lock is late too): another replica may have flushed it, so it waits once for what that
    // replica wrote to arrive, as a schedule's slot does (engine.settle). Its stable run id covers a flush that still
    // happens twice: the journal line is replaced, not added.
    const waiting = this.settling.get(id);
    if (waiting?.due !== due && this.e.wasAway(due, timer)) {
      this.settling.set(id, { due, until: now + SETTLE_MS });
      this.armAt(id, now + SETTLE_MS);
      return undefined;
    }
    if (waiting?.due === due && now < waiting.until) {
      this.armAt(id, waiting.until);
      return undefined;
    }
    this.settling.delete(id);
    const w = this.workOf(b);
    if (!this.enqueue(id, [w])) {
      // The queue is full: the batch waits for the next turn.
      this.arm(id, { ...b, openedAt: this.e.now() });
      return undefined;
    }
    this.closeBatch(id);
    return this.start(id, w.runId, true);
  }

  // ---------- the queue ----------

  private queue(id: string): Work[] {
    const q = this.store.stateGet(id, QUEUE_KEY);
    return Array.isArray(q) ? (q as Work[]).filter((w) => w && typeof w.runId === "string" && Array.isArray(w.signals)) : [];
  }

  /** Adds runs to the trigger's queue; false when they do not fit beside its state (then nothing was added). */
  private enqueue(id: string, ws: Work[]): boolean {
    try {
      this.store.stateSet(id, QUEUE_KEY, [...this.queue(id), ...ws]);
      return true;
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      this.e.ctx.log.warn(`trigger ${id}: too many runs waiting, a signal was refused`);
      return false;
    }
  }

  private unqueue(id: string, runId: string): void {
    const q = this.queue(id).filter((w) => w.runId !== runId);
    if (q.length) this.store.stateSet(id, QUEUE_KEY, q);
    else this.store.stateDelete(id, QUEUE_KEY);
  }

  /**
   * Run `runId` is carried out. A caller that holds the trigger's lock carries out its own run right there and resolves
   * after it; the rest of the queue goes on by steps. Otherwise the run waits its turn in the steps. Resolves to the run.
   */
  private start(id: string, runId: string | undefined, locked: boolean): Promise<TriggerRun | undefined> {
    // Stopped: what was queued stays queued for the next start.
    if (this.stopped) return Promise.resolve(undefined);
    if (!locked || runId === undefined) {
      const done = runId === undefined ? Promise.resolve(undefined) : new Promise<TriggerRun | undefined>((resolve) => this.waiters.set(runId, { triggerId: id, resolve }));
      this.kick(id);
      return done;
    }
    const w = this.queue(id).find((x) => x.runId === runId);
    const own = (w ? this.carryQueued(id, w) : Promise.resolve(undefined))
      .catch((err) => {
        if (!this.stopped) this.e.ctx.log.error(`trigger ${id}: a run failed: ${message(err)}`);
        return undefined;
      })
      .finally(() => this.kick(id));
    this.track(own);
    return own;
  }

  private track(p: Promise<unknown>): void {
    const q = p.then(
      () => {},
      () => {},
    );
    this.work.add(q);
    void q.finally(() => this.work.delete(q));
  }

  private settle(runId: string, run: TriggerRun | undefined): void {
    this.waiters.get(runId)?.resolve(run);
    this.waiters.delete(runId);
  }

  /**
   * The queue goes on by steps: one queued run per turn of the trigger's lock, the next step taking its place at the
   * end of the line. So an update, a delete, feedback "off" or a run now waits for one run at most, never for the whole
   * queue, however much keeps coming in. At most one step per trigger waits for the lock at a time.
   */
  private kick(id: string): void {
    if (this.stopped || this.stepping.has(id)) return;
    let left = false;
    try {
      left = this.queue(id).length > 0;
    } catch {
      // The store is closed (the engine stopped): nothing goes on.
    }
    if (!left) return;
    this.stepping.add(id);
    let failed = false;
    const p: Promise<void> = new Promise<void>((r) => setImmediate(r))
      .then(() => this.e.withLock(id, () => this.step(id)))
      .catch((err) => {
        failed = true;
        if (!this.stopped) this.e.ctx.log.error(`trigger ${id}: its queue failed: ${message(err)}`);
      })
      .finally(() => {
        this.stepping.delete(id);
        this.work.delete(p);
        // A step that failed outside its run (the store, say) is tried again a little later, not in a tight loop.
        if (failed) setTimeout(() => this.kick(id), STEP_RETRY_MS).unref?.();
        else this.kick(id);
      });
    this.work.add(p);
  }

  /** Under the trigger's lock: the first queued run. */
  private async step(id: string): Promise<void> {
    if (this.stopped) return;
    const w = this.queue(id)[0];
    if (w) await this.carryQueued(id, w);
  }

  /**
   * Under the trigger's lock: one queued run. It leaves the queue only once its outcome is written; one the journal
   * already has (written just before a stop) is not carried out again. A stop leaves it queued.
   */
  private async carryQueued(id: string, w: Work): Promise<TriggerRun | undefined> {
    const t = this.e.get(id);
    if (!t) {
      this.store.stateDelete(id, QUEUE_KEY);
      this.forget(id);
      return undefined;
    }
    let run = this.store.run(id, w.runId);
    // Turned off while it waited (its batch open, or behind other runs): nothing more runs for it. A run taken now
    // (a run now, a one-time reminder) goes all the same.
    if (!run && !t.enabled && !w.now) return this.switchedOff(t);
    if (!run) {
      try {
        run = await this.run(t, w);
      } catch (e) {
        if (this.stopped) return undefined;
        run = await this.broken(t, w, message(e));
      }
    }
    if (this.stopped) return undefined;
    this.unqueue(id, w.runId);
    this.settle(w.runId, run);
    return run;
  }

  /**
   * Under the lock, the trigger turned off: everything still queued for it (but runs taken now) becomes one note, with
   * how many signals came and their first subjects, on one journal line, and leaves the queue in the same step.
   */
  private switchedOff(t: Trigger): TriggerRun {
    const all = this.queue(t.id);
    const off = all.filter((w) => !w.now);
    const signals = off.flatMap((w) => w.signals);
    const external = signals.some((s) => s.external);
    const why = `the trigger was turned off: the ${signals.length} signal(s) that waited were kept as one note`;
    const run: TriggerRun = {
      id: off[0].runId,
      at: new Date(this.e.now()).toISOString(),
      reason: off[0].reason,
      status: "skipped",
      detail: why,
      signals: signals.map(briefOf),
      stages: [...trimLine(signals), { stage: "outcome", verdict: "note", why }],
      outcome: "note",
      external,
      noteId: this.addNote(t, describe(signals, `${signals.length} signal(s) came in before the trigger was turned off`), signals, external),
    };
    this.journal(t.id, run, keptData(signals));
    const left = all.filter((w) => w.now);
    if (left.length) this.store.stateSet(t.id, QUEUE_KEY, left);
    else this.store.stateDelete(t.id, QUEUE_KEY);
    for (const w of off) this.settle(w.runId, run);
    this.e.emit(t.id);
    return run;
  }

  // ---------- a run ----------

  /**
   * One queued run: the stages, then its outcome. The script's state writes are kept only with an outcome carried out
   * (a note, a drop, a wake that started or became a note), in the same step as its journal line: a stop before that
   * keeps nothing, and a run that failed (the script's error, the sandbox unavailable, a wake that could not start)
   * keeps none of them either, so the next run, or a retry, starts from the state as it was.
   */
  private async run(t: Trigger, w: Work): Promise<TriggerRun> {
    const at = new Date(this.e.now()).toISOString();
    const signals = w.signals;
    const pass: Pass = { dry: false, force: w.force, state: stateOverlay(this.store) };
    const j = await this.judge(t, signals, pass);
    // Stopped meanwhile: nothing is written, the run stays queued for the next start.
    if (this.stopped) throw new Error(STOPPED);
    // A trigger that does not batch, given several (a flood batched them): its script's first argument was one signal.
    const firstOnly = !!t.script && !t.batch && signals.length > 1;
    const stages: StageRecord[] = [
      ...trimLine(signals),
      ...(w.window !== undefined ? [{ stage: "batch" as const, verdict: "flush", why: `${signals.length} signal(s) gathered over ${w.window} s` }] : []),
      ...(firstOnly ? [{ stage: "batch" as const, verdict: "first", why: `the script saw the first of ${signals.length} signals (flood batch); all ${signals.length} had its verdict` }] : []),
      ...j.stages,
    ];
    const journal = { signals: signals.map(briefOf), stages, external: j.external };
    const signalData = keptData(signals);
    if (j.error !== undefined) return j.unavailable ? this.skipped(t, w, at, journal, signalData, j.error) : this.failed(t, w, at, journal, signalData, j.error);
    t.state.errorsInRow = 0;
    const outcome: Outcome = j.outcome ?? "wake";
    stages.push({ stage: "outcome", verdict: outcome, ...(j.why ? { why: j.why } : {}) });
    if (outcome === "wake") {
      // Left as it is: a stop between tasks.create and fire's journal line wakes the agent again on the retry (the
      // queue cannot tell the task was started). Rare, and one wake too many is better than one too few.
      const missedAt = missedAtOf(signals);
      const pipeline = { summary: j.summary ?? "", ...(j.context !== undefined ? { context: j.context } : {}), signals: journal.signals, external: j.external };
      const run = await this.e.fire(
        t,
        w.reason,
        { pipeline, ...(missedAt ? { missedAt } : {}), ...(w.currentValue !== undefined ? { currentValue: w.currentValue } : {}) },
        { runId: w.runId, force: w.force, skipIfBusy: w.skipIfBusy, tainted: j.external, journal: { ...journal, outcome }, signalData, commit: () => this.commitState(t, pass) },
      );
      // The day's wakes are used up, or the last one still runs: what came in is kept as a note, not lost.
      if (run.status === "skipped" && run.code && SKIPPED_WAKES.has(run.code)) return this.wakeAsNote(t, run, j, signals, signalData);
      return run;
    }
    const run: TriggerRun = { id: w.runId, at, reason: w.reason, status: "started", ...journal, outcome };
    // The script's state, the note and its journal line together, before anything is awaited: a stop cannot leave one
    // without the others.
    this.commitState(t, pass);
    if (outcome === "note") run.noteId = this.addNote(t, j.summary?.trim() || describe(signals, "Signals"), signals, j.external);
    this.journal(t.id, run, signalData);
    t.state.lastRunAt = at;
    t.state.lastStatus = "ok";
    t.state.lastError = t.state.lastErrorCode = t.state.lastErrorParams = undefined;
    delete t.state.lastErrorExternal;
    await this.e.save(t);
    this.e.emit(t.id);
    return run;
  }

  /** The run's script state into the store; one that does not fit any more (state kept before its cap) is logged, the outcome stands. */
  private commitState(t: Trigger, pass: Pass): void {
    try {
      pass.state.commit();
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      this.e.ctx.log.warn(`trigger ${t.id}: its script's state was not kept in full: ${e.message}`);
    }
  }

  private addNote(t: Trigger, text: string, signals: Signal[], external: boolean): string {
    return this.store.addNote({
      agentId: t.agentId,
      triggerId: t.id,
      triggerName: t.name,
      text: truncateBytes(text, NOTE_MAX).text,
      signalIds: signals.map((s) => s.id),
      external,
    }).id;
  }

  /** The journal line, written now (the store is synchronous); none for a trigger deleted meanwhile. */
  private journal(id: string, run: TriggerRun, signalData: Signal[]): void {
    if (!this.e.get(id)) return;
    this.store.addRun(id, signalData.length ? { ...run, signalData } : run);
  }

  /** A wake that did not start (the day's wakes, the last task still running) becomes a note on the same journal line. */
  private async wakeAsNote(t: Trigger, run: TriggerRun, j: Judgement, signals: Signal[], signalData: Signal[]): Promise<TriggerRun> {
    const why = `the agent was not woken (${run.detail ?? run.code}): kept as a note`;
    const noted: TriggerRun = {
      ...run,
      outcome: "note",
      noteId: this.addNote(t, j.summary?.trim() || describe(signals, "Not woken for"), signals, j.external),
      stages: [...(run.stages ?? []).filter((s) => s.stage !== "outcome"), { stage: "outcome", verdict: "note", why }],
    };
    this.journal(t.id, noted, signalData);
    this.e.emit(t.id);
    return noted;
  }

  /** The script could not run at all (the sandbox full or stopped): a skipped run, no failure counted, the keys let go. */
  private async skipped(t: Trigger, w: Work, at: string, journal: Pick<TriggerRun, "signals" | "stages" | "external">, signalData: Signal[], why: string): Promise<TriggerRun> {
    const run: TriggerRun = { id: w.runId, at, reason: w.reason, status: "skipped", detail: why, ...journal };
    this.unsee(t.id, w.signals);
    this.journal(t.id, run, signalData);
    t.state.lastStatus = "skipped";
    t.state.lastError = why;
    t.state.lastErrorCode = t.state.lastErrorParams = undefined;
    // The sandbox's own words.
    delete t.state.lastErrorExternal;
    await this.e.save(t);
    this.e.emit(t.id);
    return run;
  }

  /** The script failed: an error run, the keys let go (a retry is carried out); after the fifth in a row the person hears of it, once. */
  private async failed(t: Trigger, w: Work, at: string, journal: Pick<TriggerRun, "signals" | "stages" | "external">, signalData: Signal[], error: string): Promise<TriggerRun> {
    // The same error as the trigger's last run is the same line, counted, at the newest run's time (pruning and order
    // follow the end of the streak), with the newest run's signals and stages.
    const last = this.store.runs(t.id, 1)[0];
    const again = last && last.id !== w.runId && last.status === "error" && last.detail === error ? last : undefined;
    const run: TriggerRun = again
      ? { ...again, ...journal, at, count: (again.count ?? 1) + 1, lastAt: at }
      : { id: w.runId, at, reason: w.reason, status: "error", detail: error, ...journal };
    this.unsee(t.id, w.signals);
    this.journal(t.id, run, signalData);
    t.state.errorsInRow = (t.state.errorsInRow ?? 0) + 1;
    t.state.lastStatus = "error";
    t.state.lastError = error;
    t.state.lastErrorCode = t.state.lastErrorParams = undefined;
    // A run that read outside content may have put it in its error: the tools and the notification show a fixed line.
    if (journal.external) t.state.lastErrorExternal = true;
    else delete t.state.lastErrorExternal;
    await this.e.save(t);
    this.e.emit(t.id);
    this.e.ctx.log.info(`trigger ${t.id} error: ${error}`);
    if (t.state.errorsInRow === FAILING_AFTER) await this.tellFailing(t, error, !!journal.external);
    return run;
  }

  /** Something other than the script failed while a queued run was carried out: journaled, and the queue goes on. */
  private async broken(t: Trigger, w: Work, error: string): Promise<TriggerRun> {
    const run: TriggerRun = {
      id: w.runId,
      at: new Date(this.e.now()).toISOString(),
      reason: w.reason,
      status: "error",
      detail: `the run failed: ${clip(error, ERROR_MAX)}`,
      signals: w.signals.map(briefOf),
      stages: [],
      external: w.signals.some((s) => s.external),
    };
    try {
      this.unsee(t.id, w.signals);
      this.journal(t.id, run, keptData(w.signals));
      this.e.emit(t.id);
    } catch (e) {
      this.e.ctx.log.error(`trigger ${t.id}: a run failed (${error}) and could not be journaled: ${message(e)}`);
    }
    return run;
  }

  /** `external`: the run had read outside content, which its error may carry: the Inbox and the digest's agent read the notification, so it says where to look instead. */
  private async tellFailing(t: Trigger, error: string, external: boolean): Promise<void> {
    const i18n = this.e.ctx.i18n;
    try {
      // In the person's language; the script's error itself (English, no code) as it is.
      await this.e.ctx.core.call("notify", {
        level: "notify",
        title: i18n.t("notify.failing", { name: t.name }),
        body: external ? i18n.t("notify.failingBodyOutside") : i18n.t("notify.failingBody", { error }),
        triggerId: t.id,
        agentId: t.agentId,
      });
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
      if (p.dry && r.external) p.read = true;
      // pio calls the script left running when its wall time ran out (the sandbox counts them).
      const logs = r.droppedCalls ? [...r.logs, `[piomio] ${r.droppedCalls} pio call(s) the script did not wait for were dropped at the wall time`] : r.logs;
      const rec: StageRecord = { stage: "script", ms: r.ms, ...(logs.length ? { logs } : {}), ...(r.tokens ? { tokens: r.tokens } : {}) };
      if (r.error !== undefined) {
        const error = clip(r.error, ERROR_MAX);
        stages.push({ ...rec, error });
        return { stages, external, error, ...(r.unavailable ? { unavailable: true } : {}) };
      }
      const v = r.verdict;
      if (v && "drop" in v) return { stages: [{ ...rec, verdict: "drop", why: clip(v.drop, WHY_MAX) }], external, outcome: "drop", why: "the script dropped it" };
      if (v && "note" in v) return { stages: [{ ...rec, verdict: "note", why: clip(v.note, WHY_MAX) }], external, outcome: "note", summary: v.note, why: "the script kept a note" };
      if (v && "wake" in v) {
        return {
          stages: [{ ...rec, verdict: "wake", why: clip(v.wake, WHY_MAX) }],
          external,
          outcome: "wake",
          summary: v.wake,
          ...(v.context !== undefined ? { context: v.context } : {}),
          why: "the script woke the agent",
        };
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
    if (p.dry && q.external) p.read = true;
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
      // A test run's pio starts clean, so what it reports is what the script itself read from outside (DryRun.read);
      // the run is external all the same when its signals are (judge). Its state writes are the test's alone.
      external: p.dry ? false : signals.some((s) => s.external),
      // Each question bounded: a hung CLI cannot hold the script's sandbox slot past it. One that brought no answer
      // gives back the quick check it took (pio takes one before each question).
      quick: this.refunding(t, this.bounded()),
      triageBudget: () => this.takeTriage(t),
      // Its state writes stay in the pass until the run's outcome is written (stateOverlay); a test run's never leave it.
      store: p.state.store,
    });
    let r: ScriptResult;
    try {
      // The trigger's own shape (a batch's list, else the one signal) and, always, all of them (sandbox-worker.ts).
      const input = { signal: signals[0], signals, batch: !!t.batch, now: pio.now() };
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

  /**
   * The quick model with each question bounded (at `deadline`, ms of performance.now(), when given): past it, it is
   * unavailable, and the question is aborted, which closes its CLI session (bare-ask.ts) instead of leaving it to run.
   */
  private bounded(deadline?: number): QuickModel {
    const limit = this.quickMs;
    return {
      ask: (prompt, o = {}) =>
        new Promise((resolve, reject) => {
          const ms = deadline === undefined ? limit : Math.max(0, deadline - performance.now());
          const bound = new AbortController();
          const late = new Error(`the quick model did not answer within ${limit >= 1000 ? `${Math.round(limit / 1000)} s` : `${limit} ms`}`);
          const timer = setTimeout(() => {
            bound.abort(late);
            reject(late);
          }, ms);
          timer.unref?.();
          const signal = o.signal ? AbortSignal.any([o.signal, bound.signal]) : bound.signal;
          this.s.quick.ask(prompt, { ...o, signal }).then(
            (r) => {
              clearTimeout(timer);
              resolve(r);
            },
            (e) => {
              clearTimeout(timer);
              reject(e);
            },
          );
        }),
    };
  }

  private async quickCheck(
    t: Trigger,
    signals: Signal[],
    context: unknown,
    p: Pass,
  ): Promise<{ stage: StageRecord; outcome: Outcome; summary?: string; why: string; external: boolean }> {
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    if (!this.takeTriage(t)) {
      const why = "this trigger's quick checks for today are used up (triagePerDay)";
      return { stage: { stage: "triage", verdict: "unavailable", why }, ...this.fallback(t, signals, why, p), external: false };
    }
    let chars = 0;
    // Both of triage's tries share one bound.
    const quick = this.bounded(t0 + this.quickMs);
    const counted: QuickModel = {
      ask: async (prompt, o) => {
        const r = await quick.ask(prompt, o);
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
        stage: { stage: "triage", verdict: a.decision, why: clip(a.why, WHY_MAX), ms: ms(), tokens: Math.ceil(chars / 4) },
        outcome: a.decision,
        summary: a.summary || a.why,
        why: "the quick check decided",
        external,
      };
    } catch (e) {
      // No answer came (unavailable, its bound ran out waiting or asking, unparseable): the check is given back.
      this.refundTriage(t);
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
    return { outcome: "note", summary: describe(signals, "Not looked at by the quick model"), why: `${why}, and the day's wakes are used up: kept as a note` };
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

  /** Gives back one of the day's quick checks, taken for a question that brought no answer. */
  private refundTriage(t: Trigger): void {
    const used = this.triageUsed(t);
    if (used > 0) t.state.triageToday = { date: this.today(), count: used - 1 };
  }

  /** `quick`, giving back a quick check for each question that brought no answer. */
  private refunding(t: Trigger, quick: QuickModel): QuickModel {
    return {
      ask: (prompt, o) =>
        quick.ask(prompt, o).catch((e: unknown) => {
          this.refundTriage(t);
          throw e;
        }),
    };
  }

  /** Takes one of the day's quick checks (triage, pio.llm.ask, test runs too); false when none is left. */
  private takeTriage(t: Trigger): boolean {
    if ((t.triagePerDay ?? DEFAULT_TRIAGE_PER_DAY) - this.triageUsed(t) <= 0) return false;
    t.state.triageToday = { date: this.today(), count: this.triageUsed(t) + 1 };
    return true;
  }
}
