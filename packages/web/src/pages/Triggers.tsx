// Triggers: when agents act on their own. The list shows each trigger's name, when it runs and how it last went; a
// trigger's own page shows its pipeline (what it listens to, its filter, its script and quick check, what the agent
// then does) and its journal, each run open to its stages. Made and changed in the chat (CLAUDE.md, "Interface"):
// "New trigger" and "Change in the chat" open the agent's dialog with a short request; the form is the second way.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  AlarmClock,
  Bot,
  CalendarClock,
  ChevronRight,
  Code,
  Eye,
  HeartPulse,
  MessageCircleMore,
  Pencil,
  Play,
  Radio,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Trash2,
  TriangleAlert,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { api, errorText } from "../lib/api";
import { relativeTime, taskStatus } from "../lib/format";
import { useStore } from "../lib/store";
import {
  builtinSource,
  changedTrigger,
  checkText,
  configLines,
  describeMatch,
  errorMessage,
  formatAt,
  FORM_KINDS,
  KIND_HINT,
  KIND_LABEL,
  parseTimes,
  reasonText,
  runBadge,
  runNowText,
  sourceLabel,
  stageLines,
  statusBadge,
  toLocalInput,
  triggerUrl,
  TRIGGERS_API,
  WEEKDAY_ORDER,
  weekdayName,
  type TriggerKind,
  type TriggerRun,
  type TriggersList,
  type TriggerView,
} from "../lib/triggers";
import { hubEvents } from "../state/app";
import { askInChat } from "../state/ask";
import { closePanel, openPanelItem, panel, panelBack } from "../state/panel";
import { toast } from "../state/toast";
import { t } from "../i18n";
import { Badge, Button, CopyButton, cx, EmptyState, ErrorNote, Field, Input, Loading, Modal, Page, Select, Spinner, Textarea, Toggle } from "../components/ui";

const KIND_ICON: Record<TriggerKind, LucideIcon> = {
  schedule: CalendarClock,
  once: AlarmClock,
  watch: Eye,
  event: Webhook,
  heartbeat: HeartPulse,
  signal: Radio,
};

/** The list the hub answers, kept fresh: the engine says "changed" whenever a trigger or its journal does. */
function useTriggerList() {
  const [data, setData] = useState<TriggersList | null>(null);
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    api.get<TriggersList>(TRIGGERS_API).then(
      (r) => {
        setData(r);
        setError(undefined);
      },
      (e) => setError(errorText(e)),
    );
  }, []);
  useEffect(() => {
    load();
    return hubEvents.on((e) => {
      if (changedTrigger(e) !== undefined) load();
    });
  }, [load]);
  return { data, error, load };
}

/** Opens an agent's dialog (the default agent's without one) with `text` as the person's words; the panel steps aside where it covers the chat. */
function useAsk() {
  const [, navigate] = useLocation();
  return (agentId: string | undefined, text: string) => {
    if (window.matchMedia("(max-width: 1279px)").matches) closePanel();
    askInChat(agentId, text, navigate).catch((e) => toast(errorText(e), "error"));
  };
}

export function TriggersPage() {
  const p = useStore(panel);
  const list = useTriggerList();
  return p.item ? <TriggerPage key={p.item} id={p.item} {...list} /> : <TriggerList {...list} />;
}

type ListProps = ReturnType<typeof useTriggerList>;

// ---------- the list ----------

function KindMark({ kind, size = "md" }: { kind: TriggerKind; size?: "md" | "lg" }) {
  const I = KIND_ICON[kind] ?? AlarmClock;
  return (
    <span className={cx("flex shrink-0 items-center justify-center bg-accent-soft text-accent-text", size === "lg" ? "size-14 rounded-2xl" : "size-[30px] rounded-full")} aria-hidden>
      <I className={size === "lg" ? "size-7" : "size-4"} />
    </span>
  );
}

function TriggerList({ data, error, load }: ListProps) {
  const ask = useAsk();
  const [form, setForm] = useState(false);
  return (
    <Page
      title={t("nav.triggers")}
      subtitle={data ? t("triggers.subtitle", { tz: data.timezone }) : undefined}
      actions={
        <>
          <Button variant="primary" icon={<MessageCircleMore className="size-4" />} onClick={() => ask(undefined, t("triggers.ask.new"))}>
            {t("triggers.new")}
          </Button>
          <Button variant="ghost" size="sm" disabled={!data} onClick={() => setForm(true)}>
            {t("triggers.useForm")}
          </Button>
        </>
      }
    >
      {error && <ErrorNote onRetry={load}>{t("triggers.loadFailed", { error })}</ErrorNote>}
      {!data && !error && <Loading />}
      {data && data.triggers.length === 0 && <EmptyState icon="alarm-clock" title={t("triggers.empty.title")} hint={t("triggers.empty.hint")} />}
      {data && data.triggers.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-card">
          {data.triggers.map((tr, i) => {
            const badge = statusBadge(tr);
            const last = tr.state.lastRunAt ? t("triggers.list.last", { time: relativeTime(tr.state.lastRunAt) }) : t("triggers.list.never");
            return (
              <button
                key={tr.id}
                type="button"
                onClick={() => openPanelItem("triggers", tr.id)}
                className={cx("group relative flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2/60", !tr.enabled && "opacity-60")}
              >
                {i > 0 && <span className="absolute top-0 right-0 left-[58px] h-px bg-border" aria-hidden />}
                <KindMark kind={tr.kind} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{tr.name}</div>
                  <div className="mt-0.5 truncate text-xs text-muted">{[tr.whenText, last].filter(Boolean).join(" · ")}</div>
                </div>
                {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
                <ChevronRight className="size-4 shrink-0 text-muted/60 transition-transform group-hover:translate-x-0.5" />
              </button>
            );
          })}
        </div>
      )}
      {form && data && <TriggerForm initial={null} list={data} onClose={() => setForm(false)} onSaved={load} />}
    </Page>
  );
}

// ---------- a trigger's page ----------

function TriggerPage({ id, data, error, load }: ListProps & { id: string }) {
  if (error && !data)
    return (
      <div className="px-4 py-4 sm:px-5">
        <ErrorNote onRetry={load}>{t("triggers.loadFailed", { error })}</ErrorNote>
      </div>
    );
  if (!data) return <Loading />;
  const tr = data.triggers.find((x) => x.id === id);
  if (!tr)
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-8">
        <EmptyState icon="alarm-clock" title={t("triggers.gone")} />
        <Button size="sm" onClick={panelBack}>
          {t("common.back")}
        </Button>
      </div>
    );
  return <TriggerDetail tr={tr} list={data} reload={load} />;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-3.5">
      <h4 className="mb-2.5 text-[11px] font-semibold tracking-wide text-muted uppercase">{title}</h4>
      {children}
    </section>
  );
}

/** A label and its value, one row of a two-column list. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function TriggerDetail({ tr, list, reload }: { tr: TriggerView; list: TriggersList; reload: () => void }) {
  const ask = useAsk();
  const tz = list.timezone;
  const [busy, setBusy] = useState<"enabled" | "run" | "check" | "delete">();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const agent = list.agents.find((a) => a.id === tr.agentId);
  const agentName = agent?.name ?? tr.agentId;
  const badge = statusBadge(tr) ?? { label: t("triggers.status.active"), tone: "success" as const };
  // The engine's and the check's own words (an error with no code) are shown as written, labelled.
  const lastError = tr.lastErrorText ? (tr.state.lastErrorCode ? tr.lastErrorText : t("triggers.run.asWritten", { text: tr.lastErrorText })) : "";
  const waits = tr.kind === "event" || tr.kind === "signal";

  const act = async <T,>(key: NonNullable<typeof busy>, fn: () => Promise<T>, done?: (r: T) => void) => {
    setBusy(key);
    try {
      done?.(await fn());
      reload();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="flex flex-col gap-4 px-4 py-4 sm:px-5">
      <div className="flex items-start gap-3.5">
        <KindMark kind={tr.kind} size="lg" />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-display text-lg leading-tight font-semibold">{tr.name}</h3>
            <Badge tone={badge.tone}>{badge.label}</Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {[t(KIND_LABEL[tr.kind]), agentName, tr.machineName && t("triggers.detail.machine", { machine: tr.machineName }), tr.skill && t("triggers.detail.skill", { skill: tr.skill })]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      </div>

      {lastError && (
        <div className="flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{lastError}</span>
        </div>
      )}

      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-3.5">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{tr.enabled ? t("triggers.detail.on") : t("triggers.detail.off")}</div>
            <p className="mt-0.5 text-xs text-muted">{tr.whenText}</p>
          </div>
          {busy === "enabled" ? (
            <Spinner />
          ) : (
            <Toggle
              checked={tr.enabled}
              onChange={(enabled) => void act("enabled", () => api.patch(triggerUrl(tr.id), { enabled }))}
              label={<span className="sr-only">{tr.enabled ? t("triggers.detail.disable") : t("triggers.detail.enable")}</span>}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" icon={<MessageCircleMore className="size-4" />} onClick={() => ask(agent ? tr.agentId : undefined, t("triggers.ask.change", { name: tr.name }))}>
            {t("triggers.action.changeInChat")}
          </Button>
          <Button
            size="sm"
            icon={<Play className="size-3.5" />}
            loading={busy === "run"}
            disabled={!!busy}
            onClick={() =>
              void act(
                "run",
                () => api.post<Partial<TriggerRun> & { text?: string }>(triggerUrl(tr.id, "run")),
                (r) => {
                  const m = runNowText(r ?? {});
                  toast(m.text, m.ok ? "success" : "error");
                },
              )
            }
          >
            {t("triggers.action.runNow")}
          </Button>
          {tr.kind === "watch" && (
            <Button
              size="sm"
              icon={<RefreshCw className="size-3.5" />}
              loading={busy === "check"}
              disabled={!!busy}
              onClick={() =>
                void act(
                  "check",
                  () => api.post<Parameters<typeof checkText>[0]>(triggerUrl(tr.id, "check")),
                  (r) => {
                    const m = checkText(r ?? {});
                    toast(m.text, m.ok ? "info" : "error");
                  },
                )
              }
            >
              {t("triggers.action.check")}
            </Button>
          )}
        </div>
      </div>

      <Section title={t("triggers.detail.when")}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <Row label={t("triggers.detail.next")}>{waits ? t("triggers.detail.onEvent") : formatAt(tr.nextRunAt, tz) || t("triggers.detail.notYet")}</Row>
          <Row label={t("triggers.detail.last")}>{formatAt(tr.state.lastRunAt, tz) || t("triggers.detail.notYet")}</Row>
          {tr.kind === "watch" && tr.state.lastCheckedAt && <Row label={t("triggers.detail.checked")}>{formatAt(tr.state.lastCheckedAt, tz)}</Row>}
          {tr.kind === "watch" && tr.state.lastValue && (
            <Row label={t("triggers.detail.value")}>
              <span className="font-mono text-xs break-all">{tr.state.lastValue.slice(0, 200)}</span>
            </Row>
          )}
        </dl>
      </Section>

      <Pipeline tr={tr} tz={tz} agentName={agentName} />

      <Journal tr={tr} tz={tz} />

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)}>
          {t("triggers.action.editForm")}
        </Button>
        <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} disabled={!!busy} onClick={() => setDeleting(true)}>
          {t("common.delete")}
        </Button>
      </div>

      {editing && <TriggerForm initial={tr} list={list} onClose={() => setEditing(false)} onSaved={reload} />}
      <Modal
        open={deleting}
        onClose={() => setDeleting(false)}
        title={t("triggers.action.confirmDelete", { name: tr.name })}
        footer={
          <>
            <Button onClick={() => setDeleting(false)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              loading={busy === "delete"}
              onClick={() =>
                void act(
                  "delete",
                  () => api.del(triggerUrl(tr.id)),
                  () => {
                    setDeleting(false);
                    toast(t("triggers.action.deleted"), "success");
                    panelBack();
                  },
                )
              }
            >
              {t("common.delete")}
            </Button>
          </>
        }
      >
        <p className="text-sm">{t("triggers.action.deleteText")}</p>
      </Modal>
    </div>
  );
}

// ---------- the pipeline ----------

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

const Mono = ({ children }: { children: ReactNode }) => <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs break-all">{children}</code>;
const Muted = ({ children }: { children: ReactNode }) => <p className="text-xs leading-relaxed break-words text-muted">{children}</p>;

/** The webhook's address and secret: the address to copy, the secret hidden until asked. */
function WebhookLine({ tr }: { tr: TriggerView }) {
  const [shown, setShown] = useState(false);
  if (!tr.webhookUrl) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Mono>{tr.webhookUrl}</Mono>
        <CopyButton text={tr.webhookUrl} />
      </div>
      {tr.secret && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span>{t("triggers.detail.secret")}</span>
          <Mono>{shown ? tr.secret : "••••••••"}</Mono>
          <button type="button" className="rounded-lg px-2 py-1 hover:bg-surface-2 hover:text-fg" onClick={() => setShown(!shown)}>
            {shown ? t("triggers.detail.hide") : t("triggers.detail.show")}
          </button>
          <CopyButton text={tr.secret} />
        </div>
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

function Pipeline({ tr, tz, agentName }: { tr: TriggerView; tz: string; agentName: string }) {
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

// ---------- the journal ----------

function Journal({ tr, tz }: { tr: TriggerView; tz: string }) {
  const [runs, setRuns] = useState<TriggerRun[] | null>(null);
  const [limit, setLimit] = useState(20);
  const [open, setOpen] = useState<string>();
  const load = useCallback(() => {
    api.get<{ runs: TriggerRun[] }>(`${triggerUrl(tr.id, "runs")}?limit=${limit}`).then(
      (r) => setRuns(r.runs ?? []),
      () => setRuns((x) => x ?? []),
    );
  }, [tr.id, limit]);
  useEffect(() => {
    load();
    return hubEvents.on((e) => {
      const id = changedTrigger(e);
      if (id === tr.id || id === "") load();
    });
  }, [load, tr.id]);

  return (
    <Section title={t("triggers.journal.title")}>
      {!runs ? (
        <Loading />
      ) : runs.length === 0 ? (
        <Muted>{t("triggers.journal.empty")}</Muted>
      ) : (
        <div className="-mx-3.5 -mb-3.5 border-t border-border">
          {runs.map((r) => (
            <RunRow key={r.id} run={r} tz={tz} open={open === r.id} onToggle={() => setOpen(open === r.id ? undefined : r.id)} />
          ))}
          {runs.length >= limit && limit < 200 && (
            <div className="border-t border-border px-3.5 py-2">
              <Button size="sm" variant="ghost" onClick={() => setLimit(200)}>
                {t("triggers.journal.more")}
              </Button>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function RunRow({ run, tz, open, onToggle }: { run: TriggerRun; tz: string; open: boolean; onToggle: () => void }) {
  const badge = runBadge(run);
  return (
    <div className="border-b border-border last:border-b-0">
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-surface-2/60">
        <ChevronRight className={cx("size-3.5 shrink-0 text-muted/70 transition-transform", open && "rotate-90")} />
        <span className="shrink-0 text-xs text-muted tabular-nums">{formatAt(run.at, tz)}</span>
        <span className="min-w-0 flex-1 truncate">{reasonText(run.reason)}</span>
        {(run.count ?? 1) > 1 && <span className="shrink-0 text-xs text-muted tabular-nums">{t("triggers.run.times", { n: run.count! })}</span>}
        {run.external && (
          <span title={t("triggers.run.externalHint")} className="shrink-0">
            <Badge tone="warning">
              <ShieldAlert className="size-3" />
              {t("triggers.run.external")}
            </Badge>
          </span>
        )}
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </button>
      {open && <RunDetail run={run} tz={tz} />}
    </div>
  );
}

function RunDetail({ run, tz }: { run: TriggerRun; tz: string }) {
  const stages = stageLines(run.stages);
  // Why it started nothing; a script's error is shown once, on its stage.
  const why = run.taskId || (!run.code && stages.some((s) => s.error === run.detail)) ? "" : errorMessage(run.code, run.params, run.detail);
  return (
    <div className="flex flex-col gap-3 bg-surface-2/30 px-3.5 pt-1 pb-3.5 pl-9 text-sm">
      {(run.count ?? 1) > 1 && <Muted>{t("triggers.run.repeated", { n: run.count!, time: formatAt(run.lastAt ?? run.at, tz) })}</Muted>}
      {run.external && (
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-warning">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          {t("triggers.run.externalHint")}
        </p>
      )}
      {run.taskId && (
        <Link href={`/tasks/${encodeURIComponent(run.taskId)}`} className="inline-flex items-center gap-1 self-start text-sm font-medium text-accent-text hover:underline">
          {t("triggers.run.openTask")}
          {run.taskStatus ? <span className="font-normal text-muted">· {taskStatus(run.taskStatus).label}</span> : null}
          <ChevronRight className="size-3.5" />
        </Link>
      )}
      {why && <p className={cx("text-xs leading-relaxed break-words", run.status === "error" ? "text-danger" : "text-muted")}>{why}</p>}
      {run.outcome === "note" && run.noteId && <Muted>{t("triggers.run.noteKept")}</Muted>}
      {run.signals && run.signals.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium">{t("triggers.run.signals")}</span>
          <ul className="flex flex-col gap-1">
            {run.signals.map((s) => (
              <li key={s.id} className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                <span>{sourceLabel(s.type) ?? s.type}</span>
                {s.subject && <span className="min-w-0 truncate text-muted">{s.subject}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {stages.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">{t("triggers.run.stages")}</span>
          <ol className="flex flex-col gap-1.5">
            {stages.map((s, i) => (
              <li key={i} className="rounded-xl border border-border bg-surface px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium">{s.label}</span>
                  {s.verdict && <Badge tone={s.verdict.tone}>{s.verdict.label}</Badge>}
                  {s.cost && <span className="ml-auto text-xs text-muted tabular-nums">{s.cost}</span>}
                </div>
                {s.why && <p className="mt-1 text-xs leading-relaxed break-words text-muted">{s.why}</p>}
                {s.error && <p className="mt-1 text-xs leading-relaxed break-words text-danger">{s.error}</p>}
                {s.logs.length > 0 && (
                  <details className="group mt-1">
                    <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted select-none hover:text-fg [&::-webkit-details-marker]:hidden">
                      <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                      {t("triggers.run.logs")}
                    </summary>
                    <pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-code-bg p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{s.logs.join("\n")}</pre>
                  </details>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

// ---------- the form: the second way to make or change a trigger ----------

function TriggerForm({ initial, list, onClose, onSaved }: { initial: TriggerView | null; list: TriggersList; onClose: () => void; onSaved: () => void }) {
  const ask = useAsk();
  const tz = list.timezone;
  const agents = list.agents;
  const computers = list.computers ?? [];
  const editing = !!initial;
  const [kind, setKind] = useState<TriggerKind>(initial?.kind ?? "schedule");
  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [agent, setAgent] = useState(initial?.agentId ?? agents[0]?.id ?? "assistant");
  const [machine, setMachine] = useState(initial?.machine ?? "");
  const [cron, setCron] = useState(initial?.cron ?? "0 9 * * 1-5");
  const [at, setAt] = useState(toLocalInput(initial?.at, tz));
  const [url, setUrl] = useState(initial?.url ?? "");
  const [mode, setMode] = useState<"page" | "selector" | "json">(initial?.jsonPath ? "json" : initial?.selector ? "selector" : "page");
  const [selector, setSelector] = useState(initial?.selector ?? "");
  const [jsonPath, setJsonPath] = useState(initial?.jsonPath ?? "");
  const [interval, setIntervalMin] = useState(String(initial?.intervalMinutes ?? 60));
  const [times, setTimes] = useState((initial?.times ?? ["10:00", "18:00"]).join(", "));
  const [weekdays, setWeekdays] = useState<number[]>(initial?.weekdays ?? [1, 2, 3, 4, 5]);
  const [maxRuns, setMaxRuns] = useState(String(initial?.maxRunsPerDay ?? 24));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const body: Record<string, unknown> = { name, prompt, agent, maxRunsPerDay: Number(maxRuns) };
    if (!editing) body.kind = kind;
    if (machine !== (initial?.machine ?? "")) body.machine = machine;
    if (kind === "schedule") body.cron = cron;
    // Resend the time only when it changed: a fired one-off keeps its past time on rename.
    if (kind === "once" && (!editing || at !== toLocalInput(initial?.at, tz))) body.at = at;
    if (kind === "watch") {
      body.url = url;
      body.intervalMinutes = Number(interval);
      body.selector = mode === "selector" ? selector : null;
      body.jsonPath = mode === "json" ? jsonPath : null;
    }
    if (kind === "heartbeat") {
      body.times = parseTimes(times);
      body.weekdays = weekdays;
    }
    setBusy(true);
    setError(undefined);
    try {
      const saved = editing ? await api.patch<{ warnings?: Array<{ text: string }> }>(triggerUrl(initial!.id), body) : await api.post<{ warnings?: Array<{ text: string }> }>(TRIGGERS_API, body);
      toast(editing ? t("triggers.form.saved") : t("triggers.form.created"), "success");
      for (const w of saved?.warnings ?? []) toast(w.text, "info");
      onSaved();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // A computer no longer paired stays in the list under its last name, so the form does not drop it silently.
  const machineOptions = !machine || computers.some((c) => c.id === machine) ? computers : [...computers, { id: machine, name: initial?.machineName ?? machine, status: "" }];
  // Likewise an agent the list no longer has (archived) stays the trigger's until the person picks another.
  const agentOptions = agents.some((a) => a.id === agent) ? agents : [...agents, { id: agent, name: agent }];
  const kinds = FORM_KINDS.includes(kind) ? FORM_KINDS : [...FORM_KINDS, kind];

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? t("triggers.form.editTitle", { name: initial!.name }) : t("triggers.form.newTitle")}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {editing ? t("common.save") : t("common.create")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <button
          type="button"
          onClick={() => {
            onClose();
            ask(editing && agents.some((a) => a.id === initial!.agentId) ? initial!.agentId : undefined, editing ? t("triggers.ask.change", { name: initial!.name }) : t("triggers.ask.new"));
          }}
          className="flex items-start gap-2 self-start rounded-xl text-left text-xs leading-relaxed text-muted hover:text-fg"
        >
          <MessageCircleMore className="mt-0.5 size-3.5 shrink-0 text-accent-text" />
          {t("triggers.form.chatToo")}
        </button>
        <Field label={t("triggers.form.kind")} hint={t(KIND_HINT[kind])}>
          <Select value={kind} disabled={editing} onChange={(e) => setKind(e.target.value as TriggerKind)}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {t(KIND_LABEL[k])}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("triggers.form.name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("triggers.form.namePlaceholder")} />
        </Field>
        <Field label={t("triggers.form.prompt")} hint={t("triggers.form.promptHint")}>
          <Textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t("triggers.form.promptPlaceholder")} />
        </Field>
        <Field label={t("triggers.form.agent")}>
          <Select value={agent} onChange={(e) => setAgent(e.target.value)}>
            {agentOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        {/* Only when there is a choice: a hub alone has one computer, or the trigger already has one set. */}
        {(computers.length > 1 || machine) && (
          <Field label={t("triggers.form.machine")} hint={t("triggers.form.machineHint")}>
            <Select value={machine} onChange={(e) => setMachine(e.target.value)}>
              <option value="">{t("triggers.form.machineAny")}</option>
              {machineOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {kind === "schedule" && (
          <Field label={t("triggers.form.cron")} hint={t("triggers.form.cronHint", { tz })}>
            <Input className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} />
          </Field>
        )}
        {kind === "once" && (
          <Field label={t("triggers.form.at")} hint={t("triggers.form.atHint", { tz })}>
            <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          </Field>
        )}
        {kind === "watch" && (
          <>
            <Field label={t("triggers.form.url")}>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
            </Field>
            <Field label={t("triggers.form.mode")}>
              <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                <option value="page">{t("triggers.form.mode.page")}</option>
                <option value="selector">{t("triggers.form.mode.selector")}</option>
                <option value="json">{t("triggers.form.mode.json")}</option>
              </Select>
            </Field>
            {mode === "selector" && (
              <Field label={t("triggers.form.selector")}>
                <Input className="font-mono" value={selector} onChange={(e) => setSelector(e.target.value)} placeholder=".price" />
              </Field>
            )}
            {mode === "json" && (
              <Field label={t("triggers.form.jsonPath")}>
                <Input className="font-mono" value={jsonPath} onChange={(e) => setJsonPath(e.target.value)} placeholder="data.items[0].price" />
              </Field>
            )}
            <Field label={t("triggers.form.interval")} hint={t("triggers.form.intervalHint")}>
              <Input type="number" min={5} value={interval} onChange={(e) => setIntervalMin(e.target.value)} />
            </Field>
          </>
        )}
        {kind === "heartbeat" && (
          <>
            <Field label={t("triggers.form.times")} hint={t("triggers.form.timesHint", { tz })}>
              <Input value={times} onChange={(e) => setTimes(e.target.value)} placeholder="10:00, 18:00" />
            </Field>
            <Field label={t("triggers.form.weekdays")} group>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAY_ORDER.map((d) => {
                  const on = weekdays.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setWeekdays(on ? weekdays.filter((x) => x !== d) : [...weekdays, d])}
                      className={cx("press h-8 rounded-full px-3 text-[13px] font-medium", on ? "bg-fg text-bg" : "bg-surface-2 text-muted hover:text-fg")}
                    >
                      {weekdayName(d)}
                    </button>
                  );
                })}
              </div>
            </Field>
          </>
        )}
        {kind === "event" && !editing && <p className="text-xs text-muted">{t("triggers.form.eventHint")}</p>}
        <Field label={t("triggers.form.maxRuns")}>
          <Input type="number" min={1} value={maxRuns} onChange={(e) => setMaxRuns(e.target.value)} />
        </Field>
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Modal>
  );
}
