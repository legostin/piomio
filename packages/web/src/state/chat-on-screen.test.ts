import { describe, expect, it } from "vitest";
import { chatOnScreen, showChat } from "./chat-on-screen";

describe("the chat on screen", () => {
  it("is the chat shown last, until that chat leaves", () => {
    expect(chatOnScreen()).toBeUndefined();
    const leaveMarta = showChat({ conversationId: "c_marta", agentId: "marta" });
    expect(chatOnScreen()).toEqual({ conversationId: "c_marta", agentId: "marta" });
    // The next chat appears before the one it replaces is gone: leaving the old one does not hide the new one.
    const leaveGroup = showChat({ conversationId: "c_group" });
    leaveMarta();
    expect(chatOnScreen()).toEqual({ conversationId: "c_group" });
    leaveGroup();
    expect(chatOnScreen()).toBeUndefined();
  });
});
