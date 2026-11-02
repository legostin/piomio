// A task on another computer really works there (docs/superpowers/specs/2026-11-02-persistent-agents-design.md §7–9):
// the person turns commands on for that computer from the chat with their yes on a card, the hub's own app tools
// (Blender) stay with sessions on the hub's computer, and a picture made there reaches the chat. The machine "box" is
// an in-memory RPC peer for its daemon's requests and the fake brain plugin's peer for its brains.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcPeer, type AgentDef, type Message, type RpcPeer, type RpcTransport, type Task } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { folderRelative } from "../src/tools/core-tools.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

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

/** Two RPC peers talking to each other in memory: the hub's end and the machine daemon's. */
function peerPair(): [RpcPeer, RpcPeer] {
  const ends = [0, 1].map(() => ({ cb: (_m: string) => {}, closed: [] as Array<() => void> }));
  const transport = (me: number): RpcTransport => ({
    send: (m) => setImmediate(() => ends[1 - me].cb(m)),
    onMessage: (cb) => (ends[me].cb = cb),
    onClose: (cb) => ends[me].closed.push(cb),
    close: () => ends.forEach((e) => e.closed.forEach((c) => c())),
  });
  return [createRpcPeer(transport(0)), createRpcPeer(transport(1))];
}

const textOf = (m: Message) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");

describe("commands on another computer and its own apps (integration)", () => {
  let hub: Hub;
  let dialog: string;
  /** What the box's daemon was asked to set, and whether it can (an older daemon has no node.policy). */
  const asked: boolean[] = [];

  const connect = (daemonKnowsPolicy = true) => {
    const [hubEnd, daemon] = peerPair();
    if (daemonKnowsPolicy) daemon.handle("node.policy", (p: { commands: boolean }) => (asked.push(p.commands), { commands: p.commands }));
    (hub.machines as any).peers.set("mach_box", hubEnd);
    hub.brains.registerMachine("mach_box", "box", (hub.brains as any).pluginBrains.get("fake").peer, [{ id: "fake", label: "Fake" }]);
  };
  const replies = () => hub.store.listMessages(dialog, { limit: 500 }).filter((m) => m.role === "assistant");
  /** Sends the dialog a message and waits for the reply that follows it. */
  const say = async (text: string): Promise<string> => {
    const before = replies().length;
    await hub.runner.userMessage(dialog, text);
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
      { dataDir: mkdtempSync(join(tmpdir(), "owl-commands-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    await until(() => hub.brains.has("fake@local"), "fake brains to register");
    const info = { os: "Windows 11 Pro", hostname: "box", arch: "x64", nodeVersion: "v24", version: "0.2.17", allowedDirs: [], clis: [{ brainId: "fake", available: true, authenticated: true }], commands: false };
    hub.db.prepare("insert into machines(id, name, public_key, info, created_at) values (?,?,?,?,?)").run("mach_box", "box", "x", JSON.stringify(info), new Date().toISOString());
    dialog = hub.store.agentConversation("assistant").id;
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("turns commands on for a computer only after the person's yes on its own card", async () => {
    connect();
    await hub.runner.userMessage(dialog, `CALL hub_machine_commands {"machine":"box","on":true}`);
    const card = await until(() => hub.approvals.list(["pending"]).find((a) => a.tool === "hub_machine_commands"), "the card");
    expect(card.summary).toBe("Allow commands on the computer box: agents there may run programs (Blender, builds), each checked by auto mode");
    expect(asked).toEqual([]);
    hub.approvals.resolve(card.id, "approve", { via: "web" });
    await until(() => asked.length > 0, "the machine to be asked");
    expect(asked).toEqual([true]);
    await until(() => hub.machines.get("mach_box")?.info?.commands === true, "the machine's commands to be on");
  });

  it("says to update a computer once when its program cannot do it yet", async () => {
    connect(false);
    await hub.runner.userMessage(dialog, `CALL hub_machine_commands {"machine":"box","on":false}`);
    const card = await until(() => hub.approvals.list(["pending"]).find((a) => a.tool === "hub_machine_commands"), "the card");
    expect(card.summary).toBe("Forbid commands on the computer box");
    hub.approvals.resolve(card.id, "approve", { via: "web" });
    await until(() => replies().some((m) => /update the Piomio app on that computer once/.test(textOf(m))), "the answer");
    expect(asked).toEqual([true]);
    connect();
  });

  it("keeps the tools of an app on the hub's computer away from a session on another computer", () => {
    (hub.gateway as any).d.hubOnly = (owner: string) => owner === "fakebrain";
    try {
      const session = (machine: string) => ({ id: `s_${machine}`, conversationId: dialog, agentId: "assistant", brainRef: `fake@${machine}`, background: false, tainted: false }) as any;
      const owned = (machine: string) => hub.gateway.listFor(session(machine)).filter((t) => t.owner === "fakebrain").map((t) => t.name);
      expect(owned("local")).toEqual(["fake_send"]);
      expect(owned("mach_box")).toEqual([]);
    } finally {
      (hub.gateway as any).d.hubOnly = undefined;
    }
  });

  it("shows a picture a task made on another computer once it reaches the hub", async () => {
    const t = hub.runner.createTask({ agentId: "assistant", goal: `CALL show_images {"images":[{"path":"render.png"}]}`, title: "Render on box", background: false, createdBy: "agent", brainRef: "fake@mach_box" });
    const folder = hub.runner.workspacePath({ agentId: "assistant", taskId: t.id, conversationId: t.conversationId });
    // The hub pulls the machine's folder a moment later.
    setTimeout(() => {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "render.png"), PNG);
    }, 1500);
    const done = await until(() => {
      const now = hub.store.getTask(t.id) as Task;
      return now.status === "done" || now.status === "failed" ? now : undefined;
    }, "the task", 40_000);
    expect(done.result).toMatch(/The user now sees the image/);
  });

  it("finds a picture's place in the task's folder from the other computer's own path", () => {
    const ws = "/data/workspaces/blender-master/t_1";
    expect(folderRelative("render.png", ws)).toBe("render.png");
    expect(folderRelative("out\\render.png", ws)).toBe("out/render.png");
    expect(folderRelative("C:\\Users\\me\\piomio-workspace\\blender-master\\t_1\\out\\render.png", ws)).toBe("out/render.png");
    expect(folderRelative("/home/me/piomio-workspace/blender-master/t_1/render.png", ws)).toBe("render.png");
    expect(folderRelative("C:\\Users\\me\\Desktop\\render.png", ws)).toBeUndefined();
    expect(folderRelative("..\\..\\secret.png", ws)).toBeUndefined();
  });

  it("tells a session on another computer whether commands run there, and the dialog which computers have them off", () => {
    const agent = { id: "assistant", name: "Owl", description: "", brains: [], initiative: 1, tools: ["*"], skills: [], policyProfile: "default", budget: { backgroundRunsPerDay: 5 }, prompt: "", source: "builtin" } as AgentDef;
    const base = { agent, timezone: "UTC", language: "en", consoleUrl: "http://x", background: false, skills: [], nativeSkills: true, appended: [], task: { id: "t1", title: "x", createdBy: "agent" } as Task };
    expect(buildSystemPrompt({ ...base, machine: { name: "box", local: false, commands: false } })).toContain("Commands are off on this computer");
    expect(buildSystemPrompt({ ...base, machine: { name: "box", local: false, commands: true } })).toContain("Commands may run on this computer");
    expect(buildSystemPrompt({ ...base, machine: { name: "Mac", local: true } })).not.toMatch(/Commands (are off|may run)/);
    const dialogPrompt = buildSystemPrompt({
      ...base,
      task: undefined,
      dispatch: { team: [{ id: "assistant", name: "Owl", description: "", where: [] }], computers: [{ id: "local", name: "Mac", online: true }, { id: "mach_box", name: "box", online: true, commands: false }] },
    });
    expect(dialogPrompt).toContain("- mach_box: box; commands off (hub_machine_commands turns them on with the person's yes)");
  });
});
