// An agent is one person across its sessions (own-work.ts): a thread with a teammate opens knowing what the agent said
// in its dialog with the user and the tasks it finished (the `[Your recent work]` block), hears only what is new on a
// later message, carries the outside-content mark of what it was shown, and looks further back with self_recall.
// Uses the scripted fake brain (test/fixtures/plugins/fakebrain): "INPUT?" answers with the turn's input.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDef, Message, MessagePart, Task, ToolCallContext } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { mentions, recallText, recentWork, type OwnWork } from "../src/own-work.ts";

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

const message = (over: Partial<Message> & { text: string }): Message => ({
  id: `m_${over.createdAt}`,
  conversationId: "c_dialog",
  role: "assistant",
  parts: [{ type: "text", text: over.text }],
  status: "complete",
  createdAt: "2026-11-20T08:00:00Z",
  ...over,
});

const done = (over: Partial<Task>): Task => ({
  id: "t_1",
  conversationId: "c_t1",
  agentId: "briefy",
  title: "What Ilyas wrote about quick filters",
  goal: "Read the stream",
  status: "done",
  createdBy: "agent",
  background: false,
  result: "He wants one A/B test for both releases.",
  createdAt: "2026-11-20T08:20:00Z",
  updatedAt: "2026-11-20T08:41:00Z",
  ...over,
});

const work = (over: Partial<OwnWork>): OwnWork => ({ dialog: [], tasks: [], time: (iso) => iso.slice(11, 16), ...over });

describe("the [Your recent work] block", () => {
  it("shows the dialog's recent messages and the finished tasks, oldest first", () => {
    const block = recentWork(
      work({
        dialog: [
          message({ role: "user", text: "What did Ilyas write about quick filters?", createdAt: "2026-11-20T08:20:00Z" }),
          message({ text: "Started a task that reads the stream.", createdAt: "2026-11-20T08:21:00Z" }),
          message({ text: "He wants one A/B test\nfor both releases.", createdAt: "2026-11-20T08:42:00Z" }),
        ],
        tasks: [done({})],
        from: () => " from you",
      }),
    );
    expect(block).toBe(
      [
        "[Your recent work] What you said and did in your other sessions (they are all you): answer from it as from your own memory. `self_recall` looks further back, `task_status` shows a task whole.",
        "Your dialog with the user:",
        "- 08:20 User: What did Ilyas write about quick filters?",
        "- 08:21 You: Started a task that reads the stream.",
        "- 08:42 You: He wants one A/B test for both releases.",
        "Tasks you finished:",
        "- t_1 “What Ilyas wrote about quick filters” from you, done 08:41: He wants one A/B test for both releases.",
      ].join("\n"),
    );
  });

  it("is nothing when there is nothing to show, and says what is new on a later turn", () => {
    expect(recentWork(work({}))).toBeUndefined();
    // Notes for the model, a teammate's lines in a thread and a reply still being written are not the dialog's words.
    expect(
      recentWork(
        work({
          dialog: [
            message({ role: "system", text: "[System] Task t_1 is finished." }),
            message({ role: "user", agentId: "assistant", text: "a teammate" }),
            message({ text: "half a rep", status: "streaming" }),
          ],
        }),
      ),
    ).toBeUndefined();
    const later = recentWork(work({ dialog: [message({ role: "user", text: "And the release date?" })], tasks: [done({ status: "failed", result: undefined, error: "the stream did not open" })] }), { again: true })!;
    expect(later.split("\n")[0]).toBe("[Your recent work] New in your other sessions since this one last heard:");
    expect(later).toContain("- t_1 “What Ilyas wrote about quick filters”, failed 08:41: the stream did not open");
  });

  it("keeps the newest messages when the dialog is long, and says how many it left out", () => {
    const dialog = Array.from({ length: 30 }, (_, i) => message({ text: `reply ${i} ${"x".repeat(900)}`, createdAt: `2026-11-20T08:${String(i).padStart(2, "0")}:00Z` }));
    const block = recentWork(work({ dialog }))!;
    expect(block.length).toBeLessThan(8000);
    expect(block).toContain("You: reply 29 ");
    expect(block).not.toContain("You: reply 0 ");
    expect(block).toMatch(/Your dialog with the user \(\d+ older messages left out\):/);
  });
});

describe("self_recall's search", () => {
  it("finds words in their other forms, in any letter case", () => {
    expect(mentions("Что писал Ильяс про быстрые фильтры в стриме", "быстрым фильтрам")).toBe(true);
    expect(mentions("The quick FILTERS report", "filter report")).toBe(true);
    expect(mentions("Что писал Ильяс про быстрые фильтры", "отчёт по фильтрам")).toBe(false);
  });

  it("lists what mentions the words, newest first, and says so when nothing does", () => {
    const w = work({
      dialog: [
        message({ role: "user", text: "The hotel in Rome is booked", createdAt: "2026-11-18T08:00:00Z" }),
        message({ text: "Quick filters go out in one A/B test", createdAt: "2026-11-20T08:42:00Z" }),
        message({ role: "user", text: "ok, and the filters redesign?", createdAt: "2026-11-20T08:50:00Z" }),
      ],
      tasks: [done({}), done({ id: "t_2", title: "Book the hotel", goal: "Rome", result: "Booked." })],
    });
    const found = recallText(w, { query: "filters" });
    expect(found.split("\n")).toEqual([
      'What mentions "filters" in your other sessions, newest first:',
      "Your dialog with the user:",
      "- 08:50 User: ok, and the filters redesign?",
      "- 08:42 You: Quick filters go out in one A/B test",
      "Your tasks (task_status shows one whole):",
      "- t_1 “What Ilyas wrote about quick filters”, done 08:41: He wants one A/B test for both releases.",
    ]);
    expect(recallText(w, { query: "yamaha" })).toBe('Nothing in your dialog with the user or your tasks mentions "yamaha". Try one or two other words, or no query for the latest.');
    // The teammate calls it a "report": nothing has every word, so the closest comes instead of "nothing".
    const closest = recallText(w, { query: "quick filters report" });
    expect(closest.split("\n")[0]).toBe('Nothing in your other sessions has all the words of "quick filters report"; the closest, newest first:');
    expect(closest).toContain("- 08:42 You: Quick filters go out in one A/B test");
    expect(closest).not.toContain("Rome");
    // No words: the latest of both.
    const latest = recallText(w, {});
    expect(latest).toContain("- 08:00 User: The hotel in Rome is booked");
    expect(latest).toContain("- t_2 “Book the hotel”");
  });
});

type Line = Extract<MessagePart, { type: "task" }>;
const textOf = (m: Message) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
const linesOf = (ms: Message[]): Line[] => ms.flatMap((m) => m.parts.filter((p): p is Line => p.type === "task" && p.text !== undefined));

describe("an agent knows its own work in a thread with a teammate (integration)", () => {
  let hub: Hub;
  let web: Client;
  let main = "";
  let dialog = "";

  const messages = async (conversationId: string): Promise<Message[]> => web.req("GET", `/api/conversations/${conversationId}/messages`);
  const say = (conversationId: string, text: string) => web.req("POST", `/api/conversations/${conversationId}/messages`, { text });
  const idle = (conversationId: string) => until(async () => !hub.runner.isRunning(conversationId) && (await messages(conversationId)).every((m) => m.status !== "streaming"), "the turn to end");
  const task = (id: string): Promise<Task> => web.req("GET", `/api/tasks/${id}`);
  const chat = async (): Promise<string> => (await web.req("POST", "/api/conversations", { title: "side" })).id;
  const call = async (name: string, input: unknown, ctx: Partial<ToolCallContext> & { conversationId: string }) => {
    const r = await hub.tools.get(name)!.invoke(input, { sessionId: "s_test", agentId: "assistant", callId: "c_test", tainted: false, background: false, workspace: "", machineId: "local", ...ctx });
    return { text: r.content.map((c) => (c.type === "text" ? c.text : "")).join(""), isError: !!r.isError, taint: !!(r as { _meta?: { taint?: boolean } })._meta?.taint };
  };
  /** The assistant writes to the researcher from `conversationId`; the researcher's brain answers with its turn's input. */
  const ask = async (conversationId: string, text: string): Promise<{ input: string; thread: Task }> => {
    const asked = `${text}\nINPUT?`;
    expect(await call("team_message", { to: "researcher", text: asked }, { conversationId })).toMatchObject({ isError: false });
    const sent = await until(async () => linesOf(await messages(conversationId)).find((l) => l.text === asked && l.reply !== undefined), `the answer to “${text}”`);
    await idle(conversationId);
    return { input: sent.reply!, thread: await task(sent.taskId) };
  };

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-own-work-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
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
    dialog = hub.store.agentConversation("researcher").id;
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("gives a teammate's thread nothing when the agent has done nothing yet", async () => {
    const { input } = await ask(await chat(), "anything new?");
    expect(input).not.toContain("[Your recent work]");
  });

  it("opens a teammate's thread with what the agent said in its dialog and the task it finished", async () => {
    await say(dialog, "Ilyas wants the quick filters in one test");
    await idle(dialog);
    const job = hub.store.createTask({ agentId: "researcher", title: "Read the stream", goal: "read it", createdBy: "user", background: false, status: "done" });
    hub.store.updateTask(job.id, { result: "Ilyas ties both releases to one test." });

    const { input, thread } = await ask(await chat(), "bring me up to speed on the quick filters");
    expect(input).toContain("[Your recent work] What you said and did in your other sessions");
    expect(input).toMatch(/- \d\d:\d\d User: Ilyas wants the quick filters in one test/);
    expect(input).toMatch(/- \d\d:\d\d You: fake heard: Ilyas wants the quick filters in one test/);
    expect(input).toContain(`- ${job.id} “Read the stream” from the user, done `);
    expect(input).toContain("Ilyas ties both releases to one test.");
    // The block comes before the teammate's message, which stays the last word.
    expect(input.indexOf("[Your recent work]")).toBeLessThan(input.indexOf("Message from your teammate"));
    // Nothing of it read outside content: the thread stays clean.
    expect(hub.store.activeSession(thread.conversationId, "researcher")?.tainted).toBe(false);
  });

  it("tells the same thread only what is new when the teammate writes again", async () => {
    const c = await chat();
    const first = await ask(c, "what do you know?");
    expect(first.input).toContain("Ilyas wants the quick filters in one test");
    // Nothing new: no block.
    const second = await ask(c, "and now?");
    expect(second.thread.id).toBe(first.thread.id);
    expect(second.input).not.toContain("[Your recent work]");
    await say(dialog, "the release moved to December");
    await idle(dialog);
    const third = await ask(c, "anything else?");
    expect(third.input).toContain("[Your recent work] New in your other sessions since this one last heard:");
    expect(third.input).toContain("User: the release moved to December");
    expect(third.input).not.toContain("Ilyas wants the quick filters in one test");
  });

  it("opens a task a teammate started the same way, and leaves the agent's dialog and its own tasks as they were", async () => {
    const finished = (title: string) => until(async () => ((await web.req("GET", "/api/tasks")) as Task[]).find((t) => t.title === title && t.status === "done"), `the task “${title}” to finish`);
    // "ECHO?" answers with the "[…]" lines of the task's input.
    hub.runner.createTask({ agentId: "researcher", title: "From a teammate", goal: "look into it ECHO?", parentConversationId: main, createdBy: "agent", background: false });
    expect((await finished("From a teammate")).result).toContain("[Your recent work] What you said and did in your other sessions");
    await idle(main);

    await say(dialog, "INPUT?");
    await idle(dialog);
    expect(textOf((await messages(dialog)).findLast((m) => m.role === "assistant")!)).not.toContain("[Your recent work]");
    // Its dialog wrote the task's goal: the task knows what it needs.
    hub.runner.createTask({ agentId: "researcher", title: "Own job", goal: "do it ECHO?", parentConversationId: dialog, createdBy: "agent", background: false });
    expect((await finished("Own job")).result).not.toContain("[Your recent work]");
    await idle(dialog);
  });

  it("marks the thread when the dialog it is shown has read outside content", async () => {
    hub.store.updateSession(hub.store.activeSession(dialog, "researcher")!.id, { tainted: true });
    const { input, thread } = await ask(await chat(), "what did the page say?");
    expect(input).toContain("[Your recent work]");
    expect(hub.store.activeSession(thread.conversationId, "researcher")?.tainted).toBe(true);
  });

  it("lets an agent look into its own dialog and tasks from any session (self_recall)", async () => {
    const side = await chat();
    const found = await call("self_recall", { query: "december" }, { conversationId: side, agentId: "researcher" });
    expect(found.isError).toBe(false);
    expect(found.text).toContain('What mentions "december" in your other sessions');
    expect(found.text).toContain("User: the release moved to December");
    // The dialog read outside content (the test above): what comes from it is marked.
    expect(found.taint).toBe(true);
    const tasks = await call("self_recall", { query: "stream" }, { conversationId: side, agentId: "researcher" });
    expect(tasks.text).toContain("“Read the stream”");
    // Another agent's dialog is not this agent's memory.
    const other = await call("self_recall", { query: "december" }, { conversationId: side, agentId: "assistant" });
    expect(other.text).toMatch(/^Nothing in your dialog with the user or your tasks mentions "december"/);
    expect(other.taint).toBe(false);
  });

  it("tells every session that its other sessions are its own memory", () => {
    const agent = { id: "researcher", name: "Researcher", description: "", brains: [], initiative: 1, tools: ["*"], skills: [], policyProfile: "default", budget: { backgroundRunsPerDay: 5 }, prompt: "", source: "builtin" } as AgentDef;
    const base = { agent, timezone: "UTC", language: "en", consoleUrl: "http://x", background: false, skills: [], nativeSkills: false, appended: [] };
    const thread = buildSystemPrompt({ ...base, task: { id: "t1", title: "x", createdBy: "agent", kind: "message" } as Task, thread: { id: "assistant", name: "Owl" } });
    expect(thread).toContain("look with `self_recall` before you say you do not know");
    expect(buildSystemPrompt({ ...base, task: { id: "t2", title: "x", createdBy: "agent" } as Task })).toContain("`self_recall`");
  });
});
