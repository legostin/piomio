// A plugin's signals through the SDK runner (ctx.signals): what it emits reaches the "hub" as signals.emit, the hub's
// subscriptions start and stop its providers.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { startPlugin, type PluginHarness } from "../src/index.ts";

const dir = join(import.meta.dirname, "fixtures", "signal-plugin");

const until = async <T>(fn: () => T, what: string, timeoutMs = 5000): Promise<NonNullable<T>> => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("plugin signals", () => {
  let h: PluginHarness;
  beforeAll(async () => {
    h = await startPlugin({ dir });
  });
  afterAll(() => h?.stop());

  it("sends what the plugin emits, and logs what the hub refuses", async () => {
    await h.invokeText("tick", { n: 1 });
    await until(() => h.signals.length === 1, "the tick");
    expect(h.signals).toEqual([{ type: "tick", data: { n: 1 }, key: "k1", subject: "a tick" }]);
    // Not declared: the hub (here the harness, as the hub does) refuses it, and the plugin's log says why.
    await h.invokeText("tick", { type: "nope", n: 2 });
    await until(() => h.logs.find((l) => l.includes("nope") && l.includes("not declared")), "the refusal in the log");
    // Data that is not JSON never leaves the plugin.
    await h.invokeText("tick", { bad: true });
    await until(() => h.logs.find((l) => l.includes("tick") && l.includes("JSON")), "the local refusal in the log");
    expect(h.signals).toHaveLength(1);
  });

  it("refuses what the hub refuses: data against its schema, a subscribe-mode type sent without its subscription", async () => {
    await h.invokeText("tick", { type: "typed", n: 3 });
    await until(() => h.logs.find((l) => l.includes("typed") && l.includes("does not match the declared schema")), "the schema refusal in the log");
    await h.invokeText("tick", { type: "count", n: 4 });
    await until(() => h.logs.find((l) => l.includes("count") && l.includes("subscribe-mode source")), "the subscription refusal in the log");
    expect(h.signals.some((s) => s.type === "typed" || (s.type === "count" && !s.subscription))).toBe(false);
  });

  it("subscribes only as the hub would: a subscribe-mode type, with a config its schema takes", async () => {
    await expect(h.subscribeSignal("count", { word: 5 })).rejects.toThrow(/\/word must be string/);
    await expect(h.subscribeSignal("tick")).rejects.toThrow(/not a subscribe-mode source/);
    await expect(h.subscribeSignal("nope")).rejects.toThrow(/not declared/);
  });

  it("will not start a plugin whose signal declaration the hub refuses, and says why", async () => {
    await expect(startPlugin({ dir: join(import.meta.dirname, "fixtures", "refused-signal-plugin") })).rejects.toThrow(/refused-signals\.code is refused by the hub: its data schema does not compile: .*linear time/);
  });

  it("says in the plugin's log when a subscription waited for a provider that never came", async () => {
    const other = await startPlugin({ dir, provideWaitMs: 200 });
    try {
      const id = await other.subscribeSignal("late");
      await until(() => other.logs.find((l) => l.includes("late") && l.includes("no provider")), "the missing provider in the log");
      // It is still taken once the provider comes.
      await other.invokeText("provide_late");
      await until(() => other.signals.find((s) => s.subscription === id), "the late provider's signal");
    } finally {
      await other.stop();
    }
    // Within the wait, a provider that comes says nothing (the shared harness waits the default 30 s).
    expect(h.logs.some((l) => l.includes("no provider"))).toBe(false);
  });

  it("starts a provider for each subscription, sends its signals by it, and stops it", async () => {
    const id = await h.subscribeSignal("count", { word: "hi" });
    const got = await until(() => h.signals.find((s) => s.subscription === id), "the subscription's signal");
    expect(got).toEqual({ type: "count", data: { word: "hi", id }, subscription: id });
    await h.stopSignal(id);
    await until(() => h.storage.get(`stopped:${id}`), "the provider's stop");
  });

  it("starts a subscription that came before its provider once it is provided", async () => {
    const id = await h.subscribeSignal("late");
    await new Promise((r) => setTimeout(r, 100));
    expect(h.signals.some((s) => s.subscription === id)).toBe(false);
    await h.invokeText("provide_late");
    await until(() => h.signals.find((s) => s.subscription === id), "the late provider's signal");
  });

  it("tells the hub when a provider given later fails a subscription the plugin had taken", async () => {
    const id = await h.subscribeSignal("broken");
    expect(h.signalFailures).toEqual([]);
    await h.invokeText("provide_broken");
    await until(() => h.signalFailures.find((f) => f.id === id), "the failure report");
    expect(h.signalFailures.find((f) => f.id === id)!.error).toContain("the service refused");
    expect(h.logs.some((l) => l.includes("broken") && l.includes("the service refused"))).toBe(true);
    // With its provider there, a failing subscribe is the subscribe's own error.
    await expect(h.subscribeSignal("broken")).rejects.toThrow(/the service refused/);
  });

  it("stops a subscription stopped while its provider was still subscribing, and drops what it sent", async () => {
    const subscribing = h.subscribeSignal("slow", {}, "sub_slow");
    await h.stopSignal("sub_slow");
    expect(await subscribing).toBe("sub_slow");
    await until(() => h.storage.get("stopped:sub_slow"), "the late handle's stop");
    expect(h.signals.some((s) => s.subscription === "sub_slow")).toBe(false);
  });

  it("stops every subscription when the plugin stops", async () => {
    const other = await startPlugin({ dir });
    const id = await other.subscribeSignal("count");
    await until(() => other.signals.find((s) => s.subscription === id), "the signal");
    await other.stop();
    expect(other.storage.get(`stopped:${id}`)).toBe(true);
  });
});
