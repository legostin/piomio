// The hub runs the trigger engine itself: the tools under the card's name, the old webhook address, the card's switch
// and settings, standing down and leading again.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallContext } from "@piomio/shared";
import { freePort } from "@piomio/testkit";
import { Hub, loadConfig } from "../../src/index.ts";
import { listIntegrations, popularIds } from "../../src/integrations.ts";

const fixtures = join(import.meta.dirname, "..", "fixtures");

const until = async <T>(fn: () => T | Promise<T>, what: string, timeoutMs = 8000): Promise<NonNullable<T>> => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("the hub's trigger engine", () => {
  let hub: Hub;
  let base = "";
  const call: ToolCallContext = { sessionId: "s", conversationId: "c", agentId: "assistant", callId: "x", tainted: false, background: false, workspace: tmpdir(), machineId: "local" };

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-triggers-hub-")), builtinPluginsDirs: [join(fixtures, "triggers-card")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    base = config.publicUrl;
    await until(() => hub.triggers.engine, "the trigger engine to start");
  });

  afterAll(async () => {
    await hub?.stop();
  });

  /** Egress tokens the trigger engine's page loads hold. */
  const egressTokens = () => [...((hub.egress as any).grants as Map<string, { owner: string }>).values()].filter((g) => g.owner === "plugin:triggers").length;

  it("has the trigger tools, owned by the Triggers card as the plugin's were", async () => {
    expect(hub.tools.get("trigger_create")?.descriptor.owner).toBe("triggers");
    expect(hub.tools.get("trigger_run_now")?.descriptor.effect).toBe("local-write");
    // The person can still "always allow" them (the hub's own tools cannot be).
    const always = await hub.tools.get("hub_permission_always")!.invoke({ tool: "trigger_update" }, { ...call, approved: true });
    expect((always.content[0] as { text: string }).text).toContain("Allowed: trigger_update runs without approval");
  });

  it("credits the card with its tools' uses in the catalog, on or off", async () => {
    for (let i = 0; i < 3; i++) hub.audit.append("agent:assistant", "policy.decision", "trigger_list", { decision: "allow" });
    expect(popularIds(hub, await listIntegrations(hub, "en"))).toContain("triggers");
    // Off, its tools are gone: their earlier uses are matched by the card's tool prefix.
    await hub.plugins.setEnabled("triggers", false);
    await until(() => !hub.tools.get("trigger_list"), "the tools to go");
    expect(popularIds(hub, await listIntegrations(hub, "en"))).toContain("triggers");
    await hub.plugins.setEnabled("triggers", true);
    await until(() => hub.triggers.engine && hub.tools.get("trigger_list"), "the engine to start again");
  });

  it("answers a webhook at its old address and starts the agent's task", async () => {
    const out = await hub.tools.get("trigger_create")!.invoke({ kind: "event", name: "Deploys", prompt: "Look at the deploy." }, call);
    const text = (out.content[0] as { text: string }).text;
    const id = /trigger (t_[0-9a-f]+)/.exec(text)![1];
    const secret = /Secret: (\S+)/.exec(text)![1];
    expect((await fetch(`${base}/hooks/triggers/${id}`, { method: "POST", headers: { "x-piomio-secret": "wrong" } })).status).toBe(401);
    const r = await fetch(`${base}/hooks/triggers/${id}`, { method: "POST", headers: { "x-piomio-secret": secret, "content-type": "application/json" }, body: JSON.stringify({ build: 42 }) });
    expect(r.status).toBe(202);
    const task = await until(() => hub.store.listTasks({ limit: 50 }).find((t) => t.triggerId === id), "the webhook's task");
    expect(task).toMatchObject({ agentId: "assistant", background: true, createdBy: "trigger" });
    expect(task.goal).toContain("42");
  });

  it("turned on from its card in a chat, tells the agent its tool names", async () => {
    await hub.plugins.setEnabled("triggers", false);
    await until(() => !hub.triggers.engine, "the engine to stop");
    // Signed in as the person, the way the web UI is.
    let cookie = "";
    const api = async (method: string, path: string, body?: unknown, csrf = "") => {
      const r = await fetch(base + path, {
        method,
        headers: { origin: base, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf": csrf } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      cookie = r.headers.get("set-cookie")?.split(";")[0] ?? cookie;
      expect(r.status).toBeLessThan(400);
      return r.json();
    };
    await api("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "triggers-pass-1" });
    const { csrf } = await api("GET", "/api/bootstrap");
    const conv = hub.store.agentConversation("assistant");
    const told = vi.spyOn(hub.runner, "tellAgent").mockImplementation(() => {});
    try {
      await api("POST", "/api/integrations/triggers/enabled", { enabled: true, conversationId: conv.id }, csrf);
      expect(told).toHaveBeenCalledWith(conv.id, expect.stringMatching(/its tools are available now: .*trigger_create/));
    } finally {
      told.mockRestore();
    }
    await until(() => hub.triggers.engine, "the engine to start again");
  });

  it("a settings listener that throws stops neither the others nor the audit line", () => {
    const heard: unknown[] = [];
    const offBad = hub.plugins.onSettings("triggers", () => {
      throw new Error("listener broke");
    });
    const offGood = hub.plugins.onSettings("triggers", (x) => void heard.push(x));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = hub.audit.list({ action: "plugin.settings" }).length;
    try {
      expect(() => hub.plugins.setSettings("triggers", { watchTimeoutSec: 7 })).not.toThrow();
      expect(heard).toEqual([{ watchTimeoutSec: 7 }]);
      expect(hub.triggers.engine!.settings.watchTimeoutSec).toBe(7);
      expect(hub.audit.list({ action: "plugin.settings" }).length).toBe(before + 1);
      expect(err).toHaveBeenCalledWith(expect.stringContaining("listener broke"));
    } finally {
      err.mockRestore();
      offBad();
      offGood();
    }
  });

  it("stops when the hub stands down for another replica and starts again when it leads", async () => {
    await hub.standby();
    expect(hub.triggers.engine).toBeUndefined();
    expect(hub.tools.get("trigger_create")).toBeUndefined();
    expect(egressTokens()).toBe(0);
    expect((await fetch(`${base}/hooks/triggers/t_any`, { method: "POST" })).status).toBe(404);
    // A card change on a standby replica does not start it: only the leader runs triggers.
    hub.bus.emit("plugins.updated", {});
    await new Promise((r) => setTimeout(r, 50));
    expect(hub.triggers.engine).toBeUndefined();
    await hub.lead();
    expect(hub.triggers.engine).toBeDefined();
    expect(hub.tools.get("trigger_create")?.descriptor.owner).toBe("triggers");
    expect(egressTokens()).toBe(1);
  });

  it("follows the card: settings reach the engine, off stops it, on starts it again", async () => {
    hub.plugins.setSettings("triggers", { allowPrivateUrls: true, watchTimeoutSec: 5 });
    expect(hub.triggers.engine!.settings).toEqual({ allowPrivateUrls: true, watchTimeoutSec: 5 });
    expect(egressTokens()).toBe(1);
    await hub.plugins.setEnabled("triggers", false);
    await until(() => !hub.triggers.engine, "the engine to stop");
    expect(hub.tools.get("trigger_create")).toBeUndefined();
    expect((await fetch(`${base}/hooks/triggers/t_any`, { method: "POST" })).status).toBe(404);
    // Its page loads' egress token goes with it, and a new one comes with the next start.
    expect(egressTokens()).toBe(0);
    await hub.plugins.setEnabled("triggers", true);
    await until(() => hub.triggers.engine && hub.tools.get("trigger_create"), "the engine to start again");
    expect(egressTokens()).toBe(1);
  });
});
