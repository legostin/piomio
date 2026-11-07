// "Triggers" page: list, enable toggle, create/edit per kind, run now, run history.

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, EmptyState, Spinner, definePluginUI } from "@piomio/ui";
import type { PiomioUI } from "@piomio/ui";

/** "signal": a trigger that listens only to other sources' signals (`on`), made in the chat. */
type Kind = "schedule" | "once" | "watch" | "event" | "heartbeat" | "signal";
type ErrorParams = Record<string, string | number>;

interface Trigger {
  id: string;
  kind: Kind;
  name: string;
  prompt: string;
  agentId: string;
  machine?: string;
  machineName?: string;
  /** A skill the person taught that each run follows. */
  skill?: string;
  enabled: boolean;
  maxRunsPerDay: number;
  cron?: string;
  at?: string;
  url?: string;
  selector?: string;
  jsonPath?: string;
  intervalMinutes?: number;
  secret?: string;
  times?: string[];
  weekdays?: number[];
  nextRunAt: string | null;
  webhookUrl: string | null;
  /** When it runs, in the reader's language. */
  whenText: string;
  lastErrorText: string | null;
  state: {
    lastRunAt?: string;
    lastStatus?: "ok" | "error" | "skipped";
    lastError?: string;
    lastErrorCode?: string;
    lastErrorParams?: ErrorParams;
    lastCheckedAt?: string;
    lastValue?: string;
    done?: boolean;
  };
}

interface Run {
  id: string;
  at: string;
  reason: string;
  status: "started" | "skipped" | "error";
  /** What a trigger's check decided: a note or a drop started nothing (pipeline runs only). */
  outcome?: "note" | "wake" | "drop";
  taskId?: string;
  taskStatus?: string;
  detail?: string;
  code?: string;
  params?: ErrorParams;
}

interface ListResponse {
  triggers: Trigger[];
  timezone: string;
  agents: Array<{ id: string; name: string }>;
  /** The computers runs can happen on, the hub's own first. */
  computers?: Array<{ id: string; name: string; status: string }>;
}

// Set in definePluginUI; the page reloads when the language changes.
let i18n: PiomioUI["i18n"];
const tr = (key: string, params?: ErrorParams) => i18n.t(key, params);

/** The kinds the form makes; a signal trigger is made in the chat (it needs `on`). */
const KINDS: Kind[] = ["schedule", "once", "watch", "event", "heartbeat"];
/** Form order of weekdays: Monday first, Sunday last (0 = Sunday). */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Short weekday name in the interface language (0 = Sunday); 2026-10-25 is a Sunday. */
function weekdayName(d: number): string {
  return i18n.formatDate(Date.UTC(2026, 9, 25 + d, 12), { weekday: "short", timeZone: "UTC" });
}

const capitalize = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

/**
 * An error from the backend in the interface language: the catalog message for its code, else the text as is, labelled:
 * the trigger's check (its script, the engine) writes its own words in English, and they are shown as written.
 */
function errorText(code: string | undefined, params: ErrorParams | undefined, fallback: string | undefined): string {
  if (code) {
    const key = `error.${code}`;
    const text = tr(key, params);
    if (text !== key) return text;
  }
  return fallback ? tr("ui.run.asWritten", { text: fallback }) : "";
}

/** A run's badge: what came of it when it started nothing (a note, a drop; the next column says why), else how it went. */
function runBadge(r: Pick<Run, "status" | "outcome">) {
  if (r.status !== "error" && r.outcome === "note") return <Badge tone="info">{tr("ui.run.note")}</Badge>;
  if (r.status !== "error" && r.outcome === "drop") return <Badge tone="neutral">{tr("ui.run.drop")}</Badge>;
  return (
    <Badge tone={r.status === "started" ? "success" : r.status === "skipped" ? "warning" : "danger"}>
      {r.status === "started" ? tr("ui.run.started") : r.status === "skipped" ? tr("ui.run.skipped") : tr("ui.run.error")}
    </Badge>
  );
}

const s = {
  page: { maxWidth: 960, margin: "0 auto", padding: 16, display: "grid", gap: 12 },
  head: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" },
  row: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" },
  muted: { opacity: 0.7, fontSize: "0.9em" },
  error: { color: "var(--danger, #c0392b)", fontSize: "0.9em" },
  field: { display: "grid", gap: 4, marginBottom: 10 },
  input: { width: "100%", boxSizing: "border-box", padding: "6px 8px", font: "inherit" },
  mono: { fontFamily: "ui-monospace, monospace", fontSize: "0.85em", wordBreak: "break-all" },
} as const;

function fmt(iso: string | null | undefined, tz: string): string {
  if (!iso) return "—";
  try {
    return i18n.formatDate(iso, { timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

/** ISO instant → "YYYY-MM-DDTHH:MM" wall clock in tz, for <input type="datetime-local">. */
function toLocalInput(iso: string | undefined, tz: string): string {
  if (!iso) return "";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function statusBadge(t: Trigger) {
  if (t.kind === "once" && t.state.done) return <Badge tone="neutral">{tr("ui.status.done")}</Badge>;
  if (!t.enabled) return <Badge tone="neutral">{tr("ui.status.off")}</Badge>;
  if (t.state.lastStatus === "error") return <Badge tone="danger">{tr("ui.status.error")}</Badge>;
  if (t.state.lastStatus === "skipped") return <Badge tone="warning">{tr("ui.status.skipped")}</Badge>;
  return <Badge tone="success">{tr("ui.status.active")}</Badge>;
}

// ---------- form ----------

interface FormProps {
  ui: PiomioUI;
  initial: Trigger | null;
  agents: ListResponse["agents"];
  computers: NonNullable<ListResponse["computers"]>;
  tz: string;
  onDone: () => void;
}

function TriggerForm({ ui, initial, agents, computers, tz, onDone }: FormProps) {
  const editing = !!initial;
  const [kind, setKind] = useState<Kind>(initial?.kind ?? "schedule");
  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [agent, setAgent] = useState(initial?.agentId ?? agents[0]?.id ?? "assistant");
  const [machine, setMachine] = useState(initial?.machine ?? "");
  const [cron,setCron] = useState(initial?.cron ?? "0 9 * * 1-5");
  const [at, setAt] = useState(toLocalInput(initial?.at, tz));
  const [url, setUrl] = useState(initial?.url ?? "");
  const [mode, setMode] = useState<"page" | "selector" | "json">(initial?.jsonPath ? "json" : initial?.selector ? "selector" : "page");
  const [selector, setSelector] = useState(initial?.selector ?? "");
  const [jsonPath, setJsonPath] = useState(initial?.jsonPath ?? "");
  const [interval, setIntervalMin] = useState(String(initial?.intervalMinutes ?? 60));
  const [times, setTimes] = useState((initial?.times ?? ["10:00", "18:00"]).join(", "));
  const [weekdays, setWeekdays] = useState<number[]>(initial?.weekdays ?? [1, 2, 3, 4, 5]);
  const [maxRuns, setMaxRuns] = useState(String(initial?.maxRunsPerDay ?? 24));
  const [error, setError] = useState<string | null>(null);
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
      body.times = times
        .split(/[,\s]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      body.weekdays = weekdays;
    }
    setBusy(true);
    setError(null);
    try {
      if (editing) await ui.plugin.http("PATCH", `/triggers/${initial!.id}`, body);
      else await ui.plugin.http("POST", "/triggers", body);
      ui.toast(editing ? tr("ui.form.saved") : tr("ui.form.created"), "success");
      onDone();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  // A computer no longer paired stays in the list under its last name, so the form does not drop it silently.
  const machineOptions = !machine || computers.some((c) => c.id === machine) ? computers : [...computers, { id: machine, name: initial?.machineName ?? machine, status: "" }];

  const field = (label: string, input: any, hint?: string) => (
    <label style={s.field}>
      <span>{label}</span>
      {input}
      {hint && <span style={s.muted}>{hint}</span>}
    </label>
  );

  return (
    <Card title={editing ? tr("ui.form.editTitle", { name: initial!.name }) : tr("ui.form.newTitle")}>
      {field(
        tr("ui.form.kind"),
        <select style={s.input} value={kind} disabled={editing} onChange={(e: any) => setKind(e.target.value)}>
          {(KINDS.includes(kind) ? KINDS : [...KINDS, kind]).map((k) => (
            <option key={k} value={k}>
              {tr(`ui.kind.${k}`)}
            </option>
          ))}
        </select>,
        tr(`ui.kindHint.${kind}`),
      )}
      {field(tr("ui.form.name"), <input style={s.input} value={name} onChange={(e: any) => setName(e.target.value)} placeholder={tr("ui.form.namePlaceholder")} />)}
      {field(
        tr("ui.form.prompt"),
        <textarea style={s.input} rows={5} value={prompt} onChange={(e: any) => setPrompt(e.target.value)} placeholder={tr("ui.form.promptPlaceholder")} />,
        tr("ui.form.promptHint"),
      )}
      {field(
        tr("ui.form.agent"),
        <select style={s.input} value={agent} onChange={(e: any) => setAgent(e.target.value)}>
          {(agents.length ? agents : [{ id: agent, name: agent }]).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>,
      )}
      {/* Only when there is a choice: a hub alone has one computer, or the trigger already has one set. */}
      {(computers.length > 1 || machine) &&
        field(
          tr("ui.form.machine"),
          <select style={s.input} value={machine} onChange={(e: any) => setMachine(e.target.value)}>
            <option value="">{tr("ui.form.machineAny")}</option>
            {machineOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>,
          tr("ui.form.machineHint"),
        )}

      {kind === "schedule" &&
        field(tr("ui.form.cron"), <input style={{ ...s.input, ...s.mono }} value={cron} onChange={(e: any) => setCron(e.target.value)} />, tr("ui.form.cronHint", { tz }))}
      {kind === "once" && field(tr("ui.form.at"), <input type="datetime-local" style={s.input} value={at} onChange={(e: any) => setAt(e.target.value)} />, tr("ui.form.atHint", { tz }))}
      {kind === "watch" && (
        <>
          {field(tr("ui.form.url"), <input style={s.input} value={url} onChange={(e: any) => setUrl(e.target.value)} placeholder="https://…" />)}
          {field(
            tr("ui.form.mode"),
            <select style={s.input} value={mode} onChange={(e: any) => setMode(e.target.value)}>
              <option value="page">{tr("ui.form.mode.page")}</option>
              <option value="selector">{tr("ui.form.mode.selector")}</option>
              <option value="json">{tr("ui.form.mode.json")}</option>
            </select>,
          )}
          {mode === "selector" &&
            field(tr("ui.form.selector"), <input style={{ ...s.input, ...s.mono }} value={selector} onChange={(e: any) => setSelector(e.target.value)} placeholder=".price" />)}
          {mode === "json" &&
            field(tr("ui.form.jsonPath"), <input style={{ ...s.input, ...s.mono }} value={jsonPath} onChange={(e: any) => setJsonPath(e.target.value)} placeholder="data.items[0].price" />)}
          {field(
            tr("ui.form.interval"),
            <input type="number" min={5} style={s.input} value={interval} onChange={(e: any) => setIntervalMin(e.target.value)} />,
            tr("ui.form.intervalHint"),
          )}
        </>
      )}
      {kind === "heartbeat" && (
        <>
          {field(tr("ui.form.times"), <input style={s.input} value={times} onChange={(e: any) => setTimes(e.target.value)} placeholder="10:00, 18:00" />, tr("ui.form.timesHint", { tz }))}
          <div style={s.field}>
            <span>{tr("ui.form.weekdays")}</span>
            <div style={s.row}>
              {WEEKDAY_ORDER.map((d) => (
                <label key={d} style={s.row}>
                  <input
                    type="checkbox"
                    checked={weekdays.includes(d)}
                    onChange={(e: any) => setWeekdays(e.target.checked ? [...weekdays, d] : weekdays.filter((x) => x !== d))}
                  />
                  {capitalize(weekdayName(d))}
                </label>
              ))}
            </div>
          </div>
        </>
      )}
      {kind === "event" && !editing && <p style={s.muted}>{tr("ui.form.eventHint")}</p>}
      {field(tr("ui.form.maxRuns"), <input type="number" min={1} style={s.input} value={maxRuns} onChange={(e: any) => setMaxRuns(e.target.value)} />)}

      {error && <p style={s.error}>{error}</p>}
      <div style={s.row}>
        <Button variant="primary" disabled={busy} onClick={submit}>
          {editing ? tr("ui.form.save") : tr("ui.form.create")}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onDone}>
          {tr("ui.form.cancel")}
        </Button>
      </div>
    </Card>
  );
}

// ---------- history ----------

function History({ ui, trigger, tz, onClose }: { ui: PiomioUI; trigger: Trigger; tz: string; onClose: () => void }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const load = useCallback(() => {
    ui.plugin
      .http<{ runs: Run[] }>("GET", `/triggers/${trigger.id}/runs`)
      .then((r) => setRuns(r.runs))
      .catch(() => setRuns([]));
  }, [ui, trigger.id]);
  useEffect(() => {
    load();
    return ui.plugin.on("changed", (p: { id?: string }) => {
      if (p?.id === trigger.id) load();
    });
  }, [ui, trigger.id, load]);

  return (
    <Card
      title={tr("ui.history.title", { name: trigger.name })}
      actions={
        <Button variant="ghost" size="sm" onClick={onClose}>
          {tr("ui.history.close")}
        </Button>
      }
    >
      {!runs ? (
        <Spinner />
      ) : runs.length === 0 ? (
        <p style={s.muted}>{tr("ui.history.empty")}</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            {runs.map((r) => {
              const reasonKey = `ui.reason.${r.reason}`;
              const reason = tr(reasonKey);
              return (
                <tr key={r.id}>
                  <td style={{ padding: "4px 8px 4px 0", whiteSpace: "nowrap" }}>{fmt(r.at, tz)}</td>
                  <td style={{ padding: "4px 8px" }}>{reason === reasonKey ? r.reason : reason}</td>
                  <td style={{ padding: "4px 8px" }}>{runBadge(r)}</td>
                  <td style={{ padding: "4px 0 4px 8px" }}>
                    {r.taskId ? (
                      <a
                        href={`/tasks/${r.taskId}`}
                        onClick={(e: any) => {
                          e.preventDefault();
                          ui.navigate(`/tasks/${r.taskId}`);
                        }}
                      >
                        {tr("ui.run.task")}
                        {r.taskStatus ? ` (${r.taskStatus})` : ""}
                      </a>
                    ) : (
                      <span style={s.muted}>{errorText(r.code, r.params, r.detail)}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------- list ----------

function TriggerCard({ ui, t, tz, onEdit, onHistory }: { ui: PiomioUI; t: Trigger; tz: string; onEdit: () => void; onHistory: () => void }) {
  const [busy, setBusy] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  const call = async (method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown, done?: (r: any) => void) => {
    setBusy(true);
    try {
      const r = await ui.plugin.http(method, path, body);
      done?.(r);
    } catch (e: any) {
      ui.toast(e?.message ?? String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => ui.toast(tr("ui.card.copied"), "success"));
  };

  // The check's and the engine's own words (an error with no code) are shown as written, labelled.
  const lastError = t.lastErrorText ? (t.state.lastErrorCode ? t.lastErrorText : tr("ui.run.asWritten", { text: t.lastErrorText })) : "";

  return (
    <Card
      title={
        <span style={s.row}>
          <b>{t.name}</b>
          <Badge tone="info">{tr(`ui.kind.${t.kind}`)}</Badge>
          {statusBadge(t)}
        </span>
      }
      actions={
        <label style={s.row} title={t.enabled ? tr("ui.card.disable") : tr("ui.card.enable")}>
          <input type="checkbox" checked={t.enabled} disabled={busy} onChange={(e: any) => call("PATCH", `/triggers/${t.id}`, { enabled: e.target.checked })} />
          {t.enabled ? tr("ui.card.on") : tr("ui.card.off")}
        </label>
      }
    >
      <div style={{ display: "grid", gap: 4 }}>
        <span style={s.muted}>{[t.whenText, t.machineName && tr("ui.card.machine", { machine: t.machineName }), t.skill && tr("ui.card.skill", { skill: t.skill })].filter(Boolean).join(" · ")}</span>
        <span>
          {tr("ui.card.next")} <b>{t.kind === "event" ? tr("ui.card.onEvent") : fmt(t.nextRunAt, tz)}</b> · {tr("ui.card.last")} {fmt(t.state.lastRunAt, tz)}
          {t.kind === "watch" && t.state.lastCheckedAt && (
            <>
              {" "}
              · {tr("ui.card.checked")} {fmt(t.state.lastCheckedAt, tz)}
            </>
          )}
        </span>
        {lastError && <span style={s.error}>{lastError}</span>}
        {t.kind === "watch" && t.state.lastValue && (
          <span style={{ ...s.muted, ...s.mono }}>
            {tr("ui.card.value")} {t.state.lastValue.slice(0, 200)}
          </span>
        )}
        {t.kind === "event" && t.webhookUrl && (
          <div style={{ display: "grid", gap: 4 }}>
            <span style={s.row}>
              <span style={s.mono}>{t.webhookUrl}</span>
              <Button size="sm" variant="ghost" onClick={() => copy(t.webhookUrl!)}>
                {tr("ui.card.copy")}
              </Button>
            </span>
            <span style={s.row}>
              {tr("ui.card.secret")} <span style={s.mono}>{showSecret ? t.secret : "••••••••"}</span>
              <Button size="sm" variant="ghost" onClick={() => setShowSecret(!showSecret)}>
                {showSecret ? tr("ui.card.hide") : tr("ui.card.show")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => copy(t.secret ?? "")}>
                {tr("ui.card.copy")}
              </Button>
            </span>
          </div>
        )}
      </div>
      <div style={{ ...s.row, marginTop: 10 }}>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            call("POST", `/triggers/${t.id}/run`, undefined, (r) =>
              ui.toast(
                r?.status === "started" && r?.outcome === "note"
                  ? tr("ui.card.noted")
                  : r?.status === "started" && r?.outcome === "drop"
                    ? tr("ui.card.dropped")
                    : r?.status === "started"
                      ? tr("ui.card.started")
                      : tr("ui.card.notStarted", { reason: errorText(r?.code, r?.params, r?.detail) }),
                r?.status === "started" ? "success" : "error",
              ),
            )
          }
        >
          {tr("ui.card.runNow")}
        </Button>
        {t.kind === "watch" && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              call("POST", `/triggers/${t.id}/check`, undefined, (r) =>
                ui.toast(
                  r?.error
                    ? tr("ui.card.checkError", { error: errorText(r.code, r.params, r.error) })
                    : r?.changed
                      ? tr("ui.card.changed")
                      : r?.baseline
                        ? tr("ui.card.baseline")
                        : tr("ui.card.unchanged"),
                  r?.error ? "error" : "info",
                ),
              )
            }
          >
            {tr("ui.card.check")}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>
          {tr("ui.card.edit")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onHistory}>
          {tr("ui.card.history")}
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={busy}
          onClick={() => {
            if (window.confirm(tr("ui.card.confirmDelete", { name: t.name }))) void call("DELETE", `/triggers/${t.id}`);
          }}
        >
          {tr("ui.card.delete")}
        </Button>
      </div>
    </Card>
  );
}

function TriggersPage({ ui }: { ui: PiomioUI }) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Trigger | "new" | null>(null);
  const [history, setHistory] = useState<string | null>(null);

  const load = useCallback(() => {
    ui.plugin
      .http<ListResponse>("GET", "/triggers")
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e) => setError(e?.message ?? String(e)));
  }, [ui]);

  useEffect(() => {
    load();
    return ui.plugin.on("changed", () => load());
  }, [ui, load]);

  if (!data) return <div style={s.page}>{error ? <p style={s.error}>{tr("ui.loadFailed", { error })}</p> : <Spinner />}</div>;
  const tz = data.timezone;
  const historyTrigger = history ? data.triggers.find((t) => t.id === history) : undefined;

  return (
    <div style={s.page}>
      <div style={s.head}>
        <div>
          <h2 style={{ margin: 0 }}>{tr("ui.title")}</h2>
          <span style={s.muted}>{tr("ui.subtitle", { tz })}</span>
        </div>
        {editing === null && (
          <Button variant="primary" onClick={() => setEditing("new")}>
            {tr("ui.create")}
          </Button>
        )}
      </div>

      {editing !== null && (
        <TriggerForm
          key={editing === "new" ? "new" : editing.id}
          ui={ui}
          initial={editing === "new" ? null : editing}
          agents={data.agents}
          computers={data.computers ?? []}
          tz={tz}
          onDone={() => {
            setEditing(null);
            load();
          }}
        />
      )}

      {historyTrigger && <History ui={ui} trigger={historyTrigger} tz={tz} onClose={() => setHistory(null)} />}

      {data.triggers.length === 0 ? (
        <EmptyState title={tr("ui.empty.title")} hint={tr("ui.empty.hint")} icon="alarm-clock" />
      ) : (
        data.triggers.map((t) => <TriggerCard key={t.id} ui={ui} t={t} tz={tz} onEdit={() => setEditing(t)} onHistory={() => setHistory(t.id)} />)
      )}
    </div>
  );
}

export default definePluginUI((ui) => {
  i18n = ui.i18n;
  return ui.routes.add({ path: "/triggers", title: tr("ui.title"), icon: "alarm-clock", nav: true, component: () => <TriggersPage ui={ui} /> });
});
