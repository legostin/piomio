// A session's life in the hub (docs/superpowers/specs/2026-11-18-session-life-design.md): a dialog whose history grew
// past the cap, or whose cache went cold with a long history, starts afresh from the recap; otherwise it keeps the
// system prompt it started with, and a new work rule or teammate comes as a message. A task keeps its history and gets
// the window at which its brain compacts it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const textOf = (m: Message) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

describe("a session's life (integration)", () => {
  let hub: Hub;
  let config: ReturnType<typeof loadConfig>;

  const start = async () => {
    hub = new Hub(config);
    await hub.start();
    await until(() => hub.brains.has("fake@local"), "the fake brain to register");
  };

  /** A new agent with one brain, and its dialog. */
  const agent = (id: string) => {
    hub.agents.save({ id, name: id[0].toUpperCase() + id.slice(1), description: `The ${id} one`, brains: ["fake@local"], tools: ["*"], skills: ["*"], prompt: "Hi.", initiative: 1 } as any);
    return hub.store.agentConversation(id).id;
  };

  /** Say something in the agent's dialog and get its answer. */
  const ask = async (agentId: string, text: string): Promise<string> => {
    const c = hub.store.agentConversation(agentId).id;
    const before = hub.store.listMessages(c, { limit: 500 }).filter((m) => m.role === "assistant").length;
    await hub.runner.userMessage(c, text, { channel: "web" });
    const answer = await until(() => hub.store.listMessages(c, { limit: 500 }).filter((m) => m.role === "assistant" && m.status !== "streaming")[before], `the answer to “${text}”`);
    await until(() => !hub.runner.isRunning(c), "the turn to end");
    return textOf(answer);
  };

  const session = (agentId: string) => hub.store.activeSession(hub.store.agentConversation(agentId).id, agentId)!;
  const taskDone = (id: string) => until(() => (hub.store.getTask(id)?.status === "done" ? hub.store.getTask(id) : undefined), "the task");

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const dataDir = mkdtempSync(join(tmpdir(), "piomio-session-life-"));
    config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir, builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    await start();
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("knows how big a session is, and starts a dialog afresh from the recap once its history is past the cap", async () => {
    agent("big");
    expect(await ask("big", "CONTEXT 30000")).toBe("fake heard: CONTEXT 30000");
    const first = session("big");
    // The first call of a life is its base: the instructions and tools, not history.
    expect(first).toMatchObject({ contextTokens: 30_000, baseTokens: 30_000, resumeToken: "fake-resume" });
    expect(first.systemPrompt).toContain("Hi.");
    expect(Date.now() - Date.parse(first.usedAt!)).toBeLessThan(10_000);
    // 120k of history is the cap: not past it yet.
    await ask("big", "CONTEXT 150000");
    expect(await ask("big", "RECAP?")).toBe("fake backup: yes");
    await ask("big", "CONTEXT 150001");
    expect(session("big")).toMatchObject({ contextTokens: 150_001, baseTokens: 30_000 });
    expect(await ask("big", "RECAP?")).toMatch(/^fake started from: \[System\] Your session in this conversation was renewed/);
    // The same session row, a conversation of its own again, its size not known until its brain says.
    const renewed = session("big");
    expect(renewed.id).toBe(first.id);
    expect(renewed.contextTokens).toBeUndefined();
    expect(renewed.baseTokens).toBeUndefined();
    expect(await ask("big", "OPENS?")).toBe("fake opens: 2");
    expect(await ask("big", "RECAP?")).toBe("fake backup: yes");
    // Where the tokens went, by day: the cache's share apart.
    const used = hub.store.db.prepare("select tokens, output, cache_read, cache_write from usage where agent_id = 'big' and kind = 'turn'").get();
    expect(used).toEqual({ tokens: 330_001 + 21, output: 21, cache_read: 330_001 - 300, cache_write: 180 });
  });

  it("follows the person's cap", async () => {
    agent("capped");
    hub.updateSettings({ dialogContextCap: 50_000 }, "user");
    try {
      await ask("capped", "CONTEXT 30000");
      await ask("capped", "CONTEXT 81000");
      expect(await ask("capped", "RECAP?")).toMatch(/^fake started from:/);
    } finally {
      hub.updateSettings({ dialogContextCap: 120_000 }, "user");
    }
    expect(() => hub.updateSettings({ dialogContextCap: 19_999 }, "user")).toThrow(/20000/);
    expect(() => hub.updateSettings({ taskContextCap: 99_999 }, "user")).toThrow(/100000/);
    expect(() => hub.updateSettings({ recapMaxChars: 2.5 }, "user")).toThrow(/4000/);
    expect(hub.settings.get()).toMatchObject({ dialogContextCap: 120_000, taskContextCap: 200_000, recapMaxChars: 16_000 });
  });

  it("starts afresh after a quiet hour when the history is long, and resumes a short one with a new prompt", async () => {
    agent("long");
    await ask("long", "CONTEXT 30000");
    await ask("long", "CONTEXT 71000");
    // Warm, 41k of history: goes on as it is.
    expect(await ask("long", "RECAP?")).toBe("fake backup: yes");
    hub.store.updateSession(session("long").id, { usedAt: hoursAgo(2) });
    expect(await ask("long", "RECAP?")).toMatch(/^fake started from:/);

    agent("short");
    await ask("short", "CONTEXT 30000");
    await ask("short", "CONTEXT 69000");
    hub.store.updateSession(session("short").id, { usedAt: hoursAgo(2) });
    // Its brain is opened again (the prompt as it is now), and resumes: nothing is forgotten.
    expect(await ask("short", "RECAP?")).toBe("fake backup: yes");
    expect(await ask("short", "OPENS?")).toBe("fake opens: 2");
    expect(session("short")).toMatchObject({ contextTokens: 69_000, baseTokens: 30_000 });
  });

  it("tells a dialog about a new work rule or teammate in a message: the same session, the prompt it started with", async () => {
    agent("ruled");
    expect(await ask("ruled", "INPUT?")).not.toContain("changed since this session started");
    const rule = hub.runner.rules.set({ when: "renders of the garden", brain: "fake" })!;
    const input = await ask("ruled", "INPUT?");
    expect(input).toContain("[Your team and rules now] These changed since this session started;");
    expect(input).toContain(`- ${rule.id}: renders of the garden → brain fake`);
    expect(input).toContain("- ruled: Ruled (you) — The ruled one");
    // Told once.
    expect(await ask("ruled", "INPUT?")).not.toContain("changed since this session started");
    agent("joiner");
    expect(await ask("ruled", "INPUT?")).toContain("- joiner: Joiner — The joiner one");
    hub.runner.rules.remove(rule.id);
    const after = await ask("ruled", "INPUT?");
    expect(after).toContain("changed since this session started");
    expect(after).not.toContain("renders of the garden");
    // Through all of it: one brain process, and its system prompt knows neither the rule nor the newcomer.
    expect(await ask("ruled", "OPENS?")).toBe("fake opens: 1");
    expect(await ask("ruled", "SYSTEM? renders of the garden")).toBe("fake system: no");
    expect(await ask("ruled", "SYSTEM? joiner")).toBe("fake system: no");
    // A session that starts now has them in its prompt, and no note.
    hub.runner.rules.set({ when: "letters to the bank", brain: "fake" });
    agent("newer");
    expect(await ask("newer", "INPUT?")).not.toContain("changed since this session started");
    expect(await ask("newer", "SYSTEM? letters to the bank")).toBe("fake system: yes");
  });

  it("gives a session the prompt it started with after the hub restarts", async () => {
    agent("steady");
    await ask("steady", "hello");
    const before = session("steady");
    agent("latecomer");
    await hub.stop();
    await start();
    // A plugin's part of the prompt (memory's facts about the person), with what it holds as told to the session.
    const told: string[] = [];
    hub.hooks.register("session.start", "test", async (p) => {
      told.push((p as { sessionId: string }).sessionId);
      return { appendSystemPrompt: "A fact learned meanwhile." };
    });
    // What changed meanwhile comes as a message; the prompt is the stored one, so the provider's cache still fits.
    expect(await ask("steady", "INPUT?")).toContain("- latecomer: Latecomer — The latecomer one");
    expect(await ask("steady", "SYSTEM? latecomer")).toBe("fake system: no");
    expect(await ask("steady", "RECAP?")).toBe("fake backup: yes");
    expect(session("steady")).toMatchObject({ id: before.id, systemPrompt: before.systemPrompt, stamp: before.stamp });
    // Nothing was written into the kept prompt, so no plugin was asked for its part of it.
    expect(told).toEqual([]);
    // An edited agent is another matter: its instructions are in the prompt, and so is the plugin's part.
    hub.agents.save({ ...hub.agents.get("steady")!, prompt: "Be brief." } as any);
    expect(await ask("steady", "SYSTEM? Be brief.")).toBe("fake system: yes");
    expect(await ask("steady", "SYSTEM? A fact learned meanwhile.")).toBe("fake system: yes");
    expect(told).toEqual([before.id]);
    expect(session("steady").stamp).not.toBe(before.stamp);
  });

  it("never starts a task afresh, and gives its brain the window to compact its history at", async () => {
    agent("worker");
    const task = hub.runner.createTask({ agentId: "worker", title: "w", goal: "WINDOW?", createdBy: "user", background: false });
    expect((await taskDone(task.id)).result).toBe("fake window: 200000");
    // A dialog has none: the hub renews it from the recap instead.
    expect(await ask("worker", "WINDOW?")).toBe("fake window: none");
    hub.updateSettings({ taskContextCap: 300_000 }, "user");
    try {
      const next = hub.runner.createTask({ agentId: "worker", title: "w2", goal: "WINDOW?", createdBy: "user", background: false });
      expect((await taskDone(next.id)).result).toBe("fake window: 300000");
    } finally {
      hub.updateSettings({ taskContextCap: 200_000 }, "user");
    }
    // A task far past the dialogs' cap, cold: it resumes with all it knows.
    const heavy = hub.runner.createTask({ agentId: "worker", title: "h", goal: "CONTEXT 450000", createdBy: "user", background: false });
    await taskDone(heavy.id);
    const row = hub.store.activeSession(heavy.conversationId, "worker")!;
    expect(row).toMatchObject({ contextTokens: 450_000 });
    hub.store.updateSession(row.id, { usedAt: hoursAgo(20) });
    const answers = () => hub.store.listMessages(heavy.conversationId, { limit: 100 }).filter((m) => m.role === "assistant" && m.status !== "streaming");
    const had = answers().length;
    await hub.runner.userMessage(heavy.conversationId, "RECAP?", { channel: "web" });
    expect(textOf(await until(() => answers()[had], "the task's answer"))).toBe("fake backup: yes");
  });

  it("lets the default agent change the caps and the recap's size when asked", async () => {
    expect(await ask("assistant", 'CALL hub_settings_update {"patch":{"recapMaxChars":8000,"dialogContextCap":90000}}')).toMatch(/Settings updated/);
    expect(hub.settings.get()).toMatchObject({ recapMaxChars: 8000, dialogContextCap: 90_000 });
    expect(await ask("assistant", 'CALL hub_settings_update {"patch":{"taskContextCap":50000}}')).toMatch(/taskContextCap must be a whole number from 100000 to 1000000/);
    // The recap follows its size: a long dialog's recap stays inside it.
    for (let i = 0; i < 12; i++) await ask("assistant", `note ${i} ${"word ".repeat(300)}`);
    hub.store.updateSession(session("assistant").id, { contextTokens: 400_000, baseTokens: 30_000 });
    const started = await ask("assistant", "RECAP?");
    expect(started).toMatch(/^fake started from:/);
    expect(started.length).toBeLessThan(9000);
    expect(started.length).toBeGreaterThan(4000);
    hub.updateSettings({ recapMaxChars: 16_000, dialogContextCap: 120_000 }, "user");
  });
});
