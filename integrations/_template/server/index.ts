// The integration template (integrations/_template), a complete integration to start from: sunrise, sunset and day
// length for any place from sunrise-sunset.org, no key. sun_times shows a card in the chat (widget "day") and gives
// the model the times as text. A new integration replaces the API and the card and keeps the shape: see SKILL.md.

import type { PluginContext, PluginModule } from "@piomio/plugin-sdk";
import type { ToolResult } from "@piomio/shared";

interface Settings {
  /** The API's address (tests point it at a fake). */
  apiUrl?: string;
}

/** What the "day" card draws. Times are local to the place, as "HH:MM". */
export interface DayCard {
  place: string;
  /** "today" or YYYY-MM-DD. */
  date: string;
  sunrise: string;
  sunset: string;
  dayLengthSec: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const USER_AGENT = "Piomio/0.1 (self-hosted personal agent; sun integration)";

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/** The date the API takes: YYYY-MM-DD, or "today" when none is given; undefined for anything else. */
export function dateOf(v: unknown): string | undefined {
  const d = String(v ?? "").trim().toLowerCase();
  if (!d || d === "today") return "today";
  return DATE.test(d) ? d : undefined;
}

/** "05:42" from the API's local ISO time ("2026-06-21T05:42:10+01:00"). */
export function clock(iso: string): string {
  return /T(\d{2}:\d{2})/.exec(iso)?.[1] ?? iso;
}

/** "14 h 51 min" for the model (the card says it in the reader's language). */
export function duration(sec: number): string {
  const m = Math.round(sec / 60);
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** sunrise-sunset.org's answer for a place and date: its `results`, or the error to tell the model. */
async function fetchTimes(api: string, lat: number, lon: number, date: string, timezone: string): Promise<{ r: any } | { error: string }> {
  let body: any;
  try {
    const res = await fetch(`${api}/json?lat=${lat}&lng=${lon}&date=${date}&formatted=0&tzid=${encodeURIComponent(timezone)}`, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    body = await res.json().catch(() => undefined);
    if (!res.ok) return { error: `sunrise-sunset.org: HTTP ${res.status}` };
  } catch (e: any) {
    return { error: `sunrise-sunset.org is unreachable (${e?.cause?.code ?? e?.name ?? "network error"}).` };
  }
  const r = body?.results;
  if (body?.status !== "OK" || !r?.sunrise || !r?.sunset) return { error: `sunrise-sunset.org could not answer: ${body?.status ?? "no data"}.` };
  return { r };
}

/** The calendar date (YYYY-MM-DD) of `ms` in an IANA time zone; undefined for a zone that does not exist. */
export function localDate(ms: number, timezone: string): string | undefined {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  } catch {
    return undefined;
  }
}

/** The day after a YYYY-MM-DD date. */
export function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

const RETRY_MS = 30 * 60_000;
/** setTimeout cannot wait longer than this. */
const MAX_WAIT_MS = 2 ** 31 - 1;

const plugin: PluginModule = {
  activate(ctx: PluginContext) {
    let settings: Settings = ctx.settings ?? {};
    ctx.onSettingsChange((s) => (settings = s ?? {}));
    const api = () => (settings.apiUrl || "https://api.sunrise-sunset.org").replace(/\/+$/, "");

    // A subscribe-mode signal source (contributes.signals): it works only while a trigger listens to "sun.sunrise" for a
    // place, and says "the sun rose" once a day. The hub calls subscribe when a trigger starts listening and stop when
    // none does; `emit` sends the signal. See SKILL.md, "Signals".
    ctx.signals.provide("sunrise", {
      subscribe(sub, emit) {
        const lat = Number(sub.config.lat);
        const lon = Number(sub.config.lon);
        const timezone = String(sub.config.timezone ?? "UTC");
        const place = String(sub.config.place ?? "").trim() || `${lat}, ${lon}`;
        // Refuse what cannot work, with a reason the hub shows in the plugin's log (it tries again later).
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("sunrise: lat and lon must be numbers");
        const today = localDate(Date.now(), timezone);
        if (!today) throw new Error(`sunrise: "${timezone}" is not an IANA time zone (e.g. Europe/Lisbon)`);
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const wait = (ms: number, then: () => void) => {
          timer = setTimeout(then, Math.min(ms, MAX_WAIT_MS));
        };
        // Every step runs through here: whatever goes wrong is told to the log and tried again later, never left as an
        // unhandled rejection.
        const go = (date: string): void => {
          void next(date).catch((e) => {
            ctx.log.warn(`sunrise for ${place}: ${e instanceof Error ? e.message : String(e)}. Trying again later.`);
            if (!stopped) wait(RETRY_MS, () => go(date));
          });
        };

        // Looks the day's sunrise up and waits for it; then emits and goes on to the next day. A day whose sunrise
        // has passed is skipped, so a restart at noon does not announce the morning. A day with no sunrise (a polar
        // night or day) waits a while before the next day is asked about, so the service is not asked again at once.
        const next = async (date: string): Promise<void> => {
          if (stopped) return;
          const got = await fetchTimes(api(), lat, lon, date, timezone);
          if (stopped) return;
          if ("error" in got) {
            ctx.log.warn(`sunrise for ${place}: ${got.error} Trying again later.`);
            return wait(RETRY_MS, () => go(date));
          }
          const at = Date.parse(got.r.sunrise);
          if (!Number.isFinite(at)) return wait(RETRY_MS, () => go(date));
          if (localDate(at, timezone) !== date) {
            ctx.log.info(`sunrise: no sunrise in ${place} on ${date}; asking about the next day later.`);
            return wait(RETRY_MS, () => go(nextDay(date)));
          }
          if (at <= Date.now()) return go(nextDay(date));
          const sleep = (): void => {
            if (stopped) return;
            const left = at - Date.now();
            if (left > 0) return wait(left, sleep);
            emit({ place, date, sunrise: clock(got.r.sunrise) }, { key: date, subject: place });
            go(nextDay(date));
          };
          sleep();
        };
        go(today);
        return {
          stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
          },
        };
      },
    });

    ctx.tools.register({
      name: "times",
      effect: "read",
      source: true,
      description:
        "Sunrise, sunset and day length for a place and date, shown to the user as a card in the chat. " +
        "Give the place's coordinates (`lat`, `lon`) and its IANA time zone (`timezone`, e.g. Europe/Lisbon) so the times are local; " +
        "`date` is YYYY-MM-DD (default: today). Then answer briefly: the card shows the times.",
      inputSchema: {
        type: "object",
        properties: {
          place: { type: "string", description: "The place's name, as the user would say it" },
          lat: { type: "number", description: "Latitude in degrees" },
          lon: { type: "number", description: "Longitude in degrees" },
          timezone: { type: "string", description: "IANA time zone of the place, e.g. Europe/Lisbon" },
          date: { type: "string", description: "YYYY-MM-DD (default: today)" },
        },
        required: ["place", "lat", "lon", "timezone"],
      },
      handler: async (input, call) => {
        const lat = Number(input.lat);
        const lon = Number(input.lon);
        if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) return text("lat and lon must be coordinates in degrees.", true);
        const date = dateOf(input.date);
        if (!date) return text("date must be YYYY-MM-DD.", true);
        const timezone = String(input.timezone ?? "").trim() || "UTC";
        const place = String(input.place ?? "").trim() || `${lat}, ${lon}`;

        const got = await fetchTimes(api(), lat, lon, date, timezone);
        if ("error" in got) return text(got.error, true);
        const { r } = got;

        const card: DayCard = { place, date, sunrise: clock(r.sunrise), sunset: clock(r.sunset), dayLengthSec: Number(r.day_length) || 0 };
        ctx.widgets.show(call, "day", card);
        return text(
          `${place}, ${date} (${timezone}): sunrise ${card.sunrise}, sunset ${card.sunset}, day length ${duration(card.dayLengthSec)}. ` +
            "A card with these times is shown in the chat: answer in a sentence, without repeating it.",
        );
      },
    });
  },
};

export default plugin;
