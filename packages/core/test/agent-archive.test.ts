// Pinning, archiving and deleting agents (agents-state.ts, Hub.pinAgent / archiveAgent / deleteAgent): the agent's
// menu in the list (the API) and the default agent's hub tools in its chat. Runs the scripted fake brain
// (test/fixtures/plugins/fakebrain): "CALL <tool> <json>".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDef, TeamMember } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { agentFromMarkdown } from "../src/agents.ts";
import { createCoreCall } from "../src/core-call.ts";

const fixtures = join(import.meta.dirname, "fixtures");

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

async function until<T>(fn: () => T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Minimal browser-like client: one cookie jar, Origin header, CSRF header when known. */
class Client {
  cookie = "";
  csrf = "";
  base: string;
  constructor(base: string) {
    this.base = base;
  }
  async raw(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const r = await fetch(this.base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        origin: this.base,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf ? { "x-csrf": this.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    const text = await r.text();
    let json: any = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: r.status, json };
  }
  async req(method: string, path: string, body?: unknown): Promise<any> {
    const r = await this.raw(method, path, body);
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  }
}

describe("pinning, archiving and deleting agents", () => {
  let hub: Hub;
  let web: Client;

  const make = (id: string, name: string) =>
    hub.saveAgent(agentFromMarkdown(id, `---\nname: ${name}\ndescription: ${name} helps\nbrains: [fake@local]\n---\nYou are ${name}.`, "user"), "user");
  const team = async (): Promise<TeamMember[]> => web.req("GET", "/api/team");
  const agents = async (): Promise<AgentDef[]> => web.req("GET", "/api/agents");
  const conv = (agentId: string) => hub.store.agentConversation(agentId).id;
  /** The fake brain's "tool said:" reply to the person's message in the agent's dialog. */
  const say = async (agentId: string, text: string): Promise<string> => {
    const c = conv(agentId);
    const before = hub.store.listMessages(c, { limit: 500 }).length;
    await hub.runner.userMessage(c, text, { channel: "web" });
    const m = await until(
      () =>
        hub.store
          .listMessages(c, { limit: 500 })
          .slice(before)
          .find((x) => x.role === "assistant" && x.status !== "streaming" && x.parts.some((p) => p.type === "text" && p.text.startsWith("tool said:"))),
      `the reply to ${text}`,
    );
    return (m.parts.find((p) => p.type === "text" && p.text.startsWith("tool said:")) as { text: string }).text;
  };

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-archive-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    await until(() => hub.brains.has("fake@local"), "the fake brain");
    web = new Client(config.publicUrl);
    await web.req("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    web.csrf = (await web.req("GET", "/api/bootstrap")).csrf;
    hub.saveAgent({ ...hub.agents.get("assistant")!, brains: ["fake@local"], source: "user" }, "user");
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("pins agents in the order pinned, for every client", async () => {
    make("scout", "Scout");
    make("writer", "Writer");
    await web.req("POST", "/api/agents/writer/pin", { pinned: true });
    await web.req("POST", "/api/agents/scout/pin", { pinned: true });
    const t = await team();
    expect(t.find((m) => m.agentId === "writer")?.pinned).toBe(0);
    expect(t.find((m) => m.agentId === "scout")?.pinned).toBe(1);
    expect(t.find((m) => m.agentId === "assistant")?.pinned).toBeUndefined();
    await web.req("POST", "/api/agents/writer/pin", { pinned: false });
    expect((await team()).find((m) => m.agentId === "scout")?.pinned).toBe(0);
    expect((await web.raw("POST", "/api/agents/nobody/pin", { pinned: true })).status).toBe(404);
  });

  it("marks a dialog unread again until it is read", async () => {
    const c = conv("scout");
    hub.store.addMessage({ conversationId: c, role: "assistant", agentId: "scout", parts: [{ type: "text", text: "Found three" }], status: "complete" });
    await web.req("POST", `/api/conversations/${c}/read`, {});
    expect(hub.team.member("scout").unread).toBe(0);
    await web.req("POST", `/api/conversations/${c}/unread`, {});
    expect(hub.team.member("scout").unread).toBe(1);
    await web.req("POST", `/api/conversations/${c}/read`, {});
    expect(hub.team.member("scout").unread).toBe(0);
  });

  it("puts an agent to sleep in the archive and brings it back as it was", async () => {
    const c = conv("scout");
    const before = hub.store.listMessages(c, { limit: 100 }).length;
    expect(await web.req("POST", "/api/agents/scout/archive", { archived: true })).toEqual({ ok: true, defaultAgent: "assistant" });
    expect((await team()).some((m) => m.agentId === "scout")).toBe(false);
    expect((await agents()).find((a) => a.id === "scout")).toMatchObject({ archived: true });
    expect(hub.agents.list().some((a) => a.id === "scout")).toBe(false);
    // Nobody writes in its dialog; teammates do not find it; a schedule's run is skipped, not failed.
    const sent = await web.raw("POST", `/api/conversations/${c}/messages`, { text: "hello?" });
    expect(sent.status).toBe(409);
    expect(sent.json.error).toBe("Scout is in the archive. Bring them back to talk.");
    expect((await hub.runner.messageTeammate("scout", "hi", { agentId: "assistant", conversationId: conv("assistant"), background: false })).ok).toBe(false);
    // It cannot be the default agent while it sleeps.
    expect((await web.raw("PATCH", "/api/settings", { defaultAgent: "scout" })).status).toBe(400);

    await web.req("POST", "/api/agents/scout/archive", { archived: false });
    expect((await team()).find((m) => m.agentId === "scout")?.pinned).toBe(0);
    expect(hub.store.listMessages(c, { limit: 100 }).length).toBe(before);
  });

  it("skips a sleeping agent's schedule and channel runs", async () => {
    hub.archiveAgent("writer", true, {}, "user");
    expect(await createCoreCall(hub)("triggers", "tasks.create", { agentId: "writer", goal: "Write", title: "Morning" })).toEqual({ skipped: "agentArchived" });
    const queued = hub.runner.createTask({ agentId: "writer", goal: "Write", title: "Late", background: true, createdBy: "trigger" });
    await until(() => hub.store.getTask(queued.id)?.status === "cancelled", "the task to be cancelled");
    hub.archiveAgent("writer", false, {}, "user");
  });

  it("the default agent sleeps or leaves only with a successor", async () => {
    const bad = await web.raw("POST", "/api/agents/assistant/archive", { archived: true });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/is the default agent: first pick who takes their place/);
    expect((await web.raw("DELETE", "/api/agents/assistant")).status).toBe(400);
    expect((await web.raw("DELETE", "/api/agents/assistant?successor=assistant")).status).toBe(400);
    expect(hub.settings.get().defaultAgent).toBe("assistant");

    expect(await web.req("POST", "/api/agents/assistant/archive", { archived: true, successor: "scout" })).toEqual({ ok: true, defaultAgent: "scout" });
    expect(hub.settings.get().defaultAgent).toBe("scout");
    await web.req("POST", "/api/agents/assistant/archive", { archived: false });
    await web.req("PATCH", "/api/settings", { defaultAgent: "assistant" });
  });

  it("deletes an agent for good with its dialog, tasks and channels handed over", async () => {
    const helper = make("helper", "Helper");
    const c = conv(helper.id);
    hub.store.addMessage({ conversationId: c, role: "assistant", agentId: helper.id, parts: [{ type: "text", text: "hi" }], status: "complete" });
    const task = hub.store.createTask({ agentId: helper.id, goal: "x", title: "x", background: true, createdBy: "user" });
    const feed = hub.feeds.create({ title: "Helper news", brief: "news", agentId: helper.id }, { run: false });
    const group = await web.req("POST", "/api/conversations", { kind: "group", title: "Trio", members: ["assistant", "scout", helper.id] });
    await web.req("POST", "/api/agents/helper/pin", { pinned: true });
    const removed: string[] = [];
    const off = hub.bus.on("agent.removed", (e) => removed.push(e.agentId));
    try {
      expect(await web.req("DELETE", "/api/agents/helper")).toEqual({ ok: true, defaultAgent: "assistant" });
    } finally {
      off();
    }
    expect(removed).toEqual(["helper"]);
    expect(hub.agents.get("helper")).toBeUndefined();
    expect((await agents()).some((a) => a.id === "helper")).toBe(false);
    expect(hub.store.getConversation(c)).toBeUndefined();
    expect(hub.store.listMessages(c, { limit: 10 })).toHaveLength(0);
    expect(hub.store.getTask(task.id)).toBeUndefined();
    expect(hub.feeds.get(feed.id)?.agentId).toBe("assistant");
    expect(hub.store.getConversation(group.id)?.members).toEqual(["assistant", "scout"]);
    expect(hub.agentsState.get().pinned).not.toContain("helper");
  });

  it("deletes a built-in agent too, and remembers it is gone until it is made anew", async () => {
    // The fixtures' built-in assistant: the default agent hands over first.
    hub.settings.update({ defaultAgent: "scout" });
    hub.deleteAgent("assistant", {}, "user");
    expect(hub.agents.get("assistant")).toBeUndefined();
    expect(hub.agentsState.get().removed).toEqual(["assistant"]);
    hub.agents.reload();
    expect(hub.agents.get("assistant")).toBeUndefined();
    make("assistant", "Assistant");
    expect(hub.agents.get("assistant")).toBeDefined();
    expect(hub.agentsState.get().removed).toEqual([]);
    hub.saveAgent({ ...hub.agents.get("assistant")!, brains: ["fake@local"], source: "user" }, "user");
    hub.settings.update({ defaultAgent: "assistant" });
  });

  it("in the chat only the default agent deletes, and the person confirms on a card every time", async () => {
    make("temp", "Temp");
    // Another agent does not even see the hub's tools; one that did would be told to ask the default agent.
    expect(await say("scout", 'CALL hub_agent_delete {"id":"temp"}')).toMatch(/hub_agent_delete is not available|Only the default agent .* archives and deletes agents/);
    expect(hub.agents.get("temp")).toBeDefined();

    // A "yes" in the person's own words or an always-allow rule does not skip the card.
    hub.rules.create({ tool: "hub_agent_delete", decision: "allow", conditions: [], createdVia: "approval" });
    const reply = say("assistant", 'CALL hub_agent_delete {"id":"temp"}');
    const card = await until(() => hub.approvals.list(["pending"]).find((a) => a.tool === "hub_agent_delete"), "the delete card");
    expect(card.summary).toBe("Delete Temp for good, with their dialog, schedules and tasks");
    expect(hub.agents.get("temp")).toBeDefined();
    hub.approvals.resolve(card.id, "deny", { via: "web" });
    expect(await reply).toMatch(/declined: nothing was deleted/);
    expect(hub.agents.get("temp")).toBeDefined();

    const again = say("assistant", 'CALL hub_agent_delete {"id":"temp"}');
    const yes = await until(() => hub.approvals.list(["pending"]).find((a) => a.tool === "hub_agent_delete"), "the second card");
    hub.approvals.resolve(yes.id, "approve", { via: "web" });
    expect(await again).toMatch(/Agent temp deleted/);
    expect(hub.agents.get("temp")).toBeUndefined();
  });

  it("the default agent deletes itself only with a successor, named on the card", async () => {
    expect(await say("assistant", 'CALL hub_agent_delete {"id":"assistant"}')).toMatch(/pass successor/);
    const reply = say("assistant", 'CALL hub_agent_delete {"id":"assistant","successor":"scout"}');
    const card = await until(() => hub.approvals.list(["pending"]).find((a) => a.tool === "hub_agent_delete"), "the card");
    expect(card.summary).toBe("Delete Assistant for good, with their dialog, schedules and tasks; Scout becomes the default agent");
    hub.approvals.resolve(card.id, "deny", { via: "web" });
    await reply;
    expect(hub.settings.get().defaultAgent).toBe("assistant");
  });

  it("archives, restores and pins from the chat", async () => {
    expect(await say("assistant", 'CALL hub_agent_archive {"id":"writer","archived":true}')).toMatch(/writer is asleep in the archive/);
    expect(hub.agents.isArchived("writer")).toBe(true);
    expect(await say("assistant", 'CALL hub_agents_list {}')).toMatch(/"archived": true/);
    expect(await say("assistant", 'CALL hub_agent_archive {"id":"writer","archived":false}')).toMatch(/back on the team/);
    expect(await say("assistant", 'CALL hub_agent_pin {"id":"writer","pinned":true}')).toMatch(/writer is pinned/);
    expect(hub.agentsState.get().pinned).toContain("writer");
  });
});
