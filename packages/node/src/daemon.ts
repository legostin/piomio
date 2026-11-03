// Composition root for `piomio-node run` (also used by tests).

import { join } from "node:path";
import { FileSync, readInPieces, type PieceAnswer } from "@piomio/replica";
import { loadConfig, loadKey, saveHubUrls, type NodeConfig } from "./home.ts";
import { PolicyStore } from "./policy.ts";
import { BrainHost, type BrainHostOptions } from "./brains.ts";
import { NodeService } from "./service.ts";
import { NodeClient } from "./client.ts";
import type { Logger } from "./info.ts";
import { ModelGateway } from "./gateway.ts";
import { t } from "./messages.ts";

export interface NodeDaemonOptions {
  home: string;
  log: Logger;
  /** For tests: base for default policy paths (default: os.homedir()). */
  userHome?: string;
  bridgeCommand?: string[];
  pingIntervalMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  onFatal?: (message: string) => void;
  /** The user's login-shell PATH for the CLIs (brains.ts); `run` passes it. */
  userPath?: BrainHostOptions["userPath"];
  /** How often to look at the CLIs again while none is signed in (client.ts). */
  brainRecheckMs?: number;
}

export interface NodeDaemon {
  config: NodeConfig;
  policy: PolicyStore;
  brains: BrainHost;
  service: NodeService;
  client: NodeClient;
  gateway: ModelGateway;
  stop(): Promise<void>;
}

export function createNodeDaemon(o: NodeDaemonOptions): NodeDaemon {
  const config = loadConfig(o.home);
  const key = loadKey(o.home);
  const policy = new PolicyStore(o.home, { userHome: o.userHome, log: o.log });
  // Brains signed in with a key from the hub reach their providers through this (the key never leaves the daemon).
  let service: NodeService | undefined;
  const gateway = new ModelGateway({ onUsage: (u) => service?.usage(u), log: o.log });
  void gateway.start().then(
    (port) => o.log(t("gateway.ready", { port })),
    (e) => o.log(`gateway: ${e?.message ?? e}`),
  );
  const brains = new BrainHost({
    home: o.home, policy, gateway, hubUrl: config.hubUrl, bridgeCommand: o.bridgeCommand, log: o.log, userPath: o.userPath,
    // The person's files for a turn, straight from the hub, in the same pieces file sync reads them in.
    fetchFile: async (path, sha) => {
      const peer = service?.leaderPeer();
      return peer ? readInPieces((q) => peer.request<PieceAnswer>("files.read", q, { timeoutMs: 120_000 }), "workspaces", path, sha) : undefined;
    },
  });
  // The daemon's own home (key, policy) is never reachable through fs.*/exec, even if an allowed dir contains it.
  service = new NodeService({ policy, brains, log: o.log, guard: { deny: [o.home] } });
  const clientFor = (hubUrl: string, secondary: boolean) =>
    new NodeClient({
      hubUrl,
      machineId: config.machineId,
      secretKey: key.secretKey,
      service: service!,
      log: o.log,
      pingIntervalMs: o.pingIntervalMs,
      minBackoffMs: o.minBackoffMs,
      maxBackoffMs: o.maxBackoffMs,
      brainRecheckMs: o.brainRecheckMs,
      ...(secondary ? { secondary: true } : { onFatal: o.onFatal }),
    });
  const client = clientFor(config.hubUrl, false);
  // The hub's other replicas: a connection to each, so whichever leads finds this machine at once.
  const norm = (u: string) => u.replace(/\/$/, "");
  const others = new Map<string, NodeClient>();
  const connectHubs = (urls: string[]) => {
    for (const u of urls.map(norm)) {
      if (u === norm(config.hubUrl) || others.has(u)) continue;
      const c = clientFor(u, true);
      others.set(u, c);
      c.start();
    }
  };
  const origStart = client.start.bind(client);
  client.start = () => {
    origStart();
    connectHubs(config.hubUrls ?? []);
  };

  // The workspaces folder is the leader's own `workspaces`: each side pulls what the other changed.
  const files = new FileSync({
    roots: [{ name: "workspaces", dir: policy.get().workspacesRoot }],
    stateFile: join(o.home, "files.db"),
    // Not the machine's bare name: a hub replica on the same machine is a peer of its own (its own journal).
    self: `${config.name || "machine"}-node`,
    log: (m) => o.log(`files: ${m}`),
  });
  service.files = files;
  let filesOn = false;
  let pulling = false;
  let hubName = "hub";
  const filesTimer = setInterval(() => {
    const peer = service!.leaderPeer();
    if (!filesOn || !peer || pulling) return;
    pulling = true;
    void files
      .syncFrom(hubName, {
        changesSince: (cursor, limit) => peer.request("files.changes", { cursor, limit }, { timeoutMs: 60_000 }),
        read: (root, path, sha) => readInPieces((q) => peer.request<PieceAnswer>("files.read", q, { timeoutMs: 120_000 }), root, path, sha),
      })
      .catch((e) => o.log(`files: ${e?.message ?? e}`))
      .finally(() => (pulling = false));
  }, 5_000);
  filesTimer.unref();
  service.onSetup = (setup) => {
    if (setup.hubs?.length) {
      try {
        saveHubUrls(o.home, setup.hubs);
      } catch {
        /* read-only home: keep them in memory */
      }
      connectHubs(setup.hubs);
    }
    if (setup.filesName) hubName = setup.filesName;
    if (setup.files && !filesOn) {
      filesOn = true;
      files.start(4_000);
    }
  };
  return {
    config,
    policy,
    brains,
    service,
    client,
    gateway,
    stop: async () => {
      clearInterval(filesTimer);
      files.stop();
      await Promise.all([client.stop(), ...[...others.values()].map((c) => c.stop())]);
      await gateway.stop();
    },
  };
}
