// The hub checks that its own Node still does background work. On 2026-11-17 the thread pool of a running hub stopped
// taking work (file reads, DNS lookups, compression), while the event loop went on: pages opened, nothing was logged,
// and every agent hung, since the egress proxy could not resolve a host for its brains. Nothing inside such a process
// recovers, so the hub says what hangs and ends its process; what runs it (the desktop app, systemd) starts it again,
// and the turns it cut short are marked and taken up on the next start.

import { stat } from "node:fs/promises";

/** How often the pool is asked for a small piece of work. */
export const SELF_CHECK_MS = 30_000;
/** Checks in a row that find the last probe still unanswered before the pool counts as dead (two minutes). */
export const SELF_CHECK_MISSES = 4;

export interface SelfCheckOptions {
  /** A small piece of work; any answer, a failure too, shows the work was done. */
  probe: () => Promise<unknown>;
  misses?: number;
  /** Called once, with the number of checks the probe stayed unanswered. */
  onDead: (missed: number) => void;
}

/**
 * Counts checks, not seconds: a computer that slept, or a loop held up by a long task, fires its timers before it
 * hears the answers that came in meanwhile, so a late answer by the clock is still an answer by the next check.
 */
export class SelfCheck {
  private o: SelfCheckOptions;
  private misses: number;
  private asked = false;
  private missed = 0;
  private dead = false;
  private timer?: NodeJS.Timeout;

  constructor(o: SelfCheckOptions) {
    this.o = o;
    this.misses = o.misses ?? SELF_CHECK_MISSES;
  }

  /** One check: asks when nothing is asked, else counts the unanswered probe. */
  tick(): void {
    if (this.dead) return;
    if (this.asked) {
      if (++this.missed < this.misses) return;
      this.dead = true;
      this.o.onDead(this.missed);
      return;
    }
    this.asked = true;
    this.missed = 0;
    const answered = () => {
      this.asked = false;
    };
    this.o.probe().then(answered, answered);
  }

  start(everyMs = SELF_CHECK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), everyMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** Requests the thread pool serves, as process.getActiveResourcesInfo names them: files, name lookups, crypto jobs. */
const POOL_WORK = /^(FSReq|Get(Addr|Name)InfoReq)|REQUEST$/;

export interface ThreadPoolWatch {
  /** A folder that exists on a local disk (the hub's data folder). */
  dir: string;
  log: (message: string) => void;
  /**
   * Ends the process at once (SIGKILL to itself). Not process.exit(): Node joins the pool's threads on the way out,
   * so an exit waits for busy threads and never comes back from threads that no longer wake.
   */
  kill: () => void;
  /** Keeps what was pending (the audit log); a failure here never keeps the hub from ending. */
  record?: (data: { pending: Record<string, number> }) => void;
  probe?: () => Promise<unknown>;
  pending?: () => string[];
  misses?: number;
}

/**
 * Watches the thread pool with the cheapest work it does, a stat of the data folder. Not a DNS lookup: with the
 * network down those wait their turn behind lookups that take half a minute each, and a hub must not restart for that.
 */
export function watchThreadPool(o: ThreadPoolWatch): SelfCheck {
  return new SelfCheck({
    probe: o.probe ?? (() => stat(o.dir)),
    misses: o.misses,
    onDead: (missed) => {
      const pending: Record<string, number> = {};
      for (const name of (o.pending ?? (() => process.getActiveResourcesInfo()))()) if (POOL_WORK.test(name)) pending[name] = (pending[name] ?? 0) + 1;
      const list = Object.entries(pending).map(([name, n]) => `${name}×${n}`).join(", ") || "nothing listed";
      o.log(`the thread pool stopped taking work (a file read unanswered for ${missed} checks; pending: ${list}): the hub restarts`);
      try {
        o.record?.({ pending });
      } catch {
        /* the restart matters more */
      }
      o.kill();
    },
  });
}
