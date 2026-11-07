import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PiomioManifestSchema, toolPrefixOf, type ToolCallContext } from "@piomio/shared";
import { EventBus } from "../../src/bus.ts";
import { openDb } from "../../src/db.ts";
import { pluginKv } from "../../src/plugins/kv.ts";
import { CoreTriggers } from "../../src/signals/core-host.ts";
import type { TriggerHttpRequest } from "../../src/signals/host.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

type Card = { enabled: boolean; settings: Record<string, unknown> } | undefined;

/** A promise that waits until it is let go. */
function latch() {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

/** `before`: awaited before a core call is answered (a latch holds it). */
function setup(card: Card | null = { enabled: true, settings: {} }, fetch?: () => any, before?: (method: string) => Promise<void> | undefined) {
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
      await before?.(method);
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
const until = async (fn: () => unknown, what: string, timeoutMs = 5000) => {
  const end = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("the trigger engine's host in core", () => {
  it("runs on the plugin's storage, with its tools named trigger_* and owned by the Triggers card", async () => {
    const s = setup();
    await s.ct.start();
    // Owned by "triggers", as the plugin's were: "always allow", the catalog's uses and the card's tool list go by it.
    expect(triggerTools(s.tools).map((t) => [t.name, t.owner]).sort()).toEqual([
      ["trigger_create", "triggers"],
      ["trigger_delete", "triggers"],
      ["trigger_list", "triggers"],
      ["trigger_run_now", "triggers"],
      ["trigger_update", "triggers"],
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

  it("names its tools with the card's own tool prefix, which counts a turned-off card's earlier uses", () => {
    const file = join(import.meta.dirname, "..", "..", "..", "..", "plugins", "triggers", ".piomio-plugin", "plugin.json");
    const manifest = PiomioManifestSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    expect(toolPrefixOf(manifest)).toBe("trigger");
  });

  it("keeps debug and info quiet and sends warnings and errors to the hub's console", async () => {
    const s = setup();
    await s.ct.start();
    const out = { log: vi.spyOn(console, "log"), info: vi.spyOn(console, "info"), warn: vi.spyOn(console, "warn"), error: vi.spyOn(console, "error") };
    try {
      const log = s.ct.engine!.ctx.log;
      log.debug("a debug line");
      log.info("trigger t_1: catch-up");
      expect([out.log, out.info, out.warn, out.error].map((m) => m.mock.calls.length)).toEqual([0, 0, 0, 0]);
      log.warn("settings.get failed:", "boom");
      log.error("trigger t_1 failed: oops");
      expect(out.warn.mock.calls).toEqual([["[piomio] triggers warn: settings.get failed: boom"]]);
      expect(out.error.mock.calls).toEqual([["[piomio] triggers error: trigger t_1 failed: oops"]]);
      expect(out.log).not.toHaveBeenCalled();
    } finally {
      for (const m of Object.values(out)) m.mockRestore();
      s.ct.stop();
    }
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

  it("a stop while it starts cuts off what the start still does: no engine, no tools, no listeners, no writes", async () => {
    const held = latch();
    const s = setup(undefined, undefined, (m) => (m === "settings.get" ? held.wait : undefined));
    const started = s.ct.start();
    await until(() => s.calls.some((c) => c.method === "settings.get"), "the start to ask for the hub settings");
    s.ct.stop();
    const kv = pluginKv(s.db, "triggers");
    const atStop = kv.list();
    held.open();
    // Stopped, it is not a failure to start.
    await expect(started).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 50)); // its boot would run on the next turn
    expect(s.ct.engine).toBeUndefined();
    expect(triggerTools(s.tools)).toEqual([]);
    expect(s.settingsListeners.size).toBe(0);
    expect(kv.list()).toEqual(atStop);
  });

  it("a stop right after a start leaves its boot nothing to write", async () => {
    const s = setup();
    const kv = pluginKv(s.db, "triggers");
    kv.set("initialized", true);
    // No next run yet: boot would plan one and save it.
    kv.set("trigger:t_s", {
      id: "t_s", kind: "schedule", name: "Brief", prompt: "Brief me.", agentId: "assistant", enabled: true, maxRunsPerDay: 24, cron: "0 9 * * *",
      createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", createdBy: "user", report: true, state: {},
    });
    await s.ct.start();
    s.ct.stop();
    const atStop = kv.list();
    await new Promise((r) => setTimeout(r, 50));
    expect(kv.list()).toEqual(atStop);
  });

  it("a stop during a watch's page load: the check that finishes later starts no task and writes nothing", async () => {
    const held = latch();
    let loading = false;
    const s = setup({ enabled: true, settings: { allowPrivateUrls: true } }, () => ({
      fetch: async () => {
        loading = true;
        await held.wait;
        return new Response("<p>new price</p>", { status: 200, headers: { "content-type": "text/html" } });
      },
    }));
    const kv = pluginKv(s.db, "triggers");
    kv.set("initialized", true);
    kv.set("trigger:t_w", {
      id: "t_w", kind: "watch", name: "Price", prompt: "Tell me.", agentId: "assistant", enabled: true, maxRunsPerDay: 24, url: "http://127.0.0.1:9/p", intervalMinutes: 60,
      createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", createdBy: "user", report: false,
      state: { lastHash: "old", lastValue: "old price", nextRunAt: "2099-01-01T00:00:00.000Z" },
    });
    await s.ct.start();
    const check = s.ct.engine!.checkNow("t_w");
    await until(() => loading, "the page load");
    s.ct.stop();
    const atStop = { kv: kv.list(), calls: s.calls.length };
    held.open();
    await check.catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(s.calls.slice(atStop.calls).map((c) => c.method)).toEqual([]);
    expect(kv.list()).toEqual(atStop.kv);
  });

  it("a start that throws is not stuck: the next start runs", async () => {
    let n = 0;
    const s = setup(undefined, () => {
      if (n++ === 0) throw new Error("no fetch yet");
      return { fetch: async () => new Response("") };
    });
    await expect(s.ct.start()).rejects.toThrow("no fetch yet");
    expect(s.ct.engine).toBeUndefined();
    await s.ct.start();
    expect(s.ct.engine).toBeDefined();
    s.ct.stop();
  });

  it("makes its page loads afresh on every start and lets them go when it stops (the egress token, the sockets)", async () => {
    const made: Array<{ released: number }> = [];
    const s = setup(undefined, () => {
      const m = { released: 0 };
      made.push(m);
      return { fetch: async () => new Response(""), release: () => void m.released++ };
    });
    await s.ct.start();
    expect(made).toEqual([{ released: 0 }]);
    s.ct.stop();
    expect(made).toEqual([{ released: 1 }]);
    await s.ct.start();
    expect(made).toEqual([{ released: 1 }, { released: 0 }]);
    s.ct.stop();
    s.ct.stop();
    expect(made).toEqual([{ released: 1 }, { released: 1 }]);
  });

  it("keeps the journal in the hub's database, moves the plugin's run lists into it, and refuses the store once stopped", async () => {
    const s = setup();
    const kv = pluginKv(s.db, "triggers");
    kv.set("initialized", true);
    kv.set("runs:t_old", [{ id: "r_old", at: new Date().toISOString(), reason: "schedule", status: "started" }]);
    await s.ct.start();
    const store = (s.ct.engine as any).ctx.store;
    expect(store.runs("t_old").map((r: { id: string }) => r.id)).toEqual(["r_old"]);
    expect(kv.list("runs:")).toEqual([]);
    expect((s.db.prepare("select count(*) as n from trigger_runs").get() as { n: number }).n).toBe(1);
    s.ct.stop();
    expect(() => store.runs("t_old")).toThrow(/stopped/);
    expect(() => store.stateSet("t_old", "k", 1)).toThrow(/stopped/);
    expect(() => store.addNote({ agentId: "a", triggerId: "t", triggerName: "T", text: "x", signalIds: [], external: false })).toThrow(/stopped/);
  });
});
