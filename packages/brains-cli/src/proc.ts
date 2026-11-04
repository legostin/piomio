// Process helpers shared by CLI brain adapters.

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/** Async queue turning push-style callbacks into an async iterator. */
export class EventQueue<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.ended) return;
      const r = await new Promise<IteratorResult<T>>((res) => this.waiters.push(res));
      if (r.done) return;
      yield r.value;
    }
  }
}

/** The dialogs' processes waiting for their next turn: at most `max`, the one waiting longest closes first. */
export class WarmPool<T extends { release(): void }> {
  private waiting: T[] = [];
  private max: number;

  constructor(max: number) {
    this.max = max;
  }

  rest(s: T): void {
    this.take(s);
    this.waiting.push(s);
    while (this.waiting.length > this.max) this.waiting.shift()!.release();
  }

  take(s: T): void {
    const i = this.waiting.indexOf(s);
    if (i >= 0) this.waiting.splice(i, 1);
  }
}

export interface RunningProcess {
  child: ChildProcess;
  lines: AsyncIterable<string>;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: string | null }>;
  /** With `keepInput`: write more to stdin (false once it is closed) and close it. */
  write(text: string): boolean;
  endInput(): void;
}

/** Script paths (fake CLIs in tests, wrappers) run through the current Node binary. */
export function resolveCommand(command: string, args: string[]): [string, string[]] {
  return /\.(m?js|ts)$/.test(command) ? [process.execPath, ["--disable-warning=ExperimentalWarning", command, ...args]] : [command, args];
}

/** Spawn a CLI and expose stdout as lines; stdin receives `input` and is closed, or stays open with `keepInput`. */
export function runLines(command: string, args: string[], opts: { cwd?: string; env: Record<string, string>; input?: string; keepInput?: boolean }): RunningProcess {
  const [file, argv] = resolveCommand(command, args);
  const child = spawn(file, argv, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let err = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (c: string) => {
    err += c;
    if (err.length > 20_000) err = err.slice(-20_000);
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("error", (e) => {
      err += `\n${e.message}`;
      resolve({ code: -1, signal: null });
    });
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  const stdin = child.stdin!;
  stdin.on("error", () => {});
  if (opts.keepInput) {
    if (opts.input !== undefined) stdin.write(opts.input);
  } else if (opts.input !== undefined) stdin.end(opts.input);
  else stdin.end();
  const open = () => !stdin.writableEnded && !stdin.destroyed && child.exitCode === null;
  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  return {
    child,
    lines: rl,
    stderr: () => err,
    exited,
    write(text) {
      if (!open()) return false;
      stdin.write(text);
      return true;
    },
    endInput() {
      if (!stdin.writableEnded) stdin.end();
    },
  };
}

/** Run a short command and capture output (for probes). */
export function capture(command: string, args: string[], env: Record<string, string>, timeoutMs = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const [file, argv] = resolveCommand(command, args);
    execFile(file, argv, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as any).code === "number" ? (error as any).code : -1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") + (error && code === -1 ? error.message : "") });
    });
  });
}

/** Environment for CLI children: drop hub/plugin secrets, then apply overrides. */
export function childEnv(base: NodeJS.ProcessEnv, extra: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k.startsWith("PIOMIO_")) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) out[k] = v;
  return out;
}

export function textOfToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (c?.type === "text" ? String(c.text ?? "") : c?.type === "image" ? "[image]" : JSON.stringify(c)))
      .join("\n");
  }
  return content === undefined || content === null ? "" : JSON.stringify(content);
}
