// What a group chat's menu does on the hub: into the archive and back, delete. Each call updates the groups store
// itself (the hub's "group.updated" / "group.deleted" events come too, but not always first).

import type { GroupChat } from "@piomio/shared";
import { api } from "../lib/api";
import { forgetGroup, groups } from "./app";

const path = (conversationId: string) => `/api/groups/${encodeURIComponent(conversationId)}`;

/** Into the archive (out of the Groups list, nobody writes there) or back. */
export async function archiveGroup(conversationId: string, archived: boolean): Promise<void> {
  const g = await api.post<GroupChat>(`${path(conversationId)}/archive`, { archived });
  groups.set((list) => (list ? list.map((x) => (x.conversationId === g.conversationId ? g : x)) : list));
}

/** Gone for good with its conversation. `gone` runs once the hub has deleted it, before the lists forget it (to leave its chat first). */
export async function deleteGroup(conversationId: string, gone?: () => void): Promise<void> {
  await api.del(path(conversationId));
  gone?.();
  forgetGroup(conversationId);
}
