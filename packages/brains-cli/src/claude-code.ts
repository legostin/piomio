// Claude Code as a brain: a headless `claude -p` process, `--resume` when one has to start again. The turn's input goes
// in as stream-json and stdin stays open while it runs: more user messages (steer) join the turn at its next step.
// A task's process ends with its turn; a dialog's (keepWarm) waits for the next turn and can start before the first.
// Uses the user's subscription (CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`, or a login in HOME, which the user
// can make from the chat: `claude auth login` prints a sign-in page and reads the code that page shows from stdin).

import { mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BrainEvent, BrainSessionOptions, BrainTurn, ProbeResult } from "@piomio/shared";
import type { BrainProviderImpl, BrainSessionImpl } from "@piomio/plugin-sdk";
import type { Locale, Translate } from "@piomio/shared/i18n";
import { capture, childEnv, runLines, textOfToolContent, type RunningProcess } from "./proc.ts";
import { brainsT } from "./messages.ts";
import { parseClaudeBrowserLogin, runCliLogin } from "./login.ts";

const MCP_PREFIX = "mcp__piomio__";

export const DEFAULT_CLAUDE_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Task",
  "Skill",
  "NotebookEdit",
  "mcp__piomio",
];

export interface ClaudeCodeOptions {
  /** CLI command (default "claude"). */
  command?: () => string;
  /** Extra env for the CLI (e.g. CLAUDE_CODE_OAUTH_TOKEN), resolved per session. */
  authEnv?: () => Promise<Record<string, string>>;
  /** Built-in tools Claude Code may use without asking (dontAsk mode denies everything else). */
  allowedTools?: () => string[];
  /** Where per-session private files (MCP config with the token, prompt) are written. */
  stateDir: string;
  log?: (msg: string) => void;
  /** Language for messages people read (probe details, failures); English by default. */
  locale?: () => Locale;
  /** How long a sign-in from the chat may wait for the user to paste the code. */
  loginTimeoutMs?: number;
  /** How long a dialog's process waits for its next turn (default 10 minutes), and how many wait at once (3). */
  idleMs?: number;
  maxWarm?: number;
}

/** Turns Claude Code stream-json messages into BrainEvents. Pure: easy to test with recorded fixtures. */
export class ClaudeStreamParser {
  sessionId?: string;
  limit?: { resetAt?: string; detail: string };
  private streamed = new Set<string>();
  sawResult = false;
  resultError?: string;
  mcpFailed = false;
  /** User messages from stdin the CLI has taken (--replay-user-messages echoes each one when it does). */
  replays = 0;
  /** The model that answered (reported once). */
  model?: string;
  private t: Translate;

  constructor(t: Translate = brainsT()) {
    this.t = t;
  }

  push(msg: any): BrainEvent[] {
    const out: BrainEvent[] = [];
    if (!msg || typeof msg !== "object") return out;
    if (msg.session_id) this.sessionId = msg.session_id;
    const top = msg.parent_tool_use_id === null || msg.parent_tool_use_id === undefined;
    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init" && Array.isArray(msg.mcp_servers)) {
          const ob = msg.mcp_servers.find((s: any) => s.name === "piomio");
          if (ob && ob.status !== "connected") {
            this.mcpFailed = true;
            out.push({ type: "error", message: this.t("claude.mcpUnavailable", { status: ob.status }) });
          }
        }
        break;
      }
      case "stream_event": {
        const ev = msg.event;
        if (!top || !ev) break;
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          if (msg.api_message_id) this.streamed.add(msg.api_message_id);
          out.push({ type: "text", delta: ev.delta.text });
        }
        break;
      }
      case "assistant": {
        if (!top) break;
        const m = msg.message ?? {};
        // The model that answers, once per turn (not the stand-in Claude Code writes for its own error messages).
        if (typeof m.model === "string" && m.model && m.model !== "<synthetic>" && m.model !== this.model) {
          this.model = m.model;
          out.push({ type: "model", model: m.model });
        }
        for (const block of m.content ?? []) {
          if (block.type === "text" && block.text && !this.streamed.has(m.id)) out.push({ type: "text", delta: block.text });
          if (block.type === "tool_use") out.push({ type: "tool_call", id: block.id, name: stripPrefix(block.name), input: block.input ?? {} });
        }
        if (typeof m.content?.[0]?.text === "string" && /usage limit|limit reached/i.test(m.content[0].text) && m.model === "<synthetic>") {
          this.limit = { detail: m.content[0].text, resetAt: parseResetFromText(m.content[0].text) };
        }
        break;
      }
      case "user": {
        if (msg.isReplay) {
          this.replays++;
          break;
        }
        if (!top || !Array.isArray(msg.message?.content)) break;
        for (const block of msg.message.content) {
          if (block?.type === "tool_result") out.push({ type: "tool_result", id: block.tool_use_id, output: textOfToolContent(block.content), isError: !!block.is_error });
        }
        break;
      }
      case "rate_limit_event": {
        const info = msg.rate_limit_info ?? {};
        if (info.status === "rejected") {
          this.limit = {
            resetAt: info.resetsAt ? new Date(Number(info.resetsAt) * 1000).toISOString() : undefined,
            detail: this.t("claude.limit", { kind: info.rateLimitType ?? "limit" }),
          };
        }
        break;
      }
      case "result": {
        this.sawResult = true;
        this.resultError = undefined;
        const u = msg.usage ?? {};
        out.push({
          type: "usage",
          inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
          costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined,
        });
        if (msg.is_error || (msg.subtype && msg.subtype !== "success")) {
          const text = String(msg.result ?? msg.subtype ?? "error");
          if (this.limit || /usage limit|rate limit|limit reached|out of extra usage/i.test(text)) {
            this.limit ??= { detail: text, resetAt: parseResetFromText(text) };
          } else this.resultError = text;
        }
        break;
      }
    }
    return out;
  }
}

function stripPrefix(name: string): string {
  return typeof name === "string" && name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

/** "Claude AI usage limit reached|1793013600" or "... resets 5pm" → ISO date when we can tell. */
export function parseResetFromText(text: string): string | undefined {
  const m = /\|(\d{10})\b/.exec(text);
  if (m) return new Date(Number(m[1]) * 1000).toISOString();
  return undefined;
}

/**
 * `full`: the conversation no longer fits the model's context (its own compaction did not save it): the session goes on
 * afresh from the hub's recap.
 */
export function classifyClaudeFailure(
  stderr: string,
  resultError?: string,
  t: Translate = brainsT(),
): { message: string; fatal: boolean; auth: boolean; noSession: boolean; full: boolean } {
  const text = `${resultError ?? ""}\n${stderr}`;
  const noSession = /No conversation found|session .* not found/i.test(text);
  const full = /prompt is too long|context (window|length) (exceeded|limit)|exceeds? the (model's )?(context|maximum)|too many tokens/i.test(text);
  const auth = /not logged in|please run .*login|invalid api key|authentication|OAuth token|401|\/login/i.test(text) && !noSession;
  const enoent = /ENOENT|not recognized|command not found/i.test(text);
  if (enoent) return { message: t("claude.notInstalled"), fatal: true, auth: false, noSession: false, full: false };
  if (auth) return { message: t("claude.notSignedIn"), fatal: true, auth: true, noSession: false, full: false };
  const tail = text.trim().split("\n").slice(-6).join("\n").slice(0, 1500);
  return { message: tail || t("claude.failed"), fatal: true, auth: false, noSession, full };
}

// ---------- models and effort ----------

/** Claude Code's own model aliases: each names the latest model of its line. */
export const CLAUDE_MODELS = ["fable", "opus", "sonnet", "haiku"];
const CLAUDE_MODEL_NAMES: Record<string, string> = { fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };

/** What the installed CLI takes, from its --help. */
export interface ClaudeCaps {
  /** --effort levels; undefined when the CLI has no --effort. */
  efforts?: string[];
  /** --system-prompt-snapshot: a resumed conversation would keep its first system prompt unless it is off. */
  snapshot: boolean;
}

export function parseClaudeHelp(help: string): ClaudeCaps {
  const at = help.search(/^\s*--effort\b/m);
  let efforts: string[] | undefined;
  if (at >= 0) {
    const rest = help.slice(at);
    const next = rest.slice(2).search(/\n\s*-{1,2}[a-z]/i);
    const block = next >= 0 ? rest.slice(0, next + 2) : rest;
    const list = /\(([a-z]+(?:,\s*(?:or\s+)?[a-z]+)+)\)/i.exec(block.replace(/\s+/g, " "));
    efforts = list ? list[1].split(",").map((s) => s.replace(/^\s*or\s+/i, "").trim().toLowerCase()).filter(Boolean) : ["low", "medium", "high"];
  }
  return { ...(efforts ? { efforts } : {}), snapshot: /^\s*--system-prompt-snapshot\b/m.test(help) };
}

/** Fast: Sonnet with little thinking; balanced: Opus at medium effort; deep: Opus at extra-high effort. */
export function claudePresets(efforts?: string[]): NonNullable<ProbeResult["presets"]> {
  const e = (x: string) => (efforts?.includes(x) ? { effort: x } : {});
  return { fast: { model: "sonnet", ...e("low") }, balanced: { model: "opus", ...e("medium") }, deep: { model: "opus", ...(efforts?.includes("xhigh") ? e("xhigh") : e("high")) } };
}

/** What a dialog's front desk may not do itself (BrainSessionOptions.frontDesk): run commands, change files. */
const FRONT_DESK_DENIED = ["Bash", "BashOutput", "KillShell", "Write", "Edit", "MultiEdit", "NotebookEdit"];

/** Tools a confined session may use without asking: the web (through the hub's proxy), planning, subagents, skills, the hub. */
const CONFINED_ALLOWED = /^(WebFetch|WebSearch|TodoWrite|Task|Agent|Skill|ToolSearch|mcp__piomio)$/;

/**
 * The hub's own tools are always allowed: they act on the hub, which gates them itself, and without them don't-ask mode
 * denies every card, delegation and report. A list saved before the rename names the server mcp__owlbot, which is gone.
 */
function withHubTools(tools: string[]): string[] {
  const kept = tools.filter((x) => !/^mcp__owlbot(__|$)/.test(x));
  return kept.includes("mcp__piomio") ? kept : [...kept, "mcp__piomio"];
}

/**
 * Claude Code's sandbox for a confined session (macOS Seatbelt): commands write in the workspace and the temp folders,
 * read anything but `denyRead` (except `allowRead`), and reach no network; one that needs more retries outside the
 * sandbox, which the permission tool decides. No sandbox, no session: it never falls back to running unsandboxed.
 */
export function sandboxSettings(confine: NonNullable<BrainSessionOptions["confine"]>): Record<string, unknown> {
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: true,
      filesystem: { denyRead: confine.denyRead, allowRead: confine.allowRead, ...(confine.allowWrite?.length ? { allowWrite: confine.allowWrite } : {}) },
      network: { allowedDomains: [] },
    },
  };
}

/** One user message on stream-json stdin. */
function userLine(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
}

let controls = 0;
/** A control request on stream-json stdin (the CLI answers with a control_response line, which the parser skips). */
function controlLine(request: Record<string, unknown>): string {
  return `${JSON.stringify({ type: "control_request", request_id: `owl-${++controls}`, request })}\n`;
}

/** After a result, how long the CLI may stay silent with input it has not taken before stdin is closed anyway. */
const PENDING_INPUT_GRACE_MS = 30_000;
/** A dialog's process waits this long for its next turn before it closes (BrainSessionOptions.keepWarm). */
const IDLE_MS = 10 * 60_000;
/** Processes kept waiting at once per provider; the one waiting longest closes first. */
const MAX_WARM = 3;

const TIMEOUT = Symbol("timeout");

/** The lines of a process that outlives one turn: a timeout never loses a line, the next call gets it. */
class LineReader {
  private it: AsyncIterator<string>;
  private pending?: Promise<IteratorResult<string>>;

  constructor(lines: AsyncIterable<string>) {
    this.it = lines[Symbol.asyncIterator]();
  }

  /** The next line, undefined once the process is gone, or TIMEOUT when none came within `ms`. */
  async next(ms?: number): Promise<string | undefined | typeof TIMEOUT> {
    this.pending ??= this.it.next();
    let timer: NodeJS.Timeout | undefined;
    const r = ms === undefined ? await this.pending : await Promise.race([this.pending, new Promise<typeof TIMEOUT>((res) => (timer = setTimeout(() => res(TIMEOUT), ms)))]);
    clearTimeout(timer);
    if (r === TIMEOUT) return TIMEOUT;
    this.pending = undefined;
    return r.done ? undefined : r.value;
  }
}

/** The dialogs' processes waiting for their next turn: at most `max`, the one waiting longest closes first. */
class WarmPool {
  private waiting: ClaudeCodeSession[] = [];
  private max: number;

  constructor(max: number) {
    this.max = max;
  }

  rest(s: ClaudeCodeSession): void {
    this.take(s);
    this.waiting.push(s);
    while (this.waiting.length > this.max) this.waiting.shift()!.release();
  }

  take(s: ClaudeCodeSession): void {
    const i = this.waiting.indexOf(s);
    if (i >= 0) this.waiting.splice(i, 1);
  }
}

class ClaudeCodeSession implements BrainSessionImpl {
  private resumeId?: string;
  private child?: RunningProcess;
  private reader?: LineReader;
  /** This turn's messages so far: its input, then what steer() added (sent again if the turn has to start over). */
  private inputs: string[] = [];
  /** stdin is closed: the turn is ending and takes no more input. */
  private closing = false;
  private interrupted = false;
  /** A turn is in progress (send() has not finished). */
  private turning = false;
  private idle?: NodeJS.Timeout;
  /** The model and effort the running process thinks with. */
  private runs: { model?: string; effort?: string } = {};
  private o: BrainSessionOptions;
  private p: ClaudeCodeOptions;
  private dir: string;
  private caps: () => Promise<ClaudeCaps>;
  private pool: WarmPool;

  constructor(opts: BrainSessionOptions, p: ClaudeCodeOptions, caps: () => Promise<ClaudeCaps>, pool: WarmPool) {
    this.o = opts;
    this.p = p;
    this.caps = caps;
    this.pool = pool;
    this.resumeId = opts.resume;
    this.dir = join(p.stateDir, "sessions", opts.sessionId.replace(/[^\w-]/g, "_"));
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const [command, ...args] = opts.mcp.bridgeCommand.length ? opts.mcp.bridgeCommand : ["piomio-mcp-bridge"];
    const tokenFile = join(this.dir, "token");
    writePrivate(tokenFile, opts.mcp.token);
    writePrivate(
      join(this.dir, "mcp.json"),
      JSON.stringify({ mcpServers: { piomio: { type: "stdio", command, args, env: { PIOMIO_URL: opts.mcp.url, PIOMIO_TOKEN_FILE: tokenFile } } } }),
    );
    writePrivate(join(this.dir, "prompt.md"), opts.systemPrompt);
    if (opts.confine) writePrivate(join(this.dir, "settings.json"), JSON.stringify(sandboxSettings(opts.confine)));
  }

  private args(caps: ClaudeCaps): string[] {
    const confine = this.o.confine;
    // Confined: the shell runs in the sandbox, edits are accepted inside the workspace, and everything else (reading
    // the person's files, writing elsewhere, a command outside the sandbox) goes to the hub's permission tool. No bare
    // allow rule may open the file tools or Bash, or it would answer for the hub.
    const all = withHubTools(this.p.allowedTools?.() ?? DEFAULT_CLAUDE_TOOLS);
    const tools = (confine ? all.filter((x) => CONFINED_ALLOWED.test(x)) : all).filter((x) => !this.o.frontDesk || !FRONT_DESK_DENIED.includes(x));
    const mode = confine
      ? ["--permission-mode", "acceptEdits", "--permission-prompt-tool", `mcp__piomio__${confine.permissionTool}`, "--settings", join(this.dir, "settings.json")]
      : ["--permission-mode", "dontAsk"];
    const a = [
      "-p",
      "--input-format",
      "stream-json",
      "--replay-user-messages",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      ...mode,
      "--allowedTools",
      tools.join(","),
      "--strict-mcp-config",
      "--mcp-config",
      join(this.dir, "mcp.json"),
      "--append-system-prompt-file",
      join(this.dir, "prompt.md"),
    ];
    // A dialog's front desk only looks; commands and file changes are a task's (task_delegate).
    if (this.o.frontDesk) a.push("--disallowedTools", FRONT_DESK_DENIED.join(","));
    if (this.o.model) a.push("--model", this.o.model);
    if (this.o.effort && caps.efforts?.includes(this.o.effort)) a.push("--effort", this.o.effort);
    // A resumed conversation takes the agent's current instructions (they change with its profile and how it thinks).
    if (caps.snapshot) a.push("--system-prompt-snapshot", "off");
    if (this.resumeId) a.push("--resume", this.resumeId);
    for (const d of this.o.claudePluginDirs ?? []) a.push("--plugin-dir", d);
    return a;
  }

  /** The process is there and takes input. */
  private alive(): boolean {
    return !!this.child && this.child.child.exitCode === null && !this.closing;
  }

  /** A process waiting on stdin: the CLI does its start-up (settings, MCP servers) before the first message comes. */
  private async start(caps: ClaudeCaps): Promise<RunningProcess> {
    const env = childEnv(process.env, {
      ...this.o.env,
      ...(await this.p.authEnv?.()),
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
      // A permission question may wait for the person for minutes (tools/native-permission.ts).
      ...(this.o.confine ? { MCP_TOOL_TIMEOUT: String(15 * 60_000) } : {}),
    });
    const proc = runLines(this.p.command?.() ?? "claude", this.args(caps), { cwd: this.o.workspace, env, keepInput: true });
    this.child = proc;
    this.runs = { model: this.o.model, effort: this.o.effort && caps.efforts?.includes(this.o.effort) ? this.o.effort : undefined };
    this.reader = new LineReader(proc.lines);
    this.closing = false;
    void proc.exited.then(() => {
      if (this.child !== proc) return;
      this.child = undefined;
      this.reader = undefined;
      this.pool.take(this);
    });
    return proc;
  }

  async warm(): Promise<void> {
    if (!this.o.keepWarm || this.turning || this.alive()) return;
    const caps = await this.caps().catch((): ClaudeCaps => ({ snapshot: false }));
    if (this.turning || this.alive()) return;
    await this.start(caps);
    this.rest();
  }

  /**
   * A waiting process thinks with the model and effort it started with: when the session's changed since, it switches
   * (control requests on stdin, as the Agent SDK's setModel does), without starting over.
   */
  private switchTo(caps: ClaudeCaps): void {
    const proc = this.child;
    if (!proc) return;
    if (this.o.model && this.o.model !== this.runs.model) {
      proc.write(controlLine({ subtype: "set_model", model: this.o.model }));
      this.runs.model = this.o.model;
    }
    if (this.o.effort && this.o.effort !== this.runs.effort && caps.efforts?.includes(this.o.effort)) {
      proc.write(controlLine({ subtype: "apply_flag_settings", settings: { effortLevel: this.o.effort } }));
      this.runs.effort = this.o.effort;
    }
  }

  /** Between turns: the process waits for the next one, then closes. */
  private rest(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.release(), this.p.idleMs ?? IDLE_MS);
    this.idle.unref?.();
    this.pool.rest(this);
  }

  /** Let the waiting process go: stdin closes and the CLI exits. */
  release(): void {
    clearTimeout(this.idle);
    this.pool.take(this);
    if (this.turning) return;
    const proc = this.child;
    this.child = undefined;
    this.reader = undefined;
    if (!proc) return;
    proc.endInput();
    setTimeout(() => {
      if (proc.child.exitCode === null) proc.child.kill("SIGTERM");
    }, 10_000).unref();
  }

  async *send(turn: BrainTurn): AsyncGenerator<BrainEvent> {
    this.interrupted = false;
    this.inputs = [turn.text];
    this.turning = true;
    // The hub chose how this turn thinks: from here on the session thinks so (a waiting process switches below).
    if (turn.model) this.o = { ...this.o, model: turn.model };
    if (turn.effort) this.o = { ...this.o, effort: turn.effort };
    clearTimeout(this.idle);
    this.pool.take(this);
    let kept = false;
    try {
      const caps = await this.caps().catch((): ClaudeCaps => ({ snapshot: false }));
      for (let attempt = 0; attempt < 2; attempt++) {
        const t = brainsT(this.p.locale?.());
        const parser = new ClaudeStreamParser(t);
        // A dialog's process may be waiting already (warm, or the turn before); else it starts now.
        const proc = this.alive() ? this.child! : await this.start(caps);
        const reader = this.reader!;
        this.switchTo(caps);
        for (const text of this.inputs) proc.write(userLine(text));
        // The turn is over once a result comes and the CLI has taken every message. A dialog's process then waits for
        // the next turn; otherwise stdin closes and it exits. A message it has not taken yet gets its own answer right
        // after, in this process.
        let grace = false;
        const close = () => {
          this.closing = true;
          proc.endInput();
        };
        while (true) {
          const line = await reader.next(grace && !this.closing ? PENDING_INPUT_GRACE_MS : undefined);
          if (line === TIMEOUT) {
            close();
            continue;
          }
          if (line === undefined) break;
          if (!line.trim().startsWith("{")) continue;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          for (const ev of parser.push(msg)) yield ev;
          if (msg?.type === "result" && !this.closing) {
            if (parser.replays < this.inputs.length) grace = true;
            else if (this.o.keepWarm && !parser.resultError && !parser.limit && !this.interrupted) {
              kept = true;
              break;
            } else close();
          }
        }
        if (parser.sessionId) this.resumeId = parser.sessionId;
        if (kept) {
          yield { type: "done", resumeToken: this.resumeId };
          return;
        }
        this.closing = true;
        const exit = await proc.exited;
        if (this.child === proc) {
          this.child = undefined;
          this.reader = undefined;
        }
        if (this.interrupted) {
          yield { type: "done", resumeToken: this.resumeId };
          return;
        }
        if (parser.limit) {
          yield { type: "limit_hit", resetAt: parser.limit.resetAt, detail: parser.limit.detail };
          yield { type: "done", resumeToken: this.resumeId };
          return;
        }
        if (exit.code !== 0 || parser.resultError || !parser.sawResult) {
          const f = classifyClaudeFailure(proc.stderr(), parser.resultError, t);
          // The conversation is gone or too full to go on: a fresh one, which starts from the hub's recap when it sent one.
          if ((f.noSession || (f.full && turn.recap)) && attempt === 0 && this.resumeId) {
            this.p.log?.(`resume ${this.resumeId} ${f.noSession ? "not found" : "is full"}, starting a fresh Claude Code session${turn.recap ? " from the recap" : ""}`);
            this.resumeId = undefined;
            if (turn.recap) this.inputs = [`${turn.recap}\n\n---\n${this.inputs[0]}`, ...this.inputs.slice(1)];
            continue;
          }
          if (parser.resultError && exit.code === 0) yield { type: "error", message: parser.resultError };
          else yield { type: "error", message: f.message, fatal: f.fatal };
        }
        yield { type: "done", resumeToken: this.resumeId };
        return;
      }
    } finally {
      this.turning = false;
      if (kept && this.alive()) this.rest();
    }
  }

  steer(turn: BrainTurn): boolean {
    if (!this.turning || !this.child || this.closing || this.interrupted) return false;
    if (!this.child.write(userLine(turn.text))) return false;
    this.inputs.push(turn.text);
    return true;
  }

  interrupt(): void {
    if (!this.child) return;
    this.interrupted = true;
    const c = this.child.child;
    c.kill("SIGINT");
    setTimeout(() => {
      if (c.exitCode === null) c.kill("SIGKILL");
    }, 5000).unref();
  }

  close(): void {
    this.interrupt();
    this.release();
    try {
      rmSync(join(this.dir, "token"), { force: true });
    } catch {
      /* ignore */
    }
  }
}

function writePrivate(file: string, content: string): void {
  writeFileSync(file, content, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
}

export function createClaudeCodeProvider(p: ClaudeCodeOptions): BrainProviderImpl {
  const pool = new WarmPool(p.maxWarm ?? MAX_WARM);
  // What the installed CLI takes, read from its --help once per command and version.
  let caps: { key: string; caps: Promise<ClaudeCaps> } | undefined;
  const capsOf = (command: string, version: string, env: Record<string, string>): Promise<ClaudeCaps> => {
    const key = `${command}|${version}`;
    if (caps?.key !== key) caps = { key, caps: capture(command, ["--help"], env).then((h) => parseClaudeHelp(`${h.stdout}\n${h.stderr}`)) };
    return caps.caps;
  };
  const currentCaps = async (): Promise<ClaudeCaps> => {
    const command = p.command?.() ?? "claude";
    if (caps?.key.startsWith(`${command}|`)) return caps.caps;
    const env = childEnv(process.env, { DISABLE_AUTOUPDATER: "1" });
    const v = await capture(command, ["--version"], env);
    return v.code === 0 ? capsOf(command, v.stdout.trim().split(/\s+/)[0], env) : { snapshot: false };
  };
  return {
    id: "claude-code",
    label: brainsT()("claude.label"),
    async probe(): Promise<ProbeResult> {
      const t = brainsT(p.locale?.());
      const command = p.command?.() ?? "claude";
      const env = childEnv(process.env, { ...(await p.authEnv?.().catch(() => ({}))), DISABLE_AUTOUPDATER: "1" });
      const v = await capture(command, ["--version"], env);
      if (v.code !== 0) return { available: false, authenticated: false, detail: t("claude.notInstalledShort") };
      const version = v.stdout.trim().split(/\s+/)[0];
      const c = await capsOf(command, version, env).catch((): ClaudeCaps => ({ snapshot: false }));
      const thinking = { models: CLAUDE_MODELS, modelNames: CLAUDE_MODEL_NAMES, ...(c.efforts ? { efforts: c.efforts } : {}), presets: claudePresets(c.efforts) };
      if (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY) return { available: true, authenticated: true, version, ...thinking, detail: t("claude.vaultToken") };
      const s = await capture(command, ["auth", "status", "--json"], env);
      try {
        const j = JSON.parse(s.stdout);
        const method = `${j.authMethod ?? "ok"}${j.subscriptionType ? ` (${j.subscriptionType})` : ""}`;
        return { available: true, authenticated: !!j.loggedIn, version, ...thinking, detail: j.loggedIn ? t("claude.signedIn", { method }) : t("claude.noLogin") };
      } catch {
        return { available: true, authenticated: false, version, ...thinking, detail: t("claude.loginUnknown") };
      }
    },
    async createSession(opts: BrainSessionOptions): Promise<BrainSessionImpl> {
      return new ClaudeCodeSession(opts, p, currentCaps, pool);
    },
    // Browser sign-in to the subscription, kept in HOME like a terminal `/login`: the page shows a code to paste back.
    login({ env, onUpdate }) {
      const t = brainsT(p.locale?.());
      return runCliLogin({
        command: p.command?.() ?? "claude",
        args: ["auth", "login"],
        env: childEnv(process.env, { ...env, DISABLE_AUTOUPDATER: "1", NO_COLOR: "1" }),
        onUpdate,
        parse: parseClaudeBrowserLogin,
        timeoutMs: p.loginTimeoutMs ?? 15 * 60_000,
        t,
        notInstalled: t("claude.notInstalledShort"),
      });
    },
  };
}
