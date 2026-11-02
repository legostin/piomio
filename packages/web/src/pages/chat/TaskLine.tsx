// A task the agent started (a `task` part): one quiet line in its reply with who works on it, where, and how it goes,
// kept live by "task.updated". It opens the task; the work itself stays there.
// A message to a teammate (a `task` part with `text`) shows as the message itself: who wrote to whom, what, how it
// goes, and the answer right under it once it came. It opens the thread.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ArrowRight, ChevronDown, Target } from "lucide-react";
import type { AgentDef, Task } from "@piomio/shared";
import { goalLimit } from "@piomio/shared/commands";
import { useStore } from "../../lib/store";
import { taskStatus, threadStatus, type Tone } from "../../lib/format";
import { agents, ensureAgents, ensureMachineActivity, ensureTasks, machineActivity, tasks } from "../../state/app";
import { brainMachine, brains } from "../../state/brains";
import { stepText, useWork } from "./LiveStep";
import { AgentAvatar } from "../../components/AgentAvatar";
import { Markdown } from "../../components/markdown";
import { cx } from "../../components/ui";
import { t } from "../../i18n";

const toneText = (tone: Tone) => (tone === "warning" ? "text-warning" : tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : "text-muted");

export function TaskLine({ taskId, text, reply, from }: { taskId: string; text?: string; reply?: string; from?: string }) {
  const list = useStore(tasks);
  const agentList = useStore(agents);
  const machines = useStore(machineActivity);
  const brainList = useStore(brains);
  const work = useWork({ taskId });
  useEffect(() => {
    ensureTasks();
    ensureAgents();
    ensureMachineActivity();
  }, []);
  const task = useMemo(() => list?.find((x) => x.id === taskId), [list, taskId]);
  if (!task) return null;
  if (text !== undefined) return <MessageLine task={task} text={text} reply={reply} from={from ?? task.from} agentList={agentList} />;
  const agent = agentList?.find((a) => a.id === task.agentId);
  const name = agent?.name ?? task.agentId;
  const machineId = task.brainRef ? brainMachine(task.brainRef) : "local";
  const where = machineId === "local" ? undefined : (machines?.find((m) => m.id === machineId)?.name ?? machineId);
  const st = taskStatus(task.status);
  const working = task.status === "running" || task.status === "queued";
  // While it runs: what it does now ("Thinking…", "Reading plan.md…"), else its state.
  const now = task.status === "running" && work ? stepText(work) : undefined;
  // The brain and depth chosen for it, in a word each.
  const brainName = task.thinking?.brain ? (brainList?.find((b) => b.ref === task.thinking!.brain || b.ref.split("@")[0] === task.thinking!.brain)?.label ?? task.thinking.brain) : undefined;
  const how = [brainName, task.thinking?.preset ? t(`thinking.preset.${task.thinking.preset}`) : undefined].filter(Boolean).join(" · ");
  // A long goal (/goal): its mark, and while it goes, the round it is on.
  const goal = task.kind === "goal";
  const rounds = task.rounds ?? 0;
  const round = goal && working ? t("task.goalRound", { n: rounds + 1, of: goalLimit(rounds) }) : undefined;
  return (
    <Link
      href={`/tasks/${encodeURIComponent(task.id)}`}
      title={`${name}: ${task.title}`}
      className="press flex w-full max-w-md items-center gap-2.5 rounded-full border border-hairline bg-surface/70 py-1.5 pr-3.5 pl-1.5 text-[13px] hover:bg-surface"
    >
      <AgentAvatar avatar={agent?.avatar} id={task.agentId} name={name} size={22} running={task.status === "running"} />
      {goal && <Target className="size-3.5 shrink-0 text-accent-text" aria-label={t("task.goal")} />}
      <span className="min-w-0 flex-1 truncate font-medium text-fg">{task.title}</span>
      {/* While it works, its step says more than the brain it runs on. */}
      {(where || round || (how && !now)) && <span className="hidden shrink-0 text-xs text-muted sm:inline">{[where, round, now ? undefined : how].filter(Boolean).join(" · ")}</span>}
      <Status label={now ?? st.label} tone={st.tone} working={working} />
    </Link>
  );
}

/** A task's state: a word in its tone, with a breathing amber dot while it works. */
function Status({ label, tone, working }: { label: string; tone: Tone; working: boolean }) {
  return (
    <span className={cx("inline-flex max-w-[45%] min-w-0 shrink-0 items-center gap-1.5 text-xs font-medium", working ? "text-accent-text" : toneText(tone))}>
      {working && <span className="live-dot size-1.5 shrink-0 rounded-full" />}
      <span className="truncate">{label}</span>
    </span>
  );
}

/** What one agent wrote to a teammate, and the teammate's answer under it. */
function MessageLine({ task, text, reply, from, agentList }: { task: Task; text: string; reply?: string; from?: string; agentList: AgentDef[] | null }) {
  const [open, setOpen] = useState(false);
  const [cutText, setCutText] = useState(false);
  const [cutAnswer, setCutAnswer] = useState(false);
  const sender = from ? agentList?.find((a) => a.id === from) : undefined;
  const to = agentList?.find((a) => a.id === task.agentId);
  const toName = to?.name ?? task.agentId;
  // One turn may answer two messages at once: the later line shows the thread's last answer.
  const answer = reply ?? (task.status === "done" ? task.result : undefined);
  const st = threadStatus(task.status);
  const working = task.status === "running" || task.status === "queued";
  // Cut text opens with a click on it, or on the chevron in the header line: no row of its own for that.
  const foldable = open || cutText || (!!answer && cutAnswer);
  return (
    <div className="w-full max-w-md rounded-[20px] border border-hairline bg-surface px-3.5 py-2.5 text-sm shadow-card">
      <div className="flex items-center gap-1.5">
        <Link
          href={`/tasks/${encodeURIComponent(task.id)}`}
          title={t("thread.open")}
          className="press -mx-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-full px-1 py-0.5 text-xs hover:bg-surface-2"
        >
          {from && <AgentAvatar avatar={sender?.avatar} id={from} name={sender?.name ?? from} size={20} />}
          <ArrowRight className="size-3 shrink-0 text-muted" aria-hidden />
          <AgentAvatar avatar={to?.avatar} id={task.agentId} name={toName} size={20} running={task.status === "running"} />
          <span className="min-w-0 flex-1 truncate font-semibold text-fg">{toName}</span>
          <Status label={st.label} tone={st.tone} working={working} />
        </Link>
        {foldable && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-label={open ? t("task.collapse") : t("task.expand")}
            title={open ? t("task.collapse") : t("task.expand")}
            className="press -mr-1 flex size-6 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
          >
            <ChevronDown className={cx("size-3.5 transition-transform duration-300", open && "rotate-180")} />
          </button>
        )}
      </div>
      <div className={cx(foldable && !open && "cursor-pointer")} onClick={foldable && !open ? () => setOpen(true) : undefined}>
        <Clamp open={open} lines={answer ? 2 : 4} onCut={setCutText}>
          <div className="mt-1.5 whitespace-pre-wrap break-words text-fg">{text}</div>
        </Clamp>
        {answer && (
          <div className="mt-2 flex gap-2 rounded-2xl bg-surface-2/70 px-2.5 py-2">
            <AgentAvatar avatar={to?.avatar} id={task.agentId} name={toName} size={18} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <Clamp open={open} lines={3} onCut={setCutAnswer}>
                <Markdown text={answer} className="text-sm" />
              </Clamp>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Its content cut to about `lines` lines and faded out unless `open`; `onCut` hears whether anything is cut off. */
function Clamp({ open, lines, onCut, children }: { open: boolean; lines: number; onCut: (cut: boolean) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const check = () => {
      const c = el.scrollHeight > el.clientHeight + 2;
      setCut(c);
      onCut(c);
    };
    check();
    const ro = new ResizeObserver(check);
    // The box stops growing at its cap; its content keeps growing (an answer arriving), so watch that too.
    for (const c of [el, ...Array.from(el.children)]) ro.observe(c);
    return () => ro.disconnect();
  }, [lines, open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div
      ref={ref}
      style={open ? undefined : { maxHeight: `${lines * 1.5}rem` }}
      className={cx(!open && "overflow-hidden", !open && cut && "[mask-image:linear-gradient(to_bottom,black_55%,transparent)]")}
    >
      {children}
    </div>
  );
}
