// A test run of a trigger (trigger_test, POST /triggers/:id/test): its pipeline on some signals with no outcome
// (pipeline.ts dryRun). The script runs for real with the real pio, but its state writes stay in the test, and no
// note, task or journal line is made. Its quick-model checks count against the trigger's day, as a real run's do.
// What is tested: a trigger as it is (by id), a draft before it exists (the fields trigger_create takes), or a change
// before it is made (both). On what: the trigger's last signals from its journal, its sources' samples, or signals
// the agent gives.

import type { TriggerEngine } from "./engine.ts";
import { triggerSamples } from "./builtin-sources.ts";
import type { DryRun } from "./pipeline.ts";
import { localDate } from "./schedule.ts";
import type { Signal, Trigger, TriggerInput } from "./types.ts";
import { applyUpdate, buildTrigger, DEFAULT_TRIAGE_PER_DAY, normalizeOn, ValidationError } from "./validate.ts";

/** Signals one test takes at most. */
export const TEST_MAX_SIGNALS = 20;
const RECENT_DEFAULT = 5;
/** Test runs at once: as many as the sandbox runs scripts (sandbox.ts MAX_RUNNING) and the quick model takes questions. */
const RUNS_AT_ONCE = 2;
const SIGNAL_TYPE = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/i;

export interface TestInput {
  id?: unknown;
  trigger?: unknown;
  signals?: unknown;
  n?: unknown;
}

export interface TestRun extends DryRun {
  signals: Array<{ id: string; type: string; subject?: string }>;
}

export interface TestReport {
  trigger: { id: string; name: string; draft: boolean };
  using: "recent" | "sample" | "given";
  /** One per signal, or one for them all when the trigger batches. */
  runs: TestRun[];
  /** Subscribed types that have no sample to test on. */
  missing: string[];
  /** Outside content came back: the trigger's own signals were outside content, or the test read some (DryRun.read). */
  outside: boolean;
  /** The trigger's quick-model checks used today and its daily limit, when it has a script or a quick check. */
  quick?: { used: number; perDay: number };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const fail = (code: string, message: string, params?: Record<string, string | number>): never => {
  throw new ValidationError(code, message, params);
};

const SIGNALS_HELP = `signals is "recent", "sample" or a list of 1 to ${TEST_MAX_SIGNALS} signals, each { type, data, subject?, key?, external? }`;

/** A signal the agent gave, in the pipeline's shape; outside content by default unless its type is the hub's own. */
function givenSignal(v: unknown, i: number, now: Date): Signal {
  if (!isObject(v) || typeof v.type !== "string" || v.type.length > 100 || !SIGNAL_TYPE.test(v.type)) return fail("testSignals", SIGNALS_HELP, { max: TEST_MAX_SIGNALS });
  const type = v.type;
  const text = (x: unknown, max: number) => (typeof x === "string" && x.trim() ? x.trim().slice(0, max) : undefined);
  const at = typeof v.at === "string" && Number.isFinite(Date.parse(v.at)) ? new Date(v.at).toISOString() : now.toISOString();
  const subject = text(v.subject, 300);
  const key = text(v.key, 200);
  return {
    id: text(v.id, 100) ?? `sig_test_${i + 1}`,
    type,
    source: text(v.source, 100) ?? "test",
    at,
    data: v.data ?? null,
    ...(subject ? { subject } : {}),
    ...(key ? { key } : {}),
    external: typeof v.external === "boolean" ? v.external : !(type === "manual" || type === "time.tick" || type.startsWith("hub.")),
  };
}

function count(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > TEST_MAX_SIGNALS) fail("testN", `n must be an integer from 1 to ${TEST_MAX_SIGNALS}`, { max: TEST_MAX_SIGNALS });
  return n;
}

const usedOn = (t: Trigger, today: string) => (t.state.triageToday?.date === today ? t.state.triageToday.count : 0);

export async function testTrigger(e: TriggerEngine, input: TestInput, o: { defaultAgent?: string } = {}): Promise<TestReport> {
  const now = new Date(e.now());
  const stored = input.id === undefined || input.id === null || input.id === "" ? undefined : e.require(input.id);
  if (input.trigger !== undefined && !isObject(input.trigger)) fail("testWhat", "trigger is a draft: an object with the fields trigger_create (or, with id, trigger_update) takes");
  if (!stored && input.trigger === undefined)
    fail("testWhat", "Give the id of a trigger to test, a draft as trigger (the fields trigger_create takes), or both to test a change before making it");
  const draft = input.trigger === undefined ? undefined : normalizeOn(input.trigger as TriggerInput, { create: !stored });
  const t: Trigger = !draft
    ? stored!
    : stored
      ? applyUpdate(stored, draft, { now, tz: e.tz })
      : buildTrigger(draft, { now, tz: e.tz, defaultAgent: o.defaultAgent ?? e.defaultAgent, createdBy: "test" });

  let using: TestReport["using"];
  let signals: Signal[];
  let missing: string[] = [];
  const mode = input.signals ?? (stored && e.ctx.store.recentSignals(stored.id, 1).length ? "recent" : "sample");
  if (mode === "recent") {
    if (!stored) fail("testRecentNeedsId", '"recent" tests a trigger on its own last signals: give its id, or test a draft on "sample" or on signals you give');
    using = "recent";
    signals = e.ctx.store.recentSignals(stored!.id, count(input.n, RECENT_DEFAULT));
    if (!signals.length) fail("testNoRecent", `Trigger ${stored!.id} has no signals in its journal yet: test it on "sample" or on signals you give`, { id: stored!.id });
  } else if (mode === "sample") {
    using = "sample";
    const s = triggerSamples(t, e.ctx.sources?.list() ?? [], now);
    missing = s.missing;
    signals = s.signals.slice(0, count(input.n, TEST_MAX_SIGNALS));
    if (!signals.length) fail("testNoSample", `There is no sample signal for ${missing.join(", ") || t.kind}: give the signals to test on`, { types: missing.join(", ") || t.kind });
  } else if (Array.isArray(mode)) {
    using = "given";
    if (!mode.length || mode.length > TEST_MAX_SIGNALS) fail("testSignals", SIGNALS_HELP, { max: TEST_MAX_SIGNALS });
    signals = mode.map((v, i) => givenSignal(v, i, now)).slice(0, count(input.n, TEST_MAX_SIGNALS));
  } else return fail("testSignals", SIGNALS_HELP, { max: TEST_MAX_SIGNALS });

  // As a real run would take them: one batch for a trigger that batches, else one run each.
  const groups = t.batch ? [signals] : signals.map((s) => [s]);
  const today = localDate(now, e.tz);
  const usedBefore = usedOn(t, today);
  const runs: TestRun[] = new Array(groups.length);
  let next = 0;
  const work = async () => {
    for (let i = next++; i < groups.length; i = next++) {
      const r = await e.pipeline.dryRun(t, groups[i], { replay: using === "recent" });
      runs[i] = { signals: groups[i].map((s) => ({ id: s.id, type: s.type, ...(s.subject ? { subject: s.subject } : {}) })), ...r };
    }
  };
  await Promise.all(Array.from({ length: Math.min(RUNS_AT_ONCE, groups.length) }, work));

  // A change tested before it is made ran on a copy: the quick checks it used count on the trigger itself.
  const live = stored ? e.get(stored.id) : undefined;
  const spent = usedOn(t, today) - usedBefore;
  if (live && live !== t && spent > 0) {
    live.state.triageToday = { date: today, count: usedOn(live, today) + spent };
    await e.save(live);
  }
  const counted = live ?? t;
  return {
    trigger: { id: t.id, name: t.name, draft: !!draft },
    using,
    runs,
    missing,
    outside: (using === "recent" && signals.some((s) => s.external)) || runs.some((r) => r.read),
    ...(t.script || t.triage ? { quick: { used: usedOn(counted, today), perDay: t.triagePerDay ?? DEFAULT_TRIAGE_PER_DAY } } : {}),
  };
}
