// The sidebar's tabs: the team (every agent with its one long-lived dialog), the group chats and the channels. A row
// shows who said what last, whether someone is working right now and how much is unread; "Add agent" opens the
// new-agent form, "New group" the form for a chat with several agents, "New channel" the form for a channel.
// The default agent sits large on top, the pinned under it; every agent has a menu (right click, a long press, "⋯"),
// and the archived ones wait behind "Archive · N" at the end.

import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { Archive, ArrowLeft, ChevronRight, Pin, Plus, Star, UsersRound } from "lucide-react";
import type { AgentDef, GroupChat, TeamMember } from "@piomio/shared";
import { useStore } from "../../lib/store";
import { shortTime } from "../../lib/format";
import { agentPath, groupOrder, groupPath, teamOrder } from "../../lib/team";
import { agents, ensureAgents, ensureGroups, ensureTeam, groups, session, team } from "../../state/app";
import { ensureFeeds, feeds, unreadPosts } from "../../state/feeds";
import { addAgent } from "../../state/panel";
import { setSidebarTab, sidebarTab, type SidebarTab } from "../../state/prefs";
import { AgentAvatar, AvatarPair } from "../../components/AgentAvatar";
import { UnreadBadge } from "../../components/UnreadBadge";
import { menuAnchorFor, useLongPress } from "../../components/ContextMenu";
import { cx, IconButton, Segmented, Spinner } from "../../components/ui";
import { t } from "../../i18n";
import { GroupDialog } from "./GroupDialog";
import { MoreButton, useAgentMenu, type AgentMenuApi } from "./AgentMenu";
import { ChannelList } from "../channels/ChannelList";

/** Right click, a long press and the menu key open the agent's menu; iOS shows no link preview of its own. */
function useMenuTriggers(agentId: string, menu: AgentMenuApi) {
  const press = useLongPress((anchor) => menu.open(agentId, anchor));
  return {
    ...press,
    onContextMenu: (e: React.MouseEvent<HTMLElement>) => {
      e.preventDefault();
      menu.open(agentId, menuAnchorFor(e));
    },
  };
}

/** Keeps a row's text from being selected by a long press, and iOS from previewing its link. */
const NO_CALLOUT = "select-none [-webkit-touch-callout:none]";

function MemberRow({
  agent,
  member,
  href,
  active,
  menu,
  onNavigate,
}: {
  agent: AgentDef;
  member?: TeamMember;
  href: string;
  active: boolean;
  menu: AgentMenuApi;
  onNavigate?: () => void;
}) {
  const unread = member?.unread ?? 0;
  const running = !!member?.running;
  const last = member?.lastMessage;
  const preview = last ? (last.role === "user" ? t("team.you", { text: last.text }) : last.text) : agent.description || t("team.noMessages");
  const triggers = useMenuTriggers(agent.id, menu);
  return (
    <div className="group/agent relative">
      <Link href={href} onClick={onNavigate} aria-current={active ? "page" : undefined} className={cx(rowClass(active), NO_CALLOUT, !active && menu.openFor === agent.id && "bg-surface/55")} {...triggers}>
        <AgentAvatar avatar={agent.avatar} id={agent.id} name={agent.name} size={38} running={running} className={agent.archived ? "opacity-75 saturate-50" : undefined} />
        <RowText
          title={agent.name}
          time={last ? shortTime(last.createdAt) : undefined}
          unread={unread}
          running={running ? t("team.working") : undefined}
          preview={preview}
          pinned={member?.pinned !== undefined && !agent.archived}
        />
      </Link>
      <MoreButton label={t("agentMenu.open", { name: agent.name })} open={menu.openFor === agent.id} onOpen={(anchor) => menu.toggle(agent.id, anchor)} className="inset-y-0 right-2 my-auto" />
    </div>
  );
}

/** The default agent, large on top like a profile: its face with a star, its name, whether it works, what is unread. */
function DefaultAgentCard({ agent, member, active, menu, onNavigate }: { agent: AgentDef; member?: TeamMember; active: boolean; menu: AgentMenuApi; onNavigate?: () => void }) {
  const unread = member?.unread ?? 0;
  const running = !!member?.running;
  const triggers = useMenuTriggers(agent.id, menu);
  return (
    <div className="group/agent relative mb-1.5">
      <Link
        href="/"
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        title={agent.description || undefined}
        className={cx(
          "press flex flex-col items-center gap-1 rounded-3xl px-3 pt-4 pb-3 text-center",
          active ? "bg-surface shadow-card" : menu.openFor === agent.id ? "bg-surface/55" : "hover:bg-surface/55",
          NO_CALLOUT,
        )}
        {...triggers}
      >
        <span className="relative mb-1">
          <AgentAvatar avatar={agent.avatar} id={agent.id} name={agent.name} size={68} running={running} />
          <span className="absolute -right-1 -bottom-0.5 flex size-[22px] items-center justify-center rounded-full bg-surface shadow-card" role="img" title={t("team.defaultAgent")} aria-label={t("team.defaultAgent")}>
            <Star className="size-3 fill-accent text-accent" />
          </span>
          {unread > 0 && (
            <span className="absolute -top-1 -right-2">
              <UnreadBadge n={unread} />
            </span>
          )}
        </span>
        <span className={cx("max-w-full truncate text-[15px]", unread ? "font-bold" : "font-semibold")}>{agent.name}</span>
        <span className={cx("overflow-hidden text-[12px] leading-tight font-medium text-accent-text transition-all duration-300", running ? "max-h-4 opacity-100" : "max-h-0 opacity-0")}>
          {t("team.working")}
        </span>
      </Link>
      <MoreButton label={t("agentMenu.open", { name: agent.name })} open={menu.openFor === agent.id} onOpen={(anchor) => menu.toggle(agent.id, anchor)} className="top-2 right-2" />
    </div>
  );
}

/** "Archive · N" at the end of the team: quiet, only when someone is there. */
function ArchiveRow({ n, onOpen }: { n: number; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="press flex w-full items-center gap-3 rounded-2xl px-2.5 py-1.5 text-left text-[13px] text-muted hover:bg-surface/55 hover:text-fg">
      <span className="flex w-[38px] shrink-0 justify-center">
        <Archive className="size-4" />
      </span>
      <span className="min-w-0 flex-1 truncate">{t("team.archiveCount", { n })}</span>
      <ChevronRight className="size-4 shrink-0 opacity-60" />
    </button>
  );
}

/** A row on the canvas; the open one is a sheet of paper lifted off it. */
function rowClass(active: boolean): string {
  return cx(
    "press group flex items-center gap-3 rounded-2xl px-2.5 py-2",
    active ? "bg-surface shadow-card" : "hover:bg-surface/55",
  );
}

/** Name and time, then the last line (or what is happening now) and what is unread. */
function RowText({ title, time, unread, running, preview, pinned }: { title: string; time?: string; unread: number; running?: string; preview: string; pinned?: boolean }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="flex items-baseline gap-2">
        <span className={cx("min-w-0 flex-1 truncate text-[14px]", unread ? "font-semibold" : "font-medium")}>{title}</span>
        {time && <span className={cx("shrink-0 text-[11px] tabular-nums", unread ? "font-medium text-accent-text" : "text-muted")}>{time}</span>}
      </span>
      <span className="mt-0.5 flex items-center gap-2">
        {running ? (
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-accent-text">{running}</span>
        ) : (
          <span className={cx("min-w-0 flex-1 truncate text-[12.5px]", unread ? "text-fg" : "text-muted")}>{preview}</span>
        )}
        {unread > 0 ? <UnreadBadge n={unread} /> : pinned && <Pin className="size-3.5 shrink-0 rotate-45 text-muted/70" aria-label={t("team.pinned")} />}
      </span>
    </span>
  );
}

function GroupRow({ group, byId, active, onNavigate }: { group: GroupChat; byId: Map<string, AgentDef>; active: boolean; onNavigate?: () => void }) {
  const members = group.members.map((id) => byId.get(id) ?? { id, name: id, avatar: undefined });
  const name = (id: string | undefined) => (id ? (byId.get(id)?.name ?? id) : "");
  const last = group.lastMessage;
  const speaker = group.running ? group.speaking[0] : undefined;
  const preview = last
    ? last.role === "user"
      ? t("team.you", { text: last.text })
      : last.agentId
        ? t("team.said", { name: name(last.agentId), text: last.text })
        : last.text
    : members.map((m) => m.name).join(", ");
  return (
    <Link href={groupPath(group.conversationId)} onClick={onNavigate} aria-current={active ? "page" : undefined} className={rowClass(active)}>
      <AvatarPair agents={members} size={38} running={group.running} ring={active ? "bg-surface ring-surface" : "bg-canvas ring-canvas"} />
      <RowText
        title={group.title}
        time={last ? shortTime(last.createdAt) : undefined}
        unread={group.unread}
        running={group.running ? (speaker ? t("group.speaking", { name: name(speaker) }) : t("team.working")) : undefined}
        preview={preview}
      />
    </Link>
  );
}

/** "Add agent", "New group", "New channel": quiet, at the end of the list; it opens the chat that makes the thing. */
export function AddRow({ label, icon, onClick }: { label: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="press group flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left text-[13.5px] font-medium text-muted hover:bg-surface/55 hover:text-fg">
      <span className="flex size-[38px] shrink-0 items-center justify-center rounded-full border border-dashed border-muted/40 transition-colors group-hover:border-accent group-hover:bg-accent-soft group-hover:text-accent-text">
        {icon}
      </span>
      {label}
    </button>
  );
}

/** Agents, groups and channels as tabs; the tab follows what is open (a group's chat, a channel), then the user's pick. */
function Tabs({ value, unread }: { value: SidebarTab; unread: Record<SidebarTab, number> }) {
  const tabs: Array<{ id: SidebarTab; label: string }> = [
    { id: "agents", label: t("team.tab.agents") },
    { id: "groups", label: t("team.tab.groups") },
    { id: "channels", label: t("team.tab.channels") },
  ];
  return (
    <div className="mx-3 mb-2">
      <Segmented<SidebarTab>
        value={value}
        onChange={setSidebarTab}
        className="flex w-full bg-surface-3/60 dark:bg-surface"
        compact
        options={tabs.map((tab) => ({
          value: tab.id,
          label: tab.label,
          dot: value !== tab.id && unread[tab.id] > 0,
          title: value !== tab.id && unread[tab.id] > 0 ? t("team.unread", { n: unread[tab.id] }) : undefined,
        }))}
      />
    </div>
  );
}

export function TeamList({
  activeAgentId,
  activeConversationId,
  activeFeedId,
  onNavigate,
}: {
  activeAgentId?: string;
  activeConversationId?: string;
  activeFeedId?: string;
  onNavigate?: () => void;
}) {
  const agentList = useStore(agents);
  const members = useStore(team);
  const groupList = useStore(groups);
  const feedList = useStore(feeds);
  const picked = useStore(sidebarTab);
  const s = useStore(session);
  const [creating, setCreating] = useState(false);
  // The archived agents, opened from "Archive · N" in place of the team.
  const [archiveOpen, setArchiveOpen] = useState(false);
  const menu = useAgentMenu({ onNavigate });
  useEffect(() => {
    ensureAgents();
    ensureTeam();
    ensureGroups();
    ensureFeeds();
  }, []);
  const byId = useMemo(() => new Map((agentList ?? []).map((a) => [a.id, a])), [agentList]);
  const groupRows = useMemo(() => groupOrder(groupList ?? []), [groupList]);
  const archived = useMemo(() => (agentList ?? []).filter((a) => a.archived).sort((a, b) => a.name.localeCompare(b.name)), [agentList]);
  // A group needs two agents: with one there is nobody to invite yet.
  const canGroup = (agentList ?? []).filter((a) => !a.archived).length >= 2;
  const openGroup = !!activeConversationId && groupRows.some((g) => g.conversationId === activeConversationId);
  // Opening a channel or a group (a link, the address bar) shows its tab once; the user's own pick wins after that.
  useEffect(() => {
    if (activeFeedId) setSidebarTab("channels");
    else if (openGroup) setSidebarTab("groups");
  }, [activeFeedId, openGroup]);
  const tab = picked;

  const entries = useMemo(() => {
    const byAgent = new Map((members ?? []).map((m) => [m.agentId, m]));
    return teamOrder(
      (agentList ?? []).map((agent) => ({ agent, member: byAgent.get(agent.id) })),
      s?.defaultAgent,
    );
  }, [agentList, members, s?.defaultAgent]);
  const lead = entries[0]?.agent.id === s?.defaultAgent ? entries[0] : undefined;
  const rest = lead ? entries.slice(1) : entries;
  // The last one restored: back to the team.
  useEffect(() => {
    if (archiveOpen && agentList && !archived.length) setArchiveOpen(false);
  }, [archiveOpen, agentList, archived.length]);
  const unread: Record<SidebarTab, number> = {
    agents: (members ?? []).reduce((n, m) => n + (m.unread ?? 0), 0),
    groups: groupRows.reduce((n, g) => n + g.unread, 0),
    channels: unreadPosts(feedList),
  };

  const add = () => {
    addAgent();
    onNavigate?.();
  };

  const addRow = (label: string, icon: React.ReactNode, onClick: () => void) => <AddRow label={label} icon={icon} onClick={onClick} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Tabs value={tab} unread={unread} />
      {/* A short window cuts the list: its last rows fade out instead of ending on a sliced line. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 [mask-image:linear-gradient(to_bottom,#000_calc(100%_-_22px),transparent)]" role="tabpanel">
        {tab === "agents" && !archiveOpen && (
          <>
            {!agentList && (
              <div className="flex justify-center py-6">
                <Spinner />
              </div>
            )}
            {lead && <DefaultAgentCard agent={lead.agent} member={lead.member} active={lead.agent.id === activeAgentId} menu={menu} onNavigate={onNavigate} />}
            {rest.map(({ agent, member }) => (
              <MemberRow key={agent.id} agent={agent} member={member} href={agentPath(agent.id, s?.defaultAgent)} active={agent.id === activeAgentId} menu={menu} onNavigate={onNavigate} />
            ))}
            {agentList && addRow(t("team.add"), <Plus className="size-4" />, add)}
            {archived.length > 0 && <ArchiveRow n={archived.length} onOpen={() => setArchiveOpen(true)} />}
          </>
        )}
        {tab === "agents" && archiveOpen && (
          <>
            <div className="flex items-center gap-1 pb-1">
              <IconButton label={t("common.back")} onClick={() => setArchiveOpen(false)} className="size-8">
                <ArrowLeft className="size-4" />
              </IconButton>
              <span className="text-[13.5px] font-semibold">{t("team.archive")}</span>
            </div>
            {archived.map((agent) => (
              <MemberRow key={agent.id} agent={agent} href={agentPath(agent.id, undefined)} active={agent.id === activeAgentId} menu={menu} onNavigate={onNavigate} />
            ))}
            <p className="px-3 pt-2 text-xs leading-relaxed text-muted">{t("team.archiveHint")}</p>
          </>
        )}
        {tab === "groups" && (
          <>
            {groupRows.map((g) => (
              <GroupRow key={g.conversationId} group={g} byId={byId} active={g.conversationId === activeConversationId} onNavigate={onNavigate} />
            ))}
            {canGroup ? addRow(t("team.newGroup"), <UsersRound className="size-4" />, () => setCreating(true)) : agentList && <p className="px-3 pt-2 text-xs leading-relaxed text-muted">{t("team.groupsNeedTwo")}</p>}
          </>
        )}
        {tab === "channels" && <ChannelList activeId={activeFeedId} onNavigate={onNavigate} />}
      </div>
      {/* Creating one opens it; the drawer on phones closes with the navigation. */}
      <GroupDialog open={creating} onClose={() => setCreating(false)} />
      {menu.element}
    </div>
  );
}
