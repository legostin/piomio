// OpenAI Codex CLI as a brain: `codex app-server` (codex-app.ts), which takes more input while a turn runs. A dialog's
// process stays up between turns (keepWarm), so that its next reply does not wait for Codex to start and resume the
// thread; other work gets one per turn. Codex without it gets `codex exec --json` per turn, `codex exec resume <thread>`
// between turns. Uses the user's ChatGPT subscription (`codex login` stored in HOME/.codex) or OPENAI_API_KEY.

import { mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrainEvent, BrainSessionOptions, BrainTurn, ProbeResult } from "@piomio/shared";
import type { BrainProviderImpl, BrainSessionImpl } from "@piomio/plugin-sdk";
import type { Locale } from "@piomio/shared/i18n";
import { markLegacy, profileFrom } from "@piomio/shared/models";
import { capture, childEnv, runLines, WarmPool } from "./proc.ts";
import { brainsT } from "./messages.ts";
import { parseCodexDeviceLogin, runCliLogin } from "./login.ts";
import { AppServerUnsupported, CodexAppServer, listCodexModels, parseCodexReset, type CodexModel } from "./codex-app.ts";
import { askHub, type HubAnswer } from "./hub-permission.ts";
import { confinedNetwork, confinedProxyEnv } from "./network.ts";

export { parseCodexReset };

export interface CodexOptions {
  command?: () => string;
  authEnv?: () => Promise<Record<string, string>>;
  /** "danger-full-access" inside the container (isolation comes from unix users + egress proxy). */
  sandbox?: () => "read-only" | "workspace-write" | "danger-full-access";
  /** More `-c` overrides for every turn (a machine in key mode: its gateway as the model provider). */
  extraConfig?: () => string[];
  stateDir: string;
  log?: (msg: string) => void;
  /** Language for messages people read (probe details, failures); English by default. */
  locale?: () => Locale;
  /** How long a sign-in from the chat may wait for the user (Codex device codes last 15 minutes). */
  loginTimeoutMs?: number;
  /** How long a dialog's process waits for its next turn before it closes. */
  idleMs?: number;
  /** Processes kept waiting at once; the one waiting longest closes first. */
  maxWarm?: number;
}

/** A dialog's process waits this long for its next turn before it closes (BrainSessionOptions.keepWarm). */
const IDLE_MS = 10 * 60_000;
/** Processes kept waiting at once; the one waiting longest closes first. */
const MAX_WARM = 3;
/**
 * Codex's Fast tier spends the person's limits several times as quickly, and the person's own config.toml may turn it
 * on (`service_tier`): the hub's agents never use it, in a thread old or new. `serviceTier: null` on the thread says the
 * same to a Codex that no longer knows this switch (codex-app.ts).
 */
const NO_FAST_TIER = "features.fast_mode=false";

/** Turns `codex exec --json` events into BrainEvents. */
export class CodexStreamParser {
  threadId?: string;
  limit?: { resetAt?: string; detail: string };
  failed?: string;
  completed = false;

  push(ev: any): BrainEvent[] {
    const out: BrainEvent[] = [];
    if (!ev || typeof ev !== "object") return out;
    switch (ev.type) {
      case "thread.started":
        this.threadId = ev.thread_id ?? this.threadId;
        break;
      case "item.started": {
        const it = ev.item ?? {};
        if (it.type === "mcp_tool_call") out.push({ type: "tool_call", id: it.id, name: it.tool ?? "tool", input: it.arguments ?? {} });
        if (it.type === "command_execution") out.push({ type: "tool_call", id: it.id, name: "shell", input: { command: it.command } });
        if (it.type === "web_search") out.push({ type: "tool_call", id: it.id, name: "WebSearch", input: { query: it.query } });
        break;
      }
      case "item.completed": {
        const it = ev.item ?? {};
        if (it.type === "agent_message" && it.text) out.push({ type: "text", delta: String(it.text) + "\n" });
        if (it.type === "mcp_tool_call") {
          const r = it.result?.content ? it.result.content.map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n") : it.error?.message ?? JSON.stringify(it.result ?? "");
          out.push({ type: "tool_result", id: it.id, output: String(r), isError: it.status === "failed" || !!it.error });
        }
        if (it.type === "command_execution") out.push({ type: "tool_result", id: it.id, output: String(it.aggregated_output ?? ""), isError: it.exit_code !== 0 && it.exit_code !== undefined });
        if (it.type === "file_change") out.push({ type: "tool_result", id: it.id, output: (it.changes ?? []).map((c: any) => `${c.kind} ${c.path}`).join("\n") });
        if (it.type === "error") out.push({ type: "error", message: String(it.message ?? "codex error") });
        break;
      }
      case "turn.completed": {
        this.completed = true;
        const u = ev.usage ?? {};
        out.push({ type: "usage", inputTokens: (u.input_tokens ?? 0) + (u.cached_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0 });
        break;
      }
      case "turn.failed":
      case "error": {
        const message = String(ev.error?.message ?? ev.message ?? "codex error");
        if (/usage limit|rate limit|quota|limit reached|try again/i.test(message)) this.limit = { detail: message, resetAt: parseCodexReset(message) };
        else this.failed = message;
        break;
      }
    }
    return out;
  }
}

function tomlString(s: string): string {
  return JSON.stringify(s); // JSON strings are valid TOML basic strings
}

class CodexSession implements BrainSessionImpl {
  private threadId?: string;
  private proc?: ReturnType<typeof runLines>;
  /** The app server: in a turn, or a dialog's waiting for its next one. */
  private app?: CodexAppServer;
  /** This Codex has no app-server: turns use `codex exec`. */
  private execOnly = false;
  private interrupted = false;
  /** A turn is in progress (send() has not finished). */
  private turning = false;
  private closed = false;
  private idle?: NodeJS.Timeout;
  private warming?: Promise<void>;
  private o: BrainSessionOptions;
  private p: CodexOptions;
  private dir: string;
  private pool: WarmPool<CodexSession>;

  constructor(opts: BrainSessionOptions, p: CodexOptions, pool: WarmPool<CodexSession>) {
    this.o = opts;
    this.p = p;
    this.pool = pool;
    this.threadId = opts.resume;
    this.dir = join(p.stateDir, "sessions", opts.sessionId.replace(/[^\w-]/g, "_"));
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tokenFile = join(this.dir, "token");
    writeFileSync(tokenFile, opts.mcp.token, { mode: 0o600 });
    try {
      chmodSync(tokenFile, 0o600);
    } catch {
      /* windows */
    }
    // A bare session's prompt goes in as the thread's own instructions, with no project files read.
    if (opts.bare) return;
    // Codex reads AGENTS.md from the working directory: that is where our system prompt goes.
    const agentsFile = join(opts.workspace, "AGENTS.md");
    const marker = "<!-- piomio:system -->";
    const existing = existsSync(agentsFile) ? readFileSync(agentsFile, "utf8") : "";
    const userPart = existing.includes(marker) ? existing.slice(existing.indexOf("<!-- /piomio:system -->") + 24) : existing;
    writeFileSync(agentsFile, `${marker}\n${opts.systemPrompt}\n<!-- /piomio:system -->\n${userPart}`);
  }

  private sandbox(): "read-only" | "workspace-write" | "danger-full-access" {
    // A dialog's front desk only looks: commands that change things are a task's (BrainSessionOptions.frontDesk).
    if (this.o.frontDesk) return "read-only";
    const chosen = this.p.sandbox?.() ?? "danger-full-access";
    // Confined by the hub: never wider than the workspace (BrainSessionOptions.confine).
    return this.o.confine ? (chosen === "read-only" ? "read-only" : "workspace-write") : chosen;
  }

  /** What the sandbox would not let through, Codex asks for; confined, the hub answers (hub-permission.ts). */
  private ask(): ((tool: string, input: Record<string, unknown>) => Promise<HubAnswer>) | undefined {
    const confine = this.o.confine;
    // The front desk asks for nothing more: what its sandbox does not let through is a task's work.
    return confine && !this.o.frontDesk ? (tool, input) => askHub(this.o.mcp, confine.permissionTool, tool, input) : undefined;
  }

  private approvalPolicy(): "never" | "on-request" {
    return this.ask() ? "on-request" : "never";
  }

  /**
   * Confined by the hub: a permission profile in place of `sandbox_mode`, so that what no agent may read (the
   * person's credentials, the hub's data) is closed to Codex's commands too, not only what it may write. The agent's
   * earlier folders stay readable. Command networking uses Codex's managed proxy, chained to the hub's proxy. Codex
   * no longer sends every command to the hub (`approval_policy="untrusted"` is gone), so the hub's proxy decides per
   * host instead: a new one, and after outside content every one, is reviewed once per session (network-approvals.ts).
   */
  private profile(): string[] | undefined {
    const c = this.o.confine;
    if (!c) return undefined;
    const readOnly = this.sandbox() === "read-only";
    const network = confinedNetwork(this.o);
    const files = new Map<string, string>();
    for (const p of c.denyRead) files.set(p, "deny");
    for (const p of c.allowRead) if (p !== this.o.workspace) files.set(p, "read");
    if (!readOnly) for (const p of c.allowWrite ?? []) files.set(p, "write");
    return [
      `default_permissions="piomio"`,
      `permissions.piomio.extends=${tomlString(readOnly ? ":read-only" : ":workspace")}`,
      `permissions.piomio.filesystem={${[...files].map(([p, a]) => `${tomlString(p)}=${tomlString(a)}`).join(",")}}`,
      ...(network ? [
        // enabled alone opens unrestricted networking: the managed proxy feature MUST be enabled alongside it.
        "features.network_proxy=true",
        `permissions.piomio.network={enabled=true,proxy_url="http://127.0.0.1:0",enable_socks5=false,enable_socks5_udp=false,allow_upstream_proxy=true,allow_local_binding=false,mode="full",domains={${network.allowedDomains.map((h) => `${tomlString(h)}="allow"`).join(",")}}`,
      ] : ["permissions.piomio.network.enabled=false"]),
    ];
  }

  /** A bare session (auto mode's reviewer): no hub, no tools, none of the person's MCP servers, plugins or memories. */
  private bareConfig(): string[] {
    return [
      "mcp_servers={}",
      `approval_policy="never"`,
      `sandbox_mode="read-only"`,
      "project_doc_max_bytes=0",
      NO_FAST_TIER,
      ...["shell_tool", "multi_agent", "apps", "plugins", "memories", "goals", "hooks", "image_generation"].map((f) => `features.${f}=false`),
      ...(this.o.effort ? [`model_reasoning_effort=${tomlString(this.o.effort)}`] : []),
      ...(this.p.extraConfig?.() ?? []),
    ];
  }

  /**
   * `-c` overrides: the hub's MCP server, approvals (asked of the hub when confined), the sandbox. `codex exec` (a Codex
   * too old for the app-server, older than permission profiles) gets `sandbox_mode`.
   */
  private config(exec = false): string[] {
    if (this.o.bare) return this.bareConfig();
    const [command, ...args] = this.o.mcp.bridgeCommand.length ? this.o.mcp.bridgeCommand : ["piomio-mcp-bridge"];
    return [
      `mcp_servers.piomio.command=${tomlString(command)}`,
      `mcp_servers.piomio.args=[${args.map(tomlString).join(",")}]`,
      `mcp_servers.piomio.env={PIOMIO_URL=${tomlString(this.o.mcp.url)},PIOMIO_TOKEN_FILE=${tomlString(join(this.dir, "token"))}}`,
      `mcp_servers.piomio.tool_timeout_sec=3600`,
      // The hub's gateway decides about each of its tools; Codex asking the person first ended as "user rejected".
      `mcp_servers.piomio.default_tools_approval_mode="approve"`,
      `approval_policy=${tomlString(this.approvalPolicy())}`,
      NO_FAST_TIER,
      ...((!exec && this.profile()) || [`sandbox_mode=${tomlString(this.sandbox())}`]),
      // Legacy exec cannot enforce a profile's domain rules. Do not turn its sandbox into unrestricted networking.
      ...(exec && this.o.confine ? ["sandbox_workspace_write.network_access=false"] : []),
      ...(this.o.effort ? [`model_reasoning_effort=${tomlString(this.o.effort)}`] : []),
      ...(this.p.extraConfig?.() ?? []),
    ];
  }

  private args(): string[] {
    const a = ["exec", "--json", "--skip-git-repo-check", "-C", this.o.workspace];
    for (const c of this.config(true)) a.push("-c", c);
    if (this.o.model) a.push("-m", this.o.model);
    if (this.threadId) a.push("resume", this.threadId, "-");
    else a.push("-");
    return a;
  }

  private async childEnv(): Promise<Record<string, string>> {
    return childEnv(process.env, { ...this.o.env, ...(await this.p.authEnv?.()), ...confinedProxyEnv(this.o) });
  }

  private newServer(env: Record<string, string>): CodexAppServer {
    return new CodexAppServer({
      command: this.p.command?.() ?? "codex",
      config: this.config(),
      cwd: this.o.workspace,
      env,
      model: this.o.model,
      effort: this.o.effort,
      sandbox: this.o.bare ? "read-only" : this.sandbox(),
      threadId: this.threadId,
      ask: this.ask(),
      approvalPolicy: this.approvalPolicy(),
      ...(this.profile() && !this.o.bare ? { profile: true } : {}),
      ...(this.o.bare ? { bare: { instructions: this.o.systemPrompt } } : {}),
    });
  }

  /** The process starts and opens the thread before the person's message comes. Never fails: a turn starts its own. */
  warm(): Promise<void> {
    if (!this.o.keepWarm || this.execOnly || this.turning || this.app?.alive()) return this.warming ?? Promise.resolve();
    this.warming ??= this.warmUp().finally(() => (this.warming = undefined));
    return this.warming;
  }

  private async warmUp(): Promise<void> {
    const env = await this.childEnv();
    // A turn came while the environment was being read: it starts the process.
    if (this.turning || this.closed || this.app?.alive()) return;
    const app = this.newServer(env);
    this.app = app;
    try {
      await app.open();
      if (!this.turning && this.app === app) this.rest();
    } catch (e) {
      this.p.log?.(`codex warm-up failed: ${(e as Error).message}`);
      if (e instanceof AppServerUnsupported) this.execOnly = true;
      if (this.app === app) this.app = undefined;
      void app.stop();
    }
  }

  /** Between turns: the process waits for the next one, then closes. */
  private rest(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.release(), this.p.idleMs ?? IDLE_MS);
    this.idle.unref?.();
    this.pool.rest(this);
  }

  /** Let the waiting process go. */
  release(): void {
    clearTimeout(this.idle);
    this.pool.take(this);
    if (this.turning) return;
    const app = this.app;
    this.app = undefined;
    void app?.stop();
  }

  async *send(turn: BrainTurn): AsyncGenerator<BrainEvent> {
    // The hub chose how this turn thinks: from here on the session thinks so.
    if (turn.model) this.o = { ...this.o, model: turn.model };
    if (turn.effort) this.o = { ...this.o, effort: turn.effort };
    this.interrupted = false;
    this.turning = true;
    clearTimeout(this.idle);
    this.pool.take(this);
    try {
      // A warm-up in its first moment has not started the process yet: this turn does.
      const env = await this.childEnv();
      if (!this.execOnly) {
        // A dialog's process may be waiting already (warm, or the turn before); else it starts now.
        let app = this.app?.alive() ? this.app : this.newServer(env);
        this.app = app;
        app.think({ model: this.o.model, effort: this.o.effort });
        try {
          for await (const e of app.run(turn)) yield e;
          // The thread is too full to go on (Codex compacts on its own; this is when that was not enough): a fresh
          // thread from the hub's recap.
          if (app.parser.full && turn.recap && app.threadId && !this.interrupted) {
            this.p.log?.(`codex thread ${app.threadId} is full, starting a fresh one from the recap`);
            this.threadId = undefined;
            await app.stop();
            app = this.newServer(env);
            this.app = app;
            for await (const e of app.run({ ...turn, text: `${turn.recap}\n\n---\n${turn.text}` })) yield e;
          }
        } catch (e) {
          if (!(e instanceof AppServerUnsupported)) throw e;
          this.execOnly = true;
          this.app = undefined;
          this.p.log?.(`codex app-server unavailable (${e.message}); turns use codex exec`);
        }
        if (!this.execOnly) {
          if (app.threadId) this.threadId = app.threadId;
          const f = app.parser;
          // A dialog's process waits for the next turn, unless something is wrong with it (the next turn starts clean).
          const keep = !!this.o.keepWarm && !this.o.bare && !this.closed && app.alive() && f.completed && !f.failed && !f.limit;
          if (!keep) {
            this.app = undefined;
            await app.stop();
          }
          if (!this.interrupted) {
            const t = brainsT(this.p.locale?.());
            if (f.limit) yield { type: "limit_hit", resetAt: f.limit.resetAt, detail: `Codex: ${f.limit.detail}` };
            else if (f.failed || !f.completed) {
              const stderr = app.stderr();
              const auth = f.auth || /not logged in|login|401|unauthorized|api key/i.test(`${f.failed ?? ""}\n${stderr}`);
              yield { type: "error", fatal: !f.completed, message: auth ? t("codex.notSignedIn") : (f.failed ?? stderr.trim().split("\n").slice(-6).join("\n")) || t("codex.failed") };
            }
          }
          if (keep) this.rest();
          yield { type: "done", resumeToken: this.threadId };
          return;
        }
      }
      yield* this.sendExec(turn, env);
    } finally {
      this.turning = false;
    }
  }

  /** A turn through `codex exec` (a Codex too old for the app server). */
  private async *sendExec(turn: BrainTurn, env: Record<string, string>): AsyncGenerator<BrainEvent> {
    const parser = new CodexStreamParser();
    const proc = runLines(this.p.command?.() ?? "codex", this.args(), { cwd: this.o.workspace, env, input: turn.text });
    this.proc = proc;
    for await (const line of proc.lines) {
      if (!line.trim().startsWith("{")) continue;
      let ev: unknown;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      for (const e of parser.push(ev)) yield e;
    }
    const exit = await proc.exited;
    this.proc = undefined;
    if (parser.threadId) this.threadId = parser.threadId;
    if (!this.interrupted) {
      if (parser.limit) yield { type: "limit_hit", resetAt: parser.limit.resetAt, detail: `Codex: ${parser.limit.detail}` };
      else if (parser.failed || exit.code !== 0) {
        const stderr = proc.stderr();
        const notInstalled = /ENOENT|not recognized|command not found/i.test(stderr);
        const auth = /not logged in|login|401|unauthorized|api key/i.test(`${parser.failed ?? ""}\n${stderr}`);
        const t = brainsT(this.p.locale?.());
        yield {
          type: "error",
          fatal: !parser.completed,
          message: notInstalled
            ? t("codex.notInstalled")
            : auth
              ? t("codex.notSignedIn")
              : (parser.failed ?? stderr.trim().split("\n").slice(-6).join("\n")) || t("codex.failed"),
        };
      }
    }
    yield { type: "done", resumeToken: this.threadId };
  }

  async steer(turn: BrainTurn): Promise<boolean> {
    return this.app && !this.interrupted ? this.app.steer(turn) : false;
  }

  interrupt(): void {
    if (this.app) {
      // A waiting process has no turn to stop.
      if (!this.turning) return;
      this.interrupted = true;
      void this.app.interrupt(!!this.o.keepWarm && !this.closed);
      return;
    }
    if (!this.proc) return;
    this.interrupted = true;
    const c = this.proc.child;
    c.kill("SIGINT");
    setTimeout(() => {
      if (c.exitCode === null) c.kill("SIGKILL");
    }, 5000).unref();
  }

  close(): void {
    this.closed = true;
    this.interrupt();
    this.release();
  }
}

/** Efforts Codex takes when it cannot list its models (`model_reasoning_effort`). */
const CODEX_EFFORTS = ["low", "medium", "high"];

/**
 * What Codex offers to think with: its own model list (app-server `model/list`) with the default model's efforts, and
 * the presets on the default model: fast = low effort, balanced = its default effort, deep = extra-high (or high).
 */
export function codexThinking(models: CodexModel[] | undefined): Pick<ProbeResult, "models" | "modelNames" | "model" | "efforts" | "presets" | "catalog"> {
  const def = models?.find((m) => m.isDefault) ?? models?.[0];
  if (!models || !def) return { efforts: CODEX_EFFORTS, presets: { fast: { effort: "low" }, balanced: { effort: "medium" }, deep: { effort: "high" } } };
  const efforts = def.efforts.length ? def.efforts : CODEX_EFFORTS;
  const has = (e: string) => efforts.includes(e);
  const deep = has("xhigh") ? "xhigh" : has("high") ? "high" : efforts.at(-1)!;
  return {
    models: models.map((m) => m.id),
    modelNames: Object.fromEntries(models.map((m) => [m.id, m.name])),
    // What Codex says of each model now (its descriptions, the ones it calls older): the hub chooses by this.
    catalog: markLegacy(models.map((m) => profileFrom({ id: m.id, name: m.name, ...(m.description ? { description: m.description } : {}), ...(m.upgrade ? { deprecated: true } : {}), ...(m.images ? { images: true } : {}) }))),
    model: def.id,
    efforts,
    presets: {
      fast: { model: def.id, effort: has("low") ? "low" : efforts[0] },
      balanced: { model: def.id, effort: def.defaultEffort && has(def.defaultEffort) ? def.defaultEffort : has("medium") ? "medium" : efforts[0] },
      deep: { model: def.id, effort: deep },
    },
  };
}

export function createCodexProvider(p: CodexOptions): BrainProviderImpl {
  const pool = new WarmPool<CodexSession>(p.maxWarm ?? MAX_WARM);
  // The model list, asked once per command and version for ten minutes (it starts an app-server).
  let listed: { key: string; at: number; models: Promise<CodexModel[] | undefined> } | undefined;
  const modelsOf = (command: string, version: string, env: Record<string, string>) => {
    const key = `${command}|${version}`;
    if (listed?.key !== key || Date.now() - listed.at > 10 * 60_000) {
      listed = { key, at: Date.now(), models: listCodexModels(command, env).catch(() => undefined) };
    }
    return listed.models;
  };
  return {
    id: "codex",
    label: brainsT()("codex.label"),
    async probe(): Promise<ProbeResult> {
      const t = brainsT(p.locale?.());
      const command = p.command?.() ?? "codex";
      const env = childEnv(process.env, { ...(await p.authEnv?.().catch(() => ({}))) });
      const v = await capture(command, ["--version"], env);
      if (v.code !== 0) return { available: false, authenticated: false, detail: t("codex.notInstalled") };
      const version = v.stdout.trim().split(/\s+/).pop();
      if (env.OPENAI_API_KEY || env.CODEX_API_KEY) return { available: true, authenticated: true, version, ...codexThinking(await modelsOf(command, version ?? "", env)), detail: t("codex.apiKey") };
      const s = await capture(command, ["login", "status"], env);
      const ok = s.code === 0 && /logged in/i.test(s.stdout + s.stderr);
      const thinking = codexThinking(ok ? await modelsOf(command, version ?? "", env) : undefined);
      return { available: true, authenticated: ok, version, ...thinking, detail: ok ? (s.stdout + s.stderr).trim().split("\n")[0] : t("codex.noLogin") };
    },
    async createSession(opts: BrainSessionOptions): Promise<BrainSessionImpl> {
      mkdirSync(opts.workspace, { recursive: true });
      return new CodexSession(opts, p, pool);
    },
    // Device code sign-in as the same user and HOME the sessions use: the user opens the page and types the code.
    login({ env, onUpdate }) {
      const t = brainsT(p.locale?.());
      return runCliLogin({
        command: p.command?.() ?? "codex",
        args: ["login", "--device-auth"],
        env: childEnv(process.env, { ...env, NO_COLOR: "1" }),
        onUpdate,
        parse: parseCodexDeviceLogin,
        timeoutMs: p.loginTimeoutMs ?? 15 * 60_000,
        t,
        notInstalled: t("codex.notInstalled"),
      });
    },
  };
}
