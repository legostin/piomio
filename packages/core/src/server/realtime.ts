// The realtime sockets (/api/ws) this replica serves from its own event bus, and the heartbeat every realtime socket
// gets. A socket only hears the replica it is attached to, so when the lead moves the sockets move too: a replica
// that stops leading closes the ones it served (they reconnect and land on the new leader), and a standby that finds
// its leader closes those it served while it had none.
// A socket a standby passes on to the leader (server/forward.ts) hears only the replica it was passed to: once that one
// no longer leads, the socket reconnects too. The other replica does not close it in every case: a window opened in the
// second a starting replica still takes a peer that just stepped down for the leader stays attached to that peer.

import WebSocket from "ws";

/** "Service restart": the client reconnects at once (lib/socket.ts, the app's Realtime). */
const MOVED = 1012;
const PING_MS = 25_000;

interface Served {
  socket: WebSocket;
  /** True when a socket opened now would go to the leader instead of being served here. */
  relays: () => boolean;
}

interface Relayed {
  socket: WebSocket;
  /** True once the replica the socket was passed to is not the leader this replica would pass a socket to now. */
  moved: () => boolean;
}

export class RealtimeSockets {
  private readonly served = new Set<Served>();
  private readonly relayed = new Set<Relayed>();

  add(socket: WebSocket, relays: () => boolean): void {
    const s: Served = { socket, relays };
    this.served.add(s);
    socket.once("close", () => this.served.delete(s));
  }

  /** A socket this replica passes on to the leader instead of serving it. */
  relay(socket: WebSocket, moved: () => boolean): void {
    const r: Relayed = { socket, moved };
    this.relayed.add(r);
    socket.once("close", () => this.relayed.delete(r));
  }

  get size(): number {
    return this.served.size;
  }

  get relayedSize(): number {
    return this.relayed.size;
  }

  /** This replica no longer leads: what it served reconnects, to the leader. */
  closeAll(): void {
    for (const s of [...this.served]) this.close(s);
  }

  /**
   * The sockets that are in the wrong place now reconnect: those a standby served while it had no leader to pass them
   * to, and those passed on to a replica that no longer leads (this one took the lead, or another did).
   */
  closeMoved(): void {
    for (const s of [...this.served]) if (s.relays()) this.close(s);
    for (const r of [...this.relayed]) {
      if (!r.moved()) continue;
      this.relayed.delete(r);
      this.end(r.socket);
    }
  }

  private close(s: Served): void {
    this.served.delete(s);
    this.end(s.socket);
  }

  private end(socket: WebSocket): void {
    if (socket.readyState === WebSocket.OPEN) socket.close(MOVED, "hub moved");
    else socket.terminate();
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
