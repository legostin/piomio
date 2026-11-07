import { describe, expect, it } from "vitest";
import { computeNextRun, cronError, cronNext, formatLocal, heartbeatNext, localDate, parseDateTime } from "../../src/signals/schedule.ts";
import { dropSlot } from "../../src/signals/engine.ts";
import { buildTrigger } from "../../src/signals/validate.ts";
import type { Trigger } from "../../src/signals/types.ts";

const iso = (d: Date | null) => d?.toISOString();

describe("cron in the user's timezone", () => {
  it("computes the next run in a non-UTC timezone", () => {
    // 09:00 in Moscow (UTC+3, no DST) is 06:00Z.
    expect(iso(cronNext("0 9 * * *", "Europe/Moscow", new Date("2026-10-26T05:00:00Z")))).toBe("2026-10-26T06:00:00.000Z");
    expect(iso(cronNext("0 9 * * *", "Europe/Moscow", new Date("2026-10-26T06:00:00Z")))).toBe("2026-10-27T06:00:00.000Z");
    // Weekdays only, Tokyo (UTC+9): Friday 2026-10-30 after 09:00 → Monday 2026-11-02 09:00 JST = 00:00Z.
    expect(iso(cronNext("0 9 * * 1-5", "Asia/Tokyo", new Date("2026-10-30T01:00:00Z")))).toBe("2026-11-02T00:00:00.000Z");
  });

  it("follows DST transitions", () => {
    // New York leaves DST on 2026-11-01: 09:00 EDT = 13:00Z, 09:00 EST = 14:00Z.
    expect(iso(cronNext("0 9 * * *", "America/New_York", new Date("2026-10-31T12:00:00Z")))).toBe("2026-10-31T13:00:00.000Z");
    expect(iso(cronNext("0 9 * * *", "America/New_York", new Date("2026-10-31T14:00:00Z")))).toBe("2026-11-01T14:00:00.000Z");
  });

  it("explains bad cron expressions", () => {
    expect(cronError("0 9 * * 1-5")).toBeUndefined();
    expect(cronError("0 9 * *")?.message).toContain("5 fields");
    expect(cronError("0 0 9 * * *")).toMatchObject({ code: "cronFields", params: { expr: "0 0 9 * * *" } });
    expect(cronError("61 9 * * *")?.message).toMatch(/Invalid cron expression/);
    expect(cronError("")?.message).toContain("cron");
  });
});

describe("heartbeat slots", () => {
  it("picks the earliest slot on allowed weekdays", () => {
    const times = ["10:00", "18:00"];
    const wd = [1, 2, 3, 4, 5];
    // Monday 12:00 Moscow → Monday 18:00 Moscow = 15:00Z.
    expect(iso(heartbeatNext(times, wd, "Europe/Moscow", new Date("2026-10-26T09:00:00Z")))).toBe("2026-10-26T15:00:00.000Z");
    // Friday 19:00 Moscow → Monday 10:00 Moscow = 07:00Z.
    expect(iso(heartbeatNext(times, wd, "Europe/Moscow", new Date("2026-10-30T16:00:00Z")))).toBe("2026-11-02T07:00:00.000Z");
  });

  it("drops the slot that produced an unwanted notification", () => {
    // Notification at 18:05 Moscow came from the 18:00 slot.
    expect(dropSlot(["10:00", "14:00", "18:00"], "2026-10-26T15:05:00Z", "Europe/Moscow")).toEqual(["10:00", "14:00"]);
    expect(dropSlot(["10:00", "14:00", "18:00"], "2026-10-26T07:30:00Z", "Europe/Moscow")).toEqual(["14:00", "18:00"]);
    expect(dropSlot(["10:00", "18:00"], undefined, "UTC")).toEqual(["10:00"]);
  });
});

describe("local dates and ISO parsing", () => {
  it("parses wall-clock time in the user's timezone", () => {
    expect(iso(parseDateTime("2026-10-27T09:00", "Europe/Moscow"))).toBe("2026-10-27T06:00:00.000Z");
    expect(iso(parseDateTime("2026-10-27 09:30", "Asia/Tokyo"))).toBe("2026-10-27T00:30:00.000Z");
    expect(iso(parseDateTime("2026-11-01T09:00", "America/New_York"))).toBe("2026-11-01T14:00:00.000Z");
    expect(iso(parseDateTime("2026-10-27T09:00:00Z", "Asia/Tokyo"))).toBe("2026-10-27T09:00:00.000Z");
    expect(iso(parseDateTime("2026-10-27T09:00+02:00", "Asia/Tokyo"))).toBe("2026-10-27T07:00:00.000Z");
    expect(parseDateTime("tomorrow", "UTC")).toBeNull();
    expect(parseDateTime("2026-02-31T09:00", "UTC")).toBeNull();
  });

  it("formats and dates in the timezone", () => {
    expect(localDate(new Date("2026-10-26T22:30:00Z"), "Asia/Tokyo")).toBe("2026-10-27");
    expect(formatLocal("2026-10-26T22:30:00Z", "Asia/Tokyo")).toBe("2026-10-27 07:30 (Tue)");
  });

  it("computes next runs per kind", () => {
    const now = new Date("2026-10-26T05:00:00Z");
    const opts = { now, tz: "Europe/Moscow", defaultAgent: "assistant", createdBy: "test" };
    const sched = buildTrigger({ kind: "schedule", name: "s", prompt: "p", cron: "0 9 * * *" }, opts);
    expect(iso(computeNextRun(sched, "Europe/Moscow", now))).toBe("2026-10-26T06:00:00.000Z");
    const once = buildTrigger({ kind: "once", name: "o", prompt: "p", at: "2026-10-27T09:00" }, opts);
    expect(once.at).toBe("2026-10-27T06:00:00.000Z");
    expect(iso(computeNextRun(once, "Europe/Moscow", now))).toBe("2026-10-27T06:00:00.000Z");
    const watch = buildTrigger({ kind: "watch", name: "w", prompt: "p", url: "https://example.com", intervalMinutes: 15 }, opts);
    expect(iso(computeNextRun(watch, "UTC", now))).toBe(now.toISOString());
    const checked: Trigger = { ...watch, state: { lastCheckedAt: "2026-10-26T04:55:00Z" } };
    expect(iso(computeNextRun(checked, "UTC", now))).toBe("2026-10-26T05:10:00.000Z");
    const event = buildTrigger({ kind: "event", name: "e", prompt: "p" }, opts);
    expect(event.secret).toMatch(/^[\w-]{32}$/);
    expect(computeNextRun(event, "UTC", now)).toBeNull();
    expect(computeNextRun({ ...sched, enabled: false }, "UTC", now)).toBeNull();
  });

  it("validates trigger input with clear errors", () => {
    const opts = { now: new Date("2026-10-26T05:00:00Z"), tz: "UTC", defaultAgent: "assistant", createdBy: "test" };
    expect(() => buildTrigger({ kind: "once", name: "o", prompt: "p", at: "2026-10-25T09:00" }, opts)).toThrow(/already passed/);
    expect(() => buildTrigger({ kind: "watch", name: "w", prompt: "p", url: "https://e.com", intervalMinutes: 2 }, opts)).toThrow(/at least 5 minutes/);
    expect(() => buildTrigger({ kind: "watch", name: "w", prompt: "p", url: "ftp://e.com" }, opts)).toThrow(/http/);
    expect(() => buildTrigger({ kind: "watch", name: "w", prompt: "p", url: "https://e.com", jsonPath: "a..b" }, opts)).toThrow(/JSON path/);
    expect(() => buildTrigger({ kind: "heartbeat", name: "h", prompt: "p", times: ["25:00"] }, opts)).toThrow(/HH:MM/);
    expect(() => buildTrigger({ kind: "nope", name: "x", prompt: "p" }, opts)).toThrow(/Unknown trigger kind/);
    expect(() => buildTrigger({ kind: "schedule", name: "x", prompt: "" }, opts)).toThrow(/prompt/);
  });
});
