import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "@piomio/testkit";
import type { Message } from "@piomio/shared";
import { firstSpeakers, groupTurn } from "../src/group-chat.ts";
import { Hub, loadConfig } from "../src/index.ts";

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


describe("replies through HTTP, storage and brain input", () => {
  let hub: Hub;
  let web: Client;
  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const fixtures = join(import.meta.dirname, "fixtures");
    const config = loadConfig({ PIOMIO_PORT: String(port), PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), PIOMIO_DEVICES: "0", TZ: "UTC" }, {
      dataDir: mkdtempSync(join(tmpdir(), "piomio-replies-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents"),
    });
    hub = new Hub(config);
    await hub.start();
    web = new Client(config.publicUrl);
    await web.req("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    web.csrf = (await web.req("GET", "/api/bootstrap")).csrf;
    await web.req("PUT", "/api/agents/assistant", { name: "Assistant", description: "Assistant", brains: ["fake@local"], prompt: "Help." });
    await web.req("PUT", "/api/agents/scout", { name: "Scout", description: "Scout", brains: ["fake@local"], prompt: "Help." });
    for (let n = 0; n < 100 && !hub.brains.has("fake@local"); n++) await new Promise((r) => setTimeout(r, 50));
    expect(hub.brains.has("fake@local")).toBe(true);
  });
  afterAll(async () => { await hub?.stop(); });

  const chat = () => hub.store.createConversation({ kind: "chat", title: "Replies", agentId: "assistant" }).id;
  const original = (id: string, role: Message["role"], text: string, agentId?: string, status: Message["status"] = "complete") =>
    hub.store.addMessage({ conversationId: id, role, agentId, parts: [{ type: "text", text }], status });
  const post = (id: string, body: unknown) => web.raw("POST", `/api/conversations/${id}/messages`, body);

  it.each(["user", "assistant"] as const)("stores a server-owned quote of a %s message and sends it to the brain", async (role) => {
    const id = chat();
    const target = original(id, role, `original ${role} words`, role === "assistant" ? "assistant" : undefined);
    const r = await post(id, { text: "INPUT?", replyTo: target.id, author: "forged", quote: "forged" });
    expect(r.status).toBe(200);
    expect(r.json.parts[0]).toMatchObject({ type: "reply_to", messageId: target.id, text: `original ${role} words`, author: expect.any(String) });
    expect(hub.store.getMessage(r.json.id)?.parts).toEqual(r.json.parts);
    const fetched = await web.req("GET", `/api/conversations/${id}/messages`);
    expect(fetched.find((m: Message) => m.id === r.json.id).parts).toEqual(r.json.parts);
    await expect.poll(() => hub.store.listMessages(id).filter((m) => m.role === "assistant" && m.id !== target.id && m.status === "complete").map((m) => m.parts).flat(), { timeout: 10000 }).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining(`original ${role} words`) })]));
  });

  it("rejects cross-chat, missing, system, unfinished and malformed targets before storing a message", async () => {
    const id = chat();
    const other = original(chat(), "assistant", "private");
    const system = original(id, "system", "internal");
    const streaming = original(id, "assistant", "unfinished", "assistant", "streaming");
    const count = hub.store.listMessages(id).length;
    for (const replyTo of [other.id, system.id, streaming.id, "missing", "", 42, { messageId: other.id }, null]) {
      expect((await post(id, { text: "hello", replyTo })).status).toBe(400);
    }
    expect(hub.store.listMessages(id)).toHaveLength(count);
  });

  it("keeps normal messages unchanged and refuses empty replies", async () => {
    const id = chat();
    const target = original(id, "user", "before");
    expect((await post(id, { text: "", replyTo: target.id })).status).toBe(400);
    const r = await post(id, { text: "plain" });
    expect(r.json.parts).toEqual([{ type: "text", text: "plain" }]);
  });

  it("accepts an attachment-only reply", async () => {
    const id = chat();
    const target = original(id, "assistant", "the file?", "assistant");
    const m = await hub.runner.userMessage(id, "", { replyTo: target.id, attachments: [{ type: "attachment", name: "note.txt", path: "attachments/note.txt", mimeType: "text/plain", size: 3, kind: "file" }] });
    expect(m.parts).toEqual([expect.objectContaining({ type: "reply_to", messageId: target.id }), expect.objectContaining({ type: "attachment", name: "note.txt" })]);
  });

  it("addresses the quoted group member and gives them the original context", async () => {
    const g = await web.req("POST", "/api/conversations", { kind: "group", title: "Replies", members: ["assistant", "scout"] });
    const target = original(g.id, "assistant", "Scout proposal", "scout");
    expect((await post(g.id, { text: "INPUT?", replyTo: target.id })).status).toBe(200);
    await expect.poll(() => hub.store.listMessages(g.id).filter((m) => m.role === "assistant" && m.id !== target.id && m.status === "complete").map((m) => ({ agentId: m.agentId, text: m.parts.flatMap((p) => p.type === "text" ? [p.text] : []).join("") })), { timeout: 10000 }).toEqual([expect.objectContaining({ agentId: "scout", text: expect.stringContaining("Scout proposal") })]);
  });
});


describe("group reply routing and history", () => {
  const members = [{ id: "assistant", name: "Assistant" }, { id: "scout", name: "Scout" }];
  it("lets explicit mentions override a reply and falls back when the author left", () => {
    expect(firstSpeakers("yes", members, "scout")).toEqual(["scout"]);
    expect(firstSpeakers("@assistant yes", members, "scout")).toEqual(["assistant"]);
    expect(firstSpeakers("yes", members, "departed")).toEqual(["assistant"]);
    expect(firstSpeakers("yes", members)).toEqual(["assistant"]);
  });
  it("keeps reply context in unseen group history without hiding the user's new words", () => {
    const m: Message = { id: "m", conversationId: "c", role: "user", status: "complete", createdAt: "2026-01-01", parts: [{ type: "reply_to", messageId: "old", author: "Scout", text: "proposal" }, { type: "text", text: "change this" }] };
    const turn = groupTurn({ messages: [m], agentId: "assistant", name: () => "Scout", prompt: "next" });
    expect(turn.lines[0]).toContain("[User]: change this");
    expect(turn.lines[0]).toContain("proposal");
    expect(turn.lines[0]).toContain("Scout");
  });
});
