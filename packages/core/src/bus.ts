// In-process event bus. Web clients and plugin subscribers are attached by the server and plugin host.

import type { AgentDraft, BrainLoginState, DeviceNetwork, Feed, FeedPost, GroupChat, InviteUsed, MachineActivity, PageView, RemoteView, ReplicaState, TeamMember, UiEvent } from "@piomio/shared";

export type BusEvents = {
  "message.created": any;
  "message.updated": any;
  "message.delta": { id: string; conversationId: string; delta: string };
  "conversation.updated": any;
  /** A turn started or ended in a conversation. */
  "conversation.activity": { conversationId: string; running: boolean };
  "team.updated": TeamMember;
  "group.updated": GroupChat;
  /** A channel changed (settings, a run started or ended, new posts, read) or was deleted (feeds.ts). */
  "feed.updated": Feed;
  "feed.deleted": { id: string };
  "feed.post": FeedPost;
  /** A page was made or changed (pages.ts), or deleted. */
  "page.updated": PageView;
  "page.deleted": { id: string };
  "task.updated": any;
  "notification.created": any;
  "notification.feedback": any;
  /** The Inbox's unread count changed (something came in, or the person read it). */
  "inbox.changed": { unread: number };
  "approval.created": any;
  /** An action the person asked for in their own words ran without a card (ToolSpec.asked). */
  "approval.asked": any;
  "approval.resolved": any;
  "vault.state": { state: string };
  /** Vault items written outside the console (a secret typed into the chat): ids only. */
  "vault.updated": { ids: string[] };
  "secret.request": any;
  /** A brain's sign-in from the chat changed (started, shows a code, finished). */
  "brain.login": BrainLoginState;
  "plugins.updated": Record<string, never>;
  "brains.updated": Record<string, never>;
  "agents.updated": Record<string, never>;
  /** Skills came or went, or who has one changed (skills.ts SkillHolders). */
  "skills.updated": Record<string, never>;
  /** A new agent's draft in the chat changed (or became the agent). */
  "agent_draft.updated": AgentDraft;
  "settings.updated": Record<string, unknown>;
  /** A connected account (Google) came, went or broke. */
  "connections.updated": { provider: string };
  "machine.updated": any;
  /** A machine's setup (brains, keys, models, limit) changed. */
  "machine.setup": { machineId: string };
  /** A machine's gateway reported spend. */
  "machine.spend": { machineId: string };
  /** The cluster's replicas, who leads (cluster.ts). */
  "cluster.updated": ReplicaState[];
  /** Rows came from another replica: open apps re-read what they show. */
  "replica.synced": { tables: string[] };
  /** What every machine is doing now (activity.ts). */
  "machines.activity": MachineActivity[];
  /** A phone paired, was renamed or revoked: listeners re-read the list. */
  "device.updated": { id: string };
  "devices.network": DeviceNetwork;
  /** A computer or a phone joined with an invite (invites.ts): the card that shows it closes. */
  "invite.used": InviteUsed;
  /** Access from anywhere changed state (remote.ts). */
  "remote.updated": RemoteView;
  "plugin.event": { pluginId: string; channel: string; payload: unknown };
};

export type BusEventName = keyof BusEvents;

export class EventBus {
  private handlers = new Map<string, Set<(p: any) => void>>();
  private anyHandlers = new Set<(name: string, p: any) => void>();

  on<K extends BusEventName>(name: K, cb: (payload: BusEvents[K]) => void): () => void {
    const set = this.handlers.get(name) ?? new Set();
    set.add(cb);
    this.handlers.set(name, set);
    return () => set.delete(cb);
  }

  onAny(cb: (name: string, payload: any) => void): () => void {
    this.anyHandlers.add(cb);
    return () => this.anyHandlers.delete(cb);
  }

  emit<K extends BusEventName>(name: K, payload: BusEvents[K]): void {
    for (const cb of this.handlers.get(name) ?? []) {
      try {
        cb(payload);
      } catch (e) {
        console.error(`[bus] handler for ${name} failed`, e);
      }
    }
    for (const cb of this.anyHandlers) {
      try {
        cb(name, payload);
      } catch (e) {
        console.error(`[bus] any-handler failed`, e);
      }
    }
  }
}

/** Map bus events to UI websocket events. */
export function toUiEvent(name: string, payload: any): UiEvent | null {
  switch (name) {
    case "message.created":
    case "message.updated":
    case "message.delta":
    case "conversation.updated":
    case "team.updated":
    case "group.updated":
    case "feed.updated":
    case "feed.deleted":
    case "feed.post":
    case "page.updated":
    case "page.deleted":
    case "task.updated":
    case "notification.created":
    case "inbox.changed":
    case "plugins.updated":
    case "brains.updated":
    case "agents.updated":
    case "skills.updated":
    case "settings.updated":
    case "connections.updated":
    case "machine.updated":
    case "machine.setup":
    case "machine.spend":
    case "cluster.updated":
    case "replica.synced":
    case "machines.activity":
    case "device.updated":
    case "devices.network":
    case "invite.used":
    case "remote.updated":
    case "plugin.event":
    case "secret.request":
    case "agent_draft.updated":
    case "brain.login":
      return { type: name, data: payload } as UiEvent;
    case "vault.state":
      return { type: "vault.state", data: payload } as UiEvent;
    default:
      return null;
  }
}
