// A standby replica sends the phones on to the leader (cluster.ts): device-app requests and the app's WebSocket go
// through as they are (the phone's token is the same on every replica), so a phone may reach the hub at any
// replica's address. Machines connected here (/node/ws, /mcp) reach the leader the same way over the link, and so do
// this replica's own web UI and security console once it has checked who asks (relayToLeader). The replicas' own routes
// stay here.

import { randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from "fastify";
import WebSocket from "ws";
import type { RpcPeer } from "@piomio/shared";
import type { Hub } from "../app.ts";
import type { AuthSession, SessionKind } from "../auth.ts";
import { requestLocale, tFor } from "../i18n.ts";
import { LINK_MARK, LINK_SESSION, linkHttp, MAX_LINK_BODY, type LinkApp } from "../replica-link.ts";
import { pinMatches, pinnedAgent } from "@piomio/replica";

const HERE = /^\/api\/replica\//;
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);
/** Headers only replicas set (replica-link.ts LINK_MARK, LINK_SESSION): never passed on from a client. */
const OURS = /^x-piomio-/;

const pinOk = (s: TLSSocket, fingerprint: string): boolean => pinMatches(s, fingerprint);
const LOOPBACK = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;

/**
 * A web-UI or console call a standby sent over the link, with the session of that `kind` it checked there (cookie,
 * CSRF token, origin): the session counts only next to this replica's own mark, which the link adds on loopback and
 * nothing outside this process knows.
 */
export function vouchedSession(hub: Hub, req: FastifyRequest, kind: SessionKind): AuthSession | undefined {
  if (!hub.cluster.markOk(req.headers[LINK_MARK]) || !LOOPBACK.test(req.socket.remoteAddress ?? "")) return undefined;
  try {
    const s = JSON.parse(String(req.headers[LINK_SESSION] ?? "")) as Partial<AuthSession>;
    if (s.kind === kind && typeof s.id === "string" && typeof s.csrf === "string" && typeof s.expiresAt === "string") return s as AuthSession;
  } catch {
    /* not one */
  }
  return undefined;
}

function headersFor(h: IncomingHttpHeaders, ip: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined && !HOP.has(k) && !OURS.test(k)) out[k] = v;
  out["x-forwarded-for"] = ip;
  return out;
}

const moving = (req: FastifyRequest, leader: string): string => JSON.stringify({ error: tFor(requestLocale(req))("cluster.standby", { leader }) });

type Answer = { status: number; headers: Record<string, string | string[]>; body: Buffer };

interface OverLink {
  app: LinkApp;
  /** The web UI's or the console's session, checked here (relayToLeader). */
  session?: AuthSession;
  /** Changes the request's headers before they go. */
  headers?(h: Record<string, string>): void;
  /** Changes the leader's answer before it is sent back. */
  edit?(a: Answer): Answer;
}

/** Sends a request to the leader over the link (it may have no address we can reach) and writes back its answer. */
function overLink(link: RpcPeer, leader: string, req: FastifyRequest, reply: FastifyReply, o: OverLink): void {
  reply.hijack();
  const chunks: Buffer[] = [];
  let size = 0;
  req.raw.on("data", (c: Buffer) => {
    size += c.length;
    if (size <= MAX_LINK_BODY) chunks.push(c);
  });
  req.raw.on("end", () => {
    // One link message carries the body: a bigger one would break the link for everything else on it.
    if (size > MAX_LINK_BODY) {
      reply.raw.writeHead(413, { "content-type": "application/json" });
      reply.raw.end(JSON.stringify({ error: tFor(requestLocale(req))("cluster.tooLarge", { max: `${MAX_LINK_BODY / 1024 / 1024} MB` }) }));
      return;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !HOP.has(k) && k !== "content-length" && !OURS.test(k)) headers[k] = v;
    headers["x-forwarded-for"] = req.ip;
    o.headers?.(headers);
    linkHttp(link, { app: o.app, method: req.method, path: req.url, headers, body: Buffer.concat(chunks), ...(o.session ? { session: o.session } : {}) }).then(
      (r) => {
        const a = o.edit ? o.edit(r) : r;
        reply.raw.writeHead(a.status, a.headers);
        reply.raw.end(a.body);
      },
      () => {
        if (!reply.raw.headersSent) reply.raw.writeHead(502, { "content-type": "application/json" });
        reply.raw.end(moving(req, leader));
      },
    );
  });
}

/** onRequest hook of the device app (and, for /mcp, of the main app: `app: "main"`, over the link only). */
export function forwardToLeader(hub: Hub, req: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction, app: "device" | "main" = "device"): void {
  const target = hub.cluster.leaderTarget();
  if (!target || HERE.test(req.url) || req.headers.upgrade) return done();
  if (app === "main" && !target.link) return done();
  if (target.link) return overLink(target.link, target.name, req, reply, { app });
  if (!target.url) return done();
  const fingerprint = hub.deviceTls().fingerprint;
  const url = new URL(req.url, target.url);
  const https = url.protocol === "https:";
  reply.hijack();
  const up = (https ? httpsRequest : httpRequest)(
    url,
    { method: req.method, headers: headersFor(req.headers, req.ip), ...(https ? { rejectUnauthorized: false, agent: pinnedAgent } : {}), timeout: 6 * 3600_000 },
    (res) => {
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined && !HOP.has(k)) headers[k] = v;
      reply.raw.writeHead(res.statusCode ?? 502, headers);
      res.pipe(reply.raw);
    },
  );
  if (https) {
    up.on("socket", (s) => {
      const check = () => !pinOk(s as TLSSocket, fingerprint) && up.destroy(new Error("leader certificate"));
      if ((s as any)._secureEstablished) check();
      else s.once("secureConnect", check);
    });
  }
  up.on("error", () => {
    if (!reply.raw.headersSent) reply.raw.writeHead(502, { "content-type": "application/json" });
    reply.raw.end(moving(req, target.name));
  });
  req.raw.pipe(up);
}

/**
 * The web UI's call on a standby (main app), or its security console's (`app: "console"`), once this replica has
 * checked its session, CSRF token and origin: the leader's same app answers it over the link and takes that session as
 * checked (vouchedSession).
 */
export function relayToLeader(
  req: FastifyRequest,
  reply: FastifyReply,
  leader: { link: RpcPeer; name: string },
  session: AuthSession,
  o: Pick<OverLink, "headers" | "edit"> & { app?: "main" | "console" } = {},
): void {
  overLink(leader.link, leader.name, req, reply, { app: "main", session, ...o });
}

/** The sockets piped over each link, by id: one listener per link, not one per socket for as long as the link lasts. */
const piped = new WeakMap<RpcPeer, Map<string, WebSocket>>();

function pipesOn(link: RpcPeer): Map<string, WebSocket> {
  const known = piped.get(link);
  if (known) return known;
  const sockets = new Map<string, WebSocket>();
  piped.set(link, sockets);
  link.onNotification("replica.ws.msg", (m: { id: string; data: string; binary?: boolean }) => {
    const s = sockets.get(m.id);
    if (s?.readyState === WebSocket.OPEN) s.send(m.binary ? Buffer.from(m.data, "base64") : m.data);
  });
  link.onNotification("replica.ws.close", (m: { id: string }) => {
    const s = sockets.get(m.id);
    sockets.delete(m.id);
    if (s?.readyState === WebSocket.OPEN) s.close(1012, "hub moved");
  });
  link.onClose(() => {
    const all = [...sockets.values()];
    sockets.clear();
    for (const s of all) if (s.readyState === WebSocket.OPEN) s.close(1012, "hub moved");
  });
  return sockets;
}

/** Would pipeToLeader take a socket for `app` now: this replica stands by and can reach the leader. */
export function canPipeToLeader(hub: Hub, app: LinkApp = "device"): boolean {
  const target = hub.cluster.leaderTarget();
  if (!target || (app !== "device" && !target.link)) return false;
  return !!(target.link || target.url);
}

/**
 * The app's WebSocket (or a machine's /node/ws, or the web UI's /api/ws with the `session` checked here: `app: "main"`;
 * the console's with its session: `app: "console"`) on a standby: one to the leader, messages both ways. True when it
 * took the socket.
 */
export function pipeToLeader(hub: Hub, socket: WebSocket, req: FastifyRequest, app: LinkApp = "device", session?: AuthSession): boolean {
  if (!canPipeToLeader(hub, app)) return false;
  const target = hub.cluster.leaderTarget()!;
  const headers0: Record<string, string> = {};
  for (const k of ["authorization", "cookie", "user-agent", "accept-language"]) if (typeof req.headers[k] === "string") headers0[k] = req.headers[k] as string;
  if (target.link) {
    // The leader opens the socket to its own app; messages travel over the link.
    const link = target.link;
    const sockets = pipesOn(link);
    const id = randomUUID();
    sockets.set(id, socket);
    const queue: string[] = [];
    let open = false;
    socket.on("message", (d, binary) => {
      const data = binary ? Buffer.from(d as Buffer).toString("base64") : String(d);
      if (open) link.notify("replica.ws.msg", { id, data, binary });
      else queue.push(JSON.stringify({ data, binary }));
    });
    socket.on("close", () => {
      if (sockets.delete(id) && !link.closed) link.notify("replica.ws.close", { id });
    });
    const origin = app === "device" ? { origin: `https://127.0.0.1:${hub.config.devicePort}` } : {};
    link.request("replica.ws.open", { app, id, path: req.url, headers: { ...headers0, ...origin }, ...(session ? { session } : {}) }, { timeoutMs: 15_000 }).then(
      () => {
        open = true;
        for (const q of queue.splice(0)) link.notify("replica.ws.msg", { id, ...JSON.parse(q) });
      },
      () => {
        sockets.delete(id);
        if (socket.readyState === WebSocket.OPEN) socket.close(1012, "hub moved");
      },
    );
    return true;
  }
  const leaderUrl = target.url!;
  const fingerprint = hub.deviceTls().fingerprint;
  const url = new URL(req.url, leaderUrl.replace(/^http/, "ws"));
  const headers: Record<string, string> = { ...headers0, origin: leaderUrl };
  const up = new WebSocket(url, { headers, rejectUnauthorized: false, agent: pinnedAgent, handshakeTimeout: 10_000 });
  up.on("upgrade", (res) => {
    const s = res.socket as TLSSocket;
    if (url.protocol === "wss:" && !pinOk(s, fingerprint)) up.terminate();
  });
  const queue: Array<WebSocket.RawData> = [];
  socket.on("message", (d) => (up.readyState === WebSocket.OPEN ? up.send(d) : queue.push(d)));
  up.on("open", () => {
    for (const d of queue.splice(0)) up.send(d);
  });
  up.on("message", (d, binary) => socket.readyState === WebSocket.OPEN && socket.send(d, { binary }));
  const closeBoth = () => {
    if (socket.readyState === WebSocket.OPEN) socket.close(1012, "hub moved");
    if (up.readyState === WebSocket.OPEN || up.readyState === WebSocket.CONNECTING) up.terminate();
  };
  up.on("close", closeBoth);
  up.on("error", closeBoth);
  socket.on("close", closeBoth);
  return true;
}
