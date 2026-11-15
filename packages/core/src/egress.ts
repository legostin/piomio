// Egress proxy: brains and plugins reach the network only through here.
// Each process gets a token (in the proxy URL userinfo) mapped to a host allowlist.
// It says why a connection did not happen: "not allowed" (403, audited as egress.deny) is the policy; "cannot reach"
// (502, egress.unreachable) is the network: a host that does not resolve or refuses, a computer that is offline or
// asleep. An agent told "not allowed" when the Mac had no internet took the proxy for broken.

import http from "node:http";
import net from "node:net";
import os from "node:os";
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

/** The IPv4 address inside an IPv6 one (mapped, NAT64, 6to4), or the address itself; undefined for what is no address. */
function plain(ip: string): { ip: string; family: "ipv4" | "ipv6" } | undefined {
  const v = net.isIP(ip);
  if (v === 4) return { ip, family: "ipv4" };
  if (v !== 6) return undefined;
  const lower = new URL(`http://[${ip}]`).hostname.slice(1, -1).toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return { ip: dotted[1], family: "ipv4" };
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) return { ip: v4FromHex(hex[1], hex[2]), family: "ipv4" };
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/.exec(lower);
  if (sixToFour) return { ip: v4FromHex(sixToFour[1], sixToFour[2]), family: "ipv4" };
  return { ip, family: "ipv6" };
}

/** Loopback, LAN, link-local, CGNAT, multicast… including IPv4 embedded in IPv6 (mapped, NAT64, 6to4). */
export function isPrivateAddress(ip: string): boolean {
  const p = plain(ip);
  return !p || privateNets.check(p.ip, p.family);
}

/** Networks of the person's own: home and office ranges, CGNAT (a VPN, a tailnet), IPv6 unique local. */
const lanNets = new net.BlockList();
for (const [a, p] of [["10.0.0.0", 8], ["100.64.0.0", 10], ["172.16.0.0", 12], ["192.168.0.0", 16]] as const) lanNets.addSubnet(a, p, "ipv4");
lanNets.addSubnet("fc00::", 7, "ipv6");

/**
 * "lan": an address in a network of the person's own, which they may open to agents on a card. "local": this computer
 * and what nobody is asked about (loopback, link-local, cloud metadata, multicast, reserved ranges).
 */
export function privateClass(ip: string): "public" | "lan" | "local" {
  const p = plain(ip);
  if (!p) return "local";
  if (!privateNets.check(p.ip, p.family)) return "public";
  return lanNets.check(p.ip, p.family) ? "lan" : "local";
}

/** A name no public DNS zone hands out: one label ("nas") or a local-only suffix. */
function localName(host: string): boolean {
  return !host.includes(".") || /(?:^|\.)(?:localhost|local|internal|lan|home\.arpa)$/.test(host);
}

/**
 * An entry of the private-hosts list (settings egressPrivateAllow), the person's own to type: a name (one label will
 * do), "*.domain" or an address. Never everything, a URL, a path or a port.
 */
export function privatePattern(value: string): string {
  const v = String(value).trim().toLowerCase().replace(/\.$/, "");
  const wildcard = v.startsWith("*.");
  const host = (wildcard ? v.slice(2) : v).replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (wildcard) throw new Error("A wildcard goes before a domain, not an address");
    return net.isIP(host) === 6 ? new URL(`http://[${host}]`).hostname.slice(1, -1) : host;
  }
  if (!host || host.length > 253 || /^[\d.]+$/.test(host) || !host.split(".").every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)))
    throw new Error("Expected a host name, *.domain or an IP address, without a URL, path or port");
  return wildcard ? `*.${host}` : host;
}

/** The host resolves inside a private network and nobody has allowed it. `offerable`: the person may, on a card. */
export class PrivateHostError extends Error {
  host: string;
  addresses: string[];
  offerable: boolean;
  constructor(host: string, addresses: string[], offerable: boolean) {
    super(
      offerable
        ? `${host} resolves to a private address (${addresses.join(", ")}) inside the person's network: it is closed until they allow it. hub_network_request asks them on a card`
        : `${host} resolves to this computer or a link-local address (${addresses.join(", ")}): it is not offered on a network card`,
    );
    this.host = host;
    this.addresses = addresses;
    this.offerable = offerable;
  }
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

/** An exact host to ask the person about: a DNS name, an address, or a one-label name of their own network ("nas"). */
function exactHost(value: string): string {
  const v = String(value).trim();
  if (v.includes(".") || v.includes(":")) return networkHost(v);
  const host = privatePattern(v);
  if (host.startsWith("*.")) throw new Error("Expected one exact host, not a wildcard");
  return host;
}

export function networkPattern(value: string): string {
  const wildcard = value.startsWith("*.");
  const host = networkHost(wildcard ? value.slice(2) : value);
  if ((net.isIP(host) && (wildcard || isPrivateAddress(host))) || /(?:^|\.)(?:localhost|local|internal)$/.test(host))
    throw new Error("Private addresses and local hosts cannot be added to the brain allowlist");
  return wildcard ? `*.${host}` : host;
}

/** The destination could not be reached (DNS, connection): the network, not the policy. */
export class EgressUnreachable extends Error {}

/** The person was asked about a host inside their network and it stays closed: declined, unanswered, or nobody to ask. */
export class NetworkDenied extends Error {}

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
  /** The addresses inside the person's network the host resolves to: a card of its own, the person's alone to answer. */
  private?: string[];
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
  /** Resolves a host to its addresses (tests replace it); dns.lookup otherwise. */
  lookup?: (host: string) => Promise<string[]>;
  extraBrainAllow: () => string[] = () => [];
  /** Hosts inside the person's network that they opened (settings egressPrivateAllow): to brains as well. */
  privateAllow: () => string[] = () => [];
  /** This computer's own addresses: a host that resolves to one is this computer, whatever network it is on. */
  ownAddresses: () => string[] = () => Object.values(os.networkInterfaces()).flatMap((list) => (list ?? []).map((i) => i.address.replace(/%.*$/, "")));
  /** "Allow once" on a private card: the host, for as long as the session that asked lasts. */
  private privateOnce: { host: string; sessionId: string; taskId?: string }[] = [];
  private privatePending = new Map<string, Promise<void>>();
  requestApproval?: (request: NetworkRequest) => Promise<void>;
  /** The session has read outside content: what a command sends even to a listed host leaves the computer. */
  tainted: (context: NetworkContext) => boolean = () => false;
  /** What the brains' CLIs themselves talk to (their model APIs): listed, and never asked about. */
  ownHosts: string[] = [];

  /**
   * Resolve once; pinnedLookup uses exactly these checked addresses, never a second DNS lookup. `sessionId`: the
   * session the connection is for, when the proxy knows it (a brain's shell): an "allow once" then counts only if it
   * was given to that session. A plugin's connection carries no session, so any live "once" opens the host to it.
   */
  async resolveTarget(host: string, sessionId?: string): Promise<string[]> {
    const bare = host.replace(/^\[|\]$/g, "");
    let addrs: string[];
    try {
      addrs = net.isIP(bare) ? [bare] : this.lookup ? await this.lookup(bare) : (await lookup(bare, { all: true, verbatim: true })).map((a) => a.address);
    } catch (e: any) {
      throw new EgressUnreachable(`cannot resolve ${host} (${e?.code ?? e?.message ?? e})`);
    }
    if (addrs.length === 0) throw new EgressUnreachable(`cannot resolve ${host}`);
    const inside = addrs.filter(isPrivateAddress);
    if (!inside.length) return addrs;
    const own = this.ownAddresses();
    const here = (a: string) => privateClass(a) === "local" || own.includes(a);
    if (this.privateAllow().some((p) => hostMatches(bare, p)) || this.privateOnce.some((o) => o.host === bare && (!sessionId || o.sessionId === sessionId))) {
      // A name from public DNS can be pointed elsewhere after the person allowed it: never at this computer.
      if (!net.isIP(bare) && !localName(bare) && addrs.some(here))
        throw new Error(`${host} resolves to this computer or a link-local address: a name from public DNS is never followed there`);
      return addrs;
    }
    throw new PrivateHostError(host, inside, !inside.some(here));
  }

  private allowPrivateOnce(context: NetworkContext, host: string): void {
    if (!this.privateOnce.some((o) => o.host === host && o.sessionId === context.sessionId)) this.privateOnce.push({ host, sessionId: context.sessionId, taskId: context.taskId });
  }
  /** The session is over, or was stopped: so is what it was allowed once. */
  forgetSession(sessionId: string): void {
    this.privateOnce = this.privateOnce.filter((o) => o.sessionId !== sessionId);
  }

  /**
   * A host a tool is about to open for this session (a page for the browser, an address to fetch), or one the agent
   * asks for outright: when it is inside the person's network and not allowed yet, the person is asked on a card. True
   * when the host is a private one (and now open to this session), false for a public one, which needs nothing here.
   */
  async requestPrivate(context: NetworkContext, rawHost: string, port = 443): Promise<boolean> {
    const host = exactHost(rawHost);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid destination port");
    let inside: string[];
    try {
      return (await this.resolveTarget(host)).some(isPrivateAddress);
    } catch (e) {
      if (!(e instanceof PrivateHostError) || !e.offerable || !this.requestApproval) throw e;
      inside = e.addresses;
    }
    const key = `${context.sessionId}|${host}`;
    let asking = this.privatePending.get(key);
    if (!asking) {
      asking = this.requestApproval({ ...context, host, port, private: inside, signal: new AbortController().signal })
        .catch((e) => {
          throw new NetworkDenied((e as Error)?.message ?? String(e));
        })
        .then(() => {
          if (!this.privateAllow().some((p) => hostMatches(host, p))) this.allowPrivateOnce(context, host);
        })
        .finally(() => this.privatePending.delete(key));
      this.privatePending.set(key, asking);
    }
    await asking;
    // The person may have taken a minute: what the name points at now is checked again.
    await this.resolveTarget(host);
    return true;
  }

  issueToken(owner: string, allow: string[], context?: NetworkContext): string {
    const token = randomBytes(18).toString("base64url");
    this.grants.set(token, { owner, allow, context, once: new Set(), cancel: new AbortController() });
    return token;
  }
  /** A process of this owner (a plugin's, a local MCP server's) reaches the network through this proxy. */
  hasOwner(owner: string): boolean {
    return [...this.grants.values()].some((g) => g.owner === owner);
  }
  /** A live token carries this session's context: its brain's commands can reach the proxy. */
  hasSession(sessionId: string): boolean {
    return [...this.grants.values()].some((g) => g.context?.sessionId === sessionId && !g.cancel.signal.aborted);
  }
  revoke(token: string): void {
    const g = this.grants.get(token);
    g?.cancel.abort();
    this.grants.delete(token);
    if (g?.context) this.forgetSession(g.context.sessionId);
  }
  revokeOwner(owner: string): void {
    for (const [t, g] of this.grants) if (g.owner === owner) this.revoke(t);
  }
  /** Stop pending questions and drop session-only permissions without invalidating a warm CLI's proxy URL. */
  cancelRequests(owner: string): void {
    for (const [token, grant] of this.grants) if (grant.owner === owner) {
      grant.once.clear();
      if (grant.context) this.forgetSession(grant.context.sessionId);
      for (const [key, pending] of this.pending) if (key.startsWith(`${token}|`)) pending.cancel.abort();
    }
  }
  endTask(taskId: string): void {
    for (const grant of this.grants.values()) if (grant.context?.taskId === taskId) this.cancelRequests(grant.owner);
    this.privateOnce = this.privateOnce.filter((o) => o.taskId !== taskId);
  }
  allowed(token: string | undefined, host: string): { ok: boolean; owner?: string } {
    const g = token && this.grants.get(token);
    if (!g) return { ok: false };
    const list = g.owner.startsWith("brain:") ? [...g.allow, ...this.extraBrainAllow(), ...this.privateAllow()] : g.allow;
    return { ok: list.some((p) => hostMatches(host, p)), owner: g.owner };
  }

  /** A tool may propose access for its own authenticated session; it cannot supply another session's context. */
  async requestHost(sessionId: string, host: string, port: number): Promise<void> {
    const token = [...this.grants].find(([, g]) => g.context?.sessionId === sessionId)?.[0];
    if (!token) throw new Error("Network permissions are available only for a local brain session on the hub");
    await this.authorize(token, exactHost(host), port);
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
    // Resolve BEFORE any card. A host inside the person's network is never offered as an ordinary network permission:
    // it gets a card of its own (NetworkRequest.private), and this computer, link-local and metadata addresses none.
    let inside: string[] | undefined;
    const resolve = async (): Promise<string[] | undefined> => {
      try {
        return await this.resolveTarget(host, g.context?.sessionId);
      } catch (e) {
        if (!(e instanceof PrivateHostError) || !e.offerable || !g.context || !this.requestApproval) throw e;
        inside = e.addresses;
        return undefined;
      }
    };
    if ((verdict.ok && !look) || g.once.has(address)) {
      const addrs = await resolve();
      if (signal?.aborted || g.cancel.signal.aborted) throw new Error(`Host ${address} is not allowed: request cancelled`);
      if (addrs) return addrs;
    }
    if (!g.context || !this.requestApproval) throw new Error(`Host ${address} is not allowed`);
    if (!inside) {
      const addrs = await resolve();
      const priv = addrs?.filter(isPrivateAddress) ?? [];
      // Open to this session inside the network, but not on this port: still the person's to answer, never a reviewer's.
      // One the person listed is asked about after outside content like any listed host (`look`).
      if (priv.length && !look) inside = priv;
      // A public destination is offered only as an exact DNS name or a public address.
      else if (addrs && !priv.length) networkPattern(host);
    }
    if (signal?.aborted || g.cancel.signal.aborted) throw new Error(`Host ${address} is not allowed: request cancelled`);
    const key = `${token}|${address}`;
    let pending = this.pending.get(key);
    if (!pending) {
      if ([...this.pending.keys()].filter((k) => k.startsWith(`${token}|`)).length >= 16) throw new Error("Too many pending network permissions");
      const cancel = new AbortController();
      const abort = () => cancel.abort("session_ended");
      g.cancel.signal.addEventListener("abort", abort, { once: true });
      const context = g.context;
      const promise = this.requestApproval({ ...context, host, port, ...(inside ? { private: inside } : look ? { listed: true } : {}), signal: cancel.signal }).then(() => {
        if (cancel.signal.aborted || !this.grants.has(token!)) throw new Error(`Host ${address} is not allowed: request cancelled`);
        if (inside && !this.privateAllow().some((p) => hostMatches(host, p))) this.allowPrivateOnce(context, host);
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
    // The person may have taken a minute; recheck DNS, then pin the fresh result.
    return this.resolveTarget(host, g.context?.sessionId);
  }

  private tokenFrom(req: http.IncomingMessage): string | undefined {
    const h = req.headers["proxy-authorization"];
    const m = typeof h === "string" ? /^Basic\s+(.+)$/i.exec(h) : undefined;
    return m ? Buffer.from(m[1], "base64").toString("utf8").split(":")[0] : undefined;
  }
  /**
   * A refused or failed connection, once a minute per owner, host and kind. Not the 407 every client gets first,
   * before it sends its credentials: that is the handshake, not a denial.
   */
  private logRefusal(token: string | undefined, host: string, e: unknown): void {
    if (!token) return;
    const owner = this.allowed(token, host).owner ?? "unknown";
    const action = e instanceof EgressUnreachable ? "egress.unreachable" : "egress.deny";
    const key = `${action}|${owner}|${host}`;
    if (Date.now() - (this.denyLogged.get(key) ?? 0) < 60_000) return;
    this.denyLogged.set(key, Date.now());
    if (this.denyLogged.size > 5000) this.denyLogged.clear();
    this.audit?.append(owner, action, host, { reason: String((e as Error)?.message ?? e).slice(0, 300) });
  }

  /** The words an agent reads for a destination it could not reach. */
  private unreachableText(host: string, e: unknown): string {
    return `cannot reach ${host}: ${(e as Error)?.message ?? e}. This is the network, not a permission: this computer may be offline or the host down. Try again later.`;
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
        up.on("error", (e) => {
          // The client left first (its close destroyed the request): nothing failed on the way out.
          if (cancel.signal.aborted || res.destroyed) return;
          const err = new EgressUnreachable(e.message || (e as NodeJS.ErrnoException).code || String(e));
          this.logRefusal(token, host, err);
          // Half a body already went: an explanation appended to it would corrupt it.
          if (res.headersSent) return void res.destroy();
          res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end(this.unreachableText(host, err));
        });
        req.pipe(up);
      } catch (e) {
        this.logRefusal(token, host, e);
        if (res.destroyed) return;
        if (e instanceof EgressUnreachable) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end(this.unreachableText(host, e));
        else res.writeHead(token && this.grants.has(token) ? 403 : 407, { "content-type": "text/plain; charset=utf-8", ...(!token || !this.grants.has(token) ? { "proxy-authenticate": "Basic realm=piomio" } : {}) }).end(`egress to ${host} is not allowed: ${(e as Error).message}`);
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
        let established = false;
        upstream.once("connect", () => (established = true));
        upstream.on("error", (e) => {
          if (established || client.destroyed) return client.destroy();
          // Before the tunnel is up the client can still be told why.
          // A refusal on every address comes as an AggregateError with no message of its own: its code says it.
          const err = new EgressUnreachable(e.message || (e as NodeJS.ErrnoException).code || String(e));
          this.logRefusal(token, host, err);
          const reason = `cannot reach ${host}: ${err.message}`.replace(/[^\x20-\x7e]/g, " ").slice(0, 300);
          const body = `${this.unreachableText(host, err)}\n`;
          client.end(`HTTP/1.1 502 ${reason}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        });
        client.on("close", () => upstream.destroy());
      } catch (e) {
        client.off("data", hold);
        this.logRefusal(token, host, e);
        // CONNECT clients often discard the response body: keep the explanation in the status reason too.
        const unreachable = e instanceof EgressUnreachable;
        const reason = String(unreachable ? `cannot reach ${host}: ${(e as Error).message}` : (e as Error).message).replace(/[^\x20-\x7e]/g, " ").slice(0, 300);
        const body = unreachable ? `${this.unreachableText(host, e)}\n` : `Host ${host} is not allowed: ${reason}\n`;
        const status = unreachable ? 502 : token && this.grants.has(token) ? 403 : 407;
        if (!client.destroyed) client.end(`HTTP/1.1 ${status} ${reason}\r\n${status === 407 ? "Proxy-Authenticate: Basic realm=piomio\r\n" : ""}Content-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
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
