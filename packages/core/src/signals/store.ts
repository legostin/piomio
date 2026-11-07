// The trigger engine's tables: the journal of runs (with the signals they saw), the notes agents read, and the
// scripts' own key-value state. All three live in piomio.db and replicate between hub replicas (cluster.ts MAIN_TABLES).
// memoryStore is the same contract without a database, for tests.

import { randomBytes } from "node:crypto";
import type { Db } from "../db.ts";
import type { PluginKv } from "../plugins/kv.ts";
import type { Signal, TriggerRun } from "./types.ts";

export interface NoteRow {
  id: string;
  agentId: string;
  triggerId: string;
  triggerName: string;
  text: string;
  signalIds: string[];
  external: boolean;
  at: string;
}

export interface NoteQuery {
  agentId?: string;
  triggerId?: string;
  since?: string;
  text?: string;
  limit?: number;
}

export interface TriggerStore {
  /** Newest first. */
  runs(triggerId: string, limit?: number): TriggerRun[];
  /** One run of the trigger's journal by its id (a primary-key lookup). */
  run(triggerId: string, runId: string): TriggerRun | undefined;
  /** Prunes that trigger's journal to 200 runs; past its newest 20, runs older than 14 days go. */
  addRun(triggerId: string, run: TriggerRun & { signalData?: Signal[] }): void;
  /** A signal kept with one of the journal's runs. */
  signal(id: string): Signal | undefined;
  recentSignals(triggerId: string, n: number): Signal[];
  dropRuns(triggerId: string): void;
  /** Prunes notes older than 30 days, and the trigger's past its newest 500. */
  addNote(n: Omit<NoteRow, "id" | "at">): NoteRow;
  /** Newest first, at most `limit` (50 by default), read no further than that. */
  notes(q: NoteQuery): NoteRow[];
  stateGet(triggerId: string, key: string): unknown;
  /**
   * Throws RangeError when the trigger's state would pass its cap: 1 MB for the script's keys and the marks beside them
   * ("__ext:"), 4 MB for the engine's own ("__" keys).
   */
  stateSet(triggerId: string, key: string, value: unknown): void;
  stateDelete(triggerId: string, key: string): void;
  dropState(triggerId: string): void;
  /** The bytes (key and value) the trigger's keys of one budget take (stateBudget), those in `except` left out. */
  stateBytes(triggerId: string, budget: StateBudget, except?: string[]): number;
}

export const MAX_JOURNAL_RUNS = 200;
/** A trigger's newest runs, kept whatever their age (as many as the old plugin kept: engine.ts MAX_RUNS_KEPT). */
export const RECENT_RUNS_KEPT = 20;
export const JOURNAL_DAYS = 14;
export const NOTE_DAYS = 30;
/** A trigger's notes, at most: the newest. */
export const MAX_NOTES_PER_TRIGGER = 500;
export const MAX_STATE_BYTES = 1024 * 1024;
const DAY_MS = 86_400_000;
const DEFAULT_NOTE_LIMIT = 50;

type StoredRun = TriggerRun & { signalData?: Signal[] };

const iso = (ms: number) => new Date(ms).toISOString();
const noteId = () => `n_${randomBytes(8).toString("hex")}`;
const bare = (r: StoredRun): TriggerRun => {
  const { signalData: _drop, ...rest } = r;
  return rest;
};
const noteMatches = (n: NoteRow, q: NoteQuery) =>
  (!q.agentId || n.agentId === q.agentId) &&
  (!q.triggerId || n.triggerId === q.triggerId) &&
  (!q.since || n.at >= q.since) &&
  (!q.text || n.text.toLowerCase().includes(q.text.toLowerCase()));

/**
 * Which cap a state key counts against: the engine's own keys ("__": a pending batch, the queue, seen delivery keys)
 * have 4 MB; the script's keys and the outside-content marks beside them ("__ext:<key>", which grow with them) share 1 MB.
 */
export type StateBudget = "script" | "engine";
/** The engine's mark beside a state key whose value a run set after reading outside content (pio.ts). */
export const EXT_PREFIX = "__ext:";
export const stateBudget = (key: string): StateBudget => (key.startsWith("__") && !key.startsWith(EXT_PREFIX) ? "engine" : "script");
export const MAX_ENGINE_STATE_BYTES = 4 * 1024 * 1024;
/** The SQL test of a key's budget: 1 for the engine's, 0 for the script's (stateBudget). */
const ENGINE_KEY_SQL = `(substr(key, 1, 2) = '__' and substr(key, 1, ${EXT_PREFIX.length}) <> '${EXT_PREFIX}')`;

/**
 * The value's JSON, or a RangeError when the trigger's state would pass its cap: 1 MB for the script's keys, 4 MB for
 * the engine's. `others`: the bytes in the trigger's other keys of the same budget.
 */
export function checkState(others: number, key: string, value: unknown): string {
  const text = JSON.stringify(value ?? null);
  const engine = stateBudget(key) === "engine";
  if (others + Buffer.byteLength(key) + Buffer.byteLength(text) > (engine ? MAX_ENGINE_STATE_BYTES : MAX_STATE_BYTES)) {
    throw new RangeError(engine ? "the trigger engine's own state is limited to 4 MB" : "trigger state is limited to 1 MB");
  }
  return text;
}

export function sqlStore(db: Db, now: () => number = Date.now): TriggerStore {
  const parse = <T>(s: string): T => JSON.parse(s) as T;
  const storedRuns = (triggerId: string, limit: number): StoredRun[] =>
    (db.prepare("select data from trigger_runs where trigger_id = ? order by at desc, rowid desc limit ?").all(triggerId, limit) as Array<{ data: string }>).map((r) =>
      parse<StoredRun>(r.data),
    );
  const stateBytes = (triggerId: string, budget: StateBudget, except: string[] = []): number =>
    (
      db
        .prepare(
          `select coalesce(sum(length(cast(key as blob)) + length(cast(value as blob))), 0) as n from trigger_state where trigger_id = ? and ${ENGINE_KEY_SQL} = ? and key not in (select value from json_each(?))`,
        )
        .get(triggerId, budget === "engine" ? 1 : 0, JSON.stringify(except)) as { n: number }
    ).n;
  return {
    runs: (triggerId, limit = MAX_JOURNAL_RUNS) => storedRuns(triggerId, limit).map(bare),
    run(triggerId, runId) {
      const r = db.prepare("select data from trigger_runs where id = ? and trigger_id = ?").get(runId, triggerId) as { data: string } | undefined;
      return r ? bare(parse<StoredRun>(r.data)) : undefined;
    },
    addRun(triggerId, run) {
      db.prepare("insert or replace into trigger_runs(id, trigger_id, at, data) values (?,?,?,?)").run(run.id, triggerId, run.at, JSON.stringify(run));
      const newest = "select id from trigger_runs where trigger_id = ? order by at desc, rowid desc limit ?";
      // Past its newest 20, a run older than 14 days goes: a trigger that runs once a week keeps its history.
      db.prepare(`delete from trigger_runs where trigger_id = ? and at < ? and id not in (${newest})`).run(triggerId, iso(now() - JOURNAL_DAYS * DAY_MS), triggerId, RECENT_RUNS_KEPT);
      db.prepare(`delete from trigger_runs where trigger_id = ? and id not in (${newest})`).run(triggerId, triggerId, MAX_JOURNAL_RUNS);
    },
    signal(id) {
      // A cheap text prefilter; the match itself is on the parsed signal.
      const like = `%"id":${JSON.stringify(id).replace(/[\\%_]/g, "\\$&")}%`;
      const rows = db.prepare("select data from trigger_runs where data like ? escape '\\' order by at desc").all(like) as Array<{ data: string }>;
      for (const r of rows) {
        const hit = parse<StoredRun>(r.data).signalData?.find((s) => s.id === id);
        if (hit) return hit;
      }
      return undefined;
    },
    recentSignals(triggerId, n) {
      const out: Signal[] = [];
      for (const r of storedRuns(triggerId, MAX_JOURNAL_RUNS)) {
        for (const s of r.signalData ?? []) if (out.length < n) out.push(s);
        if (out.length >= n) break;
      }
      return out;
    },
    dropRuns: (triggerId) => void db.prepare("delete from trigger_runs where trigger_id = ?").run(triggerId),
    addNote(n) {
      const row: NoteRow = { ...n, id: noteId(), at: iso(now()) };
      const { id, at, agentId, triggerId, external, ...rest } = row;
      db.prepare("insert into signal_notes(id, agent_id, trigger_id, at, external, data) values (?,?,?,?,?,?)").run(id, agentId, triggerId, at, external ? 1 : 0, JSON.stringify(rest));
      db.prepare("delete from signal_notes where at < ?").run(iso(now() - NOTE_DAYS * DAY_MS));
      db.prepare("delete from signal_notes where trigger_id = ? and id not in (select id from signal_notes where trigger_id = ? order by at desc, rowid desc limit ?)").run(
        triggerId,
        triggerId,
        MAX_NOTES_PER_TRIGGER,
      );
      return row;
    },
    notes(q) {
      const where: string[] = [];
      const args: Array<string | number> = [];
      if (q.agentId) (where.push("agent_id = ?"), args.push(q.agentId));
      if (q.triggerId) (where.push("trigger_id = ?"), args.push(q.triggerId));
      if (q.since) (where.push("at >= ?"), args.push(q.since));
      const limit = q.limit ?? DEFAULT_NOTE_LIMIT;
      const out: NoteRow[] = [];
      if (limit <= 0) return out;
      const sql = `select id, agent_id, trigger_id, at, external, data from signal_notes ${where.length ? `where ${where.join(" and ")}` : ""} order by at desc, rowid desc`;
      type Row = { id: string; agent_id: string; trigger_id: string; at: string; external: number; data: string };
      // Without a text filter the database stops at the limit; with one the rows are read one by one until it is reached.
      const rows: Iterable<Row> = q.text ? (db.prepare(sql).iterate(...args) as Iterable<Row>) : (db.prepare(`${sql} limit ?`).all(...args, limit) as Row[]);
      for (const r of rows) {
        const n: NoteRow = {
          ...parse<Pick<NoteRow, "triggerName" | "text" | "signalIds">>(r.data),
          id: r.id,
          agentId: r.agent_id,
          triggerId: r.trigger_id,
          external: !!r.external,
          at: r.at,
        };
        if (!noteMatches(n, q)) continue;
        out.push(n);
        if (out.length >= limit) break;
      }
      return out;
    },
    stateGet(triggerId, key) {
      const r = db.prepare("select value from trigger_state where trigger_id = ? and key = ?").get(triggerId, key) as { value: string } | undefined;
      return r ? parse(r.value) : undefined;
    },
    stateSet(triggerId, key, value) {
      const text = checkState(stateBytes(triggerId, stateBudget(key), [key]), key, value);
      db.prepare("insert into trigger_state(trigger_id, key, value) values (?,?,?) on conflict(trigger_id, key) do update set value = excluded.value").run(triggerId, key, text);
    },
    stateDelete: (triggerId, key) => void db.prepare("delete from trigger_state where trigger_id = ? and key = ?").run(triggerId, key),
    dropState: (triggerId) => void db.prepare("delete from trigger_state where trigger_id = ?").run(triggerId),
    stateBytes,
  };
}

export function memoryStore(now: () => number = Date.now): TriggerStore {
  const runs = new Map<string, StoredRun[]>(); // oldest first, in the order added
  let notes: NoteRow[] = [];
  const state = new Map<string, Map<string, string>>();
  const stateBytes = (triggerId: string, budget: StateBudget, except: string[] = []): number => {
    let n = 0;
    for (const [k, v] of state.get(triggerId) ?? []) if (stateBudget(k) === budget && !except.includes(k)) n += Buffer.byteLength(k) + Buffer.byteLength(v);
    return n;
  };
  const newestFirst = <T extends { at: string }>(list: T[]): T[] =>
    list
      .map((item, i) => ({ item, i }))
      .sort((a, b) => (a.item.at < b.item.at ? 1 : a.item.at > b.item.at ? -1 : b.i - a.i))
      .map((x) => x.item);
  return {
    runs: (triggerId, limit = MAX_JOURNAL_RUNS) =>
      newestFirst(runs.get(triggerId) ?? [])
        .slice(0, limit)
        .map((r) => bare(structuredClone(r))),
    run(triggerId, runId) {
      const r = (runs.get(triggerId) ?? []).find((x) => x.id === runId);
      return r ? bare(structuredClone(r)) : undefined;
    },
    addRun(triggerId, run) {
      const list = (runs.get(triggerId) ?? []).filter((r) => r.id !== run.id);
      list.push(structuredClone(run));
      const cutoff = iso(now() - JOURNAL_DAYS * DAY_MS);
      runs.set(
        triggerId,
        newestFirst(list)
          .filter((r, i) => i < RECENT_RUNS_KEPT || r.at >= cutoff)
          .slice(0, MAX_JOURNAL_RUNS)
          .reverse(),
      );
    },
    signal(id) {
      for (const list of runs.values()) {
        for (const r of newestFirst(list)) {
          const hit = r.signalData?.find((s) => s.id === id);
          if (hit) return structuredClone(hit);
        }
      }
      return undefined;
    },
    recentSignals: (triggerId, n) =>
      newestFirst(runs.get(triggerId) ?? [])
        .flatMap((r) => r.signalData ?? [])
        .slice(0, n)
        .map((s) => structuredClone(s)),
    dropRuns: (triggerId) => void runs.delete(triggerId),
    addNote(n) {
      const row: NoteRow = { ...structuredClone(n), id: noteId(), at: iso(now()) };
      const cutoff = iso(now() - NOTE_DAYS * DAY_MS);
      notes = [...notes.filter((x) => x.at >= cutoff), row];
      const mine = newestFirst(notes.filter((x) => x.triggerId === row.triggerId));
      if (mine.length > MAX_NOTES_PER_TRIGGER) {
        const gone = new Set(mine.slice(MAX_NOTES_PER_TRIGGER));
        notes = notes.filter((x) => !gone.has(x));
      }
      return structuredClone(row);
    },
    notes: (q) =>
      newestFirst(notes)
        .filter((n) => noteMatches(n, q))
        .slice(0, q.limit ?? DEFAULT_NOTE_LIMIT)
        .map((n) => structuredClone(n)),
    stateGet(triggerId, key) {
      const v = state.get(triggerId)?.get(key);
      return v === undefined ? undefined : JSON.parse(v);
    },
    stateSet(triggerId, key, value) {
      const m = state.get(triggerId) ?? new Map<string, string>();
      m.set(key, checkState(stateBytes(triggerId, stateBudget(key), [key]), key, value));
      state.set(triggerId, m);
    },
    stateDelete: (triggerId, key) => void state.get(triggerId)?.delete(key),
    dropState: (triggerId) => void state.delete(triggerId),
    stateBytes,
  };
}

/**
 * The `runs:<id>` lists the triggers plugin kept in storage move into the journal, once; returns how many runs moved.
 * Each list moves whole (inside `atomically` when given, e.g. one database transaction) or not at all: a malformed
 * list is reported to `warn` and left in storage, and never stops the others or the engine's start.
 */
export function migrateRunLists(kv: PluginKv, store: TriggerStore, opts: { atomically?: <T>(fn: () => T) => T; warn?: (msg: string) => void } = {}): number {
  const atomically = opts.atomically ?? (<T>(fn: () => T) => fn());
  let n = 0;
  for (const { key, value } of kv.list("runs:")) {
    const id = key.slice("runs:".length);
    try {
      if (!Array.isArray(value)) throw new TypeError("not a list");
      const runs = value as TriggerRun[];
      for (const r of runs) if (!r || typeof r !== "object" || typeof r.id !== "string" || typeof r.at !== "string") throw new TypeError("a run has no id or time");
      atomically(() => {
        // Stored newest first: add the oldest first so the journal keeps that order.
        for (const run of [...runs].reverse()) store.addRun(id, run);
      });
      kv.delete(key);
      n += runs.length;
    } catch (e: any) {
      opts.warn?.(`${key} was not moved to the journal: ${e?.message ?? e}`);
    }
  }
  return n;
}
