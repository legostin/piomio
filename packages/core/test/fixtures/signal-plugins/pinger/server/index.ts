// A source for the hub's signal tests: "ping" (subscribe mode) sends one signal for each subscription; "pong" and any
// other type go out when the pinger_emit tool says so.

import type { PluginContext } from "@piomio/plugin-sdk";

export default {
  async activate(ctx: PluginContext) {
    let n = 0;
    ctx.signals.provide("ping", {
      subscribe(sub, emit) {
        n++;
        emit({ word: String(sub.config.word ?? "ping"), n }, { key: sub.id, subject: `ping ${n}` });
        return { stop() {} };
      },
    });
    ctx.tools.register({
      name: "emit",
      description: "Emit a signal of the given type (tests).",
      effect: "read",
      inputSchema: { type: "object", properties: { type: { type: "string" }, data: {} }, required: ["type"] },
      handler: async (input: { type: string; data?: unknown }) => {
        ctx.signals.emit(input.type, input.data ?? {});
        return "sent";
      },
    });
  },
};
