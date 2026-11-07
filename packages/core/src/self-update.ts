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
//
// The leading replica (cluster.ts) gets its standby replicas onto its own version the same way, on the same button: it
// asks one over the replica link (replica.update) and the replica updates itself (updateTo) — a server downloads and
// checks that very release, a desktop app installs its own update. The leader sends no code; it hears how it goes in
// the replica's hellos (selfState) and tells the person when it fails.

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
const CHECK_EVERY_MS = 3600_000;
/** The person opened the app or brought it to the front (checkSoon): a look at GitHub, at most this often. */
const LOOK_GAP_MS = 10 * 60_000;
/** Releases come often: the default agent offers one at most once a day (the button is there all along). */
const OFFER_EVERY_MS = 24 * 3600_000;
/** The desktop app has not restarted with the new version by then: the button comes back. */
const DESKTOP_INSTALL_MS = 20 * 60_000;
const OFFERED = "update_offered";
const OFFERED_AT = "update_offered_at";
/** A version the launcher had to go back from: never offered again (a newer one is). */
const FAILED = "update_failed";
/** A replica's update the leader asked for: "Updating…" until it runs the version, it fails, or this long. */
const REPLICA_UPDATE_MS = 30 * 60_000;
/** A replica behind the leader this long (not one restarting into its update): the default agent offers to update it. */
const BEHIND_MS = 2 * 60_000;
/** meta `replica_update_offered:<id>`: {version, at} of the last chat offer for that replica (the meta table replicates). */
const REPLICA_OFFERED = "replica_update_offered";

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

interface GithubRelease {
  tag_name?: string;
  assets?: Array<{ name?: string; browser_download_url?: string }>;
}

async function fetchRelease(url: string, version: string, fetchImpl: typeof fetch): Promise<GithubRelease | undefined> {
  const r = await fetchImpl(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": `Piomio/${version}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  return (await r.json()) as GithubRelease;
}

/** A release's version and its archive and signature for this architecture, when it has both. */
function offerOf(rel: GithubRelease | undefined, arch: string): Offer | undefined {
  const v = String(rel?.tag_name ?? "").replace(/^v/, "");
  if (!v) return undefined;
  const url = (name: string) => rel?.assets?.find((a) => a.name === name)?.browser_download_url;
  const archive = url(archiveName(v, arch));
  const signature = url(`${archiveName(v, arch)}.sig`);
  return archive && signature ? { version: v, archive, signature } : undefined;
}

/**
 * The latest release, when it is newer than `version` and has an archive for this architecture. `feed`: another URL
 * that answers like GitHub's releases/latest (PIOMIO_UPDATE_URL, a local check).
 */
export async function latestOffer(repo: string, version: string, arch: string, fetchImpl: typeof fetch = fetch, feed?: string): Promise<Offer | undefined> {
  const rel = await fetchRelease(feed ?? `https://api.github.com/repos/${repo}/releases/latest`, version, fetchImpl);
  if (!rel) throw new Error("GitHub answered 404");
  const offer = offerOf(rel, arch);
  return offer && compareVersions(offer.version, version) > 0 ? offer : undefined;
}

/**
 * The release of exactly `version` (the leading replica's), with an archive for this architecture. `feed`: as for
 * latestOffer, then only when it is that version.
 */
export async function releaseOffer(repo: string, version: string, arch: string, fetchImpl: typeof fetch = fetch, feed?: string): Promise<Offer | undefined> {
  const offer = offerOf(await fetchRelease(feed ?? `https://api.github.com/repos/${repo}/releases/tags/v${version}`, version, fetchImpl), arch);
  return offer?.version === version ? offer : undefined;
}

/** This hub's own update, as its hello tells the other replicas (cluster.ts). */
export interface SelfUpdateState {
  /** The version it is installing now. */
  installing?: string;
  /** The last update that failed, and why (English, for the leader's note to the default agent). */
  failed?: { version: string; why: string };
}

/** How a hub updates itself (HubUpdates.kind); "none": it runs from the source code. */
export type UpdateKind = "server" | "desktop" | "none";

/** Another replica of this hub, as its last hello says (cluster.ts replicaPeers). */
export interface ReplicaPeer {
  id: string;
  name: string;
  online: boolean;
  version?: string;
  /** Unset: a Piomio from before the leader could ask a replica to update (replica.update). */
  updates?: UpdateKind;
  update?: SelfUpdateState;
  /** When the hello that said this was asked for. */
  heardAt: number;
}

/** What the person sees on a replica's row: the version Update brings, and whether it is under way. */
export interface ReplicaOffer {
  id: string;
  name: string;
  update: string;
  updating?: boolean;
}

/**
 * A replica and a paired machine of the same name are one computer (install.sh names the hub replica and piomio-node
 * there after it): one row, one Update for both.
 */
export const sameComputer = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * What an agent hears about a replica's version next to its name (cluster_status, machine_list): nothing while it runs
 * this hub's version (or one it can't tell); else that it is older, and how it gets this one.
 */
export function replicaVersionNote(r: { name: string; version?: string; update?: string; updating?: boolean }, hubVersion: string): string {
  if (!r.version) return "";
  if (r.updating) return ` (updating to ${r.update ?? hubVersion})`;
  if (compareVersions(hubVersion, r.version) <= 0) return "";
  if (r.update) return ` (older than this hub's ${hubVersion}: machine_update with machine "${r.name}" updates it)`;
  return (
    ` (older than this hub's ${hubVersion}, and it can't be updated from here: it runs a Piomio from before replicas updated from the leader, ` +
    "or one from the source code. Once, on that computer: run the installer again on a server, or Install update in the desktop app's icon menu)"
  );
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
  machine: (id: string) => { name?: string; info?: MachineInfo; online: boolean } | undefined;
  /** Sends a machine the hub's own piomio-node bundle. */
  sendNode: (id: string, update: { version: string; sha256: string; bundle: string }) => Promise<void>;
  /** Has a machine that runs inside the desktop app install the app's own update (node.appUpdate). */
  appUpdateNode?: (id: string) => Promise<void>;
  /** This hub's other replicas, as their hellos say (cluster.ts); none for a hub of one. */
  replicas?: () => ReplicaPeer[];
  /** Asks a replica over its link to update itself to `version` (replica.update); resolves once it is under way. */
  askReplica?: (id: string, version: string) => Promise<{ version: string }>;
  fetch?: typeof fetch;
  run?: Run;
  verify?: (file: string, signatureText: string) => Promise<boolean>;
  /** Starts the desktop app with these arguments and does not wait for it. */
  launch?: (file: string, args: string[]) => void;
  now?: () => number;
  arch?: string;
  platform?: NodeJS.Platform;
}

/**
 * A second launch of the desktop app hands its arguments to the running one and exits. Not with the hub's
 * PIOMIO_DATA_DIR (the app sets it for the hub only): with it the app takes itself for a dev run, skips that hand-over
 * and starts a second copy (packages/desktop/src-tauri/src/main.rs).
 */
export const launchApp = (file: string, args: string[], env: NodeJS.ProcessEnv = process.env) => {
  const { PIOMIO_DATA_DIR: _, ...appEnv } = env;
  const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true, env: appEnv });
  child.on("error", (e) => console.log(`[piomio] ${basename(file)} ${args.join(" ")}: ${e.message}`));
  child.unref();
};

/** What an Update started: its version, and the hub replica it covers (alone, or with the machine of its name). */
export interface UpdateStarted {
  version: string;
  replica?: { name: string; updates: "server" | "desktop" };
}

export class HubUpdates {
  private d: HubUpdatesDeps;
  /** A server install's archive, or the version the desktop app fetches itself. */
  private offer?: Offer | { version: string };
  private installing = false;
  /** The version this hub installs now, and the last update of its own that failed (selfState). */
  private installingTo?: string;
  private failure?: { version: string; why: string };
  private desktopTimer?: NodeJS.Timeout;
  private machines = new Map<string, NodeJS.Timeout>();
  /**
   * Replicas the leader asked to update (from `from`): until they run `version`, come back on another version, say
   * they failed, or REPLICA_UPDATE_MS.
   */
  private replicaJobs = new Map<string, { version: string; from: string; answeredAt: number; timer: NodeJS.Timeout }>();
  /** Since when each replica has been behind this hub (the chat offer waits BEHIND_MS). */
  private behind = new Map<string, number>();
  private replicaKey = "";
  private timer?: NodeJS.Timeout;
  private lastLook = 0;

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

  /** Checks now and every hour. */
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
    for (const j of this.replicaJobs.values()) clearTimeout(j.timer);
    this.replicaJobs.clear();
  }

  /**
   * The release on offer for this hub, after a look at GitHub. The default agent offers a version once, and at most
   * one a day.
   */
  async check(): Promise<Offer | { version: string } | undefined> {
    const kind = this.kind;
    if (!kind) return undefined;
    this.lastLook = (this.d.now ?? Date.now)();
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

  /** The person opened the app or brought it to the front: a look now, so Update shows soon after a release. */
  checkSoon(): void {
    if (!this.enabled || (this.d.now ?? Date.now)() - this.lastLook < LOOK_GAP_MS) return;
    void this.check().catch((e) => console.log(`[piomio] update check: ${e?.message ?? e}`));
  }

  /** The launcher went back from `version` (StartState.rolledBack): its tree goes, and it is not offered again. */
  rolledBack(version: string): void {
    this.setMeta(FAILED, version);
    // A standby's leader hears it in the hello, and tells the person.
    this.failure = { version, why: "the new version did not start, so the launcher went back to the one before" };
    if (this.d.config.installRoot && currentVersion(this.d.config.installRoot) !== version) {
      rmSync(join(installLayout(this.d.config.installRoot).versions, version), { recursive: true, force: true });
    }
  }

  /** What the machines block offers on a machine's row ("local": this hub; a replica's id: that replica). */
  offerFor(id: string, info?: MachineInfo): { update?: string; updating?: boolean } {
    if (id === "local") return this.offer ? { update: this.offer.version, ...(this.installing ? { updating: true } : {}) } : {};
    const replica = this.replicaPeer(id);
    if (replica) return this.replicaOffer(replica);
    if (this.machines.has(id)) return { update: this.d.config.version, updating: true };
    return this.nodeNeeds(info) ? { update: this.d.config.version } : {};
  }

  /** This hub's own update, for its hello: under way, or how the last one failed. */
  selfState(): SelfUpdateState {
    return {
      ...(this.installing ? { installing: this.installingTo ?? this.offer?.version ?? this.d.config.version } : {}),
      ...(this.failure ? { failed: this.failure } : {}),
    };
  }

  // ---------- the other replicas, from the one that leads ----------

  /** A replica by id or name. */
  replicaPeer(idOrName: string): ReplicaPeer | undefined {
    const all = this.d.replicas?.() ?? [];
    return all.find((r) => r.id === idOrName) ?? all.find((r) => sameComputer(r.name, idOrName));
  }

  /** Online, older than this hub and able to update itself when asked. */
  private replicaNeeds(r: ReplicaPeer): boolean {
    return r.online && (r.updates === "server" || r.updates === "desktop") && !!r.version && compareVersions(this.d.config.version, r.version) > 0;
  }

  private replicaOffer(r: ReplicaPeer): { update?: string; updating?: boolean } {
    if (!this.replicaNeeds(r)) return {};
    return { update: this.d.config.version, ...(this.replicaJobs.has(r.id) || r.update?.installing ? { updating: true } : {}) };
  }

  /** The replicas with an Update on offer (the machines block gives each a row, or the row of its computer). */
  replicaOffers(): ReplicaOffer[] {
    return (this.d.replicas?.() ?? []).flatMap((r) => {
      const o = this.replicaOffer(r);
      return o.update ? [{ id: r.id, name: r.name, update: o.update, ...(o.updating ? { updating: true } : {}) }] : [];
    });
  }

  /**
   * The cluster heard every replica's hello again (cluster.ts, on the leader): an update asked of one is done once it
   * runs the version, or failed when a hello asked for after it was under way says so; a replica behind for a while
   * gets one offer in the chat.
   */
  replicasChanged(): void {
    const replicas = this.d.replicas?.() ?? [];
    for (const [id, job] of [...this.replicaJobs]) {
      const r = replicas.find((x) => x.id === id);
      if (!r || (r.version && compareVersions(r.version, job.version) >= 0)) {
        this.replicaDone(id);
        continue;
      }
      // It restarted on a newer version that is still behind (an older update it had downloaded): Update again.
      if (r.version && compareVersions(r.version, job.from) > 0) {
        this.replicaDone(id);
        this.d.tell(
          `[System] The hub replica ${r.name} updated to Piomio ${r.version}, not yet this hub's ${job.version}. Tell the person in one short message; ` +
            "Update once more (the machines block, or ask you) brings it the rest of the way.",
        );
        continue;
      }
      const failed = r.update?.failed;
      if (job.answeredAt && r.heardAt > job.answeredAt && failed && !r.update?.installing) {
        this.replicaDone(id);
        this.d.tell(
          `[System] The hub replica ${r.name} could not update to Piomio ${failed.version} (${failed.why.slice(0, 300)}); it stays on ${r.version ?? "its version"}. ` +
            "Tell the person in one short message; they can try again from the machines block in the sidebar, or ask you.",
        );
      }
    }
    this.offerReplicas(replicas);
    const key = JSON.stringify(this.replicaOffers());
    if (key !== this.replicaKey) {
      this.replicaKey = key;
      this.d.bus.emit("updates.changed", {});
    }
  }

  /**
   * The default agent offers to update a replica that has been behind this hub for a while: once per version of this
   * hub, at most once a day. One that can't be updated from here gets how to do it on that computer.
   */
  private offerReplicas(replicas: ReplicaPeer[]): void {
    const now = (this.d.now ?? Date.now)();
    const v = this.d.config.version;
    for (const r of replicas) {
      if (!r.online || !r.version || compareVersions(v, r.version) <= 0) {
        this.behind.delete(r.id);
        continue;
      }
      const since = this.behind.get(r.id) ?? now;
      this.behind.set(r.id, since);
      if (now - since < BEHIND_MS || this.replicaJobs.has(r.id) || r.update?.installing) continue;
      const key = `${REPLICA_OFFERED}:${r.id}`;
      let last: { version?: string; at?: string } = {};
      try {
        last = JSON.parse(this.meta(key) ?? "{}");
      } catch {
        /* an unreadable mark: offer again */
      }
      if (last.version === v || now - Date.parse(last.at ?? "") < OFFER_EVERY_MS) continue;
      this.setMeta(key, JSON.stringify({ version: v, at: new Date(now).toISOString() }));
      const lag = `[System] The hub replica ${r.name} runs Piomio ${r.version}, older than this hub's ${v}: replicas on different versions can't fully take over from each other. `;
      this.d.tell(
        this.replicaNeeds(r)
          ? lag +
              "Tell the person in one short message and offer to update it now with show_choices (update now / not now). On yes call hub_machine_update " +
              `(machine "${r.name}"): ${r.name} downloads and checks the release itself and restarts with it (about a minute on a server, a few minutes in the desktop app), ` +
              "and goes back by itself if the new version does not start. The machines block in the sidebar has the same Update button."
          : lag +
              (r.updates === "none"
                ? `It runs from the source code, so it can't be updated from here: tell the person in one short message to update it on that computer (git pull and a restart).`
                : "It runs a Piomio from before replicas updated from the leader, so it can't be updated from here this once. Tell the person in one short message how: " +
                  "on a server, run the installer there again as root (curl -fsSL https://piomio.io/install.sh | sh); in the desktop app, Install update in its icon's menu. " +
                  "After that it updates from here, on the machines block's Update button or in the chat."),
      );
    }
  }

  /** The replica runs the version asked for, failed, or took too long: its row shows what is on offer again. */
  private replicaDone(id: string): void {
    const j = this.replicaJobs.get(id);
    if (!j) return;
    clearTimeout(j.timer);
    this.replicaJobs.delete(id);
    this.d.bus.emit("updates.changed", {});
  }

  /** Asks a replica to update itself to this hub's version; resolves once it is under way there. */
  private async updateReplica(r: ReplicaPeer): Promise<UpdateStarted> {
    const v = this.d.config.version;
    if (!r.online) throw new UpdateError("offline");
    if (!r.version || compareVersions(v, r.version) <= 0) throw new UpdateError("upToDate", r.version ?? v);
    if (r.updates === "none") throw new UpdateError("notInstalled");
    if ((r.updates !== "server" && r.updates !== "desktop") || !this.d.askReplica) throw new UpdateError("replicaOld", r.version);
    const started: UpdateStarted = { version: v, replica: { name: r.name, updates: r.updates } };
    if (this.replicaJobs.has(r.id) || r.update?.installing) return started;
    const timer = setTimeout(() => this.replicaDone(r.id), REPLICA_UPDATE_MS);
    timer.unref?.();
    const job = { version: v, from: r.version, answeredAt: 0, timer };
    this.replicaJobs.set(r.id, job);
    this.d.bus.emit("updates.changed", {});
    try {
      await this.d.askReplica(r.id, v);
      job.answeredAt = (this.d.now ?? Date.now)();
    } catch (e) {
      this.replicaDone(r.id);
      throw e;
    }
    return started;
  }

  /**
   * Asked by the replica that leads (replica.update): this hub updates itself to `version`, the leader's. A server
   * downloads that very release and checks its signature itself, as for its own Update; the desktop app installs its
   * own update (the newest, which is the leader's version or a later one). Never to an older or the same version.
   * Resolves once the update is under way; selfState() then tells the leader how it goes.
   */
  async updateTo(version: string): Promise<{ version: string }> {
    const kind = this.kind;
    if (!kind) throw new UpdateError("notInstalled");
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new UpdateError("noRelease", version);
    if (compareVersions(version, this.d.config.version) <= 0) throw new UpdateError("upToDate", this.d.config.version);
    if (this.installing) return { version: this.installingTo ?? version };
    if (kind === "desktop") {
      // A fresh look, not the offer from the last hourly check: the app installs the latest release (one it downloaded
      // earlier gives way to a newer one, update.rs install_now), and that has to reach the leader's version.
      const offer = await this.check();
      if (!offer || compareVersions(offer.version, version) < 0) throw new UpdateError("noRelease", version);
      this.installDesktop(offer.version);
      return { version: offer.version };
    }
    const { releasesRepo, updateUrl } = this.d.config;
    const known = this.offer && "archive" in this.offer && this.offer.version === version ? this.offer : undefined;
    const offer = known ?? (await releaseOffer(releasesRepo, version, linuxArch(this.d.arch)!, this.d.fetch, updateUrl));
    if (!offer) throw new UpdateError("noRelease", version);
    void this.install(offer).catch(() => {});
    return { version };
  }

  private nodeNeeds(info?: MachineInfo): boolean {
    return (!!info?.selfUpdate || !!info?.desktopApp) && !!info.version && compareVersions(this.d.config.version, info.version) > 0;
  }

  /**
   * Updates a machine: "local" starts this hub's update and resolves once it is under way (the hub restarts when it
   * is ready; a failure before that is told in the chat); a paired machine gets the hub's bundle; a hub replica (its id)
   * updates itself to this hub's version. A machine whose replica of the same name is behind too gets both.
   */
  async update(id: string): Promise<UpdateStarted> {
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
    const replica = this.replicaPeer(id);
    if (replica?.id === id) return this.updateReplica(replica);
    const m = this.d.machine(id);
    if (!m) throw new UpdateError("unknown");
    const twin = m.online && m.name ? (this.d.replicas?.() ?? []).find((r) => sameComputer(r.name, m.name!) && this.replicaNeeds(r)) : undefined;
    if (!twin) return this.updateNode(id, m);
    // The node's part is best effort: the replica's answer is the one the button and the chat hear.
    const node = this.nodeNeeds(m.info) && !this.machines.has(id) ? this.updateNode(id, m).catch((e) => console.log(`[piomio] update of ${m.name}: ${e?.message ?? e}`)) : undefined;
    const started = await this.updateReplica(twin);
    await node;
    return started;
  }

  /** A paired machine gets the hub's piomio-node bundle, or (inside the desktop app) installs the app's update. */
  private async updateNode(id: string, m: { info?: MachineInfo; online: boolean }): Promise<UpdateStarted> {
    if (!m.online) throw new UpdateError("offline");
    if (!m.info?.selfUpdate && !(m.info?.desktopApp && this.d.appUpdateNode)) throw new UpdateError("notSelf");
    if (!this.nodeNeeds(m.info)) throw new UpdateError("upToDate", m.info.version);
    if (this.machines.has(id)) return { version: this.d.config.version };
    // Inside the desktop app: the app downloads its own update and restarts with it (longer than a daemon's swap).
    if (!m.info.selfUpdate) {
      this.machines.set(id, setTimeout(() => this.machineDone(id), 15 * 60_000));
      this.d.bus.emit("updates.changed", {});
      try {
        await this.d.appUpdateNode!(id);
      } catch (e) {
        this.machineDone(id);
        throw e;
      }
      return { version: this.d.config.version };
    }
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
  private installDesktop(version?: string): void {
    this.installing = true;
    this.installingTo = version ?? this.offer?.version;
    this.failure = undefined;
    this.d.bus.emit("updates.changed", {});
    clearTimeout(this.desktopTimer);
    this.desktopTimer = setTimeout(() => this.desktopDone(), DESKTOP_INSTALL_MS);
    this.desktopTimer.unref?.();
    console.log("[piomio] asking the desktop app to install its update");
    (this.d.launch ?? launchApp)(this.d.config.desktopApp!, ["--install-update"]);
  }

  /** The desktop app could not install the update the button asked for (its `update-failed` line on the hub's stdin). */
  desktopFailed(why: string): void {
    const version = this.installingTo ?? this.offer?.version;
    this.desktopDone();
    if (version) this.failure = { version, why: why || "the desktop app gave no reason" };
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
    this.installingTo = undefined;
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
    this.installingTo = v;
    this.failure = undefined;
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
      this.installingTo = undefined;
      this.failure = { version: v, why: String(e?.message ?? e) };
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

/**
 * Why an Update can't be done. replicaOld: a hub replica from before replicas updated from the leader; noRelease: the
 * release of that version has nothing for that computer (yet).
 */
export type UpdateRefusal = "notInstalled" | "upToDate" | "unknown" | "offline" | "notSelf" | "noBundle" | "replicaOld" | "noRelease";

export class UpdateError extends Error {
  readonly reason: UpdateRefusal;
  readonly version?: string;
  constructor(reason: UpdateRefusal, version?: string) {
    super(reason);
    this.reason = reason;
    this.version = version;
  }
}
