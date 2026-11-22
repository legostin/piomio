// Keeps Node's thread pool from freezing on macOS. Its workers wait for work on one condition variable, and macOS
// stops delivering that variable's signals once one waiter has sat out about 2^23 waits of the others (libuv#5280,
// Apple FB25289447; seen on macOS 26 and 27): every worker then stays parked with work in the queue, so file reads,
// DNS lookups and compression never finish while timers and sockets go on. A pool that serves one job at a time, as
// a file scan does, wakes its workers in turn and can leave one of them parked for millions of jobs.
// One short job per worker, posted together, wakes every parked worker, and each then waits afresh.

import { pbkdf2 } from "node:crypto";

/**
 * How often the workers are woken. A process that does nothing but pool work gets through about 100 000 waits a
 * second, so a quarter of a minute stays well short of the 8 million that strand a worker.
 */
export const POOL_WAKE_MS = 15_000;

/** libuv's pool: four threads unless UV_THREADPOOL_SIZE asks for more (1024 at most). */
export function threadPoolSize(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.UV_THREADPOOL_SIZE ?? "", 10);
  return n > 0 ? Math.min(n, 1024) : 4;
}

/**
 * About a millisecond of work for one pool thread: long enough that a worker woken for the first job of a round is
 * still busy when the last one is posted, so the last signal goes to a worker that was parked, not back to the first.
 */
function spin(done: () => void): void {
  pbkdf2("pool", "wake", 2000, 16, "sha256", done);
}

/** One round: a job per pool thread, all posted in this tick. */
export function wakeThreadPool(threads = threadPoolSize(), job: (done: () => void) => void = spin, done: () => void = () => {}): void {
  for (let i = 0; i < threads; i++) job(done);
}

export interface KeepThreadPoolAwake {
  platform?: string;
  everyMs?: number;
  wake?: () => void;
}

/** Wakes the pool's workers every POOL_WAKE_MS for as long as the process runs. macOS only; returns how to stop. */
export function keepThreadPoolAwake(o: KeepThreadPoolAwake = {}): (() => void) | undefined {
  if ((o.platform ?? process.platform) !== "darwin") return undefined;
  const wake = o.wake ?? (() => wakeThreadPool());
  const timer = setInterval(wake, o.everyMs ?? POOL_WAKE_MS);
  timer.unref();
  return () => clearInterval(timer);
}
