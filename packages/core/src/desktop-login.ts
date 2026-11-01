// The desktop app signs its own window in: it hands the hub one-time tickets over the hub's stdin, a pipe only the
// app that started the hub holds (PIOMIO_DESKTOP=1). The window then posts its ticket to POST /api/auth/desktop.

import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

const TICKET_TTL_MS = 60_000;
const hash = (ticket: string) => createHash("sha256").update(ticket).digest("hex");

/** One-time sign-in tickets, in memory only: a restart forgets them. */
export class DesktopTickets {
  private tickets = new Map<string, number>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  add(ticket: string): void {
    if (!/^[\w-]{32,128}$/.test(ticket)) return;
    const now = this.now();
    for (const [h, expires] of this.tickets) if (expires <= now) this.tickets.delete(h);
    this.tickets.set(hash(ticket), now + TICKET_TTL_MS);
  }

  /** True once per ticket, while it is fresh. */
  consume(ticket: string): boolean {
    const h = hash(ticket);
    const expires = this.tickets.get(h);
    this.tickets.delete(h);
    return expires !== undefined && expires > this.now();
  }
}

/**
 * The app's lines on stdin: `stop` (Windows has no SIGTERM for a windowless child), `ticket <t>` and
 * `update-failed <why>` (the Update button's install did not happen: self-update.ts). The app closing the pipe (it
 * quit or crashed) stops the hub too, so the hub never outlives it.
 */
export function readDesktopCommands(input: Readable, on: { stop: () => void; ticket: (t: string) => void; updateFailed?: (why: string) => void }): void {
  const lines = createInterface({ input });
  lines.on("line", (line) => {
    const [, cmd, arg = ""] = /^(\S+)\s*(.*)$/.exec(line.trim()) ?? [];
    if (cmd === "stop") on.stop();
    else if (cmd === "ticket" && arg) on.ticket(arg);
    else if (cmd === "update-failed") on.updateFailed?.(arg.slice(0, 500));
  });
  lines.on("close", () => on.stop());
}
