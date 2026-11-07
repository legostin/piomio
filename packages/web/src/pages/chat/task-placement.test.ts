import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskLine } from "./TaskLine";
import { TaskDetailPage } from "../TaskDetail";
import { tasks } from "../../state/app";
import type { Task } from "@piomio/shared";

vi.mock("../../lib/native", () => ({ native: null }));
vi.mock("../../state/app", async () => {
  const { createStore } = await import("../../lib/store");
  return {
    tasks: createStore([]), agents: createStore([]),
    machineActivity: createStore([{ id: "box", name: "Report computer" }]),
    ensureTasks() {}, ensureAgents() {}, ensureMachineActivity() {},
  };
});
vi.mock("../../state/brains", async () => {
  const { createStore } = await import("../../lib/store");
  return { brains: createStore([]), brainMachine: (ref: string) => ref.split("@")[1] ?? "local" };
});
vi.mock("./LiveStep", () => ({ useWork: () => undefined, stepText: () => "" }));
vi.mock("../../components/markdown", () => ({ Markdown: () => null }));
vi.mock("./ChatView", () => ({ ChatView: ({ top }: any) => top }));
vi.mock("../../components/Layout", () => ({ TopBar: ({ children }: any) => children }));
vi.mock("wouter", () => ({ Link: ({ children }: any) => createElement("a", {}, children) }));

const render = (patch: Partial<Task>) => {
  tasks.set([{ id: "t", title: "Report", agentId: "legost", status: "queued", ...patch } as Task]);
  return renderToStaticMarkup(createElement(TaskLine, { taskId: "t" }));
};
beforeEach(() => tasks.set([]));

describe("task placement in the conversation", () => {
  it("shows the requested remote computer before any brain starts", () => {
    const html = render({ machineId: "box" });
    expect(html).toContain("Report computer");
    expect(html).toContain(">queued</span>");
  });
  it("keeps legacy placement visible and gives the explicit machine precedence", () => {
    expect(render({ brainRef: "claude-code@box" })).toContain("Report computer");
    expect(render({ machineId: "local", brainRef: "claude-code@box" })).not.toContain("Report computer");
  });
  it("does not present a legacy placement snapshot as the brain that actually ran", () => {
    tasks.set([{ id: "t", title: "Report", agentId: "legost", goal: "report", createdAt: "2026-11-07T08:00:00.000Z", status: "done", brainRef: "claude-code@local" } as Task]);
    const html = renderToStaticMarkup(createElement(TaskDetailPage, { id: "t" }));
    expect(html).toContain("Report");
    expect(html).not.toContain("claude-code@local");
  });
});
