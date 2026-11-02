// How agents think, per kind of work: presets and exact choices resolved on the brain a session runs on, the API the
// header picker, the card and the phone use, the agent's own tools, and continuity when a session is replaced.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDef, Message, Task, ThinkingView } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";

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

describe("how agents think (integration)", () => {
  let hub: Hub;
  let web: Client;
  let dataDir: string;

  const messages = async (conversationId: string): Promise<Message[]> => web.req("GET", `/api/conversations/${conversationId}/messages`);
  const dialogOf = async (agentId: string): Promise<string> => ((await web.req("GET", "/api/team")) as Array<{ agentId: string; conversationId: string }>).find((m) => m.agentId === agentId)!.conversationId;
  const idle = (c: string) => until(async () => !hub.runner.isRunning(c) && (await messages(c)).every((m) => m.status !== "streaming"), "the turn to end");
  /** Say something in the agent's dialog and get its answer. */
  const ask = async (agentId: string, text: string): Promise<string> => {
    const c = await dialogOf(agentId);
    const before = (await messages(c)).filter((m) => m.role === "assistant").length;
    await web.req("POST", `/api/conversations/${c}/messages`, { text });
    const answer = await until(async () => (await messages(c)).filter((m) => m.role === "assistant" && m.status !== "streaming")[before], `the answer to “${text}”`);
    await idle(c);
    return textOf(answer);
  };
  const view = (agentId: string): Promise<ThinkingView> => web.req("GET", `/api/agents/${agentId}/thinking`);
  const set = (agentId: string, kind: string, patch: Record<string, unknown>): Promise<ThinkingView> => web.req("PUT", `/api/agents/${agentId}/thinking/${kind}`, patch);
  const kindOf = (v: ThinkingView, kind: string) => v.kinds.find((k) => k.kind === kind)!;
  const runTask = async (agentId: string, goal: string): Promise<Task> => {
    const t: Task = await web.req("POST", "/api/tasks", { agentId, goal, title: goal });
    return until(async () => {
      const now: Task = await web.req("GET", `/api/tasks/${t.id}`);
      return now.status === "done" || now.status === "failed" ? now : undefined;
    }, `the task “${goal}”`);
  };

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    dataDir = mkdtempSync(join(tmpdir(), "owl-thinking-"));
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir, builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    web = new Client(config.publicUrl);
    await until(() => hub.brains.has("fake@local") && hub.brains.has("fake2:a@local"), "fake brains to register");
    await web.req("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    web.csrf = (await web.req("GET", "/api/bootstrap")).csrf;
    // An agent from before `thinking`: brains and an agent-wide model.
    await web.req("PUT", "/api/agents/sage", { name: "Sage", description: "Thinks", brains: ["fake@local", "fake2:a@local"], model: "smart", prompt: "Think." });
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("keeps an agent from before working as it did", async () => {
    const v = await view("sage");
    expect(v.kinds.map((k) => k.kind)).toEqual(["chat", "task", "feed", "schedule"]);
    expect(kindOf(v, "chat")).toMatchObject({ brain: "fake@local", model: "smart" });
    expect(kindOf(v, "chat").effort).toBeUndefined();
    expect(v.brains[0]).toMatchObject({ ref: "fake@local", ready: true, efforts: ["low", "medium", "high"], models: [{ id: "quick", name: "Quick" }, { id: "smart", name: "Smart" }] });
    expect(await ask("sage", "THINKING?")).toBe("fake thinks: model=smart effort=default");
  });

  it("thinks with the preset chosen in the chat, and tasks follow it until they get their own", async () => {
    let v = await set("sage", "chat", { preset: "deep" });
    expect(kindOf(v, "chat")).toMatchObject({ preset: "deep", model: "smart", effort: "high" });
    expect(kindOf(v, "task")).toMatchObject({ preset: "deep", effort: "high" });
    expect(kindOf(v, "task").own).toBeUndefined();
    // The agent-wide model from before gave way to the choice, in the agent's file too.
    const file = readFileSync(join(dataDir, "agents", "sage.md"), "utf8");
    expect(file).toContain("thinking:");
    expect(file).not.toMatch(/^model:/m);
    expect(await ask("sage", "THINKING?")).toBe("fake thinks: model=smart effort=high");

    v = await set("sage", "task", { preset: "fast" });
    expect(kindOf(v, "task")).toMatchObject({ own: { preset: "fast" }, model: "quick", effort: "low" });
    expect(kindOf(v, "chat").effort).toBe("high");
    expect((await runTask("sage", "THINKING?")).result).toBe("fake thinks: model=quick effort=low");
    // The dialog keeps its own.
    expect(await ask("sage", "THINKING?")).toBe("fake thinks: model=smart effort=high");

    v = await set("sage", "task", { follow: true });
    expect(kindOf(v, "task").own).toBeUndefined();
    expect((await runTask("sage", "THINKING?")).result).toBe("fake thinks: model=smart effort=high");
  });

  it("takes an exact model and effort for the brain they were chosen on, and drops them on another brain", async () => {
    let v = await set("sage", "chat", { model: "quick", effort: "medium" });
    expect(kindOf(v, "chat").own).toEqual({ model: "quick", effort: "medium", brain: "fake@local" });
    expect(await ask("sage", "THINKING?")).toBe("fake thinks: model=quick effort=medium");
    // Another brain answers in the chat: the exact choice was for fake.
    v = await set("sage", "chat", { brain: "fake2:a@local" });
    expect(kindOf(v, "chat")).toMatchObject({ brain: "fake2:a@local", own: { brain: "fake2:a@local" } });
    const agent = ((await web.req("GET", "/api/agents")) as AgentDef[]).find((a) => a.id === "sage")!;
    expect(agent.brains[0]).toBe("fake2:a@local");
    expect(await ask("sage", "THINKING?")).toBe("fake2 thinks: model=default effort=default");
  });

  it("goes on from a recap when a fresh session takes over the conversation, and gives a resuming one a backup", async () => {
    await web.req("PUT", "/api/agents/scout", { name: "Scout", description: "Remembers", brains: ["fake@local", "fake2:a@local"], prompt: "Remember." });
    expect(await ask("scout", "we chose Lisbon for May")).toBe("fake heard: we chose Lisbon for May");
    // The session resumes now: its turns carry the recap, for a brain whose history is gone.
    expect(await ask("scout", "RECAP?")).toBe("fake backup: yes");
    await set("scout", "chat", { brain: "fake2:a@local" });
    const fresh = await ask("scout", "RECAP?");
    expect(fresh).toMatch(/^fake2 started from: \[System\] Your session in this conversation was renewed: you are still Scout/);
    expect(fresh).toContain("User: we chose Lisbon for May");
    expect(fresh).toContain("You: fake heard: we chose Lisbon for May");
    // Nothing about it in the chat: only the two messages and their answers.
    const c = await dialogOf("scout");
    expect((await messages(c)).filter((m) => m.role === "system")).toEqual([]);
  });

  it("lets the agent show the card and change its own choice in the chat", async () => {
    await web.req("PUT", "/api/agents/owl", { name: "Owl", description: "Asks", brains: ["fake@local"], prompt: "Hi." });
    const reply = await ask("owl", 'CALL thinking_set {"kind":"task","preset":"deep"}');
    expect(reply).toContain("tool said: Saved.");
    expect(reply).toContain("task: fake (model Smart, effort high");
    const c = await dialogOf("owl");
    const card = (await messages(c)).flatMap((m) => m.parts).find((p) => p.type === "thinking");
    expect(card).toEqual({ type: "thinking", agentId: "owl" });
    expect(kindOf(await view("owl"), "task").own).toEqual({ preset: "deep" });

    const shown = await ask("owl", "CALL thinking_show {}");
    expect(shown).toContain("chat: fake (model");
    expect(shown).toContain("fake@local (fake): models quick, smart; efforts low, medium, high; presets: fast = quick low; balanced = smart medium; deep = smart high");
    // A model the brain does not have is refused with what it has.
    expect(await ask("owl", 'CALL thinking_set {"model":"huge"}')).toContain("has no model \"huge\". Its models: quick, smart");
  });

  it("lets the hub's default agent set how another agent thinks", async () => {
    expect(await ask("assistant", 'CALL hub_agent_save {"id":"sage","thinking":{"feed":{"preset":"fast"},"dreams":{"preset":"deep"}}}')).toContain("Agent sage updated");
    const v = await view("sage");
    expect(kindOf(v, "feed").own).toEqual({ preset: "fast" });
    expect(kindOf(v, "chat").own).toBeUndefined();
  });

  it("refuses an unknown kind", async () => {
    await expect(set("sage", "dreams", { preset: "fast" })).rejects.toThrow(/400/);
  });
});
