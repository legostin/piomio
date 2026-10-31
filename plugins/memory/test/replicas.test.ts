// Memory on two hubs: the data folder travels by the hubs' real file sync (packages/replica), the working state
// through the plugin storage (one map here: the hubs' databases replicate plugin_kv row by row).
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FileSync, type FileChange, type FilePeer } from "@piomio/replica";
import { startPlugin, type PluginHarness } from "@piomio/testkit";

const DIR = join(import.meta.dirname, "..");
const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

const running: PluginHarness[] = [];
afterEach(async () => {
  for (const h of running.splice(0)) await h.stop();
});

async function start(dataDir: string, storage: Map<string, unknown>, settings: Record<string, unknown> = {}): Promise<PluginHarness> {
  const h = await startPlugin({ dir: DIR, dataDir, storage, settings });
  running.push(h);
  return h;
}

async function stop(h: PluginHarness): Promise<void> {
  running.splice(running.indexOf(h), 1);
  await h.stop();
}

const pathOf = (said: string) => /\[([^\]]+)\]/.exec(said.split("\n")[0])?.[1] ?? "";
const read = (dataDir: string, rel: string) => readFileSync(join(dataDir, ...rel.split("/")), "utf8");
const has = (dataDir: string, rel: string) => existsSync(join(dataDir, ...rel.split("/")));
const gitLog = (dataDir: string) =>
  execFileSync("git", ["-c", "safe.directory=*", "log", "--all", "--format=%s"], { cwd: join(dataDir, "memory"), encoding: "utf8" }).trim().split("\n");

/** Every file under a folder, sorted. */
function files(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...files(dir, r));
    else out.push(r);
  }
  return out.sort();
}

async function until(what: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await what())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

interface Hub {
  name: string;
  dataDir: string;
  sync: FileSync;
}

/** A hub's data dir with the cluster's file sync over plugins-data/memory (core cluster.ts FILE_ROOTS). */
function hub(name: string): Hub {
  const base = mkdtempSync(join(tmpdir(), `owl-memory-${name}-`));
  const dataDir = join(base, "plugins-data", "memory");
  mkdirSync(dataDir, { recursive: true });
  const sync = new FileSync({ roots: [{ name: "plugins-data/memory", dir: dataDir }], stateFile: join(base, "replica", "files.db"), self: name });
  return { name, dataDir, sync };
}

function peerOf(h: Hub): FilePeer {
  return {
    changesSince: async (cursor, limit) => JSON.parse(JSON.stringify(h.sync.changesSince(cursor, limit))) as { changes: FileChange[]; cursor: number; more: boolean },
    read: async (root, path, sha) => {
      const b = await h.sync.read(root, path, sha);
      return b && new Uint8Array(b);
    },
  };
}

/** Rounds of the file sync until nothing moves. */
async function settle(a: Hub, b: Hub): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const scanned = (await a.sync.scan()) + (await b.sync.scan());
    const r1 = await b.sync.syncFrom(a.name, peerOf(a));
    const r2 = await a.sync.syncFrom(b.name, peerOf(b));
    if (!scanned && ![r1, r2].some((r) => r.pulled || r.deleted || r.conflicts)) return;
  }
  throw new Error("the hubs never settled");
}

describe("memory on hub replicas", () => {
  it.skipIf(!hasGit)("shares the facts between hubs, and each builds its index, MEMORY.md and history itself", async () => {
    const mac = hub("mac");
    const vps = hub("vps");
    const kv = new Map<string, unknown>();
    let h = await start(mac.dataDir, kv);
    const anna = pathOf(await h.invokeText("remember", { fact: "The user's sister Anna lives in Perm.", about: ["Anna"], kind: "person" }));
    await h.hook("turn.context", { sessionId: "s1", agentId: "assistant", conversationId: "c1", background: false, fromUser: true, text: "Where does my sister Anna live now?" });
    // The Mac sleeps: the VPS takes the lead.
    await stop(h);
    await settle(mac, vps);
    expect(files(vps.dataDir)).toEqual([".gitignore", "memory/.gitignore", `memory/${anna}`].sort());

    const v = await start(vps.dataDir, kv);
    expect(await v.invokeText("search", { query: "Perm" })).toContain(anna);
    expect(read(vps.dataDir, "memory/MEMORY.md")).toContain(anna);
    expect(gitLog(vps.dataDir)).toEqual(["memory: sync"]);
    // What the Mac's plugin wrote to the shared state is there: Anna was recalled once.
    expect(kv.get(`usage:${anna}`)).toMatchObject({ recalled: 1 });
    const perm = pathOf(await v.invokeText("remember", { fact: "The user plays chess on Thursdays.", kind: "self" }));
    await stop(v);
    await settle(mac, vps);

    // The Mac leads again: it takes in what the VPS saved and commits it in its own history.
    h = await start(mac.dataDir, kv);
    expect(await h.invokeText("search", { query: "chess" })).toContain(perm);
    expect(gitLog(mac.dataDir)[0]).toBe("memory: sync");
    expect(gitLog(mac.dataDir)).toContain(`memory: remember ${anna}`);
  });

  it.skipIf(!hasGit)("merges what both hubs changed while both led", async () => {
    const mac = hub("mac");
    const vps = hub("vps");
    const kv = new Map<string, unknown>();
    const h0 = await start(mac.dataDir, kv);
    const anna = pathOf(await h0.invokeText("remember", { fact: "The user's sister Anna lives in Perm.", about: ["Anna"], kind: "person" }));
    await stop(h0);
    await settle(mac, vps);

    // A split: both lead and both work on the same fact.
    const m = await start(mac.dataDir, kv);
    const v = await start(vps.dataDir, kv);
    await m.invokeText("remember", { fact: "The user's sister Anna lives in Perm." }, { agentId: "assistant", conversationId: "c_mac" });
    await new Promise((r) => setTimeout(r, 30));
    await v.invokeText("remember", { fact: "The user's sister Anna lives in Perm." }, { agentId: "coder", conversationId: "c_vps" });
    const tea = pathOf(await m.invokeText("remember", { fact: "The user drinks green tea in the morning.", kind: "preference" }));
    const run = pathOf(await v.invokeText("remember", { fact: "The user runs five kilometres on Saturdays.", kind: "self" }));
    await settle(mac, vps);

    // Each running plugin takes in the other's facts, and the conflict copy the sync made is folded back.
    for (const [x, d] of [
      [m, mac.dataDir],
      [v, vps.dataDir],
    ] as const) {
      await until(async () => (await x.invokeText("search", { query: "tea" })).includes(tea) && (await x.invokeText("search", { query: "kilometres" })).includes(run));
      await until(() => !files(d).some((f) => f.includes("(conflict")));
      expect(read(d, `memory/${anna}`)).toContain("c_mac");
      expect(read(d, `memory/${anna}`)).toContain("c_vps");
      expect(read(d, "memory/MEMORY.md")).toContain(run);
    }
    await settle(mac, vps);
    expect(files(mac.dataDir).filter((f) => !f.startsWith("memory/.git/") && f !== "index.db")).toEqual(files(vps.dataDir).filter((f) => !f.startsWith("memory/.git/") && f !== "index.db"));
    expect(files(mac.dataDir).some((f) => f.includes("(conflict"))).toBe(false);
  });

  it("takes in the state.db of earlier versions and the copies the file sync made of it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "owl-memory-legacy-"));
    const legacy = (name: string, usage: Array<[string, number, string]>, journal: Array<[string, string]>, meta: Array<[string, string]>) => {
      const db = new DatabaseSync(join(dataDir, name));
      db.exec(`
        create table usage (path text primary key, recalled integer not null default 0, last_recalled text not null default '');
        create table journal (id integer primary key autoincrement, at text not null, agent text not null, conversation text not null, text text not null);
        create table meta (key text primary key, value text not null);
      `);
      for (const u of usage) db.prepare("insert into usage values (?, ?, ?)").run(...u);
      for (const [at, text] of journal) db.prepare("insert into journal(at, agent, conversation, text) values (?, 'assistant', 'c1', ?)").run(at, text);
      for (const m of meta) db.prepare("insert into meta values (?, ?)").run(...m);
      db.close();
    };
    legacy("state.db", [["people/anna.md", 3, "2026-10-30T10:00:00.000Z"]], [["2026-10-30T09:00:00.000Z", "Купил домен piomio.io"], ["2026-10-31T09:00:00.000Z", "Сестра переехала в Пермь"]], [["lastTidy", "2026-10-30T03:00:00.000Z"]]);
    legacy(
      "state (conflict vps 2026-10-31 0300).db",
      [
        ["people/anna.md", 5, "2026-10-29T10:00:00.000Z"],
        ["you/coffee.md", 1, "2026-10-31T08:00:00.000Z"],
      ],
      [["2026-10-31T09:00:00.000Z", "Сестра переехала в Пермь"], ["2026-10-31T11:00:00.000Z", "Завтра лечу в Алматы"], ["2026-10-20T09:00:00.000Z", "Reflected on long ago"]],
      [["lastTidy", "2026-10-31T03:00:00.000Z"], ["lastReflect", "2026-10-25T03:00:00.000Z"]],
    );
    writeFileSync(join(dataDir, "index (conflict mac 2026-10-30 0952).db"), "old index");
    const kv = new Map<string, unknown>();
    await start(dataDir, kv);

    expect(kv.get("usage:people/anna.md")).toEqual({ recalled: 5, lastRecalled: "2026-10-30T10:00:00.000Z" });
    expect(kv.get("usage:you/coffee.md")).toEqual({ recalled: 1, lastRecalled: "2026-10-31T08:00:00.000Z" });
    expect(kv.get("meta:lastTidy")).toBe("2026-10-31T03:00:00.000Z");
    const journal = [...kv.entries()].filter(([k]) => k.startsWith("journal:")).sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => (v as any).text);
    expect(journal).toEqual(["Купил домен piomio.io", "Сестра переехала в Пермь", "Завтра лечу в Алматы"]);
    expect(readdirSync(dataDir).filter((n) => n.endsWith(".db")).sort()).toEqual(["index.db"]);
  });

  it.skipIf(!hasGit)("folds conflict copies left from before and clears the ones in the git folder", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "owl-memory-copies-"));
    const kv = new Map<string, unknown>();
    let h = await start(dataDir, kv);
    const anna = pathOf(await h.invokeText("remember", { fact: "The user's sister Anna lives in Perm.", about: ["Anna"], kind: "person" }, { conversationId: "c_mac" }));
    const tea = pathOf(await h.invokeText("remember", { fact: "The user drinks green tea in the morning.", kind: "preference" }));
    await stop(h);
    const copyOf = (rel: string, who: string) => rel.replace(/\.md$/, ` (conflict ${who} 2026-10-31 0300).md`);
    // The other hub's older version of Anna, with its own source; a copy of a fact forgotten here since; a MEMORY.md copy.
    writeFileSync(join(dataDir, "memory", copyOf(anna, "vps")), read(dataDir, `memory/${anna}`).replace("c_mac", "c_vps"));
    renameSync(join(dataDir, "memory", tea), join(dataDir, "memory", copyOf(tea, "mac")));
    writeFileSync(join(dataDir, "memory", copyOf("MEMORY.md", "mac")), "# Memory\n");
    writeFileSync(join(dataDir, "memory", ".git", "COMMIT_EDITMSG (conflict mac 2026-10-30 0852)"), "memory: sync\n");

    h = await start(dataDir, kv);
    expect(files(join(dataDir, "memory")).filter((f) => f.includes("(conflict"))).toEqual([]);
    expect(read(dataDir, `memory/${anna}`)).toContain("c_mac");
    expect(read(dataDir, `memory/${anna}`)).toContain("c_vps");
    expect(has(dataDir, `memory/${tea}`)).toBe(true);
    expect(((await h.http({ method: "GET", path: "/facts" })).body as any).facts.map((f: any) => f.path).sort()).toEqual([anna, tea].sort());
    // The copy's text went into the history before it was folded.
    expect(execFileSync("git", ["-c", "safe.directory=*", "log", "--all", "--format=%s", "--", copyOf(anna, "vps")], { cwd: join(dataDir, "memory"), encoding: "utf8" })).toContain("memory: sync");
    expect(execFileSync("git", ["-c", "safe.directory=*", "status", "--porcelain"], { cwd: join(dataDir, "memory"), encoding: "utf8" }).trim()).toBe("");
  });

  it("saves a fact when the search index's file was replaced underneath", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "owl-memory-moved-"));
    const h = await start(dataDir, new Map(), { git: false });
    await h.invokeText("remember", { fact: "The user's sister Anna lives in Perm.", about: ["Anna"], kind: "person" });
    // What an older hub's file sync did: a copy renamed over the open database, which SQLite then refuses to write.
    const tmp = join(dataDir, ".owlsync-copy.tmp");
    copyFileSync(join(dataDir, "index.db"), tmp);
    renameSync(tmp, join(dataDir, "index.db"));
    const r = await h.invoke("remember", { fact: "The user's site legost.in runs on its own server.", kind: "project", about: ["legost.in"] });
    expect(r.isError).toBeUndefined();
    expect(await h.invokeText("search", { query: "legost" })).toContain("legost");
    expect(await h.invokeText("search", { query: "Perm" })).toContain("Anna");
    expect(h.logs.join("\n")).toContain("building it again");
    expect(readdirSync(join(dataDir, "memory", "projects"))).toHaveLength(1);
  });

  it("keeps what each hub builds out of the file sync", async () => {
    const a = hub("mac");
    const b = hub("vps");
    const h = await start(a.dataDir, new Map(), { git: false });
    await h.invokeText("remember", { fact: "The user's sister Anna lives in Perm.", about: ["Anna"], kind: "person" });
    for (const rel of ["state.db", "memory/.git/HEAD"]) {
      mkdirSync(dirname(join(a.dataDir, rel)), { recursive: true });
      writeFileSync(join(a.dataDir, rel), "ref: refs/heads/main\n");
    }
    await settle(a, b);
    expect(files(b.dataDir).filter((f) => !f.startsWith("memory/people/"))).toEqual([".gitignore", "memory/.gitignore"]);
  });
});
