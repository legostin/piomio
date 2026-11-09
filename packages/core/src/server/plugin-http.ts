// A plugin's HTTP (its API for the UI and its public webhooks). The triggers plugin's addresses go to the trigger
// engine in core (signals/core-host.ts), which is part of the hub now: /api/plugins/triggers/http/* stays as the alias
// of /api/triggers/* (api.ts), and /hooks/triggers/* is still where webhooks arrive.

import type { Hub } from "../app.ts";
import { TRIGGERS_ID } from "../signals/core-host.ts";
import type { TriggerHttpRequest, TriggerHttpResponse } from "../signals/host.ts";

export function pluginHttp(hub: Pick<Hub, "plugins" | "triggers">, id: string, req: TriggerHttpRequest): Promise<TriggerHttpResponse> {
  return id === TRIGGERS_ID ? hub.triggers.http(req) : hub.plugins.http(id, req);
}

/** Whether public webhooks of this plugin are answered at all. */
export function hasPluginHttp(hub: Pick<Hub, "plugins">, id: string): boolean {
  return id === TRIGGERS_ID || hub.plugins.hasHttp(id);
}
