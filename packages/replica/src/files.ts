// File replication shared by hub replicas and machine nodes (spec 2026-10-30-cluster-design.md, "2. Replicas → Files").
// Each side scans its roots into a journal (one row per path: its newest version and a seq), keeps per peer a cursor
// into the peer's journal and the last agreed hash of each path, and pulls: a path changed only there is downloaded
// by hash, changed only here waits for the peer to pull it, changed on both keeps the newer one in place and the other
// as `name (conflict <machine> <date>).ext`. Deletions travel the same way. SQLite files travel as a consistent copy.
// Transport-agnostic: a peer is anything with changesSince and read (HTTPS between replicas, the node's WebSocket RPC).
//
// Each version also carries its `history`: short ids of the versions the path had on that side before it (null: the
// path was absent). A version whose history holds ours was made from ours and is taken without a conflict, even when
// the peer changed it again before we saw the copy it took; one we have in our own history is old news and loses.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, watch, writeSync } from "node:fs";
import type { Dirent, FSWatcher, Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, rmdir, unlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { IGNORED_DIRS, IGNORED_FILES, Ignore, ignoredName, SQLITE_SIDE, TEMP_PREFIX } from "./ignore.ts";

export interface FileRoot {
  /** logical name, the same on every side ("workspaces") */
  name: string;
  /** absolute folder */
  dir: string;
}

export interface FileChange {
  root: string;
  /** posix, relative to the root */
  path: string;
  /** sha256 (hex) of the content; null: deleted */
  sha: string | null;
  size: number;
  mtimeMs: number;
  seq: number;
  /** earlier versions of this path on that side, newest first: 16-hex sha prefixes, null = absent */
  history?: (string | null)[];
}

export interface FilePeer {
  changesSince(cursor: number, limit: number): Promise<{ changes: FileChange[]; cursor: number; more: boolean }>;
  /** undefined: that version is gone */
  read(root: string, path: string, sha: string): Promise<Uint8Array | undefined>;
}

export interface FileSyncOptions {
  roots: FileRoot[];
  /** SQLite file holding the journal, the index and what was agreed with each peer */
  stateFile: string;
  /** this side's machine name: it names the local version when it loses a conflict */
  self: string;
  log?: (m: string) => void;
  /** larger files are left out (default 200 MB) */
  maxFileBytes?: number;
  /** called after a scan or a round wrote new journal entries (peers can be told to pull) */
  onChange?: (count: number) => void;
}

export interface SyncResult {
  pulled: number;
  deleted: number;
  conflicts: number;
}

interface Row {
  sha: string | null;
  size: number;
  mtime: number;
  seq: number;
  /** what the file looked like when hashed ("ino:size:mtime", plus the -wal's size and mtime for SQLite) */
  stat: string | null;
  history: (string | null)[];
}

interface DbRow {
  path?: string;
  sha: string | null;
  size: number;
  mtime: number;
  seq: number;
  stat: string | null;
  history: string;
}

type Plan = "agree" | "take" | "keep" | "theirs-win" | "ours-win";
type Outcome = "done" | "again" | "later" | "skip";

/** A bigger file is left out of the sync (FileSyncOptions.maxFileBytes): it stays where it was made. */
export const MAX_SYNC_FILE_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAX = MAX_SYNC_FILE_BYTES;
const PAGE = 500;
const HISTORY = 16;
const SHA_RE = /^[0-9a-f]{64}$/;
const SQLITE_NAME = /\.(db|sqlite|sqlite3)$/i;
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");
/** A live database is copied at most this often by the periodic scan. */
const SQLITE_EVERY_MS = 10_000;
/** Temp files of an interrupted write older than this are removed by the scan. */
const STALE_TEMP_MS = 10 * 60_000;
/** Not trackable here (too big, not a regular file): the change is left. */
const SKIP = Symbol("skip");
/** Unreadable right now (being written, a locked database): the change waits for the next round. */
const LATER = Symbol("later");

export class FileSync {
  private readonly roots = new Map<string, FileRoot>();
  private readonly rootNames: string;
  private readonly db: DatabaseSync;
  private readonly self: string;
  private readonly log: (m: string) => void;
  private readonly maxFileBytes: number;
  private readonly onChange?: (count: number) => void;
  private readonly q: ReturnType<typeof statements>;
  private chain: Promise<unknown> = Promise.resolve();
  private journaled = 0;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private hintTimer?: NodeJS.Timeout;
  private watchers: FSWatcher[] = [];
  private scanQueued = false;
  private readonly noted = new Set<string>();
  private readonly sqliteCopiedAt = new Map<string, number>();

  constructor(o: FileSyncOptions) {
    for (const r of o.roots) {
      if (!r.name || this.roots.has(r.name)) throw new Error(`file root "${r.name}" is empty or repeated`);
      this.roots.set(r.name, { name: r.name, dir: resolve(r.dir) });
    }
    this.rootNames = JSON.stringify([...this.roots.keys()]);
    this.self = o.self;
    this.log = o.log ?? (() => {});
    this.maxFileBytes = o.maxFileBytes ?? DEFAULT_MAX;
    this.onChange = o.onChange;
    mkdirSync(dirname(o.stateFile), { recursive: true });
    this.db = new DatabaseSync(o.stateFile);
    this.db.exec(`
      pragma journal_mode = wal;
      pragma synchronous = normal;
      create table if not exists meta(key text primary key, value integer not null);
      create table if not exists files(root text not null, path text not null, sha text, size integer not null,
        mtime_ms real not null, seq integer not null, stat text, history text not null default '[]', primary key(root, path));
      create index if not exists files_seq on files(seq);
      create table if not exists cursors(peer text primary key, cursor integer not null);
      create table if not exists bases(peer text not null, root text not null, path text not null, sha text,
        primary key(peer, root, path));
      create table if not exists retries(peer text not null, root text not null, path text not null, change text not null,
        primary key(peer, root, path));
    `);
    // Seqs start at the creation time in microseconds: a side whose state was wiped starts above every old cursor,
    // so its peers still read its whole new journal.
    this.db.prepare("insert or ignore into meta(key, value) values ('seq', ?)").run(Date.now() * 1000);
    this.q = statements(this.db);
  }

  /** Detect local changes into the journal; returns how many. */
  scan(): Promise<number> {
    return this.exclusive(() => this.scanNow(false));
  }

  /** The newest version of each path changed after `cursor`, oldest first. */
  changesSince(cursor: number, limit = 1000): { changes: FileChange[]; cursor: number; more: boolean } {
    const lim = Math.max(1, Math.min(Math.floor(limit) || 1000, 10_000));
    const after = Math.max(0, Math.floor(cursor) || 0);
    const rows = this.q.changes.all(after, this.rootNames, lim + 1) as unknown as (DbRow & { root: string; path: string })[];
    const changes = rows.slice(0, lim).map((r) => ({
      root: r.root,
      path: r.path,
      sha: r.sha,
      size: r.size,
      mtimeMs: r.mtime,
      seq: r.seq,
      history: parseHistory(r.history),
    }));
    // Nothing new: a cursor beyond this journal (the peer kept one from before a wipe) comes back lower.
    const max = (this.q.maxSeq.get() as { n: number }).n;
    return { changes, cursor: changes.length ? changes[changes.length - 1].seq : Math.min(after, max), more: rows.length > lim };
  }

  /** One version of a file, as hashed (SQLite as its consistent copy); undefined when it is not that version any more. */
  async read(root: string, path: string, sha: string): Promise<Uint8Array | undefined> {
    const r = this.roots.get(root);
    if (!r || !validRel(path) || typeof sha !== "string" || !SHA_RE.test(sha)) return undefined;
    if (this.ignoreOf(r).ignored(path, false) || !(await this.parentsSafe(r, path))) return undefined;
    const abs = this.abs(r, path);
    try {
      const st = await lstat(abs);
      if (!st.isFile() || st.size > this.maxFileBytes) return undefined;
      const bytes = isSqliteName(path) && (await hasSqliteHeader(abs)) ? await withSqliteCopy(abs, (c) => readFile(c)) : await readFile(abs);
      return sha256(bytes) === sha ? bytes : undefined;
    } catch {
      return undefined;
    }
  }

  /** Pull what `peer` changed since the last round and merge it here. */
  syncFrom(peerId: string, peer: FilePeer): Promise<SyncResult> {
    return this.exclusive(async () => {
      const out: SyncResult = { pulled: 0, deleted: 0, conflicts: 0 };
      const before = this.journaled;
      const ignores = new Map<string, Ignore>();
      const handled = new Set<string>();
      let cursor = (this.q.cursor.get(peerId) as { cursor: number } | undefined)?.cursor ?? 0;
      let restarted = false;
      try {
        for (;;) {
          const prev = cursor;
          const page = await peer.changesSince(cursor, PAGE);
          const changes = Array.isArray(page?.changes) ? page.changes : [];
          const next = typeof page?.cursor === "number" && Number.isFinite(page.cursor) ? page.cursor : cursor;
          if (next < cursor && !restarted) {
            // The peer's journal starts over (its state was wiped or restored): read it all; what both have agrees.
            this.log(`files: ${peerId}'s journal starts over, reading it again`);
            restarted = true;
            cursor = 0;
            continue;
          }
          for (const r of changes) {
            if (!wellFormed(r)) continue;
            handled.add(`${r.root}/${r.path}`);
            await this.applyOrRetry(peerId, peer, r, ignores, out);
          }
          cursor = Math.max(cursor, next);
          this.q.setCursor.run(peerId, cursor);
          if (!page?.more || !changes.length || cursor === prev) break;
        }
        // Versions the peer could not serve before, unless a newer one of the same path came just now.
        for (const t of this.q.retries.all(peerId) as { root: string; path: string; change: string }[]) {
          if (handled.has(`${t.root}/${t.path}`)) continue;
          const r = JSON.parse(t.change) as FileChange;
          if (wellFormed(r)) await this.applyOrRetry(peerId, peer, r, ignores, out);
          else this.q.dropRetry.run(peerId, t.root, t.path);
        }
      } finally {
        this.changed(this.journaled - before);
      }
      return out;
    });
  }

  /** Scan every `intervalMs` (default 3 s), and soon after file events where the OS watches whole trees. */
  start(intervalMs = 3000): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.kick(), intervalMs);
    this.timer.unref();
    if (process.platform === "darwin" || process.platform === "win32") {
      for (const root of this.roots.values()) {
        try {
          const w = watch(root.dir, { recursive: true }, (_event, name) => {
            if (typeof name === "string" && quietEvent(name)) return;
            clearTimeout(this.hintTimer);
            this.hintTimer = setTimeout(() => this.kick(), 300);
            this.hintTimer.unref();
          });
          w.on("error", () => w.close());
          w.unref();
          this.watchers.push(w);
        } catch {
          // No root yet, or no watching here: the interval still scans.
        }
      }
    }
    this.kick();
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.hintTimer);
    this.timer = this.hintTimer = undefined;
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  /** Stop, let the running scan or round finish, and close the state file. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.stop();
    this.closed = true;
    await this.chain;
    this.db.close();
  }

  /** Drop a peer's cursor and agreed versions (a revoked replica, a machine that left). */
  forget(peerId: string): void {
    this.q.forgetCursor.run(peerId);
    this.q.forgetBases.run(peerId);
    this.q.forgetRetries.run(peerId);
  }

  // ---- scanning ----

  private kick(): void {
    if (this.scanQueued || this.closed) return;
    this.scanQueued = true;
    this.exclusive(() => {
      this.scanQueued = false;
      return this.scanNow(true);
    }).catch((e: unknown) => this.log(`files: scan failed: ${(e as Error).message}`));
  }

  /** `periodic`: a background scan, which copies a live database at most every SQLITE_EVERY_MS. */
  private async scanNow(periodic: boolean): Promise<number> {
    const before = this.journaled;
    for (const root of this.roots.values()) await this.scanRoot(root, periodic);
    const n = this.journaled - before;
    this.changed(n);
    return n;
  }

  private async scanRoot(root: FileRoot, periodic: boolean): Promise<void> {
    // A missing root (not made yet, unmounted) deletes nothing.
    if (!(await lstat(root.dir).then((s) => s.isDirectory(), () => false))) return;
    const rows = new Map<string, Row>();
    for (const r of this.q.rowsOf.all(root.name) as unknown as DbRow[]) rows.set(r.path!, toRow(r));
    const ignore = this.ignoreOf(root);
    const seen = new Set<string>();
    const walk = async (parts: string[]): Promise<void> => {
      const dir = join(root.dir, ...parts);
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = [...parts, e.name];
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (!ignore.entryIgnored(p, true)) await walk(p);
        } else if (e.isFile()) {
          if (e.name.startsWith(TEMP_PREFIX)) await sweepTemp(join(dir, e.name));
          if (ignore.entryIgnored(p, false)) continue;
          const rel = p.join("/");
          seen.add(rel);
          await this.observe(root, rel, rows.get(rel), periodic);
        }
      }
    };
    await walk([]);
    for (const [rel, row] of rows) {
      if (row.sha === null || seen.has(rel)) continue;
      // Only a missing file is a deletion; one left out now (ignored, too big, a link) just stops syncing.
      if (await lstat(this.abs(root, rel)).then(() => false, isGone)) this.journalDelete(root, rel, row, Date.now());
    }
  }

  /** Bring the index entry of one path up to date with the disk; returns it (undefined: never seen, not there). */
  private async observe(root: FileRoot, rel: string, row: Row | undefined, periodic: boolean): Promise<Row | undefined | typeof SKIP | typeof LATER> {
    const abs = this.abs(root, rel);
    let st: Stats;
    try {
      st = await lstat(abs);
    } catch (e) {
      if (!isGone(e)) return LATER;
      return row && row.sha !== null ? this.journalDelete(root, rel, row, Date.now()) : row;
    }
    if (!st.isFile()) return SKIP;
    if (st.size > this.maxFileBytes) {
      this.note(`big ${root.name}/${rel} ${st.size}`, `files: left out ${root.name}/${rel} (${mb(st.size)} MB, over ${mb(this.maxFileBytes)} MB)`);
      return SKIP;
    }
    const sqlite = isSqliteName(rel) && (await hasSqliteHeader(abs));
    const key = await statKey(abs, st, sqlite);
    if (row && row.sha !== null && row.stat === key) return row;
    if (sqlite && periodic && row?.sha) {
      const id = `${root.name}/${rel}`;
      const last = this.sqliteCopiedAt.get(id) ?? 0;
      if (Date.now() - last < SQLITE_EVERY_MS) return row;
      this.sqliteCopiedAt.set(id, Date.now());
    }
    let sha: string;
    let size = st.size;
    let mtime = st.mtimeMs;
    try {
      if (sqlite) {
        // The copy is a snapshot by itself; the stat taken before it makes the next scan look again if it moved on.
        ({ sha, size } = await withSqliteCopy(abs, async (c) => ({ sha: await hashFile(c), size: (await lstat(c)).size })));
        const wal = await lstat(`${abs}-wal`).catch(() => undefined);
        mtime = Math.max(mtime, wal?.mtimeMs ?? 0);
      } else {
        sha = await hashFile(abs);
        // Changed while being read: next time.
        const after = await lstat(abs).catch(() => undefined);
        if (!after || (await statKey(abs, after, false)) !== key) return LATER;
      }
    } catch (e) {
      this.note(`unreadable ${root.name}/${rel}`, `files: cannot read ${root.name}/${rel}: ${(e as Error).message}`);
      return LATER;
    }
    if (row && row.sha === sha) {
      this.q.setStat.run(key, root.name, rel);
      return { ...row, stat: key };
    }
    return this.journal(root.name, rel, { sha, size, mtime, stat: key, history: row ? mergeHistory(sha, [row.sha], row.history) : [] });
  }

  // ---- merging ----

  /** A change that could not be merged now (the peer could not serve that version) is kept and tried every round. */
  private async applyOrRetry(peerId: string, peer: FilePeer, r: FileChange, ignores: Map<string, Ignore>, out: SyncResult): Promise<void> {
    if (await this.apply(peerId, peer, r, ignores, out)) this.q.dropRetry.run(peerId, r.root, r.path);
    else this.q.putRetry.run(peerId, r.root, r.path, JSON.stringify(r));
  }

  /** Merge one remote change; false: try it again next round. */
  private async apply(peerId: string, peer: FilePeer, r: FileChange, ignores: Map<string, Ignore>, out: SyncResult): Promise<boolean> {
    const root = this.roots.get(r.root);
    if (!root || !validRel(r.path)) return true;
    let ignore = ignores.get(root.name);
    if (!ignore) ignores.set(root.name, (ignore = this.ignoreOf(root)));
    if (ignore.ignored(r.path, false)) return true;
    if (r.sha !== null && r.size > this.maxFileBytes) {
      this.note(`big remote ${root.name}/${r.path} ${r.size}`, `files: left out ${peerId}'s ${root.name}/${r.path} (${mb(r.size)} MB)`);
      return true;
    }
    const theirs = Array.isArray(r.history) ? r.history.filter((v) => v === null || typeof v === "string") : undefined;
    const change: FileChange = { ...r, mtimeMs: Number.isFinite(r.mtimeMs) ? r.mtimeMs : Date.now(), history: theirs };
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await this.observe(root, r.path, this.rowOf(root.name, r.path), false);
      if (row === SKIP) return true;
      if (row === LATER) return false;
      const base = this.q.base.get(peerId, root.name, r.path) as { sha: string | null } | undefined;
      const { plan, conflict } = decide(change, row, base === undefined ? undefined : base.sha);
      const res = await this.execute(plan, peerId, peer, root, change, row, out);
      if (res === "again") continue;
      if (res === "later") return false;
      if (res === "skip") return true;
      if (conflict) out.conflicts++;
      this.q.setBase.run(peerId, root.name, r.path, r.sha);
      return true;
    }
    return false;
  }

  private async execute(plan: Plan, peerId: string, peer: FilePeer, root: FileRoot, r: FileChange, row: Row | undefined, out: SyncResult): Promise<Outcome> {
    const rel = r.path;
    if (plan === "agree") {
      if (row) {
        const history = mergeHistory(row.sha, row.history, r.history);
        if (JSON.stringify(history) !== JSON.stringify(row.history)) this.q.setHistory.run(JSON.stringify(history), root.name, rel);
      }
      return "done";
    }
    if (plan === "keep") {
      // Ours stands: journal it again, naming theirs as seen, so the peer takes ours when it pulls.
      const own = row!;
      this.journal(root.name, rel, { ...own, history: mergeHistory(own.sha, [r.sha], own.history, r.history) });
      return "done";
    }
    const history = mergeHistory(r.sha, row ? [row.sha] : [], r.history, row?.history);
    if (r.sha === null) {
      // take a deletion
      if (!(await this.unchanged(root, rel, row))) return "again";
      if (await this.removeAt(root, rel)) out.deleted++;
      this.journal(root.name, rel, { sha: null, size: 0, mtime: r.mtimeMs, stat: null, history });
      return "done";
    }
    const bytes = await this.download(peerId, peer, r);
    if (!bytes) return "later";
    if (plan === "ours-win") {
      // Ours keeps the path; theirs is written next to it under the peer's name.
      const own = row!;
      const copy = await this.conflictPath(root, rel, peerId, r.mtimeMs, r.sha);
      if (!copy) return "skip";
      if (!copy.same) {
        if (!(await this.writeTracked(root, copy.rel, bytes, r.sha, r.mtimeMs))) return "skip";
        out.pulled++;
      }
      this.journal(root.name, rel, { ...own, history: mergeHistory(own.sha, [r.sha], own.history, r.history) });
      return "done";
    }
    if (!(await this.unchanged(root, rel, row))) return "again";
    if (plan === "theirs-win") {
      // Theirs takes the path; ours moves next to it under this machine's name.
      const own = row!;
      const copy = await this.conflictPath(root, rel, this.self, own.mtime, own.sha);
      if (!copy) return "skip";
      if (!copy.same) {
        const abs = this.abs(root, rel);
        try {
          if (isSqliteName(rel) && (await hasSqliteHeader(abs))) {
            await this.writeAt(root, copy.rel, await withSqliteCopy(abs, (c) => readFile(c)), own.mtime);
          } else {
            await rename(abs, this.abs(root, copy.rel));
          }
        } catch (e) {
          this.note(`copy ${root.name}/${rel}`, `files: cannot keep ${root.name}/${rel} as a conflict copy: ${(e as Error).message}`);
          return "skip";
        }
        await this.observe(root, copy.rel, this.rowOf(root.name, copy.rel), false);
      }
    }
    // take theirs (also a conflict's restore of a file deleted here)
    let st: Stats;
    try {
      st = await this.writeAt(root, rel, bytes, r.mtimeMs);
    } catch (e) {
      this.note(`write ${root.name}/${rel}`, `files: cannot write ${root.name}/${rel}: ${(e as Error).message}`);
      return "skip";
    }
    this.journal(root.name, rel, { sha: r.sha, size: bytes.length, mtime: r.mtimeMs, stat: await statKey(this.abs(root, rel), st, false), history });
    out.pulled++;
    return "done";
  }

  private async download(peerId: string, peer: FilePeer, r: FileChange): Promise<Uint8Array | undefined> {
    const bytes = await peer.read(r.root, r.path, r.sha!);
    if (!bytes) return undefined;
    if (sha256(bytes) !== r.sha) {
      this.log(`files: ${peerId} sent ${r.root}/${r.path} with another hash; trying again next round`);
      return undefined;
    }
    return bytes;
  }

  /** A free name for the conflict copy, or the one already holding that very version. */
  private async conflictPath(root: FileRoot, rel: string, machine: string, mtimeMs: number, sha: string | null): Promise<{ rel: string; same: boolean } | undefined> {
    for (let n = 1; n < 100; n++) {
      const name = conflictName(rel, machine, mtimeMs, n);
      const st = await lstat(this.abs(root, name)).catch(() => undefined);
      if (!st) return { rel: name, same: false };
      if (!st.isFile() || sha === null) continue;
      const have = await this.observe(root, name, this.rowOf(root.name, name), false);
      if (typeof have === "object" && have.sha === sha) return { rel: name, same: true };
    }
    return undefined;
  }

  /** Write a version we know the hash of and journal it. */
  private async writeTracked(root: FileRoot, rel: string, bytes: Uint8Array, sha: string, mtimeMs: number): Promise<boolean> {
    try {
      const st = await this.writeAt(root, rel, bytes, mtimeMs);
      const row = this.rowOf(root.name, rel);
      const history = row ? mergeHistory(sha, [row.sha], row.history) : [];
      this.journal(root.name, rel, { sha, size: bytes.length, mtime: mtimeMs, stat: await statKey(this.abs(root, rel), st, false), history });
      return true;
    } catch (e) {
      this.note(`write ${root.name}/${rel}`, `files: cannot write ${root.name}/${rel}: ${(e as Error).message}`);
      return false;
    }
  }

  /** The file is still what the index says (checked again right before replacing it). */
  private async unchanged(root: FileRoot, rel: string, row: Row | undefined): Promise<boolean> {
    const abs = this.abs(root, rel);
    const st = await lstat(abs).catch((e: unknown) => (isGone(e) ? null : undefined));
    if (st === undefined) return false;
    if (!row || row.sha === null) return st === null;
    if (st === null || !st.isFile()) return false;
    return (await statKey(abs, st, isSqliteName(rel) && (await hasSqliteHeader(abs)))) === row.stat;
  }

  // ---- the disk ----

  /** Atomically: a temp file in the same folder, its time set, renamed over the path. */
  private async writeAt(root: FileRoot, rel: string, bytes: Uint8Array, mtimeMs: number): Promise<Stats> {
    await this.ensureParents(root, rel);
    const abs = this.abs(root, rel);
    const cur = await lstat(abs).catch(() => undefined);
    if (cur && !cur.isFile()) throw new Error("a folder or a link is in the way");
    const tmp = join(dirname(abs), `${TEMP_PREFIX}${randomBytes(6).toString("hex")}.tmp`);
    try {
      const fh = await open(tmp, "wx", 0o644);
      try {
        await fh.writeFile(bytes);
        await fh.sync();
      } finally {
        await fh.close();
      }
      if (cur) await chmod(tmp, cur.mode & 0o7777);
      await utimes(tmp, new Date(), new Date(mtimeMs));
      // Side files of the database being replaced would be read into the new one.
      if (isSqliteName(rel)) removeSqliteSide(abs);
      await rename(tmp, abs);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    return lstat(abs);
  }

  private async removeAt(root: FileRoot, rel: string): Promise<boolean> {
    if (!(await this.parentsSafe(root, rel))) return false;
    const abs = this.abs(root, rel);
    const st = await lstat(abs).catch(() => undefined);
    if (!st?.isFile()) return false;
    if (isSqliteName(rel)) removeSqliteSide(abs);
    await unlink(abs);
    // Folders left empty go too (OS junk alone counts as empty).
    const parts = rel.split("/");
    parts.pop();
    while (parts.length) {
      const dir = join(root.dir, ...parts);
      const names = await readdir(dir).catch(() => undefined);
      if (!names || names.some((n) => !IGNORED_FILES.has(n))) break;
      for (const n of names) await rm(join(dir, n), { force: true });
      if (!(await rmdir(dir).then(() => true, () => false))) break;
      parts.pop();
    }
    return true;
  }

  /** Make the folders above `rel`; a link or a file in the way is refused (nothing is written outside the root). */
  private async ensureParents(root: FileRoot, rel: string): Promise<void> {
    await mkdir(root.dir, { recursive: true });
    let dir = root.dir;
    const parts = rel.split("/");
    parts.pop();
    for (const p of parts) {
      dir = join(dir, p);
      let st = await lstat(dir).catch(() => undefined);
      if (!st) {
        await mkdir(dir).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== "EEXIST") throw e;
        });
        st = await lstat(dir);
      }
      if (!st.isDirectory()) throw new Error(`${p} is not a folder`);
    }
  }

  private async parentsSafe(root: FileRoot, rel: string): Promise<boolean> {
    let dir = root.dir;
    const parts = rel.split("/");
    parts.pop();
    for (const p of parts) {
      dir = join(dir, p);
      if (!(await lstat(dir).then((s) => s.isDirectory(), () => false))) return false;
    }
    return true;
  }

  // ---- state ----

  private journal(root: string, rel: string, v: Omit<Row, "seq">): Row {
    const seq = (this.q.nextSeq.get() as { value: number }).value;
    this.q.put.run(root, rel, v.sha, v.size, v.mtime, seq, v.stat, JSON.stringify(v.history));
    this.journaled++;
    return { ...v, seq };
  }

  private journalDelete(root: FileRoot, rel: string, row: Row, mtime: number): Row {
    return this.journal(root.name, rel, { sha: null, size: 0, mtime, stat: null, history: mergeHistory(null, [row.sha], row.history) });
  }

  private rowOf(root: string, rel: string): Row | undefined {
    const r = this.q.row.get(root, rel) as unknown as DbRow | undefined;
    return r && toRow(r);
  }

  private ignoreOf(root: FileRoot): Ignore {
    return new Ignore((dir) => {
      try {
        return readFileSync(join(root.dir, ...(dir ? dir.split("/") : []), ".gitignore"), "utf8");
      } catch {
        return undefined;
      }
    });
  }

  private abs(root: FileRoot, rel: string): string {
    return join(root.dir, ...rel.split("/"));
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("file sync is closed"));
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private changed(n: number): void {
    if (!n || !this.onChange) return;
    try {
      this.onChange(n);
    } catch {
      // A listener's failure is not the sync's.
    }
  }

  /** Log a line once (until 500 distinct ones were logged). */
  private note(key: string, line: string): void {
    if (this.noted.has(key)) return;
    if (this.noted.size > 500) this.noted.clear();
    this.noted.add(key);
    this.log(line);
  }
}

function statements(db: DatabaseSync) {
  const cols = "sha, size, mtime_ms as mtime, seq, stat, history";
  return {
    row: db.prepare(`select ${cols} from files where root = ? and path = ?`),
    rowsOf: db.prepare(`select path, ${cols} from files where root = ?`),
    put: db.prepare(`insert into files(root, path, sha, size, mtime_ms, seq, stat, history) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(root, path) do update set sha = excluded.sha, size = excluded.size, mtime_ms = excluded.mtime_ms,
      seq = excluded.seq, stat = excluded.stat, history = excluded.history`),
    setStat: db.prepare("update files set stat = ? where root = ? and path = ?"),
    setHistory: db.prepare("update files set history = ? where root = ? and path = ?"),
    nextSeq: db.prepare("update meta set value = value + 1 where key = 'seq' returning value"),
    changes: db.prepare(`select root, path, sha, size, mtime_ms as mtime, seq, history from files
      where seq > ? and root in (select value from json_each(?)) order by seq limit ?`),
    maxSeq: db.prepare("select coalesce(max(seq), 0) as n from files"),
    cursor: db.prepare("select cursor from cursors where peer = ?"),
    setCursor: db.prepare("insert into cursors(peer, cursor) values (?, ?) on conflict(peer) do update set cursor = excluded.cursor"),
    base: db.prepare("select sha from bases where peer = ? and root = ? and path = ?"),
    setBase: db.prepare(`insert into bases(peer, root, path, sha) values (?, ?, ?, ?)
      on conflict(peer, root, path) do update set sha = excluded.sha`),
    retries: db.prepare("select root, path, change from retries where peer = ?"),
    putRetry: db.prepare(`insert into retries(peer, root, path, change) values (?, ?, ?, ?)
      on conflict(peer, root, path) do update set change = excluded.change`),
    dropRetry: db.prepare("delete from retries where peer = ? and root = ? and path = ?"),
    forgetCursor: db.prepare("delete from cursors where peer = ?"),
    forgetBases: db.prepare("delete from bases where peer = ?"),
    forgetRetries: db.prepare("delete from retries where peer = ?"),
  };
}

/** What to do with a remote version `r`, given ours (`row`) and the last one agreed with that peer (`base`). */
function decide(r: FileChange, row: Row | undefined, base: string | null | undefined): { plan: Plan; conflict: boolean } {
  const L = row ? row.sha : undefined;
  if ((L ?? null) === r.sha) return { plan: "agree", conflict: false };
  // Theirs was made from ours / ours from theirs (content ids: a revert can make both true, then the newer wins).
  const fromOurs = L !== undefined && r.history !== undefined && r.history.includes(vid(L));
  const fromTheirs = row !== undefined && ((base !== undefined && r.sha === base) || row.history.includes(vid(r.sha)));
  if (fromOurs && fromTheirs) return { plan: newer(r, row!) ? "take" : "keep", conflict: false };
  if (fromOurs) return { plan: "take", conflict: false };
  if (fromTheirs) return { plan: "keep", conflict: false };
  // Only the peer changed it (also when this side never saw the path).
  if (L === undefined || L === base) return { plan: "take", conflict: false };
  // Both changed it.
  if (L === null) return { plan: "take", conflict: true }; // a remote change of a file deleted here restores it
  if (r.sha === null) return { plan: "keep", conflict: true }; // a remote delete never deletes a file changed here
  return { plan: newer(r, row!) ? "theirs-win" : "ours-win", conflict: true };
}

/** `dir/name (conflict <machine> YYYY-MM-DD HHmm).ext`, the time in UTC so both sides name the same copy alike. */
export function conflictName(rel: string, machine: string, mtimeMs: number, n = 1): string {
  const slash = rel.lastIndexOf("/");
  const dir = rel.slice(0, slash + 1);
  const name = rel.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const d = new Date(Number.isFinite(mtimeMs) ? mtimeMs : Date.now());
  const p = (x: number) => String(x).padStart(2, "0");
  const when = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  const who = machine.replace(/[/\\:*?"<>|\x00-\x1f]+/g, "-").trim() || "machine";
  return `${dir}${stem} (conflict ${who} ${when}${n > 1 ? ` ${n}` : ""})${ext}`;
}

/** The shape a change must have before anything looks at it. */
function wellFormed(r: FileChange): boolean {
  return (
    typeof r?.root === "string" && typeof r.path === "string" && (r.sha === null || (typeof r.sha === "string" && SHA_RE.test(r.sha))) &&
    Number.isFinite(r.size) && Number.isFinite(r.seq)
  );
}

/** A path a peer may name: posix, relative, no `.`/`..`/empty parts. */
export function validRel(p: unknown): p is string {
  if (typeof p !== "string" || !p || p.length > 4096 || p.includes("\0") || p.startsWith("/")) return false;
  if (process.platform === "win32" && /[\\:*?"<>|]/.test(p)) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

function newer(r: FileChange, row: Row): boolean {
  if (r.mtimeMs !== row.mtime) return r.mtimeMs > row.mtime;
  return (r.sha ?? "") > (row.sha ?? ""); // a tie decided the same way on both sides
}

const vid = (sha: string | null): string | null => (sha === null ? null : sha.slice(0, 16));

/** Earlier versions, newest first, without the current one, at most HISTORY. */
function mergeHistory(current: string | null, ...lists: (readonly (string | null)[] | undefined)[]): (string | null)[] {
  const cur = vid(current);
  const out: (string | null)[] = [];
  for (const list of lists) {
    for (const v of list ?? []) {
      const id = typeof v === "string" ? v.slice(0, 16) : null;
      if (id === cur || out.includes(id)) continue;
      out.push(id);
      if (out.length >= HISTORY) return out;
    }
  }
  return out;
}

function parseHistory(text: string): (string | null)[] {
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string | null => x === null || typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toRow(r: DbRow): Row {
  return { sha: r.sha, size: r.size, mtime: r.mtime, seq: r.seq, stat: r.stat, history: parseHistory(r.history) };
}

function isGone(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** A watch event inside build output, dependencies or the engine's own temp files wakes no scan. */
function quietEvent(name: string): boolean {
  const parts = name.split(/[\\/]/);
  const last = parts[parts.length - 1];
  return parts.slice(0, -1).some((p) => IGNORED_DIRS.has(p)) || IGNORED_DIRS.has(last) || ignoredName(last, false);
}

async function statKey(abs: string, st: Stats, sqlite: boolean): Promise<string> {
  const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
  if (!sqlite) return key;
  const wal = await lstat(`${abs}-wal`).catch(() => undefined);
  return wal ? `${key}:${wal.size}:${wal.mtimeMs}` : key;
}

async function sweepTemp(abs: string): Promise<void> {
  const st = await lstat(abs).catch(() => undefined);
  if (st && Date.now() - st.mtimeMs > STALE_TEMP_MS) await rm(abs, { force: true });
}

const mb = (n: number): string => (n / 1024 / 1024).toFixed(0);

function sha256(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

async function hashFile(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

// ---- SQLite ----

function isSqliteName(rel: string): boolean {
  return SQLITE_NAME.test(rel);
}

async function hasSqliteHeader(path: string): Promise<boolean> {
  let fh;
  try {
    fh = await open(path, "r");
    const b = Buffer.alloc(16);
    const { bytesRead } = await fh.read(b, 0, 16, 0);
    return bytesRead === 16 && b.equals(SQLITE_MAGIC);
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

function removeSqliteSide(abs: string): void {
  for (const s of SQLITE_SIDE) rmSync(abs + s, { force: true });
}

/** A consistent copy of a live database in a temp folder, handed to `fn`, then removed. */
async function withSqliteCopy<T>(src: string, fn: (copy: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "owlsync-"));
  try {
    const out = join(dir, "copy.db");
    vacuumInto(src, out);
    normalizeCopy(out);
    return await fn(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function vacuumInto(src: string, out: string): void {
  const side = (s: string) => existsSync(src + s);
  if (!side("-wal") && !side("-journal")) {
    // No connection writes it now: read it as immutable, which leaves no -wal/-shm behind; if it moved meanwhile,
    // copy again through SQLite's locks.
    const before = statSync(src);
    try {
      const url = pathToFileURL(src);
      url.searchParams.set("immutable", "1");
      vacuum(new DatabaseSync(url, { readOnly: true }), out);
      const after = statSync(src);
      if (after.size === before.size && after.mtimeMs === before.mtimeMs && !side("-wal") && !side("-journal")) return;
    } catch {
      // Through the locks below.
    }
    rmSync(out, { force: true });
  }
  // A short busy wait: this blocks the event loop, and a busy database is simply copied next time.
  vacuum(new DatabaseSync(src, { readOnly: true, timeout: 250 }), out);
}

function vacuum(db: DatabaseSync, out: string): void {
  try {
    db.prepare("VACUUM INTO ?").run(out);
  } finally {
    db.close();
  }
}

/**
 * VACUUM INTO bumps the schema cookie and stamps the library's version: fix both, so the copy of a copy (the side
 * that received it hashing it again) is byte for byte the same version.
 */
function normalizeCopy(path: string): void {
  const fd = openSync(path, "r+");
  try {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(1);
    writeSync(fd, b, 0, 4, 40);
    b.writeUInt32BE(3_000_000);
    writeSync(fd, b, 0, 4, 96);
  } finally {
    closeSync(fd);
  }
}
