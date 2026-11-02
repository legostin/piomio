// The machines in the sidebar: the hub's computer and the paired ones, a dot for each, and under a busy one who works
// there and what they do right now. A row opens that dialog, group chat or task. Kept current by "machines.activity".
// A machine with an update on offer (a server's hub, a node older than the hub) has "Update" on its row.

import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import type { AgentDef, MachineActivity, MachineWork, WorkStep } from "@piomio/shared";
import { useStore } from "../lib/store";
import { agentPath, groupPath } from "../lib/team";
import { agents, ensureMachineActivity, machineActivity, session, team } from "../state/app";
import { AgentAvatar } from "./AgentAvatar";
import { cx } from "./ui";
import { t, type MessageKey } from "../i18n";
import { api, errorText } from "../lib/api";
import { toast } from "../state/toast";

const STEP: Record<WorkStep, MessageKey> = {
  thinking: "machines.step.thinking",
  writing: "machines.step.writing",
  command: "machines.step.command",
  reading: "machines.step.reading",
  editing: "machines.step.editing",
  web: "machines.step.web",
  tool: "machines.step.tool",
  approval: "machines.step.approval",
};

function WorkRow({ work, agent, href, onNavigate }: { work: MachineWork; agent?: AgentDef; href: string; onNavigate?: () => void }) {
  const name = agent?.name ?? work.agentId;
  const waiting = work.step === "approval";
  return (
    <Link
      href={href}
      onClick={onNavigate}
      title={work.title ? `${name}: ${work.title}` : name}
      className="animate-in flex items-center gap-2 rounded-xl py-1 pr-2 pl-[22px] text-xs transition-colors hover:bg-surface/55"
    >
      <AgentAvatar avatar={agent?.avatar} id={work.agentId} name={name} size={18} running={!waiting} />
      <span className="min-w-0 flex-1 truncate text-fg">{work.title ?? name}</span>
      <span className={cx("shrink-0", waiting ? "text-warning" : "text-muted")}>{t(STEP[work.step])}</span>
    </Link>
  );
}

/**
 * "Update" until it is pressed, then "Updating…" until the machine runs the new version; an update that ended without
 * it (the desktop app could not install) shows "Update" again, since the row's key changes with `updating`.
 */
function UpdateButton({ machine }: { machine: MachineActivity }) {
  const [asked, setAsked] = useState(false);
  if (!machine.update) return null;
  if (machine.updating || asked) return <span className="shrink-0 text-[12px] text-muted">{t("machines.updating")}</span>;
  const update = () => {
    setAsked(true);
    api.post(`/api/machines/${encodeURIComponent(machine.id)}/update`).catch((e: unknown) => {
      setAsked(false);
      toast(errorText(e), "error");
    });
  };
  return (
    <button type="button" onClick={update} title={t("machines.updateTo", { version: machine.update })} className="shrink-0 text-[12px] font-medium text-accent-text hover:underline">
      {t("machines.update")}
    </button>
  );
}

function MachineRow({ machine, byId, pathOf, onNavigate }: { machine: MachineActivity; byId: Map<string, AgentDef>; pathOf: (w: MachineWork) => string; onNavigate?: () => void }) {
  const busy = machine.work.length > 0;
  return (
    <li>
      <div className="flex items-center gap-2.5 px-2.5 py-1" title={t(machine.online ? "machines.online" : "machines.offline")}>
        <span className={cx("size-1.5 shrink-0 rounded-full", !machine.online ? "ring-1 ring-muted/60" : busy ? "live-dot" : "bg-success")} />
        <span className={cx("min-w-0 flex-1 truncate text-[13px]", machine.online ? "text-fg" : "text-muted")}>{machine.name}</span>
        <UpdateButton key={`${machine.update}:${!!machine.updating}`} machine={machine} />
      </div>
      {machine.work.map((w) => (
        <WorkRow key={`${w.conversationId}:${w.agentId}`} work={w} agent={byId.get(w.agentId)} href={pathOf(w)} onNavigate={onNavigate} />
      ))}
    </li>
  );
}

export function MachinesBlock({ onNavigate }: { onNavigate?: () => void }) {
  const list = useStore(machineActivity);
  const agentList = useStore(agents);
  const members = useStore(team);
  const s = useStore(session);
  useEffect(() => ensureMachineActivity(), []);
  const byId = useMemo(() => new Map((agentList ?? []).map((a) => [a.id, a])), [agentList]);
  const dialogs = useMemo(() => new Map((members ?? []).map((m) => [m.conversationId, m.agentId])), [members]);
  if (!list?.length) return null;

  const pathOf = (w: MachineWork) => {
    if (w.taskId) return `/tasks/${encodeURIComponent(w.taskId)}`;
    const agentId = dialogs.get(w.conversationId);
    return agentId ? agentPath(agentId, s?.defaultAgent) : groupPath(w.conversationId);
  };

  return (
    <section aria-label={t("nav.machines")} className="max-h-[40%] shrink-0 overflow-y-auto px-2 pb-2">
      <div className="pt-1 pb-1 pl-3 text-[12px] font-medium text-muted">{t("nav.machines")}</div>
      <ul className="flex flex-col gap-0.5">
        {list.map((m) => (
          <MachineRow key={m.id} machine={m} byId={byId} pathOf={pathOf} onNavigate={onNavigate} />
        ))}
      </ul>
    </section>
  );
}
