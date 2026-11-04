import { describe, expect, it } from "vitest";
import type { Notification } from "@piomio/shared";
import { DESKTOP_NOTIFY_PREFIX, desktopNotifyLine, pushNote } from "../src/push.ts";
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

  it("hands the desktop app one line it can tell from the log", () => {
    const line = desktopNotifyLine(pushNote(base, "assistant", names), true);
    expect(line.startsWith(DESKTOP_NOTIFY_PREFIX)).toBe(true);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line.slice(DESKTOP_NOTIFY_PREFIX.length))).toEqual({ id: "n_1", title: "Build is green", body: "All 312 tests pass.", agent: "Assistant", path: "/agent/assistant", silent: true });
  });

  it("uses Piomio's relay unless told otherwise", () => {
    expect(loadConfig({}).pushRelay).toBe("https://legost.in/piomio-push");
    expect(loadConfig({ PIOMIO_PUSH_RELAY: "https://relay.example/" }).pushRelay).toBe("https://relay.example");
    expect(loadConfig({ PIOMIO_PUSH_RELAY: "off" }).pushRelay).toBeUndefined();
    expect(loadConfig({}).desktopNotify).toBe(false);
    expect(loadConfig({ PIOMIO_DESKTOP: "1" }).desktopNotify).toBe(true);
  });
});
