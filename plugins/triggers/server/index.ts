// Triggers plugin: schedules, one-off reminders, page watches, webhooks and heartbeat reviews
// that start background tasks for agents.

import type { PluginContext, PluginModule } from "@piomio/plugin-sdk";
import { TriggerEngine } from "./engine.ts";
import { handleHttp } from "./http.ts";
import { registerTools } from "./tools.ts";

let engine: TriggerEngine | undefined;

const plugin: PluginModule = {
  async activate(ctx: PluginContext) {
    const e = new TriggerEngine(ctx);
    engine = e;
    registerTools(ctx, e);
    ctx.http.handle((req) => handleHttp(e, req));
    ctx.events.on("notification.feedback", (n) => {
      void e.onFeedback(n).catch((err) => ctx.log.error(`feedback failed: ${err?.message ?? err}`));
    });
    ctx.events.on("agent.removed", (p: { agentId: string }) => {
      void e.removeAgent(p.agentId).catch((err) => ctx.log.error(`removing ${p.agentId}'s triggers failed: ${err?.message ?? err}`));
    });
    ctx.onSettingsChange((s) => e.updateSettings(s));
    await e.start();
    // Catch-up runs and timers start after activation so the hub is not kept waiting.
    setImmediate(() => void e.boot().catch((err) => ctx.log.error(`boot failed: ${err?.message ?? err}`)));
  },
  deactivate() {
    engine?.stop();
  },
};

export default plugin;
