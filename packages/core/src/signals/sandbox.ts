// A trigger's script, run before its agent wakes: JavaScript or TypeScript in QuickJS (WASM) on a worker thread
// (sandbox-worker.ts), so a heavy script never holds the hub's own thread (chats, approvals, cluster heartbeats). The
// script reaches the hub only through `pio`: each call comes here as a message, runs the trigger's HostCall, and goes
// back as JSON. Limits: memory and guest CPU time in the worker, wall time and the worker itself here. A run past its
// wall time ends with its worker, and the next run gets a fresh one. One idle worker is kept warm; at most two runs
// hold a slot at once, the others wait their turn. A run keeps its slot until the pio calls it started are back, even
// ones it never awaited, so what a script set off cannot pile up on the hub or land after its run.

import { Worker } from "node:worker_threads";
import type { FromSandbox, SandboxJob, ToSandbox } from "./sandbox-worker.ts";

/** What a script decides about its signal(s). Task 2 moves it to types.ts. */
export type Verdict = { drop: string } | { note: string } | { wake: string; context?: unknown } | { triage: unknown };

export interface SandboxLimits {
  memoryBytes: number;
  cpuMs: number;
  wallMs: number;
  maxCalls: number;
}

export const SCRIPT_LIMITS: SandboxLimits = { memoryBytes: 64 * 1024 * 1024, cpuMs: 2000, wallMs: 30_000, maxCalls: 50 };

/** A script's code, at most (as the trigger model has it). */
export const MAX_SCRIPT_BYTES = 64 * 1024;

/** A host function the script reaches as pio.<name>(...args); args and result are JSON. Throwing rejects the script's promise with the message. */
export type HostCall = (name: string, args: unknown[]) => Promise<unknown>;

export interface ScriptResult {
  verdict?: Verdict;
  logs: string[];
  error?: string;
  ms: number;
  calls: number;
  /** pio calls still running when the run ended at its wall time (or the sandbox stopped): their answers were dropped. */
  droppedCalls?: number;
}

/** Runs holding a slot at once (each on its own worker while it runs). */
const MAX_RUNNING = 2;
/** Runs waiting for a slot, at most: past that a run is refused at once. */
const MAX_WAITING = 200;
/** The warm worker goes after this long without a script (QuickJS's memory with it). */
const IDLE_MS = 5 * 60_000;
/** An error's text, at most (the worker cuts it too). */
const MAX_ERROR_CHARS = 2000;
/**
 * The worker's native stack. QuickJS's own stack check (QUICKJS_STACK_BYTES in the worker) must fire before V8's stack
 * runs out inside the WASM, which takes about 32 times QuickJS's limit; 16 MB is twice that for 256 KB.
 */
const WORKER_STACK_MB = 16;

interface Job {
  code: string;
  input: unknown;
  host: HostCall;
  limits: SandboxLimits;
  resolve: (r: ScriptResult) => void;
}

type Outcome = { verdict?: Verdict; error?: string };

interface Running {
  id: number;
  worker: Worker;
  host: HostCall;
  logs: string[];
  calls: number;
  /** pio calls handed to the host and not back yet. */
  inflight: number;
  t0: number;
  timer: NodeJS.Timeout;
  resolve: (r: ScriptResult) => void;
  /** How the run ended in its worker: held until its pio calls are back (or its wall time comes). */
  ended?: Outcome;
}

export class ScriptSandbox {
  private script: URL;
  private idle: Worker[] = [];
  private idleTimer?: NodeJS.Timeout;
  /** Runs holding a slot, with the worker each ran on: a worker that goes fails only its own. */
  private running = new Map<number, Running>();
  private waiting: Job[] = [];
  private seq = 0;
  private stackMb: number;

  /** `script`: the worker's module (tests hand in one that cannot start); `stackMb`: the workers' stack (tests take less). */
  constructor(script = new URL("./sandbox-worker.ts", import.meta.url), opts: { stackMb?: number } = {}) {
    this.script = script;
    this.stackMb = opts.stackMb ?? WORKER_STACK_MB;
  }

  run(code: string, input: unknown, host: HostCall, limits: SandboxLimits = SCRIPT_LIMITS): Promise<ScriptResult> {
    const refused = (error: string) => Promise.resolve({ error, logs: [], ms: 0, calls: 0 });
    if (Buffer.byteLength(code) > MAX_SCRIPT_BYTES) return refused(`the script is longer than ${MAX_SCRIPT_BYTES / 1024} KB`);
    if (this.waiting.length >= MAX_WAITING) return refused(`too many scripts waiting (${MAX_WAITING})`);
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
      job.resolve({ error: clip(`the script sandbox could not start: ${message(e)}`), logs: [], ms: 0, calls: 0 });
      return;
    }
    if (!this.idle.length) clearTimeout(this.idleTimer);
    const wallMs = job.limits.wallMs;
    const run: Running = {
      id,
      worker,
      host: job.host,
      logs: [],
      calls: 0,
      inflight: 0,
      t0,
      resolve: job.resolve,
      timer: setTimeout(() => this.wall(run, wallMs), wallMs),
    };
    this.running.set(id, run);
    try {
      worker.postMessage({ kind: "run", run: id, code: job.code, input: job.input, limits: job.limits } satisfies SandboxJob);
    } catch (e) {
      // The input cannot be copied to another thread (a function in it, say): the worker never saw the run.
      this.end(run, { error: `the script's input cannot be passed to the sandbox: ${message(e)}` }, "park");
    }
  }

  private spawn(): Worker {
    const w = new Worker(this.script, { resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: this.stackMb } });
    w.unref();
    w.on("message", (m: FromSandbox) => this.message(w, m));
    w.on("error", (e) => this.lost(w, `the script sandbox failed: ${e.message || String(e)}`));
    w.on("exit", () => this.lost(w, "the script sandbox stopped"));
    return w;
  }

  private message(w: Worker, m: FromSandbox): void {
    const run = this.running.get(m.run);
    if (!run || run.worker !== w || run.ended) return;
    if (m.kind === "log") run.logs.push(m.line);
    else if (m.kind === "call") {
      run.calls++;
      void this.answer(run, m.call, m.name, m.args);
    } else if (m.kind === "done") {
      const after = m.retire ? "terminate" : "park";
      if (m.error !== undefined) return this.end(run, { error: m.error }, after);
      const v = parseVerdict(m.value);
      this.end(run, v && "invalid" in v ? { error: `invalid verdict: ${v.invalid}` } : v ? { verdict: v } : {}, after);
    }
  }

  private async answer(run: Running, call: number, name: string, args: unknown[]): Promise<void> {
    run.inflight++;
    let reply: ToSandbox;
    try {
      const value = await run.host(name, args);
      reply = { kind: "answer", run: run.id, call, result: value === undefined ? undefined : JSON.stringify(value) };
    } catch (e) {
      reply = { kind: "answer", run: run.id, call, error: clip(message(e)) };
    }
    run.inflight--;
    // A run finished meanwhile (its wall time, the sandbox stopped) drops the answer; one whose script is done only
    // counts it back.
    if (this.running.get(run.id) !== run) return;
    if (run.ended) return this.settle(run);
    run.worker.postMessage(reply);
  }

  /** The run ended in its worker: the worker goes back (or away) now, the run resolves once its pio calls are back. */
  private end(run: Running, out: Outcome, worker: "park" | "terminate" | "none"): void {
    if (run.ended || this.running.get(run.id) !== run) return;
    run.ended = out;
    if (worker === "park") this.park(run.worker);
    else if (worker === "terminate") void run.worker.terminate();
    this.settle(run);
  }

  private settle(run: Running): void {
    if (run.ended && run.inflight === 0) this.finish(run);
  }

  /** Its wall time: a run still in its worker ends with the worker; one waiting for its pio calls ends without them. */
  private wall(run: Running, wallMs: number): void {
    if (this.running.get(run.id) !== run) return;
    if (!run.ended) {
      run.ended = { error: `the script ran longer than ${wallMs / 1000} s (wall time limit)` };
      void run.worker.terminate();
    }
    this.finish(run);
  }

  /** A worker failed or exited: its own run (if it is still in it) ends with the reason, an idle one is dropped. */
  private lost(w: Worker, reason: string): void {
    this.idle = this.idle.filter((x) => x !== w);
    for (const run of [...this.running.values()]) if (run.worker === w && !run.ended) this.end(run, { error: reason }, "none");
  }

  private finish(run: Running): void {
    if (this.running.get(run.id) !== run) return;
    this.running.delete(run.id);
    clearTimeout(run.timer);
    const out = run.ended ?? {};
    run.resolve({
      ...out,
      ...(out.error !== undefined ? { error: clip(out.error) } : {}),
      logs: run.logs,
      ms: Math.round(performance.now() - run.t0),
      calls: run.calls,
      ...(run.inflight ? { droppedCalls: run.inflight } : {}),
    });
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
    const stopped = "the script sandbox stopped";
    for (const job of this.waiting.splice(0)) job.resolve({ error: stopped, logs: [], ms: 0, calls: 0 });
    for (const run of [...this.running.values()]) {
      if (!run.ended) {
        run.ended = { error: stopped };
        void run.worker.terminate();
      }
      this.finish(run);
    }
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

function clip(s: string, n = MAX_ERROR_CHARS): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
