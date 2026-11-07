// Brain registry: brains contributed by plugins (local) and by paired machines (remote).
// Gives the session runner one interface regardless of where the brain runs.

import type { BrainEvent, BrainLoginUpdate, BrainSessionOptions, BrainTurn, ProbeResult, BrainRef } from "@piomio/shared";
import { formatBrainRef, parseBrainRef, RpcCodes, RpcError, type RpcPeer } from "@piomio/shared";
import { LocalizedError, t } from "./i18n.ts";

export interface BrainHandle {
  ref: string;
  send(turn: BrainTurn, onEvent: (e: BrainEvent) => void): Promise<void>;
  /** More input for the turn in progress: true when the brain took it (its reply goes on in send()). */
  steer(turn: BrainTurn): Promise<boolean>;
  /** Get ready for a turn soon; never fails (a brain without it just starts with the turn). */
  warm(): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

/** Something that can host brains: a plugin process (local) or a node daemon (remote). */
export interface BrainHostPeer {
  peer: RpcPeer;
  /** Brain ids available on this host. */
  brains: Map<string, string>; // id -> label
}

export interface BrainListing {
  ref: string;
  brainId: string;
  machineId: string;
  label: string;
  host: string; // "plugin:<id>" or "machine:<id>"
  /** The brain can sign in from the chat (a CLI brain in a plugin on the hub). */
  login: boolean;
  probe?: ProbeResult & { checkedAt: string };
}

/** Where a brain's sign-in runs: the plugin process that hosts it. */
export interface BrainLoginTarget {
  peer: RpcPeer;
  brainId: string;
  label: string;
  /** Updates of one sign-in (`brain.login` notifications); returns the unsubscribe. */
  onUpdate(loginId: string, cb: (u: BrainLoginUpdate) => void): () => void;
}

export class BrainRegistry {
  private pluginBrains = new Map<string, { label: string; pluginId: string; peer: RpcPeer; variants: string[]; login: boolean }>();
  private machineHosts = new Map<string, { name: string; peer: RpcPeer; brains: Map<string, string> }>();
  private probeCache = new Map<string, ProbeResult & { checkedAt: string }>();
  private eventRouters = new Map<RpcPeer, Map<string, (e: BrainEvent) => void>>();
  private loginRouters = new Map<RpcPeer, Map<string, (u: BrainLoginUpdate) => void>>();
  onChange?: () => void;

  // ---------- registration ----------

  registerPluginBrain(brainId: string, label: string, pluginId: string, peer: RpcPeer, variants: string[] = [], login = false): void {
    this.pluginBrains.set(brainId, { label, pluginId, peer, variants, login });
    // Another process now (the plugin restarted): what the old one said no longer holds.
    this.forgetProbes((r) => r.machineId === "local" && r.brainId === brainId);
    this.attachRouter(peer);
    this.onChange?.();
  }

  unregisterPlugin(pluginId: string): void {
    for (const [id, b] of this.pluginBrains) {
      if (b.pluginId !== pluginId) continue;
      this.pluginBrains.delete(id);
      this.forgetProbes((r) => r.machineId === "local" && r.brainId === id);
    }
    this.onChange?.();
  }

  registerMachine(machineId: string, name: string, peer: RpcPeer, brains: Array<{ id: string; label: string }>): void {
    this.machineHosts.set(machineId, { name, peer, brains: new Map(brains.map((b) => [b.id, b.label])) });
    this.invalidateMachine(machineId);
    this.attachRouter(peer);
    this.onChange?.();
  }

  unregisterMachine(machineId: string): void {
    this.machineHosts.delete(machineId);
    this.invalidateMachine(machineId);
    this.onChange?.();
  }

  private forgetProbes(match: (ref: BrainRef) => boolean): void {
    for (const k of [...this.probeCache.keys()]) if (match(parseBrainRef(k))) this.probeCache.delete(k);
  }

  private attachRouter(peer: RpcPeer): void {
    if (this.eventRouters.has(peer)) return;
    const routes = new Map<string, (e: BrainEvent) => void>();
    this.eventRouters.set(peer, routes);
    peer.onNotification("brain.event", (p: { sessionId: string; event: BrainEvent }) => routes.get(p.sessionId)?.(p.event));
    const logins = new Map<string, (u: BrainLoginUpdate) => void>();
    this.loginRouters.set(peer, logins);
    peer.onNotification("brain.login", (p: { loginId: string; update: BrainLoginUpdate }) => logins.get(p.loginId)?.(p.update));
    peer.onClose(() => {
      this.eventRouters.delete(peer);
      this.loginRouters.delete(peer);
    });
  }

  // ---------- lookup ----------

  /** Where a brain runs now: undefined while it is not connected (its host gone, or its connection closed). */
  private resolve(ref: BrainRef): { peer: RpcPeer; label: string; host: string } | undefined {
    if (ref.machineId === "local") {
      const b = this.pluginBrains.get(ref.brainId);
      return b && !b.peer.closed ? { peer: b.peer, label: b.label, host: `plugin:${b.pluginId}` } : undefined;
    }
    const m = this.machineHosts.get(ref.machineId);
    const label = m?.brains.get(ref.brainId);
    return m && label && !m.peer.closed ? { peer: m.peer, label: `${label} @ ${m.name}`, host: `machine:${ref.machineId}` } : undefined;
  }

  has(refStr: string): boolean {
    return !!this.resolve(parseBrainRef(refStr));
  }

  /** The plugin that signs this brain in, if it can (machines sign in on their own computer). */
  loginTarget(refStr: string): BrainLoginTarget | undefined {
    const ref = parseBrainRef(refStr);
    const b = ref.machineId === "local" ? this.pluginBrains.get(ref.brainId) : undefined;
    if (!b?.login || b.peer.closed) return undefined;
    const routes = this.loginRouters.get(b.peer);
    return {
      peer: b.peer,
      brainId: ref.brainId,
      label: b.label,
      onUpdate(loginId, cb) {
        routes?.set(loginId, cb);
        return () => routes?.delete(loginId);
      },
    };
  }

  list(variants: Record<string, string[]> = {}): BrainListing[] {
    const out: BrainListing[] = [];
    for (const [id, b] of this.pluginBrains) {
      const vs = variants[id]?.length ? variants[id] : b.variants.length ? b.variants : [undefined];
      for (const v of vs) {
        const ref = formatBrainRef({ brainId: id, variant: v, machineId: "local" });
        out.push({ ref, brainId: id, machineId: "local", label: v ? `${b.label} (${v})` : b.label, host: `plugin:${b.pluginId}`, login: b.login, probe: this.probeCache.get(ref) });
      }
    }
    for (const [mid, m] of this.machineHosts) {
      for (const [id, label] of m.brains) {
        const ref = formatBrainRef({ brainId: id, machineId: mid });
        out.push({ ref, brainId: id, machineId: mid, label: `${label} @ ${m.name}`, host: `machine:${mid}`, login: false, probe: this.probeCache.get(ref) });
      }
    }
    return out;
  }

  async probe(refStr: string, maxAgeMs = 60_000): Promise<ProbeResult> {
    const ref = parseBrainRef(refStr);
    const key = formatBrainRef(ref);
    const cached = this.probeCache.get(key);
    if (cached && Date.now() - Date.parse(cached.checkedAt) < maxAgeMs) return cached;
    const r = this.resolve(ref);
    if (!r) return { available: false, authenticated: false, detail: t("brain.notConnected"), unreachable: true };
    let result: ProbeResult;
    try {
      result = await r.peer.request<ProbeResult>("brain.probe", { brainId: ref.brainId, variant: ref.variant }, { timeoutMs: 20_000 });
    } catch (e: any) {
      // Its host did not answer (the connection closed, the plugin hangs): not connected for now. Not kept, so the next
      // look asks again rather than repeat this for a minute after the host is back.
      if (e instanceof RpcError && (e.code === RpcCodes.Closed || e.code === RpcCodes.Timeout)) return { available: false, authenticated: false, detail: t("brain.notConnected"), unreachable: true };
      result = { available: false, authenticated: false, detail: e.message };
    }
    this.probeCache.set(key, { ...result, checkedAt: new Date().toISOString() });
    return result;
  }

  invalidate(refStr: string): void {
    this.probeCache.delete(formatBrainRef(parseBrainRef(refStr)));
  }

  /** Forget a machine's probes (its setup changed: other models, another sign-in). */
  invalidateMachine(machineId: string): void {
    for (const k of [...this.probeCache.keys()]) if (k.endsWith(`@${machineId}`)) this.probeCache.delete(k);
  }

  /** Forget every probe result (their details are in the hub language, which just changed). */
  invalidateAll(): void {
    this.probeCache.clear();
  }

  async create(refStr: string, opts: BrainSessionOptions): Promise<BrainHandle> {
    const ref = parseBrainRef(refStr);
    const r = this.resolve(ref);
    if (!r) throw new LocalizedError("brain.refNotConnected", { ref: refStr });
    const peer = r.peer;
    await peer.request("brain.create", { brainId: ref.brainId, opts: { ...opts, variant: ref.variant ?? opts.variant } }, { timeoutMs: 60_000 });
    const routes = this.eventRouters.get(peer)!;
    const sessionId = opts.sessionId;
    return {
      ref: refStr,
      async send(turn, onEvent) {
        routes.set(sessionId, onEvent);
        try {
          await peer.request("brain.send", { sessionId, turn }, { timeoutMs: 6 * 3600_000 });
        } finally {
          routes.delete(sessionId);
        }
      },
      async steer(turn) {
        // Plugins and machines from before steering do not know the method: the input becomes the next turn.
        const r = await peer.request<{ accepted?: boolean }>("brain.steer", { sessionId, turn }, { timeoutMs: 15_000 }).catch(() => undefined);
        return !!r?.accepted;
      },
      async warm() {
        await peer.request("brain.warm", { sessionId }, { timeoutMs: 30_000 }).catch(() => {});
      },
      async interrupt() {
        await peer.request("brain.interrupt", { sessionId }, { timeoutMs: 10_000 }).catch(() => {});
      },
      async close() {
        await peer.request("brain.close", { sessionId }, { timeoutMs: 10_000 }).catch(() => {});
      },
    };
  }
}
