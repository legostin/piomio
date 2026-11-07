// The hub runs the trigger engine itself: core tools, the old webhook address, the card's switch and settings.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallContext } from "@piomio/shared";
import { freePort } from "@piomio/testkit";
import { Hub, loadConfig } from "../../src/index.ts";

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

  it("has the trigger tools as core tools", () => {
    expect(hub.tools.get("trigger_create")?.descriptor.owner).toBe("core");
    expect(hub.tools.get("trigger_run_now")?.descriptor.effect).toBe("local-write");
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

  it("follows the card: settings reach the engine, off stops it, on starts it again", async () => {
    hub.plugins.setSettings("triggers", { allowPrivateUrls: true, watchTimeoutSec: 5 });
    expect(hub.triggers.engine!.settings).toEqual({ allowPrivateUrls: true, watchTimeoutSec: 5 });
    await hub.plugins.setEnabled("triggers", false);
    await until(() => !hub.triggers.engine, "the engine to stop");
    expect(hub.tools.get("trigger_create")).toBeUndefined();
    expect((await fetch(`${base}/hooks/triggers/t_any`, { method: "POST" })).status).toBe(404);
    await hub.plugins.setEnabled("triggers", true);
    await until(() => hub.triggers.engine && hub.tools.get("trigger_create"), "the engine to start again");
  });
});
