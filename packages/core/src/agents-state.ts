// What the person did with the team's agents: pinned to the top of the list, put in the archive (asleep), deleted
// built-ins. Kept in the settings table (key "agents"), which every replica of a cluster shares, and not in the agents'
// files: a built-in agent keeps getting its updated prompt while it is pinned or archived.

export interface AgentsState {
  /** In the order they were pinned. */
  pinned: string[];
  archived: string[];
  /** Built-in and plugin agents the person deleted: their files ship with the hub, so the hub remembers they are gone. */
  removed: string[];
}

const KEY = "agents";

export class AgentsStateStore {
  private settings: { getKey<T>(key: string, fallback: T): T; setKey(key: string, value: unknown): void };

  constructor(settings: AgentsStateStore["settings"]) {
    this.settings = settings;
  }

  get(): AgentsState {
    const s = this.settings.getKey<Partial<AgentsState>>(KEY, {});
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return { pinned: ids(s.pinned), archived: ids(s.archived), removed: ids(s.removed) };
  }

  /** Adds `id` to a list or takes it out; a pin goes to the end of the pinned. */
  set(list: keyof AgentsState, id: string, on: boolean): void {
    const s = this.get();
    const rest = s[list].filter((x) => x !== id);
    this.settings.setKey(KEY, { ...s, [list]: on ? [...rest, id] : rest });
  }

  /** Forgets the agent everywhere: it was deleted (`removed` is set apart) or made anew. */
  forget(id: string): void {
    const s = this.get();
    const drop = (l: string[]) => l.filter((x) => x !== id);
    this.settings.setKey(KEY, { pinned: drop(s.pinned), archived: drop(s.archived), removed: drop(s.removed) });
  }
}
