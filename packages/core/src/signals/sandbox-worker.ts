// The trigger scripts' sandbox (sandbox.ts) on its own thread: one script at a time in QuickJS (WASM), off the hub's event
// loop. A script that spins takes only this thread; the interrupt handler stops it at its CPU limit, and the hub ends the
// thread when a run passes its wall limit. A fresh QuickJS runtime for every run; nothing lives between runs here. A run
// that may have left this thread unfit (TypeScript's stripper or QuickJS failing inside their WASM) asks the hub to
// retire it, so the next script gets a fresh thread.

import { stripTypeScriptTypes } from "node:module";
import { parentPort } from "node:worker_threads";
import {
  newQuickJSWASMModule,
  newVariant,
  RELEASE_SYNC,
  type CustomizeVariantOptions,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten";
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
/** Their nesting, at most: deeper JSON is a stack hazard wherever it is read or written next. */
export const MAX_JSON_DEPTH = 100;
/** An error's text, at most (the hub cuts it again). */
export const MAX_ERROR_CHARS = 2000;
/**
 * QuickJS's own stack limit. QuickJS measures only its C stack, and each of its frames takes about 32 times as much of
 * the thread's native stack. With less native stack than that, deep nesting (JSON.parse of a deep page, the parser,
 * String() of a deep array) overflows V8's stack inside the WASM before QuickJS's check fires, and that leaves QuickJS's
 * state corrupt. sandbox.ts gives this thread 16 MB (WORKER_STACK_MB): 256 KB keeps QuickJS's check first with a margin
 * of two, and still allows about 1500 frames of plain recursion.
 */
export const QUICKJS_STACK_BYTES = 256 * 1024;

/** The stripper's own errors about the code; any other failure may have left its WASM unfit for the next script. */
const SYNTAX_CODES = new Set(["ERR_INVALID_TYPESCRIPT_SYNTAX", "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX"]);
/** Promise jobs run between checks of whether the script's run has settled. */
const JOB_BATCH = 1000;

/**
 * Runs before the script, as global code. It takes the two host functions off the global object, so the script reaches
 * the hub only through `pio`, and evaluates to `{ start, describe, kindOf }`: the function that calls the script's
 * default export, the one that reads what a script threw as one short line, and the one that tells QuickJS's own
 * out-of-memory and stack-overflow errors from anything a script throws. The built-ins they use are taken once, here,
 * before the script runs, so a script that changes them changes only its own results. (`${…}` here is the host's: the
 * limits.)
 */
const PRELUDE = String.raw`(() => {
  "use strict";
  const host = globalThis.__host;
  const log = globalThis.__log;
  delete globalThis.__host;
  delete globalThis.__log;
  const { stringify, parse } = JSON;
  const toText = String;
  const sliceFn = String.prototype.slice;
  const execFn = RegExp.prototype.exec;
  const bindCall = Function.prototype.call.bind(Function.prototype.call);
  const slice = (s, a, b) => bindCall(sliceFn, s, a, b);
  const exec = (re, s) => bindCall(execFn, re, s);
  const isArray = Array.isArray;
  const { InternalError, RangeError, SyntaxError } = globalThis;
  // QuickJS's own: its stack check (InternalError; SyntaxError from the parser and JSON.parse) and its allocator.
  const isOverflow = (e) => (e instanceof InternalError || e instanceof RangeError || e instanceof SyntaxError) && e.message === "stack overflow";
  const kindOf = (e) => {
    try {
      if (e instanceof InternalError && e.message === "out of memory") return "memory";
      return isOverflow(e) ? "stack" : "";
    } catch {
      return "";
    }
  };
  const clip = (s, n) => (s.length > n ? slice(s, 0, n - 1) + "…" : s);
  const call = async (name, args) => {
    const json = stringify(args);
    if (json.length > ${MAX_JSON_CHARS}) throw new Error("the arguments of pio " + name + " are over 1 MB of JSON");
    const r = await host(name, json);
    return r === undefined ? undefined : parse(r);
  };
  const text = (v) => {
    if (typeof v === "string") return v;
    try {
      const s = stringify(v);
      return s === undefined ? toText(v) : s;
    } catch {
      return toText(v);
    }
  };
  const describe = (e) => {
    try {
      if (typeof e === "string") return clip(e, ${MAX_ERROR_CHARS});
      if (e !== null && (typeof e === "object" || typeof e === "function")) {
        const message = e.message;
        if (typeof message === "string") {
          const name = e.name;
          const stack = e.stack;
          const head = typeof name === "string" && name !== "" && name !== "Error" ? clip(name, 100) + ": " + clip(message, ${MAX_ERROR_CHARS}) : clip(message, ${MAX_ERROR_CHARS});
          const at = typeof stack === "string" ? exec(/trigger\.mjs:\d+(?::\d+)?/, slice(stack, 0, 4000)) : null;
          return at ? head + " (at " + at[0] + ")" : head;
        }
      }
      const s = stringify(e);
      return clip(s === undefined ? toText(e) : s, ${MAX_ERROR_CHARS});
    } catch (x) {
      if (isOverflow(x)) return "the script threw a value nested too deeply to show";
      return "the script threw a value that cannot be shown" + (x !== null && typeof x === "object" && typeof x.message === "string" ? " (" + clip(x.message, 200) + ")" : "");
    }
  };
  const start = async (main, inputJson) => {
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
        const line = a.map(text).join(" ");
        log(line.length > ${LOG_CHARS} ? slice(line, 0, ${LOG_CHARS + 1}) : line);
      },
      now: () => (now && typeof now === "object" ? { ...now } : { iso: new Date().toISOString(), local: new Date().toISOString(), timezone: "UTC" }),
    });
    // The trigger's own shape first (a batch's list, else its one signal: the first when a flood gathered several);
    // every signal of the run, always, as the third argument.
    const list = isArray(input.signals) ? input.signals : [input.signal];
    const first = input.signal !== undefined && input.batch !== true ? input.signal : isArray(input.signals) ? input.signals : input.signal;
    const verdict = await main(first, pio, list);
    if (verdict === undefined) return undefined;
    // Wrapped, so a verdict JSON cannot carry (a function, a toJSON giving nothing) shows as such, not as no verdict.
    const json = stringify({ v: verdict });
    if (json.length > ${MAX_JSON_CHARS}) throw new Error("invalid verdict: over 1 MB of JSON");
    return json;
  };
  return { start, describe, kindOf };
})()`;

type Outcome = { value?: unknown; error?: string; retire?: boolean };

/** Thrown out of the guest when QuickJS failed inside its WASM (not a script's error): nothing more runs in it. */
class SandboxBroken extends Error {}

let quickjs: Promise<QuickJSWASMModule> | undefined;
let current: Session | undefined;

/** The module once per thread. Emscripten's own messages (an abort's "Aborted(…)") stay off the hub's stderr: the error says it. */
function quickjsModule(): Promise<QuickJSWASMModule> {
  const emscriptenModule = { printErr: () => {} } as CustomizeVariantOptions["emscriptenModule"];
  return (quickjs ??= newQuickJSWASMModule(newVariant(RELEASE_SYNC, { emscriptenModule })));
}

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
  if (out.error !== undefined) out.error = clip(out.error, MAX_ERROR_CHARS);
  try {
    post({ kind: "done", run: job.run, ...out });
  } catch (e) {
    post({ kind: "done", run: job.run, error: clip(`the script's result cannot be passed to the hub: ${message(e)}`, MAX_ERROR_CHARS), retire: true });
  }
}

async function execute(job: SandboxJob): Promise<Outcome> {
  let code: string;
  try {
    code = stripTypeScriptTypes(job.code, { mode: "strip" });
  } catch (e) {
    if (SYNTAX_CODES.has((e as { code?: string }).code ?? "")) return { error: `syntax error: ${message(e)}` };
    // The stripper failed in itself (its WASM runs out of stack at about 1400 levels of nesting) and stays broken.
    return { error: `the script could not be read (is it nested too deeply?): ${message(e).split("\n")[0]}`, retire: true };
  }
  const runtime = (await quickjsModule()).newRuntime();
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
  // A module that failed in its WASM is not touched again (its dispose would only abort too): the thread goes, with the
  // first error.
  if (session?.broken()) return session.brokenOutcome();
  // Every handle goes before its context and the runtime: a leaked one makes dispose throw, and this thread is not reused.
  try {
    session?.dispose();
    runtime.dispose();
  } catch (e) {
    // A run that already failed (out of memory inside a job, say) can leave QuickJS unable to free its runtime: that
    // run's own error says what happened. A run that went well and does not clean up is the sandbox's leak.
    out = out.error !== undefined ? { ...out, retire: true } : { error: `the script sandbox did not clean up: ${message(e)}`, retire: true };
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
  /** The first host-level failure inside QuickJS (V8's stack running out in the WASM, a WASM trap). */
  private failure?: { error: unknown };
  /** The prelude's three functions, and the promise of the script's run. */
  private startFn?: QuickJSHandle;
  private describeFn?: QuickJSHandle;
  private kindOfFn?: QuickJSHandle;
  private promise?: QuickJSHandle;
  private ended = false;
  private settle!: (o: Outcome) => void;
  private outcome = new Promise<Outcome>((resolve) => (this.settle = resolve));

  constructor(job: SandboxJob, runtime: QuickJSRuntime) {
    this.job = job;
    this.limits = job.limits;
    this.runtime = runtime;
    runtime.setMemoryLimit(job.limits.memoryBytes);
    runtime.setMaxStackSize(QUICKJS_STACK_BYTES);
    runtime.setInterruptHandler(() => {
      if (this.entered === undefined) return false;
      if (this.used + (performance.now() - this.entered) <= this.limits.cpuMs) return false;
      this.cpuOut = true;
      return true;
    });
    this.vm = runtime.newContext();
  }

  async run(code: string): Promise<Outcome> {
    try {
      const early = this.begin(code);
      if (early) return early;
      return await this.outcome;
    } catch (e) {
      if (this.failure) return this.brokenOutcome();
      throw e;
    }
  }

  /** Everything up to the script's first wait: an outcome when it ended before that. */
  private begin(code: string): Outcome | undefined {
    const vm = this.vm;
    const hostFn = vm.newFunction("__host", (nameH, argsH) => this.callback(() => this.call(vm.getString(nameH), vm.getString(argsH))));
    vm.setProp(vm.global, "__host", hostFn);
    hostFn.dispose();
    const logFn = vm.newFunction("__log", (lineH) => this.callback(() => this.log(vm.getString(lineH))));
    vm.setProp(vm.global, "__log", logFn);
    logFn.dispose();
    const prelude = this.guest(() => vm.evalCode(PRELUDE, "prelude.js"));
    if (prelude.error) return { error: `the script sandbox failed: ${this.dumpText(this.keep(prelude.error))}`, retire: true };
    const fns = this.keep(prelude.value);
    this.startFn = this.keep(vm.getProp(fns, "start"));
    this.describeFn = this.keep(vm.getProp(fns, "describe"));
    this.kindOfFn = this.keep(vm.getProp(fns, "kindOf"));

    const mod = this.guest(() => vm.evalCode(code, "trigger.mjs", { type: "module" }));
    if (mod.error) return this.failed(this.keep(mod.error));
    let ns = this.keep(mod.value);
    // A module with a top-level await evaluates to a promise of its namespace: it has to settle without pio.
    const pumped = this.pump();
    if (pumped) return pumped;
    if (this.cpuOut) return this.cpuError();
    const state = vm.getPromiseState(ns);
    if (state.type === "pending") return { error: "the script's top level must not wait: wait inside the default function" };
    if (state.type === "rejected") return this.failed(this.keep(state.error));
    if (!state.notAPromise) ns = this.keep(state.value);

    const main = this.keep(vm.getProp(ns, "default"));
    if (vm.typeof(main) !== "function") return { error: "the script must export a default function" };
    const inputH = this.keep(vm.newString(JSON.stringify(this.job.input ?? null)));
    const called = this.guest(() => vm.callFunction(this.startFn!, vm.undefined, main, inputH));
    if (called.error) return this.failed(this.keep(called.error));
    this.promise = this.keep(called.value);
    this.step();
    return undefined;
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
    let args: unknown;
    try {
      args = JSON.parse(argsJson);
    } catch (e) {
      return refuse(`the arguments of pio ${name} are not JSON: ${message(e)}`);
    }
    // The prelude hands an array; a script's Array.prototype.toJSON could turn it into anything else.
    if (!Array.isArray(args)) return refuse(`the arguments of pio ${name} are not a list`);
    if (deeperThan(args, MAX_JSON_DEPTH)) return refuse(`the arguments of pio ${name} are nested deeper than ${MAX_JSON_DEPTH} levels`);
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
    this.safely(() => {
      if (m.error !== undefined) {
        const e = this.vm.newError(clip(m.error, MAX_ERROR_CHARS));
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
    });
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
    if (this.vm.typeof(v) === "undefined") return this.end({});
    const json = this.vm.typeof(v) === "string" ? this.vm.getString(v) : "";
    if (json.length > MAX_JSON_CHARS) return this.end({ error: `invalid verdict: over ${MAX_JSON_CHARS / 1024 / 1024} MB of JSON` });
    let wrapped: unknown;
    try {
      wrapped = JSON.parse(json);
    } catch {
      wrapped = undefined;
    }
    if (!wrapped || typeof wrapped !== "object" || !Object.hasOwn(wrapped, "v")) {
      return this.end({ error: "invalid verdict: it cannot be JSON (a function, or a toJSON that gives nothing)" });
    }
    const value = (wrapped as { v: unknown }).v;
    if (deeperThan(value, MAX_JSON_DEPTH)) return this.end({ error: `invalid verdict: nested deeper than ${MAX_JSON_DEPTH} levels` });
    this.end({ value });
  }

  /**
   * executePendingJobs in guest time, in batches; an outcome when a job failed outside any promise. Once the script's
   * run has settled, what it left queued is not run: it goes with the runtime. (A promise chain left looping would
   * otherwise fill memory after the script was done, and QuickJS cannot always free a runtime that ran out of it.)
   */
  private pump(): Outcome | undefined {
    for (;;) {
      const r = this.guest(() => this.runtime.executePendingJobs(JOB_BATCH));
      if (r.error) return this.failed(this.keep(r.error));
      if (this.cpuOut || !this.runtime.hasPendingJob() || this.settled()) return undefined;
    }
  }

  /** Whether the script's run (once it started) has settled. */
  private settled(): boolean {
    if (!this.promise) return false;
    const state = this.vm.getPromiseState(this.promise);
    if (state.type === "pending") return false;
    if (state.type === "fulfilled" && !state.notAPromise) state.value.dispose();
    else if (state.type === "rejected") state.error.dispose();
    return true;
  }

  private end(o: Outcome): void {
    if (this.ended) return;
    this.ended = true;
    this.settle(o);
  }

  /** Work outside a guest call (an answer arriving): a failure in QuickJS ends the run. */
  private safely(f: () => void): void {
    try {
      f();
    } catch (e) {
      this.failure ??= { error: e };
      this.end(this.brokenOutcome());
    }
  }

  /**
   * A host function's body. What it throws, QuickJS's bindings hand the script as an error; a failure from inside the
   * WASM (V8's stack out, a trap) is also remembered, and the guest call around it then ends the run.
   */
  private callback<T>(f: () => T): T {
    try {
      return f();
    } catch (e) {
      this.failure ??= { error: e };
      throw e;
    }
  }

  broken(): boolean {
    return this.failure !== undefined;
  }

  brokenOutcome(): Outcome {
    const e = this.failure?.error;
    if (e instanceof RangeError && /call stack/i.test(e.message)) return { error: "the script nested too deeply: the sandbox ran out of stack", retire: true };
    return { error: `the script sandbox failed: ${message(e)}`, retire: true };
  }

  /** The run's error from what the guest threw (the CPU and memory limits named as such). */
  private failed(error: QuickJSHandle): Outcome {
    if (this.cpuOut) return this.cpuError();
    // QuickJS throws null when it cannot even make its out-of-memory error.
    const kind = this.vm.sameValue(error, this.vm.null) ? "memory" : this.kindOf(error);
    const text = kind === "memory" ? "" : this.describe(error);
    // Reading what was thrown may run the guest's code too (a getter, a toJSON), and use up its CPU time.
    if (this.cpuOut) return this.cpuError();
    if (kind === "memory") return { error: `the script ran out of memory (${Math.round(this.limits.memoryBytes / 1024 / 1024)} MB)` };
    if (kind === "stack") return { error: `the script nested too deeply: ${text}` };
    return { error: text };
  }

  /** "memory", "stack" (QuickJS's own errors, by their type) or "" for anything else, asked of the prelude's kindOf. */
  private kindOf(error: QuickJSHandle): string {
    const r = this.guest(() => this.vm.callFunction(this.kindOfFn!, this.vm.undefined, error));
    if (r.error) {
      r.error.dispose();
      return "";
    }
    const v = r.value;
    try {
      return this.vm.typeof(v) === "string" ? this.vm.getString(v) : "";
    } finally {
      v.dispose();
    }
  }

  private cpuError(): Outcome {
    return { error: `the script ran out of CPU time (${this.limits.cpuMs} ms)` };
  }

  /**
   * What the guest threw, as one short line: "TypeError: … (at trigger.mjs:2:20)". Read by the prelude's describe, in
   * the guest: it is cut there, so a huge thrown value never leaves QuickJS whole, and it may run the script's code.
   */
  private describe(error: QuickJSHandle): string {
    const unreadable = "the script threw a value that cannot be shown";
    const r = this.guest(() => this.vm.callFunction(this.describeFn!, this.vm.undefined, error));
    if (r.error) {
      r.error.dispose();
      return unreadable;
    }
    const v = r.value;
    try {
      return clip(this.vm.typeof(v) === "string" ? this.vm.getString(v) : unreadable, MAX_ERROR_CHARS);
    } finally {
      v.dispose();
    }
  }

  /** Our own prelude's error (it has no describe yet). */
  private dumpText(error: QuickJSHandle): string {
    try {
      const d = this.vm.dump(error) as unknown;
      return clip(typeof d === "string" ? d : (JSON.stringify(d) ?? String(d)), MAX_ERROR_CHARS);
    } catch (e) {
      return message(e);
    }
  }

  /** Runs guest code, counting its time against the CPU limit. A throw is not the script's: QuickJS failed in its WASM. */
  private guest<T>(f: () => T): T {
    if (this.failure) throw new SandboxBroken("the sandbox failed earlier in this run");
    const t0 = performance.now();
    this.entered = t0;
    let r: T;
    try {
      r = f();
    } catch (e) {
      this.failure ??= { error: e };
      throw new SandboxBroken(message(e));
    } finally {
      this.used += performance.now() - t0;
      this.entered = undefined;
      // One long native call (a sort, a GC filling memory) runs past the limit with no chance to interrupt it: it still
      // counts as having used up the CPU time.
      if (this.used > this.limits.cpuMs) this.cpuOut = true;
    }
    // A host function failed that way while the guest ran: QuickJS went on, but its state is not to be trusted.
    if (this.failure) throw new SandboxBroken("the sandbox failed in a host function");
    return r;
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

/** Whether JSON-like `v` nests deeper than `max` (counted without recursion: `v` may be as deep as it likes). */
function deeperThan(v: unknown, max: number): boolean {
  const todo: Array<[unknown, number]> = [[v, 1]];
  while (todo.length) {
    const [x, depth] = todo.pop()!;
    if (x === null || typeof x !== "object") continue;
    if (depth > max) return true;
    for (const c of Object.values(x)) if (c !== null && typeof c === "object") todo.push([c, depth + 1]);
  }
  return false;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
