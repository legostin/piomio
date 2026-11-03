// Codex through `codex app-server` (JSON-RPC over stdio, one process per turn): thread/start or thread/resume, then
// turn/start; turn/steer adds the user's input to the turn in progress, which takes it at its next step.

import type { BrainEvent, BrainTurn } from "@piomio/shared";
import { EventQueue, runLines, type RunningProcess } from "./proc.ts";
import type { HubAnswer } from "./hub-permission.ts";

/** Codex's v2 notifications as BrainEvents. Pure: easy to test with recorded frames. */
export class CodexAppParser {
  limit?: { resetAt?: string; detail: string };
  failed?: string;
  auth = false;
  /** The thread no longer fits the model's context: it goes on as a fresh thread from the hub's recap. */
  full = false;
  completed = false;
  private streamed = new Set<string>();
  private input = 0;
  private output = 0;
  turnId?: string;

  push(method: string, p: any): BrainEvent[] {
    const out: BrainEvent[] = [];
    if (!p || typeof p !== "object") return out;
    switch (method) {
      case "item/agentMessage/delta":
        if (p.delta) {
          this.streamed.add(p.itemId);
          out.push({ type: "text", delta: String(p.delta) });
        }
        break;
      case "item/started": {
        const it = p.item ?? {};
        if (it.type === "mcpToolCall" || it.type === "dynamicToolCall") out.push({ type: "tool_call", id: it.id, name: it.tool ?? "tool", input: it.arguments ?? {} });
        if (it.type === "commandExecution") out.push({ type: "tool_call", id: it.id, name: "shell", input: { command: it.command } });
        if (it.type === "webSearch") out.push({ type: "tool_call", id: it.id, name: "WebSearch", input: { query: it.query ?? it.action?.query ?? "" } });
        if (it.type === "fileChange") out.push({ type: "tool_call", id: it.id, name: "apply_patch", input: { files: (it.changes ?? []).map((c: any) => c.path) } });
        break;
      }
      case "item/completed": {
        const it = p.item ?? {};
        if (it.type === "agentMessage") {
          if (!this.streamed.has(it.id) && it.text) out.push({ type: "text", delta: String(it.text) });
          out.push({ type: "text", delta: "\n" });
        }
        if (it.type === "mcpToolCall") {
          const text = it.result?.content ? it.result.content.map((c: any) => (c?.type === "text" ? c.text : `[${c?.type}]`)).join("\n") : (it.error?.message ?? "");
          out.push({ type: "tool_result", id: it.id, output: String(text), isError: it.status === "failed" || !!it.error });
        }
        if (it.type === "dynamicToolCall") {
          const text = (it.contentItems ?? []).map((c: any) => (c?.type === "inputText" || c?.type === "text" ? c.text : `[${c?.type}]`)).join("\n");
          out.push({ type: "tool_result", id: it.id, output: text, isError: it.success === false });
        }
        if (it.type === "commandExecution") out.push({ type: "tool_result", id: it.id, output: String(it.aggregatedOutput ?? ""), isError: typeof it.exitCode === "number" && it.exitCode !== 0 });
        if (it.type === "fileChange") out.push({ type: "tool_result", id: it.id, output: (it.changes ?? []).map((c: any) => `${c.kind?.type ?? c.kind} ${c.path}`).join("\n") });
        break;
      }
      case "thread/tokenUsage/updated": {
        const last = p.tokenUsage?.last;
        if (last) {
          this.input += last.inputTokens ?? 0;
          this.output += last.outputTokens ?? 0;
        }
        break;
      }
      case "error":
        if (!p.willRetry) this.fail(p.error);
        break;
      case "turn/completed": {
        if (this.turnId && p.turn?.id && p.turn.id !== this.turnId) break;
        this.completed = true;
        if (p.turn?.status === "failed") this.fail(p.turn.error);
        out.push({ type: "usage", inputTokens: this.input, outputTokens: this.output });
        break;
      }
    }
    return out;
  }

  private fail(err: any): void {
    const message = String(err?.message ?? "codex error");
    const info = err?.codexErrorInfo;
    const kind = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : "";
    if (kind === "usageLimitExceeded" || kind === "rateLimitExceeded" || /usage limit|rate limit|quota|limit reached/i.test(message)) {
      this.limit = { detail: message, resetAt: parseCodexReset(message) };
    } else {
      if (kind === "unauthorized") this.auth = true;
      if (kind === "contextWindowExceeded" || /context window|context length|maximum context/i.test(message)) this.full = true;
      this.failed ??= message;
    }
  }
}

/** A model as `model/list` describes it. */
export interface CodexModel {
  id: string;
  name: string;
  isDefault: boolean;
  efforts: string[];
  defaultEffort?: string;
  /** Codex's own words for it ("Frontier intelligence…", "Older fast and efficient model."). */
  description?: string;
  /** Codex points it to a newer model. */
  upgrade?: boolean;
  /** It takes images. */
  images?: boolean;
}

/** The models this Codex offers (app-server `model/list`), or undefined when it cannot say (old Codex, not signed in). */
export async function listCodexModels(command: string, env: Record<string, string>, cwd?: string, timeoutMs = 15_000): Promise<CodexModel[] | undefined> {
  const proc = runLines(command, ["app-server"], { cwd, env, keepInput: true });
  const write = (o: unknown) => proc.write(`${JSON.stringify(o)}\n`);
  const timer = setTimeout(() => proc.child.kill("SIGKILL"), timeoutMs);
  try {
    write({ id: 1, method: "initialize", params: { clientInfo: { name: "piomio", title: "Piomio", version: "1" }, capabilities: null } });
    write({ method: "initialized" });
    write({ id: 2, method: "model/list", params: {} });
    for await (const line of proc.lines) {
      if (!line.trim().startsWith("{")) continue;
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.id !== 2) continue;
      const data: any[] = Array.isArray(m.result?.data) ? m.result.data : [];
      const models = data
        .filter((x) => x && typeof x.id === "string" && !x.hidden)
        .map((x) => ({
          id: String(x.model ?? x.id),
          name: String(x.displayName || x.id),
          isDefault: !!x.isDefault,
          efforts: (x.supportedReasoningEfforts ?? []).map((e: any) => String(e?.reasoningEffort ?? e)).filter(Boolean),
          ...(x.defaultReasoningEffort ? { defaultEffort: String(x.defaultReasoningEffort) } : {}),
          ...(typeof x.description === "string" && x.description ? { description: x.description } : {}),
          ...(x.upgrade ? { upgrade: true } : {}),
          ...(Array.isArray(x.inputModalities) && x.inputModalities.includes("image") ? { images: true } : {}),
        }));
      return models.length ? models : undefined;
    }
    return undefined;
  } finally {
    clearTimeout(timer);
    proc.endInput();
    if (proc.child.exitCode === null) proc.child.kill("SIGTERM");
  }
}

/** "... try again in 2 hours 5 minutes" / "in 37 minutes" → ISO time. */
export function parseCodexReset(text: string, now = Date.now()): string | undefined {
  const re = /\bin\s+(?:(\d+)\s*(?:days?|d)\b)?\s*(?:(\d+)\s*(?:hours?|h)\b)?\s*(?:(\d+)\s*(?:minutes?|mins?|m)\b)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && !m[1] && !m[2] && !m[3]) if (m[0].length === 0) re.lastIndex++;
  if (!m) return undefined;
  const ms = ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 60_000;
  return new Date(now + ms).toISOString();
}

export interface AppServerSetup {
  command: string;
  /** `-c key=value` overrides, as for `codex exec`. */
  config: string[];
  cwd: string;
  env: Record<string, string>;
  model?: string;
  /** Reasoning effort for the turn (and the thread from then on). */
  effort?: string;
  sandbox: string;
  threadId?: string;
  /** Ask the hub about what the sandbox would not let through; without it every approval is declined. */
  ask?: (tool: string, input: Record<string, unknown>) => Promise<HubAnswer>;
  /** Networked tasks review commands even when they stay inside the sandbox. */
  approvalPolicy?: "never" | "on-request" | "untrusted";
  /** Thread settings in place of `sandbox`: a permission profile chosen by `-c default_permissions` (codex.ts). */
  profile?: boolean;
  /** A bare thread: kept nowhere, the hub's instructions in place of AGENTS.md (BrainSessionOptions.bare). */
  bare?: { instructions: string };
}

type Pending = { resolve: (v: any) => void; reject: (e: any) => void };

/**
 * The answer to one of Codex's approval requests, asking `ask` (the hub) what it is about. Codex's answers have no
 * room for why not: `denied` gets the hub's reason, for the turn to hear it otherwise.
 */
export async function approvalAnswer(method: string, params: Record<string, any>, ask?: (tool: string, input: Record<string, unknown>) => Promise<HubAnswer>, denied?: (why: string) => void): Promise<unknown> {
  const hub = async (tool: string, input: Record<string, unknown>): Promise<boolean> => {
    if (!ask) return false;
    const a = await ask(tool, input);
    if (!a.allow && a.message) denied?.(a.message);
    return a.allow;
  };
  const command = Array.isArray(params.command) ? params.command.join(" ") : typeof params.command === "string" ? params.command : "";
  const net = params.networkApprovalContext && typeof params.networkApprovalContext === "object" ? { host: params.networkApprovalContext.host } : undefined;
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const yes = await hub("codex.command", { command, cwd: params.cwd, reason: params.reason, ...(net ? { network: net } : {}) });
      return { decision: yes ? "accept" : "decline" };
    }
    case "item/fileChange/requestApproval": {
      const yes = await hub("codex.fileChange", { grantRoot: params.grantRoot, reason: params.reason });
      return { decision: yes ? "accept" : "decline" };
    }
    case "item/permissions/requestApproval": {
      const wanted = (params.permissions ?? {}) as { network?: unknown; fileSystem?: unknown };
      const yes = await hub("codex.permissions", { reason: params.reason, permissions: wanted });
      return { permissions: yes ? { ...(wanted.network ? { network: wanted.network } : {}), ...(wanted.fileSystem ? { fileSystem: wanted.fileSystem } : {}) } : {}, scope: "turn" };
    }
    case "execCommandApproval": {
      const yes = await hub("codex.command", { command, cwd: params.cwd, reason: params.reason });
      return { decision: yes ? "approved" : { denied: { rejection: "The person did not allow it." } } };
    }
    case "applyPatchApproval": {
      const yes = await hub("codex.fileChange", { grantRoot: params.grantRoot, reason: params.reason });
      return { decision: yes ? "approved" : { denied: { rejection: "The person did not allow it." } } };
    }
    default:
      return { decision: "decline" };
  }
}

/** The app-server could not start a turn at all (an old Codex without it): the caller uses `codex exec`. */
export class AppServerUnsupported extends Error {}

/**
 * One turn over a fresh `codex app-server`: yields BrainEvents until the turn completes. `steer()` adds input while it
 * runs. `threadId` is the thread to resume (or the one it started), for the next turn.
 */
export class CodexAppTurn {
  threadId?: string;
  readonly parser = new CodexAppParser();
  private proc?: RunningProcess;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private events = new EventQueue<BrainEvent>();
  private started = false;
  private finished = false;
  private s: AppServerSetup;

  constructor(s: AppServerSetup) {
    this.s = s;
    this.threadId = s.threadId;
  }

  private request<T = any>(method: string, params: unknown): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (!this.proc?.write(`${JSON.stringify({ id, method, params })}\n`)) {
        this.pending.delete(id);
        reject(new Error("codex app-server is not running"));
      }
    });
  }

  private notify(method: string): void {
    this.proc?.write(`${JSON.stringify({ method })}\n`);
  }

  private onLine(line: string): void {
    if (!line.trim().startsWith("{")) return;
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && !m.method) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p?.reject(Object.assign(new Error(String(m.error.message ?? "error")), { rpc: m.error }));
      else p?.resolve(m.result);
      return;
    }
    if (m.id !== undefined && m.method) {
      const approval = /requestApproval|Approval$/.test(m.method);
      if (!approval) {
        this.proc?.write(`${JSON.stringify({ id: m.id, error: { code: -32601, message: "not supported by Piomio" } })}\n`);
        return;
      }
      // Confined, the hub decides (and may ask the person); otherwise approval_policy is "never" and this is a no.
      let why: string | undefined;
      void approvalAnswer(m.method, m.params ?? {}, this.s.ask, (w) => (why = w)).then((result) => {
        this.proc?.write(`${JSON.stringify({ id: m.id, result })}\n`);
        // The reason joins the turn as the next thing the agent reads.
        if (why) void this.steer({ text: `[System] ${why}` });
      });
      return;
    }
    if (m.method === "thread/started" && m.params?.thread?.id) this.threadId = m.params.thread.id;
    for (const e of this.parser.push(m.method, m.params)) this.events.push(e);
    if (m.method === "turn/completed" && this.parser.completed) this.finish();
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.events.end();
  }

  private input(turn: BrainTurn): unknown[] {
    const items: unknown[] = [{ type: "text", text: turn.text, text_elements: [] }];
    for (const a of turn.attachments ?? []) if (/\.(png|jpe?g|gif|webp)$/i.test(a)) items.push({ type: "localImage", path: a });
    return items;
  }

  /** Throws AppServerUnsupported when this Codex has no app-server (nothing has been sent to the model then). */
  async *run(turn: BrainTurn): AsyncGenerator<BrainEvent> {
    const args = ["app-server"];
    for (const c of this.s.config) args.push("-c", c);
    const proc = runLines(this.s.command, args, { cwd: this.s.cwd, env: this.s.env, keepInput: true });
    this.proc = proc;
    const reading = (async () => {
      for await (const line of proc.lines) this.onLine(line);
      for (const p of this.pending.values()) p.reject(new Error("codex app-server exited"));
      this.pending.clear();
      this.finish();
    })();
    try {
      try {
        await this.request("initialize", { clientInfo: { name: "piomio", title: "Piomio", version: "1" }, capabilities: null });
      } catch {
        const exit = await Promise.race([proc.exited, new Promise<null>((r) => setTimeout(() => r(null), 2000))]);
        throw new AppServerUnsupported(exit ? proc.stderr().trim().split("\n").slice(-3).join("\n") : "codex app-server did not answer");
      }
      this.notify("initialized");
      // A `sandbox` here would win over the permission profile the config chose.
      const thread = {
        cwd: this.s.cwd,
        approvalPolicy: this.s.approvalPolicy ?? (this.s.ask ? "on-request" : "never"),
        ...(this.s.profile ? {} : { sandbox: this.s.sandbox }),
        ...(this.s.model ? { model: this.s.model } : {}),
        ...(this.s.bare ? { ephemeral: true, baseInstructions: this.s.bare.instructions } : {}),
      };
      let r: any;
      if (this.threadId) r = await this.request("thread/resume", { threadId: this.threadId, ...thread }).catch(() => undefined);
      // The thread to resume is gone: a fresh one, which starts from the hub's recap when it sent one.
      if (!r && this.threadId && turn.recap) turn = { ...turn, text: `${turn.recap}\n\n---\n${turn.text}` };
      if (!r) r = await this.request("thread/start", thread);
      this.threadId = r?.thread?.id ?? this.threadId;
      // The profile closes what no agent may read; a Codex that ran without it would see the whole computer.
      if (this.s.profile && r?.sandbox?.type === "dangerFullAccess") throw new Error("Codex did not take the hub's permission profile: the turn was not started");
      // The model the thread answers with (its default when none was asked for).
      const model = typeof r?.model === "string" && r.model ? r.model : this.s.model;
      if (model) this.events.push({ type: "model", model });
      const t = await this.request("turn/start", { threadId: this.threadId, input: this.input(turn), ...(this.s.effort ? { effort: this.s.effort } : {}) });
      this.parser.turnId = t?.turn?.id;
      this.started = true;
    } catch (e) {
      if (e instanceof AppServerUnsupported) {
        proc.child.kill("SIGKILL");
        throw e;
      }
      this.events.push({ type: "error", message: String((e as Error)?.message ?? e), fatal: true });
      this.finish();
    }
    for await (const e of this.events) yield e;
    this.started = false;
    proc.endInput();
    const exited = await Promise.race([proc.exited, new Promise<null>((r) => setTimeout(() => r(null), 3000).unref())]);
    if (!exited) proc.child.kill("SIGKILL");
    await reading.catch(() => {});
  }

  /** stderr so far, for failures people read. */
  stderr(): string {
    return this.proc?.stderr() ?? "";
  }

  /** Add input to the turn in progress; false when there is none (or Codex refused it). */
  async steer(turn: BrainTurn): Promise<boolean> {
    const turnId = this.parser.turnId;
    if (!this.started || this.finished || !turnId || !this.threadId) return false;
    try {
      await this.request("turn/steer", { threadId: this.threadId, expectedTurnId: turnId, input: this.input(turn) });
      return true;
    } catch {
      return false;
    }
  }

  async interrupt(): Promise<void> {
    const turnId = this.parser.turnId;
    if (this.started && turnId && this.threadId) {
      await Promise.race([this.request("turn/interrupt", { threadId: this.threadId, turnId }).catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    }
    const c = this.proc?.child;
    if (!c || c.exitCode !== null) return;
    c.kill("SIGINT");
    setTimeout(() => {
      if (c.exitCode === null) c.kill("SIGKILL");
    }, 5000).unref();
  }
}
