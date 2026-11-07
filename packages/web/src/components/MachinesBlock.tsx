// The machines in the sidebar: closed, one line with a dot for each computer (and how many are at work); open, the hub's
// computer and the paired ones, and under a busy one who works there and what they do right now. A row opens that
// dialog, group chat or task. Kept current by "machines.activity". A machine with an update on offer (a server's hub, a
// node older than the hub) has "Update" on its row, and a dot on the closed line.

import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowUpCircle, ChevronRight } from "lucide-react";
import { machinesOpen, setMachinesOpen } from "../state/prefs";
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
  offline: "machines.step.offline",
};

/** The turns at work on a machine: not one that only waits for its brains to connect. */
const atWork = (m: MachineActivity) => m.work.filter((w) => w.step !== "offline").length;

function WorkRow({ work, agent, href, onNavigate }: { work: MachineWork; agent?: AgentDef; href: string; onNavigate?: () => void }) {
  const name = agent?.name ?? work.agentId;
  const waiting = work.step === "approval";
  // Waiting for its brains to connect: not at work, and nothing for the person to do.
  const still = waiting || work.step === "offline";
  return (
    <Link
      href={href}
      onClick={onNavigate}
      title={work.title ? `${name}: ${work.title}` : name}
      className="animate-in flex items-center gap-2 rounded-xl py-1 pr-2 pl-[22px] text-xs transition-colors hover:bg-surface/55"
    >
      <AgentAvatar avatar={agent?.avatar} id={work.agentId} name={name} size={18} running={!still} />
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

/**
 * The hub's own computer has a newer Piomio (the desktop app's release, a server's): a plain line above the sidebar's
 * icons, so the update is seen without opening Machines. "Updating…" until the hub runs the new version.
 */
export function AppUpdateButton() {
  const list = useStore(machineActivity);
  const [asked, setAsked] = useState("");
  useEffect(() => ensureMachineActivity(), []);
  const self = list?.find((m) => m.id === "local");
  if (!self?.update) return null;
  const busy = self.updating || asked === self.update;
  const update = () => {
    setAsked(self.update!);
    api.post(`/api/machines/${encodeURIComponent(self.id)}/update`).catch((e: unknown) => {
      setAsked("");
      toast(errorText(e), "error");
    });
  };
  return (
    <div className="px-3 pb-1.5">
      <button
        type="button"
        onClick={update}
        disabled={busy}
        className="press flex w-full items-center gap-2.5 rounded-xl bg-accent-soft px-3 py-2 text-left text-[13px] font-semibold text-accent-text hover:brightness-[0.97] disabled:opacity-80"
      >
        <ArrowUpCircle className={cx("size-[17px] shrink-0", busy && "animate-pulse")} />
        <span className="min-w-0 flex-1 truncate">{busy ? t("machines.updatingApp") : t("machines.updateApp", { version: self.update })}</span>
      </button>
    </div>
  );
}

function MachineRow({ machine, byId, pathOf, onNavigate }: { machine: MachineActivity; byId: Map<string, AgentDef>; pathOf: (w: MachineWork) => string; onNavigate?: () => void }) {
  const busy = atWork(machine) > 0;
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
  const open = useStore(machinesOpen);
  useEffect(() => ensureMachineActivity(), []);
  const byId = useMemo(() => new Map((agentList ?? []).map((a) => [a.id, a])), [agentList]);
  const dialogs = useMemo(() => new Map((members ?? []).map((m) => [m.conversationId, m.agentId])), [members]);
  if (!list?.length) return null;

  const pathOf = (w: MachineWork) => {
    if (w.taskId) return `/tasks/${encodeURIComponent(w.taskId)}`;
    const agentId = dialogs.get(w.conversationId);
    return agentId ? agentPath(agentId, s?.defaultAgent) : groupPath(w.conversationId);
  };

  const working = list.reduce((n, m) => n + atWork(m), 0);
  const update = list.some((m) => m.update && !m.updating);
  return (
    <section aria-label={t("nav.machines")} className="max-h-[40%] shrink-0 overflow-y-auto px-2 pb-1">
      <button
        type="button"
        onClick={() => setMachinesOpen(!open)}
        aria-expanded={open}
        className="press flex w-full items-center gap-2 rounded-xl py-1 pr-2.5 pl-3 text-left text-[12px] font-medium text-muted hover:bg-surface/55 hover:text-fg"
      >
        <span>{t("nav.machines")}</span>
        {!open && (
          <span className="flex items-center gap-1" aria-hidden>
            {list.map((m) => (
              <span key={m.id} title={m.name} className={cx("size-1.5 rounded-full", !m.online ? "ring-1 ring-muted/60" : atWork(m) ? "live-dot" : "bg-success")} />
            ))}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-right">{!open && working > 0 ? t("machines.working", { n: working }) : ""}</span>
        {!open && update && <span className="size-1.5 shrink-0 rounded-full bg-accent" title={t("machines.update")} />}
        <ChevronRight className={cx("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <ul className="flex flex-col gap-0.5">
          {list.map((m) => (
            <MachineRow key={m.id} machine={m} byId={byId} pathOf={pathOf} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
    </section>
  );
}
