// Short errands (task_delegate `quick`): a task kind the chat shows as the agent thinking, kept to its size (an errand
// still going after ERRAND_MINUTES or asking a question becomes an ordinary task) and removed a day after it finished,
// its folder too unless a chat shows a file from it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Task } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { ERRAND_KEEP_HOURS, ERRAND_MINUTES } from "../src/runner.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (m: Message) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");

async function until<T>(fn: () => T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v as T;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("short errands", () => {
  let hub: Hub;
  let main: string;

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "piomio-errands-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    await until(() => hub.brains.has("fake@local"), "the fake brain to register");
    main = hub.store.agentConversation("assistant").id;
  });

  afterAll(async () => {
    await hub?.stop();
  });

  /** An errand that does not run (paused), as if task_delegate had made it. */
  const errand = (title: string, status: Task["status"] = "paused"): Task =>
    hub.store.createTask({ agentId: "assistant", title, goal: title, parentConversationId: main, background: false, createdBy: "agent", kind: "errand", status });
  const folderOf = (t: Task) => hub.runner.workspacePath({ agentId: t.agentId, taskId: t.id, conversationId: t.conversationId });

  it("is what a quick task_delegate makes, and its result comes back to the chat", async () => {
    await hub.runner.userMessage(main, `CALL task_delegate {"title":"Weather now","goal":"hi","quick":true}`);
    const t = await until(() => hub.store.listTasks().find((x) => x.title === "Weather now"), "the errand");
    expect(t.kind).toBe("errand");
    await until(() => hub.store.getTask(t.id)?.status === "done", "the errand to finish");
    await until(() => hub.store.listMessages(main).some((m) => m.role === "system" && textOf(m).startsWith(`[System] Task ${t.id} “Weather now” is finished.`)), "its result in the chat");
    // Without `quick` it stays an ordinary task.
    await hub.runner.userMessage(main, `CALL task_delegate {"title":"Plain one","goal":"hi"}`);
    const plain = await until(() => hub.store.listTasks().find((x) => x.title === "Plain one"), "the task");
    expect(plain.kind).toBeUndefined();
  });

  it("becomes an ordinary task once it runs long or asks a question", () => {
    const long = errand("Long errand");
    const asking = errand("Asking errand");
    hub.store.updateTask(asking.id, { question: "Which city?" });
    hub.runner.tidyErrands(Date.now());
    expect(hub.store.getTask(long.id)?.kind).toBe("errand");
    expect(hub.store.getTask(asking.id)?.kind).toBeUndefined();
    hub.runner.tidyErrands(Date.now() + (ERRAND_MINUTES + 1) * 60_000);
    expect(hub.store.getTask(long.id)?.kind).toBeUndefined();
    hub.runner.cancelTask(long.id);
    hub.runner.cancelTask(asking.id);
  });

  it("goes a day after it finished, its folder too unless a chat shows a file from it", () => {
    const plain = errand("Done errand", "done");
    const shown = errand("Errand with a picture", "done");
    const going = errand("Errand still going");
    hub.store.addMessage({ conversationId: plain.conversationId, role: "assistant", parts: [{ type: "text", text: "worked" }], status: "complete" });
    for (const t of [plain, shown]) {
      mkdirSync(folderOf(t), { recursive: true });
      writeFileSync(join(folderOf(t), "chart.png"), "png");
    }
    hub.store.addMessage({ conversationId: main, role: "assistant", parts: [{ type: "text", text: `![chart](file:assistant/${shown.id}/chart.png)` }], status: "complete" });

    // Within the day it stays.
    hub.runner.tidyErrands(Date.now() + 3600_000);
    expect(hub.store.getTask(plain.id)).toBeDefined();

    hub.runner.tidyErrands(Date.now() + (ERRAND_KEEP_HOURS + 1) * 3600_000);
    expect(hub.store.getTask(plain.id)).toBeUndefined();
    expect(hub.store.getConversation(plain.conversationId)).toBeUndefined();
    expect(hub.store.listMessages(plain.conversationId)).toEqual([]);
    expect(existsSync(folderOf(plain))).toBe(false);
    // The picture in the chat keeps its file.
    expect(hub.store.getTask(shown.id)).toBeUndefined();
    expect(existsSync(join(folderOf(shown), "chart.png"))).toBe(true);
    // Unfinished errands are not removed (the long one became an ordinary task by then).
    expect(hub.store.getTask(going.id)).toBeDefined();
    hub.runner.cancelTask(going.id);
  });
});
