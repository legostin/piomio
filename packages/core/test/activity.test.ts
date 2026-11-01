// The machines block: turns in progress by machine, what each is doing, approvals it waits for, and the event.
import { describe, expect, it } from "vitest";
import type { Approval, Machine, MachineActivity } from "@piomio/shared";
import { EventBus } from "../src/bus.ts";
import { detailOfTool, MachineActivityFeed, stepOfTool } from "../src/activity.ts";
import type { MachineHub } from "../src/machines.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(machines: Array<Pick<Machine, "id" | "name" | "status">> = []) {
  const bus = new EventBus();
  const feed = new MachineActivityFeed(bus, { list: () => machines } as unknown as MachineHub);
  const seen: MachineActivity[][] = [];
  bus.on("machines.activity", (v) => seen.push(v));
  return { bus, feed, seen };
}

const approval = (conversationId: string, agentId: string) => ({ id: "ap", conversationId, agentId }) as Approval;

describe("machines activity", () => {
  it("offers on each online row the update self-update.ts has for it, and tells when that changes", async () => {
    const { bus, feed, seen } = setup([
      { id: "m1", name: "vps", status: "online" },
      { id: "m2", name: "laptop", status: "offline" },
    ]);
    feed.updates = { offerFor: (id) => (id === "local" ? { update: "0.3.0", updating: true } : { update: "0.2.9" }) };
    const view = feed.view();
    expect(view[0]).toMatchObject({ id: "local", update: "0.3.0", updating: true });
    expect(view[1]).toMatchObject({ id: "m1", update: "0.2.9" });
    expect(view[2].update).toBeUndefined();
    bus.emit("updates.changed", {});
    await sleep(300);
    expect(seen).toHaveLength(1);
    feed.close();
  });

  it("tells what a tool call does by the tool's name", () => {
    expect(["Bash", "shell", "exec_command"].map(stepOfTool)).toEqual(["command", "command", "command"]);
    expect(["Read", "Grep", "Glob"].map(stepOfTool)).toEqual(["reading", "reading", "reading"]);
    expect(["Edit", "Write", "apply_patch"].map(stepOfTool)).toEqual(["editing", "editing", "editing"]);
    expect(["WebSearch", "WebFetch", "web_search", "web_fetch", "web_rss"].map(stepOfTool)).toEqual(["web", "web", "web", "web", "web"]);
    expect(stepOfTool("google_calendar_list_events")).toBe("tool");
  });

  it("says in a few words what each call is about", () => {
    expect(detailOfTool("Read", { file_path: "/Users/me/work/plan.md" })).toBe("plan.md");
    expect(detailOfTool("Grep", { pattern: "TODO" })).toBe("TODO");
    expect(detailOfTool("apply_patch", { files: ["src/a.ts", "src/b.ts"] })).toBe("a.ts");
    expect(detailOfTool("Bash", { command: "npm test -- --run\necho done" })).toBe("npm test -- --run");
    expect(detailOfTool("WebFetch", { url: "https://example.com/a?b=1" })).toBe("example.com");
    expect(detailOfTool("WebSearch", { query: "weather in Almaty" })).toBe("weather in Almaty");
    expect(detailOfTool("task_delegate", { goal: "x" })).toBe("task_delegate");
    expect(detailOfTool("Bash", { command: "x".repeat(100) })).toHaveLength(60);
  });

  it("keeps a step's detail, and gets it back after an approval", () => {
    const { bus, feed } = setup();
    const work = () => feed.view()[0].work[0];
    feed.start("a", { brainRef: "fake@local", agentId: "assistant", conversationId: "c1" });
    feed.step("a", "reading", "plan.md");
    expect(work()).toMatchObject({ step: "reading", detail: "plan.md" });
    bus.emit("approval.created", approval("c1", "assistant"));
    expect(work().step).toBe("approval");
    expect(work()).not.toHaveProperty("detail");
    bus.emit("approval.resolved", approval("c1", "assistant"));
    expect(work()).toMatchObject({ step: "reading", detail: "plan.md" });
    feed.step("a", "writing");
    expect(work()).not.toHaveProperty("detail");
    feed.close();
  });

  it("lists the hub's computer first, then the paired machines, each with its own turns", () => {
    const { feed } = setup([
      { id: "m1", name: "Laptop", status: "online" },
      { id: "m2", name: "Desktop", status: "offline" },
    ]);
    feed.start("a", { brainRef: "claude-code@m1", agentId: "coder", conversationId: "c1", taskId: "t1", title: "Fix the build" });
    feed.start("b", { brainRef: "codex@local", agentId: "assistant", conversationId: "c2" });
    const view = feed.view();
    expect(view.map((m) => [m.id, m.online, m.work.length])).toEqual([
      ["local", true, 1],
      ["m1", true, 1],
      ["m2", false, 0],
    ]);
    expect(view[0].name).toBeTruthy();
    expect(view[1].work[0]).toMatchObject({ agentId: "coder", conversationId: "c1", taskId: "t1", title: "Fix the build", brainId: "claude-code", step: "thinking" });
    expect(view[0].work[0]).not.toHaveProperty("title");
    feed.end("a");
    expect(feed.view()[1].work).toEqual([]);
    feed.close();
  });

  it("follows the turn's steps and the approval it waits for", () => {
    const { bus, feed } = setup();
    const step = () => feed.view()[0].work[0]?.step;
    feed.start("a", { brainRef: "fake@local", agentId: "assistant", conversationId: "c1" });
    feed.step("a", "command");
    expect(step()).toBe("command");
    // Another agent's approval, or another conversation's, is not this turn's.
    bus.emit("approval.created", approval("c1", "scout"));
    bus.emit("approval.created", approval("c2", "assistant"));
    expect(step()).toBe("command");
    bus.emit("approval.created", approval("c1", "assistant"));
    expect(step()).toBe("approval");
    // Steps while it waits come back once the user decides.
    feed.step("a", "writing");
    expect(step()).toBe("approval");
    bus.emit("approval.resolved", approval("c1", "assistant"));
    expect(step()).toBe("writing");
    feed.close();
  });

  it("announces the view once for a burst of changes", async () => {
    const { feed, seen } = setup();
    feed.start("a", { brainRef: "fake@local", agentId: "assistant", conversationId: "c1" });
    feed.step("a", "writing");
    feed.step("a", "reading");
    await sleep(400);
    expect(seen).toHaveLength(1);
    expect(seen[0][0].work[0].step).toBe("reading");
    feed.end("a");
    await sleep(400);
    expect(seen).toHaveLength(2);
    expect(seen[1][0].work).toEqual([]);
    feed.close();
  });
});
