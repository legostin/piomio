import { describe, expect, it } from "vitest";
import type { Message, MessagePart } from "./types.ts";
import { replyText } from "./replies.ts";
const msg = (parts: MessagePart[], role: Message["role"] = "assistant"): Message => ({ id: "a", conversationId: "c", role, parts, status: "complete", createdAt: "2026-01-01" });
describe("visible reply snapshots", () => {
  it("uses the final answer without tool internals, earlier commentary or a nested quote", () => {
    expect(replyText(msg([{ type: "text", text: "commentary" }, { type: "tool_call", id: "t", name: "private", input: { secret: "private" } }, { type: "reply_to", messageId: "b", text: "older quote" }, { type: "text", text: "final answer" }]))).toBe("final answer");
  });
  it("describes attachment-only and image messages and bounds long snapshots", () => {
    expect(replyText(msg([{ type: "attachment", kind: "file", name: "note.txt", path: "attachments/note.txt", mimeType: "text/plain", size: 1 }], "user"))).toBe("[note.txt]");
    expect(replyText(msg([{ type: "images", items: [{ src: "https://example.test/a.jpg", caption: "Mountain" }] }]))).toBe("Mountain");
    expect(replyText(msg([{ type: "text", text: "a".repeat(9000) }]))).toHaveLength(4000);
  });
});
