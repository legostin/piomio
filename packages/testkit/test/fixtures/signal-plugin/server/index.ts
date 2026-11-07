// Signals for the harness tests: a broadcast "tick" from a tool, and providers that emit once per subscription,
// one that takes a while to subscribe, and one provided only when a tool asks.

import type { PluginContext, SignalProvider } from "@piomio/plugin-sdk";

export default {
  async activate(ctx: PluginContext) {
    const stopped = (id: string) => () => void ctx.storage.set(`stopped:${id}`, true);
    const provider = (name: string): SignalProvider => ({
      subscribe(sub, emit) {
        emit({ word: String(sub.config.word ?? name), id: sub.id });
        return { stop: stopped(sub.id) };
      },
    });
    ctx.signals.provide("count", provider("count"));
    ctx.signals.provide("slow", {
      async subscribe(sub, emit) {
        await new Promise((r) => setTimeout(r, 300));
        emit({ word: "slow" });
        return { stop: stopped(sub.id) };
      },
    });
    ctx.tools.register({
      name: "tick",
      description: "Emit a tick (or another type), with data that is not JSON when bad is true.",
      effect: "read",
      inputSchema: { type: "object", properties: { type: { type: "string" }, n: { type: "number" }, bad: { type: "boolean" } } },
      handler: async (input: { type?: string; n?: number; bad?: boolean }) => {
        const data = input.bad ? { n: BigInt(1) } : { n: input.n ?? 0 };
        ctx.signals.emit(input.type ?? "tick", data, { key: `k${input.n ?? 0}`, subject: "a tick" });
        return "sent";
      },
    });
    ctx.tools.register({
      name: "provide_late",
      description: "Provide the late source now.",
      effect: "read",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        ctx.signals.provide("late", provider("late"));
        return "provided";
      },
    });
  },
};
