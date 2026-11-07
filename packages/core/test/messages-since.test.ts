// A device that kept a dialog asks only for what changed after its mark (GET .../messages?since=): new messages and
// older ones that changed (a reply that finished, a card that was answered), not the whole page again.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "@piomio/testkit";
import { openDb } from "../src/db.ts";
import { EventBus } from "../src/bus.ts";
import { Store } from "../src/store.ts";
import { Hub, loadConfig } from "../src/index.ts";

const fixtures = join(import.meta.dirname, "fixtures");

const tick = () => new Promise((r) => setTimeout(r, 3));

describe("messages since a mark", () => {
  it("returns what was added or changed after it, oldest first", async () => {
    const store = new Store(openDb(":memory:"), new EventBus());
    const c = store.createConversation({ kind: "main", title: "a", agentId: "a" });
    const first = store.addMessage({ conversationId: c.id, role: "user", parts: [{ type: "text", text: "hi" }], status: "complete" });
    await tick();
    const reply = store.addMessage({ conversationId: c.id, role: "assistant", parts: [], status: "streaming" });
    expect(reply.updatedAt).toBe(reply.createdAt);
    await tick();
    const mark = store.listMessages(c.id).reduce((m, x) => (x.updatedAt! > m ? x.updatedAt! : m), "");
    expect(store.listMessages(c.id, { since: mark })).toEqual([]);

    await tick();
    const done = store.updateMessage(reply.id, { parts: [{ type: "text", text: "hello" }], status: "complete" })!;
    expect(done.updatedAt! > mark).toBe(true);
    await tick();
    const next = store.addMessage({ conversationId: c.id, role: "user", parts: [{ type: "text", text: "and?" }], status: "complete" });
    expect(store.listMessages(c.id, { since: mark }).map((m) => m.id)).toEqual([reply.id, next.id]);
    expect(store.listMessages(c.id, { since: mark, limit: 1 }).map((m) => m.id)).toEqual([next.id]);
    expect(store.listMessages(c.id, { since: "2000-01-01T00:00:00.000Z" }).map((m) => m.id)).toEqual([first.id, reply.id, next.id]);
  });

  it("counts a row an older replica wrote, without updated_at, from when it was made", () => {
    const db = openDb(":memory:");
    const store = new Store(db, new EventBus());
    const c = store.createConversation({ kind: "main", title: "a", agentId: "a" });
    db.prepare("insert into messages(id, conversation_id, role, parts, status, created_at) values ('m_old', ?, 'user', '[]', 'complete', '2030-01-01T00:00:00.000Z')").run(c.id);
    expect(store.getMessage("m_old")?.updatedAt).toBe("2030-01-01T00:00:00.000Z");
    expect(store.listMessages(c.id, { since: "2029-12-31T23:59:59.000Z" }).map((m) => m.id)).toEqual(["m_old"]);
    expect(store.listMessages(c.id, { since: "2030-01-01T00:00:00.000Z" })).toEqual([]);
  });
});

describe("GET /api/conversations/:id/messages?since=", () => {
  let hub: Hub | undefined;
  afterAll(async () => {
    await hub?.stop().catch(() => {});
  });

  it("answers with what changed after the mark, and ignores a mark that is not a time", { timeout: 60_000 }, async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const env = { PIOMIO_PORT: String(port), PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" };
    hub = new Hub(loadConfig(env, { dataDir: mkdtempSync(join(tmpdir(), "owl-since-")), builtinPluginsDir: join(fixtures, "plugins"), builtinAgentsDir: join(fixtures, "agents") }));
    await hub.start();
    const { token } = hub.auth.createSession("main");
    const dialog = hub.store.agentConversation(hub.settings.get().defaultAgent);
    const first = hub.store.addMessage({ conversationId: dialog.id, role: "user", parts: [{ type: "text", text: "one" }], status: "complete" });
    await tick();
    const mark = first.updatedAt!;
    await tick();
    const second = hub.store.addMessage({ conversationId: dialog.id, role: "user", parts: [{ type: "text", text: "two" }], status: "complete" });
    const get = async (q: string) =>
      (await (await fetch(`http://127.0.0.1:${port}/api/conversations/${dialog.id}/messages?${q}`, { headers: { cookie: `piomio_session=${token}` } })).json()) as Array<{ id: string; updatedAt?: string }>;
    const changed = await get(`since=${encodeURIComponent(mark)}&limit=200`);
    expect(changed.map((m) => m.id)).toEqual([second.id]);
    expect(changed[0].updatedAt).toBe(second.updatedAt);
    expect((await get("since=yesterday&limit=200")).map((m) => m.id)).toContain(first.id);
  });
});
