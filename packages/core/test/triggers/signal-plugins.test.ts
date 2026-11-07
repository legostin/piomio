// Signals from a plugin through a real hub: the pinger fixture's provider is subscribed for a trigger that listens to
// it, its signal goes through the trigger's pipeline, and what the plugin may not emit is refused.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallContext } from "@piomio/shared";
import { freePort } from "@piomio/testkit";
import { Hub, loadConfig } from "../../src/index.ts";

const fixtures = join(import.meta.dirname, "..", "fixtures");

const until = async <T>(fn: () => T | Promise<T>, what: string, timeoutMs = 15_000): Promise<NonNullable<T>> => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("signals from a plugin", () => {
  let hub: Hub;
  const call: ToolCallContext = { sessionId: "s", conversationId: "c", agentId: "assistant", callId: "x", tainted: false, background: false, workspace: tmpdir(), machineId: "local" };
  const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("\n");
  const invoke = async (name: string, input: unknown) => textOf(await hub.tools.get(name)!.invoke(input, call));

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), PIOMIO_PLUGINS: "triggers,pinger", TZ: "UTC" },
      {
        dataDir: mkdtempSync(join(tmpdir(), "owl-signal-plugins-")),
        builtinPluginsDirs: [join(fixtures, "triggers-card"), join(fixtures, "signal-plugins")],
        builtinAgentsDir: join(fixtures, "agents"),
      },
    );
    hub = new Hub(config);
    await hub.start();
    await until(() => hub.triggers.engine && hub.plugins.get("pinger")?.status === "running", "the engine and the pinger");
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("lists the plugin's sources for the agents, in the person's language on the page", async () => {
    const text = await invoke("trigger_sources", {});
    expect(text).toContain('"type": "pinger.ping"');
    expect(text).toContain('"type": "pinger.pong"');
    expect(hub.sources.list("ru").find((s) => s.type === "pinger.ping")).toMatchObject({ source: "pinger", mode: "subscribe", title: "Пинг", external: true, online: true });
  });

  it("subscribes for a signal trigger, whose script keeps the ping as a note", async () => {
    const out = await invoke("trigger_create", {
      name: "Pings",
      prompt: "Look at the ping.",
      on: [{ type: "pinger.ping", config: { word: "hello" } }],
      script: { code: `export default () => ({ note: "pong" })` },
    });
    const id = /trigger (t_[0-9a-f]+)/.exec(out)![1];
    expect(hub.triggers.engine!.get(id)).toMatchObject({ kind: "signal" });
    const run = await until(async () => (await hub.triggers.engine!.runs(id)).find((r) => r.outcome === "note"), "the ping's note");
    expect(run).toMatchObject({ reason: "signal", status: "started", external: true, signals: [{ type: "pinger.ping", subject: "ping 1" }] });
    expect(hub.triggers.notes({ triggerId: id })).toMatchObject([{ text: "pong", external: true }]);
    // The signal itself, in the journal: what the plugin sent, marked as outside content.
    const signalId = run.signals![0].id;
    expect(hub.triggers.engine!.ctx.store.signal(signalId)).toMatchObject({ type: "pinger.ping", source: "pinger", data: { word: "hello", n: 1 }, external: true });
  });

  it("routes a broadcast to the triggers on its type, and refuses a type the plugin did not declare", async () => {
    const out = await invoke("trigger_create", {
      name: "Pongs",
      prompt: "Look at the pong.",
      on: [{ type: "pinger.pong" }],
      script: { code: `export default (signal) => ({ note: "got " + signal.data.v })` },
    });
    const id = /trigger (t_[0-9a-f]+)/.exec(out)![1];
    expect(await invoke("pinger_emit", { type: "pong", data: { v: 7 } })).toBe("sent");
    const run = await until(async () => (await hub.triggers.engine!.runs(id)).find((r) => r.outcome === "note"), "the pong's note");
    // The source says its signals are not outside content.
    expect(run).toMatchObject({ reason: "signal", external: false });
    expect(hub.triggers.notes({ triggerId: id })).toMatchObject([{ text: "got 7", external: false }]);
    // Undeclared: refused in the plugin's log, the hub's audit names it.
    await invoke("pinger_emit", { type: "nope", data: {} });
    const rec = hub.plugins.get("pinger")!;
    await until(() => rec.logs.find((l) => l.msg.includes("nope") && l.msg.includes("not declared")), "the refusal in the plugin's log");
    expect(hub.audit.list({ action: "plugin.permission-denied" }).some((a) => a.actor === "plugin:pinger" && String(a.target).includes("nope"))).toBe(true);
  });

  it("subscribes again when the plugin restarts", async () => {
    const id = (await hub.triggers.engine!.list()).find((t) => t.name === "Pings")!.id;
    await hub.plugins.restart("pinger");
    // The restarted provider sends its first ping again, with a new subscription: a new delivery key.
    await until(async () => (await hub.triggers.engine!.runs(id)).filter((r) => r.outcome === "note").length >= 2, "the second ping's note");
  });

  it("stops the plugin's subscription when its trigger goes", async () => {
    const id = (await hub.triggers.engine!.list()).find((t) => t.name === "Pings")!.id;
    expect((hub.sources as any).live.size).toBe(1);
    await invoke("trigger_delete", { id });
    await until(() => (hub.sources as any).live.size === 0, "the subscription to stop");
  });
});
