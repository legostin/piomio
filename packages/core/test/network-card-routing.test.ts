import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "@piomio/testkit";
import { Hub, loadConfig } from "../src/index.ts";

describe("a task's network permission in the starter dialog", () => {
  let hub: Hub, base: string, cookie: string, csrf: string;
  const post = (path: string, body = {}, authenticated = true) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", origin: base, ...(authenticated ? { cookie, "x-csrf": csrf } : {}) }, body: JSON.stringify(body) });
  beforeAll(async () => {
    const config = loadConfig({ PIOMIO_PORT: String(await freePort()), PIOMIO_CONSOLE_PORT: String(await freePort()), PIOMIO_EGRESS_PORT: String(await freePort()), PIOMIO_DEVICES: "0", TZ: "UTC" }, { dataDir: mkdtempSync(join(tmpdir(), "network-routing-")), builtinPluginsDirs: [], builtinAgentsDir: join(import.meta.dirname, "fixtures", "agents"), plugins: "none" });
    hub = new Hub(config); await hub.start(); base = config.publicUrl;
    const setup = await post("/api/auth/setup", { token: hub.auth.setupToken, password: "network-routing-test-pass" }, false);
    cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
    csrf = (await (await fetch(base + "/api/bootstrap", { headers: { cookie } })).json()).csrf;
  });
  afterAll(async () => { vi.restoreAllMocks(); await hub?.stop(); });

  it("delivers pending to the parent synchronously and sends resolved metadata to both chats", () => {
    const dialog = hub.store.createConversation({ agentId: "assistant", kind: "dialog", title: "Parent" });
    const task = hub.store.createTask({ agentId: "assistant", title: "Network", goal: "Network", createdBy: "user", parentConversationId: dialog.id, status: "running" });
    const events: string[] = []; const off = hub.bus.on("message.updated", (m) => events.push(m.conversationId));
    const a = hub.approvals.create({ sessionId: "s", conversationId: task.conversationId, taskId: task.id, agentId: "assistant", tool: "hub_network_request", input: { host: "registry.npmjs.org", port: 443 }, summary: "Network", ask: { kind: "network", detail: "registry.npmjs.org:443", host: "registry.npmjs.org", port: 443, listed: true, networkExpiresAt: new Date(Date.now() + 600_000).toISOString() }, effect: "read", tainted: true });
    const card = (id: string) => hub.store.listMessages(id).flatMap((m) => m.parts).find((p) => p.type === "approval" && p.approvalId === a.id);
    expect(card(dialog.id)).toMatchObject({ status: "pending", ask: { networkExpiresAt: a.ask!.networkExpiresAt, listed: true } });
    expect(hub.store.listMessages(dialog.id)[0]!.parts[0]).toEqual({ type: "task", taskId: task.id });
    hub.approvals.expire(a.id, "connection_closed");
    for (const id of [dialog.id, task.conversationId]) expect(card(id)).toMatchObject({ status: "expired", ask: { networkClosedReason: "connection_closed" } });
    expect(events).toEqual(expect.arrayContaining([dialog.id, task.conversationId]));
    const next = hub.approvals.create({ ...a, ask: { ...a.ask!, networkClosedReason: undefined } });
    hub.approvals.resolve(next.id, "approve", { via: "web" });
    for (const id of [dialog.id, task.conversationId]) expect(hub.store.listMessages(id).flatMap((m) => m.parts).find((p) => p.type === "approval" && p.approvalId === next.id)).toMatchObject({ status: "approved" });
    off();
  });

  it("an authenticated explicit retry asks for a fresh context once and never approves or connects", async () => {
    const dialog = hub.store.agentConversation("assistant");
    const a = hub.approvals.create({ sessionId: "old-session", conversationId: dialog.id, agentId: "assistant", tool: "hub_network_request", input: {}, summary: "Network", ask: { kind: "network", detail: "new.example:443", host: "new.example", port: 443 }, effect: "read", tainted: true });
    const userMessage = vi.spyOn(hub.runner, "userMessage").mockResolvedValue({} as any);
    const connect = vi.spyOn(hub.egress, "requestHost");
    hub.approvals.expire(a.id, "connection_closed");
    expect(userMessage).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
    expect((await post(`/api/approvals/${a.id}/network-retry`, {}, false)).status).toBe(401);
    const results = await Promise.all([post(`/api/approvals/${a.id}/network-retry`), post(`/api/approvals/${a.id}/network-retry`)]);
    expect(results.map((r) => r.status)).toEqual([202, 202]);
    expect(userMessage).toHaveBeenCalledTimes(1);
    expect(userMessage).toHaveBeenCalledWith(dialog.id, expect.stringContaining("new permission card in your current session"), { channel: "web" });
    expect(connect).not.toHaveBeenCalled();
    expect(hub.approvals.get(a.id)).toMatchObject({ status: "expired", ask: { networkRetryRequestedAt: expect.any(String) } });
    expect((await post(`/api/approvals/${a.id}`, { decision: "approve", remember: true })).status).toBe(409);
    expect(hub.settings.get().brainEgressAllow).not.toContain("new.example");
    userMessage.mockRestore(); connect.mockRestore();
  });

  it("does not accept retries of a live approval and releases its retry latch if delivery fails", async () => {
    const dialog = hub.store.agentConversation("assistant");
    const a = hub.approvals.create({ sessionId: "s", conversationId: dialog.id, agentId: "assistant", tool: "hub_network_request", input: {}, summary: "Network", ask: { kind: "network", detail: "new.example:443", host: "new.example", port: 443 }, effect: "read", tainted: true });
    const userMessage = vi.spyOn(hub.runner, "userMessage").mockRejectedValue(new Error("cannot deliver"));
    expect((await post(`/api/approvals/${a.id}/network-retry`)).status).toBe(409);
    expect(userMessage).not.toHaveBeenCalled();
    const unrelated = hub.approvals.create({ ...a, tool: "another_tool" });
    hub.approvals.expire(unrelated.id);
    expect((await post(`/api/approvals/${unrelated.id}/network-retry`)).status).toBe(409);
    expect(userMessage).not.toHaveBeenCalled();
    hub.approvals.expire(a.id, "connection_closed");
    expect((await post(`/api/approvals/${a.id}/network-retry`)).status).toBe(500);
    expect(hub.approvals.get(a.id)!.ask!.networkRetryRequestedAt).toBeUndefined();
    expect(hub.approvals.get(a.id)!.status).toBe("expired");
    userMessage.mockRestore();
  });
});
