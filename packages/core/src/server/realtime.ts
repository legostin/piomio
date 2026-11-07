// The realtime sockets (/api/ws) this replica serves from its own event bus, and the heartbeat every realtime socket
// gets. A socket only hears the replica it is attached to, so when the lead moves the sockets move too: a replica
// that stops leading closes the ones it served (they reconnect and land on the new leader), and a standby that finds
// its leader closes those it served while it had none.

import WebSocket from "ws";

/** "Service restart": the client reconnects at once (lib/socket.ts, the app's Realtime). */
const MOVED = 1012;
const PING_MS = 25_000;

interface Served {
  socket: WebSocket;
  /** True when a socket opened now would go to the leader instead of being served here. */
  relays: () => boolean;
}

export class RealtimeSockets {
  private readonly served = new Set<Served>();

  add(socket: WebSocket, relays: () => boolean): void {
    const s: Served = { socket, relays };
    this.served.add(s);
    socket.once("close", () => this.served.delete(s));
  }

  get size(): number {
    return this.served.size;
  }

  /** This replica no longer leads: what it served reconnects, to the leader. */
  closeAll(): void {
    for (const s of [...this.served]) this.close(s);
  }

  /** A standby that can reach its leader now: the sockets it served meanwhile reconnect, to the leader. */
  closeMoved(): void {
    for (const s of [...this.served]) if (s.relays()) this.close(s);
  }

  private close(s: Served): void {
    this.served.delete(s);
    if (s.socket.readyState === WebSocket.OPEN) s.socket.close(MOVED, "hub moved");
    else s.socket.terminate();
  }
}

/**
 * Pings the client every PING_MS: one that answered nothing since the previous ping (a phone that slept, lost its
 * network or its Tailscale path) is gone, and its socket is dropped instead of waiting out TCP for many minutes.
 * Browsers and URLSession answer pings by themselves; any frame from the client counts as an answer too.
 */
export function keepAlive(socket: WebSocket, ms = PING_MS): void {
  let heard = true;
  const alive = () => (heard = true);
  socket.on("pong", alive);
  socket.on("message", alive);
  const timer = setInterval(() => {
    if (!heard) return socket.terminate();
    heard = false;
    try {
      socket.ping();
    } catch {
      socket.terminate();
    }
  }, ms);
  timer.unref?.();
  socket.once("close", () => clearInterval(timer));
}

/** The page's own heartbeat (lib/socket.ts): a browser cannot see pings, so it asks, and hears back. */
export function isPing(raw: unknown): boolean {
  const s = String(raw);
  if (s.length > 64 || !s.includes('"ping"')) return false;
  try {
    return (JSON.parse(s) as { type?: unknown })?.type === "ping";
  } catch {
    return false;
  }
}

export const PONG = JSON.stringify({ type: "pong" });
