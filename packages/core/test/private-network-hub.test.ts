// A host inside the person's network, through the whole hub: the card in the chat, the tools, the settings.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Approval, ToolResult } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { agentFromMarkdown } from "../src/agents.ts";

const text = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("private hosts in the hub", () => {
  let hub: Hub;
  let session: string;
  let conversationId: string;
  let cards: Approval[];
  let answer: { decision: "approve" | "deny"; remember?: boolean } | undefined;
  let opened: string[];
  let off: () => void;

  beforeEach(() => {
    const dataDir = mkdtempSync(join(tmpdir(), "private-hub-"));
    hub = new Hub(loadConfig({ PIOMIO_DEVICES: "0" }, { dataDir, builtinPluginsDirs: [], builtinAgentsDir: join(dataDir, "agents") }));
    const dns: Record<string, string[]> = { "jira.corp.example": ["10.20.30.40"], "public.example": ["93.184.216.34"], "rebind.example": ["127.0.0.1"] };
    hub.egress.lookup = async (h) => { if (!dns[h]) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); return dns[h]; };
    hub.egress.ownAddresses = () => [];
    hub.saveAgent(agentFromMarkdown("developer", "---\nname: developer\ndescription: Test\nbrains: [claude@pc]\ninitiative: 2\n---\nYou are a developer.", "user"), "user");
    hub.settings.update({ language: "en" });
    const conv = hub.store.agentConversation("developer");
    conversationId = conv.id;
    // A brain on another computer: no shell of the hub's, so no proxy token of its own.
    session = hub.store.createSession({ conversationId, agentId: "developer", brainRef: "claude@pc", background: false }).row.id;
    cards = []; opened = []; answer = { decision: "approve" };
    off = hub.bus.on("approval.created", (a: Approval) => {
      cards.push(a);
      const how = answer;
      if (how) queueMicrotask(() => hub.approvals.resolve(a.id, how.decision, { via: "web", remember: how.remember }));
    });
    const obj = { type: "object" };
    hub.egress.issueToken("plugin:lan", ["*"]);
    hub.tools.register({ name: "lan_open", description: "open a page", effect: "read", inputSchema: obj, owner: "lan" }, async (i: any) => {
      opened.push(i.url);
      return { content: [{ type: "text", text: `Opened ${i.url}` }] };
    });
    hub.tools.register({ name: "far_open", description: "a service elsewhere opens a page", effect: "read", inputSchema: obj, owner: "far" }, async (i: any) => {
      opened.push(i.url);
      return { content: [{ type: "text", text: `Opened ${i.url}` }] };
    });
  });
  afterEach(async () => { off(); await hub.stop(); });

  it("a tool that opens an address inside the network shows the card by itself, then runs", async () => {
    const result = await hub.gateway.call(session, "lan_open", { url: "https://jira.corp.example/browse/X-1" });
    expect(text(result)).toBe("Opened https://jira.corp.example/browse/X-1");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ sessionId: session, tool: "hub_network_request", ask: { kind: "network", host: "jira.corp.example", port: 443, private: true, addresses: ["10.20.30.40"] } });
    expect(hub.store.listMessages(conversationId).some((m) => m.parts.some((p) => p.type === "approval" && p.approvalId === cards[0].id))).toBe(true);
    // Once covers the session: the next page there opens without another card, and nothing was written down.
    await hub.gateway.call(session, "lan_open", { url: "https://jira.corp.example/browse/X-2" });
    expect(cards).toHaveLength(1);
    expect(hub.settings.get().egressPrivateAllow).toEqual([]);
    // A public address never asks.
    await hub.gateway.call(session, "lan_open", { url: "https://public.example/" });
    expect(cards).toHaveLength(1);
    expect(opened).toHaveLength(3);
  });

  it("a declined card stops the tool and tells the agent plainly", async () => {
    answer = { decision: "deny" };
    const result = await hub.gateway.call(session, "lan_open", { url: "https://jira.corp.example/" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("user declined");
    expect(text(result)).toContain("inside the person's network");
    expect(opened).toHaveLength(0);
  });

  it("always puts the host on the private list for every agent", async () => {
    answer = { decision: "approve", remember: true };
    await hub.gateway.call(session, "lan_open", { url: "http://jira.corp.example:8080/" });
    expect(cards[0].ask).toMatchObject({ host: "jira.corp.example", port: 8080 });
    expect(hub.settings.get().egressPrivateAllow).toEqual(["jira.corp.example"]);
    expect(hub.settings.get().brainEgressAllow).toEqual([]);
    const other = hub.store.createSession({ conversationId, agentId: "developer", brainRef: "claude@pc", background: false }).row.id;
    await hub.gateway.call(other, "lan_open", { url: "https://jira.corp.example/" });
    expect(cards).toHaveLength(1);
  });

  it("asks nothing for a tool that does not run behind the hub's proxy, nor for this computer", async () => {
    await hub.gateway.call(session, "far_open", { url: "https://jira.corp.example/" });
    await hub.gateway.call(session, "lan_open", { url: "http://rebind.example/" });
    await hub.gateway.call(session, "lan_open", { url: "http://127.0.0.1:8081/" });
    await hub.gateway.call(session, "lan_open", { url: "https://no-such-host.example/" });
    expect(cards).toHaveLength(0);
    expect(opened).toHaveLength(4);
  });

  it("hub_network_request asks for a private host from any session, and says a public one needs nothing", async () => {
    const s = hub.store.getSession(session)!;
    const ctx = { sessionId: s.id, conversationId: s.conversationId, agentId: s.agentId, callId: "call", tainted: false, background: false, workspace: "", machineId: "pc" };
    const allowed = await hub.tools.get("hub_network_request")!.invoke({ host: "jira.corp.example" }, ctx);
    expect(allowed.isError).not.toBe(true);
    expect(cards).toHaveLength(1);
    expect(cards[0].ask).toMatchObject({ private: true, host: "jira.corp.example", port: 443 });
    const open = await hub.tools.get("hub_network_request")!.invoke({ host: "public.example" }, ctx);
    expect(text(open)).toContain("public host");
    expect(cards).toHaveLength(1);
  });

  it("the private list is the person's: checked when they set it, closed to an agent's settings tool", async () => {
    hub.updateSettings({ egressPrivateAllow: [" Jira.Corp.Example. ", "*.corp.example", "nas", "192.168.1.10", "nas"] }, "user");
    expect(hub.settings.get().egressPrivateAllow).toEqual(["jira.corp.example", "*.corp.example", "nas", "192.168.1.10"]);
    expect(hub.audit.list({ action: "egress.private.update" })).toHaveLength(1);
    for (const bad of [["*"], ["http://nas.local"], "nas", [1], ["nas.local:8080"]]) expect(() => hub.updateSettings({ egressPrivateAllow: bad }, "user"), JSON.stringify(bad)).toThrow();
    expect(hub.settings.get().egressPrivateAllow).toEqual(["jira.corp.example", "*.corp.example", "nas", "192.168.1.10"]);
    const s = hub.store.getSession(session)!;
    const ctx = { sessionId: s.id, conversationId: s.conversationId, agentId: s.agentId, callId: "call", tainted: false, background: false, workspace: "", machineId: "pc" };
    const bypass = await hub.tools.get("hub_settings_update")!.invoke({ patch: { egressPrivateAllow: ["evil.example"] } }, ctx);
    expect(bypass.isError).toBe(true);
    expect(text(bypass)).toContain("hub_network_request");
    expect(hub.settings.get().egressPrivateAllow).not.toContain("evil.example");
  });
});
