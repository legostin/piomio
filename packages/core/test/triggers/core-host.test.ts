import { describe, expect, it, vi } from "vitest";
import type { ToolCallContext } from "@piomio/shared";
import { EventBus } from "../../src/bus.ts";
import { openDb } from "../../src/db.ts";
import { pluginKv } from "../../src/plugins/kv.ts";
import { CoreTriggers, TRIGGERS_CARRIED, type CoreTriggersDeps, type TriggerSettings } from "../../src/signals/core-host.ts";
import type { TriggerHttpRequest } from "../../src/signals/host.ts";
import { scriptSandbox } from "../../src/signals/sandbox.ts";
import { sqlStore } from "../../src/signals/store.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

/** The hub around the engine: whether it wants it running (it leads, PIOMIO_PLUGINS is not "none") and its two settings. */
type HubSide = { wanted?: boolean; settings?: Partial<TriggerSettings> };

/** A promise that waits until it is let go. */
function latch() {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

/** `before`: awaited before a core call is answered (a latch holds it). */
function setup(
  hub: HubSide = {},
  fetch?: () => any,
  before?: (method: string) => Promise<void> | undefined,
  pipeline: Pick<CoreTriggersDeps, "gateway" | "quick" | "egress"> = {},
  db = openDb(":memory:"),
) {
  const bus = new EventBus();
  const tools = new ToolRegistry();
  const settingsListeners = new Set<() => void>();
  const calls: Array<{ pluginId: string; method: string; params: any }> = [];
  let wanted = hub.wanted ?? true;
  let current: TriggerSettings = { triggersAllowPrivateUrls: false, triggersWatchTimeoutSec: 30, ...hub.settings };
  /** What the engine's host wrote into the hub settings (the card's carry-over). */
  const updates: Array<Partial<TriggerSettings>> = [];
  /** The hub settings change (Settings, an agent): its listeners hear it, as updateSettings's bus event reaches them. */
  const setSettings = (patch: Partial<TriggerSettings>) => {
    current = { ...current, ...patch };
    for (const cb of [...settingsListeners]) cb();
  };
  const ct = new CoreTriggers({
    db,
    bus,
    tools,
    hubUrl: "http://127.0.0.1:8080",
    ...(fetch ? { fetch } : {}),
    ...pipeline,
    wanted: () => wanted,
    settings: {
      get: () => current,
      update: (patch) => {
        updates.push(patch);
        setSettings(patch);
      },
      onChange: (cb) => {
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
  return { db, bus, tools, ct, calls, settingsListeners, updates, setSettings, setWanted: (w: boolean) => void (wanted = w) };
}

/** A database with the Triggers card's plugins row, its saved settings as the plugin host kept them. */
function cardRow(settings: unknown) {
  const db = openDb(":memory:");
  db.prepare("insert into plugins(id, dir, source, enabled, granted, installed_at, settings) values (?, ?, ?, ?, ?, ?, ?)").run(
    "triggers",
    "/gone/plugins/triggers",
    "builtin",
    1,
    "{}",
    "2026-10-01T00:00:00Z",
    typeof settings === "string" ? settings : JSON.stringify(settings),
  );
  return db;
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
  it("runs on the plugin's storage, with its tools named trigger_* and owned by \"triggers\" as the plugin's were", async () => {
    const s = setup();
    await s.ct.start();
    // Owned by "triggers", as the plugin's were: "always allow", the catalog's uses and the card's tool list go by it.
    expect(triggerTools(s.tools).map((t) => [t.name, t.owner]).sort()).toEqual([
      ["trigger_create", "triggers"],
      ["trigger_delete", "triggers"],
      ["trigger_list", "triggers"],
      ["trigger_run_now", "triggers"],
      ["trigger_runs", "triggers"],
      ["trigger_sources", "triggers"],
      ["trigger_test", "triggers"],
      ["trigger_update", "triggers"],
    ]);
    // A call's own effect and its card's text reach the registry: a script host the trigger did not have is an outside action.
    const create = s.tools.get("trigger_create")!;
    const code = "export default () => {}";
    expect(create.effectOf!({ kind: "event", name: "API", prompt: "Look.", script: { code, hosts: ["api.example.com"] } }, call)).toBe("external");
    expect(create.effectOf!({ kind: "event", name: "API", prompt: "Look.", script: { code } }, call)).toBeUndefined();
    expect(create.describe!({ kind: "event", name: "API", prompt: "Look.", script: { code, hosts: ["api.example.com"] } })).toContain("api.example.com");
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

  it("stops, takes its tools and listeners back, and starts again", async () => {
    const s = setup();
    await s.ct.start();
    expect(s.settingsListeners.size).toBe(1);
    s.ct.stop();
    expect(s.ct.engine).toBeUndefined();
    expect(triggerTools(s.tools)).toEqual([]);
    expect(s.settingsListeners.size).toBe(0);
    expect((await s.ct.http(req({}))).status).toBe(404);
    await s.ct.start();
    expect(s.ct.engine).toBeDefined();
    expect(triggerTools(s.tools)).toHaveLength(8);
    s.ct.stop();
  });

  it("names its tools with the prefix the plugin's card used, which counts the earlier uses", async () => {
    const s = setup();
    await s.ct.start();
    const names = triggerTools(s.tools).map((t) => t.name);
    expect(names).toHaveLength(8);
    for (const n of names) expect(n).toMatch(/^trigger_[a-z_]+$/);
    s.ct.stop();
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

  it("does not run while the hub does not want it (a standby, or PIOMIO_PLUGINS=none), and needs no Triggers card otherwise", async () => {
    const s = setup({ wanted: false });
    expect(s.ct.wanted()).toBe(false);
    await s.ct.start();
    expect(s.ct.engine).toBeUndefined();
    expect(triggerTools(s.tools)).toEqual([]);
    expect(s.settingsListeners.size).toBe(0);
    s.setWanted(true);
    await s.ct.start();
    expect(s.ct.engine).toBeDefined();
    s.ct.stop();
  });

  it("hands the hub's trigger settings to the engine, now and when they change", async () => {
    const s = setup({ settings: { triggersAllowPrivateUrls: true } });
    await s.ct.start();
    expect(s.ct.engine!.settings).toEqual({ allowPrivateUrls: true, watchTimeoutSec: 30 });
    s.setSettings({ triggersAllowPrivateUrls: false, triggersWatchTimeoutSec: 10 });
    expect(s.ct.engine!.settings).toEqual({ allowPrivateUrls: false, watchTimeoutSec: 10 });
    s.ct.stop();
    // Stopped, it hears nothing more.
    expect(s.settingsListeners.size).toBe(0);
  });

  it("carries the Triggers card's saved settings over into the hub settings once, recorded in meta", async () => {
    const s = setup({}, undefined, undefined, {}, cardRow({ allowPrivateUrls: true, watchTimeoutSec: 500 }));
    await s.ct.start();
    // Out of range, as the engine read it: at most 120 seconds.
    expect(s.updates).toEqual([{ triggersAllowPrivateUrls: true, triggersWatchTimeoutSec: 120 }]);
    expect(s.ct.engine!.settings).toEqual({ allowPrivateUrls: true, watchTimeoutSec: 120 });
    expect(s.db.prepare("select value from meta where key = ?").get(TRIGGERS_CARRIED)).toBeTruthy();
    // The card's row is left as it was.
    const row = s.db.prepare("select settings from plugins where id = 'triggers'").get() as { settings: string };
    expect(JSON.parse(row.settings)).toEqual({ allowPrivateUrls: true, watchTimeoutSec: 500 });
    s.ct.stop();
    // Changed in the hub settings since: a later start carries nothing over again.
    s.setSettings({ triggersAllowPrivateUrls: false });
    await s.ct.start();
    expect(s.updates).toHaveLength(1);
    expect(s.ct.engine!.settings.allowPrivateUrls).toBe(false);
    s.ct.stop();
  });

  it("carries over only what the card saved and the hub can use, and records it even when that is nothing", async () => {
    const junk = setup({}, undefined, undefined, {}, cardRow({ allowPrivateUrls: "yes", watchTimeoutSec: 0 }));
    await junk.ct.start();
    expect(junk.updates).toEqual([]);
    expect(junk.ct.engine!.settings).toEqual({ allowPrivateUrls: false, watchTimeoutSec: 30 });
    expect(junk.db.prepare("select 1 from meta where key = ?").get(TRIGGERS_CARRIED)).toBeTruthy();
    junk.ct.stop();
    // The same as the hub has: nothing to write.
    const same = setup({}, undefined, undefined, {}, cardRow({ allowPrivateUrls: false, watchTimeoutSec: 30 }));
    await same.ct.start();
    expect(same.updates).toEqual([]);
    same.ct.stop();
    // A number as text, as the engine read it, and the other key left alone.
    const text = setup({}, undefined, undefined, {}, cardRow({ watchTimeoutSec: "45" }));
    await text.ct.start();
    expect(text.updates).toEqual([{ triggersWatchTimeoutSec: 45 }]);
    text.ct.stop();
    // A row that is not JSON, and no card at all: nothing carried, the start goes on.
    for (const s of [setup({}, undefined, undefined, {}, cardRow("not json")), setup()]) {
      await s.ct.start();
      expect(s.updates).toEqual([]);
      expect(s.ct.engine).toBeDefined();
      expect(s.db.prepare("select 1 from meta where key = ?").get(TRIGGERS_CARRIED)).toBeTruthy();
      s.ct.stop();
    }
  });

  it("carries over even while it does not run, so the Settings page shows the card's values", async () => {
    const s = setup({ wanted: false }, undefined, undefined, {}, cardRow({ allowPrivateUrls: true }));
    await s.ct.start();
    expect(s.ct.engine).toBeUndefined();
    expect(s.updates).toEqual([{ triggersAllowPrivateUrls: true }]);
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
    expect(triggerTools(s.tools)).toHaveLength(8);
    s.ct.stop();
  });

  it("a stop while it starts cuts off what the start still does: no engine, no tools, no listeners, no writes", async () => {
    const held = latch();
    const s = setup({}, undefined, (m) => (m === "settings.get" ? held.wait : undefined));
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
    const s = setup({ settings: { triggersAllowPrivateUrls: true } }, () => ({
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
    const s = setup({}, () => {
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
    const s = setup({}, () => {
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
    kv.set("runs:t_bad", [{ at: "x" }]);
    kv.set("runs:t_old", [{ id: "r_old", at: new Date().toISOString(), reason: "schedule", status: "started" }]);
    await s.ct.start();
    const store = (s.ct.engine as any).ctx.store;
    expect(store.runs("t_old").map((r: { id: string }) => r.id)).toEqual(["r_old"]);
    expect(kv.list("runs:").map((r) => r.key)).toEqual(["runs:t_bad"]);
    expect((s.db.prepare("select count(*) as n from trigger_runs").get() as { n: number }).n).toBe(1);
    s.ct.stop();
    expect(() => store.runs("t_old")).toThrow(/stopped/);
    expect(() => store.stateSet("t_old", "k", 1)).toThrow(/stopped/);
    expect(() => store.addNote({ agentId: "a", triggerId: "t", triggerName: "T", text: "x", signalIds: [], external: false })).toThrow(/stopped/);
  });
  it("gives a trigger's script its agent's read tools, the quick model and an egress token of each run's own", async () => {
    const reads: unknown[] = [];
    const tokens: Array<{ owner: string; allow: string[]; context: unknown; revoked: boolean }> = [];
    const s = setup({}, undefined, undefined, {
      gateway: {
        callRead: async (as, name, input) => {
          reads.push({ as, name, input });
          return { content: [{ type: "text", text: "42 open" }], _meta: { taint: true } };
        },
      },
      quick: { ask: async () => ({ text: '{"decision":"note","why":"worth keeping","summary":"42 open issues"}', ref: "fake@local" }) },
      egress: {
        proxy: {
          issueToken: (owner: string, allow: string[], ...rest: unknown[]) => {
            tokens.push({ owner, allow, context: rest[0], revoked: false });
            return `tok${tokens.length}`;
          },
          revoke: (token: string) => void (tokens[Number(token.slice(3)) - 1].revoked = true),
        },
        port: 1,
      },
    });
    const kv = pluginKv(s.db, "triggers");
    kv.set("initialized", true);
    kv.set("trigger:t_hook", {
      id: "t_hook", kind: "event", name: "Issues", prompt: "Look.", agentId: "assistant", enabled: true, maxRunsPerDay: 24,
      createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", createdBy: "user", secret: "s3cret", report: false, state: {},
      script: { code: `export default async (s, pio) => ({ triage: (await pio.tools.call("issues_count", {})).text })`, hosts: ["api.example.com"] },
      triage: { brief: "many open issues" }, triagePerDay: 10,
    });
    await s.ct.start();
    try {
      const hook = await s.ct.http(req({ method: "POST", path: "/t_hook", headers: { "x-piomio-secret": "s3cret" }, body: { a: 1 }, public: true }));
      // Answered at once; the script, the quick check and the note follow.
      expect(hook).toMatchObject({ status: 202, body: { ok: true, signalId: expect.any(String) } });
      await s.ct.engine!.pipeline.idle();
      expect(reads).toEqual([{ as: { agentId: "assistant", triggerId: "t_hook", hosts: ["api.example.com"] }, name: "issues_count", input: {} }]);
      // The run's own token: owned by the trigger, its hosts only, no session context (nothing may raise a network card), gone after the run.
      expect(tokens).toEqual([{ owner: "trigger:t_hook", allow: ["api.example.com"], context: undefined, revoked: true }]);
      expect(sqlStore(s.db).notes({ triggerId: "t_hook" })).toMatchObject([{ text: "42 open issues", external: true }]);
      expect(s.calls.some((c) => c.method === "tasks.create")).toBe(false);
      // A run's token still out when the engine stops goes with it.
      s.ct.engine!.ctx.pipeline!.fetchFor("t_hook", ["api.example.com"]);
      expect(tokens[1]).toMatchObject({ owner: "trigger:t_hook", revoked: false });
    } finally {
      s.ct.stop();
      scriptSandbox.stop();
    }
    expect(tokens[1].revoked).toBe(true);
  });
});
