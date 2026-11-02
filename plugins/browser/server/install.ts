// Playwright's Chromium on demand: where neither Google Chrome nor Chromium is there, the plugin downloads it itself
// with Playwright's own CLI the first time it is missing, and browser calls wait for that one install.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { PluginLogger } from "@piomio/plugin-sdk";
import { cut, ToolError } from "./util.ts";

/** How long a browser call waits for a running install before it gives up (the install itself goes on). */
export const INSTALL_WAIT_MS = 5 * 60_000;
/** One install is killed after this long (a stalled download). */
export const INSTALL_MAX_MS = 30 * 60_000;

const PROXY_HINT =
  "The download goes through the hub's egress proxy: the browser plugin must be allowed to reach cdn.playwright.dev " +
  "and playwright.download.prss.microsoft.com.";
const MANUAL_HINT = "To install it by hand, run on the server: npx playwright install chromium";

export interface InstallProcess {
  /** Resolves when the installer exits with code 0; rejects with the reason otherwise. */
  done: Promise<void>;
  kill(): void;
}

export interface InstallerDeps {
  /** Files the launch needs that may be missing (none when Google Chrome is used). */
  executables(): string[];
  exists(path: string): boolean;
  /** Start `playwright install chromium`; every output line goes to `onLine`. */
  spawn(onLine: (line: string) => void): InstallProcess;
  log: Pick<PluginLogger, "info" | "warn">;
  /** Automatic install is turned off (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD): only report the missing browser. */
  disabled?: boolean;
  maxInstallMs?: number;
  /** The install state changed (started, progress, finished, failed). */
  onChange?(): void;
}

export interface InstallStatus {
  installing: boolean;
  /** What is downloading now, e.g. "Chrome Headless Shell 156.0.8078.4". */
  step: string | null;
  /** Download progress of the current step, 0–100. */
  progress: number | null;
  /** Why the last install failed (cleared when a new one starts). */
  error: string | null;
}

/** Truthy PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD turns the automatic install off, as it does for `npm install`. */
export function autoInstallDisabled(env: NodeJS.ProcessEnv): boolean {
  const v = (env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

/** One Playwright error line ("Executable doesn't exist at …") means the browser files are missing. */
export function isMissingExecutableError(message: string): boolean {
  return /Executable doesn't exist|browserType\.launch.*install/i.test(message);
}

/** The most telling line of the installer's output: the first error that is not a stack frame. */
export function errorLine(lines: string[]): string | null {
  const found = lines.map((l) => l.trim()).find((l) => /error|fail|denied|refused|not allowed|ENOTFOUND|ECONN|EACCES|EPERM|ETIMEDOUT/i.test(l) && !/^at\s/.test(l));
  return found ? cut(found, 300) : null;
}

export class ChromiumInstaller {
  private readonly deps: InstallerDeps;
  private current: Promise<void> | null = null;
  private proc: InstallProcess | null = null;
  private output: string[] = [];
  private step: string | null = null;
  private progress: number | null = null;
  private error: string | null = null;

  constructor(deps: InstallerDeps) {
    this.deps = deps;
  }

  get installing(): boolean {
    return this.current !== null;
  }

  get disabled(): boolean {
    return !!this.deps.disabled;
  }

  status(): InstallStatus {
    return { installing: this.installing, step: this.step, progress: this.progress, error: this.error };
  }

  /** Executables the launch needs that are not on disk. Unknown paths count as present: the launch will tell. */
  missing(): string[] {
    let paths: string[];
    try {
      paths = this.deps.executables();
    } catch (e: any) {
      this.deps.log.warn(`cannot locate Playwright's Chromium: ${e?.message ?? e}`);
      return [];
    }
    return paths.filter((p) => !this.deps.exists(p));
  }

  /** On plugin start: when Chromium is missing, install it in the background. True if an install is running. */
  check(): boolean {
    if (this.current) return true;
    const missing = this.missing();
    if (!missing.length) return false;
    if (this.deps.disabled) {
      this.deps.log.warn(`Chromium is not installed (${missing.join(", ")}) and PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD turns the automatic install off. ${MANUAL_HINT}`);
      return false;
    }
    void this.install(missing).catch(() => {});
    return true;
  }

  /**
   * Start an install, or join the one already running: there is only ever one. `force` runs the installer even when
   * every known file is present (Playwright reported a missing executable anyway).
   */
  install(missing = this.missing(), force = false): Promise<void> {
    if (this.current) return this.current;
    if (!missing.length && !force) return Promise.resolve();
    this.error = null;
    this.step = null;
    this.progress = null;
    this.output = [];
    const what = missing.length ? missing.join(", ") : "a browser executable Playwright asked for";
    this.deps.log.info(`Chromium is missing (${what}): installing it with "playwright install chromium" (a one-time download)`);
    const job = this.run().then(
      () => {
        this.current = null;
        this.step = null;
        this.progress = null;
        this.deps.log.info("Chromium is installed");
        this.deps.onChange?.();
      },
      (e: any) => {
        this.current = null;
        this.step = null;
        this.progress = null;
        this.error = String(e?.message ?? e);
        this.deps.log.warn(`could not install Chromium: ${this.error}`);
        this.deps.onChange?.();
        throw e;
      },
    );
    job.catch(() => {});
    this.current = job;
    this.deps.onChange?.();
    return job;
  }

  private async run(): Promise<void> {
    const proc = this.deps.spawn((line) => this.onLine(line));
    this.proc = proc;
    let timer: NodeJS.Timeout | undefined;
    const limit = this.deps.maxInstallMs ?? INSTALL_MAX_MS;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`the download took longer than ${Math.round(limit / 60_000)} min and was stopped`));
        proc.kill();
      }, limit);
      timer.unref?.();
    });
    try {
      await Promise.race([proc.done, timedOut]);
    } catch (e: any) {
      const detail = errorLine(this.output);
      const reason = String(e?.message ?? e);
      throw new Error(detail && !reason.includes(detail) ? `${reason}: ${detail}` : reason);
    } finally {
      clearTimeout(timer);
      this.proc = null;
    }
    const still = this.missing();
    if (still.length) throw new Error(`the installer finished, but these files are still missing: ${still.join(", ")}`);
  }

  private onLine(raw: string): void {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!line) return;
    this.output.push(line);
    if (this.output.length > 200) this.output.shift();
    // "Downloading Chrome Headless Shell 156.0.8078.4 (playwright chromium-headless-shell v1248) from https://…"
    const started = /^Downloading (.+?)(?: \(playwright [^)]*\))?(?: from \S+)?$/.exec(line);
    // "|■■■■■■■■                | 10% of 113.4 MiB" (Playwright's progress when the output is not a terminal)
    const pct = /(\d{1,3})% of /.exec(line);
    if (started) {
      this.step = started[1];
      this.progress = 0;
      this.deps.onChange?.();
    } else if (pct) {
      this.progress = Math.min(100, Number(pct[1]));
      this.deps.onChange?.();
    }
    if (!/^at\s/.test(line)) this.deps.log.info(`playwright install: ${cut(line, 300)}`);
  }

  /**
   * Before a launch: returns once Chromium is on disk, installing it first if needed and waiting up to `waitMs`
   * (the install goes on after a timeout; the next call joins it). Throws a ToolError: an English message for the
   * model, `code` + `params` for the browser pane (ui.error.<code>).
   */
  async ensure(waitMs = INSTALL_WAIT_MS, force = false): Promise<void> {
    if (!this.current && !force && !this.missing().length) return;
    if (!this.current && this.deps.disabled) {
      throw new ToolError(
        `Chromium is not installed, and the automatic install is turned off (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD). ${MANUAL_HINT}`,
        "noChromium",
      );
    }
    const job = this.install(this.missing(), force);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), waitMs);
    });
    try {
      const r = await Promise.race([job.then(() => "done" as const), timeout]);
      if (r === "timeout") {
        const where = this.step ? ` (downloading ${this.step}${this.progress !== null ? `: ${this.progress}%` : ""})` : "";
        throw new ToolError(
          `Chromium is still being installed${where}. This is a one-time download; call the browser tool again in a minute.`,
          "installing",
        );
      }
    } catch (e: any) {
      if (e instanceof ToolError) throw e;
      const detail = String(e?.message ?? e);
      throw new ToolError(
        `Could not install Chromium: ${detail}. ${PROXY_HINT} The next browser call tries the install again. ${MANUAL_HINT}`,
        "installFailed",
        { detail },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Plugin stop: a half-done install is cleaned up and redone by Playwright next time. */
  dispose(): void {
    this.proc?.kill();
  }
}

// ---------- Playwright specifics ----------

function playwrightPackageJson(): string {
  return createRequire(import.meta.url).resolve("playwright/package.json");
}

/** Playwright's CLI from node_modules (npx may not be on PATH), run with this Node. */
export function playwrightCli(): string {
  try {
    return join(dirname(playwrightPackageJson()), "cli.js");
  } catch {
    return join(dirname(createRequire(import.meta.url).resolve("playwright-core/package.json")), "cli.js");
  }
}

/**
 * `node <playwright>/cli.js install chromium` into Playwright's default location (PLAYWRIGHT_BROWSERS_PATH when set).
 * The child inherits this process's environment, so the download goes through the hub's egress proxy with the
 * plugin's token (HTTP(S)_PROXY), and lands where the launch looks for it.
 */
export function spawnPlaywrightInstall(onLine: (line: string) => void): InstallProcess {
  const child = spawn(process.execPath, [playwrightCli(), "install", "chromium"], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  for (const stream of [child.stdout, child.stderr]) {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split(/\r?\n|\r/);
      buf = lines.pop() ?? "";
      for (const l of lines) onLine(l);
    });
    stream.on("end", () => {
      if (buf) onLine(buf);
      buf = "";
    });
  }
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", (e) => reject(new Error(`could not start the Playwright installer: ${e.message}`)));
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(signal ? `the Playwright installer was stopped (${signal})` : `the Playwright installer exited with code ${code}`));
    });
  });
  return {
    done,
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

/** The installer wired to Playwright and this process. */
export function createChromiumInstaller(opts: {
  /** Files the launch needs: Playwright's full Chromium (the headless shell is never used). */
  executables: () => string[];
  log: Pick<PluginLogger, "info" | "warn">;
  onChange?: () => void;
}): ChromiumInstaller {
  return new ChromiumInstaller({
    executables: opts.executables,
    exists: existsSync,
    spawn: spawnPlaywrightInstall,
    log: opts.log,
    disabled: autoInstallDisabled(process.env),
    onChange: opts.onChange,
  });
}
