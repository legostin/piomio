// Task detail: summary, cancel/retry, and the task's conversation. A teammate's thread (team_message) reads as the
// two agents' conversation: both of them on top, no job summary.

import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, ArrowLeftRight, Ban, ChevronDown, RotateCcw } from "lucide-react";
import type { Task } from "@piomio/shared";
import { useStore } from "../lib/store";
import { api, errorText } from "../lib/api";
import { ACTIVE_STATUSES, formatDateTime, relativeTime, taskStatus, threadStatus } from "../lib/format";
import { agents, ensureAgents, hubEvents, reconnected, tasks } from "../state/app";
import { toast } from "../state/toast";
import { t, tRich } from "../i18n";
import { Markdown } from "../components/markdown";
import { Badge, Button, EmptyState, ErrorNote, Loading } from "../components/ui";
import { AgentAvatar } from "../components/AgentAvatar";
import { ChatView } from "./chat/ChatView";
import { TopBar } from "../components/Layout";

export function TaskDetailPage({ id }: { id: string }) {
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<"cancel" | "retry" | undefined>();
  const [expanded, setExpanded] = useState(false);
  const agentList = useStore(agents);
  const cached = useStore(tasks)?.find((x) => x.id === id);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.get<Task>(`/api/tasks/${encodeURIComponent(id)}`).then(
        (loaded) => alive && setTask(loaded),
        (e) => alive && setError(errorText(e)),
      );
    setTask(null);
    setError(undefined);
    void load();
    ensureAgents();
    const off1 = hubEvents.on((e) => {
      if (e.type === "task.updated" && e.data.id === id) setTask(e.data);
    });
    const off2 = reconnected.on(() => void load());
    return () => {
      alive = false;
      off1();
      off2();
    };
  }, [id]);

  const current = task ?? cached ?? null;
  const agentName = useMemo(() => (current ? (agentList?.find((a) => a.id === current.agentId)?.name ?? current.agentId) : ""), [agentList, current]);

  if (error && !current)
    return (
      <div className="p-6">
        <EmptyState icon="list-todo" title={t("task.notFound")} hint={error} />
        <div className="flex justify-center">
          <Link href="/tasks" className="text-sm text-accent-text underline">
            {t("task.toList")}
          </Link>
        </div>
      </div>
    );
  if (!current) return <Loading />;

  const thread = current.kind === "message";
  const st = thread ? threadStatus(current.status) : taskStatus(current.status);
  const active = ACTIVE_STATUSES.includes(current.status);
  // A thread goes on when its sender writes again; only one that broke off can be retried.
  const canRetry = (thread ? ["failed", "interrupted"] : ["failed", "cancelled", "interrupted", "paused", "done"]).includes(current.status);
  const from = thread && current.from ? (agentList?.find((a) => a.id === current.from) ?? { id: current.from, name: current.from, avatar: undefined }) : undefined;
  const to = agentList?.find((a) => a.id === current.agentId);

  const act = async (kind: "cancel" | "retry") => {
    setBusy(kind);
    try {
      const r = await api.post<Task & { error?: string }>(`/api/tasks/${encodeURIComponent(current.id)}/${kind}`, {});
      if (r && (r as { error?: string }).error && !r.id) throw new Error(t("task.notFound"));
      if (r?.id) setTask(r);
      toast(kind === "cancel" ? t("task.cancelled") : t("task.requeued"), "success");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(undefined);
    }
  };

  const running = current.status === "running";
  const summary = (
    <div className="rounded-[22px] border border-hairline bg-surface p-4 shadow-card">
      <div className="flex items-center gap-2.5">
        <AgentAvatar avatar={to?.avatar} id={current.agentId} name={agentName} size={26} running={running} />
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          <span className="font-semibold text-fg">{agentName}</span>
          {" · "}{t("task.createdAt", { time: formatDateTime(current.createdAt) })}
          {current.resumeAt && current.status === "paused" ? ` · ${t("tasks.resumes", { time: relativeTime(current.resumeAt) })}` : ""}
        </span>
        {current.background && <Badge>{t("tasks.background")}</Badge>}
        {running ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent-text">
            <span className="live-dot size-1.5 rounded-full" />
            {st.label}
          </span>
        ) : (
          <Badge tone={st.tone}>{st.label}</Badge>
        )}
        {/* Opens and folds the goal and result; no row of its own. */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? t("task.collapse") : t("task.expand")}
          title={expanded ? t("task.collapse") : t("task.expand")}
          className="press -mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
        >
          <ChevronDown className={expanded ? "size-4 rotate-180 transition-transform duration-300" : "size-4 transition-transform duration-300"} />
        </button>
      </div>
      {current.question && (
        <div className="mt-3 rounded-2xl bg-warning-soft px-3.5 py-2.5 text-sm">
          <div className="mb-0.5 text-xs font-semibold text-warning">{t("task.question")}</div>
          {current.question}
        </div>
      )}
      <div
        onClick={expanded ? undefined : () => setExpanded(true)}
        className={expanded ? "mt-3" : "mt-3 max-h-24 cursor-pointer overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]"}
      >
        <div className="mb-1 text-xs font-medium text-muted">{t("task.goal")}</div>
        <Markdown text={current.goal} className="text-sm" />
        {current.result && (
          <>
            <div className="mt-3 mb-1 text-xs font-medium text-muted">{t("task.result")}</div>
            <Markdown text={current.result} className="text-sm" />
          </>
        )}
      </div>
      {current.error && (
        <div className="mt-2">
          <ErrorNote>{current.error}</ErrorNote>
        </div>
      )}
      {current.parentTaskId && (
        <div className="mt-2 text-xs text-muted">
          {tRich("task.subtaskOf", {
            parent: (
              <Link href={`/tasks/${current.parentTaskId}`} className="text-accent-text underline">
                {t("task.parent")}
              </Link>
            ),
          })}
        </div>
      )}
    </div>
  );

  const hint = (
    <div className="flex flex-col gap-2">
      <div className="text-center text-xs text-muted">{t("thread.hint")}</div>
      {current.error && <ErrorNote>{current.error}</ErrorNote>}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <TopBar>
        <Link href="/tasks" aria-label={t("task.toTasks")} className="press inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg">
          <ArrowLeft className="size-[18px]" />
        </Link>
        {thread ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[15px] font-semibold" title={current.title}>
            {from && (
              <>
                <AgentAvatar avatar={from.avatar} id={from.id} name={from.name} size={22} />
                <span className="min-w-0 truncate">{from.name}</span>
                <ArrowLeftRight className="size-3.5 shrink-0 text-muted" aria-hidden />
              </>
            )}
            <AgentAvatar avatar={to?.avatar} id={current.agentId} name={agentName} size={22} />
            <span className="min-w-0 truncate">{agentName}</span>
            <Badge tone={st.tone} dot={current.status === "running"} className="ml-1 shrink-0">
              {st.label}
            </Badge>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[14.5px] font-semibold">{current.title || t("task.untitled")}</span>
        )}
        {active && (
          <Button size="sm" variant="ghost" className="text-danger!" icon={<Ban className="size-3.5" />} onClick={() => void act("cancel")} loading={busy === "cancel"}>
            {t("task.cancel")}
          </Button>
        )}
        {canRetry && (
          <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => void act("retry")} loading={busy === "retry"}>
            {t("common.retry")}
          </Button>
        )}
      </TopBar>
      <div className="min-h-0 flex-1">
        <ChatView conversationId={current.conversationId} header={false} top={thread ? hint : summary} emptyHint={t("task.notStarted")} />
      </div>
    </div>
  );
}
