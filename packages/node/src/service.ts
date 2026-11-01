// What the hub may ask of this machine: brain.*, exec.run, fs.*. Every request is checked against the
// local policy and logged as one line (never with file contents).

import type { ChildProcess } from "node:child_process";
import type { MachineUsage, NodeSetup, RpcPeer } from "@piomio/shared";
import type { FileSync } from "@piomio/replica";
import type { PolicyStore } from "./policy.ts";
import type { BrainHost } from "./brains.ts";
import type { GuardOptions } from "./guard.ts";
import type { Logger } from "./info.ts";
import { execRun, killTree } from "./exec.ts";
import { fsList, fsRead, fsWrite } from "./fsops.ts";
import { t as tLocal } from "./messages.ts";
import { applyUpdate, type NodeUpdate } from "./self-update.ts";

const short = (s: unknown, max = 160): string => {
  const t = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

/** One-line description of a request for the log: never file contents or prompts. */
function describe(method: string, p: any): string {
  switch (method) {
    case "exec.run":
      return `${short(p?.command)}${p?.cwd ? ` (in ${short(p.cwd, 120)})` : ""}`;
    case "fs.read":
    case "fs.list":
      return short(p?.path ?? ".", 200);
    case "fs.write":
      return `${short(p?.path, 200)} (${typeof p?.content === "string" ? Buffer.byteLength(p.content) : 0} B)`;
    case "brain.probe":
      return String(p?.brainId ?? "");
    case "brain.create":
      return `${p?.brainId} session=${p?.opts?.sessionId} workspace=${short(p?.opts?.workspace, 80)}`;
    case "brain.send":
    case "brain.steer":
      return `session=${p?.sessionId} (${typeof p?.turn?.text === "string" ? p.turn.text.length : 0} chars)`;
    case "brain.warm":
    case "brain.interrupt":
    case "brain.close":
      return `session=${p?.sessionId}`;
    default:
      return "";
  }
}

function outcome(method: string, r: any): string {
  if (method === "exec.run") return `exit ${r?.code}`;
  if (method === "fs.read") return `${Buffer.byteLength(String(r?.content ?? ""))} B`;
  if (method === "fs.write") return `${r?.bytes} B`;
  if (method === "fs.list") return `${r?.entries?.length ?? 0} entries`;
  if (method === "brain.probe") return r?.available ? `available${r.authenticated ? "" : ", not signed in"}` : "unavailable";
  if (method === "brain.steer") return r?.accepted ? "joined the turn" : "no turn to join";
  return "ok";
}

export class NodeService {
  readonly policy: PolicyStore;
  readonly brains: BrainHost;
  readonly guard: GuardOptions;
  private log: Logger;
  private children = new Set<ChildProcess>();
  /** The hub connection the setup came from (the cluster's leader): spend goes back there. */
  private setupFrom: RpcPeer | undefined;
  /** The daemon learns the hub's replicas and starts sharing the workspaces. */
  onSetup?: (setup: NodeSetup, peer: RpcPeer) => void;
  /** The workspaces folder shared with the leader (files.*). */
  files?: FileSync;

  /** The leader's connection, while it is open. */
  leaderPeer(): RpcPeer | undefined {
    return this.setupFrom && !this.setupFrom.closed ? this.setupFrom : undefined;
  }

  constructor(o: { policy: PolicyStore; brains: BrainHost; log: Logger; guard?: GuardOptions }) {
    this.policy = o.policy;
    this.brains = o.brains;
    this.log = o.log;
    this.guard = o.guard ?? {};
  }

  private wrap<P, R>(method: string, fn: (p: P) => Promise<R> | R): (p: P) => Promise<R> {
    return async (p: P) => {
      const started = Date.now();
      const what = describe(method, p);
      try {
        const r = await fn(p);
        this.log(`${method} ${what} → ${outcome(method, r)} (${Date.now() - started} ms)`);
        return r;
      } catch (e: any) {
        this.log(`${method} ${what} → denied: ${e?.message ?? e}`);
        throw e;
      }
    };
  }

  /** A call the gateway made: the hub that set this machine up counts it. */
  usage(u: MachineUsage): void {
    if (this.setupFrom && !this.setupFrom.closed) this.setupFrom.notify("node.usage", u);
  }

  /** Register all request handlers on a freshly authenticated hub connection. */
  attach(peer: RpcPeer, hubUrl?: string): void {
    const policy = () => this.policy.get();
    peer.handle("node.setup", (p: NodeSetup) => {
      if (!p || typeof p !== "object" || typeof p.brains !== "object") throw new Error("bad setup");
      this.brains.applySetup(p);
      this.setupFrom = peer;
      this.onSetup?.(p, peer);
      const brains = Object.entries(p.brains)
        .map(([id, b]) => `${id} ${b!.auth}${b!.models.length ? ` (${b!.models.map((m) => m.id).join(", ")})` : ""}`)
        .join("; ");
      this.log(tLocal("gateway.setup", { brains: brains || "—" }));
      return {};
    });
    // The hub's own version of this daemon (the machines block's "Update"): checked, swapped in, then a restart.
    peer.handle("node.update", async (p: NodeUpdate) => {
      const r = await applyUpdate(p);
      this.log(tLocal("update.applied", { version: p.version }));
      return r;
    });
    peer.handle("files.changes", (p: { cursor?: number; limit?: number }) => {
      if (!this.files) return { changes: [], cursor: Number(p?.cursor) || 0, more: false };
      return this.files.changesSince(Number(p?.cursor) || 0, Math.min(Number(p?.limit) || 500, 2_000));
    });
    peer.handle("files.read", async (p: { root?: string; path?: string; sha?: string }) => {
      if (!this.files || p?.root !== "workspaces") return null;
      const b = await this.files.read("workspaces", String(p.path ?? ""), String(p.sha ?? ""));
      return b ? Buffer.from(b).toString("base64") : null;
    });
    peer.handle("exec.run", this.wrap("exec.run", (p: any) => execRun(p ?? {}, policy(), this.guard, this.children)));
    peer.handle("fs.read", this.wrap("fs.read", (p: any) => fsRead(p ?? {}, policy(), this.guard)));
    peer.handle("fs.write", this.wrap("fs.write", (p: any) => fsWrite(p ?? {}, policy(), this.guard)));
    peer.handle("fs.list", this.wrap("fs.list", (p: any) => fsList(p ?? {}, policy(), this.guard)));
    peer.handle("brain.probe", this.wrap("brain.probe", (p: any) => this.brains.probe(p ?? {})));
    peer.handle(
      "brain.create",
      this.wrap("brain.create", async (p: any) => {
        await this.brains.create(p ?? {}, peer, hubUrl);
        return {};
      }),
    );
    peer.handle(
      "brain.send",
      this.wrap("brain.send", async (p: any) => {
        await this.brains.send(p ?? {}, (event) => peer.notify("brain.event", { sessionId: p.sessionId, event }));
        return {};
      }),
    );
    peer.handle(
      "brain.steer",
      this.wrap("brain.steer", async (p: any) => ({ accepted: await this.brains.steer(p ?? {}) })),
    );
    peer.handle(
      "brain.warm",
      this.wrap("brain.warm", async (p: any) => {
        await this.brains.warm(p ?? {});
        return {};
      }),
    );
    peer.handle(
      "brain.interrupt",
      this.wrap("brain.interrupt", async (p: any) => {
        await this.brains.interrupt(p ?? {});
        return {};
      }),
    );
    peer.handle(
      "brain.close",
      this.wrap("brain.close", async (p: any) => {
        await this.brains.close(p ?? {});
        return {};
      }),
    );
  }

  /** Connection lost or shutting down: nobody will read the results, so stop everything. */
  async abortAll(): Promise<void> {
    for (const c of this.children) killTree(c);
    this.children.clear();
    await this.brains.closeAll();
  }

  /** One of several hub connections went away: only the sessions it opened stop. */
  async detach(peer: RpcPeer): Promise<void> {
    if (this.setupFrom === peer) this.setupFrom = undefined;
    await this.brains.closeAll(peer);
  }
}
