// Spend: what each conversation and task spent, at API prices, with its models, efforts, cache split and context now
// (GET /api/spend; docs/superpowers/specs/2026-11-23-thread-spend-design.md). The chat answers the same
// (hub_usage_report): "Ask in chat" sends the question to the default agent.

import { useEffect, useState } from "react";
import { Link } from "wouter";
import { MessageCircleMore } from "lucide-react";
import type { SpendPeriod, SpendReport, SpendThread, SpendTotals } from "@piomio/shared";
import { modelLabel } from "@piomio/shared/models";
import { api, errorText } from "../lib/api";
import { relativeTime } from "../lib/format";
import { allTokens, asReport, formatTokens, formatUsd, onlyEstimated } from "../lib/spend";
import { useStore } from "../lib/store";
import { agents, ensureAgents } from "../state/app";
import { useAsk } from "../state/ask";
import { effortName } from "../state/thinking";
import { t, type MessageKey } from "../i18n";
import { AgentAvatar } from "../components/AgentAvatar";
import { Badge, Button, cx, EmptyState, ErrorNote, Loading, Page, Segmented } from "../components/ui";

const PERIODS: Array<{ value: SpendPeriod; label: MessageKey; ask: MessageKey }> = [
  { value: "today", label: "spend.period.today", ask: "spend.ask.today" },
  { value: "7d", label: "spend.period.week", ask: "spend.ask.week" },
  { value: "30d", label: "spend.period.month", ask: "spend.ask.month" },
];

/** The token kinds, in the order of the bar: what the cache gave, what it took, fresh input, output. */
const PARTS: Array<{ key: "cacheRead" | "cacheWrite" | "input" | "output"; label: MessageKey; color: string }> = [
  { key: "cacheRead", label: "spend.tokens.cacheRead", color: "bg-info/60" },
  { key: "cacheWrite", label: "spend.tokens.cacheWrite", color: "bg-warning" },
  { key: "input", label: "spend.tokens.input", color: "bg-accent" },
  { key: "output", label: "spend.tokens.output", color: "bg-success" },
];

export function SpendPage() {
  const [period, setPeriod] = useState<SpendPeriod>("today");
  const [report, setReport] = useState<SpendReport | null>();
  const [error, setError] = useState<string>();
  const ask = useAsk();

  const load = (p: SpendPeriod) => {
    setError(undefined);
    api.get<unknown>(`/api/spend?period=${p}`).then(
      (r) => setReport(asReport(r) ?? null),
      (e) => setError(errorText(e)),
    );
  };
  useEffect(() => {
    ensureAgents();
  }, []);
  useEffect(() => {
    setReport(undefined);
    load(period);
  }, [period]);

  const askText = t(PERIODS.find((p) => p.value === period)!.ask);
  return (
    <Page
      title={t("nav.spend")}
      subtitle={t("spend.subtitle")}
      actions={
        <Button icon={<MessageCircleMore className="size-4" />} onClick={() => ask(askText)}>
          {t("spend.askButton")}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <Segmented value={period} onChange={setPeriod} options={PERIODS.map((p) => ({ value: p.value, label: t(p.label) }))} className="self-start" />
        {error && <ErrorNote onRetry={() => load(period)}>{error}</ErrorNote>}
        {report === undefined && !error && <Loading />}
        {report === null && !error && <EmptyState icon="chart-bar" title={t("spend.empty")} hint={t("spend.caveat")} />}
        {report && (report.total.turns === 0 ? <EmptyState icon="chart-bar" title={t("spend.empty")} hint={t("spend.caveat")} /> : <Report report={report} />)}
      </div>
    </Page>
  );
}

function Report({ report }: { report: SpendReport }) {
  const list = useStore(agents);
  // The hub's own quick model speaks as "auto-review" (auto mode) or "bare-ask" (triggers, summaries): no agent of the team.
  const nameOf = (id: string) => list?.find((a) => a.id === id)?.name ?? (id === "auto-review" ? t("spend.hub.review") : id === "bare-ask" ? t("spend.hub.quick") : id);
  return (
    <>
      <section className="rounded-2xl border border-hairline bg-surface p-4 shadow-card">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-display text-3xl font-semibold tabular-nums">{money(report.total)}</span>
          <span className="text-sm text-muted">{t("spend.turns", { n: report.total.turns })}</span>
        </div>
        <Breakdown totals={report.total} />
        <p className="mt-3 text-xs leading-relaxed text-muted">{t("spend.caveat")}</p>
        {(report.total.estimatedUsd > 0 || report.total.unpriced > 0) && (
          <p className="mt-1 text-xs leading-relaxed text-muted">
            {[report.total.estimatedUsd > 0 ? t("spend.estimatedPart", { usd: formatUsd(report.total.estimatedUsd) }) : "", report.total.unpriced > 0 ? t("spend.unpriced", { n: report.total.unpriced }) : ""].filter(Boolean).join(" ")}
          </p>
        )}
      </section>

      <section>
        <div className="px-1 pb-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">{t("spend.threads")}</div>
        <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-card">
          {report.threads.map((th, i) => (
            <ThreadRow key={th.id} th={th} first={i === 0} agentName={nameOf(th.agentId)} avatar={list?.find((a) => a.id === th.agentId)?.avatar} />
          ))}
        </div>
        {report.moreThreads > 0 && <p className="mt-2 px-1 text-xs text-muted">{t("spend.more", { n: report.moreThreads })}</p>}
      </section>

      <details className="rounded-2xl border border-hairline bg-surface px-4 py-3 shadow-card">
        <summary className="cursor-pointer text-sm font-medium">{t("spend.byAgentAndModel")}</summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Totals title={t("spend.byAgent")} rows={report.agents.map((a) => ({ key: a.agentId, label: nameOf(a.agentId), totals: a }))} />
          <Totals title={t("spend.byModel")} rows={report.models.map((m) => ({ key: m.model, label: m.model === "unknown" ? t("spend.modelUnknown") : modelLabel(m.model), totals: m }))} />
        </div>
      </details>
    </>
  );
}

/** "$6.12", "≈ $0.40" when it all came from list prices, "—" when nothing had a price. */
function money(x: SpendTotals): string {
  if (x.usd === 0 && x.unpriced === x.turns && x.turns > 0) return "—";
  return onlyEstimated(x) ? `≈ ${formatUsd(x.usd)}` : formatUsd(x.usd);
}

/** The tokens by kind: a bar and its legend. */
function Breakdown({ totals }: { totals: SpendTotals }) {
  const sum = allTokens(totals) || 1;
  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
        {PARTS.map((p) => (totals[p.key] ? <span key={p.key} className={p.color} style={{ width: `${(totals[p.key] / sum) * 100}%` }} /> : null))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {PARTS.map((p) => (
          <span key={p.key} className="inline-flex items-center gap-1.5">
            <span className={cx("size-2 rounded-full", p.color)} />
            {t(p.label)} <span className="font-medium text-fg tabular-nums">{formatTokens(totals[p.key])}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function threadTitle(th: SpendThread, agentName: string): string {
  if (th.kind === "dialog") return t("spend.dialogWith", { name: agentName });
  if (th.kind === "hub") return t(th.purpose === "auto-review" ? "spend.hub.review" : "spend.hub.quick");
  return th.title;
}

function ThreadRow({ th, first, agentName, avatar }: { th: SpendThread; first: boolean; agentName: string; avatar?: Parameters<typeof AgentAvatar>[0]["avatar"] }) {
  const href = th.kind === "task" && th.taskId ? `/tasks/${encodeURIComponent(th.taskId)}` : th.conversationId ? `/chat/${encodeURIComponent(th.conversationId)}` : undefined;
  const details = [
    t("spend.line.cacheRead", { n: formatTokens(th.cacheRead) }),
    t("spend.line.cacheWrite", { n: formatTokens(th.cacheWrite) }),
    t("spend.line.output", { n: formatTokens(th.output) }),
    ...(th.contextTokens !== undefined ? [t("spend.line.context", { n: formatTokens(th.contextTokens) })] : []),
  ].join(" · ");
  const body = (
    <>
      {!first && <span className="absolute top-0 right-0 left-[60px] h-px bg-border" aria-hidden />}
      <AgentAvatar avatar={avatar} id={th.agentId} name={agentName} size={30} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-[14.5px] font-medium">{threadTitle(th, agentName)}</span>
          {th.kind === "task" && <Badge>{t("spend.kind.task")}</Badge>}
          {th.kind === "group" && <Badge>{t("spend.kind.group")}</Badge>}
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {th.models.map((m) => (
            <span key={`${m.model} ${m.effort ?? ""}`} className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted" title={formatUsd(m.usd)}>
              {m.model === "unknown" ? t("spend.modelUnknown") : m.effort ? t("thinking.modelEffort", { model: modelLabel(m.model), effort: effortName(m.effort) }) : modelLabel(m.model)}
            </span>
          ))}
        </div>
        <div className="mt-1 text-xs text-muted">
          {details} · {relativeTime(th.lastAt)}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-[14.5px] font-semibold tabular-nums">{money(th)}</div>
        <div className="text-xs text-muted">{t("spend.turns", { n: th.turns })}</div>
      </div>
    </>
  );
  const cls = "group relative flex items-start gap-3 px-4 py-3";
  return href ? (
    <Link href={href} className={cx(cls, "transition-colors hover:bg-surface-2/60")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function Totals({ title, rows }: { title: string; rows: Array<{ key: string; label: string; totals: SpendTotals }> }) {
  return (
    <div>
      <div className="pb-1 text-xs font-semibold text-muted">{title}</div>
      <div className="flex flex-col">
        {rows.map((r) => (
          <div key={r.key} className="flex items-baseline gap-2 border-t border-hairline py-1.5 text-sm first:border-t-0">
            <span className="min-w-0 flex-1 truncate">{r.label}</span>
            <span className="text-xs text-muted">{t("spend.turns", { n: r.totals.turns })}</span>
            <span className="w-16 text-right font-medium tabular-nums">{money(r.totals)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
