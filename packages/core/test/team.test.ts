// One long-lived dialog per agent: get-or-create, the dialog of older installs kept, read markers and the team view.
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, TeamMember } from "@piomio/shared";
import { openDb } from "../src/db.ts";
import { EventBus } from "../src/bus.ts";
import { Store } from "../src/store.ts";
import { previewText, Team } from "../src/team.ts";

const tick = () => new Promise((r) => setImmediate(r));

function setup(file = ":memory:") {
  const bus = new EventBus();
  return { bus, store: new Store(openDb(file), bus) };
}

const msg = (role: Message["role"], parts: Message["parts"]): Message => ({ id: "m", conversationId: "c", role, parts, status: "complete", createdAt: "" });

describe("agent dialogs", () => {
  it("gets or creates exactly one dialog per agent", () => {
    const { store } = setup();
    const a = store.agentConversation("assistant");
    expect(a).toMatchObject({ kind: "main", agentId: "assistant" });
    expect(store.agentConversation("assistant").id).toBe(a.id);
    const r = store.agentConversation("researcher");
    expect(r).toMatchObject({ kind: "main", agentId: "researcher" });
    expect(r.id).not.toBe(a.id);
    // Older ad-hoc chats and task threads of an agent are not its dialog.
    store.createConversation({ kind: "chat", title: "x", agentId: "writer" });
    store.createTask({ agentId: "writer", title: "t", goal: "g", createdBy: "user", background: false });
    const w = store.agentConversation("writer");
    expect(w.kind).toBe("main");
    expect(store.listConversations().filter((c) => c.kind === "main").map((c) => c.agentId).sort()).toEqual(["assistant", "researcher", "writer"]);
  });

  it("keeps the dialog of an install from before per-agent dialogs, with its history read", () => {
    // An older database: schema 3 (before per-agent dialogs), one conversation "main" and no read markers.
    const file = join(mkdtempSync(join(tmpdir(), "owl-team-")), "piomio.db");
    const old = openDb(file);
    old.exec(
      "drop table devices; drop table device_pairing_codes; drop table agent_drafts; drop index conversations_kind_agent; alter table conversations drop column read_at; alter table conversations drop column members; alter table tasks drop column question; alter table tasks drop column kind; alter table tasks drop column tainted; alter table tasks drop column from_agent; drop table invites; drop table feeds; drop table feed_posts; alter table tasks drop column feed_id; alter table conversations drop column purpose; alter table conversations drop column entity; drop table pages; alter table approvals drop column ask; alter table tasks drop column thinking; alter table messages drop column model; alter table messages drop column effort; drop table machine_settings; drop table machine_spend; drop table replicas; alter table secret_requests drop column login; alter table tasks drop column skill; drop index notifications_kind; alter table notifications drop column kind; alter table notifications drop column reason; alter table notifications drop column message_id; alter table notifications drop column read_at; alter table notifications drop column digest_id; alter table notifications drop column superseded_by; alter table tasks drop column deliver; drop table skill_agents; update schema_version set v = 3;",
    );
    const t0 = "2026-10-01T10:00:00.000Z";
    old.prepare("insert into conversations(id, kind, title, agent_id, created_at, updated_at) values ('main', 'main', 'Main', 'assistant', ?, ?)").run(t0, "2026-10-01T10:00:02.000Z");
    const insert = old.prepare("insert into messages(id, conversation_id, role, parts, status, created_at) values (?, 'main', ?, ?, 'complete', ?)");
    insert.run("m1", "user", JSON.stringify([{ type: "text", text: "hi" }]), "2026-10-01T10:00:01.000Z");
    insert.run("m2", "assistant", JSON.stringify([{ type: "text", text: "hello" }]), "2026-10-01T10:00:02.000Z");
    old.close();

    const { store } = setup(file);
    expect(store.agentConversation("assistant").id).toBe("main");
    expect(store.listMessages("main").map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(store.unreadCount("main")).toBe(0);
    store.db.close();
  });

  it("leaves the old main dialog with the agent it was switched to", () => {
    const { store } = setup();
    store.createConversation({ kind: "main", id: "main", title: "Main", agentId: "researcher" });
    expect(store.agentConversation("researcher").id).toBe("main");
    expect(store.agentConversation("assistant").id).not.toBe("main");
  });

  it("counts finished agent messages after the read marker, which only moves forward", () => {
    const { store } = setup();
    const c = store.agentConversation("assistant").id;
    store.addMessage({ conversationId: c, role: "user", parts: [{ type: "text", text: "hi" }], status: "complete" });
    expect(store.unreadCount(c)).toBe(0);
    const first = store.addMessage({ conversationId: c, role: "assistant", parts: [], status: "streaming" });
    expect(store.unreadCount(c)).toBe(0);
    store.updateMessage(first.id, { parts: [{ type: "text", text: "hello" }], status: "complete" });
    expect(store.unreadCount(c)).toBe(1);
    store.markRead(c, first.createdAt);
    expect(store.unreadCount(c)).toBe(0);
    store.markRead(c, "2000-01-01T00:00:00.000Z");
    expect(store.unreadCount(c)).toBe(0);
    store.markRead(c, "not a date");
    expect(store.unreadCount(c)).toBe(0);
  });
});

describe("team", () => {
  it("lists every agent with its dialog and pushes one update per change", async () => {
    const { store, bus } = setup();
    let running = false;
    const team = new Team({ store, bus, agents: { list: () => [{ id: "assistant" }, { id: "researcher" }] }, isRunning: () => running });
    const list = team.list();
    expect(list.map((m) => m.agentId)).toEqual(["assistant", "researcher"]);
    expect(list[1]).toMatchObject({ running: false, unread: 0, lastMessage: undefined });
    expect(team.list()[1].conversationId).toBe(list[1].conversationId);

    const events: TeamMember[] = [];
    bus.on("team.updated", (m) => events.push(m));
    const c = list[1].conversationId;
    store.addMessage({ conversationId: c, role: "user", parts: [{ type: "text", text: "hi" }], status: "complete" });
    const reply = store.addMessage({ conversationId: c, role: "assistant", parts: [], status: "streaming", agentId: "researcher" });
    store.updateMessage(reply.id, { parts: [{ type: "text", text: "**Hello**, see [the docs](https://example.com)" }], status: "complete" });
    await tick();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ agentId: "researcher", conversationId: c, unread: 1, running: false, lastMessage: { role: "assistant", text: "Hello, see the docs" } });

    team.markRead(c, reply.createdAt);
    await tick();
    expect(events.at(-1)).toMatchObject({ conversationId: c, unread: 0 });

    running = true;
    bus.emit("conversation.activity", { conversationId: c, running: true });
    await tick();
    expect(events.at(-1)).toMatchObject({ conversationId: c, running: true });

    // Task threads are not dialogs: no team updates for them.
    const n = events.length;
    const task = store.createTask({ agentId: "researcher", title: "t", goal: "g", createdBy: "user", background: true });
    store.addMessage({ conversationId: task.conversationId, role: "assistant", parts: [{ type: "text", text: "working" }], status: "complete" });
    await tick();
    expect(events).toHaveLength(n);
  });

  it("previews what the user would read", () => {
    expect(previewText(msg("assistant", [{ type: "tool_call", id: "1", name: "x", input: {} }]))).toBe("");
    expect(previewText(msg("system", [{ type: "text", text: "[System] note for the model" }]))).toBe("");
    expect(previewText(msg("system", [{ type: "error", message: "No brain" }]))).toBe("No brain");
    expect(previewText(msg("assistant", [{ type: "notification", level: "notify", title: "Rain at 5", body: "take an umbrella" }]))).toBe("Rain at 5");
    expect(previewText(msg("assistant", [{ type: "text", text: "# Plan\n\n- `one`\n- two" }]))).toBe("Plan - one - two");
    expect(previewText(msg("user", [{ type: "text", text: "x".repeat(400) }])).length).toBe(160);
    expect(previewText(msg("assistant", [{ type: "images", items: [{ src: "https://a.b/1.jpg" }, { src: "https://a.b/2.jpg", caption: "Tower" }] }]))).toBe("🖼 Tower");
    expect(previewText(msg("assistant", [{ type: "images", items: [{ src: "https://a.b/1.jpg" }] }]))).toBe("🖼");
    expect(previewText(msg("assistant", [{ type: "map", lat: 48.85837, lon: 2.294481, title: "Eiffel Tower" }]))).toBe("📍 Eiffel Tower");
    expect(previewText(msg("assistant", [{ type: "map", lat: 48.85837, lon: 2.294481 }]))).toBe("📍 48.8584, 2.2945");
    expect(previewText(msg("assistant", [{ type: "map", lat: 1, lon: 2, title: "Here" }, { type: "text", text: "It stands here." }]))).toBe("It stands here.");
  });
});
