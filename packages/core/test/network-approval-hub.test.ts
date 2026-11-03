import { expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Approval } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";

it("network cards reach task and starter chats; always persists only a host, push still asks separately", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "network-hub-"));
  const hub = new Hub(loadConfig({ PIOMIO_DEVICES: "0" }, { dataDir, builtinPluginsDirs: [], builtinAgentsDir: join(dataDir, "agents") }));
  const parent = hub.store.agentConversation("developer");
  const task = hub.store.createTask({ agentId: "developer", title: "Network check", goal: "Check network", createdBy: "user", background: false, status: "running", parentConversationId: parent.id });
  const { row } = hub.store.createSession({ conversationId: task.conversationId, taskId: task.id, agentId: "developer", brainRef: "codex@local", background: false });
  const ctx = { sessionId: row.id, conversationId: row.conversationId, taskId: task.id, agentId: row.agentId };
  hub.egress.issueToken(`brain:${row.id}`, [], ctx);
  hub.settings.update({ approvalMode: "ask" });
  const cards: Approval[] = [];
  let permitHost = true;
  const off = hub.bus.on("approval.created", (a: Approval) => {
    cards.push(a);
    for (const conv of [task.conversationId, parent.id]) expect(hub.store.listMessages(conv).some((m) => m.parts.some((p) => p.type === "approval" && p.approvalId === a.id))).toBe(true);
    queueMicrotask(() => hub.approvals.resolve(a.id, a.ask?.kind === "network" && permitHost ? "approve" : "deny", { via: "web", remember: a.ask?.kind === "network" }));
  });
  try {
    const invoke = (name: string, input: unknown) => hub.tools.get(name)!.invoke(input, { ...ctx, callId: "call", tainted: true, background: false, workspace: join(dataDir, "workspaces/developer/task"), machineId: "local" });
    const result = await invoke("hub_network_request", { host: "1.1.1.1" });
    expect(result.isError).not.toBe(true);
    expect(cards[0].ask).toMatchObject({ kind: "network", task: "Network check", ipLiteral: true });
    expect(hub.settings.get().brainEgressAllow).toEqual(["1.1.1.1"]);
    expect(hub.rules.list()).toHaveLength(0);
    expect(hub.store.getTask(task.id)?.status).toBe("running");
    await invoke("hub_network_request", { host: "1.1.1.1" });
    expect(cards).toHaveLength(1);
    const push = await invoke("native_permission", { tool_name: "codex.command", input: { command: "git push origin main" } });
    expect(cards).toHaveLength(2); expect(cards[1].ask?.kind).toBe("command");
    expect(JSON.stringify(push)).toContain("declined");
    permitHost = false;
    const denied = await invoke("hub_network_request", { host: "1.0.0.1" });
    expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).toContain("user declined");
    expect(hub.store.listMessages(task.conversationId).some((m) => m.role === "system" && JSON.stringify(m.parts).includes("Host 1.0.0.1:443 is not allowed: user declined"))).toBe(true);
    // The live brain receives that exact explanation, without starting another turn.
    const steer = vi.fn().mockResolvedValue(true);
    (hub.runner as any).activeTurns.set(task.conversationId, { row, handle: { steer } });
    hub.runner.networkDenied(row.id, row.conversationId, "Network permission: user declined");
    expect(steer).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Network permission: user declined") }));
    (hub.runner as any).activeTurns.delete(task.conversationId);
    // An agent cannot bypass the card by changing settings.
    const bypass = await invoke("hub_settings_update", { patch: { brainEgressAllow: ["evil.example"] } });
    expect(bypass.isError).toBe(true); expect(hub.settings.get().brainEgressAllow).toEqual(["1.1.1.1"]);
    hub.updateSettings({ brainEgressAllow: ["*.GitHub.com."] }, "user");
    expect(hub.settings.get().brainEgressAllow).toEqual(["*.github.com"]);
    expect(() => hub.updateSettings({ brainEgressAllow: ["*"] }, "user")).toThrow();
    expect(() => hub.updateSettings({ brainEgressAllow: ["169.254.169.254"] }, "user")).toThrow();
    expect(hub.audit.list({ action: "egress.allow.update" })).toHaveLength(1);
  } finally { off(); await hub.stop(); }
});
