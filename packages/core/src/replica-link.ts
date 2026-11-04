// One lasting connection between two replicas (cluster.ts), whichever of them could dial it: a machine behind NAT or
// a link that some networks cannot reach (Funnel) still talks to a replica with a public address, and everything goes
// both ways over it — the replicas' own calls, and the phones' requests and WebSockets a standby forwards to the leader.

import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import WebSocket from "ws";
import { createRpcPeer, wsTransport, type RpcPeer, type WsLike } from "@piomio/shared";
import { pinMatches, pinnedAgent, pinnedRequest, signRequest, type ReplicaKey } from "@piomio/replica";

export const LINK_PATH = "/api/replica/link";

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
  /** The main app (machines' /node/ws and /mcp), on loopback. */
  mainUrl(): string;
  fingerprint(): string;
}

const pinOk = (s: unknown, fingerprint: string) => pinMatches(s as TLSSocket, fingerprint);

/** Serves a link: the peer's calls, and its forwarded HTTP requests and WebSockets to this replica's device app. */
export function serveLink(rpc: RpcPeer, from: string, server: LinkServer): void {
  rpc.handle("replica.call", (c: LinkCall) => server.call(from, c));
  rpc.handle("replica.http", async (r: { app?: "main" | "device"; method: string; path: string; headers: Record<string, string>; body?: string }) => {
    const main = r.app === "main";
    const res = await pinnedRequest(`${main ? server.mainUrl() : server.deviceUrl()}${r.path}`, {
      method: r.method,
      headers: main ? { ...r.headers, host: new URL(server.mainUrl()).host } : r.headers,
      body: r.body ? Buffer.from(r.body, "base64") : "",
      ...(main ? {} : { fingerprint: server.fingerprint() }),
      timeoutMs: 6 * 3600_000,
    });
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined && !/^(connection|keep-alive|transfer-encoding|content-length)$/i.test(k)) headers[k] = v;
    return { status: res.status, headers, body: res.body.toString("base64") };
  });
  const sockets = new Map<string, WebSocket>();
  rpc.handle("replica.ws.open", (r: { app?: "main" | "device"; id: string; path: string; headers: Record<string, string> }) => {
    const main = r.app === "main";
    const base = (main ? server.mainUrl() : server.deviceUrl()).replace(/^http/, "ws");
    const ws = new WebSocket(`${base}${r.path}`, { headers: r.headers, ...(main ? {} : { rejectUnauthorized: false, agent: pinnedAgent }), handshakeTimeout: 10_000 });
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

/** A forwarded HTTP request over a link: the leader's device app answers it. */
export async function linkHttp(
  rpc: RpcPeer,
  r: { app?: "main" | "device"; method: string; path: string; headers: Record<string, string>; body: Buffer },
): Promise<{ status: number; headers: Record<string, string | string[]>; body: Buffer }> {
  const res = await rpc.request<{ status: number; headers: Record<string, string | string[]>; body: string }>(
    "replica.http",
    { app: r.app ?? "device", method: r.method, path: r.path, headers: r.headers, ...(r.body.length ? { body: r.body.toString("base64") } : {}) },
    { timeoutMs: 6 * 3600_000 },
  );
  return { status: res.status, headers: res.headers, body: Buffer.from(res.body, "base64") };
}
