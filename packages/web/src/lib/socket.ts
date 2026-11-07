// Realtime connection to the hub (/api/ws) with reconnect + backoff and a heartbeat.
//
// The page only listens, so a connection that died without a close (a phone that slept or changed networks, a
// Tailscale path that went away) would never be noticed: nothing is ever written to it. The page sends {"type":"ping"}
// every PING_MS and the hub answers {"type":"pong"}; a socket that heard nothing since the previous ping is dropped
// and opened again. Coming back to the page (visible, online, the phone app's word) checks at once.

import type { UiEvent } from "@piomio/shared";
import { backoffDelay } from "./backoff";

export type ConnectionState = "connecting" | "open" | "reconnecting" | "offline";

export interface SocketHandlers {
  onEvent(e: UiEvent): void;
  onState(s: ConnectionState): void;
  /** Fired after a successful reconnect (not on the first connect): refetch state. */
  onReconnect(): void;
  /** Fired on the first connect: what the page loaded before the socket was open may have missed events. */
  onFirstOpen?(): void;
  /** The upgrade keeps failing: maybe the session expired. */
  onRepeatedFailure?(): void;
}

export interface SocketOptions {
  /** Heartbeat interval (ms). */
  pingMs?: number;
  /** How long a check on coming back waits for the hub's answer (ms). */
  probeMs?: number;
  /** The WebSocket constructor (tests). */
  WebSocket?: typeof WebSocket;
  url?: () => string;
}

const PING = JSON.stringify({ type: "ping" });

export class HubSocket {
  private ws?: WebSocket;
  private attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private pinger?: ReturnType<typeof setInterval>;
  private probe?: ReturnType<typeof setTimeout>;
  /** A ping went out and nothing came back since. */
  private waiting = false;
  /** This socket's hub answers pings (an older one, or an older leader behind a standby, does not: its silence means nothing). */
  private answers = false;
  private everOpened = false;
  private stopped = false;
  private queue: string[] = [];
  private h: SocketHandlers;
  private pingMs: number;
  private probeMs: number;
  private WS: typeof WebSocket;
  private url: () => string;

  constructor(h: SocketHandlers, o: SocketOptions = {}) {
    this.h = h;
    this.pingMs = o.pingMs ?? 25_000;
    this.probeMs = o.probeMs ?? 5_000;
    this.WS = o.WebSocket ?? WebSocket;
    this.url = o.url ?? (() => `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/ws`);
  }

  start(): void {
    this.stopped = false;
    this.connect();
    window.addEventListener("online", this.wake);
    document.addEventListener("visibilitychange", this.wake);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.stopBeat();
    window.removeEventListener("online", this.wake);
    document.removeEventListener("visibilitychange", this.wake);
    this.ws?.close(1000, "bye");
    this.ws = undefined;
  }

  send(msg: unknown): void {
    const s = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === this.WS.OPEN) this.ws.send(s);
    else if (this.queue.length < 200) this.queue.push(s);
  }

  /** Try now instead of waiting out the backoff (the phone app saw the hub come back). */
  retryNow(): void {
    this.wake();
  }

  /** Back on the page or the network: reconnect now, or check that the open socket still hears the hub. */
  private wake = () => {
    if (this.stopped || document.visibilityState === "hidden") return;
    const ws = this.ws;
    if (ws && ws.readyState === this.WS.OPEN) return this.check(ws);
    if (!ws || ws.readyState === this.WS.CLOSED || ws.readyState === this.WS.CLOSING) {
      if (ws) this.drop(ws);
      clearTimeout(this.timer);
      this.attempt = 0;
      this.connect();
    }
  };

  /** A ping now; no answer within probeMs and the socket is dead. */
  private check(ws: WebSocket): void {
    if (!this.answers || this.probe) return;
    this.ping(ws);
    this.probe = setTimeout(() => {
      this.probe = undefined;
      if (this.ws === ws && this.waiting) this.dead(ws);
    }, this.probeMs);
  }

  private ping(ws: WebSocket): void {
    this.waiting = true;
    try {
      ws.send(PING);
    } catch {
      this.dead(ws);
    }
  }

  private beat(ws: WebSocket): void {
    this.stopBeat();
    this.pinger = setInterval(() => {
      if (this.ws !== ws) return;
      // Nothing since the last ping (timers in a hidden tab are slowed, so it counts pings, not seconds).
      if (this.waiting && this.answers) return this.dead(ws);
      this.ping(ws);
    }, this.pingMs);
  }

  private stopBeat(): void {
    clearInterval(this.pinger);
    clearTimeout(this.probe);
    this.pinger = undefined;
    this.probe = undefined;
    this.waiting = false;
  }

  /** The socket hears nothing: let it go without waiting for its close (that may take minutes) and open another. */
  private dead(ws: WebSocket): void {
    if (this.ws !== ws || this.stopped) return;
    this.drop(ws);
    this.h.onState("reconnecting");
    clearTimeout(this.timer);
    this.attempt = 0;
    this.connect();
  }

  private drop(ws: WebSocket): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* already gone */
    }
    if (this.ws === ws) this.ws = undefined;
    this.stopBeat();
  }

  private connect(): void {
    if (this.stopped) return;
    this.h.onState(this.everOpened ? "reconnecting" : "connecting");
    this.answers = false;
    let ws: WebSocket;
    try {
      ws = new this.WS(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      const reconnected = this.everOpened;
      this.everOpened = true;
      this.attempt = 0;
      this.h.onState("open");
      for (const m of this.queue.splice(0)) ws.send(m);
      this.beat(ws);
      // The first ping says whether this hub answers them.
      this.ping(ws);
      if (reconnected) this.h.onReconnect();
      else this.h.onFirstOpen?.();
    };
    ws.onmessage = (ev) => {
      this.waiting = false;
      let e: UiEvent | { type: "pong" } | undefined;
      try {
        e = JSON.parse(String(ev.data)) as UiEvent | { type: "pong" };
      } catch {
        /* ignore malformed frames */
      }
      if (!e || typeof e.type !== "string") return;
      if (e.type === "pong") {
        this.answers = true;
        return;
      }
      this.h.onEvent(e as UiEvent);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.stopBeat();
      if (this.stopped) return;
      this.h.onState(this.attempt > 2 ? "offline" : "reconnecting");
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const delay = backoffDelay(this.attempt);
    this.attempt++;
    // Every third failure: the hub may be back with the session gone (it restarted), and the upgrade fails for good.
    if (this.attempt % 3 === 0) this.h.onRepeatedFailure?.();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
  }
}
