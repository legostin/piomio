// Brains on this machine: Claude Code / Codex / Kimi Code CLIs logged in with the owner's subscriptions.
// Same brain.* contract as plugin processes (packages/plugin-sdk/src/runner.ts), driven over the hub WebSocket.

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrainEvent, BrainSessionOptions, BrainTurn, MachineBrainId, MachineInfo, MachineModel, NodeSetup, ProbeResult } from "@piomio/shared";
import { brainWire, cheapestModel, keyProvider, profileFrom } from "@piomio/shared";
import type { BrainProviderImpl, BrainSessionImpl } from "@piomio/plugin-sdk";
import { codexChooser, createClaudeCodeProvider, createCodexProvider, createKimiProvider } from "@piomio/brains-cli";
import type { Policy, PolicyStore } from "./policy.ts";
import { resolveAllowedPath, resolveWorkspace } from "./guard.ts";
import { checkCommand } from "./exec.ts";
import { hubLocale, tHub } from "./messages.ts";
import type { ModelGateway } from "./gateway.ts";

export const BRAIN_IDS = ["claude-code", "codex", "kimi"] as const;
/** The brains the hub sets up per machine (sign-in or keys, models): Kimi Code only signs in. */
const MACHINE_SETUP_BRAINS: readonly MachineBrainId[] = ["claude-code", "codex"];
export type NodeBrainId = (typeof BRAIN_IDS)[number];

const DEFAULT_COMMANDS: Record<NodeBrainId, string> = { "claude-code": "claude", codex: "codex", kimi: "kimi" };

/**
 * Windows: spawn() without a shell only runs .exe/.com. npm installs CLIs as .cmd shims, so find the
 * command on PATH and, for an npm shim, return the JS entry it wraps (brains-cli runs .js/.mjs via node).
 */
export function resolveCli(command: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (platform !== "win32" || /\.(m?js|ts)$/i.test(command)) return command;
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((e) => e.toLowerCase());
  const hasDir = isAbsolute(command) || /[\\/]/.test(command);
  const dirs = hasDir ? [""] : (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const hasExt = /\.[a-z0-9]+$/i.test(command);
  for (const dir of dirs) {
    for (const ext of hasExt ? [""] : exts) {
      const p = dir ? join(dir, command + ext) : command + ext;
      let isFile = false;
      try {
        isFile = statSync(p).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) continue;
      if (/\.(cmd|bat)$/i.test(p)) return shimTarget(p) ?? p;
      return p;
    }
  }
  return command;
}

/** Target script of an npm cmd-shim: `"%dp0%\node_modules\pkg\bin\cli.js" %*`. */
export function shimTarget(cmdFile: string): string | undefined {
  try {
    const text = readFileSync(cmdFile, "utf8");
    const m = /"%~?dp0%?\\([^"]+?\.m?js)"/i.exec(text);
    if (!m) return undefined;
    // The shim spells the path with backslashes; split it so the join is right whatever platform reads the shim.
    const target = join(dirname(cmdFile), ...m[1].split(/[\\/]/));
    return existsSync(target) ? target : undefined;
  } catch {
    return undefined;
  }
}

/** Command that runs the stdio MCP bridge with the current Node binary: the checkout's bridge, or this file's `mcp-bridge` command when running as the single-file download. */
export function defaultBridgeCommand(): string[] {
  let entry: string | undefined;
  try {
    entry = fileURLToPath(import.meta.resolve("@piomio/mcp-bridge"));
  } catch {
    entry = fileURLToPath(new URL("../../mcp-bridge/src/index.ts", import.meta.url));
  }
  if (!existsSync(entry)) return [process.execPath, fileURLToPath(import.meta.url), "mcp-bridge"];
  return [process.execPath, "--disable-warning=ExperimentalWarning", entry];
}

/** Hub-provided env is applied only for harmless keys: anything else could redirect credentials or inject code. */
const SAFE_ENV = /^(TZ|LANG|LANGUAGE|LC_[A-Z]+)$/;

/**
 * Model names and resume ids become CLI arguments (`--model x`, `codex exec resume <id>`): a value starting
 * with "-" could be parsed as a flag (e.g. a sandbox bypass), so only plain tokens are accepted.
 */
const SAFE_ARG = /^[A-Za-z0-9][\w.:/@[\]-]{0,199}$/;

/**
 * What Kimi Code may do on this machine without asking (it has no sandbox): commands as `exec` allows them, writes
 * where `fs.write` and the allowed folders (and its own workspace) allow them; nothing else it would ask about.
 */
export function kimiAllowed(policy: Policy, tool: string, input: Record<string, unknown>, workspace: string): boolean {
  try {
    if (tool === "Bash") return !!checkCommand(input.command, policy);
    if (tool === "Write" || tool === "Edit") return policy.fs.write && !!resolveAllowedPath(input.path ?? input.file_path, [workspace, ...policy.allowedDirs], { base: workspace });
  } catch {
    return false;
  }
  return false;
}

function safeArg(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !SAFE_ARG.test(v)) throw new Error(`Invalid ${field}: ${String(v).slice(0, 80)}`);
  return v;
}

export interface BrainHostOptions {
  home: string;
  policy: PolicyStore;
  /** The loopback gateway key-mode brains reach their providers through (gateway.ts). */
  gateway?: ModelGateway;
  /** The hub URL this node paired with; the MCP bridge talks to `${hubUrl}/mcp`. */
  hubUrl?: string;
  bridgeCommand?: string[];
  log?: (msg: string) => void;
}

export class BrainHost {
  private o: BrainHostOptions;
  private providers = new Map<NodeBrainId, BrainProviderImpl>();
  private sessions = new Map<string, { brainId: NodeBrainId; session: BrainSessionImpl; workspace: string; owner?: unknown }>();
  private lastProbe = new Map<NodeBrainId, ProbeResult>();
  /** What the hub set for this machine (node.setup): sign-in per brain, allowed models, keys (memory only). */
  private setup: NodeSetup | undefined;

  constructor(o: BrainHostOptions) {
    this.o = o;
    const policy = () => o.policy.get();
    const stateDir = (id: string) => join(o.home, "brains", id);
    const log = (m: string) => o.log?.(m);
    const codex = codexChooser();
    this.providers.set(
      "claude-code",
      createClaudeCodeProvider({
        command: () => resolveCli(policy().brains["claude-code"].command ?? DEFAULT_COMMANDS["claude-code"]),
        allowedTools: () => policy().brains["claude-code"].allowedTools,
        stateDir: stateDir("claude-code"),
        log,
        locale: hubLocale,
      }),
    );
    this.providers.set(
      "codex",
      createCodexProvider({
        // The Codex policy names, else the newest on this machine (Codex offers newer models only to newer clients).
        command: () => resolveCli(codex(policy().brains.codex.command)),
        sandbox: () => policy().brains.codex.sandbox,
        extraConfig: () => this.codexProviderConfig(),
        stateDir: stateDir("codex"),
        log,
        locale: hubLocale,
      }),
    );
    this.providers.set(
      "kimi",
      createKimiProvider({
        command: () => policy().brains.kimi.command ?? DEFAULT_COMMANDS.kimi,
        // No sandbox around Kimi: the owner's policy answers what it asks before running.
        allow: (tool, input, workspace) => kimiAllowed(policy(), tool, input, workspace),
        stateDir: stateDir("kimi"),
        log,
        locale: hubLocale,
      }),
    );
  }

  /** The hub's setup for this machine; the gateway takes the keys, models and limit at once. */
  applySetup(setup: NodeSetup): void {
    this.setup = setup;
    const wires: Parameters<ModelGateway["configure"]>[0]["wires"] = {};
    for (const id of MACHINE_SETUP_BRAINS) {
      const b = setup.brains[id];
      if (b?.auth === "key") wires[brainWire(id)] = { models: b.models, providers: b.providers ?? [] };
    }
    this.o.gateway?.configure({ wires, ...(setup.limit ? { limit: { usd: setup.limit.usd, spent: setup.limit.spent } } : {}) });
    this.lastProbe.clear();
  }

  /** What the hub set for this brain here; Kimi Code has no setup in the hub (its own sign-in, any model). */
  private brainSetup(id: NodeBrainId): NodeSetup["brains"][MachineBrainId] {
    return id === "kimi" ? undefined : this.setup?.brains[id];
  }

  /** Key mode: the hub gives this brain provider keys, through the gateway. */
  private keyMode(id: NodeBrainId): id is MachineBrainId {
    return this.brainSetup(id)?.auth === "key" && !!this.o.gateway?.port;
  }

  private allowed(id: NodeBrainId): MachineModel[] {
    return this.brainSetup(id)?.models ?? [];
  }

  /** Codex in key mode talks to the gateway as a model provider of its own; the session token comes in its env. */
  private codexProviderConfig(): string[] {
    if (!this.keyMode("codex")) return [];
    return [
      `model_provider="piomio"`,
      `model_providers.piomio.name="Piomio"`,
      `model_providers.piomio.base_url="http://127.0.0.1:${this.o.gateway!.port}/v1"`,
      `model_providers.piomio.env_key="PIOMIO_GATEWAY_KEY"`,
      `model_providers.piomio.wire_api="responses"`,
    ];
  }

  /** What the hub's setup changes in a probe: who signs in, and which models the router may pick. */
  private shaped(id: NodeBrainId, r: ProbeResult): ProbeResult {
    const allowed = this.allowed(id);
    const b = this.brainSetup(id);
    if (!this.setup || !b) return r;
    if (this.keyMode(id)) {
      const keyed = (b.providers ?? []).map((p) => keyProvider(p.id)?.label ?? p.id);
      const authenticated = r.available && keyed.length > 0 && allowed.length > 0 && !this.setup.sealed;
      const detail = !r.available
        ? r.detail
        : this.setup.sealed
          ? tHub("brains.keyWaitsVault")
          : keyed.length
            ? tHub("brains.keyVia", { providers: keyed.join(", ") })
            : tHub("brains.keyMissing");
      return { ...r, authenticated, detail, ...modelsOf(allowed) };
    }
    if (!allowed.length) return r;
    return { ...r, ...modelsOf(allowed) };
  }

  private enabled(id: string): id is NodeBrainId {
    return (BRAIN_IDS as readonly string[]).includes(id) && this.o.policy.get().brains[id as NodeBrainId].enabled;
  }

  private provider(id: string): BrainProviderImpl {
    if (!(BRAIN_IDS as readonly string[]).includes(id)) throw new Error(`Unknown brain: ${id}`);
    if (!this.enabled(id)) throw new Error(`Brain ${id} is disabled on this machine (policy.json)`);
    return this.providers.get(id as NodeBrainId)!;
  }

  /** Probe every known brain; disabled ones are reported as unavailable. */
  async probeAll(): Promise<MachineInfo["clis"]> {
    return Promise.all(
      BRAIN_IDS.map(async (id) => {
        if (!this.enabled(id)) {
          const r = { available: false, authenticated: false, detail: tHub("brains.disabled") };
          this.lastProbe.set(id, r);
          return { brainId: id, ...r };
        }
        let r: ProbeResult;
        try {
          r = this.shaped(id, await this.providers.get(id)!.probe());
        } catch (e: any) {
          r = { available: false, authenticated: false, detail: e?.message ?? String(e) };
        }
        this.lastProbe.set(id, r);
        return { brainId: id, ...r };
      }),
    );
  }

  /** Brains to announce in node.hello: enabled and installed (as of the last probe). */
  available(): Array<{ id: string; label: string }> {
    return BRAIN_IDS.filter((id) => this.enabled(id) && this.lastProbe.get(id)?.available).map((id) => ({ id, label: this.providers.get(id)!.label }));
  }

  async probe(p: { brainId: string; variant?: string }): Promise<ProbeResult> {
    const r = this.shaped(p.brainId as NodeBrainId, await this.provider(p.brainId).probe(p.variant));
    this.lastProbe.set(p.brainId as NodeBrainId, r);
    return r;
  }

  async create(p: { brainId: string; opts: BrainSessionOptions }, owner?: unknown, hubUrl?: string): Promise<{ workspace: string }> {
    const provider = this.provider(p.brainId);
    const opts = p.opts;
    if (!opts?.sessionId || typeof opts.sessionId !== "string") throw new Error("sessionId is required");
    const policy = this.o.policy.get();
    const workspace = resolveWorkspace(opts.workspace, policy.workspacesRoot);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.env ?? {})) if (SAFE_ENV.test(k) && typeof v === "string") env[k] = v;
    const brainId = p.brainId as NodeBrainId;
    // The router picks among the allowed models; anything else (an older hub, the person's exact pick) takes the cheapest.
    const allowed = this.allowed(brainId);
    let model = safeArg(opts.model, "model");
    if (allowed.length && !allowed.some((m) => m.id === model)) model = cheapestModel(allowed)?.id;
    if (this.keyMode(brainId)) Object.assign(env, this.keyEnv(brainId, opts.sessionId, model));
    const local: BrainSessionOptions = {
      ...opts,
      model,
      effort: safeArg(opts.effort, "effort"),
      variant: safeArg(opts.variant, "variant"),
      resume: safeArg(opts.resume, "resume"),
      workspace,
      mcp: {
        // The MCP of the replica that opened the session (the daemon's own config otherwise).
        url: (hubUrl ?? this.o.hubUrl) ? `${(hubUrl ?? this.o.hubUrl)!.replace(/\/$/, "")}/mcp` : String(opts.mcp?.url ?? ""),
        token: String(opts.mcp?.token ?? ""),
        bridgeCommand: this.o.bridgeCommand ?? defaultBridgeCommand(),
      },
      // Hub-side paths mean nothing here.
      skillsDir: undefined,
      claudePluginDirs: [],
      env,
    };
    const old = this.sessions.get(opts.sessionId);
    if (old) await Promise.resolve(old.session.close()).catch(() => {});
    const session = await provider.createSession(local);
    this.sessions.set(opts.sessionId, { brainId, session, workspace, owner });
    return { workspace };
  }

  /** The env a key-mode session gets: the gateway and its own token, never a key. */
  private keyEnv(id: MachineBrainId, sessionId: string, model: string | undefined): Record<string, string> {
    const token = this.o.gateway!.open(sessionId, id);
    if (id === "codex") return { PIOMIO_GATEWAY_KEY: token, OPENAI_API_KEY: "", CODEX_API_KEY: "" };
    const allowed = this.allowed(id);
    const cheap = cheapestModel(allowed)?.id ?? model ?? "";
    const main = model ?? cheap;
    return {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${this.o.gateway!.port}`,
      ANTHROPIC_AUTH_TOKEN: token,
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      // Claude Code's own aliases and helpers name models of their own: they stay on the allowed ones.
      ANTHROPIC_MODEL: main,
      ANTHROPIC_DEFAULT_OPUS_MODEL: main,
      ANTHROPIC_DEFAULT_SONNET_MODEL: main,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: cheap,
      ANTHROPIC_SMALL_FAST_MODEL: cheap,
      CLAUDE_CODE_SUBAGENT_MODEL: main,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
  }

  async send(p: { sessionId: string; turn: BrainTurn }, emit: (event: BrainEvent) => void): Promise<void> {
    const s = this.sessions.get(p.sessionId);
    if (!s) throw new Error(`Unknown brain session: ${p.sessionId}`);
    try {
      for await (const event of s.session.send(p.turn)) emit(event);
    } catch (e: any) {
      emit({ type: "error", message: e?.message ?? String(e), fatal: true });
    }
  }

  /** More input for the turn in progress; false sends it as the next turn. */
  async steer(p: { sessionId: string; turn: BrainTurn }): Promise<boolean> {
    const s = this.sessions.get(p.sessionId)?.session;
    return !!(s?.steer && (await s.steer(p.turn)));
  }

  /** Get ready for a turn soon (a dialog the person opened). */
  async warm(p: { sessionId: string }): Promise<void> {
    await this.sessions.get(p.sessionId)?.session.warm?.();
  }

  async interrupt(p: { sessionId: string }): Promise<void> {
    await this.sessions.get(p.sessionId)?.session.interrupt();
  }

  async close(p: { sessionId: string }): Promise<void> {
    const s = this.sessions.get(p.sessionId);
    this.sessions.delete(p.sessionId);
    this.o.gateway?.close(p.sessionId);
    if (!s) return;
    await s.session.close();
    // Per-session private files (MCP token, prompt) live under the brain's state dir.
    try {
      rmSync(join(this.o.home, "brains", s.brainId, "sessions", p.sessionId.replace(/[^\w-]/g, "_")), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  async closeAll(owner?: unknown): Promise<void> {
    const ids = [...this.sessions].filter(([, s]) => owner === undefined || s.owner === owner).map(([id]) => id);
    await Promise.all(ids.map((sessionId) => this.close({ sessionId }).catch(() => {})));
  }

  get sessionCount(): number {
    return this.sessions.size;
  }
}

/** A probe's models from the allowed list: ids, and profiles with their prices for the router. */
function modelsOf(allowed: MachineModel[]): Pick<ProbeResult, "models" | "catalog" | "model"> {
  const cheap = cheapestModel(allowed);
  return {
    models: allowed.map((m) => m.id),
    ...(cheap ? { model: cheap.id } : {}),
    catalog: allowed.map((m) => profileFrom({ id: m.id, ...(m.price ? { price: m.price } : {}) })),
  };
}
