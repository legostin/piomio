// A trigger's script, run before its agent wakes: JavaScript or TypeScript in QuickJS (WASM) on a worker thread
// (sandbox-worker.ts), so a heavy script never holds the hub's own thread (chats, approvals, cluster heartbeats). The
// script reaches the hub only through `pio`: each call comes here as a message, runs the trigger's HostCall, and goes
// back as JSON. Limits: memory and guest CPU time in the worker, wall time and the worker itself here. A run past its
// wall time ends with its worker, and the next run gets a fresh one. One idle worker is kept warm; at most two scripts
// run at once, the others wait their turn.

import { Worker } from "node:worker_threads";
import type { FromSandbox, SandboxJob, ToSandbox } from "./sandbox-worker.ts";

// What a script decides about its signal(s): the trigger model's Verdict.
import type { Verdict } from "./types.ts";

export type { Verdict };

export interface SandboxLimits {
  memoryBytes: number;
  cpuMs: number;
  wallMs: number;
  maxCalls: number;
}

export const SCRIPT_LIMITS: SandboxLimits = { memoryBytes: 64 * 1024 * 1024, cpuMs: 2000, wallMs: 30_000, maxCalls: 50 };

/** A host function the script reaches as pio.<name>(...args); args and result are JSON. Throwing rejects the script's promise with the message. */
export type HostCall = (name: string, args: unknown[]) => Promise<unknown>;

export interface ScriptResult {
  verdict?: Verdict;
  logs: string[];
  error?: string;
  ms: number;
  calls: number;
}

/** Scripts running at once (each on its own worker). */
const MAX_RUNNING = 2;
/** The warm worker goes after this long without a script (QuickJS's memory with it). */
const IDLE_MS = 5 * 60_000;

interface Job {
  code: string;
  input: unknown;
  host: HostCall;
  limits: SandboxLimits;
  resolve: (r: ScriptResult) => void;
}

interface Running {
  id: number;
  worker: Worker;
  host: HostCall;
  logs: string[];
  calls: number;
  t0: number;
  timer: NodeJS.Timeout;
  resolve: (r: ScriptResult) => void;
}

export class ScriptSandbox {
  private script: URL;
  private idle: Worker[] = [];
  private idleTimer?: NodeJS.Timeout;
  /** Runs in progress, with the worker running each: a worker that goes fails only its own. */
  private running = new Map<number, Running>();
  private waiting: Job[] = [];
  private seq = 0;

  /** `script`: the worker's module (tests hand in one that cannot start). */
  constructor(script = new URL("./sandbox-worker.ts", import.meta.url)) {
    this.script = script;
  }

  run(code: string, input: unknown, host: HostCall, limits: SandboxLimits = SCRIPT_LIMITS): Promise<ScriptResult> {
    return new Promise<ScriptResult>((resolve) => {
      this.waiting.push({ code, input, host, limits, resolve });
      this.next();
    });
  }

  private next(): void {
    while (this.running.size < MAX_RUNNING && this.waiting.length) this.start(this.waiting.shift()!);
  }

  private start(job: Job): void {
    const id = ++this.seq;
    const t0 = performance.now();
    let worker: Worker;
    try {
      worker = this.idle.pop() ?? this.spawn();
    } catch (e) {
      job.resolve({ error: `the script sandbox could not start: ${message(e)}`, logs: [], ms: 0, calls: 0 });
      return;
    }
    if (!this.idle.length) clearTimeout(this.idleTimer);
    const run: Running = {
      id,
      worker,
      host: job.host,
      logs: [],
      calls: 0,
      t0,
      resolve: job.resolve,
      // Past its wall time a run ends here, whatever its worker is doing; the worker goes with it.
      timer: setTimeout(() => this.finish(run, { error: `the script ran longer than ${job.limits.wallMs / 1000} s (wall time limit)` }, "terminate"), job.limits.wallMs),
    };
    this.running.set(id, run);
    try {
      worker.postMessage({ kind: "run", run: id, code: job.code, input: job.input, limits: job.limits } satisfies SandboxJob);
    } catch (e) {
      // The input cannot be copied to another thread (a function in it, say): the worker never saw the run.
      this.finish(run, { error: `the script's input cannot be passed to the sandbox: ${message(e)}` }, "park");
    }
  }

  private spawn(): Worker {
    const w = new Worker(this.script, { resourceLimits: { maxOldGenerationSizeMb: 128 } });
    w.unref();
    w.on("message", (m: FromSandbox) => this.message(w, m));
    w.on("error", (e) => this.lost(w, `the script sandbox failed: ${e.message || String(e)}`));
    w.on("exit", () => this.lost(w, "the script sandbox stopped"));
    return w;
  }

  private message(w: Worker, m: FromSandbox): void {
    const run = this.running.get(m.run);
    if (!run || run.worker !== w) return;
    if (m.kind === "log") run.logs.push(m.line);
    else if (m.kind === "call") {
      run.calls++;
      void this.answer(run, m.call, m.name, m.args);
    } else if (m.kind === "done") {
      if (m.error !== undefined) return this.finish(run, { error: m.error }, m.retire ? "terminate" : "park");
      const v = parseVerdict(m.value);
      this.finish(run, v && "invalid" in v ? { error: `invalid verdict: ${v.invalid}` } : v ? { verdict: v } : {}, m.retire ? "terminate" : "park");
    }
  }

  private async answer(run: Running, call: number, name: string, args: unknown[]): Promise<void> {
    let reply: ToSandbox;
    try {
      const value = await run.host(name, args);
      reply = { kind: "answer", run: run.id, call, result: value === undefined ? undefined : JSON.stringify(value) };
    } catch (e) {
      reply = { kind: "answer", run: run.id, call, error: message(e) };
    }
    // A run that ended meanwhile (its wall time, its worker gone) gets no answer.
    if (this.running.get(run.id) === run) run.worker.postMessage(reply);
  }

  /** A worker failed or exited: its own run (if any) ends with the reason, an idle one is dropped. */
  private lost(w: Worker, reason: string): void {
    this.idle = this.idle.filter((x) => x !== w);
    for (const run of [...this.running.values()]) if (run.worker === w) this.finish(run, { error: reason }, "none");
  }

  private finish(run: Running, out: { verdict?: Verdict; error?: string }, worker: "park" | "terminate" | "none"): void {
    if (this.running.get(run.id) !== run) return;
    this.running.delete(run.id);
    clearTimeout(run.timer);
    if (worker === "park") this.park(run.worker);
    else if (worker === "terminate") void run.worker.terminate();
    run.resolve({ ...out, logs: run.logs, ms: Math.round(performance.now() - run.t0), calls: run.calls });
    this.next();
  }

  /** A worker done with its run is kept warm (one), or goes. */
  private park(w: Worker): void {
    if (this.idle.length) {
      void w.terminate();
      return;
    }
    this.idle.push(w);
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      for (const x of this.idle.splice(0)) void x.terminate();
    }, IDLE_MS).unref();
  }

  /** Every worker goes (the hub stops); runs in progress and waiting end with an error. Later runs start afresh. */
  stop(): void {
    clearTimeout(this.idleTimer);
    for (const w of this.idle.splice(0)) void w.terminate();
    const stopped = { error: "the script sandbox stopped" };
    for (const job of this.waiting.splice(0)) job.resolve({ ...stopped, logs: [], ms: 0, calls: 0 });
    for (const run of [...this.running.values()]) this.finish(run, stopped, "terminate");
  }
}

/** The hub's one sandbox: every trigger's scripts run here. */
export const scriptSandbox = new ScriptSandbox();

export async function runScript(code: string, input: unknown, host: HostCall, limits: SandboxLimits = SCRIPT_LIMITS): Promise<ScriptResult> {
  return scriptSandbox.run(code, input, host, limits);
}

const VERDICT_KEYS = ["drop", "note", "wake", "triage"] as const;

/** A script's return value as a verdict: nothing (undefined, null), a verdict, or why it is not one. */
export function parseVerdict(v: unknown): Verdict | undefined | { invalid: string } {
  if (v === undefined || v === null) return undefined;
  const shape = "a verdict is an object with one of drop, note, wake or triage";
  if (typeof v !== "object" || Array.isArray(v)) return { invalid: `${shape}, not ${Array.isArray(v) ? "an array" : typeof v}` };
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return { invalid: `${shape}, not a ${proto?.constructor?.name ?? "class instance"}` };
  const o = v as Record<string, unknown>;
  const kinds = VERDICT_KEYS.filter((k) => o[k] !== undefined);
  if (kinds.length !== 1) return { invalid: kinds.length ? `only one of ${kinds.join(", ")}` : shape };
  const kind = kinds[0];
  const extra = Object.keys(o).filter((k) => k !== kind && !(kind === "wake" && k === "context") && o[k] !== undefined);
  if (extra.length) return { invalid: `unexpected ${extra.map((k) => `"${k}"`).join(", ")} beside ${kind}${extra.includes("context") ? " (context goes with wake)" : ""}` };
  if (kind === "triage") return { triage: o.triage };
  const text = o[kind];
  if (typeof text !== "string") return { invalid: `${kind} must be a string, not ${text === null ? "null" : typeof text}` };
  if (kind === "wake") return o.context === undefined ? { wake: text } : { wake: text, context: o.context };
  return kind === "drop" ? { drop: text } : { note: text };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
