// The hub on several machines (docs/superpowers/specs/2026-10-30-cluster-design.md, parts 2 and 3): every replica holds
// the whole hub (both databases, merged row by row, and the files), one leads at a time by priority, and main-only work
// (tasks, channels, digests, plugins) runs on the leader. A hub without a replica identity is a cluster of one and
// behaves as it always did. Replicas talk over the device app: TLS with the hub's one certificate (pinned), every
// request signed with the replica's own key.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Replica, ReplicaState } from "@piomio/shared";
import { newId, nowIso } from "@piomio/shared";
import {
  DbReplicator,
  FileSync,
  newReplicaKey,
  pinnedRequest,
  signRequest,
  verifyRequest,
  type FilePeer,
  type FileRoot,
  type ReplEntry,
  type ReplicaKey,
  type ReplTable,
} from "@piomio/replica";
import type WebSocket from "ws";
import type { RpcPeer } from "@piomio/shared";
import { json } from "./db.ts";
import { t } from "./i18n.ts";
import type { Hub } from "./app.ts";
import { ruleMatches } from "./policy/engine.ts";
import { dialLink, linkPeer, serveLink, type LinkAnswer, type LinkCall } from "./replica-link.ts";

/** piomio.db tables every replica shares (the rest stays per replica: audit's hash chain, pairing codes). */
export const MAIN_TABLES: ReplTable[] = [
  { name: "conversations", pk: ["id"] },
  { name: "messages", pk: ["id"] },
  { name: "tasks", pk: ["id"] },
  { name: "sessions", pk: ["id"] },
  { name: "approvals", pk: ["id"] },
  { name: "rules", pk: ["id"] },
  { name: "approved_targets", pk: ["value"] },
  { name: "notifications", pk: ["id"] },
  { name: "plugins", pk: ["id"] },
  { name: "plugin_kv", pk: ["plugin_id", "key"] },
  { name: "machines", pk: ["id"] },
  { name: "machine_settings", pk: ["machine_id"] },
  { name: "machine_spend", pk: ["day", "machine_id", "brain_id", "provider", "model"] },
  { name: "replicas", pk: ["id"] },
  { name: "auth", pk: ["key"] },
  { name: "auth_sessions", pk: ["id"] },
  { name: "passkeys", pk: ["id"] },
  { name: "devices", pk: ["id"] },
  { name: "settings", pk: ["key"] },
  { name: "usage", pk: ["day", "agent_id", "kind"] },
  { name: "brain_limits", pk: ["brain_ref"] },
  { name: "secret_requests", pk: ["id"] },
  { name: "agent_drafts", pk: ["id"] },
  { name: "invites", pk: ["code"] },
  { name: "feeds", pk: ["id"] },
  { name: "feed_posts", pk: ["id"] },
  { name: "pages", pk: ["id"] },
  { name: "skill_agents", pk: ["skill"] },
  { name: "meta", pk: ["key"] },
];

/** vault.db: the items and the wrapped data key travel sealed. */
export const VAULT_TABLES: ReplTable[] = [
  { name: "vault_items", pk: ["id"] },
  { name: "vault_meta", pk: ["key"] },
];

/** Folders of the data dir every replica shares (plugins-data only for the memory plugin: the others keep live caches). */
export const FILE_ROOTS = ["workspaces", "pages", "agents", "skills", "commands", "devices", "plugins-data/memory"];

const HEARTBEAT_MS = 2_000;
/** A replica that has not answered for this long is gone; the next one leads. */
const GONE_MS = 8_000;
/** Ran nothing this long (the computer slept, the process was stopped): another replica may have taken the lead. */
const AWAY_MS = GONE_MS - HEARTBEAT_MS;
/** A leader back from such a gap has this long to hear whether another replica led meanwhile. */
const STALE_MS = 60_000;
/** A replica back from a sleep asks for the lead only once it has stayed awake this long. */
const AWAKE_BEFORE_LEAD_MS = 5 * 60_000;
/** A starting replica listens this long before it leads alone. */
const STARTUP_GRACE_MS = 6_000;
/** How long a leader waits for its turns before it hands over. */
const DRAIN_MS = 120_000;
const FILES_EVERY_MS = 5_000;
/** A file over a link goes in pieces this big. */
const FILE_PIECE = 4 * 1024 * 1024;

type Role = "leader" | "standby";
type DbName = "main" | "vault";
type Vector = Record<string, number>;

interface Identity extends ReplicaKey {
  name: string;
}

interface Hello {
  id: string;
  name: string;
  role: Role;
  priority: number;
  sealed: boolean;
  wantLead: boolean;
  /** It led, slept past GONE_MS and has just woken: a replica that led meanwhile keeps the lead. */
  stale?: boolean;
  vectors: Record<DbName, Vector>;
  version: string;
}

interface Peer extends Replica {
  publicKey: string;
  nodeUrls: string[];
  online: boolean;
  lastSeen: number;
  url?: string;
  hello?: Hello;
  pulling: Record<DbName, boolean>;
  /** The last pull from it found nothing more. */
  current: Record<DbName, number>;
  filesAt: number;
  filesBusy: boolean;
}

const rowToReplica = (r: any): Replica & { publicKey: string; nodeUrls: string[] } => ({
  id: r.id,
  name: r.name,
  urls: json<string[]>(r.urls, []),
  nodeUrls: json<string[]>(r.node_urls, []),
  priority: r.priority,
  createdAt: r.created_at,
  publicKey: r.public_key,
});

/** piomio://replica?c=<code>&u=<url>&u=…&fp=<fingerprint> */
export function replicaLink(code: string, urls: string[], fingerprint: string): string {
  const q = new URLSearchParams({ c: code });
  for (const u of urls) q.append("u", u);
  q.set("fp", fingerprint);
  return `piomio://replica?${q.toString()}`;
}

export function parseReplicaLink(link: string): { code: string; urls: string[]; fingerprint: string } {
  const u = new URL(link.trim());
  if (u.protocol !== "piomio:" || u.hostname !== "replica") throw new Error("not a replica link");
  const code = u.searchParams.get("c") ?? "";
  const urls = u.searchParams.getAll("u");
  const fingerprint = u.searchParams.get("fp") ?? "";
  if (!code || !urls.length || !fingerprint) throw new Error("incomplete replica link");
  return { code, urls, fingerprint };
}

export class Cluster {
  private hub: Hub;
  identity: Identity | undefined;
  role: Role = "leader";
  wantLead = false;
  /** Node workspaces and the replicas' files; on even for a hub of one (its machines share the workspaces). */
  files: FileSync;
  /** What this hub calls itself in file conflicts (a peer's syncFrom uses the same). */
  filesName: string;
  private main?: DbReplicator;
  private vaultRepl?: DbReplicator;
  private peers = new Map<string, Peer>();
  private timers: NodeJS.Timeout[] = [];
  private startedAt = 0;
  private running = false;
  private switching: Promise<void> = Promise.resolve();
  private handingOver = false;
  private asked = new Set<string>();
  private lastState = "";
  private synced = new Set<string>();
  private syncedTimer: NodeJS.Timeout | undefined;
  /** Lasting connections to peers (replica-link.ts), dialed by either side. */
  private links = new Map<string, RpcPeer>();
  private dialing = new Map<string, number>();
  private lastRead: { key: string; bytes: Uint8Array } | undefined;
  /** The wall clock at the last heartbeat or hello: a gap of AWAY_MS means this replica ran nothing meanwhile. */
  private aliveAt = 0;
  /** When this replica last came back from such a gap (0: not since it started). */
  private wokeAt = 0;
  /** Until when its lead counts as stale: it led into such a gap and has yet to hear who led meanwhile. */
  private staleUntil = 0;
  /** How long a replica back from a sleep stays awake before it asks for the lead (tests shorten it). */
  awakeBeforeLead = AWAKE_BEFORE_LEAD_MS;

  constructor(hub: Hub) {
    this.hub = hub;
    const f = this.identityFile();
    if (existsSync(f)) this.identity = JSON.parse(readFileSync(f, "utf8")) as Identity;
    this.filesName = this.identity?.name ?? hub.config.replicaName;
    this.files = new FileSync({
      roots: this.fileRoots(),
      stateFile: join(hub.config.dataDir, "replica", "files.db"),
      self: this.filesName,
      log: (m) => console.log(`[files] ${m}`),
    });
    if (this.identity) this.install();
  }

  get enabled(): boolean {
    return !!this.identity;
  }

  /** A hub of one always leads. */
  leads(): boolean {
    return !this.identity || this.role === "leader";
  }

  private identityFile(): string {
    return join(this.hub.config.dataDir, "replica", "identity.json");
  }

  fileRoots(): FileRoot[] {
    return FILE_ROOTS.map((name) => ({ name, dir: join(this.hub.config.dataDir, ...name.split("/")) }));
  }

  private install(): void {
    const origin = this.identity!.id;
    this.main = new DbReplicator({ db: this.hub.db, origin, tables: MAIN_TABLES, onApplied: (e) => this.onApplied(e), log: (m) => console.log(`[replica] ${m}`) });
    this.main.install();
    this.vaultRepl = new DbReplicator({ db: this.hub.vault.db, origin, tables: VAULT_TABLES, onApplied: (e) => this.onApplied(e), log: (m) => console.log(`[replica] ${m}`) });
    this.vaultRepl.install();
  }

  private repl(db: DbName): DbReplicator | undefined {
    return db === "main" ? this.main : this.vaultRepl;
  }

  // ---------- lifecycle ----------

  /** Called by Hub.start once its servers listen: a replica of several starts as standby and listens first. */
  async start(): Promise<void> {
    this.running = true;
    this.files.start(4_000);
    if (!this.identity) return;
    this.main!.start(250);
    this.vaultRepl!.start(250);
    this.refreshSelf();
    this.loadPeers();
    this.role = this.peers.size ? "standby" : "leader";
    this.startedAt = Date.now();
    const t = setInterval(() => void this.tick().catch((e) => console.error("[cluster]", e)), HEARTBEAT_MS);
    t.unref();
    this.timers.push(t);
    console.log(`[cluster] ${this.identity.name} starts as ${this.role} (${this.peers.size} other replica${this.peers.size === 1 ? "" : "s"})`);
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    // A switch in progress (taking or handing over the lead) finishes before the hub closes.
    await this.switching;
    for (const l of this.links.values()) l.close();
    this.links.clear();
    this.files.stop();
    this.main?.stop();
    this.vaultRepl?.stop();
  }

  // ---------- who we are ----------

  /** This replica's row, its addresses kept fresh (the link may come up later). */
  private refreshSelf(): void {
    const id = this.identity!.id;
    const urls = this.ownUrls();
    const nodeUrls = this.ownNodeUrls();
    const row = this.hub.db.prepare("select * from replicas where id = ?").get(id) as any;
    if (!row) {
      const max = (this.hub.db.prepare("select coalesce(max(priority), 0) as p from replicas").get() as { p: number }).p;
      this.hub.db
        .prepare("insert into replicas(id, name, public_key, urls, node_urls, priority, created_at) values (?,?,?,?,?,?,?)")
        .run(id, this.identity!.name, this.identity!.publicKey, JSON.stringify(urls), JSON.stringify(nodeUrls), max + 1, nowIso());
    } else if (row.urls !== JSON.stringify(urls) || row.node_urls !== JSON.stringify(nodeUrls)) {
      this.hub.db.prepare("update replicas set urls = ?, node_urls = ? where id = ?").run(JSON.stringify(urls), JSON.stringify(nodeUrls), id);
    }
  }

  /** Where replicas and phones reach this one: its device addresses (PIOMIO_DEVICE_URLS first), the link's :8443. */
  ownUrls(): string[] {
    return this.hub.phoneUrls();
  }

  /** Where machines reach this one for /node/ws and /mcp: PIOMIO_NODE_URLS, else its own machine address. */
  ownNodeUrls(): string[] {
    return this.hub.config.nodeUrls.length ? this.hub.config.nodeUrls : [this.hub.machineHubUrl()];
  }

  self(): (Replica & { priority: number }) | undefined {
    if (!this.identity) return undefined;
    const r = this.hub.db.prepare("select * from replicas where id = ?").get(this.identity.id) as any;
    return r ? rowToReplica(r) : undefined;
  }

  private loadPeers(): void {
    const rows = this.hub.db.prepare("select * from replicas where revoked = 0 and id != ?").all(this.identity!.id) as any[];
    const seen = new Set<string>();
    for (const r of rows) {
      seen.add(r.id);
      const base = rowToReplica(r);
      const p = this.peers.get(r.id);
      if (p) Object.assign(p, base);
      else this.peers.set(r.id, { ...base, online: false, lastSeen: 0, pulling: { main: false, vault: false }, current: { main: 0, vault: 0 }, filesAt: 0, filesBusy: false });
    }
    for (const id of [...this.peers.keys()]) if (!seen.has(id)) this.peers.delete(id);
  }

  private publicKeyOf = (id: string): string | undefined => {
    const r = this.hub.db.prepare("select public_key from replicas where id = ? and revoked = 0").get(id) as { public_key: string } | undefined;
    return r?.public_key;
  };

  /** The replica that signed a request to the device app, or undefined. */
  verify(method: string, path: string, body: string | Uint8Array, header: string | undefined): string | undefined {
    if (!this.identity) return undefined;
    return verifyRequest(header, method, path, body, this.publicKeyOf);
  }

  // ---------- talking to peers ----------

  private async call(p: Peer, method: string, path: string, body?: unknown, timeoutMs = 5_000): Promise<{ status: number; body: Buffer }> {
    const link = this.links.get(p.id);
    if (link && !link.closed) {
      const a = await link.request<LinkAnswer>("replica.call", { method, path, body } satisfies LinkCall, { timeoutMs });
      return { status: a.status, body: a.binary ? Buffer.from(String(a.body), "base64") : Buffer.from(JSON.stringify(a.body ?? null)) };
    }
    const text = body === undefined ? "" : JSON.stringify(body);
    const urls = p.url ? [p.url, ...p.urls.filter((u) => u !== p.url)] : p.urls;
    let last: unknown;
    for (const base of urls) {
      try {
        const r = await pinnedRequest(`${base.replace(/\/$/, "")}${path}`, {
          method,
          body: text,
          fingerprint: this.hub.deviceTls().fingerprint,
          timeoutMs,
          headers: { authorization: signRequest(this.identity!, method, path, text), ...(text ? { "content-type": "application/json" } : {}) },
        });
        p.url = base;
        return r;
      } catch (e) {
        last = e;
      }
    }
    throw last ?? new Error(`no address for ${p.name}`);
  }

  private async callJson<T>(p: Peer, method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const r = await this.call(p, method, path, body, timeoutMs);
    if (r.status !== 200) throw new Error(`${p.name} ${path}: ${r.status} ${r.body.toString().slice(0, 200)}`);
    return JSON.parse(r.body.toString()) as T;
  }

  private async tick(): Promise<void> {
    if (!this.running || !this.identity) return;
    this.noticeSleep();
    this.refreshSelf();
    this.loadPeers();
    for (const p of this.peers.values()) this.dial(p);
    await Promise.all(
      [...this.peers.values()].map(async (p) => {
        try {
          p.hello = await this.callJson<Hello>(p, "GET", "/api/replica/hello", undefined, 3_000);
          p.online = true;
          p.lastSeen = Date.now();
        } catch {
          if (Date.now() - p.lastSeen > GONE_MS) p.online = false;
        }
      }),
    );
    for (const p of this.peers.values()) {
      if (!p.online) continue;
      for (const db of ["main", "vault"] as const) if (!p.pulling[db]) void this.pullLoop(p, db);
      if (!p.filesBusy && Date.now() - p.filesAt > FILES_EVERY_MS) void this.syncFiles(p);
    }
    await this.decide();
    if (this.leads()) this.askToUnlock();
    this.emitState();
  }

  /** Long-polls a peer for entries we have not seen, as long as it answers. */
  private async pullLoop(p: Peer, db: DbName): Promise<void> {
    const repl = this.repl(db)!;
    p.pulling[db] = true;
    try {
      while (this.running && p.online) {
        const r = await this.callJson<{ entries: ReplEntry[]; more: boolean }>(p, "POST", "/api/replica/changes", { db, vector: repl.vector(), wait: 20_000 }, 30_000);
        if (r.entries.length) repl.apply(r.entries);
        if (!r.more) p.current[db] = Date.now();
      }
    } catch {
      /* it went away: the heartbeat notices */
    } finally {
      p.pulling[db] = false;
    }
  }

  private filePeer(p: Peer): FilePeer {
    return {
      changesSince: (cursor, limit) => this.callJson(p, "POST", "/api/replica/files/changes", { cursor, limit }, 30_000),
      read: async (root, path, sha) => {
        const link = this.links.get(p.id);
        if (link && !link.closed) {
          const parts: Buffer[] = [];
          let offset = 0;
          for (;;) {
            const a = await link.request<LinkAnswer>("replica.call", { method: "POST", path: "/api/replica/files/read", body: { root, path, sha, offset, length: FILE_PIECE } }, { timeoutMs: 120_000 });
            if (a.status === 404) return undefined;
            if (a.status !== 200) throw new Error(`${p.name} files/read: ${a.status}`);
            const piece = Buffer.from(String(a.body), "base64");
            parts.push(piece);
            offset += piece.length;
            if (!piece.length || offset >= (a.total ?? offset)) break;
          }
          return new Uint8Array(Buffer.concat(parts));
        }
        const r = await this.call(p, "POST", "/api/replica/files/read", { root, path, sha }, 120_000);
        if (r.status === 404) return undefined;
        if (r.status !== 200) throw new Error(`${p.name} files/read: ${r.status}`);
        return new Uint8Array(r.body);
      },
    };
  }

  private async syncFiles(p: Peer): Promise<void> {
    p.filesBusy = true;
    try {
      // A peer is named as it names itself, so both sides call a conflict copy the same.
      const r = await this.files.syncFrom(p.name, this.filePeer(p));
      if (r.pulled || r.deleted) this.markSynced("files");
    } catch (e: any) {
      console.error(`[files] ${p.name}: ${e?.message ?? e}`);
    } finally {
      p.filesAt = Date.now();
      p.filesBusy = false;
    }
  }

  // ---------- links ----------

  /** Keeps a link to a peer: dials its addresses now and then while there is none (its own dial may come first). */
  private dial(p: Peer): void {
    const l = this.links.get(p.id);
    if ((l && !l.closed) || Date.now() - (this.dialing.get(p.id) ?? 0) < 5_000) return;
    this.dialing.set(p.id, Date.now());
    void (async () => {
      for (const url of p.url ? [p.url, ...p.urls.filter((u) => u !== p.url)] : p.urls) {
        try {
          const ws = await dialLink({ url, key: this.identity!, fingerprint: this.hub.deviceTls().fingerprint });
          if (!this.running) return ws.close();
          this.attachLink(ws, p.id);
          return;
        } catch {
          /* the next address, or the peer dials us */
        }
      }
    })();
  }

  /** A peer's link that it dialed (device app, signed at the upgrade). */
  accept(ws: WebSocket, from: string): void {
    this.attachLink(ws, from);
  }

  private attachLink(ws: WebSocket, peerId: string): void {
    const rpc = linkPeer(ws);
    serveLink(rpc, peerId, {
      call: (from, c) => this.serveCall(from, c),
      deviceUrl: () => `https://127.0.0.1:${this.hub.config.devicePort}`,
      mainUrl: () => `http://127.0.0.1:${this.hub.config.port}`,
      fingerprint: () => this.hub.deviceTls().fingerprint,
    });
    const old = this.links.get(peerId);
    if (!old || old.closed) this.links.set(peerId, rpc);
    rpc.onClose(() => {
      if (this.links.get(peerId) === rpc) this.links.delete(peerId);
    });
  }

  /** The link to the leader, for forwarding the phones. */
  leaderLink(): RpcPeer | undefined {
    if (this.leads()) return undefined;
    const p = [...this.peers.values()].find((x) => x.online && x.hello?.role === "leader");
    const l = p && this.links.get(p.id);
    return l && !l.closed ? l : undefined;
  }

  /** What the device-app routes answer, for a call over a link. */
  private async serveCall(from: string, c: LinkCall): Promise<LinkAnswer> {
    const b = (c.body ?? {}) as any;
    switch (c.path) {
      case "/api/replica/hello":
        return { status: 200, body: this.hello() };
      case "/api/replica/changes":
        return { status: 200, body: await this.changes(b.db === "vault" ? "vault" : "main", b.vector ?? {}, Number(b.wait) || 0) };
      case "/api/replica/files/changes":
        return { status: 200, body: this.files.changesSince(Number(b.cursor) || 0, Math.min(Number(b.limit) || 500, 2_000)) };
      case "/api/replica/files/read": {
        // Over a link a file travels in pieces (offset, length); the last one read is kept for the next piece.
        const key = `${b.root}\n${b.path}\n${b.sha}`;
        let bytes = this.lastRead?.key === key ? this.lastRead.bytes : await this.files.read(String(b.root ?? ""), String(b.path ?? ""), String(b.sha ?? ""));
        if (!bytes) return { status: 404, body: { error: "gone" } };
        this.lastRead = { key, bytes };
        const total = bytes.length;
        if (b.length !== undefined) bytes = bytes.subarray(Number(b.offset) || 0, (Number(b.offset) || 0) + Number(b.length));
        return { status: 200, body: Buffer.from(bytes).toString("base64"), binary: true, total };
      }
      case "/api/replica/vault-key":
        this.receiveKey(from, String(b.key ?? ""));
        return { status: 200, body: { ok: true } };
      default:
        return { status: 404, body: { error: `no ${c.path}` } };
    }
  }

  // ---------- who leads ----------

  private better(p: Peer): boolean {
    const me = this.self();
    if (!me) return false;
    return p.priority < me.priority || (p.priority === me.priority && p.id < this.identity!.id);
  }

  /**
   * A sleeping computer runs nothing while its wall clock goes on (a Mac's DarkWake puts it to sleep every few minutes
   * at night): past GONE_MS another replica takes the lead. Checked at every heartbeat and hello, so the first peer to
   * ask after the wake already hears that this replica's lead went stale.
   */
  private noticeSleep(): void {
    const now = Date.now();
    const away = this.aliveAt ? now - this.aliveAt : 0;
    this.aliveAt = now;
    if (away < AWAY_MS) return;
    this.wokeAt = now;
    if (this.role === "leader" && this.peers.size) this.staleUntil = now + STALE_MS;
    console.log(`[cluster] ${this.identity?.name}: back after ${Math.round(away / 1000)} s asleep`);
  }

  private leadStale(): boolean {
    return Date.now() < this.staleUntil;
  }

  private async decide(): Promise<void> {
    const online = [...this.peers.values()].filter((p) => p.online && p.hello);
    const better = online.filter((p) => this.better(p));
    const leader = online.find((p) => p.hello!.role === "leader");
    if (this.role === "leader") {
      // Back from a sleep another replica led through: that one keeps the lead. This one held on to what it had before
      // it slept (plugins' memory, timers, its copies of rows): it stands down, catches up and asks for the lead later.
      if (leader && this.leadStale()) await this.switchTo("standby", "another replica led while this one slept", { stale: true });
      // After a split both led: the better one keeps it. A better one that is back and caught up gets it.
      else if (better.some((p) => p.hello!.role === "leader" && !p.hello!.stale)) await this.switchTo("standby", "a replica ahead of this one leads");
      else if (!this.handingOver && better.some((p) => p.hello!.wantLead)) void this.handOver();
      return;
    }
    if (better.length) {
      this.wantLead = false;
      return;
    }
    if (!leader) {
      if (Date.now() - this.startedAt >= STARTUP_GRACE_MS) await this.switchTo("leader", online.length ? "no replica leads" : "no other replica answers");
      return;
    }
    // A replica behind this one leads (it took over while this one was away): catch up, then ask for the lead.
    // Pulls are long polls (20 s): one that came back with nothing more within that time means caught up. Back from a
    // sleep, it asks only once it has stayed awake a while: a computer that naps all night leaves the lead with the
    // replica that stays up, instead of both switching at every wake.
    const fresh = (db: DbName) => Date.now() - (this.peers.get(leader.id)?.current[db] ?? 0) < 25_000;
    this.wantLead = fresh("main") && fresh("vault") && Date.now() - this.wokeAt >= this.awakeBeforeLead;
  }

  /** The leader steps down for a better replica once its turns are done (at most DRAIN_MS). */
  private async handOver(): Promise<void> {
    this.handingOver = true;
    try {
      const until = Date.now() + DRAIN_MS;
      while (this.hub.runner.busyTurns() > 0 && Date.now() < until && this.role === "leader") await new Promise((r) => setTimeout(r, 1_000));
      if (this.role === "leader") await this.switchTo("standby", "handing the lead to a replica ahead of this one");
    } finally {
      this.handingOver = false;
    }
  }

  private switchTo(role: Role, why: string, o: { stale?: boolean } = {}): Promise<void> {
    const next = this.switching.then(async () => {
      if (this.role === role || !this.running) return;
      console.log(`[cluster] ${this.identity?.name}: ${role} (${why})`);
      this.role = role;
      this.wantLead = false;
      this.staleUntil = 0;
      if (role === "leader") {
        await this.hub.lead();
        this.asked.clear();
      } else await this.hub.standby(o);
      this.hub.audit.append("core", `cluster.${role}`, this.identity?.id ?? "", { why });
      this.emitState(true);
    });
    this.switching = next.catch((e) => console.error("[cluster] switch failed", e));
    return this.switching;
  }

  /** The leader to forward clients to, when this replica is standby. */
  leaderTarget(): { url?: string; name: string; link?: RpcPeer } | undefined {
    if (this.leads()) return undefined;
    const p = [...this.peers.values()].find((x) => x.online && x.hello?.role === "leader");
    if (!p) return undefined;
    const link = this.links.get(p.id);
    return { name: p.name, ...(p.url ? { url: p.url } : {}), ...(link && !link.closed ? { link } : {}) };
  }

  // ---------- the vault on other replicas ----------

  /** A sealed replica gets one card in the assistant's dialog; the tap hands it the data key. */
  private askToUnlock(): void {
    if (this.hub.vault.state() !== "unlocked") return;
    const pending = this.hub.approvals.list(["pending"], 200).filter((a) => a.tool === "replica_unlock");
    // Cards from before a restart of this replica: it waits for them again.
    for (const a of pending) this.waitUnlock(a.id, String((a.input as any)?.replica ?? ""));
    for (const p of this.peers.values()) {
      if (!p.online || !p.hello?.sealed || this.asked.has(p.id)) continue;
      this.asked.add(p.id);
      if (pending.some((a) => (a.input as any)?.replica === p.id)) continue;
      const agentId = this.hub.settings.get().defaultAgent;
      // The person's "always allow" on an earlier card for this replica: no card, the key goes at once.
      const rule = this.hub.rules.list().find((r) => r.decision === "allow" && ruleMatches(r, "replica_unlock", agentId, { replica: p.id }));
      if (rule) {
        this.hub.audit.append("core", "replica.unlock", p.id, { ruleId: rule.id });
        void this.unlockPeer(p.id).catch((e: any) => {
          this.asked.delete(p.id);
          console.log(`[cluster] could not unlock ${p.name}: ${e?.message ?? e}`);
        });
        continue;
      }
      const conv = this.hub.store.agentConversation(agentId);
      const a = this.hub.approvals.create({
        sessionId: "cluster",
        conversationId: conv.id,
        agentId,
        tool: "replica_unlock",
        input: { replica: p.id },
        summary: t("cluster.unlockAsk", { name: p.name }),
        effect: "external",
        tainted: false,
      });
      this.waitUnlock(a.id, p.id);
    }
  }

  private waiting = new Set<string>();

  /** The card's tap: the key goes to that replica, and the card says it was done (no agent turn for it). */
  private waitUnlock(approvalId: string, replicaId: string): void {
    if (this.waiting.has(approvalId)) return;
    this.waiting.add(approvalId);
    void this.hub.approvals.wait(approvalId, 7 * 24 * 3600_000).then(async (d) => {
      this.waiting.delete(approvalId);
      if (d !== "approved") return;
      try {
        const name = await this.unlockPeer(replicaId);
        this.hub.approvals.markExecuted(approvalId, { content: [{ type: "text", text: `The vault on ${name} is unlocked.` }] });
      } catch (e: any) {
        this.hub.approvals.markExecuted(approvalId, { content: [{ type: "text", text: e?.message ?? String(e) }], isError: true });
      }
    });
  }

  /** Hands a sealed replica the data key (after the person's tap). */
  async unlockPeer(idOrName: string): Promise<string> {
    const p = [...this.peers.values()].find((x) => x.id === idOrName || x.name === idOrName);
    if (!p) throw new Error(`No replica ${idOrName}`);
    if (this.hub.vault.state() !== "unlocked") throw new Error("This replica's vault is locked too: unlock it first");
    await this.callJson(p, "POST", "/api/replica/vault-key", { key: this.hub.vault.exportKey() });
    this.asked.delete(p.id);
    return p.name;
  }

  // ---------- what peers ask of us (device app routes) ----------

  hello(): Hello {
    this.noticeSleep();
    const me = this.self();
    return {
      id: this.identity!.id,
      name: this.identity!.name,
      role: this.role,
      priority: me?.priority ?? 99,
      sealed: this.hub.vault.state() !== "unlocked",
      wantLead: this.wantLead,
      stale: this.leadStale(),
      vectors: { main: this.main!.vector(), vault: this.vaultRepl!.vector() },
      version: this.hub.config.version,
    };
  }

  async changes(db: DbName, vector: Vector, waitMs: number): Promise<{ entries: ReplEntry[]; more: boolean }> {
    const repl = this.repl(db);
    if (!repl) throw new Error(`unknown database ${db}`);
    repl.drain();
    let r = repl.changesSince(vector ?? {}, 500);
    if (!r.entries.length && waitMs > 0 && (await repl.waitForChanges(vector ?? {}, Math.min(waitMs, 25_000)))) r = repl.changesSince(vector ?? {}, 500);
    return r;
  }

  receiveKey(from: string, key: string): void {
    if (this.hub.vault.state() === "unlocked") return;
    this.hub.vault.unlockWithKey(key);
    this.hub.audit.append(`replica:${from}`, "vault.unlock.replica", this.identity?.id ?? "");
  }

  // ---------- joining ----------

  /** An invite for a new replica; this hub becomes a cluster (of one, so far) if it was not. */
  invite(): { link: string; code: string } {
    if (!this.identity) {
      const id = newId("rep_");
      this.identity = { ...newReplicaKey(id), name: this.hub.config.replicaName };
      mkdirSync(join(this.hub.config.dataDir, "replica"), { recursive: true, mode: 0o700 });
      writeFileSync(this.identityFile(), JSON.stringify(this.identity), { mode: 0o600 });
      this.install();
      this.main!.start(250);
      this.vaultRepl!.start(250);
      this.refreshSelf();
      this.role = "leader";
      this.startedAt = Date.now();
      const t = setInterval(() => void this.tick().catch((e) => console.error("[cluster]", e)), HEARTBEAT_MS);
      t.unref();
      this.timers.push(t);
    }
    const { code } = this.hub.invites.create();
    return { code, link: replicaLink(code, this.ownUrls(), this.hub.deviceTls().fingerprint) };
  }

  /** A new replica with an invite: its row, and a snapshot of everything to start from. */
  join(p: { code: string; publicKey: string; name: string; urls: string[]; nodeUrls: string[] }): JoinSnapshot {
    if (!this.identity) throw new Error("This hub has no cluster yet");
    const pub = Buffer.from(String(p.publicKey ?? ""), "base64url");
    if (pub.length !== 32) throw new Error("bad public key");
    let id = newId("rep_");
    if (this.hub.invites.consume(p.code, `replica:${id}`)) {
      const max = (this.hub.db.prepare("select coalesce(max(priority), 0) as p from replicas").get() as { p: number }).p;
      this.hub.db
        .prepare("insert into replicas(id, name, public_key, urls, node_urls, priority, created_at) values (?,?,?,?,?,?,?)")
        .run(id, String(p.name || "replica").slice(0, 40), p.publicKey, JSON.stringify(p.urls ?? []), JSON.stringify(p.nodeUrls ?? []), max + 1, nowIso());
      this.hub.audit.append("user", "replica.join", id, { name: p.name });
    } else {
      // The same machine again (its answer was lost on the way): the same key gets the snapshot once more.
      const again = this.hub.db
        .prepare("select id from replicas where public_key = ? and revoked = 0 and created_at > ?")
        .get(p.publicKey, new Date(Date.now() - 15 * 60_000).toISOString()) as { id: string } | undefined;
      if (!again) throw new Error("The invite has expired or was already used");
      id = again.id;
    }
    this.main!.drain();
    this.vaultRepl!.drain();
    const dir = join(tmpdir(), `piomio-join-${id}`);
    mkdirSync(dir, { recursive: true });
    try {
      this.main!.snapshot(join(dir, "piomio.db"));
      this.vaultRepl!.snapshot(join(dir, "vault.db"));
      const tls = this.hub.deviceTls();
      return {
        id,
        db: readFileSync(join(dir, "piomio.db")).toString("base64"),
        vault: readFileSync(join(dir, "vault.db")).toString("base64"),
        tls: { key: tls.key, cert: tls.cert },
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** A replica leaves the cluster for good (its key no longer signs anything here). */
  remove(idOrName: string): string {
    const r = this.hub.db.prepare("select id, name from replicas where (id = ? or name = ?) and revoked = 0").get(idOrName, idOrName) as { id: string; name: string } | undefined;
    if (!r) throw new Error(`No replica ${idOrName}`);
    if (r.id === this.identity?.id) throw new Error("This replica cannot remove itself");
    this.hub.db.prepare("update replicas set revoked = 1 where id = ?").run(r.id);
    this.links.get(r.id)?.close();
    this.links.delete(r.id);
    this.peers.delete(r.id);
    this.hub.audit.append("user", "replica.remove", r.id, { name: r.name });
    this.emitState(true);
    return r.name;
  }

  // ---------- what the apps see ----------

  states(): ReplicaState[] {
    if (!this.identity) return [];
    const me = this.self();
    const out: ReplicaState[] = [];
    if (me) out.push({ ...me, self: true, online: true, role: this.role, sealed: this.hub.vault.state() !== "unlocked" });
    for (const p of this.peers.values()) {
      out.push({
        id: p.id,
        name: p.name,
        urls: p.urls,
        priority: p.priority,
        createdAt: p.createdAt,
        self: false,
        online: p.online,
        role: p.online ? (p.hello?.role ?? "unknown") : "unknown",
        sealed: !!p.hello?.sealed,
        ...(p.lastSeen ? { lastSeenAt: new Date(p.lastSeen).toISOString() } : {}),
      });
    }
    return out.sort((a, b) => a.priority - b.priority);
  }

  /** Every replica's device addresses, the leader's first (phones keep the list and take the first that answers). */
  phoneUrls(own: string[]): string[] {
    if (!this.identity) return own;
    const lead = this.leads() ? own : [];
    const peers = [...this.peers.values()].sort((a, b) => Number(b.hello?.role === "leader") - Number(a.hello?.role === "leader") || a.priority - b.priority);
    return [...new Set([...lead, ...peers.flatMap((p) => p.urls), ...own])];
  }

  /** Every replica's address for machines (node.setup), this one's first. */
  nodeUrls(): string[] {
    if (!this.identity) return [];
    const rows = (this.hub.db.prepare("select * from replicas where revoked = 0 order by priority").all() as any[]).map(rowToReplica);
    const mine = rows.find((r) => r.id === this.identity!.id);
    return [...new Set([...(mine?.nodeUrls ?? []), ...rows.flatMap((r) => r.nodeUrls)])];
  }

  private emitState(force = false): void {
    const s = this.states();
    const key = JSON.stringify(s.map((x) => [x.id, x.online, x.role, x.sealed, x.priority]));
    if (!force && key === this.lastState) return;
    this.lastState = key;
    this.hub.bus.emit("cluster.updated", s);
  }

  private onApplied(entries: ReplEntry[]): void {
    for (const e of entries) this.synced.add(e.tbl);
    if (entries.some((e) => e.tbl === "vault_items" || e.tbl === "vault_meta")) this.hub.vault.refreshRedactor();
    if (entries.some((e) => e.tbl === "machine_settings") && this.leads()) {
      for (const e of entries) if (e.tbl === "machine_settings") this.hub.bus.emit("machine.setup", { machineId: String(e.pk[0]) });
    }
    this.flushSynced();
  }

  private markSynced(what: string): void {
    this.synced.add(what);
    this.flushSynced();
  }

  /** Open apps re-read what they show, at most once a second. */
  private flushSynced(): void {
    if (this.syncedTimer) return;
    this.syncedTimer = setTimeout(() => {
      this.syncedTimer = undefined;
      const tables = [...this.synced];
      this.synced.clear();
      if (tables.length) this.hub.bus.emit("replica.synced", { tables });
    }, 1_000);
    this.syncedTimer.unref();
  }
}

export interface JoinSnapshot {
  id: string;
  /** base64 of the databases (VACUUM INTO copies). */
  db: string;
  vault: string;
  tls: { key: string; cert: string };
}

/**
 * `piomio replica join <link>` on the new machine, before its hub runs: makes its key, joins through the inviter and
 * writes the data dir to start from. The hub then starts as a standby and catches up.
 */
export async function joinCluster(o: { dataDir: string; link: string; name: string; urls: string[]; nodeUrls: string[]; force?: boolean }): Promise<{ id: string }> {
  const { code, urls, fingerprint } = parseReplicaLink(o.link);
  if (existsSync(join(o.dataDir, "piomio.db")) && !o.force) throw new Error(`${o.dataDir} already holds a hub; use --force to replace it`);
  const tmpKey = newReplicaKey("pending");
  const body = JSON.stringify({ code, publicKey: tmpKey.publicKey, name: o.name, urls: o.urls, nodeUrls: o.nodeUrls });
  let snap: JoinSnapshot | undefined;
  let last: unknown;
  for (const base of urls) {
    try {
      const r = await pinnedRequest(`${base.replace(/\/$/, "")}/api/replica/join`, { method: "POST", body, fingerprint, timeoutMs: 300_000, headers: { "content-type": "application/json" } });
      if (r.status !== 200) throw new Error(`${base}: ${r.status} ${r.body.toString().slice(0, 300)}`);
      snap = JSON.parse(r.body.toString()) as JoinSnapshot;
      break;
    } catch (e) {
      last = e;
    }
  }
  if (!snap) throw last ?? new Error("no address answered");
  mkdirSync(join(o.dataDir, "replica"), { recursive: true, mode: 0o700 });
  mkdirSync(join(o.dataDir, "devices"), { recursive: true, mode: 0o700 });
  for (const f of ["piomio.db", "piomio.db-wal", "piomio.db-shm", "vault.db", "vault.db-wal", "vault.db-shm"]) rmSync(join(o.dataDir, f), { force: true });
  writeFileSync(join(o.dataDir, "piomio.db"), Buffer.from(snap.db, "base64"), { mode: 0o600 });
  writeFileSync(join(o.dataDir, "vault.db"), Buffer.from(snap.vault, "base64"), { mode: 0o600 });
  writeFileSync(join(o.dataDir, "devices", "tls-key.pem"), snap.tls.key, { mode: 0o600 });
  writeFileSync(join(o.dataDir, "devices", "tls-cert.pem"), snap.tls.cert, { mode: 0o644 });
  const identity: Identity = { ...tmpKey, id: snap.id, name: o.name };
  writeFileSync(join(o.dataDir, "replica", "identity.json"), JSON.stringify(identity), { mode: 0o600 });
  return { id: snap.id };
}

/**
 * `piomio replica invite` from the hub's own machine, the hub running or not: this hub gets its replica identity (if it
 * has none) and a one-time invite. A running hub that had no identity starts acting as a replica after a restart.
 */
export function localInvite(o: { dataDir: string; db: import("./db.ts").Db; invites: { create(): { code: string } }; name: string; urls: string[]; nodeUrls: string[]; fingerprint: string }): { link: string; created: boolean } {
  const file = join(o.dataDir, "replica", "identity.json");
  let created = false;
  let identity: Identity;
  if (existsSync(file)) identity = JSON.parse(readFileSync(file, "utf8")) as Identity;
  else {
    identity = { ...newReplicaKey(newId("rep_")), name: o.name.slice(0, 40) };
    mkdirSync(join(o.dataDir, "replica"), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(identity), { mode: 0o600 });
    created = true;
  }
  const row = o.db.prepare("select id from replicas where id = ?").get(identity.id);
  if (!row) {
    const max = (o.db.prepare("select coalesce(max(priority), 0) as p from replicas").get() as { p: number }).p;
    o.db
      .prepare("insert into replicas(id, name, public_key, urls, node_urls, priority, created_at) values (?,?,?,?,?,?,?)")
      .run(identity.id, identity.name, identity.publicKey, JSON.stringify(o.urls), JSON.stringify(o.nodeUrls), max + 1, nowIso());
  } else if (o.urls.length) {
    o.db.prepare("update replicas set urls = ?, node_urls = ? where id = ?").run(JSON.stringify(o.urls), JSON.stringify(o.nodeUrls), identity.id);
  }
  const { code } = o.invites.create();
  return { link: replicaLink(code, o.urls, o.fingerprint), created };
}
