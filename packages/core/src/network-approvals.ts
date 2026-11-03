// Host permissions share the hub's cards/audit, but never its external-action rules. In auto mode the reviewer
// answers instead of a card (policy/auto.ts); what it hands over, and every question in "ask" mode, is a card.
import { isIP } from "node:net";
import { parseBrainRef } from "@piomio/shared";
import type { ApprovalService } from "./approvals.ts";
import { BRAIN_MODEL_EGRESS, type Settings } from "./settings.ts";
import type { Store } from "./store.ts";
import type { AuditLog } from "./audit.ts";
import type { AgentRegistry } from "./agents.ts";
import { agentName } from "./agents.ts";
import { hubLocale, t } from "./i18n.ts";
import { networkPattern, type EgressProxy, type NetworkRequest } from "./egress.ts";
import type { AutoMode } from "./policy/auto.ts";

export function wireNetworkApprovals(d: {
  egress: EgressProxy; approvals: ApprovalService; settings: Settings; store: Store; audit: AuditLog;
  agents?: AgentRegistry; timeoutMs?: number;
  note?: (request: NetworkRequest, message: string) => void;
  auto?: AutoMode;
  /** The session's folder and the hub's computer, for the reviewer. */
  workspaceFor?: (request: NetworkRequest) => string;
  machine?: () => string;
}): void {
  const { approvals, settings, audit, store } = d;
  d.egress.tainted = (c) => !!store.getSession(c.sessionId)?.tainted;
  d.egress.ownHosts = BRAIN_MODEL_EGRESS;
  // Sockets cannot survive a restart. Old network cards must not grant access after their request has gone.
  const stale = approvals.db.prepare("select id from approvals where status = 'pending' and tool = 'hub_network_request'").all() as { id: string }[];
  for (const a of stale) approvals.expire(a.id);
  approvals.onNetworkRemember = (a) => {
    // Already on the allowlist: "always" cannot widen it, the once decision stands.
    if (a.ask?.listed) return;
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
    const question = {
      sessionId: r.sessionId, conversationId: r.conversationId, taskId: r.taskId, agentId: r.agentId,
      tool: "hub_network_request", input: { host: r.host, port: r.port },
      summary: t("network.ask", { host: r.host, port: r.port }),
      ask: { kind: "network" as const, detail: `${r.host}:${r.port}`, host: r.host, port: r.port, ipLiteral: !!isIP(r.host),
        agent: agent ? agentName(agent, hubLocale()) : r.agentId, ...(task ? { task: task.title } : {}), ...(r.listed ? { listed: true } : {}) },
      effect: "read" as const, tainted: session.tainted,
    };
    // The person allowed this destination after auto mode had stopped it.
    if (approvals.takeAllowance(r.sessionId, question.tool, (i) => !!i && typeof i === "object" && (i as any).host === r.host && (i as any).port === r.port)) return;
    if (d.auto && settings.get().approvalMode !== "ask") {
      const why = r.listed
        ? `the session has read outside content: what its commands send to ${r.host} leaves this computer`
        : "a host outside the brain allowlist";
      const verdict = await d.auto.decide(
        { tool: question.tool, input: question.input, summary: `connect to ${r.host}:${r.port}`, kind: "read", effect: "read", why },
        { sessionId: r.sessionId, conversationId: r.conversationId, taskId: r.taskId, agentId: r.agentId, workspace: d.workspaceFor?.(r) ?? "", machine: d.machine?.() ?? "local", brain: parseBrainRef(session.brainRef).brainId },
      );
      if (r.signal.aborted) throw new Error("Network permission request cancelled");
      audit.append(`agent:${r.agentId}`, "egress.decision", r.host, { port: r.port, sessionId: r.sessionId, outcome: `auto: ${verdict.decision}` });
      if (verdict.decision === "allow") return;
      if (verdict.decision === "block") {
        approvals.block({ ...question, auto: { rule: verdict.rule, reason: verdict.reason } });
        const message = `Host ${r.host}:${r.port} is not allowed: auto mode stopped it: [${verdict.rule}] ${verdict.reason}`;
        d.note?.(r, `[System] Network permission: ${message} Find another way that fits what the person asked, or ask them in your reply.`);
        throw new Error(message);
      }
    }
    const approval = approvals.create(question);
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
