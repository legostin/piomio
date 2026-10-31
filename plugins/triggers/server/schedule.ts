// Time math: cron in the user's timezone, heartbeat slots, local dates, ISO parsing in a timezone.

import { Cron } from "croner";
import { TriggerError } from "./errors.ts";
import type { Trigger } from "./types.ts";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CRON_HINT = '(minute hour day month weekday), e.g. "0 9 * * 1-5"';

function cron(expr: string, tz?: string): Cron {
  return new Cron(expr.trim(), { timezone: tz, paused: true, mode: "5-part" });
}

/** What is wrong with a 5-field cron, or undefined when valid. */
export function cronError(expr: unknown): TriggerError | undefined {
  if (typeof expr !== "string" || !expr.trim()) return new TriggerError("cronMissing", `Specify a 5-field cron ${CRON_HINT}`);
  if (expr.trim().split(/\s+/).length !== 5)
    return new TriggerError("cronFields", `Invalid cron expression "${expr}": exactly 5 fields are required ${CRON_HINT}`, { expr });
  try {
    const c = cron(expr);
    if (!c.nextRun()) return new TriggerError("cronNever", `Cron "${expr}" never fires`, { expr });
  } catch (e: any) {
    const reason = String(e?.message ?? e).replace(/^CronPattern: /, "");
    return new TriggerError("cronInvalid", `Invalid cron expression "${expr}": ${reason}`, { expr, reason });
  }
  return undefined;
}

export function cronNext(expr: string, tz: string, after: Date): Date | null {
  try {
    return cron(expr, tz).nextRun(after);
  } catch {
    return null;
  }
}

/** Runs in a week above which counting stops: 3 a day × 7 days. */
const WEEKLY_RUNS_CAP = 3 * 7;

/**
 * How many times a day a 5-field cron fires, on average over the next week. The result is capped:
 * counting stops once a week passes WEEKLY_RUNS_CAP runs, so above the cap it only means "more than 3 a day".
 */
export function cronRunsPerDay(expr: string, tz: string, from: Date): number {
  try {
    const c = cron(expr, tz);
    const end = from.getTime() + 7 * 86_400_000;
    let n = 0;
    for (let d = c.nextRun(from); d && d.getTime() < end && n <= WEEKLY_RUNS_CAP; d = c.nextRun(d)) n++;
    return n / 7;
  } catch {
    return Infinity;
  }
}

/** Left unset, a one-time run is a report, and so is a schedule running at most 3 times a day; other kinds are checks. */
export function defaultReport(t: Pick<Trigger, "kind" | "cron">, tz: string, now: Date): boolean {
  if (t.kind === "once") return true;
  if (t.kind !== "schedule" || !t.cron) return false;
  return cronRunsPerDay(t.cron, tz, now) <= 3;
}

export function timeError(t: unknown): TriggerError | undefined {
  if (typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return undefined;
  return new TriggerError("timeFormat", `Time "${String(t)}" must be in HH:MM format, e.g. "09:30"`, { value: String(t) });
}

/** Next heartbeat slot: the earliest of the "HH:MM" times on the given weekdays, in tz. */
export function heartbeatNext(times: string[], weekdays: number[], tz: string, after: Date): Date | null {
  const days = weekdays.length ? [...new Set(weekdays)].sort().join(",") : "*";
  let best: Date | null = null;
  for (const t of times) {
    const [h, m] = t.split(":").map(Number);
    const next = cronNext(`${m} ${h} * * ${days}`, tz, after);
    if (next && (!best || next < best)) best = next;
  }
  return best;
}

/** Wall-clock parts of an instant in tz. */
export function zonedParts(d: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second"), weekday: get("weekday") };
}

export function localDate(d: Date, tz: string): string {
  const p = zonedParts(d, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "2026-10-27 09:00 (Tue)" in tz (for prompts and tool output). */
export function formatLocal(d: Date | string | undefined, tz: string): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  const p = zonedParts(date, tz);
  const wd = WEEKDAYS[new Date(Date.UTC(+p.year, +p.month - 1, +p.day)).getUTCDay()];
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} (${wd})`;
}

/** Offset of tz from UTC at instant `ms`, in milliseconds. */
function tzOffset(ms: number, tz: string): number {
  const p = zonedParts(new Date(ms), tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Parse an ISO datetime. Strings with "Z" or an offset are absolute; strings without one
 * ("2026-10-27T09:00", "2026-10-27 09:00") are wall-clock time in tz.
 */
export function parseDateTime(s: string, tz: string): Date | null {
  const str = s.trim();
  if (/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(str)) {
    const ms = Date.parse(str);
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(str);
  if (!m) return null;
  const [y, mo, d, h = "0", mi = "0", sec = "0"] = m.slice(1);
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec);
  if (Number.isNaN(guess)) return null;
  // Two passes handle DST transitions.
  let ms = guess - tzOffset(guess, tz);
  ms = guess - tzOffset(ms, tz);
  const check = zonedParts(new Date(ms), tz);
  if (+check.month !== +mo || +check.day !== +d) return null; // e.g. 2026-02-31
  return new Date(ms);
}

export function validTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Next planned firing for a trigger, or null when it has none (disabled, event, finished once). */
export function computeNextRun(t: Trigger, tz: string, now: Date): Date | null {
  if (!t.enabled) return null;
  switch (t.kind) {
    case "schedule":
      return t.cron ? cronNext(t.cron, tz, now) : null;
    case "once":
      return t.state.done || !t.at ? null : new Date(t.at);
    case "watch": {
      const last = t.state.lastCheckedAt ? Date.parse(t.state.lastCheckedAt) : NaN;
      const every = (t.intervalMinutes ?? 60) * 60_000;
      return Number.isNaN(last) ? now : new Date(Math.max(now.getTime(), last + every));
    }
    case "heartbeat":
      return heartbeatNext(t.times ?? [], t.weekdays ?? [], tz, now);
    case "event":
      return null;
  }
}

/** English description of when a trigger fires (tool output; the UI builds a localized one from the fields). */
export function describeSchedule(t: Trigger): string {
  switch (t.kind) {
    case "schedule":
      return `cron ${t.cron}`;
    case "once":
      return `once: ${t.at}`;
    case "watch":
      return `every ${t.intervalMinutes} min: ${t.url}${t.selector ? ` [${t.selector}]` : ""}${t.jsonPath ? ` {${t.jsonPath}}` : ""}`;
    case "event":
      return "webhook";
    case "heartbeat": {
      const wd = t.weekdays?.length === 5 && [1, 2, 3, 4, 5].every((d) => t.weekdays!.includes(d)) ? "weekdays" : (t.weekdays ?? []).map((d) => WEEKDAYS[d]).join(",");
      return `${wd} at ${(t.times ?? []).join(", ")}`;
    }
  }
}
