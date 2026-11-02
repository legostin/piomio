// Where the user's own command-line tools live. A hub started by launchd, a tray app or a service gets a short PATH, so
// Claude Code or Codex installed with npm, nvm or Homebrew looks "not installed". The PATH of the user's login shell
// (macOS, Linux) or of their account in the registry (Windows) says where they are; brain hosts get those directories
// after their own PATH. Never used under user isolation, where the CLIs come with the image.

import { execFile } from "node:child_process";

export const PATH_MARK = "__PIOMIO_PATH__";
const SHELL_TIMEOUT_MS = 5000;

/** Runs a command and resolves with its stdout; rejects when it fails or takes longer than `timeoutMs`. */
export type Run = (file: string, args: string[], timeoutMs: number) => Promise<string>;

export interface UserPathOptions {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  run: Run;
}

/** The PATH the shell printed after the mark; banners and greetings around it are ignored. */
export function parseShellPath(out: string): string[] | undefined {
  const line = out.split(/\r?\n/).find((l) => l.startsWith(PATH_MARK));
  return line === undefined ? undefined : line.slice(PATH_MARK.length).split(":");
}

/** The value of `Path` in `reg query <key> /v Path` output. */
export function parseRegPath(out: string): string | undefined {
  return /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/im.exec(out)?.[1];
}

/** `%VAR%` from `env` (names are case-insensitive on Windows); unknown ones stay as they are. */
export function expandWinVars(s: string, env: Record<string, string | undefined>): string {
  const byName = new Map(Object.entries(env).map(([k, v]) => [k.toUpperCase(), v]));
  return s.replace(/%([^%]+)%/g, (whole, name: string) => byName.get(name.toUpperCase()) ?? whole);
}

/** `extra` without empty entries, duplicates and what `current` already has (case-insensitive with ";"). */
export function mergeDirs(current: string | undefined, extra: string[], sep: string): string[] {
  const norm = (d: string) => (sep === ";" ? d.toLowerCase() : d);
  const seen = new Set((current ?? "").split(sep).filter(Boolean).map(norm));
  const out: string[] = [];
  for (const d of extra) {
    if (!d || seen.has(norm(d))) continue;
    seen.add(norm(d));
    out.push(d);
  }
  return out;
}

const pathOf = (env: Record<string, string | undefined>) => Object.entries(env).find(([k]) => k.toUpperCase() === "PATH")?.[1];

/** Directories of the user's PATH the hub's own PATH lacks; empty when they cannot be read. */
export async function readUserPath(o: UserPathOptions): Promise<string[]> {
  try {
    if (o.platform === "win32") {
      const keys = ["HKCU\\Environment", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"];
      const values = await Promise.all(keys.map((k) => o.run("reg", ["query", k, "/v", "Path"], SHELL_TIMEOUT_MS).then(parseRegPath, () => undefined)));
      const dirs = values.flatMap((v) => (v ? expandWinVars(v, o.env).split(";") : []));
      return mergeDirs(pathOf(o.env), dirs, ";");
    }
    // A login, interactive shell reads the files where nvm, Homebrew and npm add their directories.
    const shell = o.env.SHELL || (o.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
    const out = await o.run(shell, ["-l", "-i", "-c", `printf '\\n${PATH_MARK}%s\\n' "$PATH"`], SHELL_TIMEOUT_MS);
    return mergeDirs(pathOf(o.env), parseShellPath(out) ?? [], ":");
  } catch {
    return [];
  }
}

const runCommand: Run = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: timeoutMs, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    // An interactive shell must not wait for input.
    child.stdin?.end();
  });

export class UserPath {
  private o: UserPathOptions;
  private current: string[] = [];

  constructor(o: Partial<UserPathOptions> = {}) {
    this.o = { platform: process.platform, env: process.env, run: runCommand, ...o };
  }

  /** The directories found by the last refresh. */
  dirs(): string[] {
    return this.current;
  }

  /** Reads the user's PATH again; true when the directories changed. */
  async refresh(): Promise<boolean> {
    const next = await readUserPath(this.o);
    const changed = next.join("\n") !== this.current.join("\n");
    this.current = next;
    return changed;
  }
}
