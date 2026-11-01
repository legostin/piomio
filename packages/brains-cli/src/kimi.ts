// Kimi Code CLI as a brain, on the person's Kimi membership: `kimi acp` (Agent Client Protocol over stdio, acp.ts), one
// process per session, kept between turns for a dialog. The CLI signs in with its own device-code login (`kimi login`)
// and keeps the token in $HOME/.kimi-code: the hub never sees it (Kimi lets only its own clients use the account).
// Kimi has no OS sandbox: confined, it asks before writes and commands (`default` mode) and the hub decides
// (hub-permission.ts); on a machine whose own policy decides (`allow`), that answers; elsewhere it runs `yolo`, as
// Codex runs danger-full-access there.

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrainEvent, BrainSessionOptions, BrainTurn, ProbeResult } from "@piomio/shared";
import type { BrainProviderImpl, BrainSessionImpl } from "@piomio/plugin-sdk";
import type { Locale } from "@piomio/shared/i18n";
import { markLegacy, profileFrom } from "@piomio/shared/models";
import { ACP_AUTH_REQUIRED, AcpConnection, AcpError } from "./acp.ts";
import { capture, childEnv, EventQueue } from "./proc.ts";
import { brainsT } from "./messages.ts";
import { runCliLogin, stripAnsi, type LoginParser } from "./login.ts";
import { parseCodexReset } from "./codex-app.ts";
import { askHub } from "./hub-permission.ts";

export interface KimiOptions {
  command?: () => string;
  stateDir: string;
  log?: (msg: string) => void;
  /** Language for messages people read (probe details, failures); English by default. */
  locale?: () => Locale;
  /** How long a sign-in from the chat may wait for the person (Kimi's device codes last 30 minutes). */
  loginTimeoutMs?: number;
  /**
   * Where the hub does not confine the session but a policy of its own does (a machine's policy.json): whether Kimi
   * may run this tool with this input. With it, Kimi asks before writes and commands and this answers.
   */
  allow?: (tool: string, input: Record<string, unknown>, workspace: string) => boolean;
}

/** What every Kimi process gets: no colours, no telemetry to Moonshot. */
const KIMI_ENV = { NO_COLOR: "1", KIMI_DISABLE_TELEMETRY: "1" };

const isScript = (p: string) => /\.(m?js|cjs)$/i.test(p);

/** An npm cmd-shim's target: `"%dp0%\node_modules\…\main.mjs" %*`. */
function shimTarget(cmdFile: string): string | undefined {
  try {
    const m = /"%~?dp0%?\\([^"]+?\.m?js)"/i.exec(readFileSync(cmdFile, "utf8"));
    const target = m ? join(dirname(cmdFile), ...m[1].split(/[\\/]/)) : undefined;
    return target && existsSync(target) ? target : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The command to run: `kimi` from the PATH, as the script behind it when it is an npm link or shim (`main.mjs`, run
 * with this Node: the desktop hub's Node is not on the PATH, and the script's `#!/usr/bin/env node` would not find
 * one), or as the file found. A path, or a name that is not found, is returned as given.
 */
export function kimiCommand(command: string, env: Record<string, string | undefined> = process.env, platform = process.platform): string {
  if (isAbsolute(command) || /[\\/]/.test(command)) return command;
  const path = env.PATH ?? env.Path ?? "";
  const names = platform === "win32" ? [`${command}.cmd`, `${command}.exe`, command] : [command];
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const p = join(dir, name);
      let file = false;
      try {
        file = statSync(p).isFile();
      } catch {
        file = false;
      }
      if (!file) continue;
      if (/\.cmd$/i.test(p)) return shimTarget(p) ?? p;
      try {
        const real = realpathSync(p);
        return isScript(real) ? real : p;
      } catch {
        return p;
      }
    }
  }
  return command;
}

/**
 * `kimi login`: "Opening browser for Kimi device login: https://www.kimi.ai/code/authorize_device?user_code=IN1G-ZJ3X",
 * "… enter code: IN1G-ZJ3X", "Code expires in 1800s.".
 */
export const parseKimiDeviceLogin: LoginParser = (output, startedAt) => {
  const text = stripAnsi(output);
  const urls = text.match(/https:\/\/[^\s"'<>]+/g) ?? [];
  const url = urls.find((u) => /authorize_device|device/i.test(u)) ?? urls[0];
  const code = /enter code:\s*([A-Z0-9]{3,}(?:-[A-Z0-9]{3,})+)/i.exec(text)?.[1] ?? (url ? /user_code=([A-Z0-9]+(?:-[A-Z0-9]+)+)/i.exec(url)?.[1] : undefined);
  if (!url || !code) return undefined;
  const seconds = /expires in (\d+)\s*s/i.exec(text)?.[1];
  return { url, userCode: code, expiresAt: seconds ? new Date(startedAt + Number(seconds) * 1000).toISOString() : undefined };
};

/** One select of the session's configOptions (ACP SessionConfigOption). */
interface ConfigOption {
  id: string;
  category?: string;
  currentValue?: string;
  options?: Array<{ value: string; name?: string; description?: string }>;
}

const optionOf = (options: ConfigOption[] | undefined, id: string, category: string) => options?.find((o) => o?.id === id || o?.category === category);

/**
 * What Kimi offers to think with, from a session's configOptions: its models (the plan decides which) and thinking
 * levels, least first. Presets on the current model: fast = the lightest thinking, balanced = what it thinks by
 * default, deep = the most.
 */
export function kimiThinking(options: ConfigOption[] | undefined): Pick<ProbeResult, "models" | "modelNames" | "model" | "efforts" | "presets" | "catalog"> {
  const model = optionOf(options, "model", "model");
  const thinking = optionOf(options, "thinking", "thought_level");
  const models = (model?.options ?? []).filter((o) => typeof o?.value === "string" && o.value);
  if (!models.length) return {};
  const def = model?.currentValue && models.some((m) => m.value === model.currentValue) ? model.currentValue : models[0].value;
  const efforts = (thinking?.options ?? []).map((o) => String(o.value)).filter(Boolean);
  const on = efforts.filter((e) => e !== "off");
  const current = thinking?.currentValue && on.includes(thinking.currentValue) ? thinking.currentValue : on[Math.floor((on.length - 1) / 2)];
  const e = (v: string | undefined) => (v ? { effort: v } : {});
  return {
    models: models.map((m) => m.value),
    modelNames: Object.fromEntries(models.map((m) => [m.value, m.name || m.value])),
    catalog: markLegacy(models.map((m) => profileFrom({ id: m.value, name: m.name || m.value, ...(m.description ? { description: m.description } : {}) }))),
    model: def,
    ...(efforts.length ? { efforts } : {}),
    presets: { fast: { model: def, ...e(on[0]) }, balanced: { model: def, ...e(current) }, deep: { model: def, ...e(on.at(-1)) } },
  };
}

/** A tool call as the hub names it (Claude Code's names where Kimi's tool is the same kind of thing). */
export function kimiToolName(first: string | undefined, kind: string | undefined): string {
  const ident = first && /^[A-Za-z_][\w.-]*$/.test(first) ? first : undefined;
  switch (kind) {
    case "execute":
      return "Bash";
    case "read":
      return ident && ["Read", "Glob", "Grep", "ReadMediaFile"].includes(ident) ? ident : "Read";
    case "edit":
      return ident === "Write" ? "Write" : "Edit";
    case "fetch":
      return ident === "WebSearch" ? "WebSearch" : "WebFetch";
    case "think":
      return "Think";
  }
  return ident === "FetchURL" ? "WebFetch" : (ident ?? first ?? "tool");
}

/** The text of an ACP content list (tool output): text blocks and diffs, the rest by type. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) => {
      const inner = c?.type === "content" ? c.content : c;
      if (c?.type === "diff") return `${c.path ?? ""}: changed`;
      if (inner?.type === "text") return String(inner.text ?? "");
      return inner?.type ? `[${inner.type}]` : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** `session/update` notifications as BrainEvents. Pure: tested with recorded frames. */
export class KimiUpdateParser {
  /** Tool calls by id: the name it was first seen with, its kind and input, what was already said of it. */
  readonly calls = new Map<string, { first?: string; kind?: string; input?: unknown; started: boolean; done: boolean }>();

  push(u: any): BrainEvent[] {
    const out: BrainEvent[] = [];
    if (!u || typeof u !== "object") return out;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text" && u.content.text) out.push({ type: "text", delta: String(u.content.text) });
        break;
      case "tool_call":
      case "tool_call_update": {
        const id = String(u.toolCallId ?? "");
        if (!id) break;
        let c = this.calls.get(id);
        if (!c) this.calls.set(id, (c = { first: typeof u.title === "string" ? u.title : undefined, started: false, done: false }));
        if (u.kind) c.kind = u.kind;
        if (u.rawInput !== undefined) c.input = u.rawInput;
        const final = u.status === "completed" || u.status === "failed";
        if (!c.started && (c.input !== undefined || final)) {
          c.started = true;
          out.push({ type: "tool_call", id, name: kimiToolName(c.first, c.kind), input: c.input ?? {} });
        }
        if (final && !c.done) {
          c.done = true;
          const output = contentText(u.content) || (u.rawOutput === undefined ? "" : typeof u.rawOutput === "string" ? u.rawOutput : JSON.stringify(u.rawOutput));
          out.push({ type: "tool_result", id, output, isError: u.status === "failed" });
        }
        break;
      }
    }
    return out;
  }
}

/** Quota and rate limits, in the words providers use. */
const LIMIT = /rate.?limit|quota|usage limit|too many requests|\b429\b|limit (reached|exceeded)|insufficient (balance|credit)/i;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

class KimiSession implements BrainSessionImpl {
  private o: BrainSessionOptions;
  private p: KimiOptions;
  private dir: string;
  private conn?: AcpConnection;
  /** Kimi's own session id: the resume token. */
  private sessionId?: string;
  private config: ConfigOption[] = [];
  private mode?: string;
  /** The connection being set up (warm and send may both ask for it). */
  private opening?: Promise<void>;
  /** The hub's recap goes before the next prompt: the session to resume was gone. */
  private recapDue = false;
  private parser?: KimiUpdateParser;
  private events?: EventQueue<BrainEvent>;
  private interrupted = false;

  constructor(opts: BrainSessionOptions, p: KimiOptions) {
    this.o = opts;
    this.p = p;
    this.sessionId = opts.resume;
    this.dir = join(p.stateDir, "sessions", opts.sessionId.replace(/[^\w-]/g, "_"));
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tokenFile = join(this.dir, "token");
    writeFileSync(tokenFile, opts.mcp.token, { mode: 0o600 });
    try {
      chmodSync(tokenFile, 0o600);
    } catch {
      /* windows */
    }
    // Kimi reads AGENTS.md from the working directory: that is where our system prompt goes.
    const agentsFile = join(opts.workspace, "AGENTS.md");
    const marker = "<!-- piomio:system -->";
    const existing = existsSync(agentsFile) ? readFileSync(agentsFile, "utf8") : "";
    const userPart = existing.includes(marker) ? existing.slice(existing.indexOf("<!-- /piomio:system -->") + 24) : existing;
    writeFileSync(agentsFile, `${marker}\n${opts.systemPrompt}\n<!-- /piomio:system -->\n${userPart}`);
  }

  private t() {
    return brainsT(this.p.locale?.());
  }

  /** The hub's MCP server through the stdio bridge, as ACP passes MCP servers. */
  private mcpServers(): unknown[] {
    const [command, ...args] = this.o.mcp.bridgeCommand.length ? this.o.mcp.bridgeCommand : ["piomio-mcp-bridge"];
    return [{ name: "piomio", command, args, env: [{ name: "PIOMIO_URL", value: this.o.mcp.url }, { name: "PIOMIO_TOKEN_FILE", value: join(this.dir, "token") }] }];
  }

  /** Confined, a front desk or under a machine's policy: Kimi asks before writes and commands. Otherwise it goes ahead. */
  private wantedMode(): string {
    return this.o.confine || this.o.frontDesk || this.p.allow ? "default" : "yolo";
  }

  private open(): Promise<void> {
    if (this.conn?.alive && this.sessionId && !this.opening) return Promise.resolve();
    this.opening ??= this.start().finally(() => (this.opening = undefined));
    return this.opening;
  }

  private async start(): Promise<void> {
    const env = childEnv(process.env, { ...this.o.env, ...KIMI_ENV });
    const command = kimiCommand(this.p.command?.() ?? "kimi", env);
    const conn = new AcpConnection(command, ["acp"], { cwd: this.o.workspace, env }, { notification: (m, p) => this.onNotification(m, p), request: (m, p) => this.onRequest(m, p) });
    this.conn = conn;
    try {
      await conn.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "piomio", title: "Piomio", version: "1" } }, 60_000);
      const session = { cwd: this.o.workspace, mcpServers: this.mcpServers() };
      let r: any;
      if (this.sessionId) {
        r = await conn.request("session/resume", { sessionId: this.sessionId, ...session }, 60_000).catch((e) => {
          if (e instanceof AcpError && e.code === ACP_AUTH_REQUIRED) throw e;
          this.p.log?.(`kimi session ${this.sessionId} could not be resumed (${(e as Error).message}), starting a fresh one`);
          return undefined;
        });
        if (!r) {
          this.sessionId = undefined;
          this.recapDue = true;
        }
      }
      if (!r) {
        r = await conn.request("session/new", session, 60_000);
        this.sessionId = String(r?.sessionId ?? "");
      }
      this.config = Array.isArray(r?.configOptions) ? r.configOptions : [];
      this.mode = r?.modes?.currentModeId ?? optionOf(this.config, "mode", "mode")?.currentValue;
    } catch (e) {
      conn.kill();
      this.conn = undefined;
      throw e;
    }
  }

  /** Sets one of the session's selects when it differs and Kimi offers that value. */
  private async setOption(id: string, category: string, value: string | undefined): Promise<void> {
    const opt = optionOf(this.config, id, category);
    if (!value || !opt || opt.currentValue === value) return;
    if (!opt.options?.some((o) => o.value === value)) {
      this.p.log?.(`kimi: ${id} "${value}" is not among ${opt.options?.map((o) => o.value).join(", ")}`);
      return;
    }
    const r: any = await this.conn!.request("session/set_config_option", { sessionId: this.sessionId, configId: opt.id, value });
    if (Array.isArray(r?.configOptions)) this.config = r.configOptions;
    else opt.currentValue = value;
  }

  private onNotification(method: string, params: any): void {
    if (method !== "session/update" || params?.sessionId !== this.sessionId) return;
    const u = params.update;
    if (u?.sessionUpdate === "config_option_update" && Array.isArray(u.configOptions)) this.config = u.configOptions;
    if (u?.sessionUpdate === "current_mode_update" && u.currentModeId) this.mode = u.currentModeId;
    if (!this.parser || !this.events) return;
    for (const e of this.parser.push(u)) this.events.push(e);
  }

  /** Kimi asks before a tool runs (default mode), or asks the person a question. */
  private async onRequest(method: string, params: any): Promise<unknown> {
    if (method !== "session/request_permission") throw new AcpError(-32601, `${method} is not supported by Piomio`);
    const options: Array<{ optionId: string; kind?: string }> = Array.isArray(params?.options) ? params.options : [];
    const pick = (yes: boolean) => {
      const o = options.find((x) => x.kind === (yes ? "allow_once" : "reject_once")) ?? options.find((x) => x.kind?.startsWith(yes ? "allow" : "reject"));
      return o ? { outcome: { outcome: "selected", optionId: o.optionId } } : { outcome: { outcome: "cancelled" } };
    };
    const tc = params?.toolCall ?? {};
    const tool = String(tc.title ?? "");
    // Agents ask the person through the hub, not through Kimi's own question form.
    if (tool === "AskUserQuestion") return { outcome: { outcome: "cancelled" } };
    // The hub checks its own tools itself.
    if (tool.startsWith("mcp__piomio__")) return pick(true);
    // A dialog's front desk only looks: what Kimi asks about there (writes, commands) is a task's work.
    if (this.o.frontDesk) return pick(false);
    const raw = this.parser?.calls.get(String(tc.toolCallId ?? ""))?.input;
    const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const confine = this.o.confine;
    if (confine) return pick(await askHub(this.o.mcp, confine.permissionTool, `kimi.${tool}`, input));
    return pick(this.p.allow ? this.p.allow(tool, input, this.o.workspace) : true);
  }

  private prompt(turn: BrainTurn): unknown[] {
    const text = this.recapDue && turn.recap ? `${turn.recap}\n\n---\n${turn.text}` : turn.text;
    this.recapDue = false;
    const blocks: unknown[] = [{ type: "text", text }];
    for (const a of turn.attachments ?? []) {
      try {
        if (IMAGE.test(a)) blocks.push({ type: "image", mimeType: MIME[extname(a).toLowerCase()] ?? "image/png", data: readFileSync(a).toString("base64") });
        else blocks.push({ type: "resource_link", uri: pathToFileURL(a).href, name: a.split(/[\\/]/).pop() ?? a });
      } catch {
        /* a file that went away: the text still says what it was */
      }
    }
    return blocks;
  }

  /** A failure people read: not signed in, a limit, or what Kimi said. */
  private failure(e: unknown): BrainEvent {
    const t = this.t();
    const message = String((e as Error)?.message ?? e);
    if (e instanceof AcpError && e.code === ACP_AUTH_REQUIRED) return { type: "error", fatal: true, message: t("kimi.notSignedIn") };
    if (/ENOENT|not recognized|command not found/i.test(`${message}\n${this.conn?.stderr() ?? ""}`)) return { type: "error", fatal: true, message: t("kimi.notInstalled") };
    if (LIMIT.test(message)) return { type: "limit_hit", resetAt: parseCodexReset(message), detail: `Kimi: ${message}` };
    return { type: "error", fatal: true, message: message || t("kimi.failed") };
  }

  async warm(): Promise<void> {
    if (this.o.keepWarm) await this.open().catch((e) => this.p.log?.(`kimi warm-up failed: ${(e as Error).message}`));
  }

  async *send(turn: BrainTurn): AsyncGenerator<BrainEvent> {
    // The hub chose how this turn thinks: from here on the session thinks so.
    if (turn.model) this.o = { ...this.o, model: turn.model };
    if (turn.effort) this.o = { ...this.o, effort: turn.effort };
    this.interrupted = false;
    const events = new EventQueue<BrainEvent>();
    this.events = events;
    this.parser = new KimiUpdateParser();
    let stop: string | undefined;
    let failed: BrainEvent | undefined;
    const run = (async () => {
      try {
        await this.open();
        if (this.mode !== this.wantedMode()) {
          await this.conn!.request("session/set_mode", { sessionId: this.sessionId, modeId: this.wantedMode() });
          this.mode = this.wantedMode();
        }
        await this.setOption("model", "model", this.o.model);
        await this.setOption("thinking", "thought_level", this.o.effort);
        const model = optionOf(this.config, "model", "model")?.currentValue;
        if (model) events.push({ type: "model", model });
        const r: any = await this.conn!.request("session/prompt", { sessionId: this.sessionId, prompt: this.prompt(turn) });
        stop = r?.stopReason;
        const u = r?.usage;
        if (u && (u.inputTokens || u.outputTokens)) events.push({ type: "usage", inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0 });
      } catch (e) {
        if (!this.interrupted) failed = this.failure(e);
      } finally {
        events.end();
      }
    })();
    for await (const e of events) yield e;
    await run;
    this.events = undefined;
    if (failed) yield failed;
    else if (stop === "refusal" && !this.interrupted) yield { type: "error", message: this.t()("kimi.refused") };
    // A task's process ends with its turn; the next one resumes the session.
    if (!this.o.keepWarm || failed) {
      const conn = this.conn;
      this.conn = undefined;
      await conn?.close().catch(() => {});
    }
    yield { type: "done", resumeToken: this.sessionId };
  }

  steer(): boolean {
    return false;
  }

  interrupt(): void {
    if (!this.events || !this.conn?.alive) return;
    this.interrupted = true;
    this.conn.notify("session/cancel", { sessionId: this.sessionId });
    const conn = this.conn;
    // Kimi ends the prompt with stopReason "cancelled"; one that does not is stopped.
    setTimeout(() => {
      if (this.events && this.conn === conn) conn.kill();
    }, 10_000).unref();
  }

  async close(): Promise<void> {
    this.interrupt();
    const conn = this.conn;
    this.conn = undefined;
    await conn?.close().catch(() => {});
  }
}

/** What a scratch session says: signed in or not, and what it offers. */
type KimiInfo = { auth: false } | { auth: true; options: ConfigOption[] } | { error: string };

async function kimiInfo(command: string, env: Record<string, string>, dir: string): Promise<KimiInfo> {
  mkdirSync(dir, { recursive: true });
  const conn = new AcpConnection(command, ["acp"], { cwd: dir, env });
  try {
    await conn.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "piomio", title: "Piomio", version: "1" } }, 30_000);
    const r: any = await conn.request("session/new", { cwd: dir, mcpServers: [] }, 30_000);
    if (r?.sessionId) await conn.request("session/delete", { sessionId: r.sessionId }, 10_000).catch(() => {});
    return { auth: true, options: Array.isArray(r?.configOptions) ? r.configOptions : [] };
  } catch (e) {
    if (e instanceof AcpError && e.code === ACP_AUTH_REQUIRED) return { auth: false };
    return { error: String((e as Error)?.message ?? e) };
  } finally {
    await conn.close(2000);
  }
}

export function createKimiProvider(p: KimiOptions): BrainProviderImpl {
  // A signed-in Kimi's offer, per command and version for ten minutes (it starts a process). A "not signed in" is
  // never kept: the sign-in card checks again right after the person confirms.
  let known: { key: string; at: number; options: ConfigOption[] } | undefined;
  return {
    id: "kimi",
    label: brainsT()("kimi.label"),
    async probe(): Promise<ProbeResult> {
      const t = brainsT(p.locale?.());
      const env = childEnv(process.env, KIMI_ENV);
      const command = kimiCommand(p.command?.() ?? "kimi", env);
      const v = await capture(command, ["--version"], env);
      if (v.code !== 0) return { available: false, authenticated: false, detail: t("kimi.notInstalled") };
      const version = v.stdout.trim().split(/\s+/).pop();
      const key = `${command}|${version}`;
      if (known?.key === key && Date.now() - known.at < 10 * 60_000) return { available: true, authenticated: true, version, ...kimiThinking(known.options), detail: t("kimi.signedIn") };
      const info = await kimiInfo(command, env, join(p.stateDir, "probe"));
      if ("error" in info) return { available: true, authenticated: false, version, detail: t("kimi.checkFailed", { detail: info.error.slice(0, 300) }) };
      if (!info.auth) return { available: true, authenticated: false, version, detail: t("kimi.noLogin") };
      known = { key, at: Date.now(), options: info.options };
      return { available: true, authenticated: true, version, ...kimiThinking(info.options), detail: t("kimi.signedIn") };
    },
    async createSession(opts: BrainSessionOptions): Promise<BrainSessionImpl> {
      mkdirSync(opts.workspace, { recursive: true });
      return new KimiSession(opts, p);
    },
    // Device code sign-in as the same user and HOME the sessions use: the person opens the page and confirms the code.
    login({ env, onUpdate }) {
      known = undefined;
      const t = brainsT(p.locale?.());
      const base = childEnv(process.env, { ...env, ...KIMI_ENV });
      const command = kimiCommand(p.command?.() ?? "kimi", base);
      // The card shows the page to open: Kimi would also open a browser on the hub's computer, where the person may
      // not be. Found by path, the CLI needs no PATH (a script runs with this Node), so it gets one without `open`.
      const quiet = isAbsolute(command) ? { ...base, [Object.keys(base).find((k) => k.toUpperCase() === "PATH") ?? "PATH"]: dirname(process.execPath) } : base;
      return runCliLogin({
        command,
        args: ["login"],
        env: quiet,
        onUpdate,
        parse: parseKimiDeviceLogin,
        timeoutMs: p.loginTimeoutMs ?? 30 * 60_000,
        t,
        notInstalled: t("kimi.notInstalled"),
      });
    },
  };
}
