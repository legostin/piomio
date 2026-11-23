import { describe, expect, it } from "vitest";
import { asReport, formatTokens, formatUsd, onlyEstimated } from "./spend";

const zero = { usd: 0, estimatedUsd: 0, turns: 0, unpriced: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

describe("Settings → Spend figures", () => {
  it("writes dollars and tokens as people read them", () => {
    expect(formatUsd(6.123)).toBe("$6.12");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0)).toBe("$0");
    expect(formatTokens(1_960_000)).toBe("2.0M");
    expect(formatTokens(940_400)).toBe("940k");
    expect(formatTokens(312)).toBe("312");
  });

  it("tells dollars that all came from list prices", () => {
    expect(onlyEstimated({ ...zero, usd: 0.4, estimatedUsd: 0.4 })).toBe(true);
    expect(onlyEstimated({ ...zero, usd: 1.4, estimatedUsd: 0.4 })).toBe(false);
    expect(onlyEstimated(zero)).toBe(false);
  });

  it("takes only a real report", () => {
    expect(asReport({ items: [], more: false })).toBeUndefined();
    expect(asReport(null)).toBeUndefined();
    const r = { period: "today", since: "", timezone: "UTC", total: zero, threads: [], moreThreads: 0, agents: [], models: [] };
    expect(asReport(r)).toBe(r);
  });
});
