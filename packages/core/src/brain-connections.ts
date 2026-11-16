// The CLIs' own connections (shared BrainConnection): what the person already connected in Claude Code or Codex
// itself (MCP servers, their account's connectors such as Gmail), turned on or off for the agents that think with
// that brain on that computer. Everything is off until the person turns it on.
//
// The hub keeps the names turned on and nothing else: sign-ins, commands and addresses stay in the CLI on its
// computer. A session gets the names (BrainSessionOptions.connections); the brain's host lets in exactly those.
// These tools run inside the CLI, past the hub's gateway: what only reads is free, the rest asks the hub
// (tools/native-permission.ts), and whatever they return is outside content (runner.ts).

import type { BrainConnection, BrainConnectionView } from "@piomio/shared";
import { formatBrainRef, parseBrainRef } from "@piomio/shared";
import type { AuditLog } from "./audit.ts";
import type { BrainRegistry } from "./brains.ts";
import type { EventBus } from "./bus.ts";
import type { EgressProxy } from "./egress.ts";
import { LocalizedError } from "./i18n.ts";
import type { Settings } from "./settings.ts";

/** The brains whose CLI has connections of its own. */
export const CONNECTION_BRAINS: readonly string[] = ["claude-code", "codex"];

const KEY = "brain-connections";
/** A listing is the CLI's answer at that moment; an older one is asked again when someone looks. */
const FRESH_MS = 10 * 60_000;

export interface BrainConnectionsList {
  ref: string;
  connections: BrainConnectionView[];
  /** False: this brain's CLI has none to offer here (an older Piomio on that computer, or its owner's policy). */
  supported: boolean;
  checkedAt?: string;
}

export interface BrainConnectionsDeps {
  settings: Settings;
  brains: BrainRegistry;
  audit: AuditLog;
  bus: EventBus;
  /** The computer a machine id names, the same whoever leads the cluster (Machines.canonical). */
  computer: (machineId: string) => string;
  /** The proxy a listing on the hub's own computer reaches the person's servers through. */
  egress?: { proxy: EgressProxy; port: () => number };
}

export class BrainConnections {
  private d: BrainConnectionsDeps;
  private listed = new Map<string, { at: number; connections: BrainConnection[]; supported: boolean }>();

  constructor(d: BrainConnectionsDeps) {
    this.d = d;
  }

  /** This brain's CLI can have connections of its own. */
  offers(ref: string): boolean {
    const r = parseBrainRef(ref);
    return CONNECTION_BRAINS.includes(r.brainId) && !r.variant;
  }

  /** The switches are kept by brain and computer. */
  private key(ref: string): string {
    const r = parseBrainRef(ref);
    return `${r.brainId}@${this.d.computer(r.machineId)}`;
  }

  private all(): Record<string, string[]> {
    const v = this.d.settings.getKey<Record<string, unknown>>(KEY, {});
    const out: Record<string, string[]> = {};
    for (const [k, names] of Object.entries(v && typeof v === "object" ? v : {})) if (Array.isArray(names)) out[k] = names.filter((n): n is string => typeof n === "string");
    return out;
  }

  /** The connections turned on for the agents that think with this brain on its computer. */
  enabled(ref: string): string[] {
    return this.offers(ref) ? (this.all()[this.key(ref)] ?? []) : [];
  }

  /** Every brain with something turned on, for the access map: `<brainId>@<computer>` → names. */
  enabledEverywhere(): Record<string, string[]> {
    return Object.fromEntries(Object.entries(this.all()).filter(([, names]) => names.length));
  }

  /**
   * What the CLI has, each with its switch. The CLI is asked when nobody asked lately or with `refresh`: answering,
   * Claude Code starts the servers, so nothing asks on a timer.
   */
  async list(refStr: string, opts: { refresh?: boolean } = {}): Promise<BrainConnectionsList> {
    const ref = formatBrainRef(parseBrainRef(refStr));
    if (!this.offers(ref)) return { ref, connections: [], supported: false };
    let got = this.listed.get(ref);
    if (!got || opts.refresh || Date.now() - got.at > FRESH_MS) {
      const local = parseBrainRef(ref).machineId === "local";
      const owner = `brain:connections:${ref}`;
      let env: Record<string, string> | undefined;
      if (local && this.d.egress) {
        // The servers are the person's own choice, set up in their CLI: listing them reaches whatever they reach.
        const proxy = `http://${this.d.egress.proxy.issueToken(owner, ["*"])}:x@127.0.0.1:${this.d.egress.port()}`;
        env = { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1" };
      }
      try {
        got = { at: Date.now(), ...(await this.d.brains.connections(ref, env)) };
      } finally {
        if (env) this.d.egress!.proxy.revokeOwner(owner);
      }
      this.listed.set(ref, got);
    }
    const on = this.enabled(ref);
    const connections: BrainConnectionView[] = got.connections.map((c) => ({ ...c, enabled: on.includes(c.name) }));
    // Turned on earlier and gone from the CLI since: still shown, so it can be turned off.
    for (const name of on) if (!connections.some((c) => c.name === name)) connections.push({ name, source: "config", status: "unknown", enabled: true });
    return { ref, connections, supported: got.supported, checkedAt: new Date(got.at).toISOString() };
  }

  /** Turn one connection on or off for this brain on its computer. Only what its CLI listed can be turned on. */
  async set(refStr: string, name: string, on: boolean, actor: string): Promise<BrainConnectionsList> {
    const ref = formatBrainRef(parseBrainRef(refStr));
    if (!this.offers(ref)) throw new LocalizedError("brainConnections.none", { ref }, 400);
    const list = await this.list(ref);
    if (on && !list.connections.some((c) => c.name === name)) throw new LocalizedError("brainConnections.unknown", { name, ref }, 400);
    const all = this.all();
    const key = this.key(ref);
    const names = (all[key] ?? []).filter((n) => n !== name);
    if (on) names.push(name);
    if (names.length) all[key] = names;
    else delete all[key];
    this.d.settings.setKey(KEY, all);
    this.d.audit.append(actor, "brain.connection", ref, { name, on });
    this.d.bus.emit("brains.updated", {});
    return this.list(ref);
  }
}
