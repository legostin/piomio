// The trigger engine in core (docs/superpowers/specs/2026-11-07-unified-triggers-design.md): schedules, one-off
// reminders, page watches, webhooks and heartbeat reviews that start background tasks for agents. It was the triggers
// plugin; startTriggers is that plugin's activate, on a TriggerHost.

import { TriggerEngine } from "./engine.ts";
import type { TriggerHost } from "./host.ts";
import { handleHttp } from "./http.ts";
import { registerTools } from "./tools.ts";

export async function startTriggers(host: TriggerHost): Promise<TriggerEngine> {
  const e = new TriggerEngine(host);
  registerTools(host, e);
  host.http.handle((req) => handleHttp(e, req));
  host.events.on("notification.feedback", (n) => {
    void e.onFeedback(n).catch((err) => host.log.error(`feedback failed: ${err?.message ?? err}`));
  });
  host.events.on("agent.removed", (p: { agentId: string }) => {
    void e.removeAgent(p.agentId).catch((err) => host.log.error(`removing ${p.agentId}'s triggers failed: ${err?.message ?? err}`));
  });
  host.onSettingsChange((s) => e.updateSettings(s));
  await e.start();
  // Catch-up runs and timers start after this returns, so the hub is not kept waiting.
  setImmediate(() => void e.boot().catch((err) => host.log.error(`boot failed: ${err?.message ?? err}`)));
  return e;
}

export type { TriggerEngine } from "./engine.ts";
export type { TriggerHost, TriggerHttpRequest, TriggerHttpResponse } from "./host.ts";
