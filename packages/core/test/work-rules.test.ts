// The team's rules for where work goes (docs/superpowers/specs/2026-11-02-persistent-agents-design.md): said once in a
// chat, saved by the agent with work_rule_set, listed for every dialog; a task placed on a computer that is offline
// waits for it and thinks with the brain there. A paired machine is simulated by the fake brain plugin's peer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDef, Message, Task } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { buildSystemPrompt } from "../src/prompt.ts";

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
    expect(said).toContain(`Saved the rule ${rule.id}: rendering, anything for the GPU → computer box (mach_box). Every dialog of the team follows it from now on, and the hub applies it to each task before it starts.`);
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
    expect(waiting).toMatchObject({ machineId: "mach_box", brainRef: undefined, error: "waiting for box to come online, then it starts" });
    connect();
    const done = await until(() => {
      const t = hub.store.getTask(id) as Task;
      return t.status === "done" ? t : undefined;
    }, "the task to run on box");
    expect(done.result).toMatch(/^fake heard: /);
    expect(hub.store.activeSession(done.conversationId, "assistant")!.brainRef).toBe("fake@mach_box");
  });

  it("saves how such work thinks: the model by its name, on the brain that has it", async () => {
    expect(await call("work_rule_set", { when: "the Piomio project", model: "opus" })).toMatch(/No model "opus"\. Models: fake: quick, smart\./);
    expect(await call("work_rule_set", { when: "the Piomio project", model: "Smart", effort: "extreme" })).toMatch(/No effort "extreme"\. Efforts: /);
    const said = await call("work_rule_set", { when: "the Piomio project", machine: "box", model: "Smart", effort: "high" });
    const rule = hub.runner.rules.list().find((r) => r.when === "the Piomio project")!;
    expect(rule).toMatchObject({ machine: "mach_box", brain: "fake", model: "smart", effort: "high" });
    expect(said).toContain(`Saved the rule ${rule.id}: the Piomio project → computer box (mach_box); brain fake; model smart; effort high.`);
    // How it thinks alone is a rule too.
    expect(await call("work_rule_set", { when: "news channels", effort: "low" })).toContain("news channels → effort low");
  });

  it("applies the rules that fit before a task's first run, whoever started it; what the starter named stands", async () => {
    const piomio = hub.runner.rules.list().find((r) => r.when === "the Piomio project")!;
    const asked: string[] = [];
    let answer = `{"rules":["${piomio.id}"]}`;
    (hub.runner as any).d.quick = {
      ask: async (prompt: string) => {
        asked.push(prompt);
        if (answer === "DOWN") throw new Error("no quick model is signed in");
        return { text: answer, ref: "fake@local" };
      },
    };
    const run = async (t: Parameters<Hub["runner"]["createTask"]>[0]): Promise<Task> => {
      const id = hub.runner.createTask(t).id;
      return until(() => {
        const now = hub.store.getTask(id) as Task;
        return now.status === "done" || now.status === "failed" ? now : undefined;
      }, "the task to end");
    };
    const base = { agentId: "assistant", title: "Fix the build", goal: "THINKING?", background: false } as const;

    // A scheduled run nobody placed: the rule sends it to the box, on the model and the effort it names.
    const ruledTask = await run({ ...base, createdBy: "trigger" });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(`- ${piomio.id}: the Piomio project`);
    expect(asked[0]).toContain("Fix the build");
    expect(ruledTask).toMatchObject({ rule: piomio.id, machineId: "mach_box", thinking: { brain: "fake", model: "smart", effort: "high" } });
    expect(ruledTask.result).toBe("fake thinks: model=smart effort=high");
    expect(hub.store.activeSession(ruledTask.conversationId, "assistant")!.brainRef).toBe("fake@mach_box");
    expect(hub.audit.list({ action: "task.rule", limit: 1 })[0]).toMatchObject({ target: ruledTask.id, data: { rules: [piomio.id], machineId: "mach_box" } });

    // The starter's own computer and exact model win; the rule is still noted.
    const mine = await run({ ...base, createdBy: "user", machineId: "local", thinking: { brain: "fake", model: "quick" } });
    expect(mine).toMatchObject({ rule: piomio.id, machineId: "local", thinking: { brain: "fake", model: "quick" } });
    expect(mine.result).toBe("fake thinks: model=quick effort=default");

    // No rule fits, or the quick model is away: the task runs as it was started, and is not asked about again.
    answer = '{"rules":[]}';
    expect(await run({ ...base, createdBy: "user" })).toMatchObject({ rule: "none", machineId: undefined });
    answer = "DOWN";
    const unruled = await run({ ...base, createdBy: "user" });
    expect(unruled).toMatchObject({ rule: "none", machineId: undefined });
    expect(unruled.thinking).toBeUndefined();
    expect(hub.audit.list({ action: "task.rule", limit: 1 })[0]).toMatchObject({ target: unruled.id, data: { rules: [], error: "no quick model is signed in" } });

    for (const r of hub.runner.rules.list().filter((x) => x.when !== "rendering, anything for the GPU")) hub.runner.rules.remove(r.id);
  });

  it("starts a task on the exact model and effort the person named for it", async () => {
    await until(() => !hub.runner.isRunning(dialog), "the dialog to be quiet");
    expect(await call("task_delegate", { title: "Think", goal: "THINKING?", model: "nope" })).toMatch(/No model "nope" among assistant's brains\. Models: fake: quick, smart\./);
    // The task may end, and its result reach the dialog, before the tool's reply is read: find the reply by its words.
    await call("task_delegate", { title: "Think", goal: "THINKING?", model: "Smart", effort: "low", depth: "fast" });
    const said = replies().map(textOf).find((x) => x.includes("“Think”"))!;
    expect(said).toMatch(/Task created: (t_\S+) “Think” \(fake, smart, low effort\)\./);
    const id = /Task created: (t_\S+)/.exec(said)![1];
    const done = await until(() => {
      const t = hub.store.getTask(id) as Task;
      return t.status === "done" ? t : undefined;
    }, "the task to end");
    expect(done.thinking).toEqual({ preset: "fast", brain: "fake", model: "smart", effort: "low" });
    expect(done.result).toBe("fake thinks: model=smart effort=low");
  });

  it("drops a rule", async () => {
    const [rule] = hub.runner.rules.list();
    expect(await call("work_rule_remove", { id: "rule_nope" })).toMatch(/No rule rule_nope\. Rules: rule_\S+ \(rendering/);
    expect(await call("work_rule_remove", { id: rule.id })).toBe(`tool said: Removed the rule ${rule.id} (rendering, anything for the GPU).`);
    expect(hub.runner.rules.list()).toEqual([]);
  });
});
