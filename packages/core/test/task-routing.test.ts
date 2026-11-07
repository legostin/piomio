// Exercise the real task runner and probe cache. Only the brain transport is simulated: no subscriptions or
// installed CLIs are needed, and availability is independently controlled for every brain/computer pair.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "@piomio/testkit";
import type { AgentDef, ProbeResult, RpcPeer, Task } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { taskBrains, taskPlacement } from "../src/task-routing.ts";
import { humanFailure } from "../src/notifier.ts";
import { openDb } from "../src/db.ts";
import { Store } from "../src/store.ts";
import { EventBus } from "../src/bus.ts";

async function until<T>(fn: () => T | undefined | false): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Task did not reach the expected state");
}

describe("task placement storage and constraints", () => {
  it("migrates legacy snapshots without inventing an explicit brain choice", () => {
    const file = join(mkdtempSync(join(tmpdir(), "task-routing-db-")), "hub.db");
    const old = openDb(file);
    const store = new Store(old, new EventBus());
    const task = store.createTask({ agentId: "legost", title: "Traffic", goal: "report", background: false, createdBy: "agent", brainRef: "claude-code@local", thinking: { brain: "codex", preset: "deep" } });
    old.exec("alter table tasks drop column machine_id; drop index messages_conv_changed; alter table messages drop column updated_at; alter table replicas drop column machine_id; update schema_version set v = v - 3;");
    old.close();
    const db = openDb(file);
    const migrated = new Store(db, new EventBus());
    expect(migrated.getTask(task.id)).toMatchObject({ brainRef: "claude-code@local", thinking: { brain: "codex" } });
    expect(taskPlacement(migrated.getTask(task.id)!)).toBe("local");
    migrated.updateTask(task.id, { machineId: "box" });
    expect(taskPlacement(migrated.getTask(task.id)!)).toBe("box");
    db.close();
  });

  it("honors machine bindings, explicit variants and same-host aliases", () => {
    const agent = { machines: ["rep_hub"] } as AgentDef;
    const task = { machineId: "node_alias", thinking: { brain: "codex@rep_hub" }, goal: "report" } as Task;
    const canonical = (id: string) => id === "node_alias" ? "rep_hub" : id;
    expect(taskBrains(["claude-code@local", "codex@local", "codex@rep_hub"], agent, task, "rep_hub", canonical)).toEqual(["codex@local"]);
    expect(taskBrains(["codex@node_alias"], agent, task, "rep_hub", canonical)).toEqual(["codex@node_alias"]);
    expect(taskBrains(["codex@local"], agent, { ...task, machineId: "other" }, "rep_hub", canonical)).toEqual([]);
    expect(taskBrains(["api:a@local", "api:b@local"], agent, { ...task, thinking: { brain: "api:b" } }, "rep_hub", canonical)).toEqual(["api:b@local"]);
  });

  it.each([
    { feedId: "feed_news", createdBy: "trigger" },
    { createdBy: "trigger" },
    { kind: "message" },
  ])("does not infer native code requirements from non-task instructions: %j", (kind) => {
    const agent = {} as AgentDef;
    const task = { ...kind, goal: "Save sources as script <file>" } as Task;
    expect(taskBrains(["api@local"], agent, task, "hub")).toEqual(["api@local"]);
    expect(taskBrains(["api@local"], agent, { ...task, thinking: { skill: "code" } }, "hub")).toEqual([]);
    expect(taskBrains(["api@local"], agent, { goal: task.goal } as Task, "hub")).toEqual([]);
  });
});

describe("available task brains (integration)", () => {
  let hub: Hub;
  let fake: RpcPeer;
  const probes = new Map<string, ProbeResult>();
  const opened: string[] = [];
  const failedOpen = new Set<string>();
  const ready = { available: true, authenticated: true };
  const missing = { available: false, authenticated: false, detail: "Claude Code is not installed" };
  const signedOut = { available: true, authenticated: false, detail: "Codex is not signed in on this computer" };
  const task = (id: string) => hub.store.getTask(id)!;
  const finished = (id: string) => until(() => ["done", "failed"].includes(task(id).status) && !hub.runner.isRunning(task(id).conversationId) ? task(id) : undefined);
  const start = (patch: Partial<Parameters<Hub["runner"]["createTask"]>[0]> = {}) => hub.runner.createTask({ agentId: "legost", title: "Traffic", goal: "report", createdBy: "user", background: false, machineId: "local", ...patch });
  const save = (patch: Partial<AgentDef> = {}) => hub.agents.save({ id: "legost", name: "Legost", description: "Reports", brains: ["claude-code@local", "codex@local"], prompt: "Report.", ...patch } as any);
  const peer = (machine: string) => ({
    onNotification: fake.onNotification.bind(fake),
    onClose: fake.onClose.bind(fake),
    close() {},
    async request(method: string, params: any, options: any) {
      const ref = `${params.brainId}@${machine}`;
      if (method === "brain.probe") return probes.get(ref) ?? signedOut;
      if (method === "brain.create") {
        opened.push(ref);
        if (failedOpen.has(ref)) throw new Error("brain process could not start");
        return fake.request(method, { ...params, brainId: "fake" }, options);
      }
      return fake.request(method, params, options);
    },
  }) as unknown as RpcPeer;

  beforeAll(async () => {
    const [port, consolePort, egressPort] = await Promise.all([freePort(), freePort(), freePort()]);
    const fixtures = join(import.meta.dirname, "fixtures");
    hub = new Hub(loadConfig({ PIOMIO_PORT: String(port), PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), PIOMIO_DEVICES: "0", TZ: "UTC" }, { dataDir: mkdtempSync(join(tmpdir(), "task-routing-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") }));
    await hub.start();
    await until(() => hub.brains.has("fake@local") && hub.brains.has("codex@local"));
    fake = (hub.brains as any).pluginBrains.get("fake").peer;
    const local = peer("local");
    for (const id of ["claude-code", "codex", "api"]) hub.brains.registerPluginBrain(id, id, "routing-fixture", local);
    hub.db.prepare("insert into machines(id, name, public_key, created_at) values (?,?,?,?)").run("box", "Box", "x", new Date().toISOString());
    (hub.machines as any).peers.set("box", peer("box"));
    hub.brains.registerMachine("box", "Box", peer("box"), [{ id: "codex", label: "Codex" }, { id: "claude-code", label: "Claude" }]);
    const list = hub.brains.list.bind(hub.brains);
    vi.spyOn(hub.brains, "list").mockImplementation(() => list().filter((b) => ["claude-code", "codex", "api"].includes(b.brainId)));
    hub.runner.waits = { brainMs: 0, machineMs: 0, everyMs: 100 };
  });
  beforeEach(() => {
    probes.clear(); opened.length = 0; failedOpen.clear(); hub.brains.invalidateAll();
    hub.db.exec("delete from brain_limits;");
    probes.set("claude-code@local", missing);
    probes.set("codex@local", ready);
    save();
  });
  afterAll(async () => { await hub?.stop(); vi.restoreAllMocks(); });

  it("creates a queued task without freezing the first configured brain, then runs the available Codex", async () => {
    const place = hub.runner.placeTask("legost", "local");
    expect(place).toMatchObject({ machineId: "local" });
    expect(place).not.toHaveProperty("brainRef");
    const t = start();
    expect(task(t.id).status).toBe("queued");
    expect(opened).toEqual([]);
    expect((await finished(t.id)).status).toBe("done");
    expect(opened).toEqual(["codex@local"]);
    expect(hub.store.activeSession(t.conversationId, "legost")?.brainRef).toBe("codex@local");
  });

  it("recovers a legacy Claude snapshot and respects an explicit Codex request", async () => {
    const t = start({ machineId: undefined, brainRef: "claude-code@local", thinking: { brain: "codex", preset: "deep" } });
    expect((await finished(t.id)).status).toBe("done");
    expect(opened).toEqual(["codex@local"]);
  });

  it("falls back beyond stale agent settings while staying on the bound computer", async () => {
    save({ brains: ["claude-code@local"], machines: ["local"], thinking: { task: { brain: "claude-code", preset: "deep" } } });
    expect((await finished(start().id)).status).toBe("done");
    expect(opened).toEqual(["codex@local"]);
  });

  it("does not use another computer's sign-in to satisfy a placed task, and keeps the real error in notifications", async () => {
    probes.set("codex@local", signedOut); probes.set("codex@box", ready);
    const failed = await finished(start({ thinking: { brain: "codex" } }).id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("codex@local: Codex is not signed in on this computer");
    expect(humanFailure(failed.error!, "no-brain", "Legost")).toContain("Codex is not signed in on this computer");
    expect(opened).toEqual([]);
  });

  it("never silently replaces a required brain with the available alternative", async () => {
    const failed = await finished(start({ thinking: { brain: "claude-code" } }).id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("Claude Code is not installed");
    expect(humanFailure(failed.error!, "no-brain", "Legost")).toContain("Claude Code is not installed");
    expect(opened).toEqual([]);
  });

  it("rejects conflicting required computer and brain locations", async () => {
    probes.set("codex@box", ready);
    const failed = await finished(start({ thinking: { brain: "codex@box" } }).id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("required choice: codex@box");
    expect(opened).toEqual([]);
  });

  it("opens the available brain on the requested remote computer", async () => {
    probes.set("claude-code@box", missing); probes.set("codex@box", ready);
    expect((await finished(start({ machineId: "box" }).id)).status).toBe("done");
    expect(opened).toEqual(["codex@box"]);
  });

  it("falls back if the preferred brain passes its probe but fails when opening a session", async () => {
    probes.set("claude-code@local", ready); failedOpen.add("claude-code@local");
    save({ brains: ["claude-code@local"], thinking: { task: { brain: "claude-code" } } });
    expect((await finished(start().id)).status).toBe("done");
    expect(opened).toEqual(["claude-code@local", "codex@local"]);
  });

  it("tries another suitable brain when the configured one is rate limited", async () => {
    save({ brains: ["claude-code@local"] });
    hub.db.prepare("insert into brain_limits(brain_ref, until, detail) values (?,?,?)").run("claude-code@local", "2099-01-01T00:00:00.000Z", "limit");
    expect((await finished(start().id)).status).toBe("done");
    expect(opened).toEqual(["codex@local"]);
  });

  it("preserves a session-opening failure when the other candidates are unavailable", async () => {
    probes.set("claude-code@local", ready); failedOpen.add("claude-code@local");
    probes.set("codex@local", signedOut);
    const failed = await finished(start().id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("claude-code@local: brain process could not start");
    expect(failed.error).toContain("codex@local: Codex is not signed in on this computer");
    expect(humanFailure(failed.error!, undefined, "Legost")).toContain("brain process could not start");
    expect(opened).toEqual(["claude-code@local"]);
  });

  it("reprobes on retry and reads the current inherited task settings", async () => {
    probes.set("codex@local", signedOut);
    const t = start({ machineId: undefined, brainRef: "claude-code@local" });
    expect((await finished(t.id)).status).toBe("failed");
    probes.set("codex@local", ready);
    // Cached sign-out is still present, until the retry invalidates it.
    expect((await hub.brains.probe("codex@local")).authenticated).toBe(false);
    save({ thinking: { task: { brain: "codex", preset: "deep" } } });
    expect(hub.runner.retryTask(t.id)?.status).toBe("queued");
    expect((await finished(t.id)).status).toBe("done");
    expect(opened).toEqual(["codex@local"]);
  });

  it("does not trust a cached successful probe after sign-out", async () => {
    await hub.brains.probe("codex@local");
    probes.set("codex@local", signedOut);
    expect((await hub.brains.probe("codex@local")).authenticated).toBe(true);
    expect((await finished(start({ thinking: { brain: "codex" } }).id)).status).toBe("failed");
    expect(opened).toEqual([]);
  });

  it("uses new inherited settings on retry instead of the last successful session", async () => {
    probes.set("claude-code@local", ready);
    save({ thinking: { chat: { brain: "claude-code" } } });
    const t = start();
    expect((await finished(t.id)).status).toBe("done");
    expect(opened).toEqual(["claude-code@local"]);
    save({ thinking: { chat: { brain: "codex" } } });
    hub.runner.retryTask(t.id);
    expect((await finished(t.id)).status).toBe("done");
    expect(opened).toEqual(["claude-code@local", "codex@local"]);
  });

  it("does not route native code work to an API brain, even with an exact inherited model", async () => {
    probes.set("codex@local", signedOut); probes.set("api@local", ready);
    save({ brains: ["api@local"], model: "exact-model" });
    const failed = await finished(start({ goal: "fix the bug", thinking: { skill: "code" } }).id);
    expect(failed.status).toBe("failed");
    expect(opened).toEqual([]);
  });

  it("starts a channel's first gathering run with its only API brain", async () => {
    probes.set("codex@local", signedOut); probes.set("api@local", ready);
    save({ brains: ["api@local"] });
    const feed = hub.feeds.create({ title: "City news", brief: "Gather city news", agentId: "legost" }, { run: false });
    const first = hub.feeds.run(feed.id);
    expect(first.goal).toContain("script <file>");
    expect((await finished(first.id)).status).toBe("done");
    expect(opened).toEqual(["api@local"]);
    expect(hub.store.activeSession(first.conversationId, "legost")?.brainRef).toBe("api@local");
  });
});
