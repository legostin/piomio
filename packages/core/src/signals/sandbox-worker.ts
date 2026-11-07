// The trigger scripts' sandbox (sandbox.ts) on its own thread: one script at a time in QuickJS (WASM), off the hub's event
// loop. A script that spins takes only this thread; the interrupt handler stops it at its CPU limit, and the hub ends the
// thread when a run passes its wall limit. A fresh QuickJS runtime for every run; nothing lives between runs here.

import { stripTypeScriptTypes } from "node:module";
import { parentPort } from "node:worker_threads";
import { getQuickJS, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule } from "quickjs-emscripten";
import type { SandboxLimits } from "./sandbox.ts";

/** Hub → worker: run a script. */
export interface SandboxJob {
  kind: "run";
  run: number;
  code: string;
  input: unknown;
  limits: SandboxLimits;
}

/** Hub → worker: what a pio call came back with: `result` the JSON of the host's answer (absent: undefined), or `error`. */
export interface SandboxAnswer {
  kind: "answer";
  run: number;
  call: number;
  result?: string;
  error?: string;
}

export type ToSandbox = SandboxJob | SandboxAnswer;

export type FromSandbox =
  /** A pio call for the hub to run. */
  | { kind: "call"; run: number; call: number; name: string; args: unknown[] }
  /** A pio.log line (at most LOG_LINES of LOG_CHARS each). */
  | { kind: "log"; run: number; line: string }
  /** The run ended: `value` is what the script returned (JSON), or `error`. `retire`: this thread should not be reused. */
  | { kind: "done"; run: number; value?: unknown; error?: string; retire?: boolean };

export const LOG_LINES = 50;
export const LOG_CHARS = 500;
/** The JSON of a pio call's arguments, and of the verdict, at most: the hub's thread reads both. */
export const MAX_JSON_CHARS = 1024 * 1024;
const STACK_BYTES = 1024 * 1024;

/**
 * Runs before the script, as global code. It takes the two host functions off the global object, so the script reaches
 * the hub only through `pio`, and evaluates to the function that calls the script's default export.
 */
const PRELUDE = String.raw`(() => {
  "use strict";
  const host = globalThis.__host;
  const log = globalThis.__log;
  delete globalThis.__host;
  delete globalThis.__log;
  const { stringify, parse } = JSON;
  const call = (name, args) => host(name, stringify(args)).then((r) => (r === undefined ? undefined : parse(r)));
  const text = (v) => {
    if (typeof v === "string") return v;
    try {
      const s = stringify(v);
      return s === undefined ? String(v) : s;
    } catch {
      return String(v);
    }
  };
  return async (main, inputJson) => {
    const input = parse(inputJson) ?? {};
    const now = input.now;
    const pio = Object.freeze({
      tools: Object.freeze({ call: (...a) => call("tools.call", a) }),
      fetch: async (...a) => {
        const r = await call("fetch", a);
        if (r && typeof r === "object" && typeof r.text === "string") r.json = () => parse(r.text);
        return r;
      },
      llm: Object.freeze({ ask: (...a) => call("llm.ask", a) }),
      state: Object.freeze({
        get: (...a) => call("state.get", a),
        set: (...a) => call("state.set", a),
        delete: (...a) => call("state.delete", a),
      }),
      notes: Object.freeze({ recent: (...a) => call("notes.recent", a) }),
      log: (...a) => {
        log(a.map(text).join(" "));
      },
      now: () => (now && typeof now === "object" ? { ...now } : { iso: new Date().toISOString(), local: new Date().toISOString(), timezone: "UTC" }),
    });
    const verdict = await main(Array.isArray(input.signals) ? input.signals : input.signal, pio);
    return verdict === undefined ? undefined : stringify(verdict);
  };
})()`;

type Outcome = { value?: unknown; error?: string; retire?: boolean };

let quickjs: Promise<QuickJSWASMModule> | undefined;
let current: Session | undefined;

const post = (m: FromSandbox) => parentPort!.postMessage(m);

parentPort?.on("message", (m: ToSandbox) => {
  if (m.kind === "run") void start(m);
  else if (m.kind === "answer" && current?.job.run === m.run) current.answer(m);
});

async function start(job: SandboxJob): Promise<void> {
  let out: Outcome;
  try {
    out = await execute(job);
  } catch (e) {
    out = { error: `the script sandbox failed: ${message(e)}`, retire: true };
  }
  post({ kind: "done", run: job.run, ...out });
}

async function execute(job: SandboxJob): Promise<Outcome> {
  let code: string;
  try {
    code = stripTypeScriptTypes(job.code, { mode: "strip" });
  } catch (e) {
    return { error: `syntax error: ${message(e)}` };
  }
  const runtime = (await (quickjs ??= getQuickJS())).newRuntime();
  let session: Session | undefined;
  let out: Outcome;
  try {
    session = current = new Session(job, runtime);
    out = await session.run(code);
  } catch (e) {
    out = { error: `the script sandbox failed: ${message(e)}`, retire: true };
  } finally {
    current = undefined;
  }
  // Every handle goes before its context and the runtime: a leaked one makes dispose throw, and this thread is not reused.
  try {
    session?.dispose();
    runtime.dispose();
  } catch (e) {
    out = { error: `the script sandbox did not clean up: ${message(e)}`, retire: true };
  }
  return out;
}

class Session {
  readonly job: SandboxJob;
  private runtime: QuickJSRuntime;
  private vm: QuickJSContext;
  private limits: SandboxLimits;
  /** Handles this run holds, disposed in reverse at the end. */
  private handles: QuickJSHandle[] = [];
  /** pio calls waiting for the hub, by call number. */
  private pending = new Map<number, QuickJSDeferredPromise>();
  private calls = 0;
  private seq = 0;
  private logs = 0;
  /** Guest CPU time so far, and when the guest was entered (undefined: the host is running). */
  private used = 0;
  private entered: number | undefined;
  private cpuOut = false;
  /** The promise of the script's run (the prelude's async function). */
  private promise?: QuickJSHandle;
  private ended = false;
  private settle!: (o: Outcome) => void;
  private outcome = new Promise<Outcome>((resolve) => (this.settle = resolve));

  constructor(job: SandboxJob, runtime: QuickJSRuntime) {
    this.job = job;
    this.limits = job.limits;
    this.runtime = runtime;
    runtime.setMemoryLimit(job.limits.memoryBytes);
    runtime.setMaxStackSize(STACK_BYTES);
    runtime.setInterruptHandler(() => {
      if (this.entered === undefined) return false;
      if (this.used + (performance.now() - this.entered) <= this.limits.cpuMs) return false;
      this.cpuOut = true;
      return true;
    });
    this.vm = runtime.newContext();
  }

  async run(code: string): Promise<Outcome> {
    const vm = this.vm;
    const hostFn = vm.newFunction("__host", (nameH, argsH) => this.call(vm.getString(nameH), vm.getString(argsH)));
    vm.setProp(vm.global, "__host", hostFn);
    hostFn.dispose();
    const logFn = vm.newFunction("__log", (lineH) => this.log(vm.getString(lineH)));
    vm.setProp(vm.global, "__log", logFn);
    logFn.dispose();
    const prelude = this.guest(() => vm.evalCode(PRELUDE, "prelude.js"));
    if (prelude.error) return { error: `the script sandbox failed: ${this.describe(this.keep(prelude.error))}`, retire: true };
    const startFn = this.keep(prelude.value);

    const mod = this.guest(() => vm.evalCode(code, "trigger.mjs", { type: "module" }));
    if (mod.error) return this.failed(this.keep(mod.error));
    let ns = this.keep(mod.value);
    // A module with a top-level await evaluates to a promise of its namespace: it has to settle without pio.
    const pumped = this.pump();
    if (pumped) return pumped;
    const state = vm.getPromiseState(ns);
    if (state.type === "pending") return { error: "the script's top level must not wait: wait inside the default function" };
    if (state.type === "rejected") return this.failed(this.keep(state.error));
    if (!state.notAPromise) ns = this.keep(state.value);

    const main = this.keep(vm.getProp(ns, "default"));
    if (vm.typeof(main) !== "function") return { error: "the script must export a default function" };
    const inputH = this.keep(vm.newString(JSON.stringify(this.job.input ?? null)));
    const called = this.guest(() => vm.callFunction(startFn, vm.undefined, main, inputH));
    if (called.error) return this.failed(this.keep(called.error));
    this.promise = this.keep(called.value);
    this.step();
    return this.outcome;
  }

  /** The host function behind every pio call but log: a QuickJS promise the hub's answer settles. */
  private call(name: string, argsJson: string): QuickJSHandle {
    const d = this.vm.newPromise();
    const refuse = (msg: string) => {
      const e = this.vm.newError(msg);
      d.reject(e);
      e.dispose();
      return d.handle;
    };
    if (this.ended) return refuse("the script has ended");
    if (this.calls >= this.limits.maxCalls) return refuse(`too many pio calls (${this.limits.maxCalls})`);
    if (argsJson.length > MAX_JSON_CHARS) return refuse(`the arguments of pio ${name} are over ${MAX_JSON_CHARS / 1024 / 1024} MB of JSON`);
    let args: unknown[];
    try {
      args = JSON.parse(argsJson) as unknown[];
    } catch (e) {
      return refuse(`the arguments of pio ${name} are not JSON: ${message(e)}`);
    }
    this.calls++;
    const call = ++this.seq;
    this.pending.set(call, d);
    post({ kind: "call", run: this.job.run, call, name, args });
    return d.handle;
  }

  /** The hub answered a pio call: settle the script's promise and let it go on. */
  answer(m: SandboxAnswer): void {
    const d = this.pending.get(m.call);
    if (!d) return;
    this.pending.delete(m.call);
    if (this.ended) {
      d.dispose();
      return;
    }
    if (m.error !== undefined) {
      const e = this.vm.newError(m.error);
      d.reject(e);
      e.dispose();
    } else if (m.result === undefined) {
      d.resolve();
    } else {
      const s = this.vm.newString(m.result);
      d.resolve(s);
      s.dispose();
    }
    this.step();
  }

  private log(line: string): void {
    if (this.ended || this.logs >= LOG_LINES) return;
    this.logs++;
    post({ kind: "log", run: this.job.run, line: line.length > LOG_CHARS ? `${line.slice(0, LOG_CHARS - 1)}…` : line });
  }

  /** Runs the guest's pending jobs, then ends the run when its promise settled (or can no longer settle). */
  private step(): void {
    if (this.ended) return;
    const pumped = this.pump();
    if (pumped) return this.end(pumped);
    if (this.cpuOut) return this.end(this.cpuError());
    const state = this.vm.getPromiseState(this.promise!);
    if (state.type === "pending") {
      // Only a pio call can wake the script now: with none out, it waits for something that never comes.
      if (!this.pending.size) this.end({ error: "the script waits for a promise that never settles" });
      return;
    }
    if (state.type === "rejected") return this.end(this.failed(this.keep(state.error)));
    const v = this.keep(state.value);
    const type = this.vm.typeof(v);
    if (type === "undefined") return this.end({});
    if (type !== "string") return this.end({ error: "invalid verdict: the script's promise did not give one" });
    const json = this.vm.getString(v);
    if (json.length > MAX_JSON_CHARS) return this.end({ error: `invalid verdict: over ${MAX_JSON_CHARS / 1024 / 1024} MB of JSON` });
    this.end({ value: JSON.parse(json) });
  }

  /** executePendingJobs in guest time; an outcome when a job failed outside any promise. */
  private pump(): Outcome | undefined {
    const r = this.guest(() => this.runtime.executePendingJobs());
    if (!r.error) return undefined;
    return this.failed(this.keep(r.error));
  }

  private end(o: Outcome): void {
    if (this.ended) return;
    this.ended = true;
    this.settle(o);
  }

  /** The run's error from what the guest threw (the CPU and memory limits named as such). */
  private failed(error: QuickJSHandle): Outcome {
    const text = this.cpuOut ? "" : this.describe(error);
    // Reading what was thrown may run the guest's code too (a toJSON), and use up its CPU time.
    if (this.cpuOut) return this.cpuError();
    if (/out of memory/i.test(text)) return { error: `the script ran out of memory (${Math.round(this.limits.memoryBytes / 1024 / 1024)} MB)` };
    return { error: text };
  }

  private cpuError(): Outcome {
    return { error: `the script ran out of CPU time (${this.limits.cpuMs} ms)` };
  }

  /** What the guest threw, as one line: "TypeError: … (at trigger.mjs:2:20)". Read in guest time: it may run its code. */
  private describe(error: QuickJSHandle): string {
    let v: unknown;
    try {
      v = this.guest(() => this.vm.dump(error));
    } catch {
      return "the script threw something that cannot be read";
    }
    if (v && typeof v === "object" && typeof (v as { message?: unknown }).message === "string") {
      const { name, message: msg, stack } = v as { name?: unknown; message: string; stack?: unknown };
      const head = typeof name === "string" && name && name !== "Error" ? `${name}: ${msg}` : msg;
      const at = typeof stack === "string" ? /trigger\.mjs:\d+(?::\d+)?/.exec(stack)?.[0] : undefined;
      return at ? `${head} (at ${at})` : head;
    }
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v) ?? String(v);
    } catch {
      return String(v);
    }
  }

  /** Runs guest code, counting its time against the CPU limit. */
  private guest<T>(f: () => T): T {
    const t0 = performance.now();
    this.entered = t0;
    try {
      return f();
    } finally {
      this.used += performance.now() - t0;
      this.entered = undefined;
    }
  }

  private keep(h: QuickJSHandle): QuickJSHandle {
    this.handles.push(h);
    return h;
  }

  dispose(): void {
    this.ended = true;
    for (const d of this.pending.values()) d.dispose();
    this.pending.clear();
    for (const h of this.handles.reverse()) if (h.alive) h.dispose();
    this.handles = [];
    this.vm.dispose();
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
