// Trigger engine (in core since the unified triggers, phase 1): persistence, timers, firing tasks, watch polling, webhooks, feedback.

import { randomBytes } from "node:crypto";
import type { TriggerHost, TriggerHttpRequest, TriggerHttpResponse } from "./host.ts";
import { errorFields, TriggerError, type ErrorParams } from "./errors.ts";
import { DEFAULT_HEARTBEAT_PROMPT, renderPrompt, type FireContext } from "./prompt.ts";
import { computeNextRun, defaultReport, localDate, validTimezone, zonedParts } from "./schedule.ts";
import type { RunReason, Signal, Trigger, TriggerInput, TriggerRun, TriggerState } from "./types.ts";
import { applyUpdate, buildTrigger, DEFAULT_HEARTBEAT_TIMES, DEFAULT_WEEKDAYS, ValidationError } from "./validate.ts";
import { pageReader } from "./extract.ts";
import { builtinSignal, fitted, NO_SERVICES, SIGNAL_DATA_MAX, TriggerPipeline } from "./pipeline.ts";
import { verifyWebhook } from "./webhook-verify.ts";
import { fetchPage, hashValue, lineDiff } from "./watch.ts";

export const MAX_RUNS_KEPT = 20;
const MAX_TIMER_MS = 60_000;
const STORED_VALUE_LIMIT = 20_000;
const CATCH_UP_GRACE_MS = 60_000;
/** The wall clock ran on this much more than the timers: the computer slept (other replicas take the lead after 8 s). */
const ASLEEP_MS = 5_000;
/** After a wake, the replica that led meanwhile may lead a little longer: it checks every 2 s, then stands down. */
const HANDOVER_MS = 15_000;
/** How long a slot that came while the computer slept waits for what another replica wrote (its pulls are 30 s long polls). */
const SETTLE_MS = 45_000;

export interface EngineSettings {
  allowPrivateUrls: boolean;
  watchTimeoutSec: number;
}

export function readEngineSettings(s: Record<string, any> = {}): EngineSettings {
  const timeout = Number(s.watchTimeoutSec);
  return {
    allowPrivateUrls: s.allowPrivateUrls === true,
    watchTimeoutSec: Number.isFinite(timeout) && timeout >= 1 ? Math.min(timeout, 120) : 30,
  };
}

export class NotFoundError extends TriggerError {}

/** How a firing goes: the daily limit, a busy previous run, and what the pipeline adds to it. */
export interface FireOptions {
  /** The journal line's id (a queued pipeline run keeps its own, so a retry after a stop replaces its line). */
  runId?: string;
  force?: boolean;
  skipIfBusy?: boolean;
  /** The goal carries outside content (the pipeline's run read some): the task is created tainted. */
  tainted?: boolean;
  /** The pipeline's part of the run: its signals, stages, outcome and whether it read outside content. */
  journal?: Pick<TriggerRun, "signals" | "stages" | "outcome" | "external">;
  /** The run's signals in full, kept with it in the journal. */
  signalData?: Signal[];
}

/** A trigger whose firings go through the pipeline (pipeline.ts); any other fires exactly as it always did. */
export const piped = (t: Trigger): boolean => !!(t.script || t.triage || t.batch);

/** Headers a sender names a delivery by (redeliveries carry the same one): the signal's dedup key. */
const DELIVERY_HEADERS = ["x-piomio-delivery", "x-github-delivery", "idempotency-key"];

/** A value's JSON, or its text when it has none (a payload too deeply nested to write). */
function jsonText(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "null";
  } catch {
    return String(v);
  }
}

/** Remember (or clear) the last error of a trigger, with its code for the UI. */
function setLastError(s: TriggerState, e?: { message?: string; code?: string; params?: ErrorParams }): void {
  s.lastError = e?.message;
  s.lastErrorCode = e?.code;
  s.lastErrorParams = e?.params;
}

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  return undefined;
}

function defaultTimezone(): string {
  const env = process.env.TZ;
  if (validTimezone(env)) return env;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export class TriggerEngine {
  ctx: TriggerHost;
  settings: EngineSettings;
  triggers = new Map<string, Trigger>();
  tz = defaultTimezone();
  publicUrl = "";
  defaultAgent = "assistant";
  now: () => number;
  /** Signing keys read from the vault, held 30 s per trigger (the host has no vault event to drop them on). */
  private keyCache = new Map<string, { ref: string; key: string; until: number }>();
  /** Script, quick check, batch: what a trigger that has any of them does with its signals. */
  pipeline: TriggerPipeline;

  private timer?: NodeJS.Timeout;
  private settingsTimer?: NodeJS.Timeout;
  private stopped = false;
  private booted = false;
  private inflight = new Set<string>();
  private locks = new Map<string, Promise<unknown>>();
  /** Slots that came while the computer slept (`settle`): trigger id → the slot, and the timer while it waits. */
  private settling = new Map<string, { slot: string; timer?: NodeJS.Timeout }>();
  /** Wall clock minus the timers' clock at the last tick: it grows by the time the computer slept. */
  private clockGap: number;
  /** When a tick last found the computer had slept (ms). */
  private wokeAt = -Infinity;

  constructor(ctx: TriggerHost, opts: { now?: () => number } = {}) {
    this.ctx = ctx;
    this.settings = readEngineSettings(ctx.settings);
    this.now = opts.now ?? Date.now;
    this.clockGap = this.now() - performance.now();
    this.pipeline = new TriggerPipeline(this, ctx.pipeline ?? NO_SERVICES);
  }

  // ---------- lifecycle ----------

  /** Load triggers; on first activation create the default heartbeat. */
  async start(): Promise<void> {
    await this.refreshCoreSettings();
    for (const { value } of await this.ctx.storage.list("trigger:")) {
      const t = value as Trigger | null;
      if (t?.id && t.kind) this.triggers.set(t.id, { ...t, state: t.state ?? {} });
    }
    // Triggers saved before reports existed get the default once (a daily brief reports, an hourly check does not).
    const nowReports: Trigger[] = [];
    for (const t of this.triggers.values()) {
      if (t.report !== undefined) continue;
      t.report = defaultReport(t, this.tz, new Date(this.now()));
      await this.save(t);
      // What still runs is news: a paused schedule or a reminder that already fired sends nothing either way.
      if (t.report && t.enabled && !t.state.done) nowReports.push(t);
    }
    if (nowReports.length) await this.tellNowReports(nowReports);
    if (!(await this.ctx.storage.get("initialized"))) {
      if (![...this.triggers.values()].some((t) => t.kind === "heartbeat")) await this.createDefaultHeartbeat();
      await this.ctx.storage.set("initialized", true);
    }
    this.settingsTimer = setInterval(() => void this.refreshCoreSettings(), 5 * 60_000);
    this.settingsTimer.unref?.();
  }

  /**
   * Run at most one catch-up per trigger for runs missed while the hub was down, then arm the timer. A catch-up that
   * goes through the pipeline (a script, a quick check, a batch) has its slot spent first and runs in the background
   * after the timers are armed: a hung quick model cannot keep the hub from booting, or the other triggers from firing.
   */
  async boot(): Promise<void> {
    // Stopped before its turn came (the hub stood down right after starting it): nothing to run or plan.
    if (this.stopped) return;
    const now = new Date(this.now());
    const pipedCatchUps: Array<{ id: string; missedAt: string; once: boolean }> = [];
    for (const t of [...this.triggers.values()]) {
      if (!t.enabled || this.stopped) continue;
      const missedAt = this.missedRun(t, now);
      if (!missedAt) continue;
      await this.withLock(t.id, async () => {
        const cur = this.triggers.get(t.id);
        if (!cur) return;
        this.ctx.log.info(`trigger ${cur.id}: catch-up for ${missedAt}`);
        if (piped(cur)) pipedCatchUps.push({ id: cur.id, missedAt, once: cur.kind === "once" });
        else await this.fire(cur, "catch-up", { missedAt }, { force: cur.kind === "once" });
        if (cur.kind === "once") {
          cur.state.done = true;
          cur.enabled = false;
        }
        cur.state.lastSlot = missedAt;
        cur.state.nextRunAt = undefined;
        await this.save(cur);
      });
    }
    for (const t of this.triggers.values()) {
      if (this.stopped) return;
      // Due just now (within the grace period): keep it, the timer fires it as a normal run.
      const planned = t.state.nextRunAt ? Date.parse(t.state.nextRunAt) : NaN;
      if (t.enabled && planned <= now.getTime() && t.kind !== "watch") continue;
      await this.reschedule(t, now);
    }
    this.booted = true;
    this.arm();
    // Runs queued and batches still open when the hub stopped (or another replica led) go on.
    await this.pipeline.resume();
    for (const c of pipedCatchUps) {
      const cur = this.triggers.get(c.id);
      if (!cur || this.stopped) continue;
      this.pipeline.accept(cur, [this.tickSignal(c.missedAt, "catch-up")], "catch-up", { force: c.once, immediate: c.once });
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.settingsTimer) clearInterval(this.settingsTimer);
    for (const s of this.settling.values()) if (s.timer) clearTimeout(s.timer);
    this.pipeline.stop();
  }

  updateSettings(raw: Record<string, any>): void {
    this.settings = readEngineSettings(raw);
  }

  async refreshCoreSettings(): Promise<void> {
    try {
      const s = await this.ctx.core.call<{ timezone?: string; publicUrl?: string; defaultAgent?: string }>("settings.get");
      if (typeof s?.publicUrl === "string") this.publicUrl = s.publicUrl.replace(/\/+$/, "");
      if (typeof s?.defaultAgent === "string" && s.defaultAgent) this.defaultAgent = s.defaultAgent;
      if (validTimezone(s?.timezone) && s.timezone !== this.tz) {
        this.tz = s.timezone;
        if (this.booted) {
          const now = new Date(this.now());
          for (const t of this.triggers.values()) if (t.kind === "schedule" || t.kind === "heartbeat") await this.reschedule(t, now);
          this.arm();
        }
      }
    } catch (e: any) {
      this.ctx.log.warn(`settings.get failed: ${e?.message ?? e}`);
    }
  }

  /** A planned run that passed more than CATCH_UP_GRACE_MS ago (the hub was down). */
  private missedRun(t: Trigger, now: Date): string | undefined {
    const limit = now.getTime() - CATCH_UP_GRACE_MS;
    if (t.kind === "once") return !t.state.done && t.at && Date.parse(t.at) < limit ? t.at : undefined;
    if (t.kind === "schedule" || t.kind === "heartbeat") {
      const planned = t.state.nextRunAt ? Date.parse(t.state.nextRunAt) : NaN;
      return planned < limit ? t.state.nextRunAt : undefined;
    }
    return undefined;
  }

  private async createDefaultHeartbeat(): Promise<void> {
    const t = buildTrigger(
      { kind: "heartbeat", name: this.ctx.i18n.t("heartbeat.defaultName"), prompt: DEFAULT_HEARTBEAT_PROMPT, agent: "assistant", times: DEFAULT_HEARTBEAT_TIMES, weekdays: DEFAULT_WEEKDAYS },
      { now: new Date(this.now()), tz: this.tz, defaultAgent: "assistant", createdBy: "system" },
    );
    t.state.nextRunAt = computeNextRun(t, this.tz, new Date(this.now()))?.toISOString();
    this.triggers.set(t.id, t);
    await this.save(t);
    this.ctx.log.info(`created default heartbeat ${t.id}`);
  }

  // ---------- persistence ----------

  /** Also the pipeline's: it saves the trigger's state after a run. */
  async save(t: Trigger): Promise<void> {
    if (this.triggers.get(t.id) !== t) return; // deleted or replaced meanwhile
    await this.ctx.storage.set(`trigger:${t.id}`, t);
  }

  async runs(id: string): Promise<TriggerRun[]> {
    return this.ctx.store.runs(id, MAX_RUNS_KEPT);
  }

  /** A run into the journal, with its signals in full when it had any. */
  async addRun(id: string, run: TriggerRun, signalData?: Signal[]): Promise<void> {
    if (!this.triggers.has(id)) return;
    this.ctx.store.addRun(id, signalData?.length ? { ...run, signalData } : run);
  }

  emit(id: string): void {
    this.ctx.ui.emit("changed", { id });
  }

  /**
   * Serialize everything that mutates one trigger (the pipeline's queued runs take it too). A pipeline run holds it at
   * most about a minute: the script's 30 s wall (its pio calls cut off with it), then a quick check bounded at 25 s
   * (QUICK_TIMEOUT_MS), plus any wait for a free sandbox slot. An update, a delete or feedback "off" waits no longer.
   */
  withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }

  // ---------- scheduling ----------

  private async reschedule(t: Trigger, now: Date): Promise<void> {
    const next = computeNextRun(t, this.tz, now)?.toISOString();
    if (next !== t.state.nextRunAt) {
      t.state.nextRunAt = next;
      await this.save(t);
    }
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped) return;
    let min = Infinity;
    for (const t of this.triggers.values()) {
      if (!t.enabled || !t.state.nextRunAt || this.inflight.has(t.id) || this.settling.get(t.id)?.timer) continue;
      min = Math.min(min, Date.parse(t.state.nextRunAt));
    }
    if (!Number.isFinite(min)) return;
    const delay = Math.min(Math.max(0, min - this.now()), MAX_TIMER_MS);
    this.timer = setTimeout(() => this.tick(), delay);
  }

  private tick(): void {
    this.timer = undefined;
    const now = this.now();
    this.noticeWake(now);
    for (const t of [...this.triggers.values()]) {
      if (!t.enabled || !t.state.nextRunAt || this.inflight.has(t.id) || this.settling.get(t.id)?.timer || Date.parse(t.state.nextRunAt) > now) continue;
      this.inflight.add(t.id);
      void this.withLock(t.id, () => this.runDue(t.id))
        .catch((e) => this.ctx.log.error(`trigger ${t.id} failed: ${e?.message ?? e}`))
        .finally(() => {
          this.inflight.delete(t.id);
          this.arm();
        });
    }
    this.arm();
  }

  /** Remembers when the computer woke: its wall clock ran on while the timers stood still. */
  private noticeWake(now: number): void {
    const gap = now - performance.now();
    if (gap - this.clockGap > ASLEEP_MS) this.wokeAt = now;
    this.clockGap = gap;
  }

  /**
   * A slot that came while the computer slept, or right after it woke: another replica of the hub (cluster.ts) may have
   * led meanwhile and run it, and what it wrote may still be on the way. The slot waits SETTLE_MS once, then runs unless
   * storage shows it ran. True while it waits.
   */
  private settle(id: string, slot: string): boolean {
    const cur = this.settling.get(id);
    if (cur?.slot === slot) return !!cur.timer;
    if (Date.parse(slot) > this.wokeAt + HANDOVER_MS) return false;
    const entry: { slot: string; timer?: NodeJS.Timeout } = { slot };
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      this.arm();
    }, SETTLE_MS);
    this.settling.set(id, entry);
    return true;
  }

  /** The trigger as storage has it (another replica of the hub may have written it), adopted; undefined when it is gone. */
  private async reload(id: string): Promise<Trigger | undefined> {
    const stored = await this.ctx.storage.get<Trigger>(`trigger:${id}`);
    if (!stored?.id) {
      this.triggers.delete(id);
      this.emit(id);
      return undefined;
    }
    const t = { ...stored, state: stored.state ?? {} };
    this.triggers.set(id, t);
    return t;
  }

  private async runDue(id: string): Promise<void> {
    if (!this.triggers.has(id) || this.stopped) return;
    const t = await this.reload(id);
    if (!t || !t.enabled) return;
    const now = new Date(this.now());
    if (!t.state.nextRunAt || Date.parse(t.state.nextRunAt) > now.getTime()) return; // rescheduled or run meanwhile
    const slot = t.state.nextRunAt;
    if (t.kind !== "watch" && t.kind !== "event" && this.settle(id, slot)) return;
    switch (t.kind) {
      case "schedule":
      case "heartbeat": {
        const ran = !!t.state.lastSlot && Date.parse(t.state.lastSlot) >= Date.parse(slot);
        // Plan the next run first so a slow firing is never repeated, and remember the slot so it never fires twice.
        t.state.nextRunAt = computeNextRun(t, this.tz, now)?.toISOString();
        if (!ran) t.state.lastSlot = slot;
        await this.save(t);
        if (ran) return;
        if (piped(t)) await this.pipeline.deliver(t, [this.tickSignal(slot, t.kind)], t.kind, { skipIfBusy: true, locked: true });
        else await this.fire(t, t.kind, {}, { skipIfBusy: true });
        return;
      }
      case "once":
        // A one-time reminder has nothing to wait for: it goes on now, with whatever a batch gathered.
        if (piped(t)) await this.pipeline.deliver(t, [this.tickSignal(slot, "once")], "once", { force: true, immediate: true, locked: true });
        else await this.fire(t, "once", {}, { force: true });
        t.state.done = true;
        t.enabled = false;
        t.state.nextRunAt = undefined;
        await this.save(t);
        this.emit(t.id);
        return;
      case "watch":
        await this.check(t);
        return;
      case "event":
        t.state.nextRunAt = undefined;
        await this.save(t);
        return;
    }
  }

  // ---------- firing ----------

  private async previousStillRunning(t: Trigger): Promise<boolean> {
    if (!t.state.lastTaskId) return false;
    try {
      const tasks = await this.ctx.core.call<Array<{ id: string }>>("tasks.list", { status: ["queued", "running"], limit: 200 });
      return Array.isArray(tasks) && tasks.some((x) => x.id === t.state.lastTaskId);
    } catch {
      return false;
    }
  }

  /** Start the agent's task (the pipeline's wakes come here too, with their journal part and taint). */
  async fire(t: Trigger, reason: RunReason, extra: Partial<FireContext>, opts: FireOptions = {}): Promise<TriggerRun> {
    const now = new Date(this.now());
    const today = localDate(now, this.tz);
    const rt = t.state.runsToday?.date === today ? { ...t.state.runsToday } : { date: today, count: 0 };
    const run: TriggerRun = { id: opts.runId ?? `r_${randomBytes(4).toString("hex")}`, at: now.toISOString(), reason, status: "started", ...opts.journal };
    if (!opts.force && rt.count >= t.maxRunsPerDay) {
      run.status = "skipped";
      run.detail = `Daily run limit (${t.maxRunsPerDay}) reached`;
      run.code = "dailyLimit";
      run.params = { max: t.maxRunsPerDay };
    } else if (opts.skipIfBusy && (await this.previousStillRunning(t))) {
      run.status = "skipped";
      run.detail = "The previous run has not finished yet";
      run.code = "previousRunning";
    } else {
      const away = await this.machineAway(t);
      if (away) {
        Object.assign(run, { status: "error", ...away });
        if (reason !== "manual") await this.tellMachineAway(t, away);
      } else {
        try {
          const goal = renderPrompt(t, { reason, now, tz: this.tz, ...extra });
          const task = await this.ctx.core.call<{ id?: string; skipped?: string }>("tasks.create", {
            agentId: t.agentId,
            goal,
            title: t.name,
            background: true,
            triggerId: t.id,
            ...(t.report ? { report: true } : {}),
            ...(t.machine ? { machine: t.machine } : {}),
            ...(t.skill ? { skill: t.skill } : {}),
            ...(opts.tainted ? { tainted: true } : {}),
          });
          if (task?.skipped) {
            // The agent sleeps in the archive: nothing ran, and nothing counts against the day's runs.
            run.status = "skipped";
            run.detail = "The agent is in the archive";
            run.code = task.skipped;
          } else {
            rt.count++;
            run.taskId = task?.id;
            t.state.lastTaskId = task?.id;
            t.state.lastRunAt = run.at;
          }
        } catch (e: any) {
          run.status = "error";
          run.detail = e?.message ?? String(e);
        }
      }
    }
    t.state.runsToday = rt;
    t.state.lastStatus = run.status === "started" ? "ok" : run.status;
    setLastError(t.state, run.status === "started" ? undefined : { message: run.detail, code: run.code, params: run.params });
    await this.save(t);
    await this.addRun(t.id, run, opts.signalData);
    this.emit(t.id);
    if (run.status !== "started") this.ctx.log.info(`trigger ${t.id} ${run.status}: ${run.detail}`);
    return run;
  }

  /** Why the trigger's computer cannot take a run now (no longer paired, or offline); undefined when it can or none is set. */
  private async machineAway(t: Trigger): Promise<{ detail: string; code: string; params: ErrorParams } | undefined> {
    if (!t.machine) return undefined;
    const list = await this.computers();
    if (!list.length) return undefined; // the hub did not say: tasks.create decides
    const m = list.find((x) => x.id === t.machine);
    const name = m?.name ?? t.machineName ?? t.machine;
    if (m && m.name !== t.machineName) t.machineName = m.name;
    if (!m) return { detail: `The computer "${name}" is no longer paired with the hub`, code: "machineGone", params: { machine: name } };
    if (m.status !== "online") return { detail: `The computer "${name}" is offline`, code: "machineOffline", params: { machine: name } };
    return undefined;
  }

  /**
   * Schedules saved before reports existed that became reports on this start: the person hears it once (they are saved with
   * their report now, so no later start counts them), with how to turn one back into a quiet check in the chat.
   */
  private async tellNowReports(list: Trigger[]): Promise<void> {
    const names = list.map((t) => this.ctx.i18n.t("notify.nowReports.name", { name: t.name }));
    try {
      await this.ctx.core.call("notify", {
        level: "notify",
        title: this.ctx.i18n.t("notify.nowReports.title", { n: list.length }),
        body: this.ctx.i18n.t("notify.nowReports.body", { n: list.length, names: names.join(", "), example: list[0].name }),
      });
    } catch (e: any) {
      this.ctx.log.warn(`notify failed: ${e?.message ?? e}`);
    }
  }

  /** A run its computer could not take: the user hears of it, or it would just not happen. */
  private async tellMachineAway(t: Trigger, away: { code: string; params: ErrorParams }): Promise<void> {
    try {
      await this.ctx.core.call("notify", {
        level: "notify",
        title: this.ctx.i18n.t("notify.notRun", { name: t.name }),
        body: this.ctx.i18n.t(`error.${away.code}`, away.params),
        agentId: t.agentId,
      });
    } catch (e: any) {
      this.ctx.log.warn(`notify failed: ${e?.message ?? e}`);
    }
  }

  /** Poll a watch; fire only when the extracted value changed (the first poll stores a baseline). */
  private async check(
    t: Trigger,
  ): Promise<{ changed: boolean; baseline: boolean; error?: string; code?: string; params?: ErrorParams; run?: TriggerRun }> {
    const now = new Date(this.now());
    t.state.lastCheckedAt = now.toISOString();
    t.state.nextRunAt = t.enabled ? new Date(now.getTime() + (t.intervalMinutes ?? 60) * 60_000).toISOString() : undefined;
    let value: string;
    try {
      const page = await fetchPage(t.url!, { allowPrivate: this.settings.allowPrivateUrls, timeoutMs: this.settings.watchTimeoutSec * 1000, fetch: this.ctx.fetch });
      // Off the hub's thread: a hostile page cannot hold it (extract.ts).
      value = await pageReader.read(page.body, page.contentType, { selector: t.selector, jsonPath: t.jsonPath });
    } catch (e) {
      const err = errorFields(e);
      const repeated = t.state.lastStatus === "error" && t.state.lastError === err.message;
      t.state.lastStatus = "error";
      setLastError(t.state, err);
      await this.save(t);
      if (!repeated) {
        const run: TriggerRun = { id: `r_${randomBytes(4).toString("hex")}`, at: now.toISOString(), reason: "change", status: "error", detail: err.message };
        if (err.code) Object.assign(run, { code: err.code, params: err.params });
        await this.addRun(t.id, run);
      }
      this.emit(t.id);
      return { changed: false, baseline: false, error: err.message, code: err.code, params: err.params };
    }
    const hash = hashValue(value);
    const stored = value.length > STORED_VALUE_LIMIT ? value.slice(0, STORED_VALUE_LIMIT) : value;
    if (!t.state.lastHash) {
      t.state.lastHash = hash;
      t.state.lastValue = stored;
      t.state.lastStatus = "ok";
      setLastError(t.state);
      await this.save(t);
      this.emit(t.id);
      return { changed: false, baseline: true };
    }
    if (hash === t.state.lastHash) {
      if (t.state.lastStatus === "error") {
        t.state.lastStatus = "ok";
        setLastError(t.state);
      }
      await this.save(t);
      return { changed: false, baseline: false };
    }
    const previous = t.state.lastValue;
    t.state.lastHash = hash;
    t.state.lastValue = stored;
    t.state.lastChangeAt = now.toISOString();
    const change = { previous, current: value, diff: previous !== undefined ? lineDiff(previous, value) : undefined };
    const run = piped(t) ? await this.pipeline.deliver(t, [this.pageSignal(t, change)], "change", { locked: true }) : await this.fire(t, "change", { change });
    return { changed: true, baseline: false, run };
  }

  // ---------- public API (tools and UI) ----------

  list(): Trigger[] {
    return [...this.triggers.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): Trigger | undefined {
    return this.triggers.get(id);
  }

  require(id: unknown): Trigger {
    const t = typeof id === "string" ? this.triggers.get(id) : undefined;
    if (!t) throw new NotFoundError("notFound", `Trigger ${String(id)} not found`, { id: String(id) });
    return t;
  }

  webhookUrl(t: Trigger): string | undefined {
    return t.kind === "event" ? `${this.publicUrl || this.ctx.hubUrl}/hooks/${this.ctx.pluginId}/${t.id}` : undefined;
  }

  async agents(): Promise<Array<{ id: string; name: string }>> {
    try {
      const list = await this.ctx.core.call<Array<{ id: string; name: string }>>("agents.list");
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  /** The computers runs can happen on, the hub's own first; empty when the hub does not say. */
  async computers(): Promise<Array<{ id: string; name: string; status: string }>> {
    try {
      const list = await this.ctx.core.call<Array<{ id: string; name: string; status: string }>>("machines.list");
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  /** `machine` from a tool or the UI: the computer by id or name (an offline one is fine); null or "" clears it. */
  private async setMachine(t: Trigger, value: unknown): Promise<void> {
    if (value === undefined) return;
    if (value === null || (typeof value === "string" && !value.trim())) {
      delete t.machine;
      delete t.machineName;
      return;
    }
    if (typeof value !== "string") throw new ValidationError("notString", "Field machine must be a string", { field: "machine" });
    const key = value.trim().toLowerCase();
    const list = await this.computers();
    const m = list.find((x) => x.id.toLowerCase() === key || x.name.toLowerCase() === key) ?? list.find((x) => x.name.toLowerCase().includes(key));
    if (!m) {
      const available = list.map((x) => `${x.name} (${x.id}${x.status === "online" ? "" : ", offline"})`).join(", ");
      throw new ValidationError("unknownMachine", `No computer "${value}". Computers: ${available}`, { machine: value, available });
    }
    t.machine = m.id;
    t.machineName = m.name;
  }

  private async assertAgent(id: string): Promise<void> {
    const agents = await this.agents();
    if (agents.length && !agents.some((a) => a.id === id)) {
      const available = agents.map((a) => a.id).join(", ");
      throw new ValidationError("unknownAgent", `Unknown agent "${id}". Available: ${available}`, { id, available });
    }
  }

  async create(input: TriggerInput, o: { createdBy: string; defaultAgent?: string }): Promise<Trigger> {
    const now = new Date(this.now());
    const t = buildTrigger(input, { now, tz: this.tz, defaultAgent: o.defaultAgent ?? this.defaultAgent, createdBy: o.createdBy });
    await this.assertAgent(t.agentId);
    await this.setMachine(t, input.machine);
    t.state.nextRunAt = computeNextRun(t, this.tz, now)?.toISOString();
    this.triggers.set(t.id, t);
    await this.save(t);
    this.emit(t.id);
    this.arm();
    return t;
  }

  async update(id: string, patch: TriggerInput): Promise<Trigger> {
    this.require(id);
    return this.withLock(id, async () => {
      const cur = this.require(id);
      const now = new Date(this.now());
      const next = applyUpdate(cur, patch, { now, tz: this.tz });
      if (next.agentId !== cur.agentId) await this.assertAgent(next.agentId);
      await this.setMachine(next, patch.machine);
      next.state.nextRunAt = computeNextRun(next, this.tz, now)?.toISOString();
      this.triggers.set(id, next);
      await this.save(next);
      this.emit(id);
      this.arm();
      return next;
    });
  }

  async remove(id: string): Promise<Trigger> {
    this.require(id);
    return this.withLock(id, async () => {
      const t = this.require(id);
      this.triggers.delete(id);
      await this.ctx.storage.delete(`trigger:${id}`);
      this.ctx.store.dropRuns(id);
      this.ctx.store.dropState(id);
      this.pipeline.forget(id);
      this.emit(id);
      this.arm();
      return t;
    });
  }

  /** The person deleted the agent for good: its schedules, reminders, watches and webhooks go with it. */
  async removeAgent(agentId: string): Promise<number> {
    const ids = [...this.triggers.values()].filter((t) => t.agentId === agentId).map((t) => t.id);
    for (const id of ids) await this.remove(id);
    return ids.length;
  }

  /** Start the agent now. `force` (the user, from the UI) ignores the daily limit. */
  async runNow(id: string, opts: { force?: boolean } = {}): Promise<TriggerRun> {
    this.require(id);
    return this.withLock(id, async () => {
      const t = this.require(id);
      const currentValue = t.kind === "watch" ? t.state.lastValue : undefined;
      if (piped(t)) {
        // Now, whatever the batch: a run now always leaves a run (a watch's last known value goes into its goal).
        const manual = builtinSignal("manual", {}, { at: new Date(this.now()), external: false });
        const run = await this.pipeline.deliver(t, [manual], "manual", { force: opts.force, immediate: true, locked: true, ...(currentValue !== undefined ? { currentValue } : {}) });
        if (!run) throw new Error(`trigger ${id}: the run left no journal line`);
        return run;
      }
      return this.fire(t, "manual", currentValue !== undefined ? { currentValue } : {}, { force: opts.force });
    });
  }

  /** Poll a watch right now (fires only on change). */
  async checkNow(id: string) {
    const t0 = this.require(id);
    if (t0.kind !== "watch") throw new ValidationError("checkWatchOnly", "Only watch triggers can be checked now");
    this.inflight.add(id);
    try {
      return await this.withLock(id, async () => this.check(this.require(id)));
    } finally {
      this.inflight.delete(id);
      this.arm();
    }
  }

  async runsWithStatus(id: string): Promise<Array<TriggerRun & { taskStatus?: string }>> {
    const runs = await this.runs(id);
    if (!runs.some((r) => r.taskId)) return runs;
    try {
      const tasks = await this.ctx.core.call<Array<{ id: string; status: string }>>("tasks.list", { limit: 200 });
      const status = new Map((Array.isArray(tasks) ? tasks : []).map((t) => [t.id, t.status]));
      return runs.map((r) => (r.taskId && status.has(r.taskId) ? { ...r, taskStatus: status.get(r.taskId) } : r));
    } catch {
      return runs;
    }
  }

  // ---------- feedback ----------

  async onFeedback(n: any): Promise<void> {
    const id = n?.triggerId;
    const value = n?.feedback;
    if (typeof id !== "string" || !this.triggers.has(id) || !["useful", "less", "off"].includes(value)) return;
    await this.withLock(id, async () => {
      const t = this.triggers.get(id);
      if (!t) return;
      const now = new Date(this.now());
      t.state.lastFeedback = { value, at: now.toISOString() };
      if (value === "off") {
        t.enabled = false;
        t.state.nextRunAt = undefined;
        this.ctx.log.info(`trigger ${id} disabled by feedback`);
      } else if (value === "less") {
        if (t.kind === "watch") t.intervalMinutes = Math.min(7 * 24 * 60, (t.intervalMinutes ?? 60) * 2);
        if (t.kind === "heartbeat" && (t.times?.length ?? 0) > 1) t.times = dropSlot(t.times!, n?.createdAt, this.tz);
        t.state.nextRunAt = computeNextRun(t, this.tz, now)?.toISOString();
      }
      t.updatedAt = now.toISOString();
      await this.save(t);
      this.emit(id);
      this.arm();
    });
  }

  // ---------- webhooks ----------

  async webhook(req: TriggerHttpRequest): Promise<TriggerHttpResponse> {
    const m = /^\/([A-Za-z0-9_-]{1,64})\/?$/.exec(req.path);
    const t = m ? this.triggers.get(m[1]) : undefined;
    const signed = t?.verify && t.verify.kind !== "secret" ? t.verify : undefined;
    if (!t || t.kind !== "event" || (!signed && !t.secret)) return { status: 404, body: { error: "not found" } };
    if (req.method.toUpperCase() !== "POST") return { status: 405, headers: { allow: "POST" }, body: { error: "use POST" } };
    // Who sent it, before anything is queued. A signed sender's key is in the vault, read only for this check.
    let key = t.secret ?? "";
    if (signed) {
      // An unsigned request costs no vault read, decrypt or audit record.
      const name = signed.kind === "github" ? "x-hub-signature-256" : signed.kind === "stripe" ? "stripe-signature" : (signed.header ?? "x-signature").toLowerCase();
      if (!header(req.headers, name)?.trim()) return { status: 401, body: { error: "invalid signature" } };
      const hit = this.keyCache.get(t.id);
      if (hit && hit.ref === signed.secretRef && hit.until > this.now()) key = hit.key;
      else {
        try {
          key = (await this.ctx.vault!.get(signed.secretRef, `trigger:${t.id}`)).value ?? "";
        } catch {
          key = "";
        }
        if (!key) {
          this.keyCache.delete(t.id);
          return { status: 503, body: { error: "signing secret unavailable" } };
        }
        this.keyCache.set(t.id, { ref: signed.secretRef, key, until: this.now() + 30_000 });
      }
    }
    const verdict = verifyWebhook(t.verify, { headers: req.headers ?? {}, rawBody: req.rawBody ?? "", query: req.query ?? {} }, key, this.now());
    if (!verdict.ok) return { status: 401, body: { error: signed ? "invalid signature" : "invalid secret" } };
    if (!t.enabled) return { status: 409, body: { error: "trigger is disabled" } };
    const { secret: _secret, ...query } = req.query ?? {};
    const body = req.body;
    const contentType = header(req.headers, "content-type");
    if (piped(t)) {
      // Taken in now and answered at once: the script, the quick check and the outcome follow under the trigger's
      // lock, in the background (a sender like GitHub gives up after 10 s). The run is in the journal by the signal's id.
      const intake = this.pipeline.accept(t, [this.hookSignal(req, body, query, contentType)], "webhook");
      const signalId = intake.signals[0]?.id;
      if (intake.held === "flood") return { status: 429, body: { error: "too many signals: dropped" } };
      if (intake.held === "full") return { status: 429, body: { error: "too many signals waiting: try again later" } };
      if (intake.held === "duplicate") return { status: 202, body: { ok: true, duplicate: true } };
      if (intake.held === "filtered") return { status: 202, body: { ok: true, filtered: true } };
      return { status: 202, body: { ok: true, ...(intake.held === "batch" ? { queued: true } : {}), signalId } };
    }
    const run = await this.withLock(t.id, async () => {
      const cur = this.triggers.get(t.id);
      if (!cur) throw new NotFoundError("notFound", "not found", { id: t.id });
      const payload = typeof body === "string" ? body : body === null || body === undefined ? "" : JSON.stringify(body, null, 2);
      return this.fire(cur, "webhook", { payload, query, contentType });
    });
    if (run.status === "skipped") return { status: 429, body: { error: run.detail } };
    if (run.status === "error") return { status: 502, body: { error: "could not start the task" } };
    return { status: 202, body: { ok: true, runId: run.id, taskId: run.taskId } };
  }

  // ---------- signals from the built-in sources ----------

  /** time.tick: a schedule's, a heartbeat's or a reminder's slot (not outside content); a catch-up names the slot it missed. */
  private tickSignal(slot: string, reason: RunReason): Signal {
    return builtinSignal("time.tick", { slot, reason, ...(reason === "catch-up" ? { missedAt: slot } : {}) }, { at: new Date(this.now()), external: false });
  }

  /** web.page: the watched value changed (outside content); the longest values are cut until it fits its 256 KB. */
  private pageSignal(t: Trigger, c: { previous?: string; current: string; diff?: string }): Signal {
    const raw = { url: t.url, previous: c.previous, current: c.current, diff: c.diff };
    const { data, truncated } = fitted(raw, ["current", "previous", "diff"]);
    return builtinSignal("web.page", truncated ? { ...data, truncated: true } : data, { at: new Date(this.now()), external: true, subject: t.url });
  }

  /**
   * web.webhook: what the sender posted (outside content), named by its delivery id when it gives one. A payload too
   * big for the signal's 256 KB goes on as its text, cut (as kept, escapes and all) until it fits, with truncated: true.
   */
  private hookSignal(req: TriggerHttpRequest, body: unknown, query: Record<string, string>, contentType: string | undefined): Signal {
    const key = DELIVERY_HEADERS.map((h) => header(req.headers, h)).find((v) => typeof v === "string" && v.trim());
    const payload = body === undefined ? null : body;
    let data: Record<string, unknown> = { payload, query, ...(contentType ? { contentType } : {}) };
    if (Buffer.byteLength(jsonText(data)) > SIGNAL_DATA_MAX) {
      data = fitted({ ...data, payload: typeof payload === "string" ? payload : jsonText(payload), truncated: true }, ["payload"]).data;
    }
    return builtinSignal("web.webhook", data, { at: new Date(this.now()), external: true, ...(key ? { key: key.trim() } : {}) });
  }
}

/** Heartbeat "less": drop the slot that produced the notification (the latest slot at or before it). */
export function dropSlot(times: string[], createdAt: unknown, tz: string): string[] {
  const sorted = [...times].sort();
  let idx = sorted.length - 1;
  const d = typeof createdAt === "string" ? new Date(createdAt) : undefined;
  if (d && !Number.isNaN(d.getTime())) {
    const p = zonedParts(d, tz);
    const hhmm = `${p.hour}:${p.minute}`;
    const before = sorted.map((s, i) => [s, i] as const).filter(([s]) => s <= hhmm);
    if (before.length) idx = before[before.length - 1][1];
  }
  return sorted.filter((_, i) => i !== idx);
}
