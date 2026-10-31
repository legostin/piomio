// The plugin's working state: how often each fact was recalled, the journal of the user's messages for the nightly
// reflection, and small settings like when memory was last tidied. It lives in the hub's plugin storage, which hub
// replicas share row by row, so what each hub wrote while it led merges into one state: one row per fact's usage,
// per journal entry and per setting.
// Keys: "usage:<path>" → Usage, "journal:<at> <hash>" → the entry, "meta:<key>" → a string.
//
// Until 2026-11 it was a state.db next to the memory folder; open() takes in such files (and the copies file sync
// made of them) once and deletes them.

import { createHash } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PluginContext } from "@piomio/plugin-sdk";
import type { Usage } from "./recall.ts";

export type Storage = PluginContext["storage"];

export interface JournalEntry {
  key: string;
  at: string;
  agent: string;
  conversation: string;
  text: string;
}

/** Journal entries kept at most (oldest go first). */
const MAX_JOURNAL = 400;
const USAGE = "usage:";
const JOURNAL = "journal:";
const META = "meta:";
/** The old state database and the copies file sync made of it ("state (conflict vps 2026-10-31 0300).db"). */
const LEGACY = /^state(?: \(conflict [^()]*\))?\.db$/;

const journalKey = (e: Omit<JournalEntry, "key">) =>
  `${JOURNAL}${e.at} ${createHash("sha256").update(`${e.agent}\n${e.conversation}\n${e.text}`).digest("hex").slice(0, 12)}`;

const later = (a: string | undefined, b: string | undefined) => ((a ?? "") >= (b ?? "") ? a : b);

export class MemoryState {
  private storage: Storage;
  private warn: (msg: string) => void;
  /** Usage is read on every turn: kept here, loaded when the plugin starts (on the hub that leads). */
  private usages = new Map<string, Usage>();
  private journalKeys: string[] = [];
  private pending = new Set<Promise<unknown>>();

  private constructor(storage: Storage, warn: (msg: string) => void) {
    this.storage = storage;
    this.warn = warn;
  }

  static async open(storage: Storage, dataDir: string, warn: (msg: string) => void): Promise<MemoryState> {
    const s = new MemoryState(storage, warn);
    for (const { key, value } of await storage.list(USAGE)) {
      const u = value as Usage | null;
      if (u && typeof u.recalled === "number") s.usages.set(key.slice(USAGE.length), { recalled: u.recalled, lastRecalled: String(u.lastRecalled ?? "") });
    }
    s.journalKeys = (await storage.list(JOURNAL)).map((r) => r.key);
    await s.adoptLegacy(dataDir);
    return s;
  }

  usage(path: string): Usage | undefined {
    return this.usages.get(path);
  }

  recalled(paths: string[], at = new Date().toISOString()): void {
    for (const p of paths) this.putUsage(p, { recalled: (this.usages.get(p)?.recalled ?? 0) + 1, lastRecalled: at });
  }

  moveUsage(from: string, to: string): void {
    const u = this.usages.get(from);
    if (!u) return;
    const t = this.usages.get(to);
    this.putUsage(to, { recalled: u.recalled + (t?.recalled ?? 0), lastRecalled: later(u.lastRecalled, t?.lastRecalled) ?? "" });
  }

  journal(entry: Omit<JournalEntry, "key">): void {
    const key = journalKey(entry);
    if (this.journalKeys.includes(key)) return;
    this.journalKeys.push(key);
    this.write(this.storage.set(key, entry));
    this.trim();
  }

  /** Every entry, oldest first, those other hubs wrote included (read from the storage, not from what this one wrote). */
  async journalEntries(): Promise<JournalEntry[]> {
    await this.flush();
    const rows = (await this.storage.list(JOURNAL)).sort((a, b) => a.key.localeCompare(b.key));
    this.journalKeys = rows.map((r) => r.key);
    this.trim();
    return rows.slice(-MAX_JOURNAL).map(({ key, value }) => ({ ...(value as Omit<JournalEntry, "key">), key }));
  }

  async clearJournal(entries: JournalEntry[]): Promise<void> {
    const gone = new Set(entries.map((e) => e.key));
    this.journalKeys = this.journalKeys.filter((k) => !gone.has(k));
    await Promise.all([...gone].map((k) => this.storage.delete(k)));
  }

  async get(key: string): Promise<string | undefined> {
    await this.flush();
    const v = await this.storage.get<string>(META + key);
    return typeof v === "string" ? v : undefined;
  }

  set(key: string, value: string): void {
    this.write(this.storage.set(META + key, value));
  }

  /** Writes still on their way to the hub. */
  async flush(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private putUsage(path: string, u: Usage): void {
    this.usages.set(path, u);
    this.write(this.storage.set(USAGE + path, u));
  }

  private trim(): void {
    if (this.journalKeys.length <= MAX_JOURNAL) return;
    this.journalKeys.sort();
    for (const k of this.journalKeys.splice(0, this.journalKeys.length - MAX_JOURNAL)) this.write(this.storage.delete(k));
  }

  private write(p: Promise<unknown>): void {
    const tracked = p.catch((e) => this.warn(`memory: could not save its state: ${e?.message ?? e}`)).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  /**
   * The state.db files of earlier versions: usage takes the larger count, the journal gains what it lacks (entries
   * older than the last reflection were reflected on already), settings keep the later time. Then the files go.
   */
  private async adoptLegacy(dataDir: string): Promise<void> {
    let names: string[];
    try {
      names = readdirSync(dataDir).filter((n) => LEGACY.test(n));
    } catch {
      return;
    }
    if (!names.length) return;
    const meta = new Map<string, string>();
    for (const { key, value } of await this.storage.list(META)) if (typeof value === "string") meta.set(key.slice(META.length), value);
    const journal: Array<Omit<JournalEntry, "key">> = [];
    for (const name of names) {
      let db: DatabaseSync | undefined;
      try {
        db = new DatabaseSync(join(dataDir, name), { readOnly: true });
        const has = (t: string) => !!db!.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(t);
        if (has("usage")) {
          for (const r of db.prepare("select path, recalled, last_recalled from usage").all() as Array<{ path: string; recalled: number; last_recalled: string }>) {
            const u = this.usages.get(r.path);
            if (!u || r.recalled > u.recalled || r.last_recalled > u.lastRecalled) {
              this.putUsage(r.path, { recalled: Math.max(r.recalled, u?.recalled ?? 0), lastRecalled: later(r.last_recalled, u?.lastRecalled) ?? "" });
            }
          }
        }
        if (has("meta")) {
          for (const r of db.prepare("select key, value from meta").all() as Array<{ key: string; value: string }>) meta.set(r.key, later(meta.get(r.key), r.value) ?? r.value);
        }
        if (has("journal")) journal.push(...(db.prepare("select at, agent, conversation, text from journal order by id").all() as Array<Omit<JournalEntry, "key">>));
      } catch (e: any) {
        this.warn(`memory: could not read the old state file ${name}: ${e?.message ?? e}`);
        db?.close();
        return; // the files stay for the next start
      }
      db.close();
    }
    for (const [k, v] of meta) this.set(k, v);
    const reflected = meta.get("lastReflect") ?? "";
    for (const e of journal) if (e.at > reflected) this.journal(e);
    await this.flush();
    for (const name of names) for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(join(dataDir, name + suffix), { force: true });
  }
}
