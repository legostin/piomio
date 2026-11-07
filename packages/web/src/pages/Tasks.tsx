// Task feed in three kinds (work for the person, channel runs, schedules with the configured triggers), status filters,
// search, create. A trigger is changed in the chat with its agent.

import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { AlarmClock, Bot, ChevronRight, Plus, Search, Timer, User, Zap } from "lucide-react";
import { AgentAvatar } from "../components/AgentAvatar";
import type { Task, TaskStatus } from "@piomio/shared";
import { useStore } from "../lib/store";
import { api, errorText } from "../lib/api";
import { ACTIVE_STATUSES, formatDateTime, formatTime, relativeTime, taskStatus } from "../lib/format";
import { TRIGGERS_API } from "../lib/triggers";
import { agents, ensureAgents, refreshTasks, session, tasks } from "../state/app";
import { askInChat } from "../state/ask";
import { toast } from "../state/toast";
import { t, type MessageKey } from "../i18n";
import { Badge, Button, EmptyState, ErrorNote, Field, Input, Loading, Modal, Page, Segmented, Select, Textarea, Toggle } from "../components/ui";

type Kind = "work" | "channels" | "schedules";
type Filter = "all" | "active" | "waiting" | "done" | "failed";

const KIND_LABELS: Record<Kind, MessageKey> = { work: "tasks.kind.work", channels: "tasks.kind.channels", schedules: "tasks.kind.schedules" };
const KIND_EMPTY: Record<Kind, { title: MessageKey; hint: MessageKey; icon: string }> = {
  work: { title: "tasks.empty", hint: "tasks.emptyHint", icon: "list-todo" },
  channels: { title: "tasks.emptyChannels", hint: "tasks.emptyChannelsHint", icon: "newspaper" },
  schedules: { title: "tasks.emptySchedules", hint: "tasks.emptySchedulesHint", icon: "alarm-clock" },
};

function kindOf(task: Task): Kind {
  if (task.feedId) return "channels";
  return task.createdBy === "trigger" ? "schedules" : "work";
}

/** A configured trigger as the hub lists it (only what this page shows). */
interface TriggerSummary {
  id: string;
  kind: string;
  name: string;
  agentId: string;
  /** The computer its runs happen on, when one is set. */
  machineName?: string;
  enabled: boolean;
  times?: string[];
  nextRunAt?: string | null;
}

const TRIGGERS_URL = TRIGGERS_API;

const FILTERS: Record<Filter, (s: TaskStatus) => boolean> = {
  all: () => true,
  active: (s) => ACTIVE_STATUSES.includes(s),
  waiting: (s) => s === "waiting_approval" || s === "waiting_input",
  done: (s) => s === "done",
  failed: (s) => s === "failed" || s === "cancelled",
};

const CREATED_BY: Record<Task["createdBy"], { label: MessageKey; icon: typeof User }> = {
  user: { label: "tasks.by.user", icon: User },
  agent: { label: "tasks.by.agent", icon: Bot },
  trigger: { label: "tasks.by.trigger", icon: Zap },
};

const FILTER_LABELS: Record<Filter, MessageKey> = {
  all: "tasks.filter.all",
  active: "tasks.filter.active",
  waiting: "tasks.filter.waiting",
  done: "tasks.filter.done",
  failed: "tasks.filter.failed",
};

export function TasksPage() {
  const list = useStore(tasks);
  const agentList = useStore(agents);
  const search = useSearch();
  const [, navigate] = useLocation();
  const [kind, setKind] = useState<Kind>("work");
  const [triggers, setTriggers] = useState<TriggerSummary[]>();
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(() => new URLSearchParams(search).get("new") === "1");

  const load = () => {
    setError(undefined);
    refreshTasks().catch((e) => setError(errorText(e)));
  };
  useEffect(() => {
    load();
    ensureAgents();
    // A hub that does not run triggers (it does not lead) has nothing configured to list.
    api
      .get<{ triggers: TriggerSummary[] }>(TRIGGERS_URL)
      .then((r) => setTriggers(r.triggers))
      .catch(() => setTriggers([]));
  }, []);
  useEffect(() => {
    if (new URLSearchParams(search).get("new") === "1") setCreating(true);
  }, [search]);

  const agentNames = useMemo(() => new Map((agentList ?? []).map((a) => [a.id, a.name])), [agentList]);
  const ofKind = useMemo(() => (list ?? []).filter((task) => kindOf(task) === kind), [list, kind]);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, active: 0, waiting: 0, done: 0, failed: 0 };
    for (const task of ofKind) for (const f of Object.keys(FILTERS) as Filter[]) if (FILTERS[f](task.status)) c[f]++;
    return c;
  }, [ofKind]);
  const shown = useMemo(() => {
    const query = q.trim().toLowerCase();
    return ofKind
      .filter((task) => FILTERS[filter](task.status))
      .filter((task) => !query || task.title.toLowerCase().includes(query) || task.goal.toLowerCase().includes(query))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }, [ofKind, filter, q]);
  const setUp = kind === "schedules" ? (triggers ?? []) : [];
  const empty = KIND_EMPTY[kind];

  const closeCreate = () => {
    setCreating(false);
    if (search) navigate("/tasks", { replace: true });
  };

  return (
    <Page
      title={t("nav.tasks")}
      subtitle={t("tasks.subtitle")}
      actions={
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          {t("tasks.new")}
        </Button>
      }
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <Segmented<Kind> value={kind} onChange={setKind} options={(Object.keys(KIND_LABELS) as Kind[]).map((k) => ({ value: k, label: t(KIND_LABELS[k]) }))} />
        <div className="relative w-full sm:w-52">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("common.search")} className="h-9 rounded-full border-transparent! bg-surface-2! pl-10 focus:border-accent! focus:bg-surface!" aria-label={t("tasks.searchLabel")} />
        </div>
      </div>
      <div className="mb-4">
        {/* Status filters as quiet chips; the ones with nothing in them stay out of the way. */}
        <div className="flex flex-wrap items-center gap-1" role="tablist">
          {(Object.keys(FILTER_LABELS) as Filter[])
            .filter((f) => f === "all" || f === filter || counts[f] > 0)
            .map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
                className={`press inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium ${filter === f ? "bg-fg text-bg" : "text-muted hover:bg-surface-2 hover:text-fg"}`}
              >
                {t(FILTER_LABELS[f])}
                {counts[f] > 0 && <span className={`tabular-nums ${filter === f ? "opacity-60" : "text-muted/70"}`}>{counts[f]}</span>}
              </button>
            ))}
        </div>
      </div>

      {error && <ErrorNote onRetry={load}>{error}</ErrorNote>}
      {!list && !error && <Loading />}
      {setUp.length > 0 && (
        <section className="mb-5">
          <h2 className="mb-1.5 px-3 text-[12px] font-medium text-muted">{t("tasks.setUp")}</h2>
          <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-card">
            {setUp.map((trigger, i) => (
              <button
                key={trigger.id}
                type="button"
                onClick={() => void askInChat(trigger.agentId, t("tasks.trigger.ask", { name: trigger.name }), navigate)}
                className={`group relative flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2/60 ${trigger.enabled ? "" : "opacity-60"}`}
              >
                {i > 0 && <span className="absolute top-0 right-0 left-[52px] h-px bg-border" aria-hidden />}
                <span className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-text">
                  <AlarmClock className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{trigger.name}</div>
                  <div className="mt-0.5 truncate text-xs text-muted">{[agentNames.get(trigger.agentId) ?? trigger.agentId, trigger.machineName, triggerWhen(trigger)].filter(Boolean).join(" · ")}</div>
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted" />
              </button>
            ))}
          </div>
        </section>
      )}
      {list && shown.length === 0 && (setUp.length === 0 || ofKind.length > 0) && (
        <EmptyState
          icon={empty.icon}
          title={ofKind.length ? t("tasks.emptyFiltered") : t(empty.title)}
          hint={ofKind.length ? undefined : t(empty.hint)}
        />
      )}
      {shown.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-card">
          {shown.map((task, i) => {
            const st = taskStatus(task.status);
            const by = CREATED_BY[task.createdBy] ?? CREATED_BY.user;
            const agent = agentList?.find((a) => a.id === task.agentId);
            const running = task.status === "running";
            return (
              <Link key={task.id} href={`/tasks/${task.id}`} className="group relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/60">
                {i > 0 && <span className="absolute top-0 right-0 left-[60px] h-px bg-border" aria-hidden />}
                <AgentAvatar avatar={agent?.avatar} id={task.agentId} name={agent?.name ?? task.agentId} size={30} running={running} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 truncate text-[14.5px] font-medium">{task.title || task.goal}</span>
                    {task.background && <Badge>{t("tasks.background")}</Badge>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted">
                    <span>{agentNames.get(task.agentId) ?? task.agentId}</span>
                    <span className="inline-flex items-center gap-1" title={t(by.label)}>
                      <by.icon className="size-3" />
                      {t(by.label)}
                    </span>
                    {task.resumeAt && task.status === "paused" && (
                      <span className="inline-flex items-center gap-1">
                        <Timer className="size-3" />
                        {t("tasks.resumes", { time: relativeTime(task.resumeAt) })}
                      </span>
                    )}
                    <span className="tabular-nums">{relativeTime(task.updatedAt)}</span>
                  </div>
                </div>
                {running ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent-text">
                    <span className="live-dot size-1.5 rounded-full" />
                    {st.label}
                  </span>
                ) : (
                  <Badge tone={st.tone}>{st.label}</Badge>
                )}
                <ChevronRight className="size-4 shrink-0 text-muted/50 transition-transform group-hover:translate-x-0.5" />
              </Link>
            );
          })}
        </div>
      )}

      <CreateTaskModal open={creating} onClose={closeCreate} />
    </Page>
  );
}

/** When a trigger runs: off, its next run, or what it waits for. */
function triggerWhen(trigger: TriggerSummary): string {
  if (!trigger.enabled) return t("tasks.trigger.off");
  if (trigger.nextRunAt) {
    const today = new Date(trigger.nextRunAt).toDateString() === new Date().toDateString();
    return t("tasks.trigger.next", { time: today ? formatTime(trigger.nextRunAt) : formatDateTime(trigger.nextRunAt) });
  }
  if (trigger.kind === "watch") return t("tasks.trigger.watch");
  if (trigger.kind === "event") return t("tasks.trigger.webhook");
  return trigger.times?.join(", ") ?? "";
}

function CreateTaskModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const agentList = useStore(agents);
  const s = useStore(session);
  const [, navigate] = useLocation();
  const [goal, setGoal] = useState("");
  const [title, setTitle] = useState("");
  const [agentId, setAgentId] = useState("");
  const [background, setBackground] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (open) {
      ensureAgents();
      setError(undefined);
    }
  }, [open]);

  const submit = async () => {
    if (!goal.trim()) return setError(t("tasks.goalRequired"));
    setBusy(true);
    setError(undefined);
    try {
      const task = await api.post<Task>("/api/tasks", { goal: goal.trim(), title: title.trim() || undefined, agentId: agentId || s?.defaultAgent, background });
      toast(t("tasks.created"), "success");
      setGoal("");
      setTitle("");
      onClose();
      navigate(`/tasks/${task.id}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("tasks.new")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            {t("common.create")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t("tasks.goal")} hint={t("tasks.goalHint")}>
          <Textarea
            autoFocus
            rows={5}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder={t("tasks.goalPlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
            }}
          />
        </Field>
        <Field label={t("tasks.title")} hint={t("tasks.titleHint")}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        </Field>
        <Field label={t("tasks.agent")}>
          <Select value={agentId || s?.defaultAgent || ""} onChange={(e) => setAgentId(e.target.value)}>
            {(agentList ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Toggle
          checked={background}
          onChange={setBackground}
          label={
            <span>
              {t("tasks.backgroundTask")}
              <span className="block text-xs text-muted">{t("tasks.backgroundHint")}</span>
            </span>
          }
        />
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Modal>
  );
}
