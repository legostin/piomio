import { describe, expect, it } from "vitest";
import type { ToolCallContext } from "@piomio/shared";
import { EventBus } from "../../src/bus.ts";
import { openDb } from "../../src/db.ts";
import { pluginKv } from "../../src/plugins/kv.ts";
import { CoreTriggers } from "../../src/signals/core-host.ts";
import type { TriggerHttpRequest } from "../../src/signals/host.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

type Card = { enabled: boolean; settings: Record<string, unknown> } | undefined;

function setup(card: Card | null = { enabled: true, settings: {} }, fetch?: () => any) {
  const db = openDb(":memory:");
  const bus = new EventBus();
  const tools = new ToolRegistry();
  const settingsListeners = new Set<(s: Record<string, unknown>) => void>();
  const calls: Array<{ pluginId: string; method: string; params: any }> = [];
  let current: Card = card ?? undefined;
  const ct = new CoreTriggers({
    db,
    bus,
    tools,
    hubUrl: "http://127.0.0.1:8080",
    ...(fetch ? { fetch } : {}),
    card: {
      get: () => current,
      onSettings: (cb) => {
        settingsListeners.add(cb);
        return () => void settingsListeners.delete(cb);
      },
    },
    coreCall: async (pluginId, method, params) => {
      calls.push({ pluginId, method, params });
      if (method === "settings.get") return { timezone: "Europe/Moscow", defaultAgent: "assistant" };
      if (method === "agents.list") return [{ id: "assistant", name: "A" }];
      if (method === "tasks.create") return { id: "task_1" };
      return [];
    },
  });
  return { db, bus, tools, ct, calls, settingsListeners, setCard: (c: Card) => void (current = c) };
}

const call: ToolCallContext = { sessionId: "s", conversationId: "c", agentId: "assistant", callId: "x", tainted: false, background: false, workspace: "/tmp", machineId: "local" };
const req = (over: Partial<TriggerHttpRequest>): TriggerHttpRequest => ({ method: "GET", path: "/triggers", query: {}, headers: {}, body: null, public: false, locale: "en", ...over });
const triggerTools = (tools: ToolRegistry) => tools.list().filter((t) => t.name.startsWith("trigger_"));

describe("the trigger engine's host in core", () => {
  it("runs on the plugin's storage, with its tools as core tools named trigger_*", async () => {
    const s = setup();
    await s.ct.start();
    expect(triggerTools(s.tools).map((t) => [t.name, t.owner]).sort()).toEqual([
      ["trigger_create", "core"],
      ["trigger_delete", "core"],
      ["trigger_list", "core"],
      ["trigger_run_now", "core"],
      ["trigger_update", "core"],
    ]);
    // A new hub's default heartbeat is written where the plugin kept its triggers.
    const stored = pluginKv(s.db, "triggers").list("trigger:");
    expect(stored).toHaveLength(1);
    expect(stored[0].value).toMatchObject({ kind: "heartbeat", agentId: "assistant" });
    const listed = await s.tools.get("trigger_list")!.invoke({}, call);
    expect(listed.isError).toBeFalsy();
    expect(listed.content[0]).toMatchObject({ type: "text" });
    expect((listed.content[0] as { text: string }).text).toContain('"kind": "heartbeat"');
    s.ct.stop();
  });

  it("keeps the triggers the plugin saved, serves its API and its webhooks", async () => {
    const s = setup();
    const kv = pluginKv(s.db, "triggers");
    kv.set("initialized", true);
    kv.set("trigger:t_old", {
      id: "t_old", kind: "event", name: "Hook", prompt: "Look at the payload.", agentId: "assistant", enabled: true, maxRunsPerDay: 24,
      createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", createdBy: "user", secret: "s3cret", report: false, state: {},
    });
    await s.ct.start();
    const list = await s.ct.http(req({}));
    expect((list.body as any).triggers.map((t: any) => t.id)).toEqual(["t_old"]);
    expect((list.body as any).triggers[0].webhookUrl).toBe("http://127.0.0.1:8080/hooks/triggers/t_old");
    expect((await s.ct.http(req({ method: "POST", path: "/t_old", headers: { "x-piomio-secret": "nope" }, public: true }))).status).toBe(401);
    const hook = await s.ct.http(req({ method: "POST", path: "/t_old", headers: { "x-piomio-secret": "s3cret" }, body: { a: 1 }, public: true }));
    expect(hook.status).toBe(202);
    expect(s.calls.find((c) => c.method === "tasks.create")).toMatchObject({ pluginId: "triggers", params: { triggerId: "t_old", background: true, agentId: "assistant" } });
    expect(s.calls.some((c) => c.method === "ui.emit" && c.params.channel === "changed")).toBe(true);
    s.ct.stop();
  });

  it("stops when the card is switched off, takes its tools back, and starts again", async () => {
    const s = setup();
    await s.ct.start();
    s.setCard({ enabled: false, settings: {} });
    await s.ct.sync();
    expect(s.ct.engine).toBeUndefined();
    expect(triggerTools(s.tools)).toEqual([]);
    expect(s.settingsListeners.size).toBe(0);
    expect((await s.ct.http(req({}))).status).toBe(404);
    s.setCard({ enabled: true, settings: {} });
    await s.ct.sync();
    expect(s.ct.engine).toBeDefined();
    expect(triggerTools(s.tools)).toHaveLength(5);
    s.ct.stop();
  });

  it("does not run without the Triggers card", async () => {
    const s = setup(null);
    await s.ct.start();
    expect(s.ct.engine).toBeUndefined();
    expect(triggerTools(s.tools)).toEqual([]);
  });

  it("hands the card's settings to the engine, now and when they change", async () => {
    const s = setup({ enabled: true, settings: { allowPrivateUrls: true } });
    await s.ct.start();
    expect(s.ct.engine!.settings.allowPrivateUrls).toBe(true);
    for (const cb of s.settingsListeners) cb({ allowPrivateUrls: false, watchTimeoutSec: 10 });
    expect(s.ct.engine!.settings).toEqual({ allowPrivateUrls: false, watchTimeoutSec: 10 });
    s.ct.stop();
  });

  it("hears the bus: an agent deleted for good takes its triggers along", async () => {
    const s = setup();
    await s.ct.start();
    expect(s.ct.engine!.list()).toHaveLength(1);
    s.bus.emit("agent.removed", { agentId: "assistant" });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.ct.engine!.list()).toHaveLength(0);
    s.ct.stop();
  });

  it("a stop while it starts leaves nothing running", async () => {
    const s = setup();
    const started = s.ct.start();
    s.ct.stop();
    await started;
    expect(s.ct.engine).toBeUndefined();
    expect(triggerTools(s.tools)).toEqual([]);
    expect(s.settingsListeners.size).toBe(0);
    expect((await s.ct.http(req({}))).status).toBe(404);
    await s.ct.start();
    expect(s.ct.engine).toBeDefined();
    expect(triggerTools(s.tools)).toHaveLength(5);
    s.ct.stop();
  });

  it("a start that throws is not stuck: the next start runs", async () => {
    let n = 0;
    const s = setup(undefined, () => {
      if (n++ === 0) throw new Error("no fetch yet");
      return (async () => new Response("")) as any;
    });
    await expect(s.ct.start()).rejects.toThrow("no fetch yet");
    expect(s.ct.engine).toBeUndefined();
    await s.ct.start();
    expect(s.ct.engine).toBeDefined();
    s.ct.stop();
  });
});
