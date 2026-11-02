// The front desk (docs/superpowers/specs/2026-10-29-front-desk-design.md): a dialog's brain is ready before the
// person's message (warm), dialogs think on "auto" (fast, on the quickest brain that can take the turn), tasks get the
// brain and depth the agent chose for them, the chat sees what a turn is doing now, and a task's permission question
// shows in the dialog that started it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { buildSystemPrompt } from "../src/prompt.ts";

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

describe("front desk (integration)", () => {
  let hub: Hub;

  /** Say something in the agent's dialog and get its answer. */
  const ask = async (agentId: string, text: string): Promise<string> => {
    const c = hub.store.agentConversation(agentId).id;
    const before = hub.store.listMessages(c, { limit: 500 }).filter((m) => m.role === "assistant").length;
    await hub.runner.userMessage(c, text, { channel: "web" });
    const answer = await until(() => hub.store.listMessages(c, { limit: 500 }).filter((m) => m.role === "assistant" && m.status !== "streaming")[before], `the answer to “${text}”`);
    await until(() => !hub.runner.isRunning(c), "the turn to end");
    return textOf(answer);
  };

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const dataDir = mkdtempSync(join(tmpdir(), "owl-front-desk-"));
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir, builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    await until(() => hub.brains.has("fake@local") && hub.brains.has("fake2:a@local"), "fake brains to register");
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("gets a dialog's brain ready before the message, and keeps it warm; tasks are not", async () => {
    const c = hub.store.agentConversation("assistant").id;
    expect(await hub.runner.warm(c)).toBe(true);
    const opened = hub.store.activeSession(c, "assistant")!;
    // A dialog is a front desk too: its brain only looks, commands and file changes are a task's.
    expect(await ask("assistant", "WARM?")).toBe("fake warm: yes keep: true desk: true");
    // The session it opened is the one the turn used.
    expect(hub.store.activeSession(c, "assistant")!.id).toBe(opened.id);
    const task = hub.runner.createTask({ agentId: "assistant", title: "w", goal: "WARM?", createdBy: "user", background: false });
    expect(await hub.runner.warm(task.conversationId)).toBe(false);
    const done = await until(() => (hub.store.getTask(task.id)?.status === "done" ? hub.store.getTask(task.id) : undefined), "the task");
    expect(done.result).toBe("fake warm: no keep: false desk: false");
  });

  it("picks the model per message in a dialog with no choice of its own, and gives each task the brain and depth the agent chose", async () => {
    hub.agents.save({ id: "desk", name: "Desk", description: "Front desk", brains: ["fake@local", "fake2:a@local"], tools: ["*"], skills: ["*"], prompt: "Hi.", initiative: 1 } as any);
    // The front desk: the strong model at low effort, answering at once; a word in passing: the light one.
    expect(await ask("desk", "THINKING?")).toBe("fake thinks: model=smart effort=low");
    await ask("desk", "Спасибо!");
    expect(await ask("desk", "MODELS?")).toBe("fake used: smart/low, quick/low, smart/low");
    // Each reply says how it was made, for the mark by the message.
    const replies = hub.store.listMessages(hub.store.agentConversation("desk").id, { limit: 50 }).filter((m) => m.role === "assistant");
    expect(replies.map((m) => [m.brainRef, m.model, m.effort])).toEqual([
      ["fake@local", "smart", "low"],
      ["fake@local", "quick", "low"],
      ["fake@local", "smart", "low"],
    ]);
    const c = hub.store.agentConversation("desk").id;
    const delegated = async (input: Record<string, unknown>) => {
      const before = hub.store.listTasks({ limit: 500 }).length;
      const reply = await ask("desk", `CALL task_delegate ${JSON.stringify({ goal: "THINKING?", title: "t", ...input })}`);
      if (!reply.includes("Task created")) return reply;
      const t = await until(() => hub.store.listTasks({ limit: 500 }).length > before && hub.store.listTasks({ limit: 1 })[0], "the task");
      return (await until(() => (hub.store.getTask(t.id)?.status === "done" ? hub.store.getTask(t.id) : undefined), "the task to finish")).result;
    };
    // No choice: tasks following an auto dialog think balanced.
    expect(await delegated({})).toBe("fake thinks: model=smart effort=medium");
    expect(await delegated({ depth: "deep" })).toBe("fake thinks: model=smart effort=high");
    expect(await delegated({ depth: "fast", brain: "fake2" })).toBe("fake2 thinks: model=default effort=default");
    expect(await delegated({ brain: "nope" })).toContain("desk has no brain nope. Its brains: fake@local, fake2:a@local.");
    // A call without its goal starts nothing.
    const count = hub.store.listTasks({ limit: 500 }).length;
    expect(await ask("desk", "CALL task_delegate {}")).toContain("No task started: give it `goal`");
    expect(hub.store.listTasks({ limit: 500 }).length).toBe(count);
    // A guessed name for the goal is taken as it.
    expect(await delegated({ goal: undefined, task: "THINKING?" })).toBe("fake thinks: model=smart effort=medium");
    // The task line in the dialog names the choice for the agent.
    const said = hub.store.listMessages(c, { limit: 500 }).flatMap((m) => m.parts).filter((p) => p.type === "tool_result").map((p: any) => p.output);
    expect(said.some((o: string) => /Task created: .*\(fake2, fast\)/.test(o))).toBe(true);
  });

  it("keeps a dialog on the agent's own brain, even when another one's models look better; a chosen brain wins over a fallback", async () => {
    hub.agents.save({ id: "home", name: "Home", description: "Stays", brains: ["fake2:a@local", "fake@local"], tools: ["*"], skills: ["*"], prompt: "Hi.", initiative: 1 } as any);
    expect(await ask("home", "hi")).toBe("fake2 heard: hi");
    const c = hub.store.agentConversation("home").id;
    expect(hub.store.activeSession(c, "home")!.brainRef).toBe("fake2:a@local");
    // The person picks the other brain for the dialog: it takes over at once.
    hub.agents.save({ ...hub.agents.get("home")!, thinking: { chat: { preset: "auto", brain: "fake@local" } } });
    expect(await ask("home", "THINKING?")).toBe("fake thinks: model=smart effort=low");
  });

  it("shows a task's permission question in the dialog that started it, and its answer there", async () => {
    const dialog = hub.store.agentConversation("desk").id;
    const parent = hub.store.createTask({ agentId: "desk", title: "Check the disk", goal: "x", createdBy: "agent", background: false, parentConversationId: dialog });
    // A sub-task of that task asks: the card goes up to the dialog, under the sub-task's line.
    const child = hub.store.createTask({ agentId: "desk", title: "Read the logs", goal: "y", createdBy: "agent", background: false, parentConversationId: parent.conversationId, parentTaskId: parent.id });
    const a = hub.approvals.create({ sessionId: "s", conversationId: child.conversationId, taskId: child.id, agentId: "desk", tool: "Bash", input: {}, summary: "Run: ps", effect: "external", tainted: false });
    const card = () => hub.store.listMessages(dialog, { limit: 50 }).find((m) => m.parts.some((p) => p.type === "approval" && p.approvalId === a.id));
    const shown = await until(card, "the card in the dialog");
    expect(shown.parts).toEqual([{ type: "task", taskId: child.id }, { type: "approval", approvalId: a.id, summary: "Run: ps", status: "pending" }]);
    hub.approvals.resolve(a.id, "approve", { via: "console" });
    await until(() => (card()?.parts.find((p) => p.type === "approval") as any)?.status === "approved", "the answer in the dialog");
    // A task the person started from the Tasks page has no dialog to show it in. (The dialog itself keeps getting
    // messages meanwhile: these tasks run, and their results come back to it.)
    const own = hub.store.createTask({ agentId: "desk", title: "Mine", goal: "z", createdBy: "user", background: false });
    const b = hub.approvals.create({ sessionId: "s", conversationId: own.conversationId, taskId: own.id, agentId: "desk", tool: "Bash", input: {}, summary: "Run: ls", effect: "external", tainted: false });
    await sleep(100);
    expect(hub.store.listMessages(dialog, { limit: 50 }).some((m) => m.parts.some((p) => p.type === "approval" && p.approvalId === b.id))).toBe(false);
  });

  it("shows a card asked outside a turn as a message of its own, with its answer", async () => {
    // A replica waiting for the vault key asks with no agent turn running: the card still needs its buttons.
    const conv = hub.store.agentConversation("desk").id;
    const a = hub.approvals.create({ sessionId: "cluster", conversationId: conv, agentId: "desk", tool: "replica_unlock", input: { replica: "r" }, summary: "Unlock the vault on vps", effect: "external", tainted: false });
    const card = () => hub.store.listMessages(conv, { limit: 50 }).find((m) => m.parts.some((p) => p.type === "approval" && p.approvalId === a.id));
    const shown = await until(card, "the card");
    expect(shown).toMatchObject({ role: "assistant", agentId: "desk", parts: [{ type: "approval", approvalId: a.id, summary: "Unlock the vault on vps", status: "pending" }] });
    hub.approvals.resolve(a.id, "deny", { via: "console" });
    await until(() => (card()?.parts[0] as any)?.status === "denied", "the answer on the card");
  });

  it("tells a dialog which brains are here and what each is for", () => {
    const agent = { id: "desk", name: "Desk", description: "", brains: ["claude-code@local", "codex@local"], tools: ["*"], skills: ["*"], prompt: "Hi.", initiative: 1 } as any;
    const dispatch = {
      team: [{ id: "desk", name: "Desk", description: "Front desk", where: ["Mac"], brains: ["claude-code", "codex"] }],
      computers: [{ id: "local", name: "Mac", online: true }],
      brains: [
        { id: "claude-code", label: "Claude Code", models: ["opus", "sonnet"], ready: true },
        { id: "codex", label: "Codex", models: [], ready: false },
      ],
    };
    const p = buildSystemPrompt({ agent, timezone: "UTC", language: "en", consoleUrl: "", background: false, skills: [], nativeSkills: true, appended: [], dispatch, thinking: { brain: "Claude Code", kind: "chat", model: "sonnet", effort: "low", preset: "auto" } });
    expect(p).toContain("You are the front desk");
    expect(p).toContain("- desk: Desk (you) — Front desk (brains: claude-code, codex; on: Mac)");
    expect(p).toContain("Brains here (`brain` in task_delegate):\n- claude-code: Claude Code (models: opus, sonnet) — analysis, research, writing, the browser, everyday work; can code too");
    expect(p).toContain("- codex: Codex — code: changes, refactors, tests, scripts, debugging (not ready now)");
    expect(p).toContain("You think with Claude Code: model sonnet, effort low, chosen by the hub for your dialogs");
  });
});
