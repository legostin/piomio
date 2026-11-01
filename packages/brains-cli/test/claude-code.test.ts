import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainEvent, BrainSessionOptions } from "@piomio/shared";
import { claudePresets, ClaudeStreamParser, codexThinking, createClaudeCodeProvider, createCodexProvider, CodexStreamParser, listCodexModels, parseClaudeHelp, parseCodexReset } from "../src/index.ts";
import { approvalAnswer } from "../src/codex-app.ts";
import { askHub } from "../src/hub-permission.ts";

const fake = join(import.meta.dirname, "fixtures", "fake-claude.mjs");

function opts(over: Partial<BrainSessionOptions> = {}): BrainSessionOptions {
  return {
    sessionId: "s_" + Math.random().toString(36).slice(2),
    agent: {} as any,
    workspace: mkdtempSync(join(tmpdir(), "owl-cc-ws-")),
    mcp: { url: "http://127.0.0.1:1/mcp", token: "tok-secret", bridgeCommand: ["node", "bridge.ts"] },
    systemPrompt: "SYSTEM",
    env: {},
    background: false,
    ...over,
  };
}

async function collect(it: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("ClaudeStreamParser", () => {
  it("says once which model answers, not the stand-in of its own error messages", () => {
    const p = new ClaudeStreamParser();
    expect(p.push({ type: "assistant", message: { id: "a", model: "<synthetic>", content: [] }, parent_tool_use_id: null })).toEqual([]);
    expect(p.push({ type: "assistant", message: { id: "b", model: "claude-haiku-5-5", content: [] }, parent_tool_use_id: null })).toEqual([{ type: "model", model: "claude-haiku-5-5" }]);
    expect(p.push({ type: "assistant", message: { id: "c", model: "claude-haiku-5-5", content: [] }, parent_tool_use_id: null })).toEqual([]);
    expect(p.push({ type: "assistant", message: { id: "d", model: "claude-opus-5-5", content: [] }, parent_tool_use_id: "t1" })).toEqual([]);
  });

  it("streams text once, maps tools, skips subagent output", () => {
    const p = new ClaudeStreamParser();
    const ev = [
      ...p.push({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }, parent_tool_use_id: null, api_message_id: "m1" }),
      ...p.push({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "t", name: "mcp__piomio__memory_search", input: { q: 1 } }] }, parent_tool_use_id: null }),
      ...p.push({ type: "assistant", message: { id: "m9", content: [{ type: "text", text: "inner" }] }, parent_tool_use_id: "t" }),
    ];
    expect(ev).toEqual([
      { type: "text", delta: "hi" },
      { type: "tool_call", id: "t", name: "memory_search", input: { q: 1 } },
    ]);
  });

  it("detects subscription limits", () => {
    const p = new ClaudeStreamParser();
    p.push({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1893456000, rateLimitType: "five_hour" } });
    expect(p.limit?.resetAt).toBe(new Date(1893456000 * 1000).toISOString());
  });
});

describe("Claude Code provider (fake CLI)", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "owl-cc-state-"));
  const provider = createClaudeCodeProvider({ command: () => fake, stateDir });

  it("probes version and login", async () => {
    const r = await provider.probe();
    expect(r.available).toBe(true);
    expect(r.version).toBe("9.9.9");
  });

  it("runs turns, resumes, and keeps the MCP token out of args", async () => {
    const o = opts({ model: "sonnet" });
    const s = await provider.createSession(o);
    const first = await collect(s.send({ text: "ping" }));
    expect(first.filter((e) => e.type === "text").map((e: any) => e.delta).join("")).toBe("echo:pingresume=none model=sonnet");
    expect(first).toContainEqual({ type: "tool_call", id: "tu1", name: "notify", input: { level: "silent", title: "x" } });
    expect(first).toContainEqual({ type: "tool_result", id: "tu1", output: "ok", isError: false });
    expect(first).toContainEqual({ type: "usage", inputTokens: 15, outputTokens: 3, costUsd: 0.01 });
    expect(first.at(-1)).toEqual({ type: "done", resumeToken: "sess-1" });
    const second = await collect(s.send({ text: "again" }));
    expect(second.some((e) => e.type === "text" && e.delta.includes("resume=sess-1"))).toBe(true);
    const mcp = readFileSync(join(stateDir, "sessions", o.sessionId, "mcp.json"), "utf8");
    expect(mcp).not.toContain("tok-secret");
    expect(readFileSync(join(stateDir, "sessions", o.sessionId, "prompt.md"), "utf8")).toBe("SYSTEM");
  });

  it("starts fresh when the resume id is gone", async () => {
    const s = await provider.createSession(opts({ resume: "missing" }));
    const ev = await collect(s.send({ text: "x" }));
    expect(ev.some((e) => e.type === "error")).toBe(false);
    expect(ev.at(-1)).toEqual({ type: "done", resumeToken: "sess-1" });
  });

  it("takes more input while a turn runs: at the next step, or as its own answer right after", async () => {
    const s = await provider.createSession(opts());
    const joined = s.send({ text: "go SLOW" });
    const later = setTimeout(() => expect(s.steer?.({ text: "and this" })).toBe(true), 100);
    const ev = await collect(joined);
    clearTimeout(later);
    const text = ev.filter((e) => e.type === "text").map((e: any) => e.delta).join("");
    expect(text).toBe("slow done also:and this");
    expect(ev.filter((e) => e.type === "done")).toHaveLength(1);
    // Over: nothing to join, the hub sends it as the next turn.
    expect(s.steer?.({ text: "too late" })).toBe(false);

    const own = s.send({ text: "x LATE" });
    setTimeout(() => s.steer?.({ text: "more" }), 100);
    const ev2 = await collect(own);
    const text2 = ev2.filter((e) => e.type === "text").map((e: any) => e.delta).join("");
    expect(text2).toMatch(/^late done.*echo:more/);
    expect(ev2.filter((e) => e.type === "usage")).toHaveLength(2);
  });

  it("reports limit_hit", async () => {
    const s = await provider.createSession(opts());
    const ev = await collect(s.send({ text: "LIMIT" }));
    expect(ev).toContainEqual({ type: "limit_hit", resetAt: new Date(1893456000 * 1000).toISOString(), detail: "Claude: subscription limit (five_hour)" });
  });

  it("reports a missing CLI as a fatal error", async () => {
    const p = createClaudeCodeProvider({ command: () => "definitely-not-a-claude-binary", stateDir });
    expect((await p.probe()).available).toBe(false);
    const s = await p.createSession(opts());
    const ev = await collect(s.send({ text: "x" }));
    expect(ev.find((e) => e.type === "error")).toMatchObject({ fatal: true });
  });

  it("speaks the language it is given", async () => {
    const missing = { command: () => "definitely-not-a-claude-binary", stateDir };
    expect((await createClaudeCodeProvider(missing).probe()).detail).toBe("Claude Code is not installed");
    expect((await createClaudeCodeProvider({ ...missing, locale: () => "ru" }).probe()).detail).toBe("Claude Code не установлен");
  });

  it("offers its model aliases and the efforts its --help lists, with presets on them", async () => {
    const r = await provider.probe();
    expect(r.models).toEqual(["fable", "opus", "sonnet", "haiku"]);
    expect(r.modelNames?.opus).toBe("Opus");
    expect(r.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(r.presets).toEqual({ fast: { model: "sonnet", effort: "low" }, balanced: { model: "opus", effort: "medium" }, deep: { model: "opus", effort: "xhigh" } });
  });

  it("reads --effort and --system-prompt-snapshot from the help of the installed CLI", () => {
    expect(parseClaudeHelp("  --effort <level>   Effort level\n                    (low, medium, high)\n  --model <m>  x")).toEqual({ efforts: ["low", "medium", "high"], snapshot: false });
    expect(parseClaudeHelp("  --model <m>  x\n  --system-prompt-snapshot <on|off>  y")).toEqual({ snapshot: true });
    // An old CLI without --effort: presets name a model only.
    expect(claudePresets(undefined).deep).toEqual({ model: "opus" });
  });

  it("thinks with the model and effort it is given, and takes the current instructions on resume", async () => {
    const argsFile = join(mkdtempSync(join(tmpdir(), "owl-cc-args-")), "args.jsonl");
    const s = await provider.createSession(opts({ model: "opus", effort: "high", resume: "sess-9", env: { FAKE_ARGS_FILE: argsFile } }));
    const ev = await collect(s.send({ text: "hi" }));
    expect(ev.filter((e) => e.type === "text").map((e: any) => e.delta).join("")).toBe("echo:hiresume=sess-9 model=opus effort=high");
    const args = JSON.parse(readFileSync(argsFile, "utf8").trim().split("\n")[0]) as string[];
    expect(args.slice(args.indexOf("--system-prompt-snapshot"), args.indexOf("--system-prompt-snapshot") + 2)).toEqual(["--system-prompt-snapshot", "off"]);
    // An effort the CLI does not take is not passed.
    const t = await provider.createSession(opts({ effort: "ultra" }));
    expect((await collect(t.send({ text: "x" }))).filter((e) => e.type === "text").map((e: any) => e.delta).join("")).toBe("echo:xresume=none model=default");
  });

  it("goes on from the hub's recap when the conversation is gone or too full", async () => {
    for (const resume of ["missing", "full"]) {
      const s = await provider.createSession(opts({ resume }));
      const ev = await collect(s.send({ text: "and now?", recap: "RECAP: we chose Lisbon" }));
      expect(ev.some((e) => e.type === "error")).toBe(false);
      const text = ev.filter((e) => e.type === "text").map((e: any) => e.delta).join("");
      expect(text).toBe("echo:RECAP: we chose Lisbon\n\n---\nand now?resume=none model=default");
      expect(ev.at(-1)).toEqual({ type: "done", resumeToken: "sess-1" });
    }
    // Too full and no recap: an error, not a blank start.
    const s = await provider.createSession(opts({ resume: "full" }));
    const ev = await collect(s.send({ text: "x" }));
    expect(ev.find((e) => e.type === "error")).toMatchObject({ message: expect.stringContaining("Prompt is too long") });
  });
});

describe("a dialog's warm process (keepWarm)", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "owl-cc-warm-"));
  const text = (ev: BrainEvent[]) => ev.filter((e) => e.type === "text").map((e: any) => e.delta).join("");
  /** How many processes a session started so far (the fake CLI writes its arguments once per run). */
  const runs = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length : 0);
  const argsFile = () => join(mkdtempSync(join(tmpdir(), "owl-cc-args-")), "args.jsonl");
  /** A process just started writes its arguments a moment later. */
  const started = async (file: string, n: number) => {
    for (let i = 0; i < 100 && runs(file) < n; i++) await new Promise((r) => setTimeout(r, 20));
    return runs(file);
  };

  it("keeps one process for the dialog's turns, started ahead with warm()", async () => {
    const provider = createClaudeCodeProvider({ command: () => fake, stateDir });
    const file = argsFile();
    const s = await provider.createSession(opts({ keepWarm: true, env: { FAKE_ARGS_FILE: file } }));
    await s.warm?.();
    expect(await started(file, 1)).toBe(1);
    expect(text(await collect(s.send({ text: "one" })))).toBe("echo:oneresume=none model=default");
    // The same process answers again: it was started without --resume and stays the conversation sess-1.
    const second = await collect(s.send({ text: "two" }));
    expect(text(second)).toBe("echo:tworesume=none model=default");
    expect(second.at(-1)).toEqual({ type: "done", resumeToken: "sess-1" });
    expect(runs(file)).toBe(1);
    // Steering still joins a turn in progress, and an idle process takes none.
    const slow = s.send({ text: "go SLOW" });
    const later = setTimeout(() => expect(s.steer?.({ text: "and this" })).toBe(true), 100);
    expect(text(await collect(slow))).toBe("slow done also:and this");
    clearTimeout(later);
    expect(s.steer?.({ text: "idle" })).toBe(false);
    expect(runs(file)).toBe(1);
    await s.close();
  });

  it("thinks each turn with the model and effort the hub chose, switching in the same process", async () => {
    const provider = createClaudeCodeProvider({ command: () => fake, stateDir });
    const file = argsFile();
    const s = await provider.createSession(opts({ keepWarm: true, model: "sonnet", effort: "low", env: { FAKE_ARGS_FILE: file } }));
    expect(text(await collect(s.send({ text: "hi" })))).toBe("echo:hiresume=none model=sonnet effort=low");
    expect(text(await collect(s.send({ text: "thanks", model: "haiku" })))).toBe("echo:thanksresume=none model=haiku effort=low");
    expect(text(await collect(s.send({ text: "think", model: "opus", effort: "xhigh" })))).toBe("echo:thinkresume=none model=opus effort=xhigh");
    // An effort the CLI does not take is not sent; the model stays as it was when none is given.
    expect(text(await collect(s.send({ text: "again", effort: "ultra" })))).toBe("echo:againresume=none model=opus effort=xhigh");
    expect(runs(file)).toBe(1);
    await s.close();
    // A new process starts with what the session thinks now.
    const t = await provider.createSession(opts({ model: "sonnet" }));
    expect(text(await collect(t.send({ text: "x", model: "haiku", effort: "high" })))).toBe("echo:xresume=none model=haiku effort=high");
  });

  it("closes a process that waited too long, and the next turn resumes in a new one", async () => {
    const provider = createClaudeCodeProvider({ command: () => fake, stateDir, idleMs: 150 });
    const file = argsFile();
    const s = await provider.createSession(opts({ keepWarm: true, env: { FAKE_ARGS_FILE: file } }));
    await collect(s.send({ text: "one" }));
    await new Promise((r) => setTimeout(r, 500));
    expect(text(await collect(s.send({ text: "two" })))).toBe("echo:tworesume=sess-1 model=default");
    expect(runs(file)).toBe(2);
    await s.close();
  });

  it("keeps at most maxWarm processes waiting: the one waiting longest closes first", async () => {
    const provider = createClaudeCodeProvider({ command: () => fake, stateDir, maxWarm: 1 });
    const [fa, fb] = [argsFile(), argsFile()];
    const a = await provider.createSession(opts({ keepWarm: true, env: { FAKE_ARGS_FILE: fa } }));
    const b = await provider.createSession(opts({ keepWarm: true, env: { FAKE_ARGS_FILE: fb } }));
    await collect(a.send({ text: "a1" }));
    await collect(b.send({ text: "b1" }));
    expect(text(await collect(b.send({ text: "b2" })))).toContain("resume=none");
    expect(text(await collect(a.send({ text: "a2" })))).toContain("resume=sess-1");
    expect([runs(fa), runs(fb)]).toEqual([2, 1]);
    await Promise.all([a.close(), b.close()]);
  });

  it("a task's process still ends with its turn", async () => {
    const provider = createClaudeCodeProvider({ command: () => fake, stateDir });
    const file = argsFile();
    const s = await provider.createSession(opts({ env: { FAKE_ARGS_FILE: file } }));
    await s.warm?.();
    expect(runs(file)).toBe(0);
    await collect(s.send({ text: "one" }));
    expect(text(await collect(s.send({ text: "two" })))).toContain("resume=sess-1");
    expect(runs(file)).toBe(2);
  });
});

describe("CodexStreamParser", () => {
  it("maps codex exec --json events", () => {
    const p = new CodexStreamParser();
    const ev = [
      ...p.push({ type: "thread.started", thread_id: "th1" }),
      ...p.push({ type: "item.started", item: { id: "i1", type: "mcp_tool_call", server: "piomio", tool: "notify", arguments: { title: "x" } } }),
      ...p.push({ type: "item.completed", item: { id: "i1", type: "mcp_tool_call", status: "completed", result: { content: [{ type: "text", text: "ok" }] } } }),
      ...p.push({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "Готово" } }),
      ...p.push({ type: "turn.completed", usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 2 } }),
    ];
    expect(p.threadId).toBe("th1");
    expect(ev).toEqual([
      { type: "tool_call", id: "i1", name: "notify", input: { title: "x" } },
      { type: "tool_result", id: "i1", output: "ok", isError: false },
      { type: "text", delta: "Готово\n" },
      { type: "usage", inputTokens: 6, outputTokens: 2 },
    ]);
  });

  it("parses limit reset hints", () => {
    const now = Date.parse("2026-10-26T10:00:00Z");
    expect(parseCodexReset("You have hit your usage limit. Try again in 2 hours 5 minutes.", now)).toBe("2026-10-26T12:05:00.000Z");
    const p = new CodexStreamParser();
    p.push({ type: "turn.failed", error: { message: "usage limit reached, try again in 30 minutes" } });
    expect(p.limit).toBeTruthy();
  });
});

describe("Codex provider (fake CLI)", () => {
  const fakeCodex = join(import.meta.dirname, "fixtures", "fake-codex.mjs");
  const stateDir = mkdtempSync(join(tmpdir(), "owl-cx-state-"));
  const provider = createCodexProvider({ command: () => fakeCodex, stateDir, sandbox: () => "workspace-write" });
  const text = (ev: BrainEvent[]) => ev.filter((e) => e.type === "text").map((e: any) => e.delta).join("");

  it("says which model the thread answers with", async () => {
    const s = await provider.createSession(opts({ model: "gpt-x" }));
    const ev = await collect(s.send({ text: "hi" }));
    expect(ev).toContainEqual({ type: "model", model: "gpt-x" });
  });

  it("runs turns through the app server and resumes the thread", async () => {
    const s = await provider.createSession(opts({ model: "gpt-x" }));
    const first = await collect(s.send({ text: "ping" }));
    expect(text(first)).toMatch(/^echo:ping\nthread=th-\d+ model=gpt-x\n$/);
    expect(first).toContainEqual({ type: "tool_call", id: "m1", name: "notify", input: { title: "x" } });
    expect(first).toContainEqual({ type: "tool_result", id: "m1", output: "ok", isError: false });
    expect(first).toContainEqual({ type: "usage", inputTokens: 7, outputTokens: 2 });
    const thread = (first.at(-1) as any).resumeToken;
    expect(thread).toMatch(/^th-/);
    const second = await collect(s.send({ text: "again" }));
    expect(text(second)).toContain(`thread=${thread}`);
  });

  it("takes more input into the turn in progress (turn/steer)", async () => {
    const s = await provider.createSession(opts());
    const ev: BrainEvent[] = [];
    let steered: Promise<boolean | undefined> | undefined;
    for await (const e of s.send({ text: "go SLOW" })) {
      ev.push(e);
      // The command is running: the input joins the turn.
      if (e.type === "tool_call" && !steered) steered = Promise.resolve(s.steer?.({ text: "and this" }));
    }
    expect(await steered).toBe(true);
    expect(text(ev)).toBe("slow done also:and this\n");
    expect(await s.steer?.({ text: "too late" })).toBe(false);
  });

  it("reports the subscription limit", async () => {
    const s = await provider.createSession(opts());
    const ev = await collect(s.send({ text: "LIMIT" }));
    expect(ev.find((e) => e.type === "limit_hit")).toMatchObject({ detail: expect.stringContaining("usage limit") });
  });

  it("thinks with the effort it is given", async () => {
    const s = await provider.createSession(opts({ model: "gpt-main", effort: "high" }));
    expect(text(await collect(s.send({ text: "ping" })))).toMatch(/model=gpt-main effort=high\n$/);
  });

  it("lists its own models and puts the presets on the default one", async () => {
    const models = await listCodexModels(fakeCodex, { ...process.env } as Record<string, string>);
    expect(models?.map((m) => m.id)).toEqual(["gpt-fast", "gpt-main"]);
    const th = codexThinking(models);
    expect(th.model).toBe("gpt-main");
    expect(th.modelNames).toEqual({ "gpt-fast": "GPT Fast", "gpt-main": "GPT Main" });
    expect(th.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(th.presets).toEqual({ fast: { model: "gpt-main", effort: "low" }, balanced: { model: "gpt-main", effort: "medium" }, deep: { model: "gpt-main", effort: "xhigh" } });
    // A Codex that cannot list them: efforts only.
    expect(codexThinking(undefined).presets?.deep).toEqual({ effort: "high" });
  });

  it("goes on in a fresh thread from the hub's recap when the thread is gone or too full", async () => {
    const gone = await provider.createSession(opts({ resume: "missing" }));
    expect(text(await collect(gone.send({ text: "next", recap: "RECAP" })))).toMatch(/^echo:RECAP\n\n---\nnext\n/);
    const s = await provider.createSession(opts());
    const first = await collect(s.send({ text: "hi" }));
    const thread = (first.at(-1) as any).resumeToken;
    const ev = await collect(s.send({ text: "go on FULL", recap: "RECAP" }));
    expect(ev.some((e) => e.type === "error")).toBe(false);
    expect(text(ev)).toMatch(/^echo:RECAP\n\n---\ngo on FULL\n/);
    expect((ev.at(-1) as any).resumeToken).not.toBe(thread);
  });

  it("falls back to codex exec without an app server, and cannot steer there", async () => {
    const old = process.env.FAKE_CODEX_NO_APP;
    process.env.FAKE_CODEX_NO_APP = "1";
    try {
      const s = await provider.createSession(opts());
      const ev = await collect(s.send({ text: "hello" }));
      expect(text(ev)).toBe("exec:hello\n");
      expect(ev.at(-1)).toEqual({ type: "done", resumeToken: "th-exec" });
      expect(await s.steer?.({ text: "x" })).toBe(false);
    } finally {
      if (old === undefined) delete process.env.FAKE_CODEX_NO_APP;
      else process.env.FAKE_CODEX_NO_APP = old;
    }
  });
});

describe("confined brains (BrainSessionOptions.confine)", () => {
  const confine = { denyRead: ["/Users/x/.ssh", "/data"], allowRead: ["/data/workspaces/a"], permissionTool: "native_permission" };

  it("Claude Code runs its shell in the sandbox and asks the hub for the rest; no bare rule opens files or Bash", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "owl-cc-state-"));
    const provider = createClaudeCodeProvider({ command: () => fake, stateDir });
    const argsFile = join(mkdtempSync(join(tmpdir(), "owl-cc-args-")), "args.jsonl");
    const s = await provider.createSession(opts({ confine, env: { FAKE_ARGS_FILE: argsFile } }));
    await collect(s.send({ text: "hi" }));
    const args = JSON.parse(readFileSync(argsFile, "utf8").trim().split("\n")[0]) as string[];
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(after("--permission-mode")).toBe("acceptEdits");
    expect(after("--permission-prompt-tool")).toBe("mcp__piomio__native_permission");
    expect(after("--allowedTools").split(",")).toEqual(["WebFetch", "WebSearch", "TodoWrite", "Task", "Skill", "mcp__piomio"]);
    const settings = JSON.parse(readFileSync(after("--settings"), "utf8"));
    expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: true, filesystem: { denyRead: confine.denyRead, allowRead: confine.allowRead }, network: { allowedDomains: [] } });
    // Unconfined, as before.
    const plainArgs = join(mkdtempSync(join(tmpdir(), "owl-cc-args-")), "args.jsonl");
    await collect((await provider.createSession(opts({ env: { FAKE_ARGS_FILE: plainArgs } }))).send({ text: "hi" }));
    const plain = JSON.parse(readFileSync(plainArgs, "utf8").trim().split("\n")[0]) as string[];
    expect(plain[plain.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(plain).not.toContain("--permission-prompt-tool");
  });

  it("a dialog's front desk only looks: no shell or file changes of its own, nothing to ask for", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "owl-cc-state-"));
    const claude = createClaudeCodeProvider({ command: () => fake, stateDir });
    const argsFile = join(mkdtempSync(join(tmpdir(), "owl-cc-args-")), "args.jsonl");
    await collect((await claude.createSession(opts({ confine, frontDesk: true, env: { FAKE_ARGS_FILE: argsFile } }))).send({ text: "hi" }));
    const args = JSON.parse(readFileSync(argsFile, "utf8").trim().split("\n")[0]) as string[];
    expect(args[args.indexOf("--disallowedTools") + 1].split(",")).toEqual(expect.arrayContaining(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]));
    const plain = createClaudeCodeProvider({ command: () => fake, stateDir, allowedTools: () => ["Bash", "Read", "WebSearch", "mcp__piomio"] });
    const plainFile = join(mkdtempSync(join(tmpdir(), "owl-cc-args-")), "args.jsonl");
    await collect((await plain.createSession(opts({ frontDesk: true, env: { FAKE_ARGS_FILE: plainFile } }))).send({ text: "hi" }));
    const pa = JSON.parse(readFileSync(plainFile, "utf8").trim().split("\n")[0]) as string[];
    expect(pa[pa.indexOf("--allowedTools") + 1]).toBe("Read,WebSearch,mcp__piomio");
  });

  it("the hub's own tools stay allowed, also with a list saved before the rename or one without them", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "owl-cc-state-"));
    const allowed = async (tools: string[]) => {
      const claude = createClaudeCodeProvider({ command: () => fake, stateDir, allowedTools: () => tools });
      const file = join(mkdtempSync(join(tmpdir(), "owl-cc-args-")), "args.jsonl");
      await collect((await claude.createSession(opts({ env: { FAKE_ARGS_FILE: file } }))).send({ text: "hi" }));
      const args = JSON.parse(readFileSync(file, "utf8").trim().split("\n")[0]) as string[];
      return args[args.indexOf("--allowedTools") + 1];
    };
    // A node's policy.json from the Owlbot days: don't-ask mode denied every hub tool.
    expect(await allowed(["Read", "Glob", "mcp__owlbot"])).toBe("Read,Glob,mcp__piomio");
    expect(await allowed(["Read"])).toBe("Read,mcp__piomio");
    expect(await allowed(["mcp__piomio", "Read"])).toBe("mcp__piomio,Read");

    const codex = createCodexProvider({ command: () => join(import.meta.dirname, "fixtures", "fake-codex.mjs"), stateDir, sandbox: () => "workspace-write" });
    const codexFile = join(mkdtempSync(join(tmpdir(), "owl-cx-args-")), "args.jsonl");
    await collect((await codex.createSession(opts({ confine, frontDesk: true, env: { FAKE_ARGS_FILE: codexFile } }))).send({ text: "hi" }));
    const started = JSON.parse(readFileSync(codexFile, "utf8").trim().split("\n")[0]);
    expect(started).toMatchObject({ sandbox: "read-only", approvalPolicy: "never" });
    expect(started.args).toContain('sandbox_mode="read-only"');
    expect(started.args).toContain('approval_policy="never"');
  });

  it("Codex asks the hub about what its sandbox would not let through, in each request's own answer format", async () => {
    const asked: Array<[string, unknown]> = [];
    const ask = (yes: boolean) => async (tool: string, input: Record<string, unknown>) => (asked.push([tool, input]), yes);
    expect(await approvalAnswer("item/commandExecution/requestApproval", { command: "curl https://x.io", cwd: "/w", reason: "net", networkApprovalContext: { host: "x.io", protocol: "https" } }, ask(true))).toEqual({ decision: "accept" });
    expect(asked[0]).toEqual(["codex.command", { command: "curl https://x.io", cwd: "/w", reason: "net", network: { host: "x.io" } }]);
    expect(await approvalAnswer("item/fileChange/requestApproval", { grantRoot: "/etc" }, ask(false))).toEqual({ decision: "decline" });
    expect(await approvalAnswer("item/permissions/requestApproval", { permissions: { network: { enabled: true }, fileSystem: null } }, ask(true))).toEqual({ permissions: { network: { enabled: true } }, scope: "turn" });
    expect(await approvalAnswer("item/permissions/requestApproval", { permissions: { network: { enabled: true } } }, ask(false))).toEqual({ permissions: {}, scope: "turn" });
    expect(await approvalAnswer("execCommandApproval", { command: ["ls", "-la"], cwd: "/w" }, ask(true))).toEqual({ decision: "approved" });
    expect(asked.at(-1)).toEqual(["codex.command", { command: "ls -la", cwd: "/w", reason: undefined }]);
    // Without the hub to ask, it is a no.
    expect(await approvalAnswer("item/commandExecution/requestApproval", { command: "rm -rf x" })).toEqual({ decision: "decline" });
  });

  it("asks the hub over the session's MCP endpoint; any failure is a no", async () => {
    let sent: any;
    const fetchOk = (async (_url: string, init: any) => {
      sent = { auth: init.headers.authorization, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify({ behavior: "allow", updatedInput: {} }) }] } }));
    }) as typeof fetch;
    expect(await askHub({ url: "http://h/mcp", token: "t1" }, "native_permission", "codex.command", { command: "ls" }, fetchOk)).toBe(true);
    expect(sent).toEqual({ auth: "Bearer t1", body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "native_permission", arguments: { tool_name: "codex.command", input: { command: "ls" } } } } });
    const deny = (async () => new Response(JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify({ behavior: "deny", message: "no" }) }] } }))) as unknown as typeof fetch;
    expect(await askHub({ url: "http://h/mcp", token: "t1" }, "native_permission", "codex.command", {}, deny)).toBe(false);
    const broken = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await askHub({ url: "http://h/mcp", token: "t1" }, "native_permission", "codex.command", {}, broken)).toBe(false);
  });
});
