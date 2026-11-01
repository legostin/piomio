// Updates of a hub installed on a Linux server by packaging/linux/install.sh (PIOMIO_INSTALL_ROOT), and of the
// machines it can update: on the person's button (the machines block, the chat), never by themselves.
//
// The install root holds versions/<v> (each release's tree), `current` (a link to the one that runs) and `piomio`, the
// launcher systemd starts. An update downloads the release's archive and its minisign signature (the desktop updates'
// key), unpacks it, makes sure the new tree runs (`piomio version`), snapshots the database, writes `trial`
// ("<from> <to> <starts>") and points `current` at the new version, then the hub stops and systemd starts the new one.
// The launcher counts the starts: after three that never reached confirmStarted() it points `current` back and writes
// `rolled-back`; the old version then puts the snapshot back before it opens the database (settleBeforeStart) and has
// the default agent say so. Machines (piomio-node) older than the hub get its own bundle over their connection.
//
// A hub the desktop app runs (PIOMIO_DESKTOP_APP) offers the app's own update, the one its latest.json lists for this
// computer: the button runs the app with `--install-update`, and the app downloads it, stops the hub, installs and
// restarts (packages/desktop/src-tauri/src/update.rs). When it can't, it says why on the hub's stdin (desktopFailed).

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createWriteStream, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { MachineInfo } from "@piomio/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { hubDbFile } from "./db.ts";
import type { EventBus } from "./bus.ts";
import { verifyFile } from "./minisign.ts";
import { compareVersions } from "./updates.ts";

/** The key the desktop app's updates are signed with (packages/desktop/src-tauri/tauri.conf.json); also the archives'. */
export const UPDATE_PUBKEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDI3NTJCNDM2RjNDOTMyQzYKUldUR01zbnpOclJTSjQvaWhSbDRGOXdYZURoVU8rUWFUblhMQlM3RDY2TmVLa0p6emo5Umt4VVoK";

/** Starts of a new version that may fail before the launcher goes back to the previous one (packaging/linux/piomio). */
export const TRIAL_STARTS = 3;
/** A new version that has not come up by then exits, and its start counts as failed. */
export const TRIAL_MAX_MS = 3 * 60_000;
const CHECK_EVERY_MS = 6 * 3600_000;
/** Releases come often: the default agent offers one at most once a day (the button is there all along). */
const OFFER_EVERY_MS = 24 * 3600_000;
/** The desktop app has not restarted with the new version by then: the button comes back. */
const DESKTOP_INSTALL_MS = 20 * 60_000;
const OFFERED = "update_offered";
const OFFERED_AT = "update_offered_at";
/** A version the launcher had to go back from: never offered again (a newer one is). */
const FAILED = "update_failed";

export function installLayout(root: string) {
  return {
    root,
    versions: join(root, "versions"),
    current: join(root, "current"),
    launcher: join(root, "piomio"),
    trial: join(root, "trial"),
    rolledBack: join(root, "rolled-back"),
    snapshot: join(root, "snapshot.db"),
  };
}

/** The release archives' name for this architecture; none for the ones there are no archives for. */
export function linuxArch(arch: string = process.arch): "x64" | "arm64" | undefined {
  return arch === "x64" || arch === "arm64" ? arch : undefined;
}

export const archiveName = (version: string, arch: string) => `piomio-${version}-linux-${arch}.tar.gz`;

/** The version `current` points at. */
export function currentVersion(root: string): string | undefined {
  try {
    return basename(readlinkSync(installLayout(root).current));
  } catch {
    return undefined;
  }
}

/** Points `current` at versions/<version> in one rename, so the launcher never sees it missing. */
export function switchTo(root: string, version: string): void {
  const l = installLayout(root);
  const tmp = `${l.current}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  symlinkSync(join("versions", version), tmp);
  renameSync(tmp, l.current);
}

function readPair(file: string): { from: string; to: string; starts: number } | undefined {
  try {
    const [from, to, starts] = readFileSync(file, "utf8").trim().split(/\s+/);
    return from && to ? { from, to, starts: Number(starts) || 0 } : undefined;
  } catch {
    return undefined;
  }
}

/** What the hub's start must do about an update in progress. */
export interface StartState {
  /** The launcher went back to this version after the update to `to` failed; the database is as before the update. */
  rolledBack?: { from: string; to: string };
  /** This start tries out the new version. */
  trial?: { from: string; to: string };
}

/** Before the hub opens its database. After a rollback the database goes back to its snapshot from before the update. */
export function settleBeforeStart(root: string, dataDir: string, version: string): StartState {
  const l = installLayout(root);
  const out: StartState = {};
  const back = readPair(l.rolledBack);
  if (back) {
    if (existsSync(l.snapshot)) {
      const db = hubDbFile(dataDir);
      for (const f of [`${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
      copyFileSync(l.snapshot, db);
      rmSync(l.snapshot, { force: true });
    }
    out.rolledBack = { from: back.from, to: back.to };
  }
  const trial = readPair(l.trial);
  if (trial && trial.to === version) out.trial = { from: trial.from, to: trial.to };
  return out;
}

/**
 * The new version is up: the update stays. The snapshot goes, versions other than this and the previous one go, and
 * the launcher becomes this version's own.
 */
export function confirmStarted(root: string, version: string): { from: string; to: string } | undefined {
  const l = installLayout(root);
  const trial = readPair(l.trial);
  if (!trial || trial.to !== version) return undefined;
  rmSync(l.trial, { force: true });
  rmSync(l.snapshot, { force: true });
  const keep = new Set([trial.to, trial.from]);
  for (const v of existsSync(l.versions) ? readdirSync(l.versions) : []) {
    if (!keep.has(v)) rmSync(join(l.versions, v), { recursive: true, force: true });
  }
  const own = join(l.versions, version, "packaging", "linux", "piomio");
  if (existsSync(own)) {
    const tmp = `${l.launcher}.tmp`;
    copyFileSync(own, tmp);
    chmodSync(tmp, 0o755);
    renameSync(tmp, l.launcher);
  }
  return { from: trial.from, to: trial.to };
}

/** The rollback was told: its note goes. */
export function clearRolledBack(root: string): void {
  rmSync(installLayout(root).rolledBack, { force: true });
}

export interface Offer {
  version: string;
  archive: string;
  signature: string;
}

/** The desktop app's latest.json key for this computer (packaging/desktop/latest-json.mjs); none where there is no app. */
export function desktopPlatform(platform: string = process.platform, arch: string = process.arch): string | undefined {
  if (platform === "darwin") return arch === "arm64" ? "darwin-aarch64" : arch === "x64" ? "darwin-x86_64" : undefined;
  return platform === "win32" && arch === "x64" ? "windows-x86_64" : undefined;
}

/**
 * The version the desktop app would update to: the latest release's latest.json, when it is newer than `version` and
 * lists this computer. `feed`: another latest.json (PIOMIO_UPDATE_URL, the app's own local check).
 */
export async function desktopOffer(repo: string, version: string, platform: string, fetchImpl: typeof fetch = fetch, feed?: string): Promise<{ version: string } | undefined> {
  const r = await fetchImpl(feed ?? `https://github.com/${repo}/releases/latest/download/latest.json`, {
    headers: { "user-agent": `Piomio/${version}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`the release answered ${r.status}`);
  const latest = (await r.json()) as { version?: string; platforms?: Record<string, { url?: string; signature?: string }> };
  const v = String(latest.version ?? "").replace(/^v/, "");
  if (!v || compareVersions(v, version) <= 0) return undefined;
  const files = latest.platforms?.[platform];
  return files?.url && files.signature ? { version: v } : undefined;
}

/**
 * The latest release, when it is newer than `version` and has an archive for this architecture. `feed`: another URL
 * that answers like GitHub's releases/latest (PIOMIO_UPDATE_URL, a local check).
 */
export async function latestOffer(repo: string, version: string, arch: string, fetchImpl: typeof fetch = fetch, feed?: string): Promise<Offer | undefined> {
  const r = await fetchImpl(feed ?? `https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": `Piomio/${version}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  const rel = (await r.json()) as { tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string }> };
  const v = String(rel.tag_name ?? "").replace(/^v/, "");
  if (!v || compareVersions(v, version) <= 0) return undefined;
  const url = (name: string) => rel.assets?.find((a) => a.name === name)?.browser_download_url;
  const archive = url(archiveName(v, arch));
  const signature = url(`${archiveName(v, arch)}.sig`);
  return archive && signature ? { version: v, archive, signature } : undefined;
}

export type Run = (file: string, args: string[], timeoutMs: number) => Promise<string>;

const runFile: Run = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${basename(file)} ${args[args.length - 1] ?? ""}: ${String(stderr || err.message).trim().split("\n").pop()}`)) : resolve(stdout),
    );
  });

async function download(url: string, to: string, fetchImpl: typeof fetch): Promise<void> {
  const r = await fetchImpl(url, { headers: { "user-agent": "Piomio" }, signal: AbortSignal.timeout(20 * 60_000) });
  if (!r.ok || !r.body) throw new Error(`${url}: HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body as any), createWriteStream(to));
}

export interface HubUpdatesDeps {
  config: Pick<Config, "installRoot" | "desktopApp" | "version" | "releasesRepo" | "dataDir" | "appRoot" | "updateUrl">;
  db: Db;
  bus: EventBus;
  /** A note to the default agent, which tells the person (only the leading replica). */
  tell: (note: string) => void;
  /** Stops the hub; systemd starts the version `current` points at. */
  restart: () => void;
  /** The machine and its info, to see whether it can be updated. */
  machine: (id: string) => { info?: MachineInfo; online: boolean } | undefined;
  /** Sends a machine the hub's own piomio-node bundle. */
  sendNode: (id: string, update: { version: string; sha256: string; bundle: string }) => Promise<void>;
  fetch?: typeof fetch;
  run?: Run;
  verify?: (file: string, signatureText: string) => Promise<boolean>;
  /** Starts the desktop app with these arguments and does not wait for it. */
  launch?: (file: string, args: string[]) => void;
  now?: () => number;
  arch?: string;
  platform?: NodeJS.Platform;
}

/** A second launch of the desktop app hands its arguments to the running one and exits. */
const launchApp = (file: string, args: string[]) => {
  const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", (e) => console.log(`[piomio] ${basename(file)} ${args.join(" ")}: ${e.message}`));
  child.unref();
};

export class HubUpdates {
  private d: HubUpdatesDeps;
  /** A server install's archive, or the version the desktop app fetches itself. */
  private offer?: Offer | { version: string };
  private installing = false;
  private desktopTimer?: NodeJS.Timeout;
  private machines = new Map<string, NodeJS.Timeout>();
  private timer?: NodeJS.Timeout;

  constructor(d: HubUpdatesDeps) {
    this.d = d;
  }

  /**
   * How this hub updates itself: "server", installed by install.sh on an architecture with release archives;
   * "desktop", run by the desktop app on a computer it is made for.
   */
  get kind(): "server" | "desktop" | undefined {
    const platform = this.d.platform ?? process.platform;
    if (this.d.config.installRoot && platform === "linux" && linuxArch(this.d.arch)) return "server";
    if (this.d.config.desktopApp && desktopPlatform(platform, this.d.arch ?? process.arch)) return "desktop";
    return undefined;
  }

  get enabled(): boolean {
    return !!this.kind;
  }

  /** Checks now and every day. */
  start(): void {
    if (!this.enabled || this.timer) return;
    void this.check().catch((e) => console.log(`[piomio] update check: ${e?.message ?? e}`));
    this.timer = setInterval(() => void this.check().catch(() => {}), CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.desktopTimer);
    this.timer = undefined;
    for (const t of this.machines.values()) clearTimeout(t);
    this.machines.clear();
  }

  /**
   * The release on offer for this hub, after a look at GitHub. The default agent offers a version once, and at most
   * one a day.
   */
  async check(): Promise<Offer | { version: string } | undefined> {
    const kind = this.kind;
    if (!kind) return undefined;
    const { releasesRepo, version, updateUrl } = this.d.config;
    const latest =
      kind === "server"
        ? await latestOffer(releasesRepo, version, linuxArch(this.d.arch)!, this.d.fetch, updateUrl)
        : await desktopOffer(releasesRepo, version, desktopPlatform(this.d.platform ?? process.platform, this.d.arch ?? process.arch)!, this.d.fetch, updateUrl);
    const offer = latest && latest.version !== this.meta(FAILED) ? latest : undefined;
    if (offer?.version !== this.offer?.version) {
      this.offer = offer;
      this.d.bus.emit("updates.changed", {});
    }
    const now = (this.d.now ?? Date.now)();
    const lastOffer = Date.parse(this.meta(OFFERED_AT) ?? "");
    if (offer && this.meta(OFFERED) !== offer.version && !(now - lastOffer < OFFER_EVERY_MS)) {
      this.setMeta(OFFERED, offer.version);
      this.setMeta(OFFERED_AT, new Date(now).toISOString());
      this.d.tell(
        kind === "server"
          ? `[System] Piomio ${offer.version} is out; this server runs ${version}. Tell the person in one short message and offer to update now ` +
              "with show_choices (update now / not now). On yes call hub_machine_update (machine \"local\"): the hub checks the new version, restarts and is " +
              "back in about a minute, and goes back to this version by itself if the new one does not start. The person can also update from the machines block in the sidebar."
          : `[System] Piomio ${offer.version} is out; the Piomio app on this computer runs ${version}. Tell the person in one short message and offer to ` +
              "update now with show_choices (update now / not now). On yes call hub_machine_update (machine \"local\"): the app downloads the update, " +
              "restarts with it and is back in a minute or two. The person can also update from the machines block in the sidebar.",
      );
    }
    return offer;
  }

  /** The launcher went back from `version` (StartState.rolledBack): its tree goes, and it is not offered again. */
  rolledBack(version: string): void {
    this.setMeta(FAILED, version);
    if (this.d.config.installRoot && currentVersion(this.d.config.installRoot) !== version) {
      rmSync(join(installLayout(this.d.config.installRoot).versions, version), { recursive: true, force: true });
    }
  }

  /** What the machines block offers on a machine's row ("local": this hub). */
  offerFor(id: string, info?: MachineInfo): { update?: string; updating?: boolean } {
    if (id === "local") return this.offer ? { update: this.offer.version, ...(this.installing ? { updating: true } : {}) } : {};
    if (this.machines.has(id)) return { update: this.d.config.version, updating: true };
    return this.nodeNeeds(info) ? { update: this.d.config.version } : {};
  }

  private nodeNeeds(info?: MachineInfo): boolean {
    return !!info?.selfUpdate && !!info.version && compareVersions(this.d.config.version, info.version) > 0;
  }

  /**
   * Updates a machine: "local" starts this hub's update and resolves once it is under way (the hub restarts when it
   * is ready; a failure before that is told in the chat); a paired machine gets the hub's bundle.
   */
  async update(id: string): Promise<{ version: string }> {
    if (id === "local") {
      if (!this.enabled) throw new UpdateError("notInstalled");
      const offer = this.offer ?? (await this.check());
      if (!offer) throw new UpdateError("upToDate", this.d.config.version);
      if (this.installing) return { version: offer.version };
      // A server's check finds its archive; the desktop app fetches its own files.
      if (this.kind === "desktop") this.installDesktop();
      else void this.install(offer as Offer).catch(() => {});
      return { version: offer.version };
    }
    const m = this.d.machine(id);
    if (!m) throw new UpdateError("unknown");
    if (!m.online) throw new UpdateError("offline");
    if (!m.info?.selfUpdate) throw new UpdateError("notSelf");
    if (!this.nodeNeeds(m.info)) throw new UpdateError("upToDate", m.info.version);
    if (this.machines.has(id)) return { version: this.d.config.version };
    const file = join(this.d.config.appRoot, "packages", "node", "dist", "piomio-node.mjs");
    if (!existsSync(file)) throw new UpdateError("noBundle");
    const bundle = readFileSync(file);
    // Until it comes back with the new version (machineChanged), or three minutes.
    this.machines.set(id, setTimeout(() => this.machineDone(id), 3 * 60_000));
    this.d.bus.emit("updates.changed", {});
    try {
      await this.d.sendNode(id, { version: this.d.config.version, sha256: createHash("sha256").update(bundle).digest("hex"), bundle: bundle.toString("base64") });
    } catch (e) {
      this.machineDone(id);
      throw e;
    }
    return { version: this.d.config.version };
  }

  /** A machine said hello again: an update to it is done once it runs the hub's version. */
  machineChanged(id: string, info?: MachineInfo): void {
    if (this.machines.has(id) && !this.nodeNeeds(info)) this.machineDone(id);
  }

  private machineDone(id: string): void {
    const t = this.machines.get(id);
    if (!t) return;
    clearTimeout(t);
    this.machines.delete(id);
    this.d.bus.emit("updates.changed", {});
  }

  /** The desktop app installs its update itself: this hub stops when it does, or hears why not (desktopFailed). */
  private installDesktop(): void {
    this.installing = true;
    this.d.bus.emit("updates.changed", {});
    clearTimeout(this.desktopTimer);
    this.desktopTimer = setTimeout(() => this.desktopDone(), DESKTOP_INSTALL_MS);
    this.desktopTimer.unref?.();
    console.log("[piomio] asking the desktop app to install its update");
    (this.d.launch ?? launchApp)(this.d.config.desktopApp!, ["--install-update"]);
  }

  /** The desktop app could not install the update the button asked for (its `update-failed` line on the hub's stdin). */
  desktopFailed(why: string): void {
    this.desktopDone();
    console.log(`[piomio] the desktop app's update failed: ${why}`);
    this.d.tell(
      `[System] The Piomio app could not update (${why || "no reason given"}); it stays on ${this.d.config.version}. Tell the person in one short ` +
        "message; they can try again later from the machines block in the sidebar or the app's menu by its icon.",
    );
  }

  private desktopDone(): void {
    clearTimeout(this.desktopTimer);
    this.desktopTimer = undefined;
    if (!this.installing) return;
    this.installing = false;
    this.d.bus.emit("updates.changed", {});
  }

  /** Download, check, snapshot, switch, restart. Anything that fails before the switch leaves the install as it was. */
  async install(offer: Offer): Promise<void> {
    if (this.installing) return;
    const root = this.d.config.installRoot!;
    const l = installLayout(root);
    const fetchImpl = this.d.fetch ?? fetch;
    const run = this.d.run ?? runFile;
    const verify = this.d.verify ?? ((file: string, sig: string) => verifyFile(file, sig, UPDATE_PUBKEY));
    const v = offer.version;
    const archive = join(l.versions, `.download-${v}.tar.gz`);
    const unpack = join(l.versions, `.${v}.tmp`);
    const dest = join(l.versions, v);
    this.installing = true;
    this.d.bus.emit("updates.changed", {});
    try {
      mkdirSync(l.versions, { recursive: true });
      await download(offer.archive, archive, fetchImpl);
      const sig = await fetchImpl(offer.signature, { headers: { "user-agent": "Piomio" }, signal: AbortSignal.timeout(60_000) });
      if (!sig.ok) throw new Error(`${offer.signature}: HTTP ${sig.status}`);
      if (!(await verify(archive, await sig.text()))) throw new Error("the archive's signature does not match Piomio's key");
      rmSync(unpack, { recursive: true, force: true });
      mkdirSync(unpack, { recursive: true });
      await run("tar", ["-xzf", archive, "-C", unpack], 10 * 60_000);
      const [top] = readdirSync(unpack);
      if (!top) throw new Error("the archive is empty");
      if (currentVersion(root) !== v) rmSync(dest, { recursive: true, force: true });
      renameSync(join(unpack, top), dest);
      const said = (await run(join(dest, "runtime", "bin", "node"), [join(dest, "packaging", "linux", "start.mjs"), "version"], 120_000)).trim();
      if (said !== v) throw new Error(`the new version says it is ${said || "nothing"}`);
      rmSync(l.snapshot, { force: true });
      this.d.db.exec(`vacuum into '${l.snapshot.replace(/'/g, "''")}'`);
      writeFileSync(l.trial, `${currentVersion(root) ?? this.d.config.version} ${v} 0\n`);
      switchTo(root, v);
      console.log(`[piomio] updating to ${v}: restarting`);
      this.d.restart();
    } catch (e: any) {
      if (currentVersion(root) !== v) rmSync(dest, { recursive: true, force: true });
      rmSync(l.trial, { force: true });
      this.installing = false;
      this.d.bus.emit("updates.changed", {});
      console.log(`[piomio] update to ${v} failed: ${e?.message ?? e}`);
      this.d.tell(`[System] The update to Piomio ${v} failed before anything changed (${String(e?.message ?? e)}); the hub stays on ${this.d.config.version}. Tell the person in one short message.`);
      throw e;
    } finally {
      rmSync(archive, { force: true });
      rmSync(unpack, { recursive: true, force: true });
    }
  }

  private meta(key: string): string | undefined {
    return (this.d.db.prepare("select value from meta where key = ?").get(key) as { value: string } | undefined)?.value;
  }

  private setMeta(key: string, value: string): void {
    this.d.db.prepare("insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, value);
  }
}

export type UpdateRefusal = "notInstalled" | "upToDate" | "unknown" | "offline" | "notSelf" | "noBundle";

export class UpdateError extends Error {
  readonly reason: UpdateRefusal;
  readonly version?: string;
  constructor(reason: UpdateRefusal, version?: string) {
    super(reason);
    this.reason = reason;
    this.version = version;
  }
}
