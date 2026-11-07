// Input validation for creating and updating triggers (shared by agent tools and the UI API).
// Messages are English for the model; the code and params give people the same error in their language.

import { randomBytes } from "node:crypto";
import { TriggerError, type ErrorParams } from "./errors.ts";
import { cronError, defaultReport, parseDateTime, timeError } from "./schedule.ts";
import { networkPattern } from "../egress.ts";
import { matchError } from "./match.ts";
import { BUILTIN_SOURCES, TRIGGER_KINDS, type Subscription, type Trigger, type TriggerInput, type TriggerKind } from "./types.ts";
import { parseJsonPath, selectorError, WatchError } from "./watch.ts";

export class ValidationError extends TriggerError {}

export const MIN_WATCH_MINUTES = 5;
export const MAX_WATCH_MINUTES = 7 * 24 * 60;
export const DEFAULT_WATCH_MINUTES = 60;
export const DEFAULT_MAX_RUNS = 24;
export const DEFAULT_HEARTBEAT_TIMES = ["10:00", "18:00"];
export const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5];

export const MAX_ON = 20;
export const MAX_CONFIG_BYTES = 8 * 1024;
export const MAX_SCRIPT_BYTES = 64 * 1024;
export const MAX_HOSTS = 30;
export const MIN_BATCH_SECONDS = 5;
export const MAX_BATCH_SECONDS = 3600;
export const MAX_BATCH_SIGNALS = 500;
export const MAX_BRIEF = 2000;
export const MAX_TRIAGE_PER_DAY = 2000;
export const DEFAULT_TRIAGE_PER_DAY = 200;

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

const SIGNAL_TYPE = /^[a-z][a-z0-9-]*(\.[a-z0-9_-]+)+$/;
const isBuiltin = (type: unknown): boolean => (BUILTIN_SOURCES as readonly string[]).includes(type as string);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The kind a built-in source maps to, given its config. */
const builtinKind = (type: string, config: Record<string, unknown>): TriggerKind =>
  type === "time.cron" ? (config.times !== undefined || config.weekdays !== undefined ? "heartbeat" : "schedule") : type === "time.at" ? "once" : type === "web.page" ? "watch" : "event";

/**
 * Turn a built-in `on` entry (time.cron, time.at, web.page, web.webhook) into the trigger's kind and its fields,
 * leaving the other subscriptions in `on`. Input without such an entry comes back unchanged.
 */
export function normalizeOn(input: TriggerInput): TriggerInput {
  if (!input || typeof input !== "object" || !Array.isArray(input.on)) return input;
  const builtin = input.on.filter((s) => isObject(s) && isBuiltin(s.type));
  if (!builtin.length) return input;
  if (builtin.length > 1) fail("onBuiltinTwice", "Only one built-in source (time.cron, time.at, web.page, web.webhook) fits in one trigger");
  const entry = builtin[0];
  const config = isObject(entry.config) ? entry.config : {};
  const kind = builtinKind(entry.type, config);
  if (input.kind !== undefined && input.kind !== kind)
    fail("onKindConflict", `The source ${entry.type} does not fit a trigger of kind ${String(input.kind)}`, { type: entry.type, kind: String(input.kind) });
  const out: TriggerInput = { ...input, kind, on: input.on.filter((s) => s !== entry) };
  switch (entry.type) {
    case "time.cron":
      if (kind === "schedule") out.cron = config.cron as string;
      else {
        if (config.times !== undefined) out.times = config.times as string[];
        if (config.weekdays !== undefined) out.weekdays = config.weekdays as number[];
      }
      break;
    case "time.at":
      out.at = config.at as string;
      break;
    case "web.page":
      for (const k of ["url", "selector", "jsonPath", "intervalMinutes"] as const) if (config[k] !== undefined) (out as Record<string, unknown>)[k] = config[k];
      break;
    case "web.webhook":
      if (config.verify !== undefined) out.verify = config.verify;
      break;
  }
  return out;
}

/** Validate subscriptions that stay in `on`; returns them in canonical shape. */
function checkOn(v: unknown, kind: TriggerKind): Subscription[] {
  if (!Array.isArray(v)) return fail("onType", "on must be a list of subscriptions", { type: String(v) });
  if (v.length > MAX_ON) fail("onTooMany", `A trigger can subscribe to at most ${MAX_ON} signal types`, { max: MAX_ON });
  const out: Subscription[] = [];
  for (const raw of v as unknown[]) {
    const type = isObject(raw) ? raw.type : undefined;
    if (typeof type !== "string" || !SIGNAL_TYPE.test(type))
      fail("onType", `Invalid signal type "${String(type)}": use a dotted name like source.event, e.g. composio.gmail_new_message`, { type: String(type) });
    if (isBuiltin(type)) fail("onKindConflict", `The source ${String(type)} does not fit a trigger of kind ${kind}`, { type: String(type), kind });
    const sub = raw as Record<string, unknown>;
    const name = type as string;
    const s: Subscription = { type: name };
    if (sub.config !== undefined && sub.config !== null) {
      if (!isObject(sub.config) || Buffer.byteLength(JSON.stringify(sub.config)) > MAX_CONFIG_BYTES)
        fail("configTooBig", `The config of ${name} is too big (at most ${MAX_CONFIG_BYTES / 1024} KB)`, { type: name, max: MAX_CONFIG_BYTES / 1024 });
      s.config = sub.config as Record<string, unknown>;
    }
    if (sub.where !== undefined && sub.where !== null) {
      const reason = matchError(sub.where);
      if (reason) fail("whereInvalid", `The filter (where) is not valid: ${reason}`, { reason });
      s.where = sub.where as Subscription["where"];
    }
    out.push(s);
  }
  return out;
}

function checkBatch(v: unknown): { windowSec: number; max?: number } {
  const b = isObject(v) ? v : {};
  const w = Number(b.windowSec);
  if (!Number.isInteger(w) || w < MIN_BATCH_SECONDS || w > MAX_BATCH_SECONDS)
    fail("batchWindow", `batch.windowSec must be from ${MIN_BATCH_SECONDS} to ${MAX_BATCH_SECONDS} seconds`, { min: MIN_BATCH_SECONDS, max: MAX_BATCH_SECONDS });
  const out: { windowSec: number; max?: number } = { windowSec: w };
  if (b.max !== undefined && b.max !== null) {
    const m = Number(b.max);
    if (!Number.isInteger(m) || m < 1 || m > MAX_BATCH_SIGNALS) fail("batchMax", `batch.max must be an integer from 1 to ${MAX_BATCH_SIGNALS}`, { max: MAX_BATCH_SIGNALS });
    out.max = m;
  }
  return out;
}

/** A host the script may reach: a DNS name or *.domain (or a public IP), nothing else. */
function checkHost(v: unknown): string {
  if (typeof v === "string") {
    try {
      return networkPattern(v.trim());
    } catch {
      // falls through to the error below
    }
  }
  return fail("hostInvalid", `"${String(v)}" is not a valid host: use a name like example.com or *.example.com, with no scheme, port, path or private address`, { host: String(v) });
}

function checkScript(v: unknown): { code: string; hosts: string[] } {
  const sc = isObject(v) ? v : {};
  if (typeof sc.code !== "string" || !sc.code.trim()) fail("required", "Field script.code is required", { field: "script.code" });
  const code = sc.code as string;
  if (Buffer.byteLength(code) > MAX_SCRIPT_BYTES) fail("scriptTooBig", `The script is too long (at most ${MAX_SCRIPT_BYTES / 1024} KB)`, { max: MAX_SCRIPT_BYTES / 1024 });
  const hostsIn = sc.hosts === undefined || sc.hosts === null ? [] : sc.hosts;
  if (!Array.isArray(hostsIn)) fail("hostInvalid", `"${String(hostsIn)}" is not a valid host: hosts must be a list`, { host: String(hostsIn) });
  if ((hostsIn as unknown[]).length > MAX_HOSTS) fail("hostsTooMany", `The script can reach at most ${MAX_HOSTS} hosts`, { max: MAX_HOSTS });
  return { code, hosts: [...new Set((hostsIn as unknown[]).map(checkHost))] };
}

function checkTriage(v: unknown): { brief: string } {
  const brief = isObject(v) && typeof v.brief === "string" ? v.brief.trim() : "";
  if (!brief) fail("briefRequired", "triage.brief is required: say what is worth waking the agent for");
  if (brief.length > MAX_BRIEF) fail("briefTooLong", `triage.brief is too long (at most ${MAX_BRIEF} characters)`, { max: MAX_BRIEF });
  return { brief };
}

function checkTriagePerDay(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_TRIAGE_PER_DAY) fail("triageLimit", `triagePerDay must be an integer from 1 to ${MAX_TRIAGE_PER_DAY}`, { max: MAX_TRIAGE_PER_DAY });
  return n;
}

const isUnset = (v: unknown) => v === null || v === undefined;

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
    case "signal":
      break;
  }
  if (kind === "event" && input.verify !== undefined && input.verify !== null) t.verify = input.verify;
  if (!isUnset(input.on)) {
    const on = checkOn(input.on, kind);
    if (on.length) t.on = on;
  }
  if (kind === "signal" && !t.on?.length) fail("signalNeedsOn", "A signal trigger needs at least one subscription (on) to a source other than time.cron, time.at, web.page or web.webhook");
  if (!isUnset(input.batch)) t.batch = checkBatch(input.batch);
  if (!isUnset(input.script)) t.script = checkScript(input.script);
  if (!isUnset(input.triage)) t.triage = checkTriage(input.triage);
  if (!isUnset(input.triagePerDay)) t.triagePerDay = checkTriagePerDay(input.triagePerDay);
  else if (t.triage) t.triagePerDay = DEFAULT_TRIAGE_PER_DAY;
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
    case "signal":
      break;
  }
  if (patch.on !== undefined) {
    const on = isUnset(patch.on) ? [] : checkOn(patch.on, t.kind);
    if (on.length) next.on = on;
    else delete next.on;
  }
  if (next.kind === "signal" && !next.on?.length) fail("signalNeedsOn", "A signal trigger needs at least one subscription (on) to a source other than time.cron, time.at, web.page or web.webhook");
  if (patch.batch !== undefined) {
    if (isUnset(patch.batch)) delete next.batch;
    else next.batch = checkBatch(patch.batch);
  }
  if (patch.script !== undefined) {
    if (isUnset(patch.script)) delete next.script;
    else next.script = checkScript(patch.script);
  }
  if (patch.triage !== undefined) {
    if (isUnset(patch.triage)) {
      delete next.triage;
      delete next.triagePerDay;
    } else {
      next.triage = checkTriage(patch.triage);
      if (next.triagePerDay === undefined) next.triagePerDay = DEFAULT_TRIAGE_PER_DAY;
    }
  }
  if (patch.triagePerDay !== undefined) {
    if (isUnset(patch.triagePerDay)) delete next.triagePerDay;
    else next.triagePerDay = checkTriagePerDay(patch.triagePerDay);
  }
  next.updatedAt = o.now.toISOString();
  return next;
}
