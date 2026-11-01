// The server install's updates (self-update.ts): the files of an install root, the release check, the hub's own
// update (download, check, snapshot, switch) and the machines it updates.
import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventBus } from "../src/bus.ts";
import { HubUpdates, archiveName, clearRolledBack, confirmStarted, currentVersion, installLayout, latestOffer, settleBeforeStart, switchTo, UpdateError, type HubUpdatesDeps } from "../src/self-update.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "owl-selfupdate-"));

/** An install root with these versions unpacked and `current` on the first. */
function root(...versions: string[]): string {
  const r = tmp();
  for (const v of versions) {
    mkdirSync(join(r, "versions", v, "packaging", "linux"), { recursive: true });
    writeFileSync(join(r, "versions", v, "packaging", "linux", "piomio"), `#!/bin/sh\n# launcher of ${v}\n`);
  }
  if (versions[0]) switchTo(r, versions[0]);
  return r;
}

function db(file: string): DatabaseSync {
  const d = new DatabaseSync(file);
  d.exec("create table if not exists meta(key text primary key, value text)");
  return d;
}

const release = (tag: string, names: string[]) => ({
  tag_name: tag,
  assets: names.map((name) => ({ name, browser_download_url: `https://example.test/${name}` })),
});

const jsonFetch = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("install root", () => {
  it("switches current in one rename and reads it back", () => {
    const r = root("0.2.4", "0.2.5");
    expect(currentVersion(r)).toBe("0.2.4");
    switchTo(r, "0.2.5");
    expect(readlinkSync(installLayout(r).current)).toBe(join("versions", "0.2.5"));
    expect(currentVersion(r)).toBe("0.2.5");
  });

  it("after a rollback puts the database back as it was before the update", () => {
    const r = root("0.2.4");
    const data = tmp();
    const l = installLayout(r);
    const before = db(join(data, "piomio.db"));
    before.exec("insert into meta values ('k', 'before')");
    before.exec(`vacuum into '${l.snapshot}'`);
    before.exec("update meta set value = 'after' where key = 'k'");
    before.close();
    writeFileSync(join(data, "piomio.db-wal"), "stale");
    writeFileSync(l.rolledBack, "0.2.4 0.2.5\n");

    expect(settleBeforeStart(r, data, "0.2.4")).toEqual({ rolledBack: { from: "0.2.4", to: "0.2.5" } });
    expect(existsSync(join(data, "piomio.db-wal"))).toBe(false);
    expect(existsSync(l.snapshot)).toBe(false);
    const after = db(join(data, "piomio.db"));
    expect((after.prepare("select value from meta where key = 'k'").get() as { value: string }).value).toBe("before");
    after.close();
    // A second start does not restore again; the note stays until it was told.
    expect(settleBeforeStart(r, data, "0.2.4").rolledBack).toBeTruthy();
    clearRolledBack(r);
    expect(settleBeforeStart(r, data, "0.2.4")).toEqual({});
  });

  it("a confirmed start keeps the update: no trial, no snapshot, two versions, its own launcher", () => {
    const r = root("0.2.5", "0.2.3", "0.2.4");
    const l = installLayout(r);
    writeFileSync(l.trial, "0.2.4 0.2.5 1\n");
    writeFileSync(l.snapshot, "db");
    writeFileSync(l.launcher, "old launcher");
    expect(settleBeforeStart(r, tmp(), "0.2.5").trial).toEqual({ from: "0.2.4", to: "0.2.5" });
    expect(confirmStarted(r, "0.2.5")).toEqual({ from: "0.2.4", to: "0.2.5" });
    expect(existsSync(l.trial) || existsSync(l.snapshot)).toBe(false);
    expect(existsSync(join(l.versions, "0.2.3"))).toBe(false);
    expect(existsSync(join(l.versions, "0.2.4"))).toBe(true);
    expect(readFileSync(l.launcher, "utf8")).toContain("launcher of 0.2.5");
    expect(statSync(l.launcher).mode & 0o111).not.toBe(0);
    // Not this version's trial, or none: nothing to confirm.
    expect(confirmStarted(r, "0.2.5")).toBeUndefined();
  });
});

describe("the release on offer", () => {
  it("is a newer release with an archive and a signature for this architecture", async () => {
    const names = [archiveName("0.3.0", "x64"), `${archiveName("0.3.0", "x64")}.sig`];
    expect(await latestOffer("o/r", "0.2.4", "x64", jsonFetch(release("v0.3.0", names)))).toEqual({
      version: "0.3.0",
      archive: `https://example.test/${names[0]}`,
      signature: `https://example.test/${names[1]}`,
    });
    expect(await latestOffer("o/r", "0.3.0", "x64", jsonFetch(release("v0.3.0", names)))).toBeUndefined();
    expect(await latestOffer("o/r", "0.2.4", "arm64", jsonFetch(release("v0.3.0", names)))).toBeUndefined();
    expect(await latestOffer("o/r", "0.2.4", "x64", jsonFetch(release("v0.3.0", [names[0]])))).toBeUndefined();
    await expect(latestOffer("o/r", "0.2.4", "x64", jsonFetch({}, 403))).rejects.toThrow("403");
  });
});

/** A release archive with a tree that says it is `version`, served by a fake fetch. */
function served(version: string) {
  const dir = tmp();
  mkdirSync(join(dir, `piomio-${version}`, "packaging", "linux"), { recursive: true });
  writeFileSync(join(dir, `piomio-${version}`, "packaging", "linux", "piomio"), "#!/bin/sh\n");
  const archive = join(dir, "a.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", dir, `piomio-${version}`]);
  const fetchImpl = (async (url: string) => new Response(url.endsWith(".sig") ? "signature" : readFileSync(archive))) as unknown as typeof fetch;
  return { fetchImpl, offer: { version, archive: `https://example.test/${archiveName(version, "x64")}`, signature: "https://example.test/x.sig" } };
}

function updates(r: string, over: Partial<HubUpdatesDeps> = {}) {
  const data = tmp();
  const d = db(join(data, "piomio.db"));
  const told: string[] = [];
  const restart = vi.fn();
  const u = new HubUpdates({
    config: { installRoot: r, version: "0.2.4", releasesRepo: "o/r", dataDir: data, appRoot: tmp() },
    db: d,
    bus: new EventBus(),
    tell: (n) => told.push(n),
    restart,
    machine: () => undefined,
    sendNode: async () => {},
    // tar for real; the new tree's `piomio version` answers what the test says.
    run: async (file, args) => (file === "tar" ? execFileSync(file, args).toString() : "0.3.0\n"),
    verify: async () => true,
    arch: "x64",
    platform: "linux",
    ...over,
  });
  return { u, told, restart, d };
}

describe("the hub's own update", () => {
  it("unpacks, checks, snapshots, switches and restarts", async () => {
    const r = root("0.2.4");
    const { fetchImpl, offer } = served("0.3.0");
    const { u, restart } = updates(r, { fetch: fetchImpl });
    await u.install(offer);
    const l = installLayout(r);
    expect(currentVersion(r)).toBe("0.3.0");
    expect(existsSync(join(l.versions, "0.3.0", "packaging", "linux", "piomio"))).toBe(true);
    expect(readFileSync(l.trial, "utf8").trim()).toBe("0.2.4 0.3.0 0");
    expect(existsSync(l.snapshot)).toBe(true);
    expect(restart).toHaveBeenCalledOnce();
    // Nothing of the download is left next to the versions.
    expect(execFileSync("ls", ["-A", l.versions]).toString().trim().split("\n").sort()).toEqual(["0.2.4", "0.3.0"]);
  });

  it("leaves everything as it was when the signature or the new version is wrong, and says so", async () => {
    for (const over of [{ verify: async () => false }, { run: async (file: string, args: string[]) => (file === "tar" ? execFileSync(file, args).toString() : "0.2.9\n") }]) {
      const r = root("0.2.4");
      const { fetchImpl, offer } = served("0.3.0");
      const { u, restart, told } = updates(r, { fetch: fetchImpl, ...over });
      await expect(u.install(offer)).rejects.toThrow();
      expect(currentVersion(r)).toBe("0.2.4");
      expect(existsSync(installLayout(r).trial) || existsSync(join(installLayout(r).versions, "0.3.0"))).toBe(false);
      expect(restart).not.toHaveBeenCalled();
      expect(told[0]).toContain("stays on 0.2.4");
    }
  });

  it("offers a newer release once per version", async () => {
    const names = [archiveName("0.3.0", "x64"), `${archiveName("0.3.0", "x64")}.sig`];
    const { u, told } = updates(root("0.2.4"), { fetch: jsonFetch(release("v0.3.0", names)) });
    await u.check();
    await u.check();
    expect(told).toHaveLength(1);
    expect(u.offerFor("local")).toEqual({ update: "0.3.0" });
  });

  it("does not offer again a version the launcher had to go back from, and drops its tree", async () => {
    const r = root("0.2.4", "0.3.0");
    const names = [archiveName("0.3.0", "x64"), `${archiveName("0.3.0", "x64")}.sig`];
    const { u } = updates(r, { fetch: jsonFetch(release("v0.3.0", names)) });
    u.rolledBack("0.3.0");
    expect(existsSync(join(installLayout(r).versions, "0.3.0"))).toBe(false);
    expect(await u.check()).toBeUndefined();
    expect(u.offerFor("local")).toEqual({});
    const newer = [archiveName("0.3.1", "x64"), `${archiveName("0.3.1", "x64")}.sig`];
    (u as any).d.fetch = jsonFetch(release("v0.3.1", newer));
    expect((await u.check())?.version).toBe("0.3.1");
  });
});

describe("machines", () => {
  const info = (version: string | undefined, selfUpdate: boolean) => ({ os: "linux", hostname: "vps", arch: "x64", clis: [], allowedDirs: [], nodeVersion: "v24", ...(version ? { version } : {}), selfUpdate });

  it("offers an update to a node older than the hub that can replace itself", () => {
    const { u } = updates(root("0.2.4"));
    expect(u.offerFor("m1", info("0.2.3", true))).toEqual({ update: "0.2.4" });
    expect(u.offerFor("m1", info("0.2.4", true))).toEqual({});
    expect(u.offerFor("m1", info("0.2.3", false))).toEqual({});
    expect(u.offerFor("m1", info(undefined, false))).toEqual({});
  });

  it("sends the hub's bundle and shows it updating until the machine comes back new", async () => {
    const sent: Array<{ version: string; sha256: string; bundle: string }> = [];
    let m = { online: true, info: info("0.2.3", true) };
    const { u } = updates(root("0.2.4"), { machine: () => m, sendNode: async (_id, x) => void sent.push(x) });
    await expect(u.update("m1")).rejects.toThrow(UpdateError); // no bundle built in this app root
    const appRoot = (u as any).d.config.appRoot;
    mkdirSync(join(appRoot, "packages", "node", "dist"), { recursive: true });
    writeFileSync(join(appRoot, "packages", "node", "dist", "piomio-node.mjs"), "console.log('0.2.4')\n");
    expect(await u.update("m1")).toEqual({ version: "0.2.4" });
    expect(Buffer.from(sent[0].bundle, "base64").toString()).toContain("0.2.4");
    expect(u.offerFor("m1", m.info)).toEqual({ update: "0.2.4", updating: true });
    m = { online: true, info: info("0.2.4", true) };
    u.machineChanged("m1", m.info);
    expect(u.offerFor("m1", m.info)).toEqual({});
    m = { online: false, info: info("0.2.3", true) };
    await expect(u.update("m1")).rejects.toMatchObject({ reason: "offline" });
    u.stop();
  });
});
