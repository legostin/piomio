import { describe, expect, it } from "vitest";
import type { Message, SetupBrain, SetupState } from "@piomio/shared";
import { cliRows, introDue, newest, primaryRef, showGate } from "./setup";

const brain = (ref: string, o: Partial<SetupBrain> = {}): SetupBrain => ({ ref, label: ref, kind: "cli", installed: false, signedIn: false, canInstall: false, ...o });
const state = (brains: SetupBrain[], usable = false, firstRun = false, starting = false): SetupState => ({
  agentId: "assistant",
  brains,
  usable,
  firstRun,
  starting,
  vault: "absent",
  apiKeys: false,
  telegram: false,
  machines: 0,
  done: [],
  skipped: [],
  remaining: [],
});
const msg = (role: Message["role"], parts: Message["parts"]): Message =>
  ({ id: Math.random().toString(36), conversationId: "c", role, parts, status: "complete", createdAt: "2026-10-26T00:00:00Z" }) as Message;

describe("primaryRef", () => {
  it("offers an installed CLI before one the hub would install", () => {
    const s = state([brain("claude-code@local", { canInstall: true }), brain("codex@local", { installed: true }), brain("api:anthropic", { kind: "api", installed: true })]);
    expect(primaryRef(s)).toBe("codex@local");
    expect(cliRows(s).map((b) => b.ref)).toEqual(["codex@local", "claude-code@local"]);
  });

  it("falls back to a CLI the hub can install, and to nothing", () => {
    expect(primaryRef(state([brain("claude-code@local", { canInstall: true }), brain("codex@local")]))).toBe("claude-code@local");
    expect(primaryRef(state([brain("codex@local")]))).toBeUndefined();
    expect(primaryRef(state([brain("codex@local", { installed: true, signedIn: true })]))).toBeUndefined();
  });
});

describe("showGate", () => {
  const s = state([brain("codex@local", { installed: true })]);

  it("shows the card while no brain works and none waits in the conversation", () => {
    expect(showGate([], s)).toBe(true);
    expect(showGate([msg("user", [{ type: "text", text: "hi" }])], s)).toBe(true);
    expect(showGate([], null)).toBe(false);
    expect(showGate([], state([], true))).toBe(false);
  });

  it("leaves it to the hub's card until an answer comes after it", () => {
    const card = msg("system", [{ type: "brain_setup" }]);
    expect(showGate([msg("user", [{ type: "text", text: "hi" }]), card], s)).toBe(false);
    expect(showGate([card, msg("user", [{ type: "text", text: "again" }])], s)).toBe(false);
    expect(showGate([card, msg("assistant", [{ type: "text", text: "hello" }])], s)).toBe(true);
  });
});

describe("showGate while the hub starts", () => {
  it("shows no card while the hub is starting: its brains are not in yet", () => {
    expect(showGate([], state([brain("codex@local", { installed: true })], false, false, true))).toBe(false);
  });
});

describe("newest", () => {
  it("keeps only the newest request current, so an older answer that comes back later is dropped", () => {
    const ticket = newest();
    const first = ticket();
    expect(first()).toBe(true);
    const second = ticket();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});

describe("introDue", () => {
  const hi = [msg("user", [{ type: "text", text: "hi" }])];

  it("opens the intro in the default agent's empty dialog on a new hub with a brain", () => {
    expect(introDue([], state([], true, true), true)).toBe(true);
  });

  it("waits for a brain, the default agent's dialog and an empty one; never on a hub already in use", () => {
    expect(introDue([], state([], false, true), true)).toBe(false);
    expect(introDue([], state([], true, true), false)).toBe(false);
    expect(introDue(hi, state([], true, true), true)).toBe(false);
    expect(introDue([], state([], true, false), true)).toBe(false);
    expect(introDue([], null, true)).toBe(false);
  });
});
