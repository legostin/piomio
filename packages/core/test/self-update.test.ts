// The server install's updates (self-update.ts): the files of an install root, the release check, the hub's own
// update (download, check, snapshot, switch) and the machines it updates; the desktop app's update on the same button.
import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventBus } from "../src/bus.ts";
import {
  HubUpdates,
  archiveName,
  clearRolledBack,
  confirmStarted,
  currentVersion,
  desktopOffer,
  desktopPlatform,
  installLayout,
  latestOffer,
  launchApp,
  releaseOffer,
  replicaVersionNote,
  settleBeforeStart,
  switchTo,
  UpdateError,
  type HubUpdatesDeps,
  type ReplicaPeer,
} from "../src/self-update.ts";

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

  it("of one version is that release's archive, when it has one for this architecture", async () => {
    const names = [archiveName("0.2.9", "arm64"), `${archiveName("0.2.9", "arm64")}.sig`];
    const asked: string[] = [];
    const answer = (async (url: string) => (asked.push(url), new Response(JSON.stringify(release("v0.2.9", names))))) as unknown as typeof fetch;
    expect(await releaseOffer("o/r", "0.2.9", "arm64", answer)).toMatchObject({ version: "0.2.9", archive: `https://example.test/${names[0]}` });
    expect(asked).toEqual(["https://api.github.com/repos/o/r/releases/tags/v0.2.9"]);
    expect(await releaseOffer("o/r", "0.2.9", "x64", answer)).toBeUndefined();
    expect(await releaseOffer("o/r", "0.2.9", "arm64", jsonFetch({}, 404))).toBeUndefined();
    // A feed (PIOMIO_UPDATE_URL) that has another version: not this one.
    expect(await releaseOffer("o/r", "0.2.8", "arm64", answer, "http://feed.test/latest")).toBeUndefined();
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

  it("looks again when the person opens the app, but not more than once in ten minutes", async () => {
    const names = [archiveName("0.3.0", "x64"), `${archiveName("0.3.0", "x64")}.sig`];
    let now = Date.parse("2026-11-03T12:00:00Z");
    let looks = 0;
    const answer = jsonFetch(release("v0.3.0", names));
    const { u } = updates(root("0.2.4"), { now: () => now, fetch: (async (...a: Parameters<typeof fetch>) => (looks++, answer(...a))) as typeof fetch });
    await u.check();
    expect(looks).toBe(1);
    u.checkSoon();
    now += 9 * 60_000;
    u.checkSoon();
    expect(looks).toBe(1);
    now += 2 * 60_000;
    u.checkSoon();
    expect(looks).toBe(2);
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

  it("has a machine inside the desktop app install the app's update, from the chat or the button", async () => {
    const asked: string[] = [];
    let m = { online: true, info: { ...info("0.2.3", false), desktopApp: true } };
    const { u } = updates(root("0.2.4"), { machine: () => m, appUpdateNode: async (id) => void asked.push(id) });
    expect(u.offerFor("m1", m.info)).toEqual({ update: "0.2.4" });
    expect(await u.update("m1")).toEqual({ version: "0.2.4" });
    expect(asked).toEqual(["m1"]);
    expect(u.offerFor("m1", m.info)).toEqual({ update: "0.2.4", updating: true });
    m = { online: true, info: { ...info("0.2.4", false), desktopApp: true } };
    u.machineChanged("m1", m.info);
    expect(u.offerFor("m1", m.info)).toEqual({});
    // An app from before this cannot take it from the hub: the person updates it there once.
    m = { online: true, info: { ...info("0.2.3", false) } } as typeof m;
    await expect(u.update("m1")).rejects.toMatchObject({ reason: "notSelf" });
    u.stop();
  });
});

describe("the desktop app's update", () => {
  /** The desktop app's latest.json (packaging/desktop/latest-json.mjs). */
  const latest = (version: string, platforms = ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"]) => ({
    version,
    platforms: Object.fromEntries(platforms.map((p) => [p, { url: `https://example.test/${p}`, signature: "sig" }])),
  });

  it("knows the app's name for this computer", () => {
    expect(desktopPlatform("darwin", "arm64")).toBe("darwin-aarch64");
    expect(desktopPlatform("darwin", "x64")).toBe("darwin-x86_64");
    expect(desktopPlatform("win32", "x64")).toBe("windows-x86_64");
    expect(desktopPlatform("linux", "x64")).toBeUndefined();
  });

  it("offers a newer version that latest.json lists for this computer", async () => {
    expect(await desktopOffer("o/r", "0.2.4", "darwin-aarch64", jsonFetch(latest("0.3.0")))).toEqual({ version: "0.3.0" });
    expect(await desktopOffer("o/r", "0.3.0", "darwin-aarch64", jsonFetch(latest("0.3.0")))).toBeUndefined();
    expect(await desktopOffer("o/r", "0.2.4", "darwin-aarch64", jsonFetch(latest("0.3.0", ["windows-x86_64"])))).toBeUndefined();
    await expect(desktopOffer("o/r", "0.2.4", "darwin-aarch64", jsonFetch({}, 404))).rejects.toThrow("404");
  });

  function desktop(over: Partial<HubUpdatesDeps> = {}) {
    const launched: string[][] = [];
    let now = Date.parse("2026-11-02T10:00:00Z");
    const t = updates(root(), {
      config: { desktopApp: "/Applications/Piomio.app/Contents/MacOS/piomio", version: "0.2.4", releasesRepo: "o/r", dataDir: tmp(), appRoot: tmp() },
      platform: "darwin",
      arch: "arm64",
      fetch: jsonFetch(latest("0.3.0")),
      launch: (file, args) => void launched.push([file, ...args]),
      now: () => now,
      ...over,
    });
    return { ...t, launched, later: (ms: number) => void (now += ms) };
  }

  it("is how a hub in the desktop app updates; elsewhere the app is not asked", () => {
    expect(desktop().u.kind).toBe("desktop");
    expect(desktop({ platform: "linux" }).u.kind).toBeUndefined();
    expect(updates(root("0.2.4")).u.kind).toBe("server");
  });

  it("asks the app to install, shows it updating, and hears why when the app can't", async () => {
    const { u, launched, told, restart } = desktop();
    await u.check();
    expect(told[0]).toContain("the Piomio app on this computer runs 0.2.4");
    expect(u.offerFor("local")).toEqual({ update: "0.3.0" });
    expect(await u.update("local")).toEqual({ version: "0.3.0" });
    expect(launched).toEqual([["/Applications/Piomio.app/Contents/MacOS/piomio", "--install-update"]]);
    expect(u.offerFor("local")).toEqual({ update: "0.3.0", updating: true });
    // A second press while it installs does not ask again; the app restarts the hub itself.
    await u.update("local");
    expect(launched).toHaveLength(1);
    expect(restart).not.toHaveBeenCalled();
    u.desktopFailed("no network");
    expect(u.offerFor("local")).toEqual({ update: "0.3.0" });
    expect(told[1]).toContain("could not update (no network); it stays on 0.2.4");
    u.stop();
  });

  it.skipIf(process.platform === "win32")("starts the app without the hub's data dir, so the running app gets the arguments", async () => {
    const dir = tmp();
    const app = join(dir, "piomio");
    const out = join(dir, "seen");
    // A stand-in for the app: what it was started with.
    writeFileSync(app, `#!/bin/sh\n{ echo "args $*"; env; } > "${out}.part" && mv "${out}.part" "${out}"\n`, { mode: 0o755 });
    launchApp(app, ["--install-update"], { PATH: process.env.PATH, PIOMIO_DATA_DIR: dir, PIOMIO_DESKTOP: "1", HOME: dir });
    const seen = await vi.waitFor(() => readFileSync(out, "utf8"), { timeout: 5000, interval: 50 });
    expect(seen).toContain("args --install-update");
    expect(seen).toContain(`HOME=${dir}`);
    // With PIOMIO_DATA_DIR the app takes itself for a dev run and starts a second copy (src-tauri/src/main.rs).
    expect(seen).not.toMatch(/^PIOMIO_DATA_DIR=/m);
  });

  it("offers each version once and at most once a day", async () => {
    const { u, told, later } = desktop();
    await u.check();
    later(3600_000);
    (u as any).d.fetch = jsonFetch(latest("0.3.1"));
    await u.check();
    // The button already offers 0.3.1; the chat hears of it a day after the last offer.
    expect(u.offerFor("local")).toEqual({ update: "0.3.1" });
    expect(told).toHaveLength(1);
    later(24 * 3600_000);
    await u.check();
    await u.check();
    expect(told).toHaveLength(2);
    expect(told[1]).toContain("Piomio 0.3.1 is out");
  });
});

/** A release of `version` as GitHub serves it: the release's JSON at releases/tags, its archive and signature. */
function releaseServed(version: string) {
  const { fetchImpl, offer } = served(version);
  const names = [archiveName(version, "x64"), `${archiveName(version, "x64")}.sig`];
  const asked: string[] = [];
  const answer = (async (url: string) => {
    asked.push(url);
    return url.includes("/releases/") ? new Response(JSON.stringify(release(`v${version}`, names))) : fetchImpl(url);
  }) as unknown as typeof fetch;
  return { fetchImpl: answer, offer, asked };
}

describe("a replica asked by the leader to update", () => {
  it("downloads and checks the leader's version itself, and says in its hello that it installs it", async () => {
    const r = root("0.2.4");
    const { fetchImpl, asked } = releaseServed("0.3.0");
    const { u, restart } = updates(r, { fetch: fetchImpl });
    expect(await u.updateTo("0.3.0")).toEqual({ version: "0.3.0" });
    expect(u.selfState()).toEqual({ installing: "0.3.0" });
    await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
    expect(asked[0]).toBe("https://api.github.com/repos/o/r/releases/tags/v0.3.0");
    expect(currentVersion(r)).toBe("0.3.0");
    expect(readFileSync(installLayout(r).trial, "utf8").trim()).toBe("0.2.4 0.3.0 0");
    expect(existsSync(installLayout(r).snapshot)).toBe(true);
  });

  it("goes only forward, to a release that exists, on an install that can update", async () => {
    const { fetchImpl } = releaseServed("0.3.0");
    const { u } = updates(root("0.2.4"), { fetch: fetchImpl });
    await expect(u.updateTo("0.2.4")).rejects.toMatchObject({ reason: "upToDate" });
    await expect(u.updateTo("0.2.3")).rejects.toMatchObject({ reason: "upToDate" });
    await expect(u.updateTo("0.3.0/../../x")).rejects.toMatchObject({ reason: "noRelease" });
    await expect(u.updateTo("0.3.1")).rejects.toMatchObject({ reason: "noRelease" });
    await expect(updates(root("0.2.4"), { platform: "darwin" }).u.updateTo("0.3.0")).rejects.toMatchObject({ reason: "notInstalled" });
  });

  it("says in its hello why the update failed, and stays as it was", async () => {
    const r = root("0.2.4");
    const { fetchImpl } = releaseServed("0.3.0");
    const { u, restart } = updates(r, { fetch: fetchImpl, verify: async () => false });
    await u.updateTo("0.3.0");
    await vi.waitFor(() => expect(u.selfState().failed).toBeTruthy());
    expect(u.selfState()).toEqual({ failed: { version: "0.3.0", why: "the archive's signature does not match Piomio's key" } });
    expect(currentVersion(r)).toBe("0.2.4");
    expect(restart).not.toHaveBeenCalled();
    // A version the launcher went back from, after its restart.
    u.rolledBack("0.3.0");
    expect(u.selfState().failed?.why).toContain("did not start");
  });

  it("in the desktop app, has the app install its update, and hears why it couldn't", async () => {
    const launched: string[][] = [];
    const { u } = updates(root(), {
      config: { desktopApp: "/Applications/Piomio.app/Contents/MacOS/piomio", version: "0.2.4", releasesRepo: "o/r", dataDir: tmp(), appRoot: tmp() },
      platform: "darwin",
      arch: "arm64",
      fetch: jsonFetch({ version: "0.3.0", platforms: { "darwin-aarch64": { url: "https://example.test/app", signature: "sig" } } }),
      launch: (file, args) => void launched.push([file, ...args]),
    });
    expect(await u.updateTo("0.3.0")).toEqual({ version: "0.3.0" });
    expect(launched).toEqual([["/Applications/Piomio.app/Contents/MacOS/piomio", "--install-update"]]);
    expect(u.selfState()).toEqual({ installing: "0.3.0" });
    u.desktopFailed("no network");
    expect(u.selfState()).toEqual({ failed: { version: "0.3.0", why: "no network" } });
    u.stop();
  });

  it("in the desktop app, looks again rather than install an older release, and refuses one short of the leader's", async () => {
    const latest = (version: string) => jsonFetch({ version, platforms: { "darwin-aarch64": { url: "https://example.test/app", signature: "sig" } } });
    const launched: string[][] = [];
    const { u } = updates(root(), {
      config: { desktopApp: "/Applications/Piomio.app/Contents/MacOS/piomio", version: "0.2.4", releasesRepo: "o/r", dataDir: tmp(), appRoot: tmp() },
      platform: "darwin",
      arch: "arm64",
      fetch: latest("0.3.0"),
      launch: (file, args) => void launched.push([file, ...args]),
    });
    // The hourly check found 0.3.0; the leader runs 0.3.1, and latest.json still lists 0.3.0: refused, nothing launched.
    await u.check();
    await expect(u.updateTo("0.3.1")).rejects.toMatchObject({ reason: "noRelease", version: "0.3.1" });
    expect(launched).toEqual([]);
    expect(u.selfState()).toEqual({});
    // Once 0.3.1 is out, the fresh look finds it (not the 0.3.0 from the hourly check).
    (u as any).d.fetch = latest("0.3.1");
    expect(await u.updateTo("0.3.1")).toEqual({ version: "0.3.1" });
    expect(launched).toHaveLength(1);
    expect(u.selfState()).toEqual({ installing: "0.3.1" });
    u.stop();
  });
});

describe("the leader and its replicas", () => {
  const peer = (over: Partial<ReplicaPeer> = {}): ReplicaPeer => ({ id: "rep_vps", name: "vps", online: true, version: "0.2.3", updates: "server", heardAt: 0, ...over });

  function leader(over: Partial<HubUpdatesDeps> = {}) {
    let now = Date.parse("2026-11-07T12:00:00Z");
    const replicas: ReplicaPeer[] = [peer()];
    const asked: Array<[string, string]> = [];
    const t = updates(root("0.2.4"), {
      replicas: () => replicas,
      askReplica: async (id, version) => (asked.push([id, version]), { version }),
      now: () => now,
      ...over,
    });
    return { ...t, replicas, asked, later: (ms: number) => void (now += ms), at: () => now };
  }

  it("offers Update on a replica behind it that can update itself, and not on the others", () => {
    const { u, replicas } = leader();
    expect(u.offerFor("rep_vps")).toEqual({ update: "0.2.4" });
    expect(u.replicaOffers()).toEqual([{ id: "rep_vps", name: "vps", update: "0.2.4" }]);
    for (const over of [{ version: "0.2.4" }, { version: "0.2.5" }, { online: false }, { updates: undefined }, { updates: "none" as const }, { version: undefined }]) {
      replicas[0] = peer(over);
      expect(u.offerFor("rep_vps")).toEqual({});
    }
  });

  it("asks the replica for its own version and shows it updating until it comes back on it", async () => {
    const { u, replicas, asked, at } = leader();
    expect(await u.update("rep_vps")).toEqual({ version: "0.2.4", replica: { name: "vps", updates: "server" } });
    expect(asked).toEqual([["rep_vps", "0.2.4"]]);
    expect(u.offerFor("rep_vps")).toEqual({ update: "0.2.4", updating: true });
    // A second press while it updates does not ask again.
    await u.update("rep_vps");
    expect(asked).toHaveLength(1);
    // It restarts (away), then says hello with the new version.
    replicas[0] = peer({ online: false, heardAt: at() + 1 });
    u.replicasChanged();
    expect(u.offerFor("rep_vps")).toEqual({});
    replicas[0] = peer({ version: "0.2.4", heardAt: at() + 2 });
    u.replicasChanged();
    expect(u.offerFor("rep_vps")).toEqual({});
    expect((u as any).replicaJobs.size).toBe(0);
    u.stop();
  });

  it("tells the person when the replica's update failed, once a hello after the ask says so", async () => {
    const { u, replicas, told, at } = leader();
    // A failure from before this ask is in the hello that crossed it: not this update's.
    replicas[0] = peer({ update: { failed: { version: "0.2.4", why: "old" } } });
    await u.update("rep_vps");
    replicas[0] = peer({ heardAt: at() - 1, update: { failed: { version: "0.2.4", why: "old" } } });
    u.replicasChanged();
    expect(u.offerFor("rep_vps")).toEqual({ update: "0.2.4", updating: true });
    expect(told).toHaveLength(0);
    replicas[0] = peer({ heardAt: at() + 1, update: { installing: "0.2.4" } });
    u.replicasChanged();
    expect(u.offerFor("rep_vps")).toEqual({ update: "0.2.4", updating: true });
    replicas[0] = peer({ heardAt: at() + 2, update: { failed: { version: "0.2.4", why: "GitHub answered 502" } } });
    u.replicasChanged();
    expect(u.offerFor("rep_vps")).toEqual({ update: "0.2.4" });
    expect(told).toEqual([expect.stringContaining("The hub replica vps could not update to Piomio 0.2.4 (GitHub answered 502); it stays on 0.2.3")]);
    u.replicasChanged();
    expect(told).toHaveLength(1);
    u.stop();
  });

  it("shows Update again at once when the replica comes back on a newer version that is still behind", async () => {
    const { u, replicas, told, at } = leader();
    replicas[0] = peer({ version: "0.2.2", updates: "desktop" });
    await u.update("rep_vps");
    expect(u.offerFor("rep_vps")).toEqual({ update: "0.2.4", updating: true });
    // An update it had downloaded before: 0.2.3, not this hub's 0.2.4.
    replicas[0] = peer({ version: "0.2.3", updates: "desktop", heardAt: at() + 1 });
    u.replicasChanged();
    expect(u.offerFor("rep_vps")).toEqual({ update: "0.2.4" });
    expect(told).toEqual([expect.stringContaining("The hub replica vps updated to Piomio 0.2.3, not yet this hub's 0.2.4")]);
    u.stop();
  });

  it("says why it can't update a replica, and lets a refusal there through", async () => {
    const { u, replicas } = leader({
      askReplica: async () => {
        throw new UpdateError("noRelease", "0.2.4");
      },
    });
    await expect(u.update("rep_vps")).rejects.toMatchObject({ reason: "noRelease" });
    expect(u.offerFor("rep_vps")).toEqual({ update: "0.2.4" });
    replicas[0] = peer({ updates: undefined });
    await expect(u.update("rep_vps")).rejects.toMatchObject({ reason: "replicaOld" });
    replicas[0] = peer({ updates: "none" });
    await expect(u.update("rep_vps")).rejects.toMatchObject({ reason: "notInstalled" });
    replicas[0] = peer({ online: false });
    await expect(u.update("rep_vps")).rejects.toMatchObject({ reason: "offline" });
    replicas[0] = peer({ version: "0.2.4" });
    await expect(u.update("rep_vps")).rejects.toMatchObject({ reason: "upToDate" });
  });

  it("updates the replica with the paired machine of its name: one computer, one Update", async () => {
    const info = { os: "linux", hostname: "vps", arch: "x64", clis: [], allowedDirs: [], nodeVersion: "v24", version: "0.2.4", selfUpdate: true };
    let m = { name: "VPS", online: true, info };
    const sent: string[] = [];
    const { u, asked } = leader({ machine: () => m, sendNode: async (id) => void sent.push(id) });
    // The machine's program is current: only the replica is asked.
    expect(await u.update("m1")).toMatchObject({ replica: { name: "vps" } });
    expect(asked).toEqual([["rep_vps", "0.2.4"]]);
    expect(sent).toEqual([]);
    u.stop();

    // Both behind: both are updated.
    const t = leader({ machine: () => m, sendNode: async (id) => void sent.push(id) });
    m = { name: "vps", online: true, info: { ...info, version: "0.2.3" } };
    const appRoot = (t.u as any).d.config.appRoot;
    mkdirSync(join(appRoot, "packages", "node", "dist"), { recursive: true });
    writeFileSync(join(appRoot, "packages", "node", "dist", "piomio-node.mjs"), "0.2.4\n");
    await t.u.update("m1");
    expect(t.asked).toEqual([["rep_vps", "0.2.4"]]);
    expect(sent).toEqual(["m1"]);
    t.u.stop();
  });

  it("offers to update a replica behind it in the chat, after a while, once per version and at most once a day", async () => {
    const { u, replicas, told, later, d } = leader();
    u.replicasChanged();
    expect(told).toHaveLength(0);
    later(3 * 60_000);
    u.replicasChanged();
    u.replicasChanged();
    expect(told).toEqual([expect.stringContaining('The hub replica vps runs Piomio 0.2.3, older than this hub\'s 0.2.4')]);
    expect(told[0]).toContain('hub_machine_update (machine "vps")');
    // Once per version, kept in the replicated meta table (another leader does not offer it again).
    expect(JSON.parse((d.prepare("select value from meta where key = 'replica_update_offered:rep_vps'").get() as { value: string }).value)).toMatchObject({ version: "0.2.4" });
    later(25 * 3600_000);
    u.replicasChanged();
    expect(told).toHaveLength(1);

    // One from before replicas updated from the leader: how to update it there, this once.
    replicas[0] = peer({ id: "rep_mac", name: "mac", updates: undefined });
    u.replicasChanged();
    later(3 * 60_000);
    u.replicasChanged();
    expect(told[1]).toContain("run the installer there again");
  });
});

describe("what agents hear about a replica's version", () => {
  it("is nothing while it runs this hub's, else that it is older and how it gets this one", () => {
    expect(replicaVersionNote({ name: "vps", version: "0.2.4" }, "0.2.4")).toBe("");
    expect(replicaVersionNote({ name: "vps" }, "0.2.4")).toBe("");
    expect(replicaVersionNote({ name: "vps", version: "0.2.3", update: "0.2.4" }, "0.2.4")).toContain('older than this hub\'s 0.2.4: machine_update with machine "vps"');
    expect(replicaVersionNote({ name: "vps", version: "0.2.3", update: "0.2.4", updating: true }, "0.2.4")).toBe(" (updating to 0.2.4)");
    expect(replicaVersionNote({ name: "vps", version: "0.2.3" }, "0.2.4")).toContain("can't be updated from here");
  });
});
