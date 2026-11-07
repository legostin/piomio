// When a trigger runs, in words, with core's catalogs.

import { describe, expect, it } from "vitest";
import { format, type Locale } from "@piomio/shared";
import { coreCatalog } from "../../src/i18n.ts";
import type { Trigger } from "../../src/signals/types.ts";
import { cronText, whenText } from "../../src/signals/when.ts";

const catalog = (l: Locale) => coreCatalog[l] as Record<string, string>;
const tr = (l: Locale) => {
  const c = catalog(l);
  return (key: string, params?: Record<string, string | number>) => format(c[`triggers.${key}`] ?? key, params, l);
};

describe("when a trigger runs, in words", () => {
  it("reads the usual crons", () => {
    const en = (cron: string) => cronText(cron, tr("en"), "en");
    expect(en("0 * * * *")).toBe("every hour");
    expect(en("15 * * * *")).toBe("every hour at :15");
    expect(en("*/30 * * * *")).toBe("every 30 minutes");
    expect(en("0 9 * * *")).toBe("every day at 09:00");
    expect(en("30 8 * * 1-5")).toBe("weekdays at 08:30");
    expect(en("0 9,18 * * 0,6")).toBe("weekends at 09:00, 18:00");
    expect(en("0 10 * * 1,3")).toBe("Mon, Wed at 10:00");
    expect(en("0 9 1 * *")).toBe("cron 0 9 1 * *");
  });

  it("in Russian too", () => {
    const ru = (cron: string) => cronText(cron, tr("ru"), "ru");
    expect(ru("0 * * * *")).toBe("каждый час");
    expect(ru("*/5 * * * *")).toBe("каждые 5 минут");
    expect(ru("0 8 * * *")).toBe("каждый день в 08:00");
    expect(ru("0 9 * * 1-5")).toBe("по будням в 09:00");
  });

  it("describes every kind", () => {
    const t = (over: Partial<Trigger>) => ({ id: "t", name: "n", prompt: "p", agentId: "a", enabled: true, maxRunsPerDay: 24, createdAt: "", updatedAt: "", createdBy: "user", state: {}, ...over }) as Trigger;
    const en = (x: Trigger) => whenText(x, tr("en"), "en", "Asia/Almaty");
    expect(en(t({ kind: "heartbeat", times: ["10:00", "18:00"], weekdays: [1, 2, 3, 4, 5] }))).toBe("weekdays at 10:00, 18:00");
    expect(en(t({ kind: "once", at: "2026-10-30T04:00:00.000Z" }))).toMatch(/^once, Oct 30, 2026.+9:00/);
    expect(en(t({ kind: "watch", url: "https://e.com/", intervalMinutes: 60 }))).toBe("every 60 min: https://e.com/");
    expect(en(t({ kind: "event" }))).toBe("on a webhook");
  });
});
