// A trigger's pipeline, top to bottom: what it listens to (its kind's own source, its subscriptions with their
// filters, a batch window), its script and quick check, then what the agent does.

import { useState, type ReactNode } from "react";
import { Bot, ChevronRight, Code, Radio, ShieldCheck, Sparkles, type LucideIcon } from "lucide-react";
import { builtinSource, configLines, describeMatch, formatAt, sourceLabel, webhookCheck, type TriggerView } from "../../lib/triggers";
import { t } from "../../i18n";
import { CopyButton, cx } from "../../components/ui";
import { Mono, Muted, Section } from "./parts";

function Step({ icon: I, title, children, last }: { icon: LucideIcon; title: string; children?: ReactNode; last?: boolean }) {
  return (
    <li className={cx("relative flex gap-3", !last && "pb-4")}>
      {!last && <span className="absolute top-8 bottom-0 left-[13px] w-px bg-border" aria-hidden />}
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted" aria-hidden>
        <I className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1 pt-1">
        <div className="text-sm font-medium">{title}</div>
        {children && <div className="mt-1 flex flex-col gap-1.5 text-sm">{children}</div>}
      </div>
    </li>
  );
}

/**
 * The webhook's address and what a delivery must carry: the address to copy, then the shared secret hidden until asked,
 * or, for a signed webhook, the signature the hub checks (its key stays in the vault).
 */
function WebhookLine({ tr }: { tr: TriggerView }) {
  const [shown, setShown] = useState(false);
  if (!tr.webhookUrl) return null;
  const check = webhookCheck(tr);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Mono>{tr.webhookUrl}</Mono>
        <CopyButton text={tr.webhookUrl} />
      </div>
      {check?.kind === "secret" && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span>{t("triggers.detail.secret")}</span>
          <Mono>{shown ? check.secret : "••••••••"}</Mono>
          <button type="button" className="rounded-lg px-2 py-1 hover:bg-surface-2 hover:text-fg" onClick={() => setShown(!shown)}>
            {shown ? t("triggers.detail.hide") : t("triggers.detail.show")}
          </button>
          <CopyButton text={check.secret} />
        </div>
      )}
      {check?.kind === "signed" && (
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{check.text}</span>
        </p>
      )}
    </div>
  );
}

/** What the trigger's kind listens to on its own: the time, the page, the webhook. */
function BuiltinSource({ tr, tz }: { tr: TriggerView; tz: string }) {
  const type = builtinSource(tr.kind);
  if (!type) return null;
  return (
    <div className="flex flex-col gap-1">
      <span>{sourceLabel(type) ?? type}</span>
      {tr.kind === "schedule" && tr.cron && <Mono>{tr.cron}</Mono>}
      {tr.kind === "heartbeat" && <Muted>{tr.whenText}</Muted>}
      {tr.kind === "once" && tr.at && <Muted>{formatAt(tr.at, tz)}</Muted>}
      {tr.kind === "watch" && tr.url && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Mono>{tr.url}</Mono>
          {tr.selector && <Mono>{tr.selector}</Mono>}
          {tr.jsonPath && <Mono>{tr.jsonPath}</Mono>}
        </div>
      )}
      {tr.kind === "event" && <WebhookLine tr={tr} />}
    </div>
  );
}

export function Pipeline({ tr, tz, agentName }: { tr: TriggerView; tz: string; agentName: string }) {
  return (
    <Section title={t("triggers.pipeline.title")}>
      <ol>
        <Step icon={Radio} title={t("triggers.pipeline.listens")}>
          <BuiltinSource tr={tr} tz={tz} />
          {tr.on.map((s, i) => {
            const label = sourceLabel(s.type);
            const config = configLines(s.config);
            const filter = describeMatch(s.where);
            return (
              <div key={`${s.type}-${i}`} className="flex flex-col gap-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  {label && <span>{label}</span>}
                  <Mono>{s.type}</Mono>
                </span>
                {config.length > 0 && <Muted>{config.join(" · ")}</Muted>}
                {filter && <Muted>{t("triggers.pipeline.filter", { filter })}</Muted>}
              </div>
            );
          })}
          {tr.batch && (
            <Muted>
              {t("triggers.pipeline.batch", { sec: tr.batch.windowSec })}
              {tr.batch.max ? ` · ${t("triggers.pipeline.batchMax", { max: tr.batch.max })}` : ""}
            </Muted>
          )}
        </Step>
        {tr.script && (
          <Step icon={Code} title={t("triggers.pipeline.script")}>
            <Muted>{t("triggers.pipeline.scriptHint")}</Muted>
            {tr.script.hosts.length ? (
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                <span>{t("triggers.pipeline.hosts")}</span>
                {tr.script.hosts.map((h) => (
                  <Mono key={h}>{h}</Mono>
                ))}
              </div>
            ) : (
              <Muted>{t("triggers.pipeline.noHosts")}</Muted>
            )}
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted select-none hover:text-fg [&::-webkit-details-marker]:hidden">
                <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                {t("triggers.pipeline.code")}
              </summary>
              <pre className="mt-1.5 max-h-80 overflow-auto rounded-xl border border-hairline bg-code-bg p-3 font-mono text-xs leading-relaxed">{tr.script.code}</pre>
            </details>
          </Step>
        )}
        {tr.triage && (
          <Step icon={Sparkles} title={t("triggers.pipeline.triage")}>
            <Muted>{t("triggers.pipeline.triageHint")}</Muted>
            <p className="rounded-xl bg-surface-2/60 px-3 py-2 text-sm whitespace-pre-wrap">{tr.triage.brief}</p>
            {tr.triagePerDay ? <Muted>{t("triggers.pipeline.triagePerDay", { n: tr.triagePerDay })}</Muted> : null}
          </Step>
        )}
        <Step icon={Bot} title={t("triggers.pipeline.does", { agent: agentName })} last>
          <p className="whitespace-pre-wrap break-words">{tr.prompt}</p>
          <Muted>{[tr.report ? t("triggers.pipeline.report") : "", t("triggers.pipeline.maxRuns", { n: tr.maxRunsPerDay })].filter(Boolean).join(" · ")}</Muted>
        </Step>
      </ol>
    </Section>
  );
}

