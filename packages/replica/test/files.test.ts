// File replication (files.ts): rounds between in-process sides through a FilePeer that goes through JSON like a real
// transport. Both directions, no ping-pong, conflicts, deletes against edits, relays, ignores, live SQLite files,
// unicode paths, restarts, versions a peer cannot serve, and paths a peer must not be able to write.
import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { conflictName, FileSync, SCAN_PACE } from "../src/files.ts";
import type { FileChange, FilePeer } from "../src/files.ts";
import { Ignore, matchGitignore, parseGitignore } from "../src/ignore.ts";

const T = Date.UTC(2026, 9, 30, 12, 0, 0);
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

interface Side {
  name: string;
  dir: string;
  state: string;
  sync: FileSync;
  logs: string[];
}

function side(name: string, opts: { maxFileBytes?: number; base?: string } = {}): Side {
  const base = opts.base ?? mkdtempSync(join(tmpdir(), `owl-files-${name}-`));
  const dir = join(base, "workspaces");
  mkdirSync(dir, { recursive: true });
  const state = join(base, "state", "files.db");
  const logs: string[] = [];
  const sync = new FileSync({ roots: [{ name: "workspaces", dir }], stateFile: state, self: name, log: (m) => logs.push(m), maxFileBytes: opts.maxFileBytes });
  return { name, dir, state, sync, logs };
}

/** Like a transport: everything goes through JSON; counts the downloads. */
function peerOf(s: Side, o: { stripHistory?: boolean } = {}): FilePeer & { reads: number } {
  const peer = {
    reads: 0,
    async changesSince(cursor: number, limit: number) {
      const page = JSON.parse(JSON.stringify(s.sync.changesSince(cursor, limit))) as { changes: FileChange[]; cursor: number; more: boolean };
      if (o.stripHistory) for (const c of page.changes) delete c.history;
      return page;
    },
    async read(root: string, path: string, v: string) {
      peer.reads++;
      const b = await s.sync.read(root, path, v);
      return b && new Uint8Array(b);
    },
  };
  return peer;
}

function put(s: Side, rel: string, text: string | Uint8Array, mtimeMs?: number): void {
  const abs = join(s.dir, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  if (mtimeMs !== undefined) utimesSync(abs, new Date(mtimeMs), new Date(mtimeMs));
}

function get(s: Side, rel: string): string | undefined {
  const abs = join(s.dir, ...rel.split("/"));
  return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
}

function del(s: Side, rel: string): void {
  unlinkSync(join(s.dir, ...rel.split("/")));
}

/** Every file under the root, sorted (conflict copies and stray side files included). */
function files(s: Side): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(s.dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk("");
  return out.sort();
}

/** Both scan, then each pulls from the other. */
async function round(a: Side, b: Side) {
  const scanned = (await a.sync.scan()) + (await b.sync.scan());
  const toB = await b.sync.syncFrom(a.name, peerOf(a));
  const toA = await a.sync.syncFrom(b.name, peerOf(b));
  return { scanned, toA, toB, pulled: toA.pulled + toB.pulled, deleted: toA.deleted + toB.deleted, conflicts: toA.conflicts + toB.conflicts };
}

/** Rounds until nothing moves; returns the conflicts seen on the way. */
async function settle(a: Side, b: Side): Promise<number> {
  let conflicts = 0;
  for (let i = 0; i < 6; i++) {
    const r = await round(a, b);
    conflicts += r.conflicts;
    if (!r.scanned && !r.pulled && !r.deleted && !r.conflicts) return conflicts;
  }
  throw new Error("the sides never settled");
}

describe("ignore rules", () => {
  it("read the common .gitignore syntax", () => {
    const rules = parseGitignore(["# comment", "", "*.log", "!keep.log", "/top.txt", "secret/", "docs/**/*.pdf", "a?c", "[ab]x", "\\#hash", "out/**", "trail   "].join("\n"));
    const m = (p: string, dir = false) => matchGitignore(rules, p, dir);
    expect(m("x.log")).toBe(true);
    expect(m("deep/er/x.log")).toBe(true);
    expect(m("keep.log")).toBe(false);
    expect(m("top.txt")).toBe(true);
    expect(m("sub/top.txt")).toBeUndefined();
    expect(m("secret", true)).toBe(true);
    expect(m("secret")).toBeUndefined();
    expect(m("a/secret", true)).toBe(true);
    expect(m("docs/a.pdf")).toBe(true);
    expect(m("docs/x/y/a.pdf")).toBe(true);
    expect(m("other/a.pdf")).toBeUndefined();
    expect(m("abc")).toBe(true);
    expect(m("abbc")).toBeUndefined();
    expect(m("bx")).toBe(true);
    expect(m("cx")).toBeUndefined();
    expect(m("#hash")).toBe(true);
    expect(m("out/a/b")).toBe(true);
    expect(m("out", true)).toBeUndefined();
    expect(m("trail")).toBe(true);
  });

  it("apply .gitignore files of every folder above a path, the built-in names, and keep .git", () => {
    const texts: Record<string, string> = {
      "": "*.log\n!important.log\nsecret/\n/top.txt\nlogs/\n!logs/keep.txt\n",
      sub: "*.tmp\n!keep.tmp\n",
    };
    const ig = new Ignore((dir) => texts[dir]);
    expect(ig.ignored("a.log", false)).toBe(true);
    expect(ig.ignored("important.log", false)).toBe(false);
    expect(ig.ignored("sub/x.tmp", false)).toBe(true);
    expect(ig.ignored("sub/keep.tmp", false)).toBe(false);
    expect(ig.ignored("x.tmp", false)).toBe(false);
    expect(ig.ignored("top.txt", false)).toBe(true);
    expect(ig.ignored("sub/top.txt", false)).toBe(false);
    expect(ig.ignored("secret/a.txt", false)).toBe(true);
    expect(ig.ignored("deep/secret/a.txt", false)).toBe(true);
    // A file in an excluded folder cannot be re-included.
    expect(ig.ignored("logs/keep.txt", false)).toBe(true);
    for (const p of ["node_modules/x/index.js", "src/build/out.js", "a/.venv/bin/python", "x/__pycache__/m.pyc", ".DS_Store", "d/Thumbs.db", "app.db-wal", "app.db-shm", "app.sqlite-journal", ".owlsync-1a2b.tmp"]) {
      expect(ig.ignored(p, false), p).toBe(true);
    }
    for (const p of [".git/config", ".git/objects/ab/cdef", "build", "src/main.ts", ".gitignore"]) expect(ig.ignored(p, false), p).toBe(false);
  });
});

describe("file sync", () => {
  it("names conflict copies by machine and UTC time", () => {
    expect(conflictName("notes/plan.md", "vps", T)).toBe("notes/plan (conflict vps 2026-10-30 1200).md");
    expect(conflictName(".bashrc", "mac", T + 61_000, 2)).toBe(".bashrc (conflict mac 2026-10-30 1201 2)");
    expect(conflictName("Makefile", "a/b", T)).toBe("Makefile (conflict a-b 2026-10-30 1200)");
  });

  it("creates, changes and deletes files in both directions", async () => {
    const a = side("a");
    const b = side("b");
    put(a, "readme.md", "hello", T);
    put(a, "src/app/main.ts", "console.log(1)", T);
    let r = await round(a, b);
    expect(r.toB.pulled).toBe(2);
    expect(get(b, "readme.md")).toBe("hello");
    expect(get(b, "src/app/main.ts")).toBe("console.log(1)");
    expect(statSync(join(b.dir, "readme.md")).mtimeMs).toBe(T);

    put(b, "readme.md", "hello from b", T + 60_000);
    put(b, "notes.txt", "b's notes", T + 60_000);
    r = await round(a, b);
    expect(r.toA.pulled).toBe(2);
    expect(get(a, "readme.md")).toBe("hello from b");
    expect(get(a, "notes.txt")).toBe("b's notes");

    del(a, "src/app/main.ts");
    del(b, "notes.txt");
    r = await round(a, b);
    expect(r.deleted).toBe(2);
    expect(existsSync(join(b.dir, "src"))).toBe(false); // folders left empty go too
    expect(get(a, "notes.txt")).toBeUndefined();
    expect(files(a)).toEqual(["readme.md"]);
    expect(files(b)).toEqual(["readme.md"]);
    expect(r.conflicts).toBe(0);
  });

  it("does not ping-pong: a pulled change comes back as agreement, not as a change", async () => {
    const a = side("a");
    const b = side("b");
    put(a, "x.txt", "1", T);
    await a.sync.scan();
    expect((await b.sync.syncFrom("a", peerOf(a))).pulled).toBe(1);
    // b relays what it took; a sees its own version and downloads nothing.
    const back = peerOf(b);
    expect(await a.sync.syncFrom("b", back)).toEqual({ pulled: 0, deleted: 0, conflicts: 0 });
    expect(back.reads).toBe(0);
    for (let i = 0; i < 3; i++) {
      const r = await round(a, b);
      expect(r).toMatchObject({ scanned: 0, pulled: 0, deleted: 0, conflicts: 0 });
    }
  });

  it("keeps the newer of two concurrent edits in place and the other as a conflict copy, in any order", async () => {
    for (const order of ["b first", "a first", "together"] as const) {
      const a = side("a");
      const b = side("b");
      put(a, "plan.md", "v0", T);
      await settle(a, b);
      put(a, "plan.md", "a's edit", T + 60_000);
      put(b, "plan.md", "b's edit", T + 120_000);
      await a.sync.scan();
      await b.sync.scan();
      let conflicts = 0;
      const add = (r: { conflicts: number }) => (conflicts += r.conflicts);
      if (order === "b first") {
        add(await b.sync.syncFrom("a", peerOf(a)));
        add(await a.sync.syncFrom("b", peerOf(b)));
      } else if (order === "a first") {
        add(await a.sync.syncFrom("b", peerOf(b)));
        add(await b.sync.syncFrom("a", peerOf(a)));
      } else {
        (await Promise.all([a.sync.syncFrom("b", peerOf(b)), b.sync.syncFrom("a", peerOf(a))])).forEach(add);
      }
      conflicts += await settle(a, b);
      const copy = "plan (conflict a 2026-10-30 1201).md";
      for (const s of [a, b]) {
        expect(files(s), `${order}: ${s.name}`).toEqual([copy, "plan.md"]);
        expect(get(s, "plan.md")).toBe("b's edit");
        expect(get(s, copy)).toBe("a's edit");
      }
      expect(conflicts, order).toBe(order === "together" ? 2 : 1);
    }
  });

  it("keeps an edit made while the other side deleted the file", async () => {
    for (const order of ["b first", "a first"] as const) {
      const a = side("a");
      const b = side("b");
      put(a, "todo.txt", "v0", T);
      await settle(a, b);
      del(a, "todo.txt");
      put(b, "todo.txt", "edited", T + 60_000);
      await a.sync.scan();
      await b.sync.scan();
      if (order === "b first") {
        expect((await b.sync.syncFrom("a", peerOf(a))).conflicts).toBe(1);
        expect(get(b, "todo.txt")).toBe("edited");
      }
      await settle(a, b);
      for (const s of [a, b]) {
        expect(files(s), `${order}: ${s.name}`).toEqual(["todo.txt"]);
        expect(get(s, "todo.txt")).toBe("edited");
      }
    }
  });

  it("takes a change made from a pulled version without a conflict, before the copy came back", async () => {
    const a = side("a");
    const b = side("b");
    put(a, "task/report.md", "draft", T);
    await a.sync.scan();
    await b.sync.syncFrom("a", peerOf(a));
    // b edits at once: a never saw b holding the draft.
    put(b, "task/report.md", "final", T + 5_000);
    await b.sync.scan();
    expect(await a.sync.syncFrom("b", peerOf(b))).toEqual({ pulled: 1, deleted: 0, conflicts: 0 });
    expect(get(a, "task/report.md")).toBe("final");
    // The same for a deletion right after the edit.
    put(a, "task/scratch.txt", "tmp", T);
    await a.sync.scan();
    await b.sync.syncFrom("a", peerOf(a));
    del(b, "task/scratch.txt");
    await b.sync.scan();
    expect(await a.sync.syncFrom("b", peerOf(b))).toEqual({ pulled: 0, deleted: 1, conflicts: 0 });
    expect(await settle(a, b)).toBe(0);
    expect(files(a)).toEqual(["task/report.md"]);
    expect(files(b)).toEqual(["task/report.md"]);
  });

  it("without the history field (an older peer) a delete against an edit still converges on the edit", async () => {
    const a = side("a");
    const b = side("b");
    put(a, "f.txt", "v0", T);
    await settle(a, b);
    del(a, "f.txt");
    put(b, "f.txt", "edited", T + 60_000);
    for (let i = 0; i < 3; i++) {
      await a.sync.scan();
      await b.sync.scan();
      await b.sync.syncFrom("a", peerOf(a, { stripHistory: true }));
      await a.sync.syncFrom("b", peerOf(b, { stripHistory: true }));
    }
    expect(get(a, "f.txt")).toBe("edited");
    expect(get(b, "f.txt")).toBe("edited");
  });

  it("relays A → B → C: changes pass through a side that took them", async () => {
    const a = side("a");
    const b = side("b");
    const c = side("c");
    // b talks to both; a and c never talk to each other.
    const chain = async () => {
      let conflicts = 0;
      for (let i = 0; i < 2; i++) {
        for (const s of [a, b, c]) await s.sync.scan();
        conflicts += (await b.sync.syncFrom("a", peerOf(a))).conflicts;
        conflicts += (await b.sync.syncFrom("c", peerOf(c))).conflicts;
        conflicts += (await a.sync.syncFrom("b", peerOf(b))).conflicts;
        conflicts += (await c.sync.syncFrom("b", peerOf(b))).conflicts;
      }
      return conflicts;
    };
    put(a, "shared/doc.md", "from a", T);
    expect(await chain()).toBe(0);
    expect(get(c, "shared/doc.md")).toBe("from a");
    put(c, "shared/doc.md", "c changed it", T + 60_000);
    expect(await chain()).toBe(0);
    expect(get(a, "shared/doc.md")).toBe("c changed it");
    del(a, "shared/doc.md");
    expect(await chain()).toBe(0);
    for (const s of [a, b, c]) expect(files(s)).toEqual([]);
  });

  it("leaves out ignored files, refuses to serve them, and keeps .git", async () => {
    const a = side("a");
    const b = side("b");
    const kept = [".git/HEAD", ".git/config", ".gitignore", "a.tmp", "build", "important.log", "src/main.ts", "sub/.gitignore", "sub/keep.tmp", "sub/top-only.txt"];
    const left = [
      "node_modules/pkg/index.js", "src/build/out.js", "dist/app.js", "target/debug/bin", ".DS_Store", "src/Thumbs.db",
      "data.db-wal", "data.db-shm", "old.sqlite-journal", ".owlsync-1234.tmp", "app.log", "top-only.txt", "secret/key.txt",
      "sub/secret/key.txt", "sub/a.tmp", "logs/keep.txt",
    ];
    put(a, ".gitignore", "*.log\n!important.log\n/top-only.txt\nsecret/\nlogs/\n!logs/keep.txt\n");
    put(a, "sub/.gitignore", "*.tmp\n!keep.tmp\n");
    for (const p of [...kept, ...left]) if (!p.endsWith(".gitignore")) put(a, p, `content of ${p}`);
    await settle(a, b);
    expect(files(b)).toEqual([...kept].sort());
    expect(await a.sync.read("workspaces", "secret/key.txt", sha("content of secret/key.txt"))).toBeUndefined();
    expect(await a.sync.read("workspaces", "node_modules/pkg/index.js", sha("content of node_modules/pkg/index.js"))).toBeUndefined();
    expect(Buffer.from((await a.sync.read("workspaces", "src/main.ts", sha("content of src/main.ts")))!).toString()).toBe("content of src/main.ts");
    // A file that becomes ignored stops syncing but is not deleted on the other side.
    put(a, ".gitignore", "*.log\n!important.log\n/top-only.txt\nsecret/\nlogs/\n!logs/keep.txt\nsrc/\n", Date.now() + 1000);
    await settle(a, b);
    expect(get(b, "src/main.ts")).toBe("content of src/main.ts");
  });

  it("refuses paths that leave the root, go through a link, or land in ignored folders", async () => {
    const b = side("b");
    const outside = mkdtempSync(join(tmpdir(), "owl-files-outside-"));
    symlinkSync(outside, join(b.dir, "link"));
    const body = new TextEncoder().encode("pwned");
    const v = sha(body);
    const paths = ["../escape.txt", "/etc/passwd", "a/../../escape.txt", "link/pwned.txt", "node_modules/evil.js", "x/./y.txt", ""];
    const evil: FilePeer = {
      async changesSince(cursor) {
        if (cursor > 0) return { changes: [], cursor, more: false };
        return { changes: paths.map((path, i) => ({ root: "workspaces", path, sha: v, size: body.length, mtimeMs: T, seq: i + 1 })), cursor: paths.length, more: false };
      },
      async read() {
        return body;
      },
    };
    expect(await b.sync.syncFrom("evil", evil)).toEqual({ pulled: 0, deleted: 0, conflicts: 0 });
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(dirname(b.dir), "escape.txt"))).toBe(false);
    expect(files(b)).toEqual(["link"]);
  });

  it("sends a live SQLite database as a consistent copy that opens with its rows", async () => {
    const a = side("a");
    const b = side("b");
    const path = join(a.dir, "app", "data.db");
    mkdirSync(dirname(path), { recursive: true });
    const w = new DatabaseSync(path);
    w.exec("pragma journal_mode = wal; pragma wal_autocheckpoint = 0; create table t(id integer primary key, v text)");
    const insert = w.prepare("insert into t(v) values (?)");
    for (let i = 0; i < 50; i++) insert.run(`row ${i}`);
    expect(existsSync(`${path}-wal`)).toBe(true); // the rows are only in the WAL so far
    const count = () => {
      const db = new DatabaseSync(join(b.dir, "app", "data.db"), { readOnly: true });
      try {
        return (db.prepare("select count(*) as n from t").get() as { n: number }).n;
      } finally {
        db.close();
      }
    };
    await settle(a, b);
    expect(files(b)).toEqual(["app/data.db"]); // no -wal / -shm travel
    expect(count()).toBe(50);

    // More writes into the open connection: the WAL moves, the scan sees it.
    for (let i = 0; i < 25; i++) insert.run(`more ${i}`);
    expect(await a.sync.scan()).toBe(1);
    expect((await b.sync.syncFrom("a", peerOf(a))).pulled).toBe(1);
    expect(count()).toBe(75);

    // Closing checkpoints the WAL into the file: same rows, no new version.
    w.close();
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(await a.sync.scan()).toBe(0);
    // The received copy hashes the same when b looks at it again.
    utimesSync(join(b.dir, "app", "data.db"), new Date(), new Date(Date.now() + 5000));
    expect(await b.sync.scan()).toBe(0);
    expect(await settle(a, b)).toBe(0);
    expect(existsSync(`${path}-wal`)).toBe(false); // reading the closed database left no side files
    expect(existsSync(`${path}-shm`)).toBe(false);
  });

  it("syncs nested folders and unicode names", async () => {
    const a = side("a");
    const b = side("b");
    const names = ["папка/подпапка/файл ☃.txt", "日本語/ノート.md", "a/b/c/d/e/f.txt", "émoji 🦉/name with spaces & (parens).md"];
    for (const n of names) put(a, n, `text of ${n}`, T);
    await settle(a, b);
    expect(files(b)).toEqual([...names].sort());
    for (const n of names) expect(get(b, n)).toBe(`text of ${n}`);
    put(b, "日本語/ノート.md", "更新", T + 1000);
    del(b, "a/b/c/d/e/f.txt");
    await settle(a, b);
    expect(get(a, "日本語/ノート.md")).toBe("更新");
    expect(existsSync(join(a.dir, "a"))).toBe(false);
  });

  it("keeps its state across a restart: nothing is hashed as new or downloaded again", async () => {
    const a = side("a");
    const b = side("b");
    for (let i = 0; i < 5; i++) put(a, `docs/${i}.md`, `doc ${i}`, T);
    put(b, "b-only.txt", "b", T);
    await settle(a, b);
    await a.sync.close();
    await b.sync.close();
    const a2 = side("a", { base: dirname(a.dir) });
    const b2 = side("b", { base: dirname(b.dir) });
    expect(await a2.sync.scan()).toBe(0);
    expect(await b2.sync.scan()).toBe(0);
    const fromA = peerOf(a2);
    const fromB = peerOf(b2);
    expect(await b2.sync.syncFrom("a", fromA)).toEqual({ pulled: 0, deleted: 0, conflicts: 0 });
    expect(await a2.sync.syncFrom("b", fromB)).toEqual({ pulled: 0, deleted: 0, conflicts: 0 });
    expect(fromA.reads + fromB.reads).toBe(0);
    // And the journal goes on from where it was.
    put(a2, "docs/new.md", "new", T + 1000);
    expect(await a2.sync.scan()).toBe(1);
    expect((await b2.sync.syncFrom("a", peerOf(a2))).pulled).toBe(1);
    expect(get(b2, "docs/new.md")).toBe("new");
  });

  it("reads a wiped peer's journal again and agrees on what both have", async () => {
    const a = side("a");
    const b = side("b");
    for (let i = 0; i < 3; i++) put(a, `f${i}.txt`, `${i}`, T);
    await settle(a, b);
    await a.sync.close();
    rmSync(dirname(a.state), { recursive: true });
    const a2 = side("a", { base: dirname(a.dir) });
    put(a2, "after-wipe.txt", "new", T);
    expect(await a2.sync.scan()).toBe(4);
    const fromA = peerOf(a2);
    expect(await b.sync.syncFrom("a", fromA)).toEqual({ pulled: 1, deleted: 0, conflicts: 0 });
    expect(fromA.reads).toBe(1);
    expect(await a2.sync.syncFrom("b", peerOf(b))).toEqual({ pulled: 0, deleted: 0, conflicts: 0 });
    expect(await settle(a2, b)).toBe(0);
  });

  it("retries a version the peer cannot serve on the next round", async () => {
    const a = side("a");
    const b = side("b");
    put(a, "one.txt", "1", T);
    put(a, "two.txt", "2", T);
    await a.sync.scan();
    let fail = true;
    const real = peerOf(a);
    const flaky: FilePeer = {
      changesSince: (c, l) => real.changesSince(c, l),
      read: async (root, path, v) => (fail && path === "one.txt" ? undefined : real.read(root, path, v)),
    };
    expect((await b.sync.syncFrom("a", flaky)).pulled).toBe(1);
    expect(get(b, "one.txt")).toBeUndefined();
    fail = false;
    expect((await b.sync.syncFrom("a", flaky)).pulled).toBe(1);
    expect(get(b, "one.txt")).toBe("1");

    // The file moved on before the peer scanned: the old version is gone, the new one comes after the scan.
    put(a, "one.txt", "1 again", T + 1000);
    put(a, "two.txt", "2 again", T + 1000);
    await a.sync.scan();
    put(a, "two.txt", "2 once more", T + 2000);
    expect((await b.sync.syncFrom("a", peerOf(a))).pulled).toBe(1);
    expect(get(b, "two.txt")).toBe("2");
    await a.sync.scan();
    expect((await b.sync.syncFrom("a", peerOf(a))).pulled).toBe(1);
    expect(get(b, "two.txt")).toBe("2 once more");
    expect(get(b, "one.txt")).toBe("1 again");
  });

  it("does not let a version that stays unavailable hold up later changes, and keeps trying it after a restart", async () => {
    const a = side("a");
    const b = side("b");
    put(a, "stuck.txt", "stuck", T);
    await a.sync.scan();
    let serve = false;
    const real = peerOf(a);
    let stuckReads = 0;
    const peer: FilePeer = {
      changesSince: (c, l) => real.changesSince(c, l),
      read: async (root, path, v) => {
        if (path !== "stuck.txt") return real.read(root, path, v);
        stuckReads++;
        return serve ? real.read(root, path, v) : undefined;
      },
    };
    expect((await b.sync.syncFrom("a", peer)).pulled).toBe(0);
    for (let i = 0; i < 3; i++) {
      put(a, `later-${i}.txt`, `${i}`, T);
      await a.sync.scan();
      expect((await b.sync.syncFrom("a", peer)).pulled).toBe(1);
    }
    expect(get(b, "later-2.txt")).toBe("2");
    expect(stuckReads).toBe(4); // asked again every round
    await b.sync.close();
    const b2 = side("b", { base: dirname(b.dir) });
    serve = true;
    expect((await b2.sync.syncFrom("a", peer)).pulled).toBe(1);
    expect(get(b2, "stuck.txt")).toBe("stuck");
    expect((await b2.sync.syncFrom("a", peer)).pulled).toBe(0);
    expect(stuckReads).toBe(5);
  });

  it("scans on its own once started and says when the journal moved", async () => {
    const base = mkdtempSync(join(tmpdir(), "owl-files-started-"));
    const dir = join(base, "workspaces");
    mkdirSync(dir);
    const counts: number[] = [];
    const s = new FileSync({ roots: [{ name: "workspaces", dir }], stateFile: join(base, "state.db"), self: "a", onChange: (n) => counts.push(n) });
    s.start(50);
    writeFileSync(join(dir, "hello.txt"), "hi");
    const until = Date.now() + 5000;
    while (!s.changesSince(0).changes.length && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    const paths = s.changesSince(0).changes.map((c) => c.path);
    await s.close();
    expect(paths).toEqual(["hello.txt"]);
    expect(counts).toEqual([1]);
  });

  it("waits after a background scan many times as long as it took, however short the interval and busy the folder", async () => {
    const a = side("a");
    const proto = FileSync.prototype as unknown as { scanNow(periodic: boolean): Promise<number> };
    const real = proto.scanNow;
    const runs: { start: number; end: number }[] = [];
    // A scan that takes 40 ms, as one of a big tree does.
    const spy = vi.spyOn(proto, "scanNow").mockImplementation(async function (this: unknown, periodic: boolean) {
      const run = { start: Date.now(), end: 0 };
      runs.push(run);
      await new Promise((r) => setTimeout(r, 40));
      try {
        return await real.call(this, periodic);
      } finally {
        run.end = Date.now();
      }
    });
    try {
      a.sync.start(1);
      // File events all along (where the OS reports them) do not hurry it either.
      for (let i = 0; i < 20; i++) {
        put(a, `busy-${i}.txt`, String(i));
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      await a.sync.close();
      spy.mockRestore();
    }
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < runs.length; i++) expect(runs[i].start - runs[i - 1].end).toBeGreaterThanOrEqual(SCAN_PACE * 40 * 0.9);
  });

  it("looks at single paths without a walk: a new file, a changed one, a deleted one, and leaves out ignored ones", async () => {
    const a = side("a");
    put(a, "keep.txt", "one");
    put(a, "gone.txt", "bye");
    await a.sync.scan();
    const cursor = a.sync.changesSince(0).cursor;
    put(a, "keep.txt", "two");
    put(a, "new/inside.txt", "new");
    put(a, "node_modules/x.js", "x");
    put(a, "unasked.txt", "not looked at");
    unlinkSync(join(a.dir, "gone.txt"));
    expect(await a.sync.look("workspaces", ["keep.txt", "new/inside.txt", "node_modules/x.js", "gone.txt", "../out.txt", "new"])).toBe(3);
    const changes = a.sync.changesSince(cursor).changes.map((c) => [c.path, c.sha === null ? "deleted" : "here"]);
    expect(changes.sort()).toEqual([["gone.txt", "deleted"], ["keep.txt", "here"], ["new/inside.txt", "here"]]);
    // The full scan finds the rest.
    expect(await a.sync.scan()).toBe(1);
    await a.sync.close();
  });

  it.skipIf(process.platform !== "darwin" && process.platform !== "win32")("takes a file event's path in soon, with no full scan of the tree", async () => {
    const a = side("a");
    const proto = FileSync.prototype as unknown as { scanNow(periodic: boolean): Promise<number> };
    const spy = vi.spyOn(proto, "scanNow");
    try {
      a.sync.start(60_000);
      const first = Date.now() + 5000;
      while (spy.mock.calls.length < 1 && Date.now() < first) await new Promise((r) => setTimeout(r, 20));
      // Watching starts a moment after the call.
      await new Promise((r) => setTimeout(r, 300));
      put(a, "deep/er/news.txt", "news");
      const until = Date.now() + 5000;
      while (!a.sync.changesSince(0).changes.length && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      expect(a.sync.changesSince(0).changes.map((c) => c.path)).toEqual(["deep/er/news.txt"]);
      expect(spy.mock.calls.length).toBe(1);
    } finally {
      await a.sync.close();
      spy.mockRestore();
    }
  });

  it("started on demand, scans only while peers read the journal", async () => {
    const a = side("a");
    a.sync.start(20, { whileAskedMs: 300 });
    put(a, "hello.txt", "hi");
    await new Promise((r) => setTimeout(r, 200));
    expect(a.sync.scanning).toBe(false);
    // The first read wakes it; the scan's result is in a later one.
    expect(a.sync.changesSince(0).changes).toEqual([]);
    expect(a.sync.scanning).toBe(true);
    const until = Date.now() + 5000;
    while (!a.sync.changesSince(0).changes.length && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    expect(a.sync.changesSince(0).changes.map((c) => c.path)).toEqual(["hello.txt"]);
    // Nobody reads it any more: it rests, and sees nothing new until asked again.
    const quiet = Date.now() + 5000;
    while (a.sync.scanning && Date.now() < quiet) await new Promise((r) => setTimeout(r, 20));
    expect(a.sync.scanning).toBe(false);
    put(a, "later.txt", "later");
    await new Promise((r) => setTimeout(r, 200));
    const cursor = a.sync.changesSince(0).cursor;
    const again = Date.now() + 5000;
    while (!a.sync.changesSince(cursor).changes.length && Date.now() < again) await new Promise((r) => setTimeout(r, 20));
    expect(a.sync.changesSince(cursor).changes.map((c) => c.path)).toEqual(["later.txt"]);
    await a.sync.close();
    expect(a.sync.scanning).toBe(false);
  });

  it("skips files over the size limit and symbolic links", async () => {
    const a = side("a", { maxFileBytes: 1000 });
    const b = side("b");
    put(a, "big.bin", new Uint8Array(2000));
    put(a, "small.txt", "small");
    symlinkSync(join(a.dir, "small.txt"), join(a.dir, "link.txt"));
    mkdirSync(join(a.dir, "real"));
    put(a, "real/inside.txt", "inside");
    symlinkSync(join(a.dir, "real"), join(a.dir, "linked-dir"));
    await settle(a, b);
    expect(files(b)).toEqual(["real/inside.txt", "small.txt"]);
    expect(a.logs.some((l) => l.includes("big.bin"))).toBe(true);
  });
});
