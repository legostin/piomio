// Group chats the person put in the archive: out of the Groups list, nobody writes there until they come back. Kept in
// the settings table (key "groups"), which every replica of a cluster shares, like what agents-state.ts keeps for agents.

const KEY = "groups";

export class GroupsStateStore {
  private settings: { getKey<T>(key: string, fallback: T): T; setKey(key: string, value: unknown): void };

  constructor(settings: GroupsStateStore["settings"]) {
    this.settings = settings;
  }

  /** The archived group chats' conversation ids, in the order they were archived. */
  archived(): string[] {
    const s = this.settings.getKey<{ archived?: unknown }>(KEY, {});
    return Array.isArray(s.archived) ? s.archived.filter((x): x is string => typeof x === "string") : [];
  }

  isArchived(conversationId: string): boolean {
    return this.archived().includes(conversationId);
  }

  /** Into the archive or back out of it (a deleted group leaves it too). */
  set(conversationId: string, archived: boolean): void {
    const rest = this.archived().filter((x) => x !== conversationId);
    this.settings.setKey(KEY, { archived: archived ? [...rest, conversationId] : rest });
  }
}
