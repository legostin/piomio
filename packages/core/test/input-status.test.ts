import { describe, expect, it } from "vitest";
import { EventBus } from "../src/bus.ts";
import { openDb } from "../src/db.ts";
import { Store } from "../src/store.ts";

describe("stored input delivery", () => {
  it("survives reload and reports lost in-memory queued delivery after a restart", () => {
    const db = openDb(":memory:");
    const store = new Store(db, new EventBus());
    const c = store.agentConversation("assistant");
    const messages = (["sending", "queued", "steered", "started"] as const).map((state) => store.addMessage({ conversationId: c.id, role: "user", status: "complete", parts: [{ type: "text", text: state }, { type: "input_status", state }] }));
    const reload = new Store(db, new EventBus());
    expect(reload.getMessage(messages[1].id)?.parts).toContainEqual({ type: "input_status", state: "queued" });
    reload.failStreamingMessages();
    for (const [i, expected] of ["failed", "failed", "steered", "started"].entries()) {
      const m = reload.getMessage(messages[i].id)!;
      expect(m.parts[0]).toEqual({ type: "text", text: ["sending", "queued", "steered", "started"][i] });
      expect(m.parts[1]).toEqual({ type: "input_status", state: expected });
    }
    db.close();
  });
});
