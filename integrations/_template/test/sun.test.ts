// The integration template against a fake sunrise-sunset.org: the card and the model's text, local times, and the
// errors a model can cause (bad coordinates or date) or meet (the service says no).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { startPlugin, type PluginHarness } from "@piomio/testkit";
import { readFileSync } from "node:fs";
import { clock, dateOf, duration, localDate, nextDay, type DayCard } from "../server/index.ts";

const dir = join(import.meta.dirname, "..");

function fakeApi() {
  const requests: URL[] = [];
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    requests.push(u);
    const send = (status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (u.pathname !== "/json") return send(404, {});
    if (u.searchParams.get("lat") === "0") return send(200, { status: "INVALID_REQUEST", results: "" });
    send(200, { status: "OK", results: { sunrise: "2026-06-21T06:12:40+01:00", sunset: "2026-06-21T21:05:02+01:00", day_length: 53542 } });
  });
  return { server, requests };
}

describe("the integration template", () => {
  let api: ReturnType<typeof fakeApi>;
  let h: PluginHarness;

  beforeAll(async () => {
    api = fakeApi();
    await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
    h = await startPlugin({ dir, settings: { apiUrl: `http://127.0.0.1:${(api.server.address() as any).port}` } });
  });

  afterAll(async () => {
    await h?.stop();
    api?.server.close();
  });

  it("reads dates, local times and lengths", () => {
    expect(dateOf(undefined)).toBe("today");
    expect(dateOf("2026-06-21")).toBe("2026-06-21");
    expect(dateOf("next friday")).toBeUndefined();
    expect(clock("2026-06-21T06:12:40+01:00")).toBe("06:12");
    expect(duration(53542)).toBe("14 h 52 min");
  });

  it("shows the card and gives the model the local times", async () => {
    const r = await h.invoke("times", { place: "Lisbon", lat: 38.72, lon: -9.14, timezone: "Europe/Lisbon", date: "2026-06-21" }, { callId: "c1" });
    expect(r.isError).toBeFalsy();
    expect(r._meta!.widgets![0]).toMatchObject({ kind: "day", data: { place: "Lisbon", date: "2026-06-21", sunrise: "06:12", sunset: "21:05", dayLengthSec: 53542 } satisfies DayCard });
    expect(r.content.map((c: any) => c.text).join("")).toContain("Lisbon, 2026-06-21 (Europe/Lisbon): sunrise 06:12, sunset 21:05, day length 14 h 52 min.");
    const q = api.requests.at(-1)!.searchParams;
    expect([q.get("lng"), q.get("formatted"), q.get("tzid")]).toEqual(["-9.14", "0", "Europe/Lisbon"]);
  });

  it("explains what went wrong instead of showing a card", async () => {
    expect((await h.invoke("times", { place: "X", lat: 200, lon: 0, timezone: "UTC" })).isError).toBe(true);
    expect((await h.invoke("times", { place: "X", lat: 1, lon: 1, timezone: "UTC", date: "soon" })).isError).toBe(true);
    const r = await h.invoke("times", { place: "Null Island", lat: 0, lon: 0, timezone: "UTC" }, { callId: "c2" });
    expect(r.isError).toBe(true);
    expect(r._meta?.widgets).toBeUndefined();
    expect(r.content.map((c: any) => c.text).join("")).toContain("INVALID_REQUEST");
  });
});

describe("the sunrise signal source", () => {
  let server: Server;
  let h: PluginHarness;
  const asked: URL[] = [];
  const iso = (ms: number) => new Date(ms).toISOString();

  beforeAll(async () => {
    server = createServer((req, res) => {
      const u = new URL(req.url!, "http://x");
      asked.push(u);
      // The first day asked for has its sunrise in a moment; every later one is tomorrow.
      const at = asked.length === 1 ? Date.now() + 300 : Date.now() + 20 * 3_600_000;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "OK", results: { sunrise: iso(at), sunset: iso(at + 3_600_000), day_length: 3600 } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    h = await startPlugin({ dir, settings: { apiUrl: `http://127.0.0.1:${(server.address() as any).port}` } });
  });

  afterAll(async () => {
    await h?.stop();
    server?.close();
  });

  it("is declared as a subscribe source", () => {
    expect(JSON.parse(readFileSync(join(dir, ".piomio-plugin", "plugin.json"), "utf8")).contributes.signals[0]).toMatchObject({ type: "sunrise", mode: "subscribe" });
  });

  it("emits once at sunrise for the configured place, keyed by the date, then waits for the next day", async () => {
    const id = await h.subscribeSignal("sunrise", { place: "Lisbon", lat: 38.72, lon: -9.14, timezone: "Europe/Lisbon" });
    const end = Date.now() + 5000;
    while (!h.signals.length && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(h.signals).toHaveLength(1);
    const s = h.signals[0] as any;
    expect(s).toMatchObject({ type: "sunrise", subject: "Lisbon", data: { place: "Lisbon" } });
    expect(s.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.key).toBe(s.data.date);
    expect(asked[0].searchParams.get("tzid")).toBe("Europe/Lisbon");
    await new Promise((r) => setTimeout(r, 200));
    expect(h.signals).toHaveLength(1);
    // The next day was asked for the day after the first.
    expect(asked.at(-1)!.searchParams.get("date")).toBe(nextDay(s.key));
    await h.stopSignal(id);
  });

  it("works out dates in the place's time zone", () => {
    expect(localDate(Date.parse("2026-06-21T23:30:00Z"), "Europe/Lisbon")).toBe("2026-06-22");
    expect(localDate(Date.parse("2026-06-21T23:30:00Z"), "Not/AZone")).toBeUndefined();
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });
});
