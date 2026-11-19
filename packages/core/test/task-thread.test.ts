// Talking to a task's thread: whoever started a task reads what it did and does (task_status), the task tells them
// something mid-work (task_tell: its answer when they wrote to it, else a progress line nobody is woken for), and a
// dialog's turns carry each open task's last update.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, MessagePart, Task } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { stepLine, threadLines } from "../src/task-thread.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  let last: unknown;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}

class Client {
  cookie = "";
  csrf = "";
  base: string;
  constructor(base: string) {
    this.base = base;
  }
  async req(method: string, path: string, body?: unknown): Promise<any> {
    const r = await fetch(this.base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        origin: this.base,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf ? { "x-csrf": this.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    const text = await r.text();
    const json = text ? JSON.parse(text) : undefined;
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${text}`);
    return json;
  }
}

const textOf = (m: Message) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");

describe("a task's thread as lines", () => {
  let n = 0;
  const msg = (role: Message["role"], parts: MessagePart[], agentId?: string): Message => ({
    id: `m_${++n}`,
    conversationId: "c_1",
    role,
    parts,
    status: "complete",
    ...(agentId ? { agentId } : {}),
    createdAt: "2026-11-19T10:00:00.000Z",
  });
  const thread = [
    msg("user", [{ type: "text", text: "Compare the three laptops" }]),
    msg("assistant", [
      { type: "text", text: "Let me\nlook." },
      { type: "tool_call", id: "a", name: "Read", input: { file_path: "/work/notes.md" } },
      { type: "tool_result", id: "a", output: "the notes" },
      { type: "tool_call", id: "b", name: "Bash", input: { command: "npm test\necho done" } },
      { type: "tool_result", id: "b", output: "1 failed", isError: true },
      { type: "tool_call", id: "c", name: "mcp__piomio__web_search", input: { query: "laptops" } },
    ]),
    msg("system", [{ type: "text", text: "[System] Owl, who started this task, writes: only under 1.5 kg" }]),
    msg("user", [{ type: "text", text: "and under $1500" }]),
    msg("user", [{ type: "text", text: "a colleague's word" }], "coder"),
    msg("system", [{ type: "error", message: "the brain broke off" }]),
    msg("assistant", [{ type: "text", text: "x".repeat(2000) }]),
  ];

  it("gives one line per thing that happened, oldest first, without the goal", () => {
    const { lines, total, from } = threadLines(thread);
    expect(total).toBe(9);
    expect(from).toBe(1);
    expect(lines.slice(0, 8)).toEqual([
      "Task: Let me look.",
      "→ reading: notes.md",
      "→ command: npm test (failed)",
      "→ tool: web_search",
      "Owl, who started this task, writes: only under 1.5 kg",
      "The user: and under $1500",
      "coder writes: a colleague's word",
      "Error: the brain broke off",
    ]);
    // A long entry is cut.
    expect(lines[8]).toHaveLength(500);
    expect(lines[8].endsWith("…")).toBe(true);
  });

  it("shows the newest entries, and older ones with `skip`", () => {
    expect(threadLines(thread, { last: 2 })).toMatchObject({ total: 9, from: 8 });
    expect(threadLines(thread, { last: 2 }).lines[0]).toBe("Error: the brain broke off");
    const older = threadLines(thread, { last: 2, skip: 7 });
    expect(older).toEqual({ lines: ["Task: Let me look.", "→ reading: notes.md"], total: 9, from: 1 });
    expect(threadLines(thread, { skip: 99 }).lines).toEqual([]);
    expect(threadLines([thread[0]])).toEqual({ lines: [], total: 0, from: 1 });
  });

  it("names a turn's step in a few words", () => {
    expect(stepLine({ step: "command", detail: "npm test" })).toBe("command: npm test");
    expect(stepLine({ step: "thinking" })).toBe("thinking");
  });
});

describe("talking to a task's thread (integration)", () => {
  let hub: Hub;
  let web: Client;
  let main: string;

  const messages = async (conversationId: string): Promise<Message[]> => web.req("GET", `/api/conversations/${conversationId}/messages`);
  const say = (conversationId: string, text: string) => web.req("POST", `/api/conversations/${conversationId}/messages`, { text });
  const idle = (conversationId: string) => until(async () => !hub.runner.isRunning(conversationId) && (await messages(conversationId)).every((m) => m.status !== "streaming"), "the turn to end");
  const dialogOf = async (agentId: string): Promise<string> => ((await web.req("GET", "/api/team")) as Array<{ agentId: string; conversationId: string }>).find((m) => m.agentId === agentId)!.conversationId;
  const task = (id: string): Promise<Task> => web.req("GET", `/api/tasks/${id}`);
  const startedTask = async (conversationId: string, title: string): Promise<string> =>
    until(async () => {
      const ids = (await messages(conversationId)).flatMap((m) => m.parts.flatMap((p) => (p.type === "task" ? [p.taskId] : [])));
      for (const id of ids.reverse()) if ((await task(id)).title === title) return id;
      return undefined;
    }, `the task line of “${title}”`);
  const status = (id: string, s: Task["status"]) => until(async () => ((await task(id)).status === s ? task(id) : undefined), `task ${id} to be ${s}`);
  const lastAnswer = async (conversationId: string) => textOf((await messages(conversationId)).filter((m) => m.role === "assistant").at(-1)!);
  const notes = async (conversationId: string, has: string) => (await messages(conversationId)).filter((m) => m.role === "system" && textOf(m).includes(has)).length;

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-task-thread-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    web = new Client(config.publicUrl);
    await until(() => hub.brains.has("fake@local") && hub.brains.has("fake2:a@local"), "fake brains to register");
    await web.req("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    web.csrf = (await web.req("GET", "/api/bootstrap")).csrf;
    main = (await web.req("GET", "/api/bootstrap")).mainConversationId as string;
    // An agent whose brain cannot take input mid-turn: its SLOW task stays in one turn for 5 s.
    await web.req("PUT", "/api/agents/plodder", { name: "Plodder", description: "Takes one thing at a time", brains: ["fake2:a@local"], prompt: "One at a time." });
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("keeps a task's progress line for the person and wakes nobody for it", async () => {
    await say(main, `CALL task_delegate {"title":"Halfway","goal":"CALL task_tell {\\"text\\":\\"halfway there\\"}"}`);
    const id = await startedTask(main, "Halfway");
    const done = await status(id, "done");
    expect(done.progress?.text).toBe("halfway there");
    expect(Date.parse(done.progress!.at)).toBeGreaterThan(Date.now() - 60_000);
    expect(done.result).toContain("Noted: the person sees it under the task");
    await until(() => notes(main, `Task ${id} “Halfway” is finished.`), "the result in the dialog");
    expect(await notes(main, "replies:")).toBe(0);
    await idle(main);
  });

  it("delivers a task's answer to its starter at once when they wrote to it", async () => {
    await say(main, `CALL task_delegate {"title":"Slow look","goal":"look around SLOW","agent":"plodder"}`);
    const id = await startedTask(main, "Slow look");
    const tc = (await task(id)).conversationId;
    await until(async () => (await messages(tc)).some((m) => m.role === "assistant" && textOf(m).includes("fake2 is thinking")), "the task at work");
    await idle(main);
    const from = { agentId: "assistant", conversationId: main };
    const sent = await hub.runner.messageTask(id, "what did you find so far?", from);
    expect(sent.text).toContain("its answer comes here as a message");
    expect((await task(id)).owesReply).toBe(true);
    expect((await messages(tc)).some((m) => textOf(m).includes("writes: what did you find so far?\n(If they ask you something, answer with task_tell"))).toBe(true);

    const told = await hub.runner.tellFromTask(id, "found three");
    expect(told).toEqual({ ok: true, text: "Delivered to whoever started this task, as your answer. Go on with the work." });
    await until(() => notes(main, `[System] Task ${id} “Slow look” (Plodder) replies: found three`), "the answer in the dialog");
    expect(await task(id)).toMatchObject({ progress: { text: "found three" } });
    expect((await task(id)).owesReply).toBeUndefined();
    await idle(main);

    // The next word is progress: on the task's line, and the dialog hears nothing.
    const quiet = await hub.runner.tellFromTask(id, "comparing them");
    expect(quiet.text).toContain("Noted");
    expect((await task(id)).progress?.text).toBe("comparing them");
    expect(await notes(main, "replies:")).toBe(1);
    expect((await hub.runner.tellFromTask(id, "  ")).ok).toBe(false);
    hub.runner.cancelTask(id);
  });

  it("does not take the answer to a task's own question for a question", async () => {
    await idle(main);
    await say(main, `CALL task_delegate {"title":"Branch","goal":"CALL task_ask {\\"question\\":\\"Which branch?\\"}"}`);
    const id = await startedTask(main, "Branch");
    const tc = (await task(id)).conversationId;
    await status(id, "waiting_input");
    await hub.runner.messageTask(id, "main", { agentId: "assistant", conversationId: main });
    expect((await task(id)).question).toBeUndefined();
    expect((await task(id)).owesReply).toBeUndefined();
    expect((await messages(tc)).some((m) => textOf(m).endsWith("writes: main"))).toBe(true);
    await status(id, "done");
    await idle(main);
  });

  it("shows a task's thread to whoever started it, and only its state to others", async () => {
    await idle(main);
    await say(main, `CALL task_delegate {"title":"Notes","goal":"read the notes"}`);
    const id = await startedTask(main, "Notes");
    const tc = (await task(id)).conversationId;
    await status(id, "done");
    // The person writes on the task's page: the task narrates, reads a file and answers.
    await say(tc, "THINK");
    await until(async () => (await messages(tc)).some((m) => m.role === "assistant" && textOf(m).includes("fake found it")), "the task's second turn");
    await status(id, "done");
    await idle(main);

    await say(main, `CALL task_status {"taskId":"${id}"}`);
    await idle(main);
    const seen = await lastAnswer(main);
    expect(seen).toContain(`Task ${id} “Notes” — `);
    expect(seen).toContain("Goal: read the notes");
    expect(seen).toMatch(/Thread \(entries 1–\d+ of \d+, oldest first\):/);
    expect(seen).toContain("The user: THINK");
    expect(seen).toContain("Task: Let me look.");
    expect(seen).toContain("→ reading: notes.md");
    expect(seen).toContain("fake found it");
    expect(seen).toContain("Result:");

    // The newest entry alone, with the way to the older ones.
    await say(main, `CALL task_status {"taskId":"${id}","last":1}`);
    await idle(main);
    expect(await lastAnswer(main)).toMatch(/Thread \(entries (\d+)–\1 of \1, oldest first; skip: 1 reads older\):/);

    const other = await dialogOf("plodder");
    await say(other, `CALL task_status {"taskId":"${id}"}`);
    await idle(other);
    const outside = await lastAnswer(other);
    expect(outside).toContain(`Task ${id} “Notes” — `);
    expect(outside).toContain("Result:");
    expect(outside).not.toContain("Thread");
    expect(outside).not.toContain("→ reading");

    await say(other, `CALL task_status {"taskId":"t_nope"}`);
    await idle(other);
    expect(await lastAnswer(other)).toContain("No task t_nope.");
  });

  it("tells a dialog each open task's last update, and only that there is one after outside content", async () => {
    const c = await dialogOf("plodder");
    await idle(c);
    await say(c, `CALL task_delegate {"title":"Waiting","goal":"CALL task_ask {\\"question\\":\\"Which one?\\"}"}`);
    const id = await startedTask(c, "Waiting");
    await status(id, "waiting_input");
    await idle(c);
    await hub.runner.tellFromTask(id, "checked two of five");
    await say(c, "INPUT?");
    await idle(c);
    const open = await lastAnswer(c);
    expect(open).toContain("[Open tasks you started]");
    expect(open).toMatch(new RegExp(`- ${id} “Waiting” — Plodder: waiting for your answer; last update \\d\\d:\\d\\d: checked two of five; asked you: Which one\\?`));

    // The task read outside content: its words reach a session only with the mark (task_status).
    hub.store.updateTask(id, { tainted: true });
    await say(c, "INPUT?");
    await idle(c);
    const marked = await lastAnswer(c);
    expect(marked).toMatch(/; wrote an update at \d\d:\d\d \(task_status shows it\)/);
    expect(marked).not.toContain("checked two of five");
    expect(hub.store.activeSession(c, "plodder")?.tainted).toBeFalsy();

    await say(c, `CALL task_status {"taskId":"${id}"}`);
    await idle(c);
    const seen = await lastAnswer(c);
    expect(seen).toMatch(/Last update \(\d\d:\d\d\): checked two of five/);
    expect(seen).toContain("Asked: Which one?");
    expect(hub.store.activeSession(c, "plodder")?.tainted).toBe(true);
    hub.runner.cancelTask(id);
  });

  it("refuses task_tell outside a task", async () => {
    await idle(main);
    await say(main, `CALL task_tell {"text":"hello"}`);
    await idle(main);
    expect(await lastAnswer(main)).toContain("task_tell works inside a task");
  });
});
