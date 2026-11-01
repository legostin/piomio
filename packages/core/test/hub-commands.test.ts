// The hub's own commands (docs/superpowers/specs/2026-11-01-hub-commands-design.md): the composer's list, "/task",
// "/brain", "/effort", "/archive" answered without the model, "/schedule" as a request to the agent, and "/goal": a
// task that keeps going round after round until goal_report, pauses every GOAL_ROUNDS rounds and on the person's word.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, MessagePart, Task, ThinkingView } from "@piomio/shared";
import { GOAL_ROUNDS, goalControl, goalLimit, parseCommand } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { findBrain, findEffort, findPreset } from "../src/commands.ts";
import { goalPrompt } from "../src/prompt.ts";

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

async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 20_000): Promise<T> {
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
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<any> {
    const r = await fetch(this.base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        origin: this.base,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf ? { "x-csrf": this.csrf } : {}),
        ...headers,
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

describe("commands, parsed", () => {
  it("reads the name and the words, Telegram's /name@bot too", () => {
    expect(parseCommand("/task find a flat")).toEqual({ name: "task", args: "find a flat" });
    expect(parseCommand("/Brain")).toEqual({ name: "brain", args: "" });
    expect(parseCommand("/goal@piomio_bot  ship it \n today")).toEqual({ name: "goal", args: "ship it \n today" });
    expect(parseCommand("not /task")).toBeUndefined();
    expect(parseCommand("/")).toBeUndefined();
  });

  it("tells a goal's control words from a goal", () => {
    expect(goalControl("пауза")).toBe("pause");
    expect(goalControl("Resume")).toBe("resume");
    expect(goalControl("сбросить")).toBe("clear");
    expect(goalControl("stop smoking")).toBeUndefined();
    expect(goalLimit(0)).toBe(GOAL_ROUNDS);
    expect(goalLimit(GOAL_ROUNDS - 1)).toBe(GOAL_ROUNDS);
    expect(goalLimit(GOAL_ROUNDS)).toBe(2 * GOAL_ROUNDS);
  });

  it("finds a brain, a depth and an effort by the person's words", () => {
    const brain = (ref: string, label: string, ready = true) => ({ ref, label, ready, models: [], efforts: [], presets: {} });
    const list = [brain("claude-code@local", "Claude Code", false), brain("codex@local", "Codex"), brain("api:anthropic@local", "Claude API")];
    expect(findBrain(list, "codex")?.ref).toBe("codex@local");
    expect(findBrain(list, "Claude")?.ref).toBe("api:anthropic@local");
    expect(findBrain(list, "claude code")?.ref).toBe("claude-code@local");
    expect(findBrain(list, "gemini")).toBeUndefined();
    expect(findPreset("глубоко")).toBe("deep");
    expect(findPreset("Fast")).toBe("fast");
    expect(findPreset("high")).toBeUndefined();
    expect(findEffort(["low", "high"], "высокая")).toBe("high");
    expect(findEffort(["low", "high"], "xhigh")).toBeUndefined();
  });
});

describe("a goal's prompt", () => {
  it("explains the loop in its first round, says which round it is after, and ends with the goal", () => {
    const first = goalPrompt({ goal: "ship it", rounds: 0 }, true, GOAL_ROUNDS);
    expect(first).toContain("goal_report");
    expect(first.endsWith("The goal:\nship it")).toBe(true);
    const later = goalPrompt({ goal: "ship it", rounds: 4 }, false, GOAL_ROUNDS);
    expect(later.startsWith(`Round 5 of ${GOAL_ROUNDS}.`)).toBe(true);
    expect(later.endsWith("ship it")).toBe(true);
  });
});

describe("the hub's commands (integration)", () => {
  let hub: Hub;
  let web: Client;
  let dialog: string;

  const messages = async (conversationId: string): Promise<Message[]> => web.req("GET", `/api/conversations/${conversationId}/messages`);
  const say = (conversationId: string, text: string) => web.req("POST", `/api/conversations/${conversationId}/messages`, { text });
  const task = (id: string): Promise<Task> => web.req("GET", `/api/tasks/${id}`);
  const thinking = (agentId: string): Promise<ThinkingView> => web.req("GET", `/api/agents/${agentId}/thinking`);
  /** The hub's answer to the latest command: the parts of the newest system message. */
  const answer = (conversationId: string): Promise<MessagePart[]> =>
    until(async () => (await messages(conversationId)).filter((m) => m.role === "system").at(-1)?.parts, "the hub's answer");
  /** Says a command and waits for the hub's answer to it (a new system message). */
  const command = async (conversationId: string, text: string): Promise<MessagePart[]> => {
    const before = (await messages(conversationId)).filter((m) => m.role === "system").length;
    await say(conversationId, text);
    return until(async () => {
      const sys = (await messages(conversationId)).filter((m) => m.role === "system");
      return sys.length > before ? sys.at(-1)!.parts : undefined;
    }, `the answer to ${text}`);
  };
  const taskOf = (parts: MessagePart[]): string => {
    const p = parts.find((x) => x.type === "task");
    if (!p || p.type !== "task") throw new Error(`no task line in ${JSON.stringify(parts)}`);
    return p.taskId;
  };

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "piomio-commands-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    web = new Client(config.publicUrl);
    await until(() => hub.brains.has("fake@local") && hub.brains.has("fake2:a@local"), "fake brains to register");
    await web.req("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    web.csrf = (await web.req("GET", "/api/bootstrap")).csrf;
    dialog = ((await web.req("GET", "/api/team")) as Array<{ agentId: string; conversationId: string }>).find((m) => m.agentId === "assistant")!.conversationId;
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("lists its own commands first, in the reader's language, with a hint for their words", async () => {
    const en = (await web.req("GET", "/api/commands", undefined, { "accept-language": "en" })) as Array<{ name: string; description: string; source: string; args?: string }>;
    expect(en.slice(0, 6).map((c) => c.name)).toEqual(["task", "goal", "schedule", "brain", "effort", "archive"]);
    expect(en[0]).toEqual({ name: "task", description: "Start a task for the agent", source: "hub", args: "what to do" });
    expect(en.find((c) => c.name === "brain")?.args).toBeUndefined();
    const ru = (await web.req("GET", "/api/commands", undefined, { "x-locale": "ru", "accept-language": "ru" })) as Array<{ name: string; description: string }>;
    expect(ru[0].description).toBe("Дать агенту задачу");
  });

  it("/task starts a task for the agent with its line in the chat; without words it says what to write", async () => {
    const hint = await command(dialog, "/task");
    expect(hint[0]).toMatchObject({ type: "note" });
    const parts = await command(dialog, "/task check the weather");
    const id = taskOf(parts);
    const t = await task(id);
    expect(t).toMatchObject({ agentId: "assistant", title: "check the weather", goal: "check the weather", createdBy: "user", parentConversationId: dialog });
    await until(async () => (await task(id)).status === "done", "the task to finish");
    // The command itself never reached the model: the dialog's agent did not answer it.
    const assistant = (await messages(dialog)).filter((m) => m.role === "assistant");
    expect(assistant.some((m) => JSON.stringify(m.parts).includes("/task"))).toBe(false);
  });

  it("/brain shows the brains and switches by name", async () => {
    const menu = await command(dialog, "/brain");
    expect(menu[0]).toEqual({ type: "thinking", agentId: "assistant", focus: "brain" });
    const unknown = await command(dialog, "/brain gemini");
    expect(unknown[0]).toMatchObject({ type: "note" });
    await command(dialog, "/brain fake2");
    expect((await thinking("assistant")).kinds.find((k) => k.kind === "chat")?.brain).toMatch(/^fake2:/);
    await command(dialog, "/brain fake");
    expect((await thinking("assistant")).kinds.find((k) => k.kind === "chat")?.brain).toBe("fake@local");
  });

  it("/effort shows the depth and sets a preset or the brain's exact effort", async () => {
    const menu = await command(dialog, "/effort");
    expect(menu[0]).toEqual({ type: "thinking", agentId: "assistant", focus: "effort" });
    await command(dialog, "/effort deep");
    expect(hub.agents.get("assistant")?.thinking?.chat).toMatchObject({ preset: "deep" });
    await command(dialog, "/effort low");
    // From the preset the model stays the one it gave (deep: smart); the effort is exact, on the brain it was set for.
    expect(hub.agents.get("assistant")?.thinking?.chat).toMatchObject({ effort: "low", model: "smart", brain: "fake@local" });
    const wrong = await command(dialog, "/effort turbo");
    expect(wrong[0]).toMatchObject({ type: "note" });
    await command(dialog, "/effort auto");
  });

  it("/archive answers with the archive card", async () => {
    expect(await command(dialog, "/archive")).toEqual([{ type: "agent_archive", agentId: "assistant" }]);
  });

  it("/schedule goes to the agent as a request to set one up", async () => {
    await say(dialog, "/schedule every morning at nine, the weather");
    const reply = await until(async () => (await messages(dialog)).find((m) => m.role === "assistant" && JSON.stringify(m.parts).includes("when it runs")), "the agent's reply");
    expect(JSON.stringify(reply.parts)).toContain("Then say in one line when it runs.");
    expect((await messages(dialog)).some((m) => m.role === "user" && JSON.stringify(m.parts).includes("/schedule every morning at nine"))).toBe(true);
  });

  it("/goal ends when the agent reports it reached", async () => {
    const id = taskOf(await command(dialog, '/goal CALL goal_report {"status":"achieved","summary":"all set"}'));
    expect((await task(id)).kind).toBe("goal");
    const done = await until(async () => {
      const t = await task(id);
      return t.status === "done" ? t : undefined;
    }, "the goal to be reached");
    expect(done).toMatchObject({ result: "all set", rounds: 1 });
  });

  it("/goal goes on round after round, pauses at its rounds, resumes and clears; a new one replaces the old", async () => {
    const id = taskOf(await command(dialog, "/goal keep the notes tidy"));
    const paused = await until(
      async () => {
        const t = await task(id);
        return t.status === "paused" ? t : undefined;
      },
      "the goal to pause at its rounds",
      60_000,
    );
    expect(paused.rounds).toBe(GOAL_ROUNDS);
    // A reply for each round, each one to the goal itself.
    const replies = (await messages(paused.conversationId)).filter((m) => m.role === "assistant");
    expect(replies.length).toBe(GOAL_ROUNDS);
    expect(JSON.stringify(replies.at(-1)!.parts)).toContain("heard: keep the notes tidy");
    // The person hears that it paused.
    const notice = await until(async () => (await messages(dialog)).find((m) => m.parts.some((p) => p.type === "notification" && p.title.includes("keep the notes tidy"))), "the pause notice");
    expect(notice).toBeTruthy();

    expect(taskOf(await command(dialog, "/goal"))).toBe(id);
    await command(dialog, "/goal resume");
    await until(async () => ((await task(id)).rounds ?? 0) > GOAL_ROUNDS, "a round after resuming");
    await command(dialog, "/goal clear");
    await until(async () => (await task(id)).status === "cancelled", "the goal to be cleared");
    const rounds = (await task(id)).rounds;
    await sleep(500);
    expect((await task(id)).rounds).toBe(rounds);

    const first = taskOf(await command(dialog, "/goal first one SLOW"));
    const second = taskOf(await command(dialog, "/goal second one SLOW"));
    expect((await task(first)).status).toBe("cancelled");
    await command(dialog, "/goal clear");
    await until(async () => (await task(second)).status === "cancelled", "the second goal to be cleared");
  }, 90_000);

  it("/goal pause stops a running round and the goal stays paused until resumed", async () => {
    const id = taskOf(await command(dialog, "/goal look around SLOW"));
    await until(async () => (await task(id)).status === "running", "the goal to run");
    await command(dialog, "/goal pause");
    await until(async () => !hub.runner.isRunning((await task(id)).conversationId), "the round to stop");
    await sleep(300);
    expect((await task(id)).status).toBe("paused");
    await command(dialog, "/goal resume");
    await until(async () => (await task(id)).status === "running", "the goal to run again");
    await command(dialog, "/goal clear");
  });

  it("a blocked goal asks the person and goes on with their answer", async () => {
    const id = taskOf(await command(dialog, '/goal CALL goal_report {"status":"blocked","summary":"Which city?"}'));
    const waiting = await until(async () => {
      const t = await task(id);
      return t.status === "waiting_input" ? t : undefined;
    }, "the goal to wait for the person");
    expect(waiting.question).toBe("Which city?");
    await say(waiting.conversationId, "Kazan");
    await until(async () => ((await task(id)).rounds ?? 0) >= 2, "a round with the answer");
    await command(dialog, "/goal clear");
  });

  it("in a group chat the lead takes a task; how one agent thinks is set in its own chat", async () => {
    await web.req("PUT", "/api/agents/helper", { name: "Helper", description: "Helps", brains: ["fake@local"], prompt: "Help." });
    const g = await web.req("POST", "/api/conversations", { kind: "group", members: ["assistant", "helper"] });
    const note = await command(g.id, "/brain");
    expect(note[0]).toMatchObject({ type: "note" });
    const id = taskOf(await command(g.id, "/task tidy up"));
    expect((await task(id)).agentId).toBe("assistant");
  });

  it("answers in words, with a link, on the channel the command came from", async () => {
    const sent: Array<{ text: string; link?: string }> = [];
    hub.channels.register("phone", "Phone", "phone-test", { closed: false, request: async (_m: string, p: any) => (sent.push(p.message), {}) } as any);
    try {
      await hub.runner.userMessage(dialog, "/brain", { channel: "phone" });
      const said = await until(() => sent.at(-1), "the channel's answer");
      expect(said.text).toMatch(/^Тестовый ассистент thinks with fake\. Brains: /);
      expect(said.link).toMatch(/\/agent\/assistant$/);
      expect((await answer(dialog))[0]).toMatchObject({ type: "thinking", focus: "brain" });
    } finally {
      hub.channels.unregisterPlugin("phone-test");
    }
  });
});
