// A dialog whose brains are only not connected for now (the hub switching machines, a computer asleep, a plugin
// restarting) shows a passing status, not an error message: the turn waits for them with the live step "offline", and
// once they are back it answers and the status is gone. Only past the wait does the chat say it cannot start, as
// before. Stop ends the wait; a hub that stops leading leaves nothing behind. A paired machine is simulated by the fake
// brain plugin's peer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Task } from "@piomio/shared";
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

const textOf = (m: Message) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
const errorOf = (m: Message) => m.parts.flatMap((p) => (p.type === "error" ? [p.message] : [])).join("");
const FIRST_ENDING = "When you are done, briefly describe the result — it will be passed to whoever created the task.";

describe("waiting for brains to connect (integration)", () => {
  let hub: Hub;
  let c: string;
  /** The fake brain plugin's process: it also stands for the machine "box". */
  let fake: any;

  const messages = (conversationId = c): Message[] => hub.store.listMessages(conversationId, { limit: 200 });
  const errors = (conversationId = c) => messages(conversationId).filter((m) => errorOf(m));
  const answers = (conversationId = c) => messages(conversationId).filter((m) => m.role === "assistant");
  const status = (conversationId = c) => hub.activity.view().flatMap((m) => m.work.map((w) => ({ ...w, machine: m.id }))).find((w) => w.conversationId === conversationId);
  const idle = (conversationId = c) => until(() => !hub.runner.isRunning(conversationId) && messages(conversationId).every((m) => m.status !== "streaming"), "the turn to end");
  const say = (text: string, conversationId = c) => hub.runner.userMessage(conversationId, text);
  const task = (id: string): Task => hub.store.getTask(id)!;

  /** The machine "box" comes online: its brain `fake` runs on the fake plugin's process. */
  const connect = () => {
    (hub.machines as any).peers.set("mach_box", fake.peer);
    hub.brains.registerMachine("mach_box", "box", fake.peer, [{ id: "fake", label: "Fake" }]);
  };
  const disconnect = () => {
    (hub.machines as any).peers.delete("mach_box");
    hub.brains.unregisterMachine("mach_box");
  };

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-brain-wait-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    await until(() => hub.brains.has("fake@local"), "fake brains to register");
    fake = (hub.brains as any).pluginBrains.get("fake");
    hub.db.prepare("insert into machines(id, name, public_key, created_at) values (?,?,?,?)").run("mach_box", "box", "x", new Date().toISOString());
    connect();
    hub.agents.save({ id: "coder", name: "Coder", description: "Writes code", brains: ["fake@local"], machines: ["mach_box"], prompt: "Code." } as any);
    c = hub.store.agentConversation("coder").id;
    hub.runner.waits = { ...hub.runner.waits, dialogMs: 60_000, everyMs: 300 };
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("shows a status instead of an error while its computer is away, and answers once it is back", async () => {
    disconnect();
    try {
      await say("are you there");
      const waiting = await until(() => status(), "the status");
      expect(waiting).toMatchObject({ agentId: "coder", step: "offline", machine: "mach_box" });
      // It keeps waiting: still no error in the chat, and the conversation is busy (later messages queue).
      await sleep(600);
      expect(errors()).toEqual([]);
      expect(hub.runner.isRunning(c)).toBe(true);
    } finally {
      connect();
    }
    await idle();
    expect(textOf(messages().filter((m) => m.role === "assistant").at(-1)!)).toBe("fake heard: are you there");
    expect(status()).toBeUndefined();
    expect(errors()).toEqual([]);
  });

  it("ends the wait on Stop, quietly", async () => {
    disconnect();
    try {
      await say("never mind");
      await until(() => status(), "the status");
      expect(hub.runner.interrupt(c)).toBe(true);
      await idle();
      expect(status()).toBeUndefined();
      expect(errors()).toEqual([]);
    } finally {
      connect();
    }
  });

  it("ends on a Stop that comes while it looks at a brain just back", async () => {
    disconnect();
    const before = answers().length;
    const probe = hub.brains.probe;
    try {
      await say("hold on");
      await until(() => status(), "the status");
      // Stop lands while the hub asks the brain that came back whether it is ready.
      hub.brains.probe = async (ref: string, maxAgeMs?: number) => {
        if (ref.endsWith("@mach_box")) hub.runner.interrupt(c);
        return probe.call(hub.brains, ref, maxAgeMs);
      };
      connect();
      await idle();
      expect(answers().length).toBe(before);
      expect(status()).toBeUndefined();
      expect(errors()).toEqual([]);
    } finally {
      hub.brains.probe = probe;
      connect();
    }
  });

  it("thinks with the same brain on a computer that came during the wait", async () => {
    // The agent may think here or on box: the hub's own brain is gone (its plugin restarting), and box is off.
    hub.agents.save({ id: "pair", name: "Pair", description: "Here or on box", brains: ["fake@local"], machines: ["local", "mach_box"], prompt: "Pair." } as any);
    const p = hub.store.agentConversation("pair").id;
    disconnect();
    (hub.brains as any).pluginBrains.delete("fake");
    try {
      await say("anyone?", p);
      await until(() => status(p), "the status");
      connect();
      await idle(p);
      expect(textOf(answers(p).at(-1)!)).toBe("fake heard: anyone?");
      expect(hub.store.activeSession(p, "pair")!.brainRef).toBe("fake@mach_box");
      expect(status(p)).toBeUndefined();
      expect(errors(p)).toEqual([]);
    } finally {
      (hub.brains as any).pluginBrains.set("fake", fake);
      connect();
    }
  });

  it("says it cannot start, as before, once it has waited long enough", async () => {
    disconnect();
    hub.runner.waits = { ...hub.runner.waits, dialogMs: 0 };
    try {
      await say("still there?");
      await idle();
      expect(errorOf(messages().at(-1)!)).toBe("Coder works only on box, and it is not online now. Your message is kept: send it again once it is back.");
      expect(status()).toBeUndefined();
    } finally {
      hub.runner.waits = { ...hub.runner.waits, dialogMs: 60_000 };
      connect();
    }
  });

  it("writes nothing when the hub stops leading while it waits", async () => {
    disconnect();
    const before = messages().length;
    const errs = errors().length;
    try {
      await say("one more");
      await until(() => status(), "the status");
      await hub.runner.stop();
      await idle();
      expect(status()).toBeUndefined();
      expect(messages().length).toBe(before + 1);
      expect(errors().length).toBe(errs);
    } finally {
      hub.runner.start();
      connect();
    }
  });

  it("keeps a task's chat free of errors while its brain breaks off and it tries again", async () => {
    const t = hub.runner.createTask({ agentId: "assistant", goal: "long work CRASH", title: "Crashy", background: false, createdBy: "agent" });
    const done = await until(() => (["done", "failed"].includes(task(t.id).status) ? task(t.id) : undefined), "the task to finish");
    expect(done.status).toBe("done");
    expect(done.result).not.toBe(`fake heard: ${FIRST_ENDING}`);
    expect(hub.store.listMessages(t.conversationId, { limit: 50 }).filter((m) => errorOf(m))).toEqual([]);
  });
});
