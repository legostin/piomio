// Host permissions share the hub's cards/audit, but never its external-action rules.
import { isIP } from "node:net";
import type { ApprovalService } from "./approvals.ts";
import type { Settings } from "./settings.ts";
import type { Store } from "./store.ts";
import type { AuditLog } from "./audit.ts";
import type { AgentRegistry } from "./agents.ts";
import { agentName } from "./agents.ts";
import { hubLocale, t } from "./i18n.ts";
import { networkPattern, type EgressProxy, type NetworkRequest } from "./egress.ts";

export function wireNetworkApprovals(d: {
  egress: EgressProxy; approvals: ApprovalService; settings: Settings; store: Store; audit: AuditLog;
  agents?: AgentRegistry; timeoutMs?: number;
  note?: (request: NetworkRequest, message: string) => void;
}): void {
  const { approvals, settings, audit, store } = d;
  // Sockets cannot survive a restart. Old network cards must not grant access after their request has gone.
  const stale = approvals.db.prepare("select id from approvals where status = 'pending' and tool = 'hub_network_request'").all() as { id: string }[];
  for (const a of stale) approvals.expire(a.id);
  approvals.onNetworkRemember = (a) => {
    const host = networkPattern(a.ask?.host ?? "");
    if (host.startsWith("*.")) throw new Error("A network card may authorize only its exact destination");
    const current = settings.get().brainEgressAllow;
    settings.update({ brainEgressAllow: [...new Set([...current, host])] });
    audit.append("user", "egress.allow.always", host, { approvalId: a.id, sessionId: a.sessionId, port: a.ask?.port });
    approvals.bus.emit("settings.updated", { keys: ["brainEgressAllow"] });
  };
  approvals.bus.on("task.updated", (task) => {
    if (["done", "failed", "cancelled"].includes(task.status)) d.egress.endTask(task.id);
  });
  d.egress.requestApproval = async (r: NetworkRequest) => {
    const session = store.getSession(r.sessionId);
    if (!session || session.status !== "active" || session.agentId !== r.agentId || session.conversationId !== r.conversationId || session.taskId !== r.taskId)
      throw new Error("Network permission session is no longer available");
    if (r.signal.aborted) throw new Error("Network permission request cancelled");
    const agent = d.agents?.get(r.agentId);
    const task = r.taskId ? store.getTask(r.taskId) : undefined;
    if (r.taskId && (!task || ["done", "failed", "cancelled"].includes(task.status))) throw new Error("Network permission task is no longer running");
    const approval = approvals.create({
      sessionId: r.sessionId, conversationId: r.conversationId, taskId: r.taskId, agentId: r.agentId,
      tool: "hub_network_request", input: { host: r.host, port: r.port },
      summary: t("network.ask", { host: r.host, port: r.port }),
      ask: { kind: "network", detail: `${r.host}:${r.port}`, host: r.host, port: r.port, ipLiteral: !!isIP(r.host),
        agent: agent ? agentName(agent, hubLocale()) : r.agentId, ...(task ? { task: task.title } : {}) },
      effect: "read", tainted: session.tainted,
    });
    if (r.taskId && ["done", "failed", "cancelled"].includes(store.getTask(r.taskId)?.status ?? "cancelled")) {
      approvals.expire(approval.id);
      throw new Error("Network permission task is no longer running");
    }
    if (task?.status === "running") store.updateTask(task.id, { status: "waiting_approval" });
    const abort = () => approvals.expire(approval.id);
    r.signal.addEventListener("abort", abort, { once: true });
    if (r.signal.aborted) abort();
    try {
      const outcome = await approvals.wait(approval.id, d.timeoutMs ?? 90_000);
      if (outcome === "timeout") approvals.expire(approval.id);
      const cancelled = r.signal.aborted;
      audit.append(`agent:${r.agentId}`, "egress.decision", r.host, { approvalId: approval.id, port: r.port, sessionId: r.sessionId, outcome: cancelled ? "cancelled" : outcome });
      if (outcome !== "approved" || cancelled) {
        const why = cancelled ? "request cancelled" : outcome === "timeout" ? "user did not answer in time" : "user declined";
        const message = `Host ${r.host}:${r.port} is not allowed: ${why}`;
        if (!cancelled) d.note?.(r, `[System] Network permission: ${message}. Tell the person this outcome. Do not retry a declined destination through another route.`);
        throw new Error(message);
      }
    } finally {
      r.signal.removeEventListener("abort", abort);
      if (r.taskId && store.getTask(r.taskId)?.status === "waiting_approval" && !approvals.db.prepare("select 1 from approvals where task_id = ? and status = 'pending' limit 1").get(r.taskId))
        store.updateTask(r.taskId, { status: "running" });
    }
  };
}
