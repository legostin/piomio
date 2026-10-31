// Input validation for creating and updating triggers (shared by agent tools and the UI API).
// Messages are English for the model; the code and params give people the same error in their language.

import { randomBytes } from "node:crypto";
import { TriggerError, type ErrorParams } from "./errors.ts";
import { cronError, defaultReport, parseDateTime, timeError } from "./schedule.ts";
import { TRIGGER_KINDS, type Trigger, type TriggerInput, type TriggerKind } from "./types.ts";
import { parseJsonPath, selectorError, WatchError } from "./watch.ts";

export class ValidationError extends TriggerError {}

export const MIN_WATCH_MINUTES = 5;
export const MAX_WATCH_MINUTES = 7 * 24 * 60;
export const DEFAULT_WATCH_MINUTES = 60;
export const DEFAULT_MAX_RUNS = 24;
export const DEFAULT_HEARTBEAT_TIMES = ["10:00", "18:00"];
export const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5];

const fail = (code: string, message: string, params?: ErrorParams): never => {
  throw new ValidationError(code, message, params);
};

/** Rethrow a problem found by a checker (cron, time, selector, JSON path) as a validation error. */
const failWith = (e: TriggerError): never => fail(e.code, e.message, e.params);

export const newTriggerId = () => `t_${randomBytes(5).toString("hex")}`;
export const newSecret = () => randomBytes(24).toString("base64url");

const str = (v: unknown, field: string, max: number): string => {
  if (typeof v !== "string" || !v.trim()) fail("required", `Field ${field} is required`, { field });
  const s = (v as string).trim();
  if (s.length > max) fail("tooLong", `Field ${field} is too long (at most ${max} characters)`, { field, max });
  return s;
};

const optStr = (v: unknown, field: string, max: number): string | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") fail("notString", `Field ${field} must be a string`, { field });
  return str(v, field, max);
};

function checkUrl(v: unknown): string {
  const url = str(v, "url", 2000);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return fail("badUrl", `Invalid address "${url}": a full URL is required, e.g. https://example.com/page`, { url });
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") fail("httpOnly", "Only http and https addresses are supported");
  return u.toString();
}

function checkInterval(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) fail("intervalNumber", "intervalMinutes must be a number of minutes");
  if (n < MIN_WATCH_MINUTES) fail("intervalMin", `The check interval must be at least ${MIN_WATCH_MINUTES} minutes (got ${n})`, { min: MIN_WATCH_MINUTES, value: n });
  if (n > MAX_WATCH_MINUTES) fail("intervalMax", `The check interval must be at most a week (${MAX_WATCH_MINUTES} minutes)`, { max: MAX_WATCH_MINUTES });
  return Math.round(n);
}

function checkTimes(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length) fail("timesList", 'times must be a non-empty list of "HH:MM" times, e.g. ["10:00", "18:00"]');
  for (const t of v as unknown[]) {
    const e = timeError(t);
    if (e) failWith(e);
  }
  return [...new Set(v as string[])].sort();
}

function checkWeekdays(v: unknown): number[] {
  if (!Array.isArray(v) || !v.length) fail("weekdaysList", "weekdays must be a non-empty list of weekdays 0-6 (0 = Sunday)");
  for (const d of v as unknown[])
    if (!Number.isInteger(d) || (d as number) < 0 || (d as number) > 6) fail("weekdayRange", `Weekday ${String(d)} is outside 0-6 (0 = Sunday)`, { value: String(d) });
  return [...new Set(v as number[])].sort();
}

function checkMaxRuns(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 1000) fail("maxRuns", "maxRunsPerDay must be an integer from 1 to 1000");
  return n;
}

function checkReport(v: unknown, kind: TriggerKind): boolean {
  if (typeof v !== "boolean") fail("reportBool", "report must be true or false");
  if (v && kind !== "schedule" && kind !== "once")
    fail("reportKind", "Only schedule and once triggers can be reports: other kinds speak through notify when something needs attention", { kind });
  return v as boolean;
}

function checkAt(v: unknown, tz: string, now: Date): string {
  const s = str(v, "at", 64);
  const d = parseDateTime(s, tz);
  if (!d)
    return fail("badTime", `Cannot parse the time "${s}": use ISO format, e.g. 2026-10-27T09:00 (the user's local time) or 2026-10-27T06:00:00Z`, { value: s });
  if (d.getTime() <= now.getTime()) fail("pastTime", `The time "${s}" has already passed`, { value: s });
  return d.toISOString();
}

function checkWatchTarget(selector: unknown, jsonPath: unknown): { selector?: string; jsonPath?: string } {
  const sel = optStr(selector, "selector", 500);
  const jp = optStr(jsonPath, "jsonPath", 500);
  if (sel && jp) fail("selectorOrJsonPath", "Specify only one: selector (for HTML) or jsonPath (for JSON)");
  if (sel) {
    const e = selectorError(sel);
    if (e) failWith(e);
  }
  if (jp) {
    try {
      parseJsonPath(jp);
    } catch (e) {
      if (e instanceof WatchError) failWith(e);
      throw e;
    }
  }
  return { selector: sel, jsonPath: jp };
}

export interface BuildOptions {
  now: Date;
  tz: string;
  defaultAgent: string;
  createdBy: string;
}

export function buildTrigger(input: TriggerInput, o: BuildOptions): Trigger {
  if (!input || typeof input !== "object") fail("noData", "No trigger data");
  const kind = input.kind as TriggerKind;
  if (!TRIGGER_KINDS.includes(kind))
    fail("unknownKind", `Unknown trigger kind "${String(input.kind)}". Allowed: ${TRIGGER_KINDS.join(", ")}`, { kind: String(input.kind), kinds: TRIGGER_KINDS.join(", ") });
  const prompt = str(input.prompt, "prompt", 8000);
  const name = input.name === undefined || input.name === "" ? prompt.split("\n")[0].slice(0, 60) : str(input.name, "name", 120);
  const nowIso = o.now.toISOString();
  const t: Trigger = {
    id: newTriggerId(),
    kind,
    name,
    prompt,
    agentId: optStr(input.agent ?? input.agentId, "agent", 64) ?? o.defaultAgent,
    enabled: input.enabled ?? true,
    maxRunsPerDay: input.maxRunsPerDay === undefined ? DEFAULT_MAX_RUNS : checkMaxRuns(input.maxRunsPerDay),
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy: o.createdBy,
    state: {},
  };
  const skill = optStr(input.skill, "skill", 64);
  if (skill) t.skill = skill;
  switch (kind) {
    case "schedule": {
      const e = cronError(input.cron);
      if (e) failWith(e);
      t.cron = (input.cron as string).trim().replace(/\s+/g, " ");
      break;
    }
    case "once":
      t.at = checkAt(input.at, o.tz, o.now);
      break;
    case "watch":
      t.url = checkUrl(input.url);
      t.intervalMinutes = input.intervalMinutes === undefined ? DEFAULT_WATCH_MINUTES : checkInterval(input.intervalMinutes);
      Object.assign(t, checkWatchTarget(input.selector, input.jsonPath));
      break;
    case "event":
      t.secret = newSecret();
      break;
    case "heartbeat":
      t.times = input.times === undefined ? [...DEFAULT_HEARTBEAT_TIMES] : checkTimes(input.times);
      t.weekdays = input.weekdays === undefined ? [...DEFAULT_WEEKDAYS] : checkWeekdays(input.weekdays);
      break;
  }
  t.report = input.report === undefined ? defaultReport(t, o.tz, o.now) : checkReport(input.report, kind);
  return t;
}

/** Apply a partial update; returns a new trigger. Changing what a watch looks at resets its baseline. */
export function applyUpdate(t: Trigger, patch: TriggerInput, o: { now: Date; tz: string }): Trigger {
  if (!patch || typeof patch !== "object") fail("noChanges", "Nothing to update");
  if (patch.kind !== undefined && patch.kind !== t.kind) fail("kindFixed", "The trigger kind cannot be changed: create a new trigger instead");
  const next: Trigger = { ...t, state: { ...t.state } };
  if (patch.name !== undefined) next.name = str(patch.name, "name", 120);
  if (patch.prompt !== undefined) next.prompt = str(patch.prompt, "prompt", 8000);
  if (patch.agent !== undefined || patch.agentId !== undefined) next.agentId = str(patch.agent ?? patch.agentId, "agent", 64);
  if (patch.maxRunsPerDay !== undefined) next.maxRunsPerDay = checkMaxRuns(patch.maxRunsPerDay);
  if (patch.skill !== undefined) {
    const skill = optStr(patch.skill, "skill", 64);
    if (skill) next.skill = skill;
    else delete next.skill;
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") fail("enabledBool", "enabled must be true or false");
    next.enabled = patch.enabled;
  }
  if (patch.report !== undefined) next.report = checkReport(patch.report, t.kind);
  switch (t.kind) {
    case "schedule":
      if (patch.cron !== undefined) {
        const e = cronError(patch.cron);
        if (e) failWith(e);
        next.cron = patch.cron.trim().replace(/\s+/g, " ");
      }
      break;
    case "once":
      if (patch.at !== undefined) {
        next.at = checkAt(patch.at, o.tz, o.now);
        next.state.done = false;
        if (patch.enabled === undefined) next.enabled = true;
      } else if (next.enabled && !t.enabled && t.state.done) fail("onceFired", "This one-time trigger has already fired: set a new time (at)");
      break;
    case "watch": {
      if (patch.url !== undefined) next.url = checkUrl(patch.url);
      if (patch.intervalMinutes !== undefined) next.intervalMinutes = checkInterval(patch.intervalMinutes);
      if (patch.selector !== undefined || patch.jsonPath !== undefined) {
        const target = checkWatchTarget(patch.selector === undefined ? t.selector : patch.selector, patch.jsonPath === undefined ? t.jsonPath : patch.jsonPath);
        next.selector = target.selector;
        next.jsonPath = target.jsonPath;
      }
      if (next.url !== t.url || next.selector !== t.selector || next.jsonPath !== t.jsonPath) {
        delete next.state.lastHash;
        delete next.state.lastValue;
        delete next.state.lastCheckedAt;
      }
      break;
    }
    case "heartbeat":
      if (patch.times !== undefined) next.times = checkTimes(patch.times);
      if (patch.weekdays !== undefined) next.weekdays = checkWeekdays(patch.weekdays);
      break;
    case "event":
      break;
  }
  next.updatedAt = o.now.toISOString();
  return next;
}
