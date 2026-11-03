// The user's team: every agent with its one long-lived dialog, and the group chats, as the web sidebar shows them.
// Changes in a dialog (new or finished messages, turns starting and ending, the read marker) go out as "team.updated";
// in a group chat (also its title and members) as "group.updated".

import type { AgentPresence, Conversation, GroupChat, Message, TeamMember } from "@piomio/shared";
import { truncate } from "@piomio/shared";
import type { Store } from "./store.ts";
import type { EventBus } from "./bus.ts";

const PREVIEW_CHARS = 160;
/** How far back to look for a message with something to preview (tool-only replies have none). */
const PREVIEW_LOOKBACK = 10;

/** Short plain text of a message for the sidebar, or "" when it has nothing to show. */
export function previewText(m: Message): string {
  const out: string[] = [];
  const shown: string[] = [];
  for (const p of m.parts) {
    // Text in system messages is a note for the model ("[System] …"); errors in them are for the user.
    if (p.type === "text" && m.role !== "system") out.push(p.text);
    else if (p.type === "notification") out.push(p.title);
    else if (p.type === "error") out.push(p.message);
    else if (p.type === "attachment") out.push(p.name);
    // Pictures and maps by their caption or title, marked without words (the sidebar's language is the viewer's), when
    // the message says nothing else.
    else if (p.type === "images") shown.push(`🖼 ${p.items.find((it) => it.caption)?.caption ?? ""}`.trim());
    else if (p.type === "map") shown.push(`📍 ${p.title ?? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`}`);
  }
  const text = (out.some((x) => x.trim()) ? out : shown)
    .join("\n")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`]+|^#+\s*|^>\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(text, PREVIEW_CHARS);
}

/** A companion's live state lasts this long unless its plugin says it again. */
export const PRESENCE_TTL_MS = 90_000;

export class Team {
  private store: Store;
  private agents: { list(): Array<{ id: string }> };
  private pinned: () => string[];
  private bus: EventBus;
  private isRunning: (conversationId: string) => boolean;
  private floor: (conversationId: string) => string[];
  private archived: (conversationId: string) => boolean;
  private pending = new Set<string>();
  /** The always-on companion's live state, by agent (set by its plugin; never stored), and when it lapses. */
  private presences = new Map<string, { presence: AgentPresence; lapse: ReturnType<typeof setTimeout> }>();

  constructor(d: {
    store: Store;
    agents: { list(): Array<{ id: string }> };
    /** Agents pinned to the top of the list, in order (agents-state.ts). */
    pinned?: () => string[];
    bus: EventBus;
    isRunning: (conversationId: string) => boolean;
    /** A group chat's member answering now, then the ones waiting for their turn. */
    floor?: (conversationId: string) => string[];
    /** The group chat is in the archive (groups-state.ts). */
    archived?: (conversationId: string) => boolean;
  }) {
    this.store = d.store;
    this.agents = d.agents;
    this.pinned = d.pinned ?? (() => []);
    this.bus = d.bus;
    this.isRunning = d.isRunning;
    this.floor = d.floor ?? (() => []);
    this.archived = d.archived ?? (() => false);
    d.bus.on("message.created", (m: Message) => this.changed(m.conversationId));
    d.bus.on("message.updated", (m: Message) => {
      if (m.status !== "streaming") this.changed(m.conversationId);
    });
    d.bus.on("conversation.activity", (a) => this.changed(a.conversationId));
    d.bus.on("message.deleted", (m) => this.changed(m.conversationId));
    // A group renamed or with new members.
    d.bus.on("conversation.updated", (c: Conversation) => {
      if (c.kind === "group") this.changed(c.id);
    });
  }

  /** Every agent of the team (the archived ones are not) with its dialog (created for agents that have none yet). */
  list(): TeamMember[] {
    return this.agents.list().map((a) => this.memberOf(this.store.agentConversation(a.id)));
  }

  member(agentId: string): TeamMember {
    return this.memberOf(this.store.agentConversation(agentId));
  }

  /** The user has seen the dialog up to `at` (a message's createdAt; default: now). */
  markRead(conversationId: string, at?: string): void {
    this.store.markRead(conversationId, at);
    this.changed(conversationId);
  }

  /** The group chats, the latest activity first: the archived ones (marked `archived`) only with `all`. */
  listGroups(opts: { all?: boolean } = {}): GroupChat[] {
    return this.store
      .listGroups()
      .filter((c) => opts.all || !this.archived(c.id))
      .map((c) => this.groupOf(c));
  }

  /**
   * What the agent is doing on the person's computer now (undefined: nothing), pushed to clients at once. It lapses
   * after `ttlMs` unless set again: a plugin that stopped does not leave its agent "watching".
   */
  setPresence(agentId: string, presence: AgentPresence | undefined, ttlMs = PRESENCE_TTL_MS): void {
    const was = this.presences.get(agentId);
    if (was) clearTimeout(was.lapse);
    if (presence) {
      const lapse = setTimeout(() => this.setPresence(agentId, undefined), ttlMs);
      lapse.unref?.();
      this.presences.set(agentId, { presence, lapse });
    } else this.presences.delete(agentId);
    if (was?.presence !== presence) this.changed(this.store.agentConversation(agentId).id);
  }

  memberOf(conv: Conversation): TeamMember {
    const last = this.lastMessage(conv.id);
    const pin = this.pinned().indexOf(conv.agentId);
    const presence = this.presences.get(conv.agentId)?.presence;
    return {
      agentId: conv.agentId,
      conversationId: conv.id,
      lastMessage: last && { role: last.role, text: last.text, createdAt: last.createdAt },
      lastActivityAt: conv.updatedAt,
      running: this.isRunning(conv.id),
      unread: this.store.unreadCount(conv.id),
      ...(pin >= 0 ? { pinned: pin } : {}),
      ...(presence ? { presence } : {}),
    };
  }

  /** The person wants to come back to the dialog: its last message from the agent counts as unread again. */
  markUnread(conversationId: string): void {
    this.store.markUnread(conversationId);
    this.changed(conversationId);
  }

  groupOf(conv: Conversation): GroupChat {
    const running = this.isRunning(conv.id);
    return {
      conversationId: conv.id,
      title: conv.title,
      members: conv.members ?? [conv.agentId],
      lastMessage: this.lastMessage(conv.id),
      lastActivityAt: conv.updatedAt,
      running,
      speaking: running ? this.floor(conv.id) : [],
      unread: this.store.unreadCount(conv.id),
      ...(this.archived(conv.id) ? { archived: true } : {}),
    };
  }

  private lastMessage(conversationId: string): GroupChat["lastMessage"] {
    const recent = this.store.listMessages(conversationId, { limit: PREVIEW_LOOKBACK });
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].quiet) continue;
      const text = previewText(recent[i]);
      if (text) return { role: recent[i].role, text, createdAt: recent[i].createdAt, ...(recent[i].agentId ? { agentId: recent[i].agentId } : {}) };
    }
    return undefined;
  }

  /** Push the dialog's new state after the events of this tick, so clients get the message itself first. */
  private changed(conversationId: string): void {
    if (!this.pending.size) setImmediate(() => this.flush());
    this.pending.add(conversationId);
  }

  private flush(): void {
    const ids = [...this.pending];
    this.pending.clear();
    for (const id of ids) {
      try {
        const conv = this.store.getConversation(id);
        if (conv?.kind === "main") this.bus.emit("team.updated", this.memberOf(conv));
        else if (conv?.kind === "group") this.bus.emit("group.updated", this.groupOf(conv));
      } catch {
        /* the hub is stopping: the database is closed */
      }
    }
  }
}
