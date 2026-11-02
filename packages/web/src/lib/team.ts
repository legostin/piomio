// The team in the sidebar: order, the agent's menu, and the route of each agent's dialog.

import type { AgentDef, TeamMember } from "@piomio/shared";

export interface TeamEntry {
  agent: Pick<AgentDef, "id" | "name" | "archived">;
  member?: TeamMember;
}

/**
 * The default agent first, then the pinned in their order, then whoever talked last; agents with an empty dialog by
 * name. Archived agents are not on the team list.
 */
export function teamOrder<E extends TeamEntry>(entries: E[], defaultAgent: string | undefined): E[] {
  const activity = (e: TeamEntry) => (e.member?.lastMessage ? e.member.lastActivityAt : "");
  const pin = (e: TeamEntry) => e.member?.pinned ?? Infinity;
  return entries
    .filter((e) => !e.agent.archived)
    .sort((a, b) => {
      if (a.agent.id === defaultAgent) return -1;
      if (b.agent.id === defaultAgent) return 1;
      if (pin(a) !== pin(b)) return pin(a) < pin(b) ? -1 : 1;
      const x = activity(a);
      const y = activity(b);
      if (x !== y) return x < y ? 1 : -1;
      return a.agent.name.localeCompare(b.agent.name);
    });
}

/** What the agent's menu offers (right click, a long press, "⋯"), in the order shown. */
export type AgentMenuAction = "pin" | "unpin" | "unread" | "read" | "default" | "settings" | "archive" | "restore" | "delete";

export function agentMenuActions(o: { isDefault: boolean; archived?: boolean; pinned?: boolean; unread: number; hasMessages: boolean }): AgentMenuAction[] {
  if (o.archived) return ["restore", "delete"];
  const out: AgentMenuAction[] = [];
  // The default agent is always on top: nothing to pin, nothing to make default.
  if (!o.isDefault) out.push(o.pinned ? "unpin" : "pin");
  if (o.unread > 0) out.push("read");
  else if (o.hasMessages) out.push("unread");
  if (!o.isDefault) out.push("default");
  out.push("settings", "archive", "delete");
  return out;
}

/** Who can take the default agent's place: the active agents other than it, in the team's order. */
export function successorsOf<A extends Pick<AgentDef, "id" | "name" | "archived">>(agentId: string, agents: A[], members: TeamMember[] = []): A[] {
  const byAgent = new Map(members.map((m) => [m.agentId, m]));
  return teamOrder(
    agents.filter((a) => a.id !== agentId).map((agent) => ({ agent, member: byAgent.get(agent.id) })),
    undefined,
  ).map((e) => e.agent);
}

/** The route of an agent's dialog: "/" for the default agent. */
export function agentPath(agentId: string, defaultAgent: string | undefined): string {
  return agentId === defaultAgent ? "/" : `/agent/${encodeURIComponent(agentId)}`;
}

/** Whose dialog a route shows, if any. */
export function agentForPath(path: string, defaultAgent: string | undefined): string | undefined {
  if (path === "/" || path === "") return defaultAgent;
  const m = /^\/agent\/([^/?#]+)/.exec(path);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

// ---------- group chats ----------

/** The route of a group chat. */
export function groupPath(conversationId: string): string {
  return `/chat/${encodeURIComponent(conversationId)}`;
}

/** Which conversation a "/chat/:id" route shows, if any. */
export function chatForPath(path: string): string | undefined {
  const m = /^\/chat\/([^/?#]+)/.exec(path);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** The latest activity first. */
export function groupOrder<G extends { lastActivityAt: string; title: string }>(groups: G[]): G[] {
  return groups.slice().sort((a, b) => (a.lastActivityAt !== b.lastActivityAt ? (a.lastActivityAt < b.lastActivityAt ? 1 : -1) : a.title.localeCompare(b.title)));
}

/** A title for a group nobody named: the first members' names, "+N" for the rest. */
export function suggestedTitle(names: string[], shown = 3): string {
  const head = names.slice(0, shown).join(", ");
  return names.length > shown ? `${head} +${names.length - shown}` : head;
}
