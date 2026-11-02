// The team's rules for where work goes (docs/superpowers/specs/2026-11-02-persistent-agents-design.md): said once in a
// chat, saved by the agent with work_rule_set, listed for every dialog; a task placed on a computer that is offline
// waits for it and thinks with the brain there. A paired machine is simulated by the fake brain plugin's peer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDef, Message, Task } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { buildSystemPrompt } from "../src/prompt.ts";

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

const textOf = (m: Message) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");

describe("work rules (integration)", () => {
  let hub: Hub;
  let dialog: string;

  const connect = () => {
    const peer = (hub.brains as any).pluginBrains.get("fake").peer;
    (hub.machines as any).peers.set("mach_box", peer);
    hub.brains.registerMachine("mach_box", "box", peer, [{ id: "fake", label: "Fake" }]);
  };
  const disconnect = () => {
    (hub.machines as any).peers.delete("mach_box");
    hub.brains.unregisterMachine("mach_box");
  };
  /** What the agent's tool call answered: the dialog's latest reply. */
  const replies = () => hub.store.listMessages(dialog, { limit: 500 }).filter((m) => m.role === "assistant");
  const call = async (tool: string, input: unknown): Promise<string> => {
    const before = replies().length;
    await hub.runner.userMessage(dialog, `CALL ${tool} ${JSON.stringify(input)}`);
    const reply = await until(() => {
      const r = replies();
      return r.length > before && !hub.runner.isRunning(dialog) && r.at(-1)!.status !== "streaming" ? r.at(-1) : undefined;
    }, "the reply");
    return textOf(reply);
  };

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-rules-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    await until(() => hub.brains.has("fake@local"), "fake brains to register");
    // The box said it is signed in to `fake` and has a graphics card the last time it was online.
    const info = { os: "Windows 11 Pro", hostname: "box", arch: "x64", nodeVersion: "v24", allowedDirs: [], clis: [{ brainId: "fake", available: true, authenticated: true }], gpus: ["NVIDIA GeForce RTX 4090, 24 GB"] };
    hub.db.prepare("insert into machines(id, name, public_key, info, created_at) values (?,?,?,?,?)").run("mach_box", "box", "x", JSON.stringify(info), new Date().toISOString());
    hub.runner.waits = { brainMs: 60_000, machineMs: 60_000, everyMs: 300 };
    dialog = hub.store.agentConversation("assistant").id;
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("saves a rule from the chat, the computer by name, and refuses what does not exist", async () => {
    expect(await call("work_rule_set", { when: "rendering, anything for the GPU", machine: "atlantis" })).toMatch(/No computer "atlantis"\. Computers: .*box \(mach_box\)/);
    expect(await call("work_rule_set", { when: "rendering", agent: "nobody" })).toMatch(/No agent "nobody"\. Agents: /);
    expect(await call("work_rule_set", { when: "rendering" })).toMatch(/No rule saved: say where such work goes/);
    expect(hub.runner.rules.list()).toEqual([]);

    const said = await call("work_rule_set", { when: "rendering, anything for the GPU", machine: "BOX" });
    const [rule] = hub.runner.rules.list();
    expect(rule).toMatchObject({ when: "rendering, anything for the GPU", machine: "mach_box" });
    expect(said).toContain(`Saved the rule ${rule.id}: rendering, anything for the GPU → computer box (mach_box). Every dialog of the team follows it from now on.`);
  });

  it("lists the rules and the computers' graphics cards for the team", async () => {
    const listed = await call("task_agents", {});
    expect(listed).toMatch(/- mach_box: box, offline, GPU: NVIDIA GeForce RTX 4090, 24 GB/);
    expect(listed).toMatch(/The user's rules for where work goes:\n- rule_\S+: rendering, anything for the GPU → computer box \(mach_box\)/);
  });

  it("puts the rules and the cards into a dialog's instructions", () => {
    const agent = { id: "assistant", name: "Owl", description: "", brains: [], initiative: 1, tools: ["*"], skills: [], policyProfile: "default", budget: { backgroundRunsPerDay: 5 }, prompt: "", source: "builtin" } as AgentDef;
    const prompt = buildSystemPrompt({
      agent,
      timezone: "UTC",
      language: "en",
      consoleUrl: "http://x",
      background: false,
      skills: [],
      nativeSkills: false,
      appended: [],
      dispatch: {
        team: [{ id: "assistant", name: "Owl", description: "Helps", where: ["MacBook"] }],
        computers: [
          { id: "local", name: "MacBook", online: true },
          { id: "mach_box", name: "box", online: false, gpus: ["NVIDIA GeForce RTX 4090, 24 GB"] },
        ],
        rules: ["- rule_1: rendering → computer box (mach_box)"],
      },
    });
    expect(prompt).toContain("- mach_box: box; GPU: NVIDIA GeForce RTX 4090, 24 GB (offline when this session started)");
    expect(prompt).toContain("The user's rules for where work goes (follow them in task_delegate):\n- rule_1: rendering → computer box (mach_box)");
    expect(prompt).toContain("save it with `work_rule_set`");
  });

  it("places a task on a computer that is off: it waits for it and thinks with the brain there", async () => {
    disconnect();
    const said = await call("task_delegate", { title: "Render the scene", goal: "render it", machine: "box" });
    expect(said).toMatch(/Task created: (t_\S+) “Render the scene” on box\. box is offline now: the task starts when it comes online\./);
    const id = /Task created: (t_\S+)/.exec(said)![1];
    const waiting = await until(() => {
      const t = hub.store.getTask(id);
      return t?.status === "queued" && t.error ? t : undefined;
    }, "the task to wait");
    expect(waiting).toMatchObject({ brainRef: "fake@mach_box", error: "waiting for box to come online, then it starts" });
    connect();
    const done = await until(() => {
      const t = hub.store.getTask(id) as Task;
      return t.status === "done" ? t : undefined;
    }, "the task to run on box");
    expect(done.result).toMatch(/^fake heard: /);
    expect(hub.store.activeSession(done.conversationId, "assistant")!.brainRef).toBe("fake@mach_box");
  });

  it("drops a rule", async () => {
    const [rule] = hub.runner.rules.list();
    expect(await call("work_rule_remove", { id: "rule_nope" })).toMatch(/No rule rule_nope\. Rules: rule_\S+ \(rendering/);
    expect(await call("work_rule_remove", { id: rule.id })).toBe(`tool said: Removed the rule ${rule.id} (rendering, anything for the GPU).`);
    expect(hub.runner.rules.list()).toEqual([]);
  });
});
