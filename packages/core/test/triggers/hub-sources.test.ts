// The hub's own events as signals (signals/hub-sources.ts, wired by SignalSources): broadcast sources hub.*, mapped
// from the bus. They start and stop with the registry, each lists with a title, description, schema and sample, and
// a trigger's own wake task finishing does not wake it again.

import { describe, expect, it } from "vitest";
import { EventBus } from "../../src/bus.ts";
import { tFor } from "../../src/i18n.ts";
import { SignalSources } from "../../src/signals/sources.ts";
import type { Signal, Trigger } from "../../src/signals/types.ts";

const trigger = (id: string, types: string[], over: Partial<Trigger> = {}): Trigger => ({
  id,
  kind: "signal",
  name: id,
  prompt: "Look.",
  agentId: "assistant",
  enabled: true,
  maxRunsPerDay: 24,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  createdBy: "user",
  state: {},
  on: types.map((type) => ({ type })),
  ...over,
});

function setup(
  triggers: Trigger[],
  o: {
    start?: boolean;
    machines?: Array<{ id: string; name: string; status: "online" | "offline" }>;
    taskTainted?: (t: any) => boolean;
    tasks?: Record<string, { triggerId?: string; parentTaskId?: string }>;
  } = {},
) {
  const bus = new EventBus();
  const deliveries: Array<{ triggerId: string; signal: Signal }> = [];
  const clock = { now: Date.parse("2026-11-08T10:00:30Z") };
  const machines = o.machines ?? [];
  const s = new SignalSources({
    plugins: { declared: () => [], subscribe: async () => {}, stop: async () => {} },
    triggers: () => triggers,
    sink: {
      deliver: async (triggerId, signals) => {
        for (const signal of signals) deliveries.push({ triggerId, signal });
        return undefined;
      },
    },
    bus,
    now: () => clock.now,
    machines: () => machines,
    ...(o.taskTainted ? { taskTainted: o.taskTainted } : {}),
    ...(o.tasks ? { task: (id: string) => o.tasks![id] } : {}),
    redact: (v) => JSON.parse(JSON.stringify(v).replaceAll("SECRET", "***")),
  });
  if (o.start !== false) s.start();
  return { s, bus, deliveries, clock, machines };
}

const task = (over: Record<string, unknown> = {}) => ({
  id: "task_1",
  agentId: "a1",
  conversationId: "c_1",
  title: "Write report",
  status: "done",
  result: "All good",
  updatedAt: "2026-11-08T10:00:00.000Z",
  ...over,
});

describe("the hub's own sources", () => {
  it("lists every hub source as a broadcast, not external, with a title, description, schema and sample", () => {
    const f = setup([]);
    const en = tFor("en");
    const types = ["hub.task.finished", "hub.task.failed", "hub.machine.online", "hub.machine.offline", "hub.feed.post", "hub.approval.waiting"];
    const list = f.s.list("en");
    for (const type of types) {
      const info = list.find((x) => x.type === type);
      expect(info, type).toBeDefined();
      expect(info).toMatchObject({ source: "hub", mode: "broadcast", external: type === "hub.feed.post", online: true, title: en(`triggers.source.${type}`) });
      expect(info!.title).not.toBe(`triggers.source.${type}`);
      expect(info!.description.length).toBeGreaterThan(20);
      expect(info!.data).toBeTruthy();
      expect(info!.sample).toBeTruthy();
    }
    expect(list.find((x) => x.type === "hub.task.finished")!.title).not.toBe(f.s.list("ru").find((x) => x.type === "hub.task.finished")!.title);
  });

  it("task.updated with status done brings hub.task.finished, keyed by task and status, the result cut to 2 KB", () => {
    const f = setup([trigger("t1", ["hub.task.finished"]), trigger("t2", ["hub.task.failed"]), trigger("off", ["hub.task.finished"], { enabled: false })]);
    f.bus.emit("task.updated", task({ result: "x".repeat(5000) }));
    expect(f.deliveries).toHaveLength(1);
    const { triggerId, signal } = f.deliveries[0];
    expect(triggerId).toBe("t1");
    expect(signal).toMatchObject({ type: "hub.task.finished", source: "hub", external: false, key: "task_1:done:2026-11-08T10:00:00.000Z", subject: "Write report" });
    const d = signal.data as { taskId: string; agentId: string; title: string; result: string };
    expect(d).toMatchObject({ taskId: "task_1", agentId: "a1", title: "Write report" });
    expect(Buffer.byteLength(d.result)).toBeLessThanOrEqual(2048);
    expect(d.result.length).toBeGreaterThan(1000);
  });

  it("other task statuses bring nothing; failed brings hub.task.failed with the error", () => {
    const f = setup([trigger("t1", ["hub.task.finished", "hub.task.failed"])]);
    f.bus.emit("task.updated", task({ status: "running" }));
    f.bus.emit("task.updated", task({ status: "cancelled" }));
    expect(f.deliveries).toEqual([]);
    f.bus.emit("task.updated", task({ status: "failed", error: "boom SECRET", result: undefined }));
    expect(f.deliveries).toHaveLength(1);
    expect(f.deliveries[0].signal).toMatchObject({ type: "hub.task.failed", key: "task_1:failed:2026-11-08T10:00:00.000Z", subject: "Write report", data: { taskId: "task_1", agentId: "a1", title: "Write report", error: "boom ***" } });
  });

  it("a task that read outside content brings an external signal", () => {
    const f = setup([trigger("t1", ["hub.task.finished"])]);
    f.bus.emit("task.updated", task({ tainted: true }));
    expect(f.deliveries[0].signal.external).toBe(true);
  });

  it("a task whose conversation read outside content brings an external signal, though the task itself was not started with any", () => {
    const f = setup([trigger("t1", ["hub.task.finished", "hub.task.failed"])], { taskTainted: (t) => t.tainted === true || t.conversationId === "c_web" });
    f.bus.emit("task.updated", task({ id: "task_web", conversationId: "c_web", result: "What the page said" }));
    f.bus.emit("task.updated", task({ id: "task_web2", conversationId: "c_web", status: "failed", error: "The page said no" }));
    f.bus.emit("task.updated", task({ id: "task_plain", conversationId: "c_plain" }));
    expect(f.deliveries.map((d) => [d.signal.data && (d.signal.data as any).taskId, d.signal.external])).toEqual([
      ["task_web", true],
      ["task_web2", true],
      ["task_plain", false],
    ]);
  });

  it("brings one signal per finish: not again while the task stays done, but again when it finishes after another turn", () => {
    const f = setup([trigger("t1", ["hub.task.finished"])]);
    f.bus.emit("task.updated", task());
    f.bus.emit("task.updated", task({ title: "Renamed", updatedAt: "2026-11-08T10:01:00.000Z" }));
    expect(f.deliveries).toHaveLength(1);
    f.bus.emit("task.updated", task({ status: "running", updatedAt: "2026-11-08T11:00:00.000Z" }));
    f.bus.emit("task.updated", task({ updatedAt: "2026-11-08T11:05:00.000Z" }));
    expect(f.deliveries).toHaveLength(2);
    expect(f.deliveries[1].signal.key).toBe("task_1:done:2026-11-08T11:05:00.000Z");
    expect(f.deliveries[1].signal.key).not.toBe(f.deliveries[0].signal.key);
  });

  it("the self-loop guard follows subtasks and approvals up to the trigger's own wake task", () => {
    const tasks = { task_wake: { triggerId: "t1" }, task_sub: { parentTaskId: "task_wake" }, task_subsub: { parentTaskId: "task_sub" } };
    const f = setup([trigger("t1", ["hub.task.finished", "hub.approval.waiting"]), trigger("t2", ["hub.task.finished", "hub.approval.waiting"])], { tasks });
    f.bus.emit("task.updated", task({ id: "task_subsub", parentTaskId: "task_sub" }));
    expect(f.deliveries.map((d) => d.triggerId)).toEqual(["t2"]);
    f.deliveries.length = 0;
    f.bus.emit("approval.created", { id: "a_1", agentId: "a1", taskId: "task_sub", summary: "Send a message" });
    f.bus.emit("approval.created", { id: "a_2", agentId: "a1", taskId: "task_wake", summary: "Send a message" });
    expect(f.deliveries.map((d) => d.triggerId)).toEqual(["t2", "t2"]);
    f.deliveries.length = 0;
    // Not the trigger's own: everyone hears it.
    f.bus.emit("approval.created", { id: "a_3", agentId: "a1", taskId: "task_other", summary: "Send a message" });
    expect(f.deliveries.map((d) => d.triggerId)).toEqual(["t1", "t2"]);
  });

  it("names each hub signal in its subject: the task's title, the computer, the post, the approval", () => {
    const f = setup([trigger("t1", ["hub.machine.online", "hub.feed.post", "hub.approval.waiting", "hub.task.finished"])]);
    f.bus.emit("machine.updated", { id: "m1", name: "Studio\nMac", status: "online" });
    f.bus.emit("feed.post", { id: "p1", feedId: "f1", title: "A   new\trelease", text: "b", createdAt: "x" });
    f.bus.emit("approval.created", { id: "a_1", agentId: "a1", summary: "Send " + "x".repeat(400) });
    f.bus.emit("task.updated", task({ title: "Weekly\n report" }));
    const subjects = f.deliveries.map((d) => d.signal.subject!);
    expect(subjects.slice(0, 2)).toEqual(["Studio Mac", "A new release"]);
    expect(subjects[2].startsWith("Send xxx")).toBe(true);
    expect(subjects[2].length).toBeLessThanOrEqual(200);
    expect(subjects[3]).toBe("Weekly report");
  });

  it("drops hub.task.* for a task the receiving trigger started (the self-loop guard), but not for other triggers", () => {
    const f = setup([trigger("t1", ["hub.task.finished", "hub.task.failed"]), trigger("t2", ["hub.task.finished"])]);
    f.bus.emit("task.updated", task({ triggerId: "t1", createdBy: "trigger" }));
    expect(f.deliveries.map((d) => d.triggerId)).toEqual(["t2"]);
    f.deliveries.length = 0;
    f.bus.emit("task.updated", task({ id: "task_2", status: "failed", error: "x", triggerId: "t1" }));
    expect(f.deliveries).toEqual([]);
  });

  it("machine.updated brings hub.machine.online / offline on a change of status only", () => {
    const f = setup([trigger("t1", ["hub.machine.online", "hub.machine.offline"])], { machines: [{ id: "m1", name: "Mac", status: "offline" }] });
    f.bus.emit("machine.updated", { id: "m1", name: "Mac", status: "offline" });
    expect(f.deliveries).toEqual([]);
    f.bus.emit("machine.updated", { id: "m1", name: "Mac", status: "online" });
    f.bus.emit("machine.updated", { id: "m1", name: "Mac", status: "online" });
    expect(f.deliveries).toHaveLength(1);
    expect(f.deliveries[0].signal).toMatchObject({ type: "hub.machine.online", key: "m1:online:2026-11-08T10:00", data: { machineId: "m1", name: "Mac" } });
    f.bus.emit("machine.updated", { id: "m1", name: "Mac", status: "offline" });
    expect(f.deliveries[1].signal).toMatchObject({ type: "hub.machine.offline", key: "m1:offline:2026-11-08T10:00", data: { machineId: "m1", name: "Mac" } });
  });

  it("a machine first seen online counts as coming online; a removed machine goes offline under its known name", () => {
    const f = setup([trigger("t1", ["hub.machine.online", "hub.machine.offline"])]);
    f.bus.emit("machine.updated", { id: "m2", name: "PC", status: "online" });
    expect(f.deliveries[0].signal.type).toBe("hub.machine.online");
    f.bus.emit("machine.updated", { id: "m2", status: "offline", revoked: true });
    expect(f.deliveries[1].signal).toMatchObject({ type: "hub.machine.offline", data: { machineId: "m2", name: "PC" } });
  });

  it("feed.post brings hub.feed.post with the channel, title and address", () => {
    const f = setup([trigger("t1", ["hub.feed.post"])]);
    f.bus.emit("feed.post", { id: "p1", feedId: "f1", title: "News", text: "long body", url: "https://example.com/a", createdAt: "2026-11-08T10:00:00Z" });
    f.bus.emit("feed.post", { id: "p2", feedId: "f1", title: "No link", text: "b", createdAt: "2026-11-08T10:00:00Z" });
    expect(f.deliveries[0].signal).toMatchObject({ type: "hub.feed.post", key: "p1", data: { feedId: "f1", title: "News", url: "https://example.com/a" } });
    expect(f.deliveries[1].signal.data).toEqual({ feedId: "f1", title: "No link" });
  });

  it("a channel post is always external, and the listing says so", () => {
    const f = setup([trigger("t1", ["hub.feed.post"])]);
    f.bus.emit("feed.post", { id: "p1", feedId: "f1", title: "News", text: "b", createdAt: "x" });
    expect(f.deliveries[0].signal.external).toBe(true);
    expect(f.s.list("en").find((x) => x.type === "hub.feed.post")!.external).toBe(true);
  });

  it("an approval's signal is external when the approval is tainted", () => {
    const f = setup([trigger("t1", ["hub.approval.waiting"])]);
    f.bus.emit("approval.created", { id: "a_1", agentId: "a1", summary: "Open a link", tainted: true });
    f.bus.emit("approval.created", { id: "a_2", agentId: "a1", summary: "Open a link", tainted: false });
    expect(f.deliveries.map((d) => d.signal.external)).toEqual([true, false]);
  });

  it("approval.created brings hub.approval.waiting with the summary and no tool input", () => {
    const f = setup([trigger("t1", ["hub.approval.waiting"])]);
    f.bus.emit("approval.created", { id: "a_1", agentId: "a1", tool: "shell", input: { cmd: "rm -rf /" }, summary: "Run a command" });
    expect(f.deliveries[0].signal).toMatchObject({ type: "hub.approval.waiting", key: "a_1", data: { approvalId: "a_1", agentId: "a1", summary: "Run a command" } });
    expect(JSON.stringify(f.deliveries[0].signal)).not.toContain("rm -rf");
  });

  it("listens only while the sources run: nothing before start, nothing after stop, one listener after a restart", () => {
    const f = setup([trigger("t1", ["hub.feed.post"])], { start: false });
    const post = { id: "p1", feedId: "f1", title: "A", text: "b", createdAt: "x" };
    f.bus.emit("feed.post", post);
    expect(f.deliveries).toEqual([]);
    f.s.start();
    f.s.start();
    f.bus.emit("feed.post", { ...post, id: "p2" });
    expect(f.deliveries).toHaveLength(1);
    f.s.stop();
    f.bus.emit("feed.post", { ...post, id: "p3" });
    expect(f.deliveries).toHaveLength(1);
  });
});
