// Signing CLI brains in from the chat. The plugin that hosts a brain runs the CLI's own login (Codex device code,
// Claude Code browser code) as the user and HOME its sessions use; the hub gives it an egress grant for the
// subscription hosts, keeps the latest state per brain for the sign-in card and, once the CLI is through, checks the
// brains again so the card, the Brains page and the first-run checklist turn green. On a hub without user isolation
// (desktop installers, `npm start`) a CLI that is not installed is installed first from its official npm package.

import type { BrainLoginState, BrainLoginUpdate, BrainLoginView, RpcPeer } from "@piomio/shared";
import { formatBrainRef, newId, nowIso, parseBrainRef } from "@piomio/shared";
import type { BrainRegistry } from "./brains.ts";
import type { EventBus } from "./bus.ts";
import type { EgressProxy } from "./egress.ts";
import type { AuditLog } from "./audit.ts";
import type { CliTool, CliTools } from "./cli-tools.ts";
import { DEFAULT_BRAIN_EGRESS } from "./settings.ts";
import { LocalizedError, t } from "./i18n.ts";

const RUNNING = new Set(["installing", "starting", "waiting", "verifying"]);
const STATUSES = new Set([...RUNNING, "succeeded", "failed", "cancelled", "expired"]);
/** The CLI gives up after its own timeout (15 minutes); this only catches a host that never answers. */
const GUARD_MS = 20 * 60_000;
const MAX_CODE = 4096;

interface Deps {
  brains: BrainRegistry;
  bus: EventBus;
  egress: EgressProxy;
  audit: AuditLog;
  egressPort: () => number;
  /** Installs missing CLIs; absent or disabled where the hub may not install them. */
  tools?: CliTools;
}

interface Running {
  peer: RpcPeer;
  stop: () => void;
  /** Stops an install that is still running. */
  abort: () => void;
}

export class BrainLogins {
  private d: Deps;
  private latest = new Map<string, BrainLoginState>();
  private running = new Map<string, Running>();
  /** Conversation whose assistant asked for the sign-in: it hears when the brain is signed in. */
  private askedFrom = new Map<string, string>();
  /** Set by the hub: tell the assistant in that conversation that the brain is ready. */
  onSignedIn?: (state: BrainLoginState, label: string, conversationId: string) => void;

  constructor(d: Deps) {
    this.d = d;
  }

  supported(ref: string): boolean {
    return !!this.d.brains.loginTarget(norm(ref));
  }

  get(ref: string): BrainLoginState | undefined {
    return this.latest.get(norm(ref));
  }

  /** The card's data: the brain, whether it is signed in, the sign-in in progress. Probes are cached for a few
   *  minutes: every card on the page asks, and a sign-in from the card re-checks on its own. */
  async view(refStr: string, maxProbeAgeMs = 5 * 60_000): Promise<BrainLoginView> {
    const ref = norm(refStr);
    const listing = this.d.brains.list().find((b) => b.ref === ref);
    const connected = this.d.brains.has(ref);
    return {
      ref,
      label: listing?.label ?? ref,
      connected,
      supported: this.supported(ref),
      probe: connected ? await this.d.brains.probe(ref, maxProbeAgeMs) : undefined,
      login: this.latest.get(ref),
    };
  }

  /** Start the CLI's login, or return the one already running for this brain. */
  async start(refStr: string, opts: { actor: string; conversationId?: string }): Promise<BrainLoginState> {
    const ref = norm(refStr);
    if (opts.conversationId) this.askedFrom.set(ref, opts.conversationId);
    const current = this.latest.get(ref);
    if (current && RUNNING.has(current.status)) return current;
    const target = this.d.brains.loginTarget(ref);
    if (!target) throw new LocalizedError(this.d.brains.has(ref) ? "brainLogin.unsupported" : "brain.refNotConnected", { ref }, 400);

    const id = newId("bl_");
    const owner = `brain:login:${id}`;
    const proxy = `http://${this.d.egress.issueToken(owner, DEFAULT_BRAIN_EGRESS)}:x@127.0.0.1:${this.d.egressPort()}`;
    const env = { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1" };
    const unsubscribe = target.onUpdate(id, (u) => void this.update(ref, id, u, target.label));
    target.peer.onClose(() => void this.update(ref, id, { status: "failed", error: t("brainLogin.hostGone") }, target.label));
    const guard = setTimeout(() => {
      void target.peer.request("brain.login.cancel", { loginId: id }, { timeoutMs: 10_000 }).catch(() => {});
      void this.update(ref, id, { status: "expired", error: t("brainLogin.expired") }, target.label);
    }, GUARD_MS);
    guard.unref?.();
    const installing = new AbortController();
    this.running.set(id, {
      peer: target.peer,
      stop: () => {
        clearTimeout(guard);
        unsubscribe();
        installing.abort();
        this.d.egress.revokeOwner(owner);
        this.running.delete(id);
      },
      abort: () => installing.abort(),
    });

    const state: BrainLoginState = { id, ref, status: "starting", startedAt: nowIso() };
    this.latest.set(ref, state);
    this.d.bus.emit("brain.login", state);
    this.d.audit.append(opts.actor, "brain.login", ref);
    const begin = async () => {
      try {
        await target.peer.request("brain.login.start", { brainId: target.brainId, loginId: id, env }, { timeoutMs: 30_000 });
      } catch (e: any) {
        await this.update(ref, id, { status: "failed", error: e?.data?.text ?? e?.message ?? String(e) }, target.label);
      }
    };
    const tool = this.d.tools?.forBrain(target.brainId);
    if (tool && !(await this.d.brains.probe(ref, 0)).available) {
      this.set({ ...state, status: "installing" });
      void this.install(ref, id, tool, opts.actor, installing.signal).then((ok) => (ok ? begin() : undefined));
    } else await begin();
    return this.latest.get(ref)!;
  }

  /** The CLI is not on this machine: install it, then the sign-in goes on. False when it failed or was cancelled. */
  private async install(ref: string, id: string, tool: CliTool, actor: string, signal: AbortSignal): Promise<boolean> {
    this.d.audit.append(actor, "brain.cli.install", ref, { package: tool.pkg });
    try {
      await this.d.tools!.install(tool, { signal });
      this.d.brains.invalidateAll();
      const probe = await this.d.brains.probe(ref, 0);
      if (!probe.available) throw new Error(probe.detail ?? "the CLI does not start");
    } catch (e: any) {
      if (!signal.aborted) await this.update(ref, id, { status: "failed", error: t("brainLogin.installFailed", { name: tool.label, detail: e?.message ?? String(e) }) }, tool.label);
      return false;
    }
    const cur = this.latest.get(ref);
    if (cur?.id !== id || cur.status !== "installing") return false;
    this.set({ ...cur, status: "starting" });
    this.d.bus.emit("brains.updated", {});
    return true;
  }

  /** The code the user pasted from the sign-in page (browser flows). */
  async submitCode(refStr: string, code: string): Promise<BrainLoginState> {
    const ref = norm(refStr);
    const s = this.latest.get(ref);
    const r = s && this.running.get(s.id);
    if (!s || !r || s.status !== "waiting" || !s.needsCode) throw new LocalizedError("brainLogin.notWaiting", undefined, 409);
    const clean = code.trim();
    if (!clean || clean.length > MAX_CODE || /\s/.test(clean)) throw new LocalizedError("brainLogin.badCode", undefined, 400);
    try {
      await r.peer.request("brain.login.code", { loginId: s.id, code: clean }, { timeoutMs: 15_000 });
    } catch (e: any) {
      throw new LocalizedError("brainLogin.codeRefused", { detail: e?.data?.text ?? e?.message ?? String(e) }, 400);
    }
    return this.latest.get(ref)!;
  }

  async cancel(refStr: string, actor: string): Promise<BrainLoginState | undefined> {
    const ref = norm(refStr);
    const s = this.latest.get(ref);
    if (!s || !RUNNING.has(s.status)) return s;
    this.askedFrom.delete(ref);
    this.d.audit.append(actor, "brain.login.cancel", ref);
    const r = this.running.get(s.id);
    if (s.status === "installing") {
      r?.abort();
      await this.update(ref, s.id, { status: "cancelled" }, ref);
      return this.latest.get(ref);
    }
    const sent = r ?await r.peer.request("brain.login.cancel", { loginId: s.id }, { timeoutMs: 10_000 }).then(() => true, () => false) : false;
    // A host that is gone cannot report the end itself.
    if (!sent) await this.update(ref, s.id, { status: "cancelled" }, ref);
    return this.latest.get(ref);
  }

  private async update(ref: string, id: string, u: BrainLoginUpdate, label: string): Promise<void> {
    const prev = this.latest.get(ref);
    if (!prev || prev.id !== id || !RUNNING.has(prev.status) || !STATUSES.has(u?.status)) return;
    if (!RUNNING.has(u.status)) this.running.get(id)?.stop();
    if (u.status !== "succeeded") return this.set({ ...prev, ...pick(u), ...(RUNNING.has(u.status) ? {} : { finishedAt: nowIso() }) });

    // The CLI says it is through: believe the brain's own check, not the exit code.
    this.set({ ...prev, ...pick(u), status: "verifying" });
    this.d.brains.invalidateAll();
    const probe = await this.d.brains.probe(ref, 0);
    const ok = probe.authenticated;
    this.set({ ...prev, ...pick(u), status: ok ? "succeeded" : "failed", error: ok ? undefined : (probe.detail ?? t("brainLogin.notSignedIn")), finishedAt: nowIso() });
    this.d.bus.emit("brains.updated", {});
    const conv = this.askedFrom.get(ref);
    this.askedFrom.delete(ref);
    if (ok && conv) this.onSignedIn?.(this.latest.get(ref)!, label, conv);
  }

  private set(s: BrainLoginState): void {
    const prev = this.latest.get(s.ref);
    if (prev?.id !== s.id || JSON.stringify(prev) === JSON.stringify(s)) return;
    this.latest.set(s.ref, s);
    this.d.bus.emit("brain.login", s);
  }
}

function norm(ref: string): string {
  return formatBrainRef(parseBrainRef(ref));
}

/** Only the fields an update may set. */
function pick(u: BrainLoginUpdate): BrainLoginUpdate {
  const out: BrainLoginUpdate = { status: u.status };
  if (typeof u.url === "string" && /^https:\/\//.test(u.url)) out.url = u.url.slice(0, 4096);
  if (typeof u.userCode === "string") out.userCode = u.userCode.slice(0, 64);
  if (typeof u.needsCode === "boolean") out.needsCode = u.needsCode;
  if (typeof u.expiresAt === "string") out.expiresAt = u.expiresAt;
  if (typeof u.error === "string") out.error = u.error.slice(0, 500);
  return out;
}
