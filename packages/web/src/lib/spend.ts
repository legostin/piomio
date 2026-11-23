// Figures of Settings → Spend (pages/Spend.tsx): dollars at API prices and token counts as people read them.

import type { SpendReport, SpendTotals } from "@piomio/shared";

/** "$6.12", "<$0.01", "$0". */
export function formatUsd(n: number): string {
  if (n >= 0.005) return `$${n.toFixed(2)}`;
  return n > 0 ? "<$0.01" : "$0";
}

/** "2.0M", "940k", "312". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

/** Every token a total counts. */
export const allTokens = (x: SpendTotals): number => x.input + x.cacheRead + x.cacheWrite + x.output;

/** All of the dollars came from list prices, none from the brain itself. */
export const onlyEstimated = (x: SpendTotals): boolean => x.usd > 0 && Math.abs(x.usd - x.estimatedUsd) < 1e-9;

/** A report the page can show; anything else (an older hub, a stand-in answer) counts as nothing spent. */
export function asReport(v: unknown): SpendReport | undefined {
  const r = v as SpendReport | undefined;
  return r && typeof r === "object" && r.total && typeof r.total.usd === "number" && Array.isArray(r.threads) && Array.isArray(r.agents) && Array.isArray(r.models) ? r : undefined;
}
