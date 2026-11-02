// Hub connection: outgoing WebSocket to <hub>/node/ws, Ed25519 challenge auth, then JSON-RPC 2.0.
// Reconnects forever with exponential backoff (max 60 s); a 4401 close (revoked / unknown key) is fatal.

import WebSocket from "ws";
import { createRpcPeer, normalizeLocale, wsTransport, type MachineInfo, type RpcPeer, type WsLike } from "@piomio/shared";
import { setHubLocale, t } from "./messages.ts";
import { nodeWsUrl } from "./home.ts";
import { signChallenge } from "./keys.ts";
import { graphicsCards } from "@piomio/shared/hardware";
import { machineInfo, type Logger } from "./info.ts";
import type { NodeService } from "./service.ts";

export const CLOSE_UNAUTHORIZED = 4401;

export interface NodeClientOptions {
  hubUrl: string;
  machineId: string;
  secretKey: string;
  service: NodeService;
  log: Logger;
  pingIntervalMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Called once when the hub refuses this machine for good (close code 4401). */
  onFatal?: (message: string) => void;
  /** One of several connections (another replica of the hub): losing it stops only what it opened. */
  secondary?: boolean;
  /** While no CLI here is signed in, how often to look again (default 30 s). */
  brainRecheckMs?: number;
}

export type ClientState = "idle" | "connecting" | "online" | "stopped";

export class NodeClient {
  private o: NodeClientOptions;
  state: ClientState = "idle";
  private ws?: WebSocket;
  private peer?: RpcPeer;
  private attempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private onlineWaiters: Array<() => void> = [];
  private stopPolicyWatch?: () => void;
  private helloTimer?: NodeJS.Timeout;
  private brainTimer?: NodeJS.Timeout;
  /** The CLIs as the last node.hello told the hub. */
  private announced = "";
  private signedIn = false;
  /** Name the hub knows this machine by (from node.hello). */
  hubName?: string;

  constructor(o: NodeClientOptions) {
    this.o = o;
    o.service.policy.onChange(() => {
      // Allowed dirs / brains changed: tell the hub (debounced).
      if (this.state !== "online") return;
      clearTimeout(this.helloTimer);
      this.helloTimer = setTimeout(() => void this.hello().catch((e) => this.o.log(`node.hello: ${e.message}`)), 300);
    });
  }

  start(): void {
    if (this.state !== "idle") return;
    this.stopPolicyWatch = this.o.service.policy.watch();
    this.connect();
  }

  /** Resolves once authenticated and node.hello was accepted. */
  waitOnline(timeoutMs = 30_000): Promise<void> {
    if (this.state === "online") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(t("client.helloTimeout"))), timeoutMs);
      this.onlineWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private connect(): void {
    if (this.state === "stopped") return;
    this.state = "connecting";
    const url = nodeWsUrl(this.o.hubUrl);
    const ws = new WebSocket(url, { handshakeTimeout: 15_000, maxPayload: 16 * 1024 * 1024 });
    this.ws = ws;
    let authed = false;
    let lastError: string | undefined;
    let peerOf: RpcPeer | undefined;

    ws.on("message", (data) => {
      if (authed) return;
      let msg: any;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg?.type === "challenge" && typeof msg.nonce === "string") {
        ws.send(JSON.stringify({ type: "auth", machineId: this.o.machineId, signature: signChallenge(msg.nonce, this.o.secretKey) }));
      } else if (msg?.type === "ok") {
        authed = true;
        peerOf = this.onAuthed(ws);
      }
    });
    ws.on("error", (e: any) => {
      lastError = e?.code ? `${e.code}` : (e?.message ?? String(e));
    });
    ws.on("close", (code, reasonBuf) => {
      const reason = String(reasonBuf ?? "");
      const wasOnline = this.state === "online";
      if (this.ws === ws) {
        this.ws = undefined;
        this.peer = undefined;
      }
      clearInterval(this.pingTimer);
      clearInterval(this.brainTimer);
      // Only what this connection opened stops: the machine may be serving the hub over another one.
      if (peerOf) void this.o.service.detach(peerOf);
      if (this.state === "stopped") return;
      if (code === CLOSE_UNAUTHORIZED && !this.o.secondary) {
        const message = t("client.rejected", { reason: reason || "unauthorized", hub: this.o.hubUrl });
        this.o.log(message);
        void this.stop();
        this.o.onFatal?.(message);
        return;
      }
      if (wasOnline) this.o.log(t("client.lost", { code: `${code}${reason ? ` ${reason}` : ""}` }));
      this.scheduleReconnect(lastError);
    });
  }

  private scheduleReconnect(why?: string): void {
    if (this.state === "stopped") return;
    this.state = "connecting";
    const min = this.o.minBackoffMs ?? 1000;
    const max = this.o.maxBackoffMs ?? 60_000;
    const delay = Math.min(max, min * 2 ** Math.min(this.attempt, 16));
    this.attempt++;
    const after = delay < 1000 ? t("client.ms", { n: delay }) : t("client.sec", { n: Math.round(delay / 1000) });
    this.o.log(why ? t("client.retry", { hub: this.o.hubUrl, reason: why, after }) : t("client.reconnect", { after }));
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private onAuthed(ws: WebSocket): RpcPeer {
    // From here on every text frame is JSON-RPC. The listener is added while the "ok" frame is being
    // dispatched, so it only sees later frames.
    const peer = createRpcPeer(wsTransport(ws as unknown as WsLike));
    this.peer = peer;
    this.o.service.attach(peer, this.o.hubUrl);
    peer.onNotification("node.locale", (p: { language?: string }) => setHubLocale(normalizeLocale(p?.language)));
    void (async () => {
      try {
        const r = await this.hello();
        if (this.peer !== peer) return;
        this.attempt = 0;
        this.state = "online";
        this.hubName = r?.name;
        this.o.log(t("client.connected", { hub: this.o.hubUrl, name: r?.name ?? this.o.machineId }));
        for (const w of this.onlineWaiters.splice(0)) w();
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          peer.request("node.ping", {}, { timeoutMs: 15_000 }).catch(() => {
            if (this.peer === peer) {
              this.o.log(t("client.pingLost"));
              ws.terminate();
            }
          });
        }, this.o.pingIntervalMs ?? 30_000);
        this.pingTimer.unref?.();
        // A CLI signed in over SSH after the daemon started reaches the hub by itself, without "Check again".
        clearInterval(this.brainTimer);
        this.brainTimer = setInterval(() => void this.recheckBrains(peer), this.o.brainRecheckMs ?? 30_000);
        this.brainTimer.unref?.();
      } catch (e: any) {
        this.o.log(t("client.helloFailed", { error: String(e?.message ?? e) }));
        ws.terminate();
      }
    })();
    return peer;
  }

  /** Probe the CLIs and announce this machine (info + installed brains) to the hub. */
  async hello(probed?: MachineInfo["clis"]): Promise<{ machineId: string; name: string }> {
    const peer = this.peer;
    if (!peer) throw new Error(t("client.offline"));
    const clis = probed ?? (await this.o.service.brains.probeAll());
    this.announced = cliState(clis);
    this.signedIn = clis.some((c) => c.authenticated);
    const info = machineInfo(this.o.service.policy.get(), clis, await graphicsCards());
    const brains = this.o.service.brains.available();
    const r = await peer.request<{ machineId: string; name: string; language?: string }>("node.hello", { info, brains }, { timeoutMs: 30_000 });
    setHubLocale(normalizeLocale(r?.language));
    this.o.log(t("client.brains", { list: brains.map((b) => b.id).join(", ") || t("cli.brain.none") }));
    return r;
  }

  /** Only while nothing here is signed in: a machine with a working CLI is not probed over and over. */
  private async recheckBrains(peer: RpcPeer): Promise<void> {
    if (this.peer !== peer || this.signedIn) return;
    const clis = await this.o.service.brains.probeAll().catch(() => undefined);
    if (!clis || this.peer !== peer || cliState(clis) === this.announced) return;
    await this.hello(clis).catch((e) => this.o.log(`node.hello: ${e.message}`));
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "stopped";
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.helloTimer);
    clearInterval(this.pingTimer);
    clearInterval(this.brainTimer);
    this.stopPolicyWatch?.();
    const ws = this.ws;
    this.ws = undefined;
    this.peer = undefined;
    try {
      ws?.close(1000, "node stopping");
    } catch {
      /* ignore */
    }
    await this.o.service.abortAll();
  }
}

/** What the hub needs to hear again about the CLIs: which are there and signed in. */
const cliState = (clis: MachineInfo["clis"]) => JSON.stringify(clis.map((c) => ({ id: c.brainId, available: c.available, authenticated: c.authenticated })));
