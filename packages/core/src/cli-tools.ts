// Command-line tools the hub runs without relying on the system's: npm (plugin installs) and, where they are missing,
// the Claude Code, Codex and Kimi Code CLIs. The desktop installers ship Node with no npm on the PATH, so npm is the
// npm-cli.js that came with the hub's own Node. A missing brain CLI is installed from its official npm package into
// <data>/tools when the user signs it in from the chat; its native binary goes on the PATH of the plugin hosting that
// brain, after the system PATH, so a CLI the user installed themselves wins (Kimi Code is a Node script: its npm link
// in node_modules/.bin, which the brain runs with the hub's own Node). Under user isolation (the Docker image) the CLIs
// are part of the image and run as another user, so the hub never installs them there.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export interface NpmInvocation {
  file: string;
  args: string[];
  shell: boolean;
}

/** npm-cli.js next to a Node binary: `<dir>/node_modules/npm` (Windows zip) or `<dir>/../lib/node_modules/npm` (tarballs). */
export function bundledNpmCli(execPath = process.execPath): string | undefined {
  const dir = dirname(execPath);
  const candidates = [join(dir, "node_modules", "npm", "bin", "npm-cli.js"), join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  return candidates.find((c) => existsSync(c));
}

/** How to run `npm <args>`: the hub's own npm when it has one, else `npm` from the PATH. */
export function npmInvocation(args: string[], execPath = process.execPath): NpmInvocation {
  const cli = bundledNpmCli(execPath);
  if (cli) return { file: execPath, args: [cli, ...args], shell: false };
  return process.platform === "win32" ? { file: "npm.cmd", args, shell: true } : { file: "npm", args, shell: false };
}

/** The variable that holds the PATH (Windows spells it "Path"). */
export function pathKey(env: Record<string, string | undefined>): string {
  return Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
}

/** A copy of `env` with directories put before and after its PATH. */
export function withPath(env: Record<string, string | undefined>, before: string[], after: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  const key = pathKey(out);
  out[key] = [...before, ...(out[key] ? [out[key]] : []), ...after].join(delimiter);
  return out;
}

/** The environment npm runs with: this Node first on the PATH (lifecycle scripts call `node`), no hub settings. */
export function npmEnv(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !k.startsWith("PIOMIO_")) clean[k] = v;
  return { ...withPath(clean, [dirname(execPath)]), npm_config_update_notifier: "false", npm_config_fund: "false" };
}

export interface CliTool {
  /** The brain this CLI powers, as its plugin names it. */
  brainId: string;
  label: string;
  pkg: string;
  /** Directories under `<tools>/node_modules` that hold the native binary for this platform. */
  dirs: string[];
}

const CODEX_TRIPLES: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};

function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return !!report && report.header?.glibcVersionRuntime === undefined;
}

/**
 * Where the official packages put their native binaries. Both pull the binary in as a per-platform optional
 * dependency, so installing with --ignore-scripts still brings it; the binaries are run straight from there.
 */
export function cliToolSpecs(platform: string = process.platform, arch: string = process.arch, musl = isMusl()): CliTool[] {
  const plat = `${platform}-${arch}`;
  const tools: CliTool[] = [{ brainId: "claude-code", label: "Claude Code", pkg: "@anthropic-ai/claude-code", dirs: [`@anthropic-ai/claude-code-${plat}${musl ? "-musl" : ""}`] }];
  const triple = CODEX_TRIPLES[plat];
  if (triple) tools.push({ brainId: "codex", label: "Codex", pkg: "@openai/codex", dirs: [`@openai/codex-${plat}/vendor/${triple}/bin`, `@openai/codex-${plat}/vendor/${triple}/codex-path`] });
  tools.push({ brainId: "kimi", label: "Kimi Code", pkg: "@moonshot-ai/kimi-code", dirs: [".bin"] });
  return tools;
}

/** One install is stopped after this long (a stalled download). */
const INSTALL_MAX_MS = 20 * 60_000;

export class CliTools {
  readonly dir: string;
  readonly enabled: boolean;
  private specs: CliTool[];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, enabled: boolean, specs: CliTool[] = cliToolSpecs()) {
    this.dir = join(dataDir, "tools");
    this.enabled = enabled;
    this.specs = specs;
  }

  forBrain(brainId: string): CliTool | undefined {
    return this.enabled ? this.specs.find((s) => s.brainId === brainId) : undefined;
  }

  /** Every directory a managed binary can live in, present or not yet (PATH lookups happen at each spawn). */
  binDirs(): string[] {
    return this.enabled ? this.specs.flatMap((s) => s.dirs.map((d) => join(this.dir, "node_modules", d))) : [];
  }

  /** `npm install <pkg>@latest` into <data>/tools. Installs run one at a time: they share one package.json. */
  install(tool: CliTool, opts: { signal?: AbortSignal; npm?: (args: string[]) => NpmInvocation } = {}): Promise<void> {
    const run = this.queue.then(() => this.runInstall(tool, opts));
    this.queue = run.catch(() => {});
    return run;
  }

  private runInstall(tool: CliTool, opts: { signal?: AbortSignal; npm?: (args: string[]) => NpmInvocation }): Promise<void> {
    if (opts.signal?.aborted) return Promise.reject(new Error("cancelled"));
    mkdirSync(this.dir, { recursive: true });
    // Saved as a dependency: npm prunes what package.json does not list, so a second CLI keeps the first.
    const manifest = join(this.dir, "package.json");
    if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ name: "piomio-tools", private: true }, null, 2) + "\n");
    const args = ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", "--loglevel=error", `${tool.pkg}@latest`];
    const npm = (opts.npm ?? npmInvocation)(args);
    return new Promise((resolve, reject) => {
      const child = spawn(npm.file, npm.args, { cwd: this.dir, env: npmEnv(), shell: npm.shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let tail = "";
      const keep = (c: Buffer) => {
        tail = (tail + c.toString("utf8")).slice(-4000);
      };
      child.stdout!.on("data", keep);
      child.stderr!.on("data", keep);
      const stop = () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      };
      const timer = setTimeout(stop, INSTALL_MAX_MS);
      timer.unref?.();
      opts.signal?.addEventListener("abort", stop, { once: true });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`could not start npm: ${e.message}`));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", stop);
        if (opts.signal?.aborted) return reject(new Error("cancelled"));
        if (code === 0) return resolve();
        const last = tail.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ").slice(0, 400);
        reject(new Error(last || (signal ? `npm was stopped (${signal})` : `npm exited with code ${code}`)));
      });
    });
  }
}
