// Egress proxy: brains and plugins reach the network only through here.
// Each process gets a token (in the proxy URL userinfo) mapped to a host allowlist.

import http from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { randomBytes } from "node:crypto";
import { hostMatches } from "@piomio/shared";
import type { AuditLog } from "./audit.ts";

export const NETWORK_APPROVAL_WAIT_MS = 10 * 60_000;

const PRIVATE_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["168.63.129.16", 32], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const PRIVATE_V6: Array<[string, number]> = [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]];
const privateNets = new net.BlockList();
for (const [a, p] of PRIVATE_V4) privateNets.addSubnet(a, p, "ipv4");
for (const [a, p] of PRIVATE_V6) privateNets.addSubnet(a, p, "ipv6");

/** dns.lookup replacement that only returns addresses we already checked (no second resolution). */
export function pinnedLookup(addrs: string[]): net.LookupFunction {
  return ((_host: string, opts: { all?: boolean }, cb: (...a: any[]) => void) => {
    if (opts?.all) cb(null, addrs.map((address) => ({ address, family: net.isIP(address) })));
    else cb(null, addrs[0], net.isIP(addrs[0]));
  }) as net.LookupFunction;
}

function v4FromHex(hi: string, lo: string): string {
  const n = ((parseInt(hi, 16) << 16) | parseInt(lo, 16)) >>> 0;
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** Loopback, LAN, link-local, CGNAT, multicast… including IPv4 embedded in IPv6 (mapped, NAT64, 6to4). */
export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return privateNets.check(ip, "ipv4");
  if (v !== 6) return true;
  const lower = new URL(`http://[${ip}]`).hostname.slice(1, -1).toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return privateNets.check(dotted[1], "ipv4");
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) return privateNets.check(v4FromHex(hex[1], hex[2]), "ipv4");
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/.exec(lower);
  if (sixToFour) return privateNets.check(v4FromHex(sixToFour[1], sixToFour[2]), "ipv4");
  return privateNets.check(ip, "ipv6");
}

/** Canonical exact host. Reject URL syntax, non-canonical numeric IP tricks and control characters. */
export function networkHost(value: string): string {
  const host = value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (net.isIP(host) === 6) return new URL(`http://[${host}]`).hostname.slice(1, -1);
  if (net.isIP(host) === 4) return host;
  if (!host || host.length > 253 || !host.includes(".") || /^[\d.]+$/.test(host) || !host.split(".").every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)))
    throw new Error("Expected a DNS host or IP address, without a URL, path or port");
  const canonical = new URL(`http://${host}`).hostname;
  if (canonical !== host) throw new Error("Use the canonical host or IP address");
  return host;
}

export function networkPattern(value: string): string {
  const wildcard = value.startsWith("*.");
  const host = networkHost(wildcard ? value.slice(2) : value);
  if ((net.isIP(host) && (wildcard || isPrivateAddress(host))) || /(?:^|\.)(?:localhost|local|internal)$/.test(host))
    throw new Error("Private addresses and local hosts cannot be added to the brain allowlist");
  return wildcard ? `*.${host}` : host;
}

export interface NetworkContext {
  sessionId: string;
  conversationId: string;
  agentId: string;
  taskId?: string;
}
export interface NetworkRequest extends NetworkContext {
  host: string;
  port: number;
  /** On the allowlist: asked about only because the session has read outside content. */
  listed?: boolean;
  signal: AbortSignal;
}
interface Grant {
  owner: string;
  allow: string[];
  context?: NetworkContext;
  once: Set<string>;
  cancel: AbortController;
}
interface Pending {
  promise: Promise<void>;
  cancel: AbortController;
  users: number;
}

export class EgressProxy {
  private grants = new Map<string, Grant>();
  private pending = new Map<string, Pending>();
  private server?: http.Server;
  private sockets = new Set<net.Socket>();
  private denyLogged = new Map<string, number>();
  audit?: AuditLog;
  extraBrainAllow: () => string[] = () => [];
  privateAllow: () => string[] = () => [];
  requestApproval?: (request: NetworkRequest) => Promise<void>;
  /** The session has read outside content: what a command sends even to a listed host leaves the computer. */
  tainted: (context: NetworkContext) => boolean = () => false;
  /** What the brains' CLIs themselves talk to (their model APIs): listed, and never asked about. */
  ownHosts: string[] = [];

  /** Resolve once; pinnedLookup uses exactly these checked addresses, never a second DNS lookup. */
  async resolveTarget(host: string): Promise<string[]> {
    const bare = host.replace(/^\[|\]$/g, "");
    const addrs = net.isIP(bare) ? [bare] : (await lookup(bare, { all: true, verbatim: true })).map((a) => a.address);
    if (addrs.length === 0) throw new Error(`cannot resolve ${host}`);
    const okPrivate = this.privateAllow().some((p) => hostMatches(bare, p));
    if (!okPrivate && addrs.some(isPrivateAddress)) throw new Error(`${host} resolves to a private address; network permission cannot authorize it`);
    return addrs;
  }

  issueToken(owner: string, allow: string[], context?: NetworkContext): string {
    const token = randomBytes(18).toString("base64url");
    this.grants.set(token, { owner, allow, context, once: new Set(), cancel: new AbortController() });
    return token;
  }
  revoke(token: string): void {
    this.grants.get(token)?.cancel.abort();
    this.grants.delete(token);
  }
  revokeOwner(owner: string): void {
    for (const [t, g] of this.grants) if (g.owner === owner) this.revoke(t);
  }
  /** Stop pending questions and drop session-only permissions without invalidating a warm CLI's proxy URL. */
  cancelRequests(owner: string): void {
    for (const [token, grant] of this.grants) if (grant.owner === owner) {
      grant.once.clear();
      for (const [key, pending] of this.pending) if (key.startsWith(`${token}|`)) pending.cancel.abort();
    }
  }
  endTask(taskId: string): void {
    for (const grant of this.grants.values()) if (grant.context?.taskId === taskId) this.cancelRequests(grant.owner);
  }
  allowed(token: string | undefined, host: string): { ok: boolean; owner?: string } {
    const g = token && this.grants.get(token);
    if (!g) return { ok: false };
    const list = g.owner.startsWith("brain:") ? [...g.allow, ...this.extraBrainAllow()] : g.allow;
    return { ok: list.some((p) => hostMatches(host, p)), owner: g.owner };
  }

  /** A tool may propose access for its own authenticated session; it cannot supply another session's context. */
  async requestHost(sessionId: string, host: string, port: number): Promise<void> {
    const token = [...this.grants].find(([, g]) => g.context?.sessionId === sessionId)?.[0];
    if (!token) throw new Error("Network permissions are available only for a local brain session on the hub");
    await this.authorize(token, networkHost(host), port);
  }

  private async authorize(token: string | undefined, host: string, port: number, signal?: AbortSignal): Promise<string[]> {
    host = host.toLowerCase().replace(/\.$/, "");
    if (net.isIP(host) === 6) host = networkHost(host);
    const g = token && this.grants.get(token);
    if (!g) throw new Error("Proxy authentication required");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid destination port");
    const verdict = this.allowed(token, host);
    const address = `${host}:${port}`;
    // After outside content each listed host is asked about once per session, as an unknown one would be.
    const look = verdict.ok && !!g.context && !this.ownHosts.some((p) => hostMatches(host, p)) && this.tainted(g.context);
    if ((verdict.ok && !look) || g.once.has(address)) {
      const addrs = await this.resolveTarget(host);
      if (signal?.aborted || g.cancel.signal.aborted) throw new Error(`Host ${address} is not allowed: request cancelled`);
      return addrs;
    }
    if (!g.context || !this.requestApproval) throw new Error(`Host ${address} is not allowed`);
    // Resolve BEFORE any card. Private/metadata addresses must never be offered as ordinary network permissions.
    networkPattern(host);
    const addrs = await this.resolveTarget(host);
    if (addrs.some(isPrivateAddress)) throw new Error(`Host ${host} resolves to a private address; no permission card is offered`);
    if (signal?.aborted || g.cancel.signal.aborted) throw new Error(`Host ${address} is not allowed: request cancelled`);
    const key = `${token}|${address}`;
    let pending = this.pending.get(key);
    if (!pending) {
      if ([...this.pending.keys()].filter((k) => k.startsWith(`${token}|`)).length >= 16) throw new Error("Too many pending network permissions");
      const cancel = new AbortController();
      const abort = () => cancel.abort("session_ended");
      g.cancel.signal.addEventListener("abort", abort, { once: true });
      const promise = this.requestApproval({ ...g.context, host, port, ...(look ? { listed: true } : {}), signal: cancel.signal }).then(() => {
        if (cancel.signal.aborted || !this.grants.has(token!)) throw new Error(`Host ${address} is not allowed: request cancelled`);
        // A permanent grant stays removable in settings: only a once decision needs a temporary allowance.
        if (look || !this.allowed(token, host).ok) g.once.add(address);
      }).finally(() => {
        this.pending.delete(key);
        g.cancel.signal.removeEventListener("abort", abort);
      });
      pending = { promise, cancel, users: 0 };
      this.pending.set(key, pending);
    }
    pending.users++;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        pending.promise,
        new Promise<never>((_, reject) => {
          abort = () => reject(new Error(`Host ${address} is not allowed: connection closed`));
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        }),
      ]);
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
      if (--pending.users === 0) pending.cancel.abort("connection_closed");
    }
    if (!this.grants.has(token!)) throw new Error("Proxy permission revoked");
    // The person may have taken a minute; recheck DNS, then pin the fresh public result.
    return this.resolveTarget(host);
  }

  private tokenFrom(req: http.IncomingMessage): string | undefined {
    const h = req.headers["proxy-authorization"];
    const m = typeof h === "string" ? /^Basic\s+(.+)$/i.exec(h) : undefined;
    return m ? Buffer.from(m[1], "base64").toString("utf8").split(":")[0] : undefined;
  }
  private logDeny(owner: string | undefined, host: string): void {
    const key = `${owner}|${host}`;
    if (Date.now() - (this.denyLogged.get(key) ?? 0) < 60_000) return;
    this.denyLogged.set(key, Date.now());
    this.audit?.append(owner ?? "unknown", "egress.deny", host);
  }

  listen(port: number): Promise<void> {
    const server = http.createServer(async (req, res) => {
      const token = this.tokenFrom(req);
      let host = "unknown";
      const cancel = new AbortController();
      res.on("close", () => cancel.abort());
      try {
        const target = new URL(req.url ?? "");
        if (target.protocol !== "http:" || target.username || target.password) throw new Error("Only absolute HTTP URLs are accepted");
        host = target.hostname.replace(/^\[|\]$/g, "");
        const port = Number(target.port || 80);
        const addrs = await this.authorize(token, host, port, cancel.signal);
        if (cancel.signal.aborted) return;
        const headers: http.OutgoingHttpHeaders = { ...req.headers, host: target.host };
        delete headers["proxy-authorization"];
        delete headers["proxy-connection"];
        const up = http.request({ host, port, lookup: pinnedLookup(addrs), method: req.method, path: target.pathname + target.search, headers }, (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        });
        res.on("close", () => up.destroy());
        up.on("error", (e) => { if (!res.headersSent) res.writeHead(502); res.end(`upstream error: ${e.message}`); });
        req.pipe(up);
      } catch (e) {
        this.logDeny(this.allowed(token, host).owner, host);
        if (!res.destroyed) res.writeHead(token && this.grants.has(token) ? 403 : 407, { "content-type": "text/plain; charset=utf-8", ...(!token || !this.grants.has(token) ? { "proxy-authenticate": "Basic realm=piomio" } : {}) }).end(`egress to ${host} is not allowed: ${(e as Error).message}`);
      }
    });
    server.on("connect", async (req, client: net.Socket, head) => {
      client.on("error", () => {});
      const cancel = new AbortController();
      client.on("close", () => cancel.abort());
      // CONNECT sockets may half-close (FIN) before `close`; there is no live caller left to approve then.
      client.on("end", () => cancel.abort());
      const token = this.tokenFrom(req);
      let host = "unknown";
      // Read bounded early bytes so a FIN is observed while permission is pending; never forward them early.
      const early: Buffer[] = head.length ? [head] : [];
      let earlySize = head.length;
      const hold = (chunk: Buffer) => {
        earlySize += chunk.length;
        if (earlySize > 64 * 1024) { cancel.abort(); client.destroy(); }
        else early.push(chunk);
      };
      client.on("data", hold);
      try {
        if (earlySize > 64 * 1024) throw new Error("Too much data before CONNECT approval");
        const match = /^(\[[0-9a-fA-F:.]+\]|[^:\s/]+):(\d{1,5})$/.exec(req.url ?? "");
        if (!match) throw new Error("Invalid CONNECT host and port");
        host = match[1].replace(/^\[|\]$/g, "").toLowerCase();
        const port = Number(match[2]);
        const addrs = await this.authorize(token, host, port, cancel.signal);
        if (cancel.signal.aborted || client.destroyed) return;
        client.pause();
        client.off("data", hold);
        const upstream = net.connect({ host, port, lookup: pinnedLookup(addrs), autoSelectFamily: true }, () => {
          if (cancel.signal.aborted || client.destroyed) { upstream.destroy(); client.destroy(); return; }
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (earlySize) upstream.write(Buffer.concat(early));
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on("error", () => client.destroy());
        client.on("close", () => upstream.destroy());
      } catch (e) {
        client.off("data", hold);
        this.logDeny(this.allowed(token, host).owner, host);
        // CONNECT clients often discard the response body: keep the explanation in the status reason too.
        const reason = String((e as Error).message).replace(/[^\x20-\x7e]/g, " ").slice(0, 300);
        const body = `Host ${host} is not allowed: ${reason}\n`;
        if (!client.destroyed) client.end(`HTTP/1.1 ${token && this.grants.has(token) ? 403 : 407} ${reason}\r\n${!token || !this.grants.has(token) ? "Proxy-Authenticate: Basic realm=piomio\r\n" : ""}Content-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      }
    });
    this.server = server;
    // Do not let Node's default five-minute request timer beat a live permission card.
    server.requestTimeout = NETWORK_APPROVAL_WAIT_MS + 60_000;
    server.on("connection", (sock) => { this.sockets.add(sock); sock.on("close", () => this.sockets.delete(sock)); });
    return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve()); });
  }
  close(): Promise<void> {
    for (const token of this.grants.keys()) this.revoke(token);
    return new Promise((r) => {
      if (!this.server) return r();
      this.server.close(() => r());
      this.server.closeAllConnections?.();
      for (const sock of this.sockets) sock.destroy();
      this.sockets.clear();
    });
  }
}
