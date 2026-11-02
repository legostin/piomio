// Tasks that do not give up (docs/superpowers/specs/2026-11-02-persistent-agents-design.md): a task whose brains are
// not connected waits for them instead of failing, one placed on a computer waits for it to come online, a turn whose
// brain broke off goes on from where it stopped, and only past the wait does a task fail as before. A paired machine is
// simulated by the fake brain plugin's peer.
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

/** The last line of a task's first prompt, which the fake brain answers. */
const FIRST_ENDING = "When you are done, briefly describe the result — it will be passed to whoever created the task.";
const textOf = (m: Message) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
const errorOf = (m: Message) => m.parts.flatMap((p) => (p.type === "error" ? [p.message] : [])).join("");

describe("tasks that do not give up (integration)", () => {
  let hub: Hub;

  /** The machine "box" comes online: its brain `fake` runs on the fake plugin's process. */
  const connect = () => {
    const peer = (hub.brains as any).pluginBrains.get("fake").peer;
    (hub.machines as any).peers.set("mach_box", peer);
    hub.brains.registerMachine("mach_box", "box", peer, [{ id: "fake", label: "Fake" }]);
  };
  const disconnect = () => {
    (hub.machines as any).peers.delete("mach_box");
    hub.brains.unregisterMachine("mach_box");
  };
  const task = (id: string): Task => hub.store.getTask(id)!;
  const finished = (id: string, timeoutMs = 15_000) => until(() => (["done", "failed"].includes(task(id).status) ? task(id) : undefined), `task ${id} to finish`, timeoutMs);
  const start = (t: { agentId: string; goal: string; title: string; brainRef?: string }) => hub.runner.createTask({ ...t, background: false, createdBy: "agent" });

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-persist-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    await until(() => hub.brains.has("fake@local"), "fake brains to register");
    hub.db.prepare("insert into machines(id, name, public_key, created_at) values (?,?,?,?)").run("mach_box", "box", "x", new Date().toISOString());
    hub.agents.save({ id: "coder", name: "Coder", description: "Writes code", brains: ["fake@local"], machines: ["mach_box"], prompt: "Code." } as any);
    hub.runner.waits = { brainMs: 60_000, machineMs: 60_000, everyMs: 300 };
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("waits for the computer it was placed on, quietly, and runs once it is online", async () => {
    disconnect();
    const t = start({ agentId: "assistant", goal: "render the scene", title: "Render", brainRef: "fake@mach_box" });
    const waiting = await until(() => (task(t.id).status === "queued" && task(t.id).error ? task(t.id) : undefined), "the task to wait");
    expect(waiting.error).toBe("waiting for box to come online, then it starts");
    // Looked again and still waits: no error in its chat meanwhile.
    await sleep(800);
    expect(task(t.id).status).not.toBe("failed");
    expect(hub.store.listMessages(t.conversationId, { limit: 50 }).some((m) => errorOf(m))).toBe(false);
    connect();
    const done = await finished(t.id);
    expect(done.status).toBe("done");
    // Its first turn, not "continue": it had not started.
    expect(done.result).toBe(`fake heard: ${FIRST_ENDING}`);
    expect(done.error).toBeUndefined();
  });

  it("waits for the computers its agent is bound to", async () => {
    disconnect();
    try {
      const t = start({ agentId: "coder", goal: "build it", title: "Build" });
      const waiting = await until(() => (task(t.id).status === "queued" && task(t.id).error ? task(t.id) : undefined), "the task to wait");
      expect(waiting.error).toBe("waiting for box to come online, then it starts");
      connect();
      expect((await finished(t.id)).result).toBe(`fake heard: ${FIRST_ENDING}`);
    } finally {
      connect();
    }
  });

  it("fails as before once it has waited long enough, saying why in its chat", async () => {
    disconnect();
    hub.runner.waits = { brainMs: 0, machineMs: 0, everyMs: 300 };
    try {
      const t = start({ agentId: "assistant", goal: "render again", title: "Render again", brainRef: "fake@mach_box" });
      const failed = await finished(t.id);
      expect(failed.status).toBe("failed");
      expect(failed.error).toMatch(/Can't start the agent .+fake@mach_box: not connected/);
      expect(hub.store.listMessages(t.conversationId, { limit: 50 }).some((m) => /not connected/.test(errorOf(m)))).toBe(true);
    } finally {
      hub.runner.waits = { brainMs: 60_000, machineMs: 60_000, everyMs: 300 };
      connect();
    }
  });

  it("goes on from where it stopped when its brain breaks off mid-turn", async () => {
    const t = start({ agentId: "assistant", goal: "long work CRASH", title: "Crashy" });
    const done = await finished(t.id);
    expect(done.status).toBe("done");
    expect(done.result).toBe("fake heard: Continue working on the task from where you stopped.");
    const said = hub.store.listMessages(t.conversationId, { limit: 50 }).filter((m) => m.role === "assistant").map(textOf);
    expect(said).toEqual(["fake started", "fake heard: Continue working on the task from where you stopped."]);
  });
});
