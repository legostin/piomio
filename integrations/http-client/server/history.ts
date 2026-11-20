// The journal of every request, the person's and the agents': SQLite in the plugin's data folder, one row per request,
// and a trigram full-text index over method, address, headers and bodies (a plain scan when FTS5 is missing or the
// words are under three characters). The newest MAX_ENTRIES rows stay, within MAX_TOTAL of stored text.

import { DatabaseSync } from "node:sqlite";
import type { Entry, EntrySummary, HistoryFilter, Pair } from "./types.ts";

export const MAX_ENTRIES = 5000;
/** Characters of one body kept in the history. */
export const MAX_STORED_BODY = 512 * 1024;
/** Characters of stored entries in all. */
export const MAX_TOTAL = 256 * 1024 * 1024;
/** Of a body, what the search reads. */
const INDEXED_REQUEST = 64 * 1024;
const INDEXED_RESPONSE = 256 * 1024;
const PAGE = 50;
const MAX_PAGE = 200;

interface Row {
  id: string;
  at: number;
  by: string;
  method: string;
  url: string;
  host: string;
  status: number | null;
  error: string | null;
  ms: number;
  bytes: number;
  saved: string | null;
}

const pairs = (list: Pair[] | undefined): string => (list ?? []).map((p) => `${p.name}: ${p.value}`).join("\n");

/** What the search reads of an entry, lower case. */
export function searchText(e: Entry): string {
  return [
    `${e.method} ${e.url}`,
    e.saved ?? "",
    pairs(e.request.headers),
    (e.request.body ?? "").slice(0, INDEXED_REQUEST),
    e.response ? `${e.response.status} ${e.response.statusText}` : "",
    e.response ? pairs(e.response.headers) : "",
    (e.response?.body ?? "").slice(0, INDEXED_RESPONSE),
    e.error?.message ?? "",
  ]
    .join("\n")
    .toLowerCase();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class History {
  private db: DatabaseSync;
  /** The index is FTS5 with trigrams; otherwise a plain table read with LIKE. */
  readonly fts: boolean;
  private max: number;
  private maxTotal: number;

  constructor(file: string, o: { max?: number; maxTotal?: number; fts?: boolean } = {}) {
    this.max = o.max ?? MAX_ENTRIES;
    this.maxTotal = o.maxTotal ?? MAX_TOTAL;
    this.db = new DatabaseSync(file);
    this.db.exec("pragma journal_mode = wal");
    this.db.exec(
      "create table if not exists entries(n integer primary key autoincrement, id text not null unique, at integer not null, by text not null, method text not null, url text not null, host text not null, status integer, error text, ms integer not null, bytes integer not null, saved text, size integer not null, data text not null)",
    );
    this.fts = this.openIndex(o.fts !== false);
  }

  /** The index, as it was made the first time: an FTS5 table, or a plain one where FTS5 is missing. */
  private openIndex(wantFts: boolean): boolean {
    const existing = this.db.prepare("select sql from sqlite_master where name = 'entries_text'").get() as { sql: string } | undefined;
    if (existing) return /fts5/i.test(existing.sql);
    if (wantFts) {
      try {
        this.db.exec("create virtual table entries_text using fts5(text, tokenize = 'trigram')");
        return true;
      } catch {
        /* no FTS5, or no trigram tokenizer, in this SQLite */
      }
    }
    this.db.exec("create table entries_text(text text not null)");
    return false;
  }

  add(e: Entry): void {
    const data = JSON.stringify(e);
    const r = this.db
      .prepare("insert into entries(id, at, by, method, url, host, status, error, ms, bytes, saved, size, data) values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(e.id, e.at, e.by, e.method, e.url, hostOf(e.url), e.response?.status ?? null, e.error?.message ?? null, e.ms, e.response?.bytes ?? 0, e.saved ?? null, data.length, data);
    this.db.prepare("insert into entries_text(rowid, text) values (?, ?)").run(r.lastInsertRowid, searchText(e));
    this.prune();
  }

  private prune(): void {
    const over = this.db.prepare("select n from entries order by n desc limit 1 offset ?").get(this.max) as { n: number } | undefined;
    if (over) this.dropUpTo(over.n);
    const total = (this.db.prepare("select coalesce(sum(size), 0) as s from entries").get() as { s: number }).s;
    if (total <= this.maxTotal) return;
    // The oldest go until the rest fits; the newest one always stays.
    let left = total;
    let cut: number | undefined;
    for (const row of this.db.prepare("select n, size from entries order by n asc").iterate() as Iterable<{ n: number; size: number }>) {
      if (left <= this.maxTotal) break;
      left -= row.size;
      cut = row.n;
    }
    const newest = (this.db.prepare("select max(n) as n from entries").get() as { n: number }).n;
    if (cut !== undefined) this.dropUpTo(Math.min(cut, newest - 1));
  }

  private dropUpTo(n: number): void {
    this.db.prepare("delete from entries_text where rowid <= ?").run(n);
    this.db.prepare("delete from entries where n <= ?").run(n);
  }

  get(id: string): Entry | undefined {
    const row = this.db.prepare("select data from entries where id = ?").get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Entry) : undefined;
  }

  count(): number {
    return (this.db.prepare("select count(*) as c from entries").get() as { c: number }).c;
  }

  remove(id: string): boolean {
    const row = this.db.prepare("select n from entries where id = ?").get(id) as { n: number } | undefined;
    if (!row) return false;
    this.db.prepare("delete from entries_text where rowid = ?").run(row.n);
    this.db.prepare("delete from entries where n = ?").run(row.n);
    return true;
  }

  clear(): void {
    this.db.exec("delete from entries_text");
    this.db.exec("delete from entries");
  }

  /** Newest first. `more`: there are older ones that match. */
  search(f: HistoryFilter = {}): { entries: EntrySummary[]; more: boolean } {
    const where: string[] = [];
    const args: Array<string | number> = [];
    const words = (f.q ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (words.length) {
      if (this.fts && words.every((w) => [...w].length >= 3)) {
        where.push("e.n in (select rowid from entries_text where entries_text match ?)");
        args.push(words.map((w) => `"${w.replace(/"/g, '""')}"`).join(" "));
      } else {
        for (const w of words) {
          where.push("e.n in (select rowid from entries_text where text like ? escape '\\')");
          args.push(`%${likeEscape(w)}%`);
        }
      }
    }
    if (f.host) {
      const host = f.host.toLowerCase().replace(/^\*\./, "");
      where.push("(e.host = ? or e.host like ? escape '\\')");
      args.push(host, `%.${likeEscape(host)}`);
    }
    if (f.method) {
      where.push("e.method = ?");
      args.push(f.method.toUpperCase());
    }
    if (f.status) {
      const s = f.status.toLowerCase();
      if (s === "error") where.push("e.error is not null");
      else if (/^[1-5]xx$/.test(s)) {
        where.push("e.status between ? and ?");
        args.push(Number(s[0]) * 100, Number(s[0]) * 100 + 99);
      } else if (/^\d{3}$/.test(s)) {
        where.push("e.status = ?");
        args.push(Number(s));
      } else where.push("0");
    }
    if (f.by) {
      where.push("e.by = ?");
      args.push(f.by);
    }
    if (f.since !== undefined && Number.isFinite(f.since)) {
      where.push("e.at >= ?");
      args.push(f.since);
    }
    if (f.before) {
      where.push("e.n < coalesce((select n from entries where id = ?), 0)");
      args.push(f.before);
    }
    const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(f.limit ?? PAGE)));
    const rows = this.db
      .prepare(`select e.id, e.at, e.by, e.method, e.url, e.host, e.status, e.error, e.ms, e.bytes, e.saved from entries e ${where.length ? `where ${where.join(" and ")}` : ""} order by e.n desc limit ?`)
      .all(...args, limit + 1) as unknown as Row[];
    return {
      more: rows.length > limit,
      entries: rows.slice(0, limit).map((r) => ({
        id: r.id,
        at: r.at,
        by: r.by,
        method: r.method as EntrySummary["method"],
        url: r.url,
        host: r.host,
        ...(r.status !== null ? { status: r.status } : {}),
        ...(r.error !== null ? { error: r.error } : {}),
        ms: r.ms,
        bytes: r.bytes,
        ...(r.saved !== null ? { saved: r.saved } : {}),
      })),
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
