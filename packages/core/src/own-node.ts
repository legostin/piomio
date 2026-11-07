// A hub replica's own computer as a machine of its cluster. While another replica leads, nothing runs in this hub
// (cluster.ts: main-only work is the leader's), so the CLIs signed in here (Claude Code, Codex, Kimi) reach the leader
// the way any computer's do: through a machine daemon (packages/node). A computer that already runs piomio-node next
// to its hub (a server set up by install.sh) keeps that one; any other replica pairs a daemon of its own
// (<data>/node) and runs it in this process. The replica publishes which machine serves its computer
// (replicas.machine_id), so whoever leads names that machine by the replica (machines.ts canonical) and an agent bound
// to this computer thinks here whoever leads.

import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createNodeDaemon, defaultPolicy, generateKey, loadConfig, loadKey, savePaired, type NodeDaemon } from "@piomio/node";
import { newId, nowIso } from "@piomio/shared";
import type { Hub } from "./app.ts";
import { confinement } from "./native-permissions.ts";
import { localComputerName } from "./pairing.ts";

/** How soon the daemon tries again after the hub refused it (its row has yet to reach the leader, or a key changed). */
const RETRY_MS = 30_000;
/** A pairing just made: its row reaches the leader before the daemon knocks there. */
const FRESH_MS = 5_000;

export class OwnNode {
  private hub: Hub;
  private daemon?: NodeDaemon;
  private retry?: NodeJS.Timeout;
  private stopped = false;

  constructor(hub: Hub) {
    this.hub = hub;
  }

  /** The daemon's home: config.json and key.json (its pairing), policy.json (what it may do on this computer). */
  home(): string {
    return join(this.hub.config.dataDir, "node");
  }

  /**
   * Where its brains work: this replica's own workspaces, which the replica keeps in step with the others itself
   * (cluster.ts file roots), so the daemon syncs no copy of its own.
   */
  workspaces(): string {
    return join(this.hub.config.dataDir, "workspaces");
  }

  /** Whether the daemon runs in this process now. */
  running(): boolean {
    return !!this.daemon;
  }

  /** The machine id of the daemon this hub paired for itself, if it did. */
  ownId(): string | undefined {
    try {
      return loadConfig(this.home()).machineId;
    } catch {
      return undefined;
    }
  }

  /**
   * The machine that serves this computer for the other replicas: a piomio-node of this computer's user (proven by
   * the host identity, or by its pairing in this user's home), else the daemon this hub paired for itself.
   */
  machineId(): string | undefined {
    const external = this.external();
    if (external) return external;
    const own = this.ownId();
    return own && this.paired(own) ? own : undefined;
  }

  /**
   * Called on every cluster heartbeat: a replica among others runs its daemon unless its computer has a piomio-node of
   * its own; a hub of one (or one whose computer the person removed from the machines) runs none.
   */
  async sync(inCluster: boolean): Promise<void> {
    if (this.stopped || !this.hub.config.ownNode) return;
    const want = inCluster && !this.external();
    if (!want) {
      if (this.daemon) await this.stopDaemon("not needed");
      return;
    }
    if (this.daemon || this.retry) return;
    const paired = this.ensurePaired();
    if (!paired) return;
    if (paired.fresh) this.wait(FRESH_MS);
    else this.startDaemon();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    this.retry = undefined;
    await this.stopDaemon("the hub stops");
  }

  // ---------- inside ----------

  /** A machine paired on this computer by other means: verified by its host proof, or by its pairing in this home. */
  private external(): string | undefined {
    const own = this.ownId();
    for (const id of this.hub.machines.aliases()) if (id !== own && this.paired(id)) return id;
    try {
      // piomio-node's own home (install.sh runs it as the same user, with its default home, packages/node home.ts).
      const id = loadConfig(join(homedir(), ".piomio-node")).machineId;
      if (id !== own && this.paired(id)) return id;
    } catch {
      /* none here */
    }
    return undefined;
  }

  /** Paired with this hub and not removed. */
  private paired(id: string): boolean {
    const r = this.hub.db.prepare("select revoked from machines where id = ?").get(id) as { revoked: number } | undefined;
    return !!r && !r.revoked;
  }

  private localUrl(): string {
    const host = ["0.0.0.0", "::", ""].includes(this.hub.config.host) ? "127.0.0.1" : this.hub.config.host;
    return `http://${host.includes(":") ? `[${host}]` : host}:${this.hub.config.port}`;
  }

  /**
   * Pairs the daemon with this hub directly: a key of its own and a machines row (replicated to the leader). One the
   * person removed stays removed; a pairing whose row is gone (the data was reset) pairs again.
   */
  private ensurePaired(): { id: string; fresh?: boolean } | undefined {
    const home = this.home();
    const own = this.ownId();
    if (own) {
      const r = this.hub.db.prepare("select revoked from machines where id = ?").get(own) as { revoked: number } | undefined;
      if (r?.revoked) return undefined;
      if (r) {
        // Its hub's address: the port may have moved since it paired.
        const c = loadConfig(home);
        if (c.hubUrl !== this.localUrl()) savePaired(home, { ...c, hubUrl: this.localUrl() }, loadKey(home));
        return { id: own };
      }
    }
    const key = generateKey();
    const id = newId("mach_");
    const name = localComputerName(this.hub.machines.list()).slice(0, 60);
    savePaired(home, { hubUrl: this.localUrl(), machineId: id, name, pairedAt: nowIso() }, key);
    if (!existsSync(join(home, "policy.json"))) {
      const ws = this.workspaces();
      writeFileSync(join(home, "policy.json"), JSON.stringify({ ...defaultPolicy(), allowedDirs: [ws], workspacesRoot: ws }, null, 2) + "\n", { mode: 0o600 });
    }
    this.hub.db.prepare("insert into machines(id, name, public_key, info, last_seen_at, created_at) values (?,?,?,?,?,?)").run(id, name, key.publicKey, null, null, nowIso());
    this.hub.audit.append("core", "machine.pair", id, { name, own: true });
    console.log(`[own-node] paired this computer as machine ${name} (${id})`);
    return { id, fresh: true };
  }

  /** No start until `ms` from now (sync starts it on a heartbeat after that). */
  private wait(ms: number): void {
    this.retry = setTimeout(() => {
      this.retry = undefined;
    }, ms);
    this.retry.unref();
  }

  private startDaemon(): void {
    const log = (m: string) => console.log(`[own-node] ${m}`);
    try {
      this.daemon = createNodeDaemon({
        home: this.home(),
        log,
        userPath: this.hub.userPath,
        files: false,
        // In this computer's sandbox, as this hub's own brains here: its data folder (vault, conversations) and the
        // person's private stores stay closed. Nothing goes past it: the leader would judge such a request by its own
        // computer's paths, so no permission tool. Kimi has no sandbox of its own: this computer's policy answers it.
        confine: (workspace, brainId) => (this.hub.config.sandboxBrains && brainId !== "kimi" ? confinement(this.hub.config.dataDir, workspace) : undefined),
        onFatal: (message) => {
          // Refused: its row may not have reached the leader yet. Try again later, unless the person removed it.
          log(message);
          void this.stopDaemon("refused").then(() => {
            if (!this.stopped) this.wait(RETRY_MS);
          });
        },
      });
      this.daemon.client.start();
      log(`runs as machine ${this.daemon.config.name} (${this.daemon.config.machineId}) through ${this.daemon.config.hubUrl}`);
    } catch (e: any) {
      log(`did not start: ${e?.message ?? e}`);
      this.daemon = undefined;
      this.wait(RETRY_MS);
    }
  }

  private async stopDaemon(why: string): Promise<void> {
    const d = this.daemon;
    if (!d) return;
    this.daemon = undefined;
    console.log(`[own-node] stops: ${why}`);
    await d.stop().catch(() => {});
  }
}
