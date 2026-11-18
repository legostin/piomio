// exec.run: shell commands inside allowed dirs, with an output cap and a timeout that kills the whole process tree.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesAny } from "@piomio/shared";
import { DEFAULT_MAX_TIMEOUT_MS, type Policy } from "./policy.ts";
import { resolveAllowedPath, type GuardOptions } from "./guard.ts";

export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 120_000;
const TIMEOUT_EXIT_CODE = 124;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class ExecDenied extends Error {
  code = "EXEC_DENIED";
}

/** With an allowlist, shell control characters would let one allowed command smuggle in another. */
const SHELL_META = /[;&|`$<>\r\n]|%[^%\s]+%|\^/;

/** Throws ExecDenied unless the policy allows this command. */
export function checkCommand(command: unknown, policy: Policy): string {
  if (!policy.exec.enabled) throw new ExecDenied("Running commands is not allowed on this machine (exec.enabled = false in policy.json)");
  if (typeof command !== "string" || !command.trim()) throw new ExecDenied("No command given");
  const cmd = command.trim();
  const allow = policy.exec.allowCommands ?? [];
  if (allow.length) {
    if (SHELL_META.test(cmd)) throw new ExecDenied("With exec.allowCommands set, ; & | ` $ < > ^ %VAR% and line breaks are not allowed");
    if (!matchesAny(cmd, allow)) throw new ExecDenied(`The command is not in exec.allowCommands: ${cmd}`);
  }
  return cmd;
}

/** Kill a child and everything it started. */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    k.on("error", () => child.kill());
  } else {
    try {
      process.kill(-child.pid, "SIGKILL"); // detached → the child leads its own process group
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
}

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("PIOMIO_")) out[k] = v;
  return { ...out, ...extra };
}

/** How many variables one command may be given, and how long a value may be. */
const MAX_ENV_VARS = 32;
const MAX_ENV_VALUE = 64 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The variables a command is given on top of this machine's own (the hub's vault_exec: secrets from its vault). Names
 * are plain identifiers and never the daemon's own (PIOMIO_*); values are strings. They are never logged.
 */
export function checkEnv(env: unknown): Record<string, string> {
  if (env === undefined || env === null) return {};
  if (typeof env !== "object" || Array.isArray(env)) throw new ExecDenied("env must be an object of names and string values");
  const entries = Object.entries(env as Record<string, unknown>);
  if (entries.length > MAX_ENV_VARS) throw new ExecDenied(`At most ${MAX_ENV_VARS} variables can be given to a command`);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!ENV_NAME.test(k) || k.toUpperCase().startsWith("PIOMIO_")) throw new ExecDenied(`Not a variable name a command can be given: ${k.slice(0, 80)}`);
    if (typeof v !== "string" || v.includes("\0") || v.length > MAX_ENV_VALUE) throw new ExecDenied(`The value of ${k} must be a string of at most ${MAX_ENV_VALUE} characters`);
    out[k] = v;
  }
  return out;
}

/** Answers git's question for a username or a password from the command's own variables, and nothing else. */
const ASKPASS = `#!/bin/sh
case "$1" in
  Username*) printf '%s\\n' "\${GIT_USERNAME:-x-access-token}" ;;
  *) printf '%s\\n' "$GIT_PASSWORD" ;;
esac
`;

/**
 * A command given GIT_PASSWORD (and GIT_USERNAME, "x-access-token" without it) has git over HTTPS sign in with it: git
 * asks a helper written for this one command, never a terminal, and the person's own credential helpers (the
 * keychain) are neither read nor handed the password to keep. Not on Windows, and not when the command names its own
 * GIT_ASKPASS. Returns what to add to the environment and how to clean up.
 */
export function gitAskpass(env: Record<string, string>, base: NodeJS.ProcessEnv = process.env): { env: Record<string, string>; cleanup: () => void } {
  if (process.platform === "win32" || env.GIT_PASSWORD === undefined || env.GIT_ASKPASS !== undefined) return { env: {}, cleanup: () => {} };
  const dir = mkdtempSync(join(tmpdir(), "piomio-askpass-"));
  const file = join(dir, "askpass.sh");
  writeFileSync(file, ASKPASS, { mode: 0o700 });
  // One more entry after the ones already in the environment: an empty credential.helper empties the list before it.
  const count = Number(env.GIT_CONFIG_COUNT ?? base.GIT_CONFIG_COUNT ?? 0);
  const n = Number.isInteger(count) && count >= 0 ? count : 0;
  return {
    env: { GIT_ASKPASS: file, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: "credential.helper", [`GIT_CONFIG_VALUE_${n}`]: "" },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Collects up to `max` bytes shared between stdout and stderr. */
class Capped {
  private used = 0;
  truncated = false;
  readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  take(chunk: Buffer, into: Buffer[]): void {
    if (this.used >= this.max) {
      this.truncated = true;
      return;
    }
    const room = this.max - this.used;
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (part.length < chunk.length) this.truncated = true;
    into.push(part);
    this.used += part.length;
  }
}

export interface RunOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  shell?: string;
  maxOutput?: number;
  /** Variables on top of this process's own (secrets from the hub's vault): never logged. */
  env?: Record<string, string>;
  /** Running children, so the daemon can kill them on disconnect/shutdown. */
  track?: Set<ChildProcess>;
}

export function runShell(o: RunOptions): Promise<ExecResult> {
  const win = process.platform === "win32";
  // cmd.exe prints in the OEM code page by default; switch the console to UTF-8 first.
  const command = win && !o.shell ? `chcp 65001>nul & ${o.command}` : o.command;
  const askpass = gitAskpass(o.env ?? {});
  const child = spawn(command, {
    cwd: o.cwd,
    env: childEnv({ ...o.env, ...askpass.env }),
    shell: o.shell ?? true,
    detached: !win,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  o.track?.add(child);
  const cap = new Capped(o.maxOutput ?? MAX_OUTPUT_BYTES);
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout!.on("data", (c: Buffer) => cap.take(c, out));
  child.stderr!.on("data", (c: Buffer) => cap.take(c, err));
  let timedOut = false;
  let spawnError: Error | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, o.timeoutMs);

  return new Promise<ExecResult>((resolvePromise) => {
    let done = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.track?.delete(child);
      askpass.cleanup();
      let stdout = Buffer.concat(out).toString("utf8");
      let stderr = Buffer.concat(err).toString("utf8");
      if (cap.truncated) stderr += `\n[piomio-node] output truncated to ${Math.round(cap.max / 1024)} KB`;
      let exit = code ?? (signal ? 128 + (signal === "SIGKILL" ? 9 : 15) : -1);
      if (timedOut) {
        exit = TIMEOUT_EXIT_CODE;
        stderr += `\n[piomio-node] timed out after ${Math.round(o.timeoutMs / 1000)} s, the process was stopped`;
      }
      if (spawnError) {
        exit = exit === 0 ? -1 : exit;
        stderr += `\n[piomio-node] could not start the command: ${spawnError.message}`;
      }
      resolvePromise({ code: exit, stdout, stderr: stderr.replace(/^\n/, "") });
    };
    child.on("error", (e) => {
      spawnError = e;
      finish(-1, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
    // A grandchild that escaped the kill may keep the pipes open: don't wait for it forever.
    child.on("exit", (code, signal) => {
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code, signal);
      }, 2000).unref();
    });
  });
}

/** exec.run handler body: policy + path checks, then run. */
export async function execRun(
  params: { command?: unknown; cwd?: unknown; timeoutMs?: unknown; env?: unknown },
  policy: Policy,
  guard: GuardOptions,
  track?: Set<ChildProcess>,
): Promise<ExecResult> {
  const command = checkCommand(params?.command, policy);
  const env = checkEnv(params?.env);
  const cwd = params?.cwd === undefined || params?.cwd === null || params?.cwd === "" ? resolveAllowedPath(".", policy.allowedDirs, guard) : resolveAllowedPath(params.cwd, policy.allowedDirs, guard);
  let isDir = false;
  try {
    isDir = statSync(cwd).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new ExecDenied(`The working folder does not exist or is not a folder: ${String(params?.cwd ?? cwd)}`);
  const max = policy.exec.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const requested = Number(params?.timeoutMs);
  const timeoutMs = Math.min(Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_TIMEOUT_MS, max);
  return runShell({ command, cwd, timeoutMs, shell: policy.exec.shell, track, ...(Object.keys(env).length ? { env } : {}) });
}
