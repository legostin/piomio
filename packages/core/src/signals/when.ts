// When a trigger runs, in words for people (the triggers page, the phone), in the reader's language. The model reads
// the plain cron instead (schedule.ts describeSchedule).

import type { ErrorParams } from "./errors.ts";
import type { Trigger } from "./types.ts";

type Translate = (key: string, params?: ErrorParams) => string;

const pad = (n: string | number) => String(n).padStart(2, "0");

/** A short weekday name in `locale` (0 = Sunday); 2026-10-25 is a Sunday. */
const weekday = (d: number, locale: string) => new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(Date.UTC(2026, 9, 25 + d, 12));

/** Weekdays in words: every day, weekdays, weekends, or their names Monday first. */
function days(list: number[], tr: Translate, locale: string): string {
  const set = [...new Set(list)].sort();
  if (set.length === 7) return tr("when.everyDay");
  if (set.length === 5 && [1, 2, 3, 4, 5].every((d) => set.includes(d))) return tr("when.weekdays");
  if (set.length === 2 && set.includes(0) && set.includes(6)) return tr("when.weekends");
  return [...set.filter((d) => d !== 0), ...set.filter((d) => d === 0)].map((d) => weekday(d, locale)).join(", ");
}

/** A cron weekday field ("*", "1-5", "1,3,5", "0-6", 7 = Sunday) as weekdays, or undefined for anything else. */
function cronDays(field: string): number[] | undefined {
  if (field === "*") return [0, 1, 2, 3, 4, 5, 6];
  const out: number[] = [];
  for (const part of field.split(",")) {
    const m = /^(\d)(?:-(\d))?$/.exec(part);
    if (!m) return undefined;
    const [from, to] = [Number(m[1]), Number(m[2] ?? m[1])];
    if (from > to || to > 7) return undefined;
    for (let d = from; d <= to; d++) out.push(d % 7);
  }
  return out;
}

/** A cron in words for the usual shapes (every N minutes, hourly, at times on some days); the expression otherwise. */
export function cronText(cron: string, tr: Translate, locale: string): string {
  const [min, hour, dom, mon, dow] = cron.trim().split(/\s+/);
  if (dom === "*" && mon === "*") {
    const step = /^\*\/(\d+)$/.exec(min);
    if (step && hour === "*" && dow === "*") return tr("when.everyMinutes", { n: Number(step[1]) });
    if (/^\d{1,2}$/.test(min) && hour === "*" && dow === "*") return Number(min) === 0 ? tr("when.hourly") : tr("when.hourlyAt", { minute: pad(min) });
    const weekdays = cronDays(dow);
    if (/^\d{1,2}$/.test(min) && /^\d{1,2}(,\d{1,2})*$/.test(hour) && weekdays) {
      const times = hour
        .split(",")
        .map((h) => `${pad(h)}:${pad(min)}`)
        .join(", ");
      return tr("when.daysAt", { days: days(weekdays, tr, locale), times });
    }
  }
  return tr("when.cron", { cron });
}

/** When `t` runs, for a person reading in `locale`. */
export function whenText(t: Trigger, tr: Translate, locale: string, tz: string): string {
  switch (t.kind) {
    case "schedule":
      return cronText(t.cron ?? "", tr, locale);
    case "once":
      return tr("when.once", { at: t.at ? new Intl.DateTimeFormat(locale, { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(new Date(t.at)) : "" });
    case "watch":
      return tr("when.watch", { n: t.intervalMinutes ?? 60, target: `${t.url}${t.selector ? ` [${t.selector}]` : ""}${t.jsonPath ? ` {${t.jsonPath}}` : ""}` });
    case "event":
      return tr("when.webhook");
    case "heartbeat":
      return tr("when.daysAt", { days: days(t.weekdays ?? [], tr, locale), times: (t.times ?? []).join(", ") });
  }
}
