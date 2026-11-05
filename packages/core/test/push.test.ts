import { describe, expect, it } from "vitest";
import type { Conversation, Message, Notification } from "@piomio/shared";
import { DESKTOP_NOTIFY_PREFIX, desktopNotifyLine, messageNote, messagePreview, pushNote } from "../src/push.ts";
import { loadConfig } from "../src/config.ts";

const base: Notification = { id: "n_1", level: "notify", kind: "alert", title: "Build is green", body: "All 312 tests pass.", createdAt: "2026-11-04T10:00:00.000Z" };
const names = (id: string) => (id === "coder" ? "Coder" : "Assistant");

describe("what a device shows", () => {
  it("opens the agent's dialog, or the task a question is about", () => {
    expect(pushNote(base, "assistant", names)).toMatchObject({ agentId: "assistant", agentName: "Assistant", path: "/agent/assistant" });
    expect(pushNote({ ...base, kind: "question", agentId: "coder", taskId: "t_9" }, "assistant", names).path).toBe("/tasks/t_9");
    // A scheduled report lands in the dialog, not on its run.
    expect(pushNote({ ...base, kind: "report", agentId: "coder", taskId: "t_9" }, "assistant", names).path).toBe("/agent/coder");
    expect(pushNote({ ...base, body: "x".repeat(2000) }, "assistant", names).body.length).toBeLessThanOrEqual(601);
  });

  it("shows an agent's message as its agent, or its group with the agent below", () => {
    const at = "2026-11-04T10:00:00.000Z";
    const m: Message = { id: "m_1", conversationId: "c_1", role: "assistant", parts: [{ type: "text", text: "Tests pass." }], status: "complete", agentId: "coder", createdAt: at };
    const dialog: Conversation = { id: "c_1", kind: "main", title: "coder", agentId: "coder", createdAt: at, updatedAt: at } as Conversation;
    expect(messageNote(m, dialog, names, "Sent a file")).toEqual({ id: "m_1", kind: "message", title: "Coder", body: "Tests pass.", agentId: "coder", conversationId: "c_1", path: "/agent/coder" });
    const group = { ...dialog, kind: "group", title: "Trip" } as Conversation;
    expect(messageNote(m, group, names, "Sent a file")).toMatchObject({ title: "Trip", agentName: "Coder", path: "/chat/c_1" });
    expect(messagePreview({ parts: [{ type: "attachment", path: "a.png", name: "a.png" } as any] }, "Sent a file")).toBe("Sent a file");
    // Only tool calls: nothing to read, no push.
    expect(messageNote({ ...m, parts: [] }, dialog, names, "Sent a file")).toBeUndefined();
  });

  it("hands the desktop app one line it can tell from the log", () => {
    const line = desktopNotifyLine(pushNote(base, "assistant", names), true);
    expect(line.startsWith(DESKTOP_NOTIFY_PREFIX)).toBe(true);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line.slice(DESKTOP_NOTIFY_PREFIX.length))).toEqual({ id: "n_1", title: "Build is green", body: "All 312 tests pass.", agent: "Assistant", path: "/agent/assistant", silent: true });
  });

  it("uses Piomio's relay unless told otherwise", () => {
    expect(loadConfig({}).pushRelay).toBe("https://relay.piomio.io");
    expect(loadConfig({ PIOMIO_PUSH_RELAY: "https://relay.example/" }).pushRelay).toBe("https://relay.example");
    expect(loadConfig({ PIOMIO_PUSH_RELAY: "off" }).pushRelay).toBeUndefined();
    expect(loadConfig({}).desktopNotify).toBe(false);
    expect(loadConfig({ PIOMIO_DESKTOP: "1" }).desktopNotify).toBe(true);
  });
});
