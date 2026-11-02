// Agents as entry points: input that arrives while an agent works joins its turn (or waits for the next one when the
// brain cannot take it), tasks on the side with a live line both ways (task_ask / task_message), placing a task on a
// computer, the task line in the reply, the open tasks a dialog sees, and the prompt that routes work into tasks.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDef, Message, Task } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { createCoreCall } from "../src/core-call.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { taskResult } from "../src/runner.ts";

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

const textOf = (m: Message) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");

describe("a finished task's report", () => {
  it("reaches its starter whole, and a very long one says where the rest is", () => {
    const report = "Отчёт. ".repeat(1000);
    expect(taskResult({ id: "t_1", result: report })).toBe(report);
    const long = "x".repeat(30_000);
    const cut = taskResult({ id: "t_2", result: long });
    expect(cut.startsWith("x".repeat(24_000) + "\n…[cut at 24000 of 30000 characters")).toBe(true);
    expect(cut).toContain('task_status {"taskId":"t_2"} has the whole result');
    expect(taskResult({ id: "t_3" })).toBe("");
  });
});

describe("agents as entry points (integration)", () => {
  let hub: Hub;
  let web: Client;

  const messages = async (conversationId: string): Promise<Message[]> => web.req("GET", `/api/conversations/${conversationId}/messages`);
  const say = (conversationId: string, text: string) => web.req("POST", `/api/conversations/${conversationId}/messages`, { text });
  const idle = (conversationId: string) => until(async () => !hub.runner.isRunning(conversationId) && (await messages(conversationId)).every((m) => m.status !== "streaming"), "the turn to end");
  const dialogOf = async (agentId: string): Promise<string> => ((await web.req("GET", "/api/team")) as Array<{ agentId: string; conversationId: string }>).find((m) => m.agentId === agentId)!.conversationId;
  const task = (id: string): Promise<Task> => web.req("GET", `/api/tasks/${id}`);
  /** The task the agent's latest reply started (its task line). */
  const startedTask = async (conversationId: string, title: string): Promise<string> =>
    until(async () => {
      const ids = (await messages(conversationId)).flatMap((m) => m.parts.flatMap((p) => (p.type === "task" ? [p.taskId] : [])));
      for (const id of ids.reverse()) if ((await task(id)).title === title) return id;
      return undefined;
    }, `the task line of “${title}”`);

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-dispatch-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    web = new Client(config.publicUrl);
    await until(() => hub.brains.has("fake@local") && hub.brains.has("fake2:a@local"), "fake brains to register");
    await web.req("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    web.csrf = (await web.req("GET", "/api/bootstrap")).csrf;
    // An agent whose brain cannot take input mid-turn.
    await web.req("PUT", "/api/agents/plodder", { name: "Plodder", description: "Takes one thing at a time", brains: ["fake2:a@local"], prompt: "One at a time." });
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("lets a message written while the agent works join its turn, answered after it", async () => {
    const c = (await web.req("GET", "/api/bootstrap")).mainConversationId as string;
    await say(c, "check the build SLOW");
    // At work: its brain has begun to answer (a turn that is still starting its brain gets the message as the next turn).
    await until(async () => (await messages(c)).some((m) => m.role === "assistant" && textOf(m).includes("fake is thinking")), "the agent at work");
    await say(c, "and the tests too");
    await idle(c);
    const ms = (await messages(c)).filter((m) => m.role !== "system");
    const tail = ms.slice(-4).map((m) => [m.role, m.role === "user" ? textOf(m) : textOf(m).trim()]);
    expect(tail).toEqual([
      ["user", "check the build SLOW"],
      ["assistant", "fake is thinking"],
      ["user", "and the tests too"],
      ["assistant", "fake also heard: and the tests too"],
    ]);
    // One turn: nothing queued after it.
    await sleep(500);
    expect((await messages(c)).filter((m) => m.role === "assistant")).toHaveLength(ms.filter((m) => m.role === "assistant").length);
  });

  it("gives the message its own turn when the brain cannot take it mid-turn", async () => {
    const c = await dialogOf("plodder");
    await say(c, "first BRIEF");
    await until(() => hub.runner.isRunning(c), "the turn to start");
    await say(c, "second");
    await until(async () => (await messages(c)).some((m) => m.role === "assistant" && textOf(m) === "fake2 heard: second"), "the second turn");
    await idle(c);
    const answers = (await messages(c)).filter((m) => m.role === "assistant").map(textOf);
    expect(answers).toEqual(["fake2 is thinking", "fake2 heard: second"]);
  });

  it("runs a task on the side that asks its starter, waits for the answer, then reports", async () => {
    const c = (await web.req("GET", "/api/bootstrap")).mainConversationId as string;
    await say(c, `CALL task_delegate {"title":"Deploy","goal":"CALL task_ask {\\"question\\":\\"Which branch?\\"}"}`);
    const id = await startedTask(c, "Deploy");
    const asked = await until(async () => {
      const t = await task(id);
      return t.status === "waiting_input" ? t : undefined;
    }, "the task to wait for its answer");
    expect(asked.question).toBe("Which branch?");
    // The question reached the dialog's agent, who sees the task among the open ones.
    await until(async () => (await messages(c)).some((m) => m.role === "system" && textOf(m).includes(`Task ${id} “Deploy”`) && textOf(m).includes("asks you: Which branch?")), "the question in the dialog");
    await idle(c);
    await say(c, "ECHO?");
    await idle(c);
    expect(textOf((await messages(c)).filter((m) => m.role === "assistant").at(-1)!)).toContain("[Open tasks you started]");

    await say(c, `CALL task_message {"taskId":"${id}","text":"main"}`);
    const done = await until(async () => {
      const t = await task(id);
      return t.status === "done" ? t : undefined;
    }, "the task to finish");
    expect(done.question).toBeUndefined();
    expect(done.result).toContain("who started this task, writes: main");
    await until(async () => (await messages(c)).some((m) => m.role === "system" && textOf(m).startsWith(`[System] Task ${id} “Deploy” is finished.`)), "the result in the dialog");
  });

  it("takes a clarification into a task that is working", async () => {
    const c = (await web.req("GET", "/api/bootstrap")).mainConversationId as string;
    await idle(c);
    await say(c, `CALL task_delegate {"title":"Long check","goal":"look around SLOW"}`);
    const id = await startedTask(c, "Long check");
    const tc = (await task(id)).conversationId;
    await until(async () => (await messages(tc)).some((m) => m.role === "assistant" && textOf(m).includes("fake is thinking")), "the task at work");
    await idle(c);
    await say(c, `CALL task_message {"taskId":"${id}","text":"skip the docs"}`);
    const done = await until(async () => {
      const t = await task(id);
      return t.status === "done" ? t : undefined;
    }, "the task to finish", 8000);
    expect(done.result).toContain("fake also heard: [System]");
    expect(done.result).toContain("writes: skip the docs");
  });

  it("takes a clarification sent as `message`, and sends nothing empty", async () => {
    const c = (await web.req("GET", "/api/bootstrap")).mainConversationId as string;
    await idle(c);
    await say(c, `CALL task_delegate {"title":"Guessed field","goal":"look around SLOW"}`);
    const id = await startedTask(c, "Guessed field");
    const tc = (await task(id)).conversationId;
    await until(async () => (await messages(tc)).some((m) => m.role === "assistant" && textOf(m).includes("fake is thinking")), "the task at work");
    await idle(c);
    await say(c, `CALL task_message {"taskId":"${id}"}`);
    await idle(c);
    expect(textOf((await messages(c)).filter((m) => m.role === "assistant").at(-1)!)).toMatch(/Nothing sent: give `text`/);
    expect((await messages(tc)).some((m) => textOf(m).includes("writes: undefined"))).toBe(false);
    await say(c, `CALL task_message {"taskId":"${id}","message":"use the second way"}`);
    const done = await until(async () => {
      const t = await task(id);
      return t.status === "done" ? t : undefined;
    }, "the task to finish", 8000);
    expect(done.result).toContain("writes: use the second way");
  });

  it("places a task on a computer, or says which computers there are", async () => {
    const c = (await web.req("GET", "/api/bootstrap")).mainConversationId as string;
    await idle(c);
    await say(c, `CALL task_delegate {"title":"Somewhere","goal":"hi","machine":"atlantis"}`);
    await idle(c);
    expect(textOf((await messages(c)).filter((m) => m.role === "assistant").at(-1)!)).toMatch(/No computer "atlantis"\. Computers: .+ \(local\)/);

    await say(c, `CALL task_delegate {"title":"Here","goal":"hi","machine":"local"}`);
    await idle(c);
    const here = ((await web.req("GET", "/api/tasks")) as Task[]).find((t) => t.title === "Here")!;
    expect(here.brainRef).toBe("fake@local");
    // The reply that started it carries its line.
    expect((await messages(c)).some((m) => m.parts.some((p) => p.type === "task" && p.taskId === here.id))).toBe(true);
  });

  it("lets a plugin place a task on a computer (a trigger's runs)", async () => {
    const core = createCoreCall(hub);
    const computers = (await core("triggers", "machines.list", {})) as Array<{ id: string; status: string }>;
    expect(computers[0]).toMatchObject({ id: "local", status: "online" });
    const t = (await core("triggers", "tasks.create", { agentId: "assistant", goal: "measure", title: "Measure", triggerId: "t_m", machine: "local" })) as Task;
    expect(t).toMatchObject({ brainRef: "fake@local", createdBy: "trigger", triggerId: "t_m" });
    await expect(core("triggers", "tasks.create", { agentId: "assistant", goal: "x", machine: "atlantis" })).rejects.toThrow(/No computer "atlantis"/);
    await until(async () => ["done", "failed"].includes((await task(t.id)).status), "the placed task to finish");
  });

  it("tells the dialog's agent how to route work, and a task how to ask back", () => {
    const agent = { id: "assistant", name: "Owl", description: "", brains: [], initiative: 1, tools: ["*"], skills: [], policyProfile: "default", budget: { backgroundRunsPerDay: 5 }, prompt: "", source: "builtin" } as AgentDef;
    const base = { agent, timezone: "UTC", language: "en", consoleUrl: "http://x", background: false, skills: [], nativeSkills: false, appended: [] };
    const dialog = buildSystemPrompt({
      ...base,
      dispatch: {
        team: [
          { id: "assistant", name: "Owl", description: "Helps", where: ["MacBook"] },
          { id: "coder", name: "Coder", description: "Writes code", where: ["Studio"] },
        ],
        computers: [
          { id: "local", name: "MacBook", online: true },
          { id: "m1", name: "Studio", online: false },
        ],
      },
    });
    expect(dialog).toContain("## How you work");
    expect(dialog).toContain("two requests in one message are two tasks");
    expect(dialog).toContain("- coder: Coder — Writes code (on: Studio)");
    expect(dialog).toContain("- m1: Studio (offline when this session started)");
    // A task back without its result is tried again another way before the user hears it failed.
    expect(dialog).toContain("start it again at once another way");
    const inTask = buildSystemPrompt({ ...base, task: { id: "t1", title: "x", createdBy: "agent" } as Task });
    expect(inTask).not.toContain("## How you work");
    expect(inTask).toContain("`task_ask`");
    // An obstacle is a reason to try another way; the person's no is not one to work around.
    expect(inTask).toContain("Try two or three really different ways");
    expect(inTask).toContain("Never work around the person's no");
  });

  it("keeps what an agent with its own files makes in its folder, not on the person's Desktop", () => {
    const agent = { id: "assistant", name: "Owl", description: "", brains: [], initiative: 1, tools: ["*"], skills: [], policyProfile: "default", budget: { backgroundRunsPerDay: 5 }, prompt: "", source: "builtin" } as AgentDef;
    const base = { agent, timezone: "UTC", language: "en", consoleUrl: "http://x", background: false, skills: [], appended: [] };
    const task = { id: "t1", title: "x", createdBy: "agent" } as Task;
    expect(buildSystemPrompt({ ...base, nativeSkills: true, task })).toMatch(/in a task, in the task's own folder\. Never put it on the Desktop/);
    // A brain without files of its own (the API) has nothing to place.
    expect(buildSystemPrompt({ ...base, nativeSkills: false, task })).not.toContain("on the Desktop");
  });
});
