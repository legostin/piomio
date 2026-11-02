// Teammates write to each other (team_message): a thread on the side, a line with the answer in the sender's reply,
// the reply back to the sender (into its running turn or as a new one), the same thread for a follow-up, the limits,
// outside content staying marked both ways (threads and tasks), and the phone getting outcomes, not agent chatter.
// Uses the scripted fake brain (test/fixtures/plugins/fakebrain): "CALL <tool> <json>", "SLOW".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDef, Message, MessagePart, Task, ToolCallContext } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { buildSystemPrompt } from "../src/prompt.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

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

type Line = Extract<MessagePart, { type: "task" }>;
const textOf = (m: Message) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
const linesOf = (ms: Message[]): Line[] => ms.flatMap((m) => m.parts.filter((p): p is Line => p.type === "task" && p.text !== undefined));

describe("teammates writing to each other (integration)", () => {
  let hub: Hub;
  let web: Client;
  let main = "";

  const messages = async (conversationId: string): Promise<Message[]> => web.req("GET", `/api/conversations/${conversationId}/messages`);
  const say = (conversationId: string, text: string) => web.req("POST", `/api/conversations/${conversationId}/messages`, { text });
  const idle = (conversationId: string) => until(async () => !hub.runner.isRunning(conversationId) && (await messages(conversationId)).every((m) => m.status !== "streaming"), "the turn to end");
  const task = (id: string): Promise<Task> => web.req("GET", `/api/tasks/${id}`);
  /** The line of the message `text` in the conversation, once it is there (and answered, when asked). */
  const line = (conversationId: string, text: string, answered = false): Promise<Line> =>
    until(async () => linesOf(await messages(conversationId)).find((l) => l.text === text && (!answered || l.reply !== undefined)), `the line “${text}”${answered ? " answered" : ""}`);
  const chat = async (): Promise<string> => (await web.req("POST", "/api/conversations", { title: "side" })).id;
  /** A tool call as an agent's brain would make it. */
  const call = async (name: string, input: unknown, ctx: Partial<ToolCallContext> & { conversationId: string }) => {
    const r = await hub.tools.get(name)!.invoke(input, { sessionId: "s_test", agentId: "assistant", callId: "c_test", tainted: false, background: false, workspace: "", machineId: "local", ...ctx });
    return { text: r.content.map((c) => (c.type === "text" ? c.text : "")).join(""), isError: !!r.isError };
  };
  const sessionTainted = (conversationId: string, agentId: string) => !!hub.store.activeSession(conversationId, agentId)?.tainted;

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-team-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    web = new Client(config.publicUrl);
    await until(() => hub.brains.has("fake@local"), "fake brains to register");
    await web.req("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    const boot = await web.req("GET", "/api/bootstrap");
    web.csrf = boot.csrf;
    main = boot.mainConversationId;
    await web.req("PUT", "/api/agents/researcher", { name: "Researcher", description: "Looks things up", brains: ["fake@local"], prompt: "Research." });
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("opens a thread on the side, shows the answer under the message and hands it back to the sender", async () => {
    await say(main, `CALL team_message {"to":"researcher","text":"what is two plus two"}`);
    const sent = await line(main, "what is two plus two");
    const thread = await task(sent.taskId);
    expect(thread).toMatchObject({ kind: "message", from: "assistant", agentId: "researcher", parentConversationId: main, createdBy: "agent", background: false });
    // The sender's tool result says where it went and not to wait.
    await until(async () => (await messages(main)).some((m) => m.role === "assistant" && textOf(m).startsWith(`tool said: Sent to Researcher (thread ${sent.taskId})`)), "the tool result");

    const answered = await line(main, "what is two plus two", true);
    expect(answered.reply).toBe("fake heard: what is two plus two");
    // The thread reads as the sender's message and the teammate's reply.
    const inThread = await messages(thread.conversationId);
    expect(inThread[0]).toMatchObject({ role: "user", agentId: "assistant", parts: [{ type: "text", text: "what is two plus two" }] });
    expect(inThread.find((m) => m.role === "assistant")).toMatchObject({ agentId: "researcher" });
    // The sender hears the reply (a note for the model) and carries on with it.
    await until(async () => (await messages(main)).some((m) => m.role === "system" && textOf(m).startsWith(`[System] Researcher replied (thread ${sent.taskId}):`)), "the reply note");
    await until(async () => (await messages(main)).some((m) => m.role === "assistant" && textOf(m) === "fake heard: fake heard: what is two plus two"), "the sender's next turn");
    await idle(main);
    expect(sessionTainted(main, "assistant")).toBe(false);
  });

  it("continues the same thread when the agent writes to the teammate again, by name too", async () => {
    const first = (await line(main, "what is two plus two")).taskId;
    await say(main, `CALL team_message {"to":"Researcher","text":"and three plus three"}`);
    const again = await line(main, "and three plus three", true);
    expect(again.taskId).toBe(first);
    expect(again.reply).toBe("fake heard: and three plus three");
    // The first answer stays under the first message.
    expect((await line(main, "what is two plus two")).reply).toBe("fake heard: what is two plus two");
    const inThread = await messages((await task(first)).conversationId);
    expect(inThread.filter((m) => m.role === "user" && m.agentId === "assistant").map(textOf)).toEqual(["what is two plus two", "and three plus three"]);
    await idle(main);
  });

  it("brings the reply into the sender's turn while it still works", async () => {
    const c = await chat();
    await say(c, "keep going SLOW");
    // At work: its brain has begun to answer, so the reply can join the turn.
    await until(async () => (await messages(c)).some((m) => m.role === "assistant" && textOf(m).includes("fake is thinking")), "the agent at work");
    // The brain writes to a teammate in the middle of its turn.
    const r = await hub.runner.messageTeammate("researcher", "quick check", { agentId: "assistant", conversationId: c, background: false, tainted: false, nest: true });
    expect(r.ok).toBe(true);
    await idle(c);
    const said = (await messages(c)).filter((m) => m.role === "assistant").map(textOf);
    expect(said).toContain("fake also heard: fake heard: quick check");
    expect((await line(c, "quick check", true)).reply).toBe("fake heard: quick check");
  });

  it("refuses itself, strangers, nesting deeper than 3 and a seventh message without the user", async () => {
    const c = await chat();
    expect(await call("team_message", { to: "assistant", text: "hi" }, { conversationId: c })).toMatchObject({ isError: true, text: expect.stringMatching(/^That is you/) });
    expect(await call("team_message", { to: "nobody", text: "hi" }, { conversationId: c })).toMatchObject({ isError: true, text: expect.stringMatching(/^No teammate "nobody"\. The team: .*researcher \(Researcher\)/) });

    // Three tasks deep: no new thread from here.
    const t1 = hub.store.createTask({ agentId: "assistant", title: "a", goal: "a", createdBy: "user", background: false, status: "done" });
    const t2 = hub.store.createTask({ agentId: "assistant", title: "b", goal: "b", createdBy: "agent", background: false, parentTaskId: t1.id, status: "done" });
    const t3 = hub.store.createTask({ agentId: "assistant", title: "c", goal: "c", createdBy: "agent", background: false, parentTaskId: t2.id, status: "done" });
    expect(await call("team_message", { to: "researcher", text: "deep" }, { conversationId: t3.conversationId, taskId: t3.id })).toMatchObject({
      isError: true,
      text: expect.stringMatching(/nested too deep/),
    });

    // Six messages to teammates since the user wrote here; the seventh waits for the user.
    for (let i = 1; i <= 6; i++) expect(await call("team_message", { to: "researcher", text: `note ${i}` }, { conversationId: c })).toMatchObject({ isError: false });
    expect(await call("team_message", { to: "researcher", text: "note 7" }, { conversationId: c })).toMatchObject({ isError: true, text: expect.stringMatching(/6 times since the user last wrote here/) });
    expect(new Set(linesOf(await messages(c)).map((l) => l.taskId)).size).toBe(1);
    await say(c, "go on");
    expect(await call("team_message", { to: "researcher", text: "note 8" }, { conversationId: c })).toMatchObject({ isError: false });
    await idle(c);
  });

  it("keeps outside content marked both ways: into the teammate's thread and back with its reply", async () => {
    const c = await chat();
    const r = await call("team_message", { to: "researcher", text: "summarize the page" }, { conversationId: c, tainted: true });
    expect(r.isError).toBe(false);
    const sent = await line(c, "summarize the page", true);
    const thread = await task(sent.taskId);
    expect(thread.tainted).toBe(true);
    expect(sessionTainted(thread.conversationId, "researcher")).toBe(true);
    // The reply carries it back: the sender's session is marked by the turn that reads it.
    await until(async () => (await messages(c)).some((m) => m.role === "assistant" && textOf(m).startsWith("fake heard:")), "the sender's turn");
    await idle(c);
    expect(sessionTainted(c, "assistant")).toBe(true);

    // A clean sender, a teammate whose thread has read outside content: the reply marks the sender.
    const d = await chat();
    await say(d, "hello");
    await idle(d);
    expect(sessionTainted(d, "assistant")).toBe(false);
    await call("team_message", { to: "researcher", text: "first look" }, { conversationId: d });
    const first = await line(d, "first look", true);
    await idle(d);
    expect(sessionTainted(d, "assistant")).toBe(false);
    const threadConv = (await task(first.taskId)).conversationId;
    hub.store.updateSession(hub.store.activeSession(threadConv, "researcher")!.id, { tainted: true });
    await call("team_message", { to: "researcher", text: "and now?" }, { conversationId: d });
    await line(d, "and now?", true);
    await until(() => sessionTainted(d, "assistant"), "the sender's session to be marked");
  });

  it("marks tasks started from a session that read outside content, and the starter by their result", async () => {
    const c = await chat();
    await say(c, "hello");
    await idle(c);
    hub.store.updateSession(hub.store.activeSession(c, "assistant")!.id, { tainted: true });
    await say(c, `CALL task_delegate {"title":"Tainted job","goal":"do it"}`);
    const job = await until(async () => ((await web.req("GET", "/api/tasks")) as Task[]).find((t) => t.title === "Tainted job" && t.status === "done"), "the task to finish");
    expect(job.tainted).toBe(true);
    expect(sessionTainted(job.conversationId, "assistant")).toBe(true);

    // A clean dialog starts a clean task; the task reads outside content; its result marks the dialog.
    const d = await chat();
    await say(d, `CALL task_delegate {"title":"Reader","goal":"read the web SLOW"}`);
    const reader = await until(async () => ((await web.req("GET", "/api/tasks")) as Task[]).find((t) => t.title === "Reader" && t.status === "running"), "the task to run");
    expect(reader.tainted).toBeFalsy();
    await until(() => hub.store.activeSession(reader.conversationId, "assistant"), "the task's session");
    hub.store.updateSession(hub.store.activeSession(reader.conversationId, "assistant")!.id, { tainted: true });
    hub.runner.interrupt(reader.conversationId);
    await until(async () => (await task(reader.id)).status === "done", "the task to finish");
    await until(() => sessionTainted(d, "assistant"), "the starter's session to be marked");
  });

  it("sends the phone the outcome, not agents writing to each other", async () => {
    await idle(main);
    const sent: any[] = [];
    const peer = { closed: false, request: async (_m: string, p: any) => (sent.push(p), {}) } as any;
    hub.channels.register("mirror", "Mirror", "mirror-team", peer);
    try {
      // A turn nobody typed (a note) that writes to a teammate again stays in the web...
      hub.runner.noteAndContinue(main, `CALL team_message {"to":"researcher","text":"one more thing"}`);
      await line(main, "one more thing", true);
      // ...and the turn with the outcome reaches the phone.
      const out = await until(() => sent.find((s) => s.message.text === "fake heard: fake heard: one more thing"), "the outcome on the phone");
      expect(out.message.kind).toBe("reply");
      await idle(main);
      await sleep(200);
      expect(sent.some((s) => /Sent to Researcher|^fake heard: one more thing$/.test(s.message.text))).toBe(false);
    } finally {
      hub.channels.unregisterPlugin("mirror-team");
    }
  });

  it("tells a dialog's agent to write to teammates, and a teammate how to answer", () => {
    const agent = { id: "assistant", name: "Owl", description: "", brains: [], initiative: 1, tools: ["*"], skills: [], policyProfile: "default", budget: { backgroundRunsPerDay: 5 }, prompt: "", source: "builtin" } as AgentDef;
    const base = { agent, timezone: "UTC", language: "en", consoleUrl: "http://x", background: false, skills: [], nativeSkills: false, appended: [] };
    const dialog = buildSystemPrompt({ ...base, dispatch: { team: [{ id: "researcher", name: "Researcher", description: "Looks things up", where: [] }], computers: [] } });
    expect(dialog).toContain("goes to them with `team_message`");
    expect(dialog).toContain('also when the user says "ask X" or writes @id');
    expect(dialog).toContain("Your team (`to` in team_message, `agent` in task_delegate):");
    const thread = buildSystemPrompt({ ...base, task: { id: "t1", title: "x", createdBy: "agent", kind: "message" } as Task, thread: { id: "assistant", name: "Owl" } });
    expect(thread).toContain('Your teammate Owl (agent "assistant") wrote to you; you are answering them in a thread on the side (id t1).');
    expect(thread).toContain("Your reply goes back to them by itself");
    expect(thread).not.toContain("`task_ask`");
    const inTask = buildSystemPrompt({ ...base, task: { id: "t2", title: "x", createdBy: "agent" } as Task });
    expect(inTask).toContain("write to them with `team_message`");
  });
});
