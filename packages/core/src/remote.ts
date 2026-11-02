// Access from anywhere: the hub's own Tailscale node (packages/tailnet, piomio-tailnet) and the permanent Funnel link
// it serves. The node is a child process speaking JSON lines: the hub sends where it keeps its keys and where to
// proxy, the node reports sign-in, Funnel and the link. Funnel traffic reaches the hub only through two loopback
// gateways (server/main-app.ts and server/device-app.ts in remote mode), never the computer's own ports. A link the
// node reports is shown only once it answers from the internet: Tailscale issues its certificate on the first visit.

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Locale, RemoteState, RemoteView, Translate } from "@piomio/shared";
import type { Config } from "./config.ts";
import type { EventBus } from "./bus.ts";
import type { DeviceTls } from "./devices-tls.ts";
import { hubLocale, LocalizedError, tFor } from "./i18n.ts";

/** The hub's loopback entrances for the node's proxies; idempotent while running. */
export interface RemoteGateways {
  start(): Promise<{ web: number; device: number }>;
  stop(): Promise<void>;
}

interface NodeState {
  state: RemoteState;
  url?: string;
  deviceUrl?: string;
  authUrl?: string;
  enableUrl?: string;
  account?: string;
  keyExpiry?: string;
  message?: string;
}

const RESTART_FIRST_MS = 2000;
const RESTART_MAX_MS = 60_000;
const STOP_GRACE_MS = 5000;
const LOGOUT_WAIT_MS = 20_000;
const LINK_CHECK_EVERY_MS = 3000;
const LINK_CHECK_TIMEOUT_MS = 20_000;
/** A link that still does not answer after this is shown anyway: it may work from elsewhere. */
const LINK_CHECK_MAX_MS = 3 * 60_000;

/** The link answers at all: its name resolves, Funnel reaches the node and the node has its certificate. */
async function linkAnswers(url: string): Promise<boolean> {
  try {
    await fetch(new URL("/api/auth/state", url), { redirect: "manual", signal: AbortSignal.timeout(LINK_CHECK_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

/** Where a server's hub keeps its link's state for install.sh and `piomio link`. */
export function remoteStatusFile(dataDir: string): string {
  return join(dataDir, "remote.json");
}

/** The link's state as the hub last wrote it (RemoteAccess.writeStatus). */
export type RemoteStatus = Partial<Pick<RemoteView, "available" | "enabled" | "state" | "authUrl" | "enableUrl" | "url">>;

export function readRemoteStatus(file: string): RemoteStatus | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RemoteStatus;
  } catch {
    return undefined;
  }
}

const LINK_WAIT_MS = 15 * 60_000;
const LINK_SETTLE_MS = 30_000;

/**
 * `piomio link` (install.sh runs it): Tailscale's sign-in and Funnel pages as the hub reports them, then the link, with
 * the setup code in its fragment until the first password. Without `wait` it stops at the first page. True once the
 * link is printed.
 */
export async function printLink(o: {
  file: string;
  setupCode?: string;
  wait: boolean;
  t: Translate;
  print: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<boolean> {
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const end = now() + (o.wait ? LINK_WAIT_MS : LINK_SETTLE_MS);
  let shown: string | undefined;
  while (now() < end) {
    const s = readRemoteStatus(o.file);
    if (s && (!s.available || !s.enabled)) {
      o.print(o.t("cli.linkOff"));
      return false;
    }
    if (s?.state === "running" && s.url) {
      o.print(o.t("cli.link", { url: o.setupCode ? `${s.url}/#setup=${o.setupCode}` : s.url }));
      return true;
    }
    const page = s?.state === "needs-login" ? s.authUrl : s?.state === "needs-funnel" ? s.enableUrl : undefined;
    if (page && page !== shown) {
      o.print(o.t(s?.state === "needs-login" ? "cli.linkLogin" : "cli.linkFunnel", { url: page }));
      if (!o.wait) break;
      if (!shown) o.print(o.t("cli.linkWaiting"));
      shown = page;
    }
    await sleep(1000);
  }
  o.print(o.t("cli.linkLater"));
  return false;
}

/** The node program for this computer, when it is in the build and can run. */
export function tailnetBinary(cfg: Pick<Config, "tailnetBin">): string | undefined {
  try {
    accessSync(cfg.tailnetBin, constants.X_OK);
    return cfg.tailnetBin;
  } catch {
    return undefined;
  }
}

export class RemoteAccess {
  private cfg: Config;
  private settings: { get(): { remoteAccess: boolean }; update(p: { remoteAccess: boolean }): unknown };
  private bus: EventBus;
  private deviceTls: () => DeviceTls;
  private gateways: RemoteGateways;
  private hasPassword: () => boolean;
  private checkLink: (url: string) => Promise<boolean>;
  private statusFile?: string;

  private child?: ChildProcess;
  private node: NodeState = { state: "off" };
  /** The link that answered (or was waited for long enough): only then is it shown. */
  private ready?: string;
  private checking?: string;
  private checkTimer?: NodeJS.Timeout;
  private lastStderr = "";
  private restartDelay = RESTART_FIRST_MS;
  private restartTimer?: NodeJS.Timeout;
  /** Exits the hub asked for (stop, disable, forget) are not crashes. */
  private stopping = false;
  private ops: Promise<unknown> = Promise.resolve();

  constructor(d: {
    config: Config;
    settings: { get(): { remoteAccess: boolean }; update(p: { remoteAccess: boolean }): unknown };
    bus: EventBus;
    deviceTls: () => DeviceTls;
    gateways: RemoteGateways;
    hasPassword: () => boolean;
    /** Whether the link answers; tests have no internet. */
    checkLink?: (url: string) => Promise<boolean>;
    /** Where install.sh reads the sign-in page and the link (server installs). */
    statusFile?: string;
  }) {
    this.cfg = d.config;
    this.settings = d.settings;
    this.bus = d.bus;
    this.deviceTls = d.deviceTls;
    this.gateways = d.gateways;
    this.hasPassword = d.hasPassword;
    this.checkLink = d.checkLink ?? linkAnswers;
    this.statusFile = d.statusFile;
  }

  private get dir(): string {
    return join(this.cfg.dataDir, "tailnet");
  }

  view(locale: Locale = hubLocale()): RemoteView {
    const t = tFor(locale);
    const available = !!tailnetBinary(this.cfg);
    const enabled = this.settings.get().remoteAccess;
    if (!available) return { available, enabled, state: "off", error: t("remote.unavailable", { path: this.cfg.tailnetBin }) };
    if (!enabled) return { available, enabled, state: "off" };
    if (this.node.state === "running" && !this.linkReady()) return { available, enabled, state: "starting", preparing: true };
    const { message, ...rest } = this.node;
    const view: RemoteView = { available, enabled, ...rest };
    if (rest.state === "error") view.error = t("remote.error", { message: message || "?" });
    else if (rest.state === "needs-login" && message === "machine-auth") view.error = t("remote.machineAuth");
    return view;
  }

  /** The link's host while the node serves it: the remote gateway accepts only this Host. */
  linkHost(): string | undefined {
    if (this.node.state !== "running" || !this.node.url) return undefined;
    try {
      return new URL(this.node.url).host;
    } catch {
      return undefined;
    }
  }

  /** The link itself, while it is up. */
  link(): string | undefined {
    return this.linkReady() ? this.node.url : undefined;
  }

  /** The phones' address behind the link, while it is up. */
  deviceLink(): string | undefined {
    return this.linkReady() ? this.node.deviceUrl : undefined;
  }

  private linkReady(): boolean {
    return this.node.state === "running" && !!this.node.url && this.ready === this.node.url;
  }

  /** Hub start: an enabled hub brings its link back. */
  start(): Promise<void> {
    return this.serial(async () => {
      this.writeStatus();
      if (this.settings.get().remoteAccess && tailnetBinary(this.cfg)) await this.spawnNode();
    });
  }

  enable(): Promise<RemoteView> {
    return this.serial(async () => {
      if (!tailnetBinary(this.cfg)) throw new LocalizedError("remote.unavailable", { path: this.cfg.tailnetBin }, 409);
      if (!this.hasPassword()) throw new LocalizedError("auth.noPassword", undefined, 409);
      this.settings.update({ remoteAccess: true });
      await this.spawnNode();
      this.emit();
      return this.view();
    });
  }

  disable(): Promise<RemoteView> {
    return this.serial(async () => {
      this.settings.update({ remoteAccess: false });
      await this.stopNode();
      await this.gateways.stop();
      this.node = { state: "off" };
      this.emit();
      return this.view();
    });
  }

  /** Signs the node out of Tailscale (when it runs) and deletes its keys: the next start is a new node. */
  forget(): Promise<RemoteView> {
    return this.serial(async () => {
      this.settings.update({ remoteAccess: false });
      const child = this.child;
      if (child?.stdin?.writable) {
        this.stopping = true;
        this.clearRestart();
        const exited = waitExit(child, LOGOUT_WAIT_MS);
        child.stdin.write(JSON.stringify({ type: "logout" }) + "\n");
        if (!(await exited)) child.kill("SIGKILL");
      }
      await this.stopNode();
      await this.gateways.stop();
      rmSync(this.dir, { recursive: true, force: true });
      this.node = { state: "off" };
      this.emit();
      return this.view();
    });
  }

  /** Hub stop: the node goes down, the switch stays as it is. */
  stop(): Promise<void> {
    return this.serial(async () => {
      await this.stopNode();
      await this.gateways.stop();
      this.node = { state: "off" };
    });
  }

  // ---------- the node process ----------

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.ops.then(fn, fn);
    this.ops = next.catch(() => {});
    return next;
  }

  private emit(): void {
    this.bus.emit("remote.updated", this.view());
    this.writeStatus();
  }

  /** What install.sh prints: the sign-in page, the Funnel page or the link (packaging/linux/install.sh). */
  private writeStatus(): void {
    if (!this.statusFile) return;
    const { available, enabled, state, authUrl, enableUrl, url } = this.view();
    try {
      writeFileSync(this.statusFile, JSON.stringify({ available, enabled, state, authUrl, enableUrl, url }) + "\n", { mode: 0o600 });
    } catch (e) {
      console.error(`[tailnet] could not write ${this.statusFile}: ${(e as Error).message}`);
    }
  }

  /** Asks the link until it answers, then shows it. */
  private waitForLink(url: string): void {
    if (this.checking === url) return;
    this.stopLinkCheck();
    this.checking = url;
    const since = Date.now();
    const attempt = async () => {
      this.checkTimer = undefined;
      const answered = await this.checkLink(url).catch(() => false);
      if (this.checking !== url) return;
      if (answered || Date.now() - since >= LINK_CHECK_MAX_MS) {
        this.checking = undefined;
        this.ready = url;
        this.emit();
        return;
      }
      this.checkTimer = setTimeout(() => void attempt(), LINK_CHECK_EVERY_MS);
      this.checkTimer.unref();
    };
    void attempt();
  }

  private stopLinkCheck(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = undefined;
    this.checking = undefined;
  }

  private async spawnNode(): Promise<void> {
    if (this.child) return;
    this.clearRestart();
    const bin = tailnetBinary(this.cfg);
    if (!bin) return;
    let ports: { web: number; device: number };
    try {
      ports = await this.gateways.start();
    } catch (e) {
      this.node = { state: "error", message: (e as Error).message };
      this.emit();
      return;
    }
    const tls = this.deviceTls();
    // A small environment: the node needs none of the hub's settings, and Tailscale gets no logs from it.
    const env: NodeJS.ProcessEnv = { TS_NO_LOGS_NO_SUPPORT: "true" };
    for (const k of ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "SystemRoot", "LOCALAPPDATA", "APPDATA"]) if (process.env[k]) env[k] = process.env[k];
    const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], env, windowsHide: true });
    this.child = child;
    this.stopping = false;
    this.lastStderr = "";
    this.node = { state: "starting" };

    createInterface({ input: child.stdout! }).on("line", (line) => this.onLine(line));
    createInterface({ input: child.stderr! }).on("line", (line) => {
      if (!line.trim()) return;
      this.lastStderr = line.trim();
      console.log(`[tailnet] ${line}`);
    });
    child.on("error", (e) => {
      this.lastStderr = e.message;
    });
    child.on("exit", (code) => this.onExit(child, code));
    child.stdin!.on("error", () => {});
    child.stdin!.write(
      JSON.stringify({
        type: "start",
        dir: this.dir,
        hostname: this.cfg.tailnetHostname,
        web: `127.0.0.1:${ports.web}`,
        device: `127.0.0.1:${ports.device}`,
        deviceCert: tls.cert,
        deviceKey: tls.key,
      }) + "\n",
    );
  }

  private onLine(line: string): void {
    let msg: { type?: string } & Partial<NodeState>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type !== "state" || typeof msg.state !== "string") return;
    const next: NodeState = { state: msg.state as RemoteState };
    for (const k of ["url", "deviceUrl", "authUrl", "enableUrl", "account", "keyExpiry", "message"] as const) if (typeof msg[k] === "string" && msg[k]) next[k] = msg[k];
    if (next.state === "running") this.restartDelay = RESTART_FIRST_MS;
    this.node = next;
    if (next.state === "running" && next.url && this.ready !== next.url) this.waitForLink(next.url);
    else if (next.state !== "running") this.stopLinkCheck();
    this.emit();
  }

  private onExit(child: ChildProcess, code: number | null): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.stopLinkCheck();
    if (this.stopping || !this.settings.get().remoteAccess) return;
    // An unexpected exit: say why and try again, waiting longer each time.
    this.node = { state: "error", message: this.lastStderr || `exit ${code}` };
    this.emit();
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, RESTART_MAX_MS);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.serial(async () => {
        if (this.settings.get().remoteAccess && !this.child) {
          await this.spawnNode();
          this.emit();
        }
      });
    }, delay);
    this.restartTimer.unref();
  }

  private clearRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }

  /** Closing stdin stops the node; one that does not exit in time is killed. */
  private async stopNode(): Promise<void> {
    this.clearRestart();
    this.stopLinkCheck();
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const exited = waitExit(child, STOP_GRACE_MS);
    child.stdin?.end();
    if (!(await exited)) child.kill("SIGKILL");
    await waitExit(child, STOP_GRACE_MS);
    if (this.child === child) this.child = undefined;
  }
}

function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
