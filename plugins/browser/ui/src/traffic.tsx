// A line over the page while agents change the browser's traffic (their browser_request_rule / browser_request_change
// rules: blocked requests, replaced answers): what the page shows may not be what the site sent. «Remove» takes
// every rule away.

import { useEffect, useState } from "react";
import { loadAgentNames, send, t, type BrowserState } from "./host.ts";

export function TrafficNote({ traffic }: { traffic: BrowserState["traffic"] }) {
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const ids = [...new Set((traffic ?? []).map((r) => r.agentId))];
  const key = ids.join(",");
  useEffect(() => {
    if (key) void loadAgentNames().then(setNames);
  }, [key]);
  if (!ids.length) return null;
  return (
    <div className="obb-traffic">
      <span className="obb-trunc">{t("ui.traffic.changing", { agent: ids.map((id) => names.get(id) ?? id).join(", ") })}</span>
      <button type="button" onClick={() => send({ type: "traffic.clear" })}>
        {t("ui.traffic.remove")}
      </button>
    </div>
  );
}
