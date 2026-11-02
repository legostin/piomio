// What an agent knows about itself (situation.ts): the `[You now]` block — this session, the agent's other work, the
// team, the computers — and, end to end, a teammate asked in a thread naming the task it runs elsewhere, the dialog
// seeing what a teammate is busy with, the block coming again only when it changed. And the conversation flow around
// it: a thread waits in line for a busy brain (its sender hears why), messages written in a row reach the agent as one
// turn, and a task's report answers the request it came from when the dialog moved on.
// Uses the scripted fake brain (test/fixtures/plugins/fakebrain): "SELF?" answers with the last block it got, "SLOW".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineActivity, Message, MessagePart, Task } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { situation, type SituationFacts } from "../src/situation.ts";
import { clockTime } from "../src/clock.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const task = (over: Partial<Task>): Task => ({
  id: "t_1",
  conversationId: "c_t1",
  agentId: "critic",
  title: "Edit the hotel shot",
  goal: "edit",
  status: "running",
  createdBy: "agent",
  background: false,
  createdAt: "2026-10-28T18:02:00Z",
  updatedAt: "2026-10-28T18:02:00Z",
  ...over,
});

const facts = (over: Partial<SituationFacts>): SituationFacts => ({
  agentId: "critic",
  session: { kind: "dialog", conversationId: "c_critic", machine: "MacBook", local: true },
  team: [
    { id: "assistant", name: "Assistant" },
    { id: "critic", name: "Photo critic" },
    { id: "researcher", name: "Researcher" },
  ],
  tasks: [],
  activity: [{ id: "local", name: "MacBook", online: true, work: [] }],
  starter: (t) => (t.kind === "message" ? t.from : "critic"),
  machineOf: () => "MacBook",
  time: (iso) => clockTime(iso, "Asia/Almaty", new Date("2026-10-28T18:10:00Z")),
  ...over,
});

describe("the [You now] block", () => {
  it("names this session, the agent's other work and what each teammate does", () => {
    const thread = task({ id: "t_2", conversationId: "c_t2", kind: "message", from: "assistant", title: "What are you doing?" });
    const block = situation(
      facts({
        session: { kind: "thread", conversationId: "c_t2", machine: "MacBook", local: true, task: thread },
        tasks: [thread, task({}), task({ id: "t_3", agentId: "researcher", title: "Yamaha shops", createdBy: "user", status: "waiting_input" })],
        activity: [
          { id: "local", name: "MacBook", online: true, work: [{ agentId: "assistant", conversationId: "c_main", brainId: "fake", step: "thinking", startedAt: "2026-10-28T18:09:00Z" }] },
          { id: "m1", name: "Studio", online: false, work: [] },
        ],
      }),
    );
    expect(block.split("\n")).toEqual([
      "[You now]",
      'This session: your thread t_2 answering Assistant, who wrote to you, on the computer "MacBook" (the hub\'s own).',
      "Your other work (all of it is you, in other sessions):",
      "- t_1 “Edit the hotel shot”: a task from you, on MacBook, since 23:02; working",
      "Team now:",
      "- assistant (Assistant): replying in its dialog with the user",
      "- researcher (Researcher): t_3 “Yamaha shops”: a task from the user, on MacBook, since 23:02; waiting for an answer",
      "Computers: MacBook (the hub's own) online, Studio offline.",
    ]);
  });

  it("says when there is nothing else, counts the rest and adds where the user is", () => {
    const many = Array.from({ length: 5 }, (_, i) => task({ id: `t_r${i}`, agentId: "researcher", title: `R${i}` }));
    const block = situation(facts({ tasks: many, user: "Almaty, Dostyk Ave (iPhone, 23:05)" }));
    expect(block).toContain("Your other work: none; this session is all you are doing now.");
    expect(block).toContain("- assistant (Assistant): free");
    expect(block).toMatch(/R2”: a task from Photo critic.*; and 2 more tasks$/m);
    expect(block).not.toContain("Computers:");
    expect(block.endsWith("The user: Almaty, Dostyk Ave (iPhone, 23:05)")).toBe(true);
  });

  it("lists the agent's dialog and group chats mid-turn, but not this session's own turn", () => {
    const work = (conversationId: string, title?: string): MachineActivity["work"][number] => ({ agentId: "critic", conversationId, brainId: "fake", step: "writing", startedAt: "2026-10-28T18:00:00Z", ...(title ? { title } : {}) });
    const block = situation(
      facts({
        session: { kind: "task", conversationId: "c_t1", machine: "Studio", local: false, task: task({}) },
        activity: [{ id: "local", name: "MacBook", online: true, work: [work("c_critic"), work("c_g", "Launch"), { ...work("c_t1"), taskId: "t_1" }] }],
      }),
    );
    expect(block).toContain('This session: your task t_1 “Edit the hotel shot” from you, since 23:02, on the computer "Studio".');
    expect(block).toContain("- your dialog with the user: replying now");
    expect(block).toContain("- the group chat “Launch”: replying now");
    expect(block).not.toContain("t_1 “Edit the hotel shot”: a task");
  });
});

async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

type Line = Extract<MessagePart, { type: "task" }>;
const textOf = (m: Message) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");

describe("agents knowing what they do (integration)", () => {
  let hub: Hub;
  let base = "";
  let cookie = "";
  let csrf = "";
  let main = "";

  const req = async (method: string, path: string, body?: unknown): Promise<any> => {
    const r = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), origin: base, ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf": csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await r.text();
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${text}`);
    return text ? JSON.parse(text) : undefined;
  };
  const messages = (conversationId: string): Promise<Message[]> => req("GET", `/api/conversations/${conversationId}/messages`);
  const say = (conversationId: string, text: string) => req("POST", `/api/conversations/${conversationId}/messages`, { text });
  const replyTo = (conversationId: string, after: number) =>
    until(async () => (await messages(conversationId)).filter((m) => m.role === "assistant" && m.status === "complete").slice(after)[0], "a reply");

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-self-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    base = config.publicUrl;
    await until(() => hub.brains.has("fake@local"), "fake brains to register");
    await req("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    const boot = await req("GET", "/api/bootstrap");
    csrf = boot.csrf;
    main = boot.mainConversationId;
    await req("PUT", "/api/agents/critic", { name: "Critic", description: "Reviews photos", brains: ["fake@local"], prompt: "Review." });
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("a teammate asked in a thread names the task it is running elsewhere, and the dialog sees it busy", async () => {
    const work = hub.runner.createTask({ agentId: "critic", goal: "edit the hotel shot SLOW", title: "Hotel shot", createdBy: "user", background: false });
    await until(() => hub.store.getTask(work.id)?.status === "running" && hub.runner.isRunning(work.conversationId), "the task to run");

    await say(main, `CALL team_message {"to":"critic","text":"SELF?"}`);
    const answered = await until(
      async () => (await messages(main)).flatMap((m) => m.parts.filter((p): p is Line => p.type === "task" && p.text === "SELF?" && p.reply !== undefined))[0],
      "the critic's reply",
    );
    expect(answered.reply).toMatch(/^fake self: \[You now\]\nThis session: your thread \S+ answering [^,]+, who wrote to you, on the computer "[^"]+" \(the hub's own\)\./);
    expect(answered.reply).toContain(`- ${work.id} “Hotel shot”: a task from the user, on `);
    expect(answered.reply).toContain("; working");
    await until(() => !hub.runner.isRunning(main), "the dialog to settle");

    // The dialog's agent sees the critic busy with it.
    const before = (await messages(main)).filter((m) => m.role === "assistant").length;
    await say(main, "SELF?");
    const own = textOf(await replyTo(main, before));
    expect(own).toMatch(new RegExp(`- critic \\(Critic\\): ${work.id} “Hotel shot”: a task from the user, on [^,]+, since \\d\\d:\\d\\d; working`));
    expect(own).toContain("This session: your dialog with the user");

    // Nothing changed: no block this time, so the brain still holds the last one; it comes again once the task ends.
    hub.runner.cancelTask(work.id);
    await until(() => !hub.runner.isRunning(work.conversationId), "the task to stop");
    const next = (await messages(main)).filter((m) => m.role === "assistant").length;
    await say(main, "SELF?");
    expect(textOf(await replyTo(main, next))).toContain("- critic (Critic): free");
  });

  it("a thread waits in line for the teammate's busy brain, and the sender hears why", async () => {
    hub.settings.update({ brainConcurrency: 1 });
    try {
      const work = hub.runner.createTask({ agentId: "critic", goal: "a long look SLOW", title: "Long look", createdBy: "user", background: false });
      await until(() => hub.runner.isRunning(work.conversationId), "the task to run");
      // As a brain's team_message call would (the assistant's own turn would move to its second brain).
      expect((await hub.runner.messageTeammate("critic", "are you there", { agentId: "assistant", conversationId: main, background: false, tainted: false, nest: true })).ok).toBe(true);
      await until(
        async () => (await messages(main)).find((m) => m.role === "system" && /^\[System\] Critic is busy right now \(working on “Long look”\): your message \(thread \S+\) waits in line/.test(textOf(m))),
        "the busy note",
        8_000,
      );
      hub.runner.cancelTask(work.id);
      const answered = await until(
        async () => (await messages(main)).flatMap((m) => m.parts.filter((p): p is Line => p.type === "task" && p.text === "are you there" && p.reply !== undefined))[0],
        "the critic's reply",
      );
      expect(answered.reply).toBe("fake heard: are you there");
      expect((await messages(main)).some((m) => textOf(m).includes("could not answer"))).toBe(false);
      await until(() => !hub.runner.isRunning(main), "the dialog to settle");
    } finally {
      hub.settings.update({ brainConcurrency: 2 });
    }
  });

  it("messages written in a row while the agent answers reach it together, as one turn", async () => {
    await req("PUT", "/api/agents/slowpoke", { name: "Slowpoke", description: "", brains: ["fake2:a@local"], prompt: "" });
    const c = hub.store.agentConversation("slowpoke").id;
    await say(c, "think about it BRIEF");
    await until(() => hub.runner.isRunning(c), "the turn to start");
    await say(c, "one more thing");
    await say(c, "and the last one");
    await until(async () => (await messages(c)).filter((m) => m.role === "assistant" && m.status === "complete").length >= 2 && !hub.runner.isRunning(c), "the replies");
    await sleep(300);
    const said = (await messages(c)).filter((m) => m.role === "assistant").map(textOf);
    // fake2 cannot take input mid-turn: both messages come as the next turn, its last line the last message.
    expect(said).toEqual(["fake2 is thinking", "fake2 heard: and the last one"]);
  });

  it("a task's report answers the message that asked for it when the user wrote more since", async () => {
    await say(main, `CALL task_delegate {"title":"Look around","goal":"look around BRIEF"}`);
    const asked = (await messages(main)).findLast((m) => m.role === "user")!;
    await until(async () => (await messages(main)).some((m) => m.parts.some((p) => p.type === "task")) && !hub.runner.isRunning(main), "the task line");
    await say(main, "meanwhile, hello");
    const report = await until(async () => (await messages(main)).find((m) => m.role === "assistant" && m.parts[0]?.type === "reply_to" && m.status !== "streaming"), "the report");
    expect(report.parts[0]).toEqual({ type: "reply_to", messageId: asked.id, text: `CALL task_delegate {"title":"Look around","goal":"look around BRIEF"}` });
    expect(textOf(report)).toMatch(/^fake heard: /);
    await until(() => !hub.runner.isRunning(main), "the dialog to settle");
  });

  it("task_agents says who is busy", async () => {
    const r = await hub.tools.get("task_agents")!.invoke({}, { sessionId: "s", agentId: "assistant", callId: "c", tainted: false, background: false, workspace: "", machineId: "local", conversationId: main });
    const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toMatch(/Busy now:\n- assistant \([^)]+\): /);
    expect(text).toContain("- critic (Critic): free");
  });
});
