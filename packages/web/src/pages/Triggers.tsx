// Triggers: when agents act on their own. The list shows each trigger's name, when it runs and how it last went; a
// trigger's own page shows its pipeline (what it listens to, its filter, its script and quick check, what the agent
// then does) and its journal, each run open to its stages. Made and changed in the chat (CLAUDE.md, "Interface"):
// "New trigger" and "Change in the chat" open the agent's dialog with a short request; the form is the second way.
// This file has the list and a trigger's page; the pipeline, the journal and the form are in ./triggers.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AlarmClock, CalendarClock, ChevronRight, Eye, HeartPulse, MessageCircleMore, Pencil, Play, Radio, RefreshCw, Trash2, TriangleAlert, Webhook, type LucideIcon } from "lucide-react";
import { api, errorText } from "../lib/api";
import { relativeTime } from "../lib/format";
import { useStore } from "../lib/store";
import { changedTrigger, checkText, formatAt, KIND_LABEL, runNowText, statusBadge, triggerUrl, TRIGGERS_API, type TriggerKind, type TriggerRun, type TriggersList, type TriggerView } from "../lib/triggers";
import { hubEvents } from "../state/app";
import { useAsk } from "../state/ask";
import { openPanelItem, panel, panelBack } from "../state/panel";
import { toast } from "../state/toast";
import { t } from "../i18n";
import { Badge, Button, cx, EmptyState, ErrorNote, Loading, Modal, Page, Spinner, Toggle } from "../components/ui";
import { Journal } from "./triggers/Journal";
import { Pipeline } from "./triggers/Pipeline";
import { Section } from "./triggers/parts";
import { TriggerForm } from "./triggers/TriggerForm";

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
          <Button variant="primary" icon={<MessageCircleMore className="size-4" />} onClick={() => ask(t("triggers.ask.new"))}>
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
          <Button size="sm" variant="primary" icon={<MessageCircleMore className="size-4" />} onClick={() => ask(t("triggers.ask.change", { name: tr.name }), agent ? tr.agentId : undefined)}>
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

