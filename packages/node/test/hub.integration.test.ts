// The daemon against a REAL hub (packages/core) running in-process: pairing, challenge auth, node.hello,
// fs/exec over hub.machines.call and a remote brain session with a fake Claude Code CLI.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort } from "@piomio/testkit";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDef, BrainEvent, BrainSessionOptions } from "@piomio/shared";
import { Hub } from "../../core/src/app.ts";
import { loadConfig } from "../../core/src/config.ts";
import { PolicyStore } from "../src/policy.ts";
import { pair } from "../src/pair.ts";
import { createNodeDaemon, type NodeDaemon } from "../src/daemon.ts";
import { loadConfig as loadNodeConfig } from "../src/home.ts";

const FAKE_CLAUDE = fileURLToPath(new URL("../../brains-cli/test/fixtures/fake-claude.mjs", import.meta.url));
const MCP_BRIDGE = fileURLToPath(new URL("../../mcp-bridge/src/index.ts", import.meta.url));

async function until<T>(fn: () => T | undefined | false, timeoutMs = 10_000, what = "condition"): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const agent: AgentDef = {
  id: "assistant",
  name: "assistant",
  description: "",
  brains: [],
  initiative: 0,
  tools: ["*"],
  skills: [],
  policyProfile: "default",
  budget: { backgroundRunsPerDay: 0 },
  prompt: "",
  source: "builtin",
};

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "obn-hub-")));
const nodeHomeDir = join(root, "node-home");
const userHome = join(root, "user");
const workspace = join(userHome, "piomio-workspace");
let hub: Hub;
let daemon: NodeDaemon;
let machineId: string;
const logs: string[] = [];
const fatal: string[] = [];

function editPolicy(mut: (p: any) => void): void {
  const file = join(nodeHomeDir, "policy.json");
  const p = JSON.parse(readFileSync(file, "utf8"));
  mut(p);
  writeFileSync(file, JSON.stringify(p, null, 2));
}

beforeAll(async () => {
  const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
  const config = loadConfig({
    PIOMIO_DATA_DIR: join(root, "hub-data"),
    PIOMIO_PORT: String(port),
    PIOMIO_DEVICES: "0",
    PIOMIO_CONSOLE_PORT: String(consolePort),
    PIOMIO_EGRESS_PORT: String(egressPort),
    PIOMIO_PLUGINS: "none",
  });
  hub = new Hub(config);
  await hub.start();

  // The owner's local policy: fake Claude CLI, Codex "not installed", exec allowed.
  new PolicyStore(nodeHomeDir, { userHome });
  editPolicy((p) => {
    p.exec.enabled = true;
    p.brains["claude-code"].command = FAKE_CLAUDE;
    p.brains.codex.command = join(root, "no-such-codex-cli");
  });

  const { code } = hub.machines.createPairingCode();
  const paired = await pair({ home: nodeHomeDir, hubUrl: hub.config.publicUrl + "/", code, name: "test-box" });
  machineId = paired.machineId;

  daemon = createNodeDaemon({ home: nodeHomeDir, userHome, log: (m) => logs.push(m), minBackoffMs: 100, maxBackoffMs: 500, onFatal: (m) => fatal.push(m) });
  daemon.client.start();
  await daemon.client.waitOnline(15_000);
}, 60_000);

afterAll(async () => {
  if (process.env.OBN_DEBUG) console.log(logs.map((l) => `LOG ${l}`).join("\n"));
  await daemon?.stop();
  await hub?.stop();
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* windows may still hold the sqlite file */
  }
}, 30_000);

describe("pairing and connection", () => {
  it("wrote config.json and rejects a reused code", async () => {
    const c = loadNodeConfig(nodeHomeDir);
    expect(c).toMatchObject({ hubUrl: hub.config.publicUrl, machineId, name: "test-box" });
    await expect(pair({ home: join(root, "other-home"), hubUrl: hub.config.publicUrl, code: "WRONG123" })).rejects.toThrow(/rejected the pairing/);
  });

  it("explains an unreachable hub", async () => {
    const port = await freePort();
    await expect(pair({ home: join(root, "other-home"), hubUrl: `http://127.0.0.1:${port}`, code: "X" })).rejects.toThrow(/Could not reach the hub/);
  });

  it("shows the machine online with its info", () => {
    const m = hub.machines.list().find((x) => x.id === machineId);
    expect(m?.status).toBe("online");
    expect(m?.name).toBe("test-box");
    expect(m?.info?.allowedDirs).toEqual([workspace]);
    expect(m?.info?.nodeVersion).toBe(process.version);
    const cc = m?.info?.clis.find((c) => c.brainId === "claude-code");
    expect(cc).toMatchObject({ available: true, version: "9.9.9" });
    expect(m?.info?.clis.find((c) => c.brainId === "codex")?.available).toBe(false);
  });

  it("registers only installed brains", async () => {
    const refs = hub.brains.list().map((b) => b.ref);
    expect(refs).toContain(`claude-code@${machineId}`);
    expect(refs).not.toContain(`codex@${machineId}`);
    const probe = await hub.brains.probe(`claude-code@${machineId}`, 0);
    expect(probe).toMatchObject({ available: true, version: "9.9.9" });
  });
});

describe("one computer with hub and node executors", () => {
  it("has one computer/activity identity and keeps an existing task's brain reference and folder", async () => {
    expect(hub.machines.get(machineId)?.sameHost).toBe(true);
    expect(hub.machines.canonical(machineId)).toBe(hub.here());
    expect(hub.computers()).toHaveLength(1);
    expect(hub.computers()[0].aliases).toContain(machineId);
    expect(hub.resolveComputer(machineId)).toBe(hub.here());
    expect(hub.resolveComputer("test-box")).toBe(hub.here());
    const activityId = "identity-test-turn";
    hub.activity.start(activityId, { agentId: "assistant", conversationId: "c_test", brainRef: `claude-code@${machineId}` });
    try {
      expect(hub.activity.view()).toHaveLength(1);
      expect(hub.activity.view()[0].work.some((w) => w.conversationId === "c_test")).toBe(true);
    } finally { hub.activity.end(activityId); }
    hub.saveAgent({ ...agent, id: "identity-dev", name: "Dev", brains: [`claude-code@${machineId}`], machines: [machineId] }, "user");
    const task = hub.store.createTask({ agentId: "identity-dev", title: "Kept", goal: "Keep", brainRef: `claude-code@${machineId}`, createdBy: "agent", background: true, resumeAt: "2099-01-01T00:00:00.000Z", status: "queued" });
    expect(hub.runner.placeTask("identity-dev", "local")).toMatchObject({ brainRef: `claude-code@${machineId}` });
    expect(hub.runner.placeTask("identity-dev", machineId)).toMatchObject({ brainRef: `claude-code@${machineId}` });
    expect(hub.store.getTask(task.id)?.brainRef).toBe(`claude-code@${machineId}`);
    expect(hub.machines.get(machineId)?.info?.workspacesRoot).toBe(workspace);
    const dialog = hub.store.agentConversation("identity-dev").id;
    const parentFile = join(workspace, "identity-dev", dialog, "attachments", "input.jpeg");
    mkdirSync(join(workspace, "identity-dev", dialog, "attachments"), { recursive: true });
    writeFileSync(parentFile, "image");
    const taskDir = join(workspace, "identity-dev", task.id);
    mkdirSync(taskDir, { recursive: true });
    const session = hub.store.createSession({ agentId: "identity-dev", conversationId: task.conversationId, taskId: task.id, brainRef: `claude-code@${machineId}`, background: false }).row;
    let reviewed = false;
    hub.auto.useReviewer(() => async () => { reviewed = true; return "BLOCK"; });
    const verdict = await hub.auto.decide({ tool: "machine_exec", kind: "tool", effect: "external", input: { machine: machineId, cwd: taskDir, command: `ls -la '${parentFile}'` }, summary: "Read own attachment", why: "command" }, { sessionId: session.id, conversationId: session.conversationId, taskId: task.id, agentId: "identity-dev", workspace: hub.runner.workspacePath(session), machineId, machine: "test-box" });
    expect(verdict.decision).toBe("allow");
    expect(reviewed).toBe(false);
    const compound = await hub.auto.decide({ tool: "machine_exec", kind: "tool", effect: "external", input: { machine: machineId, cwd: taskDir, command: `ls -la '${parentFile}' && pwd` }, summary: "Compound file operation", why: "command" }, { sessionId: session.id, conversationId: session.conversationId, taskId: task.id, agentId: "identity-dev", workspace: hub.runner.workspacePath(session), machineId, machine: "test-box" });
    expect(compound.decision).not.toBe("allow");
    expect(reviewed).toBe(true);
    expect(readFileSync(parentFile, "utf8")).toBe("image");
    // The node also verifies paths on its own filesystem for hubs on a different computer.
    expect(await hub.machines.ownsFiles(machineId, "identity-dev", [task.id, dialog], { paths: [parentFile, join(taskDir, "result.jpeg")], write: true })).toBe(true);
    expect(await hub.machines.ownsFiles(machineId, "identity-dev", [task.id], { paths: [join(workspace, "assistant", "other", "x")], write: false })).toBe(false);
  });
});


describe("files and commands through the hub", () => {
  it("fs.write / fs.read / fs.list inside the allowed dir", async () => {
    const file = join(workspace, "docs", "hello.txt");
    const secret = "секретное содержимое 42";
    const w = await hub.machines.call<{ bytes: number }>(machineId, "fs.write", { path: file, content: secret });
    expect(w.bytes).toBe(Buffer.byteLength(secret));
    expect(readFileSync(file, "utf8")).toBe(secret);
    const r = await hub.machines.call<{ content: string }>(machineId, "fs.read", { path: file });
    expect(r.content).toBe(secret);
    const l = await hub.machines.call<{ entries: Array<{ name: string; type: string }> }>(machineId, "fs.list", { path: workspace });
    expect(l.entries).toContainEqual({ name: "docs", type: "dir" });
    // Every request is logged on one line, never with file contents.
    expect(logs.some((x) => x.startsWith("fs.write ") && x.includes("hello.txt"))).toBe(true);
    expect(logs.some((x) => x.includes(secret))).toBe(false);
  });

  it("refuses paths outside the allowed dirs and the daemon home", async () => {
    await expect(hub.machines.call(machineId, "fs.read", { path: join(root, "hub-data", "piomio.db") })).rejects.toThrow(/outside the allowed/);
    await expect(hub.machines.call(machineId, "fs.write", { path: join(nodeHomeDir, "policy.json"), content: "{}" })).rejects.toThrow(/outside the allowed|state folder/);
    await expect(hub.machines.call(machineId, "fs.read", { path: `${workspace}/../../node-home/key.json` })).rejects.toThrow(/must not contain/);
  });

  it("exec.run runs in the allowed dir and obeys policy reloads", async () => {
    const r = await hub.machines.call<{ code: number; stdout: string; stderr: string }>(machineId, "exec.run", {
      command: `"${process.execPath}" -e "console.log(process.cwd())"`,
      timeoutMs: 20_000,
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim().toLowerCase()).toBe(workspace.toLowerCase());
    editPolicy((p) => (p.exec.enabled = false));
    await expect(hub.machines.call(machineId, "exec.run", { command: "echo hi", timeoutMs: 5000 })).rejects.toThrow(/exec.enabled = false/);
  });
});

describe("remote brain session", () => {
  const opts = (sessionId: string, ws: string): BrainSessionOptions => ({
    sessionId,
    agent,
    workspace: ws,
    mcp: { url: "http://hub-public-url.invalid/mcp", token: "session-token", bridgeCommand: [] },
    systemPrompt: "You are a test",
    skillsDir: "/hub/only/skills",
    claudePluginDirs: ["/hub/only/plugin"],
    env: { TZ: "UTC", NODE_OPTIONS: "--require /tmp/evil.js", ANTHROPIC_BASE_URL: "http://evil" },
    background: false,
  });

  it("streams events from the machine's Claude Code", async () => {
    const handle = await hub.brains.create(`claude-code@${machineId}`, opts("sess_remote1", "assistant/c_test"));
    const wsDir = join(workspace, "assistant", "c_test");
    expect(existsSync(wsDir)).toBe(true);

    // MCP bridge runs from this checkout and talks to the hub URL the node paired with.
    const stateDir = join(nodeHomeDir, "brains", "claude-code", "sessions", "sess_remote1");
    const mcp = JSON.parse(readFileSync(join(stateDir, "mcp.json"), "utf8")).mcpServers.piomio;
    expect(mcp.command).toBe(process.execPath);
    expect(realpathSync.native(mcp.args[mcp.args.length - 1])).toBe(realpathSync.native(MCP_BRIDGE));
    expect(mcp.env.PIOMIO_URL).toBe(`${hub.config.publicUrl}/mcp`);

    const events: BrainEvent[] = [];
    await handle.send({ text: "hello" }, (e) => events.push(e));
    const text = events.filter((e) => e.type === "text").map((e: any) => e.delta).join("");
    expect(text).toContain("echo:hello");
    expect(events).toContainEqual({ type: "tool_call", id: "tu1", name: "notify", input: { level: "silent", title: "x" } });
    expect(events.at(-1)).toEqual({ type: "done", resumeToken: "sess-1" });

    await handle.close();
    await until(() => !existsSync(stateDir), 5000, "session state cleanup");
  });

  it("gives the machine's brain a working MCP bridge to the hub", async () => {
    const conv = hub.store.agentConversation("assistant");
    const { row, token } = hub.store.createSession({ conversationId: conv.id, agentId: "assistant", brainRef: `claude-code@${machineId}`, background: false });
    const handle = await hub.brains.create(`claude-code@${machineId}`, { ...opts(row.id, "assistant/c_mcp"), mcp: { url: "http://unused.invalid/mcp", token, bridgeCommand: [] } });
    const stateDir = join(nodeHomeDir, "brains", "claude-code", "sessions", row.id.replace(/[^\w-]/g, "_"));
    const mcp = JSON.parse(readFileSync(join(stateDir, "mcp.json"), "utf8")).mcpServers.piomio;
    // Run the bridge exactly as Claude Code would, and list the hub's tools through it.
    const bridge = spawn(mcp.command, mcp.args, { env: { ...process.env, ...mcp.env }, stdio: ["pipe", "pipe", "inherit"] });
    const lines = createInterface({ input: bridge.stdout! });
    const replies = new Map<number, any>();
    lines.on("line", (l) => {
      const m = JSON.parse(l);
      replies.set(m.id, m);
    });
    bridge.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) + "\n");
    bridge.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    const list = await until(() => replies.get(2), 10_000, "tools/list through the bridge");
    bridge.stdin!.end();
    expect(replies.get(1)?.result?.serverInfo).toBeTruthy();
    expect(list.result.tools.map((t: any) => t.name)).toContain("machine_list");
    await handle.close();
  });

  it("refuses workspace keys that escape the workspaces root", async () => {
    await expect(hub.brains.create(`claude-code@${machineId}`, opts("sess_bad", "../escape"))).rejects.toThrow(/Invalid working folder key/);
    await expect(hub.brains.create(`claude-code@${machineId}`, opts("sess_bad2", workspace))).rejects.toThrow(/relative key/);
  });

  it("re-announces brains when the owner disables one", async () => {
    editPolicy((p) => (p.brains["claude-code"].enabled = false));
    await until(() => !hub.brains.list().some((b) => b.ref === `claude-code@${machineId}`), 15_000, "claude-code to be unregistered");
    await expect(hub.machines.call(machineId, "brain.create", { brainId: "claude-code", opts: opts("sess_x", "a/b") })).rejects.toThrow(/disabled/);
  });
});

describe("the shared workspaces folder", () => {
  // Bigger than the hub's 4 MB and the node's 16 MB WebSocket frames: a whole-file answer closed the socket.
  it("carries a 20 MB file both ways without dropping the connection", async () => {
    const lost = () => logs.filter((l) => /lost the connection|unreachable/i.test(l)).length;
    const before = lost();
    const toNode = randomBytes(20 * 1024 * 1024);
    mkdirSync(join(root, "hub-data", "workspaces", "big"), { recursive: true });
    writeFileSync(join(root, "hub-data", "workspaces", "big", "from-hub.bin"), toNode);
    const onNode = join(workspace, "big", "from-hub.bin");
    await until(() => existsSync(onNode) && readFileSync(onNode).equals(toNode), 60_000, "the hub's file on the node");
    const toHub = randomBytes(20 * 1024 * 1024);
    writeFileSync(join(workspace, "big", "from-node.bin"), toHub);
    const onHub = join(root, "hub-data", "workspaces", "big", "from-node.bin");
    await until(() => existsSync(onHub) && readFileSync(onHub).equals(toHub), 60_000, "the node's file on the hub");
    expect(lost()).toBe(before);
  }, 150_000);
});

describe("a CLI signed in after the daemon started", () => {
  it("reaches the hub by itself while nothing here was signed in", async () => {
    const home2 = join(root, "node-home-2");
    const user2 = join(root, "user-2");
    // The fake Claude Code is signed in once HOME/.claude/.credentials.json exists, as after `claude` over SSH.
    const oldHome = process.env.HOME;
    process.env.HOME = user2;
    let d2: NodeDaemon | undefined;
    try {
      new PolicyStore(home2, { userHome: user2 });
      const file = join(home2, "policy.json");
      const p = JSON.parse(readFileSync(file, "utf8"));
      p.brains["claude-code"].command = FAKE_CLAUDE;
      p.brains.codex.command = join(root, "no-such-codex-cli");
      p.brains.kimi.command = join(root, "no-such-kimi-cli");
      writeFileSync(file, JSON.stringify(p, null, 2));
      const { code } = hub.machines.createPairingCode();
      const { machineId: id } = await pair({ home: home2, hubUrl: hub.config.publicUrl, code, name: "later-box" });
      d2 = createNodeDaemon({ home: home2, userHome: user2, log: () => {}, brainRecheckMs: 200, minBackoffMs: 100, maxBackoffMs: 500 });
      d2.client.start();
      await d2.client.waitOnline(15_000);
      const signedIn = () => hub.machines.list().find((m) => m.id === id)?.info?.clis.find((c) => c.brainId === "claude-code")?.authenticated;
      expect(signedIn()).toBe(false);
      mkdirSync(join(user2, ".claude"), { recursive: true });
      writeFileSync(join(user2, ".claude", ".credentials.json"), "{}");
      await until(() => signedIn(), 15_000, "the sign-in to reach the hub");
    } finally {
      await d2?.stop();
      process.env.HOME = oldHome;
    }
  });
});

describe("revocation", () => {
  it("stops for good when the hub revokes the machine", async () => {
    hub.machines.revoke(machineId);
    await until(() => fatal.length > 0, 15_000, "fatal 4401");
    expect(fatal[0]).toMatch(/refused the connection/);
    expect(daemon.client.state).toBe("stopped");
    expect(hub.machines.list().some((m) => m.id === machineId)).toBe(false);
  });
});
