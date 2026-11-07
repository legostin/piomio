import { describe, expect, it } from "vitest";
import type { Message } from "@piomio/shared";
import { appendDelta, applyDelta, askSince, isStreaming, joinLatest, mergeChanges, mergeFetched, newestChange, prependOlder, removeMessage, upsertMessage } from "./messages";

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

describe("what changed since the dialog's mark", () => {
  const t = (s: number) => `2026-01-01T00:00:${String(s).padStart(2, "0")}.000Z`;
  it("replaces changed messages, adds new ones and leaves out one older than the page", () => {
    const a = msg("a", t(1));
    const b = msg("b", t(2), [], "streaming");
    const done = { ...msg("b", t(2), [{ type: "text", text: "done" }]), updatedAt: t(9) };
    const c = msg("c", t(5));
    const old = msg("old", t(0));
    const out = mergeChanges([a, b], [old, done, c]);
    expect(out.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(out[1].parts).toEqual([{ type: "text", text: "done" }]);
    expect(mergeChanges([a], [])).toEqual([a]);
  });
  it("keeps a streaming reply that already has more text here", () => {
    const here = msg("b", t(2), [{ type: "text", text: "longer text" }], "streaming");
    const there = msg("b", t(2), [{ type: "text", text: "lo" }], "streaming");
    expect(mergeChanges([here], [there])[0]).toBe(here);
  });
  it("takes the newest change as the mark, and asks a little before it", () => {
    expect(newestChange([msg("a", t(1)), { ...msg("b", t(2)), updatedAt: t(7) }], t(3))).toBe(t(7));
    expect(newestChange([], t(3))).toBe(t(3));
    expect(newestChange([])).toBeUndefined();
    expect(askSince(t(30), 10_000)).toBe(t(20));
  });
  it("drops what was here when the latest page shares nothing with it (no gap in the dialog)", () => {
    const here = [msg("x", t(1)), msg("y", t(2))];
    const page = [msg("p", t(10)), msg("q", t(11))];
    expect(joinLatest(here, page, 2)).toEqual({ messages: page, gap: true });
    expect(joinLatest(here, page, 3).messages.map((m) => m.id)).toEqual(["x", "y", "p", "q"]);
    const live = msg("live", t(12));
    expect(joinLatest([...here, live], page, 2).messages.map((m) => m.id)).toEqual(["p", "q", "live"]);
  });
});
