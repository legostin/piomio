// The value a watch compares, read off the hub's event loop (extract-worker.ts runs extractValue). node-html-parser takes
// quadratic time on unclosed nested tags, so a hostile page within the 2 MB body cap could hold the hub's thread for
// minutes: chats, the API, approvals, webhooks and cluster heartbeats with it. In the worker, a page that takes longer
// than the limit ends with its worker and an extractTimeout error, and the next page gets a fresh worker. One page at a
// time; the worker goes after a minute without work.

import { Worker } from "node:worker_threads";
import type { ExtractJob, ExtractReply } from "./extract-worker.ts";
import { WatchError } from "./watch.ts";

/** How long one page may take to read. A large ordinary page takes well under a second. */
export const EXTRACT_TIMEOUT_MS = 10_000;
/** The worker goes after this long without work (a parsed page's memory with it). */
const IDLE_MS = 60_000;

type Opts = { selector?: string; jsonPath?: string };

export class PageReader {
  private worker?: Worker;
  private seq = 0;
  /** Pages being read, with the worker reading each: a worker that goes fails only its own. */
  private pending = new Map<number, { resolve: (r: ExtractReply) => void; timer: NodeJS.Timeout; worker: Worker }>();
  private queue: Promise<unknown> = Promise.resolve();
  private idle?: NodeJS.Timeout;
  private script: URL;

  /** `script`: the worker's module. */
  constructor(script = new URL("./extract-worker.ts", import.meta.url)) {
    this.script = script;
  }

  /** extractValue(body, contentType, opts), in the worker: the same value, or the same error. */
  read(body: string, contentType: string, opts: Opts, timeoutMs = EXTRACT_TIMEOUT_MS): Promise<string> {
    const run = this.queue.then(() => this.ask({ body, contentType, opts }, timeoutMs));
    this.queue = run.catch(() => {});
    return run.then((r) => {
      if (!r.error) return r.value ?? "";
      throw r.error.code ? new WatchError(r.error.code, r.error.message, r.error.params) : new Error(r.error.message);
    });
  }

  private ask(job: Omit<ExtractJob, "id">, timeoutMs: number): Promise<ExtractReply> {
    const worker = this.start();
    clearTimeout(this.idle);
    const id = ++this.seq;
    return new Promise<ExtractReply>((resolve) => {
      const timer = setTimeout(() => {
        // A page that never finishes: the worker goes with it, the next page starts afresh.
        this.pending.delete(id);
        this.stop();
        const seconds = Math.ceil(timeoutMs / 1000);
        resolve({ id, error: { message: `Reading the page took longer than ${seconds} s: it is too large or too deeply nested`, code: "extractTimeout", params: { seconds } } });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer, worker });
      worker.postMessage({ ...job, id } satisfies ExtractJob);
    }).finally(() => {
      if (!this.pending.size && this.worker) this.idle = setTimeout(() => this.stop(), IDLE_MS).unref();
    });
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(this.script);
    w.unref();
    w.on("message", (r: ExtractReply) => {
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      clearTimeout(p.timer);
      p.resolve(r);
    });
    // A worker ended after a page took too long may exit while its successor reads the next page: only its own fail.
    const failed = (reason: string) => {
      if (this.worker === w) this.worker = undefined;
      for (const [id, p] of this.pending) {
        if (p.worker !== w) continue;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.resolve({ id, error: { message: `Could not read the page: ${reason}` } });
      }
    };
    w.on("error", (e) => failed(e.message || "the page reader failed"));
    w.on("exit", () => failed("the page reader stopped"));
    this.worker = w;
    return w;
  }

  /** The worker goes (idle, a page that took too long, or the process ends). */
  stop(): void {
    clearTimeout(this.idle);
    const w = this.worker;
    this.worker = undefined;
    void w?.terminate();
  }
}

/** The hub's one page reader: every watch's pages are read here, one at a time. */
export const pageReader = new PageReader();
