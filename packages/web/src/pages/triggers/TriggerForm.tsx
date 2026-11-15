// The form: the second way to make or change a trigger (the chat is the first, and the form's top line leads there).
// It has every field the plugin's form had; a signal trigger is made in the chat.

import { useState } from "react";
import { MessageCircleMore } from "lucide-react";
import { api, errorText } from "../../lib/api";
import { FORM_KINDS, KIND_HINT, KIND_LABEL, parseTimes, toLocalInput, triggerUrl, TRIGGERS_API, WEEKDAY_ORDER, weekdayName, type TriggerKind, type TriggersList, type TriggerView } from "../../lib/triggers";
import { useAsk } from "../../state/ask";
import { toast } from "../../state/toast";
import { t } from "../../i18n";
import { Button, cx, ErrorNote, Field, Input, Modal, Select, Textarea } from "../../components/ui";

export function TriggerForm({ initial, list, onClose, onSaved }: { initial: TriggerView | null; list: TriggersList; onClose: () => void; onSaved: () => void }) {
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
            ask(editing ? t("triggers.ask.change", { name: initial!.name }) : t("triggers.ask.new"), editing && agents.some((a) => a.id === initial!.agentId) ? initial!.agentId : undefined);
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
