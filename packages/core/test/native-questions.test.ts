// What Claude Code puts to the person through the permission tool (native-questions.ts): AskUserQuestion's questions
// and ExitPlanMode's plan show in the chat as the agent's words with quick replies, and the person's tap or own words
// go back as the call's result, not as a new turn.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "@piomio/testkit";
import type { Message, MessagePart } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { askPlan, askQuestions, parseQuestions, questionChoices, questionText, type PersonAnswer, type Unanswered } from "../src/native-questions.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const words = { several: "Pick several.", approve: "Go ahead", decline: "Don’t", plan: "Go ahead with this plan?" };

async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A person who gives these answers in order, and what they were asked. */
function person(...answers: Array<PersonAnswer | Unanswered>) {
  const asked: Array<{ text: string; options: string[] }> = [];
  return { asked, ask: async (text: string, options: string[]) => (asked.push({ text, options }), answers.shift() ?? "timeout") };
}

describe("a question from the brain's CLI", () => {
  const colour = { question: "Which colour?", header: "Colour", options: [{ label: "Red", description: "Warm" }, { label: "Blue" }], multiSelect: false };
  const size = { question: "Which sizes?", options: ["S", "M", "L"], multiSelect: true };

  it("is read from what the model or a plugin sent: options as {label, description} or bare strings, never fewer than two", () => {
    expect(parseQuestions({ questions: [colour, size, { question: "Alone?", options: [{ label: "Yes" }] }, { options: ["a", "b"] }] })).toEqual([
      { question: "Which colour?", options: [{ label: "Red", description: "Warm" }, { label: "Blue" }], multiSelect: false },
      { question: "Which sizes?", options: [{ label: "S" }, { label: "M" }, { label: "L" }], multiSelect: true },
    ]);
    expect(parseQuestions({})).toEqual([]);
    expect(parseQuestions({ questions: "what?" })).toEqual([]);
  });

  it("shows as the question, what its options mean when they say, and short buttons", () => {
    const [q, many] = parseQuestions({ questions: [colour, size] });
    expect(questionText(q, words.several)).toBe("Which colour?\n\n- **Red**: Warm");
    expect(questionText(many, words.several)).toBe("Which sizes?\n\nPick several.");
    expect(questionChoices(q)).toEqual(["Red", "Blue"]);
    const long = parseQuestions({ questions: [{ question: "Q?", options: ["x".repeat(80), "b"] }] })[0];
    expect(questionChoices(long)[0]).toHaveLength(60);
  });

  it("is allowed with the person's answers filled in: a tapped option's own label, or their words", async () => {
    const p = person({ text: "Blue", choice: 1 }, { text: "S and L" });
    expect(await askQuestions({ questions: [colour, size] }, { ask: p.ask }, words)).toEqual({
      behavior: "allow",
      updatedInput: { questions: [colour, size], answers: { "Which colour?": "Blue", "Which sizes?": "S and L" } },
    });
    expect(p.asked).toEqual([
      { text: "Which colour?\n\n- **Red**: Warm", options: ["Red", "Blue"] },
      { text: "Which sizes?\n\nPick several.", options: ["S", "M", "L"] },
    ]);
  });

  it("is refused with what to do instead when nobody answers: in time, in a task, in the background", async () => {
    const late = await askQuestions({ questions: [colour, size] }, { ask: person({ text: "Red", choice: 0 }, "timeout").ask }, words);
    expect(late).toMatchObject({ behavior: "deny", message: expect.stringMatching(/^Answered so far: "Which colour\?"="Red"\. The person has not answered "Which sizes\?" yet\..*next message/) });
    const task = person();
    expect(await askQuestions({ questions: [colour] }, { ask: task.ask, task: true }, words)).toMatchObject({ behavior: "deny", message: expect.stringContaining("task_ask") });
    expect(task.asked).toEqual([]);
    expect(await askQuestions({ questions: [colour] }, {}, words)).toMatchObject({ behavior: "deny", message: expect.stringContaining("Nobody is in this conversation") });
    expect(await askQuestions({ questions: [colour] }, { ask: person("nobody").ask }, words)).toMatchObject({ behavior: "deny", message: expect.stringContaining("Nobody is in this conversation") });
    expect(await askQuestions({ questions: [] }, { ask: person().ask }, words)).toMatchObject({ behavior: "deny", message: expect.stringContaining("Nothing to ask") });
  });
});

describe("a plan from the brain's CLI", () => {
  const plan = { plan: "# Plan\n1. Write hello.txt", planFilePath: "/tmp/p.md" };

  it("goes to the person, who approves it, declines it or says what to change", async () => {
    const yes = person({ text: "Go ahead", choice: 0 });
    expect(await askPlan(plan, { ask: yes.ask }, words)).toEqual({ behavior: "allow", updatedInput: plan });
    expect(yes.asked).toEqual([{ text: plan.plan, options: ["Go ahead", "Don’t"] }]);
    expect(await askPlan(plan, { ask: person({ text: "Don’t", choice: 1 }).ask }, words)).toMatchObject({ behavior: "deny", message: expect.stringContaining("declined the plan") });
    expect(await askPlan(plan, { ask: person({ text: "skip step 2" }).ask }, words)).toMatchObject({ behavior: "deny", message: expect.stringContaining('"skip step 2"') });
    expect(await askPlan(plan, { ask: person("timeout").ask }, words)).toMatchObject({ behavior: "deny", message: expect.stringContaining("call ExitPlanMode again") });
  });

  it("is the plan the agent put in the call when its CLI saved none; with none to see, the agent writes it in its reply first", async () => {
    const inCall = person({ text: "Go ahead", choice: 0 });
    expect(await askPlan({}, { ask: inCall.ask }, words, { written: "1. Write hello.txt" })).toEqual({ behavior: "allow", updatedInput: {} });
    const unseen = person();
    expect(await askPlan({}, { ask: unseen.ask }, words, { written: 7 })).toMatchObject({ behavior: "deny", message: expect.stringContaining("Write the plan out in your reply") });
    expect(unseen.asked).toEqual([]);
    const inReply = person({ text: "Go ahead", choice: 0 });
    expect(await askPlan({}, { ask: inReply.ask }, words, { inReply: true })).toEqual({ behavior: "allow", updatedInput: {} });
    expect([...inCall.asked, ...inReply.asked].map((a) => a.text)).toEqual(["1. Write hello.txt", "Go ahead with this plan?"]);
  });

  it("is left to the hub's usual decision where nobody is there to read it", async () => {
    const p = person();
    expect(await askPlan(plan, { ask: p.ask, task: true }, words)).toBeUndefined();
    expect(await askPlan(plan, {}, words)).toBeUndefined();
    expect(await askPlan(plan, { ask: person("nobody").ask }, words)).toBeUndefined();
    expect(p.asked).toEqual([]);
  });
});

describe("questions and plans in the chat (integration)", () => {
  let hub: Hub;
  let main = "";
  const colour = { question: "Which colour?", header: "Colour", options: [{ label: "Red", description: "Warm" }, { label: "Blue" }], multiSelect: false };

  const messages = () => hub.store.listMessages(main, { limit: 200 });
  const texts = (m: Message) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
  const choices = (m: Message) => m.parts.find((p): p is Extract<MessagePart, { type: "choices" }> => p.type === "choices");
  const idle = () => until(() => !hub.runner.isRunning(main), "the turn to end");

  /** A turn of the dialog that stays open (the fake brain's "SLOW"), and its session. */
  const turn = async () => {
    await idle();
    const before = messages().length;
    await hub.runner.userMessage(main, "think SLOW");
    await until(() => messages().slice(before).some((m) => m.role === "assistant" && texts(m).includes("fake is thinking")), "the turn to start");
    return hub.store.activeSession(main, "assistant")!.id;
  };
  /** The brain's CLI asks through the permission tool, as the session of the running turn. */
  const ask = async (session: string, tool_name: string, input: unknown, over: { taskId?: string; background?: boolean } = {}) => {
    const r = await hub.tools.get("native_permission")!.invoke(
      { tool_name, input, tool_use_id: "t1" },
      { sessionId: session, agentId: "assistant", callId: "c", tainted: false, background: !!over.background, workspace: join(hub.config.dataDir, "workspaces", "assistant", main), machineId: "local", conversationId: main, ...(over.taskId ? { taskId: over.taskId } : {}) },
    );
    return JSON.parse(r.content.map((c) => (c.type === "text" ? c.text : "")).join("")) as { behavior: string; updatedInput?: unknown; message?: string };
  };
  /** The message with unanswered buttons for these options. */
  const buttons = (options: string[]) =>
    until(() => messages().find((m) => JSON.stringify(choices(m)?.options) === JSON.stringify(options) && choices(m)!.chosen === undefined), `the buttons ${options.join("/")}`);

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const dataDir = mkdtempSync(join(tmpdir(), "owl-questions-"));
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir, builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    main = hub.store.agentConversation(hub.settings.get().defaultAgent).id;
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("shows the question under the reply with buttons; a tap is the answer, and the turn goes on without a new one", async () => {
    const session = await turn();
    const call = ask(session, "AskUserQuestion", { questions: [colour] });
    const asked = await buttons(["Red", "Blue"]);
    expect(texts(asked)).toBe("fake is thinking\n\nWhich colour?\n\n- **Red**: Warm");

    const sent = await hub.runner.choose(asked.id, 1, "web");
    expect(sent).toMatchObject({ role: "user", parts: [{ type: "text", text: "Blue" }] });
    expect(await call).toEqual({ behavior: "allow", updatedInput: { questions: [colour], answers: { "Which colour?": "Blue" } } });
    expect(choices(hub.store.getMessage(asked.id)!)!.chosen).toBe(1);
    expect(hub.store.getMessage(asked.id)!.status).toBe("complete");
    // The same turn is still running: the answer was the call's result, not more input and not a turn of its own.
    expect(hub.runner.isRunning(main)).toBe(true);
    hub.runner.interrupt(main);
    await idle();
    expect(messages().filter((m) => m.role === "assistant").map(texts).join("\n")).not.toMatch(/heard/);
    expect(hub.audit.list({ limit: 20 }).find((e) => e.action === "native.question")).toMatchObject({ target: "AskUserQuestion", data: { sessionId: session, answered: true } });
  });

  it("takes the person's own words as the answer: the buttons rest on the option they named, or go", async () => {
    const session = await turn();
    const call = ask(session, "AskUserQuestion", { questions: [colour, { question: "How big?", options: ["Small", "Large"] }] });
    const first = await buttons(["Red", "Blue"]);
    await hub.runner.userMessage(main, "red");
    const second = await buttons(["Small", "Large"]);
    expect(second.id).not.toBe(first.id);
    expect(texts(second)).toBe("How big?");
    await hub.runner.userMessage(main, "about a metre");
    expect(await call).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Which colour?": "Red", "How big?": "about a metre" } } });
    expect(choices(hub.store.getMessage(first.id)!)!.chosen).toBe(0);
    expect(choices(hub.store.getMessage(second.id)!)).toBeUndefined();
    hub.runner.interrupt(main);
    await idle();
  });

  it("shows a plan the same way: approved with a tap, sent back with the person's words", async () => {
    const plan = { plan: "# Plan\n\n1. Write hello.txt\n2. Read it back", planFilePath: "/tmp/plan.md" };
    const session = await turn();
    const call = ask(session, "ExitPlanMode", plan);
    const shown = await buttons(["Go ahead", "Don’t"]);
    expect(texts(shown)).toBe(`fake is thinking\n\n${plan.plan}`);
    await hub.runner.choose(shown.id, 0, "web");
    expect(await call).toEqual({ behavior: "allow", updatedInput: plan });

    const again = ask(session, "ExitPlanMode", plan);
    await buttons(["Go ahead", "Don’t"]);
    await hub.runner.userMessage(main, "only the first step");
    expect(await again).toMatchObject({ behavior: "deny", message: expect.stringContaining('"only the first step"') });

    // A dialog's brain writes no files, so its CLI saves no plan: the agent is told once to write it in its reply,
    // and its next call asks the person about that.
    expect(await ask(session, "ExitPlanMode", {})).toMatchObject({ behavior: "deny", message: expect.stringContaining("Write the plan out in your reply") });
    const written = ask(session, "ExitPlanMode", {});
    const under = await buttons(["Go ahead", "Don’t"]);
    expect(texts(under)).toBe("Go ahead with this plan?");
    await hub.runner.choose(under.id, 0, "web");
    expect(await written).toEqual({ behavior: "allow", updatedInput: {} });
    hub.runner.interrupt(main);
    await idle();
  });

  it("does not hold a task, background work or a finished turn: the question is refused, the plan goes through", async () => {
    const session = await turn();
    const before = messages().length;
    expect(await ask(session, "AskUserQuestion", { questions: [colour] }, { taskId: "t_1" })).toMatchObject({ behavior: "deny", message: expect.stringContaining("task_ask") });
    expect(await ask(session, "AskUserQuestion", { questions: [colour] }, { background: true })).toMatchObject({ behavior: "deny", message: expect.stringContaining("Nobody is in this conversation") });
    expect(await ask(session, "ExitPlanMode", { plan: "p" }, { taskId: "t_1" })).toEqual({ behavior: "allow", updatedInput: { plan: "p" } });
    expect(messages().slice(before).some((m) => choices(m))).toBe(false);

    // The person stops the turn under a question: nobody waits for the answer any more.
    const call = ask(session, "AskUserQuestion", { questions: [colour] });
    await buttons(["Red", "Blue"]);
    hub.runner.interrupt(main);
    expect(await call).toMatchObject({ behavior: "deny", message: expect.stringContaining("Nobody is in this conversation") });
    await idle();
    expect(await ask(session, "AskUserQuestion", { questions: [colour] })).toMatchObject({ behavior: "deny" });
    expect(await ask(session, "ExitPlanMode", { plan: "p" })).toEqual({ behavior: "allow", updatedInput: { plan: "p" } });
  });

  it("leaves the buttons when the person does not answer in time: a later tap is their next message", async () => {
    const session = await turn();
    expect(await hub.runner.askPerson(main, session, "Tea or coffee?", ["Tea", "Coffee"], 30)).toBe("timeout");
    const asked = await buttons(["Tea", "Coffee"]);
    hub.runner.interrupt(main);
    await idle();
    await hub.runner.choose(asked.id, 0, "web");
    await until(() => messages().some((m) => m.role === "assistant" && texts(m).includes("fake heard: Tea")), "the reply to the late answer");
    await idle();
  });
});
