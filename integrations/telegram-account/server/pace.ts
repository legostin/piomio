// The pause between requests to Telegram. An account that asks too often is refused for a while (FLOOD_WAIT), and
// agents ask in bursts: a list of chats, then several chats at once. So requests leave one at a time, no closer than
// a gap, in the order they were asked; whoever asked waits for their turn.

/**
 * Which requests wait their turn: what the tools and the card ask (chats, messages, sending). Not the parts of a file
 * being moved (the library has its own limit for those: a download is hundreds of them), not the stream of updates
 * that brings new messages, and not signing in.
 */
export const isPaced = (method: string): boolean => !/^(upload|updates|auth|help)\.|^account\.getPassword$/.test(method);

export interface PaceOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class Pace {
  private gapMs: number;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  /** The turn of the request asked last: the next one goes after it. */
  private line: Promise<void> = Promise.resolve();
  private last = -Infinity;

  constructor(gapMs: number, o: PaceOptions = {}) {
    this.gapMs = gapMs;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Resolves when the caller's request may leave. */
  wait(): Promise<void> {
    const turn = this.line.then(async () => {
      const early = this.last + this.gapMs - this.now();
      if (early > 0) await this.sleep(early);
      this.last = this.now();
    });
    this.line = turn;
    return turn;
  }
}
