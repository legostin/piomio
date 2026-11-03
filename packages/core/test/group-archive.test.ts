// Archiving and deleting group chats (groups-state.ts, Hub.archiveGroup / deleteGroup): the group's menu in the list
// (the API) and the agents' group tools in the chat, where a delete always waits for the person's yes on a card.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDef, Conversation, GroupChat } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";

const fixtures = join(import.meta.dirname, "fixtures");

async function until<T>(fn: () => T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 50));
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

describe("archiving and deleting group chats", () => {
  let hub: Hub;
  let web: Client;

  const groups = async (all = false): Promise<GroupChat[]> => web.req("GET", all ? "/api/groups?all=1" : "/api/groups");
  const makeGroup = async (title: string): Promise<Conversation> => web.req("POST", "/api/conversations", { kind: "group", title, members: ["assistant", "scout"] });
  const call = async (name: string, input: unknown, ctx: { conversationId?: string; background?: boolean } = {}) => {
    const r = await hub.tools.get(name)!.invoke(input, {
      sessionId: "s",
      agentId: "assistant",
      callId: "c",
      tainted: false,
      background: ctx.background ?? false,
      workspace: "",
      machineId: "local",
      conversationId: ctx.conversationId ?? hub.store.agentConversation("assistant").id,
    });
    return { text: r.content.map((c) => (c.type === "text" ? c.text : "")).join(""), isError: !!r.isError };
  };

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-group-archive-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    web = new Client(config.publicUrl);
    await web.req("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    web.csrf = (await web.req("GET", "/api/bootstrap")).csrf;
    hub.agents.save({ ...hub.agents.get("assistant")!, id: "scout", name: "Scout", source: "user" } as AgentDef);
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("puts a group in the archive and brings it back as it was", async () => {
    const g = await makeGroup("Launch");
    hub.store.addMessage({ conversationId: g.id, role: "assistant", agentId: "scout", parts: [{ type: "text", text: "Ready" }], status: "complete" });
    // Work started in the group stops with it.
    const open = hub.store.createTask({ agentId: "scout", goal: "Draft", title: "Draft", background: true, createdBy: "agent", parentConversationId: g.id, status: "waiting_input" });
    const events: GroupChat[] = [];
    const off = hub.bus.on("group.updated", (e) => events.push(e));
    try {
      expect(await web.req("POST", `/api/groups/${g.id}/archive`, { archived: true })).toMatchObject({ conversationId: g.id, archived: true });
    } finally {
      off();
    }
    expect(events.some((e) => e.conversationId === g.id && e.archived)).toBe(true);
    expect((await groups()).some((x) => x.conversationId === g.id)).toBe(false);
    expect((await groups(true)).find((x) => x.conversationId === g.id)).toMatchObject({ archived: true, title: "Launch" });
    expect(hub.store.getTask(open.id)?.status).toBe("cancelled");
    // Nobody writes there while it sleeps.
    const sent = await web.raw("POST", `/api/conversations/${g.id}/messages`, { text: "anyone?" });
    expect(sent.status).toBe(409);
    expect(sent.json.error).toBe("“Launch” is in the archive. Bring it back to write there.");

    const back = await web.req("POST", `/api/groups/${g.id}/archive`, { archived: false });
    expect(back.archived).toBeUndefined();
    expect((await groups()).find((x) => x.conversationId === g.id)?.lastMessage?.text).toBe("Ready");
  });

  it("deletes a group for good with its conversation and the work started there", async () => {
    const g = await makeGroup("Old plans");
    hub.store.addMessage({ conversationId: g.id, role: "user", parts: [{ type: "text", text: "hi" }], status: "complete" });
    const task = hub.store.createTask({ agentId: "scout", goal: "Look", title: "Look", background: true, createdBy: "agent", parentConversationId: g.id, status: "done" });
    const inner = hub.store.createTask({ agentId: "assistant", goal: "Help", title: "Help", background: true, createdBy: "agent", parentConversationId: task.conversationId, status: "done" });
    await hub.notifier.notify({ level: "silent", title: "From the group", body: "x", conversationId: g.id });
    await hub.notifier.notify({ level: "silent", title: "From its task", body: "x", taskId: task.id });
    hub.archiveGroup(g.id, true, "user");
    const deleted: string[] = [];
    const off = hub.bus.on("group.deleted", (e) => deleted.push(e.conversationId));
    try {
      expect(await web.req("DELETE", `/api/groups/${g.id}`)).toEqual({ ok: true });
    } finally {
      off();
    }
    expect(deleted).toEqual([g.id]);
    expect(hub.store.getConversation(g.id)).toBeUndefined();
    expect(hub.store.listMessages(g.id, { limit: 10 })).toHaveLength(0);
    expect(hub.store.getTask(task.id)).toBeUndefined();
    expect(hub.store.getTask(inner.id)).toBeUndefined();
    expect(hub.store.getConversation(inner.conversationId)).toBeUndefined();
    expect(hub.notifier.list(50).some((n) => n.title.startsWith("From "))).toBe(false);
    expect(hub.groupsState.archived()).not.toContain(g.id);
    expect((await groups(true)).some((x) => x.conversationId === g.id)).toBe(false);
    // Only group chats, and only ones that are there.
    expect((await web.raw("DELETE", `/api/groups/${g.id}`)).status).toBe(404);
    expect((await web.raw("POST", `/api/groups/${hub.store.agentConversation("scout").id}/archive`, { archived: true })).status).toBe(404);
  });

  it("archives and restores from the chat, by name or as this group", async () => {
    const g = await makeGroup("Trip");
    expect((await call("group_archive", { group: "trip", archived: true })).text).toMatch(/“Trip” .* is in the archive/);
    expect(hub.groupsState.isArchived(g.id)).toBe(true);
    expect((await call("group_archive", { group: "Trip", archived: false })).text).toMatch(/back in the Groups list/);
    expect((await call("group_archive", { archived: true }, { conversationId: g.id })).isError).toBe(false);
    expect(hub.groupsState.isArchived(g.id)).toBe(true);
    hub.archiveGroup(g.id, false, "user");
    expect(hub.tools.get("group_archive")!.descriptor.askWhenTainted).toBe(true);
  });

  it("deletes from the chat only after the person's yes on a card", async () => {
    const g = await makeGroup("Scratch");
    expect((await call("group_delete", { group: "Scratch" }, { background: true })).text).toMatch(/not background work/);

    const declined = call("group_delete", { group: "Scratch" });
    const card = await until(() => hub.approvals.list(["pending"]).find((a) => a.tool === "group_delete"), "the delete card");
    expect(card.summary).toBe("Delete the group chat “Scratch” for good, with all its messages");
    hub.approvals.resolve(card.id, "deny", { via: "web" });
    expect((await declined).text).toMatch(/declined: nothing was deleted/);
    expect(hub.store.getConversation(g.id)).toBeDefined();

    // From inside the group it goes once the member's turn has ended.
    const yes = call("group_delete", {}, { conversationId: g.id });
    const again = await until(() => hub.approvals.list(["pending"]).find((a) => a.tool === "group_delete"), "the second card");
    hub.approvals.resolve(again.id, "approve", { via: "web" });
    expect((await yes).text).toMatch(/goes for good once this reply ends/);
    await until(() => !hub.store.getConversation(g.id), "the group to be deleted");
  });
});
