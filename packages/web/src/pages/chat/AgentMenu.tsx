// The agent's menu (a right click on its row, a long press on a touch screen, "⋯" on hover) and what follows it: who
// becomes the default when the default agent goes, the confirmation before deleting, and the bar an archived agent's
// dialog shows instead of the composer.

import { useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Archive, ArchiveRestore, CheckCheck, Ellipsis, MessageSquareDot, Pin, PinOff, Plus, SlidersHorizontal, Star, Trash2 } from "lucide-react";
import type { AgentDef } from "@piomio/shared";
import { useStore } from "../../lib/store";
import { errorText } from "../../lib/api";
import { agentForPath, agentMenuActions, agentPath, successorsOf, type AgentMenuAction } from "../../lib/team";
import type { MenuAnchor } from "../../lib/menu";
import { agents, markRead, markUnread, session, team } from "../../state/app";
import { archiveAgent, deleteAgent, makeDefaultAgent, pinAgent } from "../../state/agentActions";
import { addAgent, editAgent } from "../../state/panel";
import { toast } from "../../state/toast";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { AgentAvatar } from "../../components/AgentAvatar";
import { Button, cx, Modal, Spinner } from "../../components/ui";
import { t, type MessageKey } from "../../i18n";

/** What follows a menu item for the default agent (pick a successor) and before deleting (confirm). */
type Flow = { step: "successor"; action: "archive" | "delete"; agent: AgentDef } | { step: "delete"; agent: AgentDef; successor?: AgentDef };

const ICONS: Record<AgentMenuAction, ReactNode> = {
  pin: <Pin className="size-4" />,
  unpin: <PinOff className="size-4" />,
  unread: <MessageSquareDot className="size-4" />,
  read: <CheckCheck className="size-4" />,
  default: <Star className="size-4" />,
  settings: <SlidersHorizontal className="size-4" />,
  archive: <Archive className="size-4" />,
  restore: <ArchiveRestore className="size-4" />,
  delete: <Trash2 className="size-4" />,
};

const LABELS: Record<AgentMenuAction, MessageKey> = {
  pin: "agentMenu.pin",
  unpin: "agentMenu.unpin",
  unread: "agentMenu.markUnread",
  read: "agentMenu.markRead",
  default: "agentMenu.makeDefault",
  settings: "agent.settings",
  archive: "agentMenu.archive",
  restore: "agentMenu.restore",
  delete: "agentMenu.delete",
};

/** A hub call from the menu: its error, in the hub's words, as a toast. */
function run(work: Promise<unknown>, done?: string): Promise<boolean> {
  return work.then(
    () => {
      if (done) toast(done, "success");
      return true;
    },
    (e) => {
      toast(errorText(e), "error");
      return false;
    },
  );
}

export interface AgentMenuApi {
  /** Opens the agent's menu at a point or under a box. */
  open: (agentId: string, anchor: MenuAnchor) => void;
  /** "⋯": opens it, or closes it when it is open for this agent. */
  toggle: (agentId: string, anchor: MenuAnchor) => void;
  /** The agent whose menu is open. */
  openFor?: string;
  /** Delete, with the successor first for the default agent (the Agents settings use it too). */
  requestDelete: (agent: AgentDef) => void;
  /** The menu and its dialogs: render once. */
  element: ReactNode;
}

/** One agent menu with its dialogs for a list of agents. `onNavigate` closes the phone's drawer. */
export function useAgentMenu({ onNavigate }: { onNavigate?: () => void } = {}): AgentMenuApi {
  const agentList = useStore(agents);
  const members = useStore(team);
  const s = useStore(session);
  const [loc, navigate] = useLocation();
  const [menu, setMenu] = useState<{ agentId: string; anchor: MenuAnchor } | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const defaultAgent = s?.defaultAgent;

  const agent = menu ? agentList?.find((a) => a.id === menu.agentId) : undefined;
  const member = menu ? members?.find((m) => m.agentId === menu.agentId) : undefined;
  /** Whose dialog is on screen. */
  const openDialog = agentForPath(loc, defaultAgent);

  const requestDelete = (a: AgentDef) => setFlow(a.id === defaultAgent ? { step: "successor", action: "delete", agent: a } : { step: "delete", agent: a });

  const act = (action: AgentMenuAction, a: AgentDef) => {
    const conversationId = members?.find((m) => m.agentId === a.id)?.conversationId;
    switch (action) {
      case "pin":
      case "unpin":
        return void run(pinAgent(a.id, action === "pin"));
      case "unread":
        if (conversationId) void run(markUnread(conversationId));
        return;
      case "read":
        if (conversationId) void markRead(conversationId);
        return;
      case "default": {
        // The dialog on screen stays on screen: the old default's moves from "/" to its own address, the new one's to "/".
        const atRoot = loc === "/";
        if (atRoot && defaultAgent) navigate(agentPath(defaultAgent, a.id), { replace: true });
        const ownOpen = !atRoot && openDialog === a.id;
        void run(makeDefaultAgent(a.id)).then((ok) => {
          if (ok && ownOpen) navigate("/", { replace: true });
        });
        return;
      }
      case "settings":
        editAgent(a.id);
        onNavigate?.();
        return;
      case "archive":
        if (a.id === defaultAgent) return setFlow({ step: "successor", action: "archive", agent: a });
        return void run(archiveAgent(a.id, true), t("agentMenu.archived", { name: a.name }));
      case "restore":
        return void run(archiveAgent(a.id, false), t("agentMenu.restored", { name: a.name }));
      case "delete":
        return requestDelete(a);
    }
  };

  const items: MenuItem[] = agent
    ? agentMenuActions({
        isDefault: agent.id === defaultAgent,
        archived: agent.archived,
        pinned: member?.pinned !== undefined,
        unread: member?.unread ?? 0,
        hasMessages: !!member?.lastMessage,
      }).map((action) => ({
        id: action,
        label: t(LABELS[action]),
        icon: ICONS[action],
        danger: action === "delete",
        divider: action === "archive" || (action === "delete" && !!agent.archived),
        onSelect: () => act(action, agent),
      }))
    : [];

  /** The person picked the default agent's successor. */
  const succeed = async (successor: AgentDef) => {
    if (!flow || flow.step !== "successor") return;
    if (flow.action === "delete") return setFlow({ step: "delete", agent: flow.agent, successor });
    const ok = await run(archiveAgent(flow.agent.id, true, successor.id), t("agentMenu.archivedSuccessor", { name: flow.agent.name, successor: successor.name }));
    if (ok) setFlow(null);
  };

  const confirmDelete = async (archiveInstead: boolean) => {
    if (!flow || flow.step !== "delete") return;
    const { agent: a, successor } = flow;
    const wasOpen = openDialog === a.id;
    const done = archiveInstead
      ? successor
        ? t("agentMenu.archivedSuccessor", { name: a.name, successor: successor.name })
        : t("agentMenu.archived", { name: a.name })
      : successor
        ? t("agentMenu.deletedSuccessor", { name: a.name, successor: successor.name })
        : t("agents.deleted", { name: a.name });
    // Its dialog, if on screen, gives way to the default agent's before the list forgets it.
    const leave = () => wasOpen && navigate("/");
    const ok = await run(archiveInstead ? archiveAgent(a.id, true, successor?.id) : deleteAgent(a.id, successor?.id, leave), done);
    if (ok) setFlow(null);
  };

  const element = (
    <>
      {menu && agent && <ContextMenu key={agent.id} anchor={menu.anchor} items={items} label={agent.name} onClose={() => setMenu(null)} />}
      <SuccessorDialog
        flow={flow?.step === "successor" ? flow : undefined}
        candidates={flow ? successorsOf(flow.agent.id, agentList ?? [], members ?? []) : []}
        onPick={succeed}
        onNew={() => {
          setFlow(null);
          addAgent();
          onNavigate?.();
        }}
        onClose={() => setFlow(null)}
      />
      <DeleteDialog flow={flow?.step === "delete" ? flow : undefined} onConfirm={(archiveInstead) => confirmDelete(archiveInstead)} onClose={() => setFlow(null)} />
    </>
  );

  return {
    open: (agentId, anchor) => setMenu({ agentId, anchor }),
    toggle: (agentId, anchor) => setMenu((m) => (m?.agentId === agentId ? null : { agentId, anchor })),
    openFor: menu?.agentId,
    requestDelete,
    element,
  };
}

/** "Who becomes the default?": the other active agents, and making a new one in the chat. */
function SuccessorDialog({
  flow,
  candidates,
  onPick,
  onNew,
  onClose,
}: {
  flow?: Extract<Flow, { step: "successor" }>;
  candidates: AgentDef[];
  onPick: (a: AgentDef) => Promise<void> | void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string>();
  const row = "press flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left hover:bg-surface-2 disabled:opacity-50";
  return (
    <Modal open={!!flow} onClose={onClose} title={t("agentMenu.successor.title")}>
      {flow && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            {candidates.length ? t("agentMenu.successor.hint", { name: flow.agent.name }) : t("agentMenu.successor.none")}
          </p>
          <div className="-mx-2.5 flex flex-col">
            {candidates.map((a) => (
              <button
                key={a.id}
                type="button"
                disabled={!!busy}
                onClick={async () => {
                  setBusy(a.id);
                  try {
                    await onPick(a);
                  } finally {
                    setBusy(undefined);
                  }
                }}
                className={row}
              >
                <AgentAvatar avatar={a.avatar} id={a.id} name={a.name} size={34} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium">{a.name}</span>
                  {a.description && <span className="block truncate text-[12.5px] text-muted">{a.description}</span>}
                </span>
                {busy === a.id && <Spinner size={16} />}
              </button>
            ))}
            <button type="button" disabled={!!busy} onClick={onNew} className={cx(row, "group text-[14px] font-medium text-muted hover:text-fg")}>
              <span className="flex size-[34px] shrink-0 items-center justify-center rounded-full border border-dashed border-muted/40 transition-colors group-hover:border-accent group-hover:bg-accent-soft group-hover:text-accent-text">
                <Plus className="size-4" />
              </span>
              {t("agentMenu.successor.new")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** "Delete <name>?": what goes for good, and the archive as the way to keep it. */
function DeleteDialog({ flow, onConfirm, onClose }: { flow?: Extract<Flow, { step: "delete" }>; onConfirm: (archiveInstead: boolean) => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState<"delete" | "archive">();
  const go = async (what: "delete" | "archive") => {
    setBusy(what);
    try {
      await onConfirm(what === "archive");
    } finally {
      setBusy(undefined);
    }
  };
  const archived = !!flow?.agent.archived;
  return (
    <Modal
      open={!!flow}
      onClose={onClose}
      title={flow ? t("agentMenu.deleteTitle", { name: flow.agent.name }) : ""}
      footer={
        <>
          {!archived && (
            <Button variant="ghost" className="mr-auto" disabled={!!busy} loading={busy === "archive"} onClick={() => void go("archive")}>
              {t("agentMenu.archiveInstead")}
            </Button>
          )}
          <Button onClick={onClose} disabled={!!busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" disabled={!!busy} loading={busy === "delete"} onClick={() => void go("delete")}>
            {t("agentMenu.delete")}
          </Button>
        </>
      }
    >
      {flow && (
        <div className="flex flex-col gap-2 text-sm">
          <p>{t(archived ? "agentMenu.deleteTextArchived" : "agentMenu.deleteText")}</p>
          {flow.successor && <p className="text-muted">{t("agentMenu.deleteSuccessor", { name: flow.successor.name })}</p>}
        </div>
      )}
    </Modal>
  );
}

/** "⋯" on a row (inside a `group/agent`): only on hover or keyboard focus (and while its menu is open); touch screens use a long press. */
export function MoreButton({ label, open, onOpen, className }: { label: string; open: boolean; onOpen: (anchor: MenuAnchor) => void; className?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      aria-expanded={open}
      // The menu closes on a press elsewhere: this press toggles it instead.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onOpen({ box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
      }}
      // Hidden, it lets taps through to the row (touch screens have no hover: a long press opens the menu there).
      className={cx(
        "press absolute z-10 flex size-7 items-center justify-center rounded-full bg-surface text-muted shadow-card hover:text-fg",
        "group-hover/agent:pointer-events-auto group-hover/agent:opacity-100 group-has-[:focus-visible]/agent:pointer-events-auto group-has-[:focus-visible]/agent:opacity-100",
        open ? "opacity-100" : "pointer-events-none opacity-0",
        className,
      )}
    >
      <Ellipsis className="size-4" />
    </button>
  );
}

/** Instead of the composer in an archived agent's dialog: nobody writes there until it comes back. */
export function ArchivedBar({ agent }: { agent: Pick<AgentDef, "id" | "name"> }) {
  const [busy, setBusy] = useState(false);
  const restore = async () => {
    setBusy(true);
    await run(archiveAgent(agent.id, false), t("agentMenu.restored", { name: agent.name }));
    setBusy(false);
  };
  return (
    <div className="flex items-center gap-3 rounded-[26px] border border-hairline bg-surface py-1.5 pr-1.5 pl-4 shadow-pop">
      <Archive className="size-4 shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate text-[13.5px] text-muted">{t("agent.archivedBar", { name: agent.name })}</span>
      <Button size="sm" variant="primary" loading={busy} onClick={() => void restore()} icon={<ArchiveRestore className="size-3.5" />}>
        {t("agentMenu.restore")}
      </Button>
    </div>
  );
}
