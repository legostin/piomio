import { beforeEach, describe, expect, it } from "vitest";
import type { Message } from "@piomio/shared";
import { clearReply, replies, selectReply } from "./replies";
const msg = (id: string, conversationId = "c"): Message => ({ id, conversationId, role: "user", status: "complete", parts: [{ type: "text", text: id }], createdAt: "2026-01-01" });
beforeEach(() => replies.set({}));
describe("reply drafts", () => {
  it("keeps chat selections independent and cancels without touching another chat", () => {
    selectReply(msg("a"), "You");
    selectReply(msg("b", "other"), "You");
    clearReply("c");
    expect(replies.get().c).toBeUndefined();
    expect(replies.get().other?.messageId).toBe("b");
  });
  it("a completed send clears only its own selection, preserving a newer draft", () => {
    selectReply(msg("a"), "You");
    const sending = replies.get().c;
    selectReply(msg("b"), "You");
    clearReply("c", sending);
    expect(replies.get().c?.messageId).toBe("b");
    clearReply("c", replies.get().c);
    expect(replies.get().c).toBeUndefined();
  });
  it("does not let hidden or unfinished messages become targets", () => {
    for (const target of [{ ...msg("a"), role: "system" as const }, { ...msg("b"), status: "streaming" as const }, { ...msg("c"), quiet: true }]) selectReply(target, "Agent");
    expect(replies.get()).toEqual({});
  });
});
