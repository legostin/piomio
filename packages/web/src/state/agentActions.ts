// What the agent's menu does on the hub: pin, make default, archive and restore, delete. Each call refreshes the
// stores it touches itself (the hub's "agents.updated" / "settings.updated" events come too, but not always first).

import { api } from "../lib/api";
import { refreshAgents, refreshBootstrap, refreshTeam, team } from "./app";

const path = (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}`;

/** The agents, the team and the default agent, all at once. */
async function refreshAll(): Promise<void> {
  await Promise.all([refreshAgents().catch(() => {}), refreshTeam(), refreshBootstrap()]);
}

/** Pinned to the top of the list (under the default agent), last among the pinned; or back among the rest. */
export async function pinAgent(agentId: string, pinned: boolean): Promise<void> {
  // The row moves at once; the hub's order follows.
  team.set((list) => {
    if (!list) return list;
    const last = Math.max(-1, ...list.map((m) => m.pinned ?? -1));
    return list.map((m) => (m.agentId !== agentId ? m : pinned ? { ...m, pinned: last + 1 } : { ...m, pinned: undefined }));
  });
  try {
    await api.post(`${path(agentId)}/pin`, { pinned });
  } finally {
    await refreshTeam();
  }
}

/** The agent becomes the default: "/" opens its dialog and it sits large on top of the list. */
export async function makeDefaultAgent(agentId: string): Promise<void> {
  await api.patch("/api/settings", { defaultAgent: agentId });
  await refreshBootstrap();
}

/**
 * Into the archive (asleep: off the list, its schedules and channels stop) or back. The default agent goes only with a
 * `successor`, an active agent that becomes the default in the same step.
 */
export async function archiveAgent(agentId: string, archived: boolean, successor?: string): Promise<void> {
  await api.post(`${path(agentId)}/archive`, successor ? { archived, successor } : { archived });
  await refreshAll();
}

/**
 * Gone for good with its dialog, tasks and schedules; the default agent only with a `successor`. `gone` runs once the
 * hub has deleted it, before the lists are fetched again (to leave its dialog first).
 */
export async function deleteAgent(agentId: string, successor?: string, gone?: () => void): Promise<void> {
  await api.del(successor ? `${path(agentId)}?successor=${encodeURIComponent(successor)}` : path(agentId));
  gone?.();
  await refreshAll();
}
