// One lasting connection between two replicas (cluster.ts), whichever of them could dial it: a machine behind NAT or
// a link that some networks cannot reach (Funnel) still talks to a replica with a public address, and everything goes
// both ways over it — the replicas' own calls, and the requests and WebSockets a standby forwards to the leader: the
// phones', the machines', and its own web UI's.

import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import WebSocket from "ws";
import { createRpcPeer, wsTransport, type RpcPeer, type WsLike } from "@piomio/shared";
import { pinMatches, pinnedAgent, pinnedRequest, signRequest, type ReplicaKey } from "@piomio/replica";
import type { AuthSession } from "./auth.ts";

export const LINK_PATH = "/api/replica/link";

/**
 * A standby's web UI works on the leader: the standby checks the session, CSRF token and origin, and sends the call
 * with that session over the link. The leader's main app takes the session only next to its own mark, which never
 * leaves its process (main-app.ts), so a client can't claim one by sending these headers itself.
 */
export const LINK_MARK = "x-piomio-link";
export const LINK_SESSION = "x-piomio-session";
/** A forwarded request's body stays under this, so it fits one link message (64 MB frames, base64). */
export const MAX_LINK_BODY = 40 * 1024 * 1024;
/** A forwarded answer bigger than this travels in pieces: no frame too big, and other calls don't wait long behind it. */
const HTTP_PIECE = 8 * 1024 * 1024;
/** How long a piece-wise answer waits for its next piece. */
const HELD_MS = 120_000;

/** A replica call as it would go over HTTP: what the device-app routes answer. */
export interface LinkCall {
  method: string;
  path: string;
  body?: unknown;
}

export interface LinkAnswer {
  status: number;
  /** JSON, or base64 of bytes when `binary`. */
  body: unknown;
  binary?: boolean;
  /** A piece of a file: the whole file's size. */
  total?: number;
}

export interface LinkServer {
  /** The replica calls (hello, changes, files…), by path. */
  call(from: string, c: LinkCall): Promise<LinkAnswer>;
  /** The device app on this replica, for requests a standby forwards here. */
  deviceUrl(): string;
  /** The main app (machines' /node/ws and /mcp, a standby's web UI), on loopback. */
  mainUrl(): string;
  /** What the main app takes as proof that a call came over a link (LINK_MARK). */
  mark(): string;
  fingerprint(): string;
}

/** What a standby sends for the main app: a call, or a WebSocket, and the session it checked for it (web UI only). */
interface MainCall {
  app?: "main" | "device";
  headers: Record<string, string>;
  session?: AuthSession;
}

const pinOk = (s: unknown, fingerprint: string) => pinMatches(s as TLSSocket, fingerprint);

/** Serves a link: the peer's calls, and its forwarded HTTP requests and WebSockets to this replica's apps. */
export function serveLink(rpc: RpcPeer, from: string, server: LinkServer): void {
  rpc.handle("replica.call", (c: LinkCall) => server.call(from, c));
  /** Headers for the main app: never a peer's own x-piomio-*; the mark goes with the session the peer vouches for. */
  const mainHeaders = (r: MainCall): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers)) if (!k.toLowerCase().startsWith("x-piomio-")) out[k] = v;
    if (r.session) {
      out[LINK_MARK] = server.mark();
      out[LINK_SESSION] = JSON.stringify(r.session);
    }
    return out;
  };
  const held = new Map<string, { body: Buffer; timer: NodeJS.Timeout }>();
  const hold = (id: string, body: Buffer) => {
    clearTimeout(held.get(id)?.timer);
    const timer = setTimeout(() => held.delete(id), HELD_MS);
    timer.unref();
    held.set(id, { body, timer });
  };
  rpc.handle("replica.http", async (r: MainCall & { method: string; path: string; body?: string; pieces?: boolean }) => {
    const main = r.app === "main";
    const res = await pinnedRequest(`${main ? server.mainUrl() : server.deviceUrl()}${r.path}`, {
      method: r.method,
      headers: main ? { ...mainHeaders(r), host: new URL(server.mainUrl()).host } : r.headers,
      body: r.body ? Buffer.from(r.body, "base64") : "",
      ...(main ? {} : { fingerprint: server.fingerprint() }),
      timeoutMs: 6 * 3600_000,
    });
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined && !/^(connection|keep-alive|transfer-encoding|content-length)$/i.test(k)) headers[k] = v;
    // A peer that asks for pieces gets a big answer piece by piece (an older one gets it whole, as before).
    if (r.pieces && res.body.length > HTTP_PIECE) {
      const rest = randomUUID();
      hold(rest, res.body);
      return { status: res.status, headers, body: res.body.subarray(0, HTTP_PIECE).toString("base64"), total: res.body.length, rest };
    }
    return { status: res.status, headers, body: res.body.toString("base64") };
  });
  rpc.handle("replica.http.piece", (p: { rest: string; offset: number }) => {
    const h = held.get(p.rest);
    if (!h) throw new Error("the answer is gone");
    const offset = Number(p.offset) || 0;
    const piece = h.body.subarray(offset, offset + HTTP_PIECE);
    if (offset + piece.length >= h.body.length) {
      clearTimeout(h.timer);
      held.delete(p.rest);
    } else hold(p.rest, h.body);
    return { body: piece.toString("base64") };
  });
  const sockets = new Map<string, WebSocket>();
  rpc.handle("replica.ws.open", (r: MainCall & { id: string; path: string }) => {
    const main = r.app === "main";
    const base = (main ? server.mainUrl() : server.deviceUrl()).replace(/^http/, "ws");
    const ws = new WebSocket(`${base}${r.path}`, { headers: main ? mainHeaders(r) : r.headers, ...(main ? {} : { rejectUnauthorized: false, agent: pinnedAgent }), handshakeTimeout: 10_000 });
    if (!main) ws.on("upgrade", (res) => !pinOk(res.socket, server.fingerprint()) && ws.terminate());
    sockets.set(r.id, ws);
    ws.on("message", (d, binary) => rpc.notify("replica.ws.msg", { id: r.id, data: binary ? Buffer.from(d as Buffer).toString("base64") : String(d), binary }));
    const gone = () => {
      if (!sockets.has(r.id)) return;
      sockets.delete(r.id);
      rpc.notify("replica.ws.close", { id: r.id });
    };
    ws.on("close", gone);
    ws.on("error", gone);
    return {};
  });
  rpc.onNotification("replica.ws.msg", (m: { id: string; data: string; binary?: boolean }) => {
    const ws = sockets.get(m.id);
    if (!ws) return;
    const send = () => ws.send(m.binary ? Buffer.from(m.data, "base64") : m.data);
    if (ws.readyState === WebSocket.OPEN) send();
    else ws.once("open", send);
  });
  rpc.onNotification("replica.ws.close", (m: { id: string }) => {
    const ws = sockets.get(m.id);
    sockets.delete(m.id);
    ws?.close();
  });
  rpc.onClose(() => {
    for (const ws of sockets.values()) ws.terminate();
    sockets.clear();
    for (const h of held.values()) clearTimeout(h.timer);
    held.clear();
  });
}

/** Dials a peer's link (any of its addresses); resolves with the connected socket, or rejects. */
export function dialLink(o: { url: string; key: ReplicaKey; fingerprint: string; timeoutMs?: number }): Promise<WebSocket> {
  const url = `${o.url.replace(/\/$/, "").replace(/^http/, "ws")}${LINK_PATH}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { authorization: signRequest(o.key, "GET", LINK_PATH, "") },
      ...(url.startsWith("wss:") ? { rejectUnauthorized: false, agent: pinnedAgent } : {}),
      handshakeTimeout: o.timeoutMs ?? 8_000,
      maxPayload: 64 * 1024 * 1024,
    });
    ws.on("upgrade", (res) => {
      if (url.startsWith("wss:") && !pinOk(res.socket, o.fingerprint)) ws.terminate();
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("close", (code) => reject(new Error(`link closed (${code})`)));
  });
}

/**
 * An RPC peer over a link socket, with a ping so a dead connection is noticed. A peer busy sending (a file's piece on
 * a slow uplink) answers the ping only after it, so any bytes from it count as alive too; `onBytes` hears them.
 */
export function linkPeer(ws: WebSocket, o: { onBytes?: () => void; pingMs?: number } = {}): RpcPeer {
  const rpc = createRpcPeer(wsTransport(ws as unknown as WsLike));
  let alive = true;
  const heard = () => {
    alive = true;
    o.onBytes?.();
  };
  ws.on("pong", heard);
  // ws keeps the open connection's socket here; its "data" comes before a big frame is whole.
  (ws as unknown as { _socket?: Socket })._socket?.on("data", heard);
  const t = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    try {
      ws.ping();
    } catch {
      /* closing */
    }
  }, o.pingMs ?? 10_000);
  t.unref();
  ws.on("close", () => clearInterval(t));
  return rpc;
}

/** A forwarded HTTP request over a link: the leader's device app answers it, or its main app (`session`: the web UI's). */
export async function linkHttp(
  rpc: RpcPeer,
  r: { app?: "main" | "device"; method: string; path: string; headers: Record<string, string>; body: Buffer; session?: AuthSession },
): Promise<{ status: number; headers: Record<string, string | string[]>; body: Buffer }> {
  const res = await rpc.request<{ status: number; headers: Record<string, string | string[]>; body: string; total?: number; rest?: string }>(
    "replica.http",
    {
      app: r.app ?? "device",
      method: r.method,
      path: r.path,
      headers: r.headers,
      pieces: true,
      ...(r.session ? { session: r.session } : {}),
      ...(r.body.length ? { body: r.body.toString("base64") } : {}),
    },
    { timeoutMs: 6 * 3600_000 },
  );
  const pieces = [Buffer.from(res.body, "base64")];
  let got = pieces[0].length;
  while (res.rest && got < (res.total ?? 0)) {
    const p = await rpc.request<{ body: string }>("replica.http.piece", { rest: res.rest, offset: got }, { timeoutMs: HELD_MS });
    const piece = Buffer.from(p.body, "base64");
    if (!piece.length) throw new Error("the answer ended early");
    pieces.push(piece);
    got += piece.length;
  }
  return { status: res.status, headers: res.headers, body: Buffer.concat(pieces) };
}
