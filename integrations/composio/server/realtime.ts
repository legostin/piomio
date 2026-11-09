// Composio's realtime channel: the Pusher channel its SDK listens to when there is no webhook. Composio calls it
// internal (undocumented, may change), so the integration uses it only when the hub has no public https address.
//
// Only the few frames needed are spoken, over Node's own WebSocket (through the hub's egress proxy, *.pusher.com):
// connect to ws-<cluster>.pusher.com, read the socket id from pusher:connection_established, have Composio authorise
// the private channel for that socket, subscribe, answer pings (and ping a quiet connection), and connect again with a
// growing pause when the socket drops. Large events come in chunks (chunked-trigger_to_client) and are put back
// together here; every complete event goes to `onEvent` as parsed JSON. A problem that may repeat (a refused
// authorisation, a reconnect, a frame left out) is logged with a reason, so the plugin says it at most once in a while,
// and never with an event's content: a refusal says only the status Composio or Pusher answered.

import type { RealtimeCredentials } from "./api.ts";

/** The pause before the first reconnect, and the longest. */
const RECONNECT_MS = 1000;
const RECONNECT_MAX_MS = 60_000;
/** How long the server may stay quiet before it is pinged (Pusher's activity_timeout, at most), and the pong waited for. */
const ACTIVITY_MAX_S = 120;
const PONG_MS = 30_000;
/** How long a new connection may take to say pusher:connection_established. */
const HANDSHAKE_MS = 30_000;
/** A frame longer than this is not even parsed. */
const FRAME_MAX = 1024 * 1024;
/** Chunked events: at most this many in progress, this long each, this many chunks and characters. */
const PENDING_MAX = 5;
const PENDING_MS = 60_000;
const CHUNKS_MAX = 1000;
const CHUNKED_TEXT_MAX = 300 * 1024;
const TRIGGER_EVENT = "trigger_to_client";
const CHUNKED_EVENT = `chunked-${TRIGGER_EVENT}`;
const CLUSTER_RE = /^[a-z0-9-]{1,40}$/;
const KEY_RE = /^[A-Za-z0-9_-]{1,100}$/;

export interface RealtimeDeps {
  credentials(): Promise<RealtimeCredentials>;
  /** Composio's authorisation of `channel` for `socketId`. */
  auth(socketId: string, channel: string): Promise<string>;
  /** A complete event from the channel. */
  onEvent(event: unknown): void;
  /** `reason`: the line names a problem that may repeat (every reconnect), logged at most once in a while per reason. */
  log(level: "info" | "warn", msg: string, reason?: string): void;
  /** Where the socket goes instead of wss://ws-<cluster>.pusher.com (tests only). */
  base?: string;
  /** The first reconnect pause (tests). */
  reconnectMs?: number;
  /** How long a connection may take to be established (tests). */
  handshakeMs?: number;
}

interface Chunked {
  parts: string[];
  count: number;
  size: number;
  total?: number;
  at: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** The HTTP status a refusal came with (a ComposioError's, Pusher's), when it has one. */
const statusOf = (v: unknown): number | undefined => {
  const n = Number((v as { status?: unknown } | null)?.status);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/** JSON text parsed, anything else as it is (Pusher sends `data` as a JSON string). */
function parsed(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

export class RealtimeChannel {
  private d: RealtimeDeps;
  private running = false;
  private ws: WebSocket | undefined;
  /** Bumped for every socket: handlers of an earlier one do nothing. */
  private gen = 0;
  private attempt = 0;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private quiet: ReturnType<typeof setTimeout> | undefined;
  private pong: ReturnType<typeof setTimeout> | undefined;
  private handshake: ReturnType<typeof setTimeout> | undefined;
  private activityMs = ACTIVITY_MAX_S * 1000;
  private chunks = new Map<string, Chunked>();
  /** The channel is subscribed on the current socket. */
  subscribed = false;

  constructor(d: RealtimeDeps) {
    this.d = d;
  }

  /** Opens the channel (and keeps it open) until stop(); calling it again does nothing. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    void this.connect();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.reconnect);
    this.reconnect = undefined;
    this.drop();
    this.chunks.clear();
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    const gen = ++this.gen;
    let creds: RealtimeCredentials;
    try {
      creds = await this.d.credentials();
      if (!CLUSTER_RE.test(creds.cluster) || !KEY_RE.test(creds.pusherKey)) throw new Error("Composio gave realtime credentials of an unexpected form");
    } catch (e) {
      if (gen !== this.gen || !this.running) return;
      this.d.log("warn", `composio: the realtime channel's credentials could not be read: ${message(e)}`, "realtime-credentials");
      return this.later();
    }
    if (gen !== this.gen || !this.running) return;
    const channel = `private-${creds.projectId}_triggers`;
    const base = (this.d.base || `wss://ws-${creds.cluster}.pusher.com`).replace(/\/+$/, "");
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${base}/app/${creds.pusherKey}?protocol=7&client=js&version=8.4.0&flash=false`);
    } catch (e) {
      this.d.log("warn", `composio: the realtime channel could not connect: ${message(e)}`, "realtime-connect");
      return this.later();
    }
    this.ws = ws;
    this.subscribed = false;
    const mine = () => gen === this.gen && this.ws === ws;
    // A connection that never says it is established is given up and made again.
    this.handshake = setTimeout(() => {
      if (!mine()) return;
      this.d.log("warn", "composio: the realtime channel did not answer in time; connecting again", "realtime-silent");
      this.drop();
      this.later();
    }, this.d.handshakeMs ?? HANDSHAKE_MS);
    this.handshake.unref?.();
    ws.onmessage = (ev) => {
      if (mine()) this.frame(ws, channel, String(ev.data));
    };
    ws.onclose = (ev) => {
      if (!mine()) return;
      this.ws = undefined;
      this.subscribed = false;
      this.clearTimers();
      if (!this.running) return;
      // Pusher's 4000-4099: do not come back unchanged (the credentials are read again, after the longest pause).
      if (ev.code >= 4000 && ev.code < 4100) this.attempt = Math.max(this.attempt, 16);
      else if (ev.code >= 4200 && ev.code < 4300) this.attempt = 0;
      this.d.log("warn", `composio: the realtime channel closed (${ev.code}${ev.reason ? ` ${ev.reason.slice(0, 120)}` : ""}); connecting again`, "realtime-closed");
      this.later();
    };
    ws.onerror = () => {
      // A close follows.
    };
  }

  /** The next try, after a pause that grows with each failed one. */
  private later(): void {
    if (!this.running) return;
    clearTimeout(this.reconnect);
    const first = this.d.reconnectMs ?? RECONNECT_MS;
    const wait = Math.min(first * 2 ** Math.min(this.attempt, 16), Math.max(first, RECONNECT_MAX_MS));
    this.attempt++;
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      void this.connect();
    }, wait);
    this.reconnect.unref?.();
  }

  /** Closes the current socket without its close handler (a stop, or a connection that stopped answering). */
  private drop(): void {
    const ws = this.ws;
    this.ws = undefined;
    this.subscribed = false;
    this.gen++;
    this.clearTimers();
    if (!ws) return;
    ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  private clearTimers(): void {
    clearTimeout(this.quiet);
    clearTimeout(this.pong);
    clearTimeout(this.handshake);
    this.quiet = this.pong = this.handshake = undefined;
  }

  /** Every frame counts as life: the server is pinged only after it was quiet for activity_timeout. */
  private alive(ws: WebSocket): void {
    clearTimeout(this.quiet);
    clearTimeout(this.pong);
    this.pong = undefined;
    this.quiet = setTimeout(() => {
      this.send(ws, "pusher:ping", {});
      this.pong = setTimeout(() => {
        if (this.ws !== ws) return;
        this.d.log("warn", "composio: the realtime channel stopped answering; connecting again", "realtime-silent");
        this.drop();
        this.later();
      }, PONG_MS);
      this.pong.unref?.();
    }, this.activityMs);
    this.quiet.unref?.();
  }

  private send(ws: WebSocket, event: string, data: unknown): void {
    try {
      ws.send(JSON.stringify({ event, data }));
    } catch {
      /* the close handler reconnects */
    }
  }

  private frame(ws: WebSocket, channel: string, text: string): void {
    if (text.length > FRAME_MAX) {
      this.alive(ws);
      this.d.log("warn", `composio: a frame over ${FRAME_MAX / 1024} KB from the realtime channel was left out`, "channel-frame-size");
      return;
    }
    let f: { event?: unknown; data?: unknown; channel?: unknown };
    try {
      f = JSON.parse(text);
    } catch {
      this.d.log("warn", "composio: a frame from the realtime channel is not JSON; left out", "channel-frame");
      return;
    }
    this.alive(ws);
    const data = parsed(f.data);
    switch (f.event) {
      case "pusher:connection_established": {
        const d = (data ?? {}) as { socket_id?: unknown; activity_timeout?: unknown };
        const t = Number(d.activity_timeout);
        if (Number.isFinite(t) && t > 0) this.activityMs = Math.min(t, ACTIVITY_MAX_S) * 1000;
        clearTimeout(this.handshake);
        this.handshake = undefined;
        this.alive(ws);
        const socketId = typeof d.socket_id === "string" ? d.socket_id : "";
        if (!socketId) return ws.close();
        void this.d.auth(socketId, channel).then(
          (auth) => {
            if (this.ws === ws) this.send(ws, "pusher:subscribe", { channel, auth });
          },
          (e) => {
            if (this.ws !== ws) return;
            // The status only: what Composio says with it is not needed to tell why, and is not kept.
            const status = statusOf(e);
            this.d.log(
              "warn",
              status ? `composio: Composio refused the realtime channel's authorisation (HTTP ${status})` : "composio: the realtime channel's authorisation could not be asked for (no answer from Composio)",
              "realtime-auth",
            );
            ws.close();
          },
        );
        return;
      }
      case "pusher_internal:subscription_succeeded":
        if (f.channel !== channel) return;
        if (!this.subscribed) this.d.log("info", "composio: listening to the apps' events on Composio's realtime channel");
        this.subscribed = true;
        this.attempt = 0;
        return;
      case "pusher:subscription_error": {
        const status = statusOf(data);
        this.d.log("warn", `composio: Pusher refused the realtime channel's subscription (${status ? `HTTP ${status}` : "no status"})`, "realtime-auth");
        ws.close();
        return;
      }
      case "pusher:error": {
        const code = Number((data as { code?: unknown } | null)?.code);
        this.d.log(
          "warn",
          `composio: the realtime channel reported an error${Number.isFinite(code) ? ` ${code}` : ""}: ${String((data as { message?: unknown } | null)?.message ?? "").slice(0, 300)}`,
          "realtime-error",
        );
        if (code >= 4000 && code < 4100) this.attempt = Math.max(this.attempt, 16);
        return;
      }
      case "pusher:ping":
        this.send(ws, "pusher:pong", {});
        return;
      case TRIGGER_EVENT:
        if (f.channel === channel) this.d.onEvent(data);
        return;
      case CHUNKED_EVENT:
        if (f.channel === channel) this.chunk(data);
        return;
    }
  }

  /** One chunk of a large event; the event goes on once every chunk up to the final one is there. */
  private chunk(d: unknown): void {
    const c = d as { id?: unknown; index?: unknown; chunk?: unknown; final?: unknown } | null;
    const id = c?.id;
    const index = c?.index;
    if (typeof id !== "string" || !id || typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= CHUNKS_MAX || typeof c!.chunk !== "string") {
      this.d.log("warn", "composio: an invalid chunked trigger event from the realtime channel was left out", "channel-chunk-invalid");
      return;
    }
    const now = Date.now();
    for (const [k, p] of this.chunks) if (now - p.at > PENDING_MS) this.chunks.delete(k);
    let p = this.chunks.get(id);
    if (!p) {
      if (this.chunks.size >= PENDING_MAX) this.chunks.delete(this.chunks.keys().next().value!);
      this.chunks.set(id, (p = { parts: [], count: 0, size: 0, at: now }));
    }
    if (p.parts[index] === undefined) {
      p.parts[index] = c!.chunk;
      p.count++;
      p.size += c!.chunk.length;
    }
    if (p.size > CHUNKED_TEXT_MAX) {
      this.chunks.delete(id);
      this.d.log("warn", `composio: a chunked trigger event over ${CHUNKED_TEXT_MAX / 1024} KB from the realtime channel was left out`, "channel-chunk-size");
      return;
    }
    if (c!.final === true) p.total = index + 1;
    if (p.total === undefined || p.count < p.total) return;
    for (let i = 0; i < p.total; i++) if (p.parts[i] === undefined) return;
    this.chunks.delete(id);
    try {
      this.d.onEvent(JSON.parse(p.parts.slice(0, p.total).join("")));
    } catch {
      this.d.log("warn", "composio: a chunked trigger event from the realtime channel is not JSON; left out", "channel-chunk-json");
    }
  }
}
