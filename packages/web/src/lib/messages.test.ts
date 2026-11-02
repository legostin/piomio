import { describe, expect, it } from "vitest";
import type { Message } from "@piomio/shared";
import { appendDelta, applyDelta, isStreaming, mergeFetched, prependOlder, removeMessage, upsertMessage } from "./messages";

const msg = (id: string, createdAt: string, parts: Message["parts"] = [], status: Message["status"] = "complete"): Message => ({
  id,
  conversationId: "c1",
  role: "assistant",
  parts,
  status,
  createdAt,
});

describe("appendDelta", () => {
  it("extends the last text part", () => {
    expect(appendDelta([{ type: "text", text: "Hel" }], "lo")).toEqual([{ type: "text", text: "Hello" }]);
  });
  it("starts a new text part after a tool call (like the hub runner)", () => {
    const parts = appendDelta([{ type: "text", text: "a" }, { type: "tool_call", id: "t1", name: "x", input: {} }], "b");
    expect(parts).toHaveLength(3);
    expect(parts[2]).toEqual({ type: "text", text: "b" });
  });
  it("creates the first text part of an empty message", () => {
    expect(appendDelta([], "hi")).toEqual([{ type: "text", text: "hi" }]);
  });
});

describe("applyDelta", () => {
  it("patches the right message and leaves others untouched", () => {
    const a = msg("a", "2026-01-01T00:00:00Z", [{ type: "text", text: "x" }]);
    const b = msg("b", "2026-01-01T00:00:01Z", [], "streaming");
    const out = applyDelta([a, b], { id: "b", delta: "yo" });
    expect(out[0]).toBe(a);
    expect(out[1].parts).toEqual([{ type: "text", text: "yo" }]);
  });
  it("ignores deltas for unknown messages", () => {
    const list = [msg("a", "2026-01-01T00:00:00Z")];
    expect(applyDelta(list, { id: "zzz", delta: "x" })).toBe(list);
  });
});

describe("quiet replies", () => {
  it("keeps a quiet turn's reply out until it is kept, and drops a deleted one", () => {
    const quiet = { ...msg("q", "2"), quiet: true };
    expect(upsertMessage([msg("a", "1")], quiet).map((m) => m.id)).toEqual(["a"]);
    expect(upsertMessage([msg("a", "1"), msg("q", "2")], quiet).map((m) => m.id)).toEqual(["a"]);
    expect(upsertMessage([msg("a", "1")], msg("q", "2")).map((m) => m.id)).toEqual(["a", "q"]);
    expect(mergeFetched([], [msg("a", "1"), quiet]).map((m) => m.id)).toEqual(["a"]);
    expect(removeMessage([msg("a", "1"), msg("q", "2")], "q").map((m) => m.id)).toEqual(["a"]);
  });
});

describe("upsertMessage", () => {
  it("replaces by id", () => {
    const out = upsertMessage([msg("a", "1"), msg("b", "2")], msg("a", "1", [{ type: "text", text: "new" }]));
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
    expect(out[0].parts).toEqual([{ type: "text", text: "new" }]);
  });
  it("appends newer and sorts older into place", () => {
    expect(upsertMessage([msg("a", "1"), msg("c", "3")], msg("d", "4")).map((m) => m.id)).toEqual(["a", "c", "d"]);
    expect(upsertMessage([msg("a", "1"), msg("c", "3")], msg("b", "2")).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
});

describe("mergeFetched", () => {
  it("keeps a local streaming copy that already has more text", () => {
    const local = [msg("a", "1", [{ type: "text", text: "Hello wor" }], "streaming")];
    const fetched = [msg("a", "1", [{ type: "text", text: "Hel" }], "streaming")];
    expect(mergeFetched(local, fetched)[0].parts).toEqual([{ type: "text", text: "Hello wor" }]);
  });
  it("prefers the fetched copy when it is complete", () => {
    const local = [msg("a", "1", [{ type: "text", text: "Hello wor" }], "streaming")];
    const fetched = [msg("a", "1", [{ type: "text", text: "Hello" }], "complete")];
    expect(mergeFetched(local, fetched)[0].status).toBe("complete");
  });
  it("keeps older history and messages that arrived after the fetch", () => {
    const local = [msg("old", "1"), msg("x", "5"), msg("late", "9")];
    const fetched = [msg("x", "5"), msg("y", "6")];
    expect(mergeFetched(local, fetched).map((m) => m.id)).toEqual(["old", "x", "y", "late"]);
  });
  it("keeps socket messages when the fetch returned nothing", () => {
    expect(mergeFetched([msg("a", "1")], []).map((m) => m.id)).toEqual(["a"]);
  });
});

describe("prependOlder / isStreaming", () => {
  it("dedupes and sorts", () => {
    expect(prependOlder([msg("b", "2"), msg("c", "3")], [msg("a", "1"), msg("b", "2")]).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
  it("detects streaming", () => {
    expect(isStreaming([msg("a", "1")])).toBe(false);
    expect(isStreaming([msg("a", "1", [], "streaming")])).toBe(true);
  });
});
