// Small copies of the pictures in the chat (/api/files?preview=1): the chat shows the copy, the viewer loads the file
// itself when the person opens it. Copies are made once in a worker thread (preview-image.ts) and kept on disk under
// the file's path, size and modification time, so a changed file gets a new one.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { FileCache, imageTypeOf } from "./media.ts";
import { makePreview } from "./preview-image.ts";
import type { PreviewJob, PreviewReply } from "./preview-worker.ts";

export const PREVIEW_TTL_MS = 30 * 24 * 3600_000;
/** A smaller file is its own preview: making one would save next to nothing. */
export const MIN_PREVIEW_BYTES = 160 * 1024;
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
/** The worker goes after this long without work (a decoded photo's memory with it). */
const IDLE_MS = 60_000;
const JOB_TIMEOUT_MS = 60_000;
const EXT: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png" };

/** The worker's reply; `worker`: the worker failed, not the picture. */
type Answer = PreviewReply & { worker?: boolean };

export class PicturePreviews {
  private cache: FileCache;
  private worker?: Worker;
  private seq = 0;
  private pending = new Map<number, { resolve: (r: Answer) => void; timer: NodeJS.Timeout }>();
  private inflight = new Map<string, Promise<string | undefined>>();
  /** One picture at a time: decoding a big photo takes a lot of memory. */
  private queue: Promise<unknown> = Promise.resolve();
  private idle?: NodeJS.Timeout;

  private script: URL;

  /** `script`: the worker's module (tests hand in one that cannot start). */
  constructor(dir: string, script = new URL("./preview-worker.ts", import.meta.url)) {
    this.cache = new FileCache(dir, PREVIEW_TTL_MS);
    this.script = script;
  }

  /** The preview file of a picture, or undefined when the picture itself should be shown (small, not JPEG/PNG, unreadable). */
  preview(file: string): Promise<string | undefined> {
    const type = imageTypeOf(file);
    if (type !== "image/jpeg" && type !== "image/png") return Promise.resolve(undefined);
    let st;
    try {
      st = statSync(file);
    } catch {
      return Promise.resolve(undefined);
    }
    if (st.size < MIN_PREVIEW_BYTES || st.size > MAX_SOURCE_BYTES) return Promise.resolve(undefined);
    const key = createHash("sha256").update(`${file}\0${st.size}\0${Math.floor(st.mtimeMs)}`).digest("hex");
    for (const ext of Object.values(EXT)) {
      const hit = join(this.cache.dir, key + ext);
      if (existsSync(hit)) return Promise.resolve(hit);
    }
    // The original stands in for a picture no preview could be made of (a corrupt or odd file, one that took too long
    // or took the worker down): not tried again.
    if (existsSync(join(this.cache.dir, `${key}.none`))) return Promise.resolve(undefined);
    let p = this.inflight.get(key);
    if (!p) {
      p = this.make(file, type, key).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private make(file: string, type: string, key: string): Promise<string | undefined> {
    const run = this.queue.then(async () => {
      let r = await this.ask({ file, type });
      // The worker itself failed (it could not start here, or went down): this picture is made on the hub's own
      // thread instead, which only waits longer.
      if (r.worker) r = here(file, type);
      if (!r.data || !r.type || !EXT[r.type]) {
        this.cache.put(`${key}.none`, r.error ?? "");
        return undefined;
      }
      this.cache.put(key + EXT[r.type], Buffer.from(r.data));
      return join(this.cache.dir, key + EXT[r.type]);
    });
    this.queue = run.catch(() => {});
    return run.catch(() => undefined);
  }

  private ask(job: Omit<PreviewJob, "id">): Promise<Answer> {
    const worker = this.start();
    clearTimeout(this.idle);
    const id = ++this.seq;
    return new Promise<Answer>((resolve) => {
      const timer = setTimeout(() => {
        // A picture that never finishes: the worker goes with it, the next one starts afresh.
        this.pending.delete(id);
        this.stop();
        resolve({ id, error: "timeout" });
      }, JOB_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      worker.postMessage({ ...job, id } satisfies PreviewJob);
    }).finally(() => {
      if (!this.pending.size) this.idle = setTimeout(() => this.stop(), IDLE_MS).unref();
    });
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(this.script);
    w.unref();
    w.on("message", (r: PreviewReply) => {
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      clearTimeout(p.timer);
      p.resolve(r);
    });
    const failed = (reason: string) => {
      if (this.worker === w) this.worker = undefined;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ id, error: reason, worker: true });
      }
      this.pending.clear();
    };
    w.on("error", (e) => {
      console.warn(`[previews] the preview worker failed: ${e.message || String(e)}`);
      failed(e.message || "the preview worker failed");
    });
    w.on("exit", () => failed("the preview worker stopped"));
    this.worker = w;
    return w;
  }

  /** The hub stops (or the worker idles): the worker goes. */
  stop(): void {
    clearTimeout(this.idle);
    const w = this.worker;
    this.worker = undefined;
    void w?.terminate();
  }

  prune(): void {
    this.cache.prune();
  }
}

/** One picture's preview made on this thread (the worker could not). */
function here(file: string, type: string): PreviewReply & { worker?: boolean } {
  try {
    const p = makePreview(readFileSync(file), type);
    return p ? { id: 0, data: p.data, type: p.type } : { id: 0 };
  } catch (e) {
    return { id: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
