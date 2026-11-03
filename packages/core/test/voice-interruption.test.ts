import { describe, expect, it, vi } from "vitest";
import type { BrainEvent, Message, MessagePart } from "@piomio/shared";
import { SessionRunner, type RunnerDeps } from "../src/runner.ts";
import { heardParts, heardPrefixes } from "../src/speech/interruption.ts";

const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const text = (m: Message) => m.parts.flatMap((p) => p.type === "text" ? [p.text] : []).join("");

async function fixture(ref = "fake@local", accepts = true) {
  const messages = new Map<string, Message>();
  const conv = { id: "c", kind: "main", agentId: "pio" };
  const agent = { id: "pio", companion: true };
  let event!: (e: BrainEvent) => void;
  let finish!: () => void;
  const handle = {
    ref, interrupt: vi.fn(async () => {}), steer: vi.fn(async () => accepts),
    send: vi.fn(async (_input, onEvent) => { event = onEvent; await new Promise<void>((r) => finish = r); }),
  };
  const deps = {
    settings: { get: () => ({ timezone: "UTC" }) }, approvals: {}, secrets: { capture: (s: string) => ({ text: s, stored: [] }) },
    bus: { on() {}, emit() {} }, redactor: { text: (s: string) => s, value: (s: unknown) => s },
    agents: { get: () => agent, isArchived: () => false }, skills: { expandCommand: () => undefined },
    hooks: { run: async (_name: string, payload: unknown) => ({ payload, results: [] }) },
    gateway: { has: () => true },
    store: {
      getConversation: () => conv,
      getMessage: (id: string) => messages.get(id),
      addMessage: (m: Message) => { const value = { ...m, id: `m${messages.size}`, createdAt: "now" }; messages.set(value.id, value); return value; },
      updateMessage: (id: string, patch: Partial<Message>) => { const m = { ...messages.get(id)!, ...patch }; messages.set(id, m); return m; },
      db: { prepare: () => ({ get: () => undefined, run() {} }) },
    },
  };
  const runner = new SessionRunner(deps as unknown as RunnerDeps);
  const internals = runner as any;
  internals.situationOf = () => undefined;
  const row = { id: "s", conversationId: "c", agentId: "pio", brainRef: ref };
  const done = internals.enqueue("c", () => internals.streamTurn(conv, row, { handle, brainRef: ref }, agent, { text: "question" }));
  const nextTurn = internals.runTurn = vi.fn(async () => ({ text: "next", awaitingApproval: false }));
  await tick();
  return { runner, messages, handle, done, nextTurn, event: (e: BrainEvent) => event(e), finish: () => finish() };
}

describe("heard history", () => {
  it("keeps only acknowledged speech and the actual tools/cards", () => {
    const parts: MessagePart[] = [{ type: "text", text: "**Heard**. Unheard." }, { type: "tool_call", id: "t", name: "save", input: {} }, { type: "text", text: "More unheard." }];
    const heard = heardParts(parts, 10, "Interrupted");
    expect(heard).toEqual([{ type: "text", text: "Heard.\n\n[Interrupted]", voiceInterrupted: true }, parts[1]]);
    expect(heardParts(heard, 10, "Interrupted")).toEqual(heard);
    expect(heardParts(parts, 0, "Interrupted")[0]).toEqual({ type: "text", text: "[Interrupted]", voiceInterrupted: true });
  });
  it("validates bounded, unique playback receipts", () => {
    expect(heardPrefixes([{ messageId: "m", end: 3 }])).toEqual([{ messageId: "m", end: 3 }]);
    for (const value of [null, [{ messageId: "m", end: -1 }], [{ messageId: "m", end: 1.1 }], [{ messageId: "m", end: 1 }, { messageId: "m", end: 1 }]])
      expect(() => heardPrefixes(value)).toThrow();
  });
});

describe("the actual runner stream at barge-in", () => {
  it("stops the brain immediately, ignores late text/final flush, and queues the next input serially", async () => {
    const f = await fixture();
    f.event({ type: "text", delta: "Heard. Unheard." });
    f.event({ type: "tool_call", id: "t", name: "save", input: {} });
    expect(f.runner.interruptVoice("c", [{ messageId: "m0", end: 6 }])).toEqual({ mode: "interrupted" });
    expect(f.handle.interrupt).toHaveBeenCalledOnce();
    await f.runner.userMessage("c", "new request"); await tick();
    expect(f.handle.steer).not.toHaveBeenCalled(); expect(f.nextTurn).not.toHaveBeenCalled();
    f.event({ type: "text", delta: " late unspoken text" }); f.finish(); await f.done; await tick();
    expect(text(f.messages.get("m0")!)).toBe("Heard.\n\n[Interrupted by the user]");
    expect(f.messages.get("m0")!.parts.some((p) => p.type === "tool_call")).toBe(true);
    expect(f.nextTurn).toHaveBeenCalledOnce();
    expect(f.nextTurn.mock.calls[0][1]).toContain("new request");
    expect(f.nextTurn.mock.calls[0][1]).toContain("person heard only");
  });
  it("steers Claude in the same send, splits history, and does not erase a previous interruption", async () => {
    const f = await fixture("claude-code@local");
    f.event({ type: "text", delta: "Heard. Unheard." });
    expect(f.runner.interruptVoice("c", [{ messageId: "m0", end: 6 }]).mode).toBe("steer");
    expect(f.handle.interrupt).not.toHaveBeenCalled();
    f.event({ type: "text", delta: " late" });
    await f.runner.userMessage("c", "instead explain this"); await tick();
    expect(f.handle.steer).toHaveBeenCalledOnce();
    expect(f.handle.steer.mock.calls[0][0].text).toContain("instead explain this");
    f.event({ type: "text", delta: "New answer. More." });
    const current = [...f.messages.values()].filter((m) => m.role === "assistant").at(-1)!;
    f.runner.interruptVoice("c", [{ messageId: current.id, end: 11 }]);
    f.finish(); await f.done;
    expect(text(f.messages.get("m0")!)).toBe("Heard.\n\n[Interrupted by the user]");
    expect(text(f.messages.get(current.id)!)).toBe("New answer.\n\n[Interrupted by the user]");
    expect(f.handle.send).toHaveBeenCalledOnce(); expect(f.nextTurn).not.toHaveBeenCalled();
  });
  it("falls back to interrupt plus a serial next turn when Claude refuses steer", async () => {
    const f = await fixture("claude-code@local", false);
    f.event({ type: "text", delta: "Old response." });
    f.runner.interruptVoice("c", [{ messageId: "m0", end: 0 }]);
    await f.runner.userMessage("c", "new request"); await tick();
    expect(f.handle.interrupt).toHaveBeenCalledOnce(); expect(f.nextTurn).not.toHaveBeenCalled();
    f.finish(); await f.done; await tick(); expect(f.nextTurn).toHaveBeenCalledOnce();
  });
  it("lets speech while thinking join the current turn without cancelling or running another", async () => {
    const f = await fixture();
    await f.runner.userMessage("c", "one more detail"); await tick();
    expect(f.handle.steer).toHaveBeenCalledOnce(); expect(f.handle.interrupt).not.toHaveBeenCalled();
    f.finish(); await f.done; expect(f.nextTurn).not.toHaveBeenCalled();
  });
  it("also prefers steer before the first synthesized sentence has started playback", async () => {
    const f = await fixture(); f.event({ type: "text", delta: "Not yet heard." });
    expect(f.runner.interruptVoice("c", [{ messageId: "m0", end: 0 }], { thinking: true }).mode).toBe("steer");
    await f.runner.userMessage("c", "one more detail"); await tick();
    expect(f.handle.steer).toHaveBeenCalledOnce(); expect(f.handle.interrupt).not.toHaveBeenCalled();
    f.finish(); await f.done; expect(f.nextTurn).not.toHaveBeenCalled();
  });
  it("rejects foreign messages and impossible positions without modifying history or stopping a turn", async () => {
    const f = await fixture(); f.event({ type: "text", delta: "Answer." });
    expect(() => f.runner.interruptVoice("c", [{ messageId: "m0", end: 100 }])).toThrow();
    const m = f.messages.get("m0")!; f.messages.set("foreign", { ...m, id: "foreign", conversationId: "other" });
    expect(() => f.runner.interruptVoice("c", [{ messageId: "foreign", end: 0 }])).toThrow();
    expect(f.handle.interrupt).not.toHaveBeenCalled(); f.finish(); await f.done;
    expect(text(f.messages.get("m0")!)).toBe("Answer.");
  });
});
