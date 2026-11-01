// native_permission: where a CLI brain asks before its own tools reach beyond its folder (native-permissions.ts).
// Claude Code calls it as its permission prompt tool ({tool_name, input}); the Codex brain calls it for the approval
// requests its sandbox raises ("codex.command", "codex.fileChange", "codex.permissions"); the Kimi brain for Kimi's
// permission requests ("kimi.<tool>"). The answer is Claude Code's
// format, a JSON text: {"behavior":"allow","updatedInput":…} or {"behavior":"deny","message":…}. When the person
// has to say yes, the hub shows the same approval card as for an external action and waits for it.
import type { ApprovalAsk, ToolResult } from "@piomio/shared";
import { truncate } from "@piomio/shared";
import type { ToolRegistry } from "./registry.ts";
import type { ApprovalService } from "../approvals.ts";
import type { RuleStore } from "../policy/rules.ts";
import type { Store } from "../store.ts";
import type { Settings } from "../settings.ts";
import type { AuditLog } from "../audit.ts";
import type { Redactor } from "../vault/redact.ts";
import type { AgentRegistry } from "../agents.ts";
import { ruleMatches } from "../policy/engine.ts";
import { t } from "../i18n.ts";
import { classifyClaudeTool, classifyKimiTool, confinement, decideNative, shownPath, simpleCommand, type NativeAction } from "../native-permissions.ts";

export const NATIVE_PERMISSION_TOOL = "native_permission";
/** How long a brain's question waits for the person: the CLI holds its turn meanwhile. */
const WAIT_MS = 10 * 60_000;

export interface NativePermissionDeps {
  registry: ToolRegistry;
  approvals: ApprovalService;
  rules: RuleStore;
  store: Store;
  settings: Settings;
  audit: AuditLog;
  redactor: Redactor;
  agents: AgentRegistry;
  dataDir: string;
  /** More folders the session's brain may use (Claude Code plugin folders). */
  roots: () => string[];
}

const answer = (o: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** A Codex approval request as an action: the sandbox already let through everything it would. */
function classifyCodex(kind: string, input: Record<string, unknown>, cwd: string): NativeAction {
  if (kind === "codex.command") {
    const net = input.network && typeof input.network === "object" ? (input.network as Record<string, unknown>) : undefined;
    return { kind: "command", tool: kind, command: str(input.command) ?? "", cwd: str(input.cwd) ?? cwd, reason: str(input.reason), network: str(net?.host) };
  }
  if (kind === "codex.fileChange") return { kind: "write", tool: kind, path: str(input.grantRoot) ?? str(input.path) ?? cwd };
  return { kind: "other", tool: kind, input };
}

function summary(a: NativeAction): string {
  switch (a.kind) {
    case "command":
      return truncate(a.network ? t("native.commandNetwork", { command: a.command, host: a.network }) : t("native.command", { command: a.command }), 300);
    case "read":
      return t("native.read", { path: shownPath(a.path) });
    case "write":
      return t("native.write", { path: shownPath(a.path) });
    default:
      return t("native.other", { tool: a.tool });
  }
}

/** What the card says: the command or path as is, and the agent's own reason when it gave one. */
function askOf(a: NativeAction): ApprovalAsk {
  switch (a.kind) {
    case "command":
      return { kind: "command", detail: truncate(a.command, 2000), ...(a.reason ? { reason: truncate(a.reason, 300) } : {}), ...(a.network ? { host: a.network } : {}) };
    case "read":
    case "write":
      return { kind: a.kind, detail: shownPath(a.path) };
    default:
      return { kind: "tool", detail: a.tool };
  }
}

export function registerNativePermission(d: NativePermissionDeps): void {
  d.registry.register(
    {
      name: NATIVE_PERMISSION_TOOL,
      owner: "core",
      description: "Internal: your CLI asks here before its own tools reach beyond your folder. Never call it yourself.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
        required: ["tool_name"],
      },
    },
    async (raw, ctx) => {
      const i = (raw ?? {}) as { tool_name?: unknown; input?: unknown };
      const tool = String(i.tool_name ?? "");
      const input = i.input && typeof i.input === "object" ? (i.input as Record<string, unknown>) : {};
      const action = tool.startsWith("codex.")
        ? classifyCodex(tool, input, ctx.workspace)
        : tool.startsWith("kimi.")
          ? classifyKimiTool(tool.slice(5), input, ctx.workspace)
          : classifyClaudeTool(tool, input, ctx.workspace);
      const { denyRead } = confinement(d.dataDir, ctx.workspace);
      let decided = decideNative(action, { workspace: ctx.workspace, roots: d.roots(), denied: denyRead });

      // The person's own rules: "deny" always wins; "always allow" (from an approval card) answers for them.
      if (decided.decision !== "deny") {
        // A rule for a program ("git push *") covers that program alone, never a script that starts with it; it is
        // matched with a space after the command, so the program without arguments is covered too.
        const command = typeof input.command === "string" ? input.command : "";
        const spaced = { ...input, command: `${command.trim()} ` };
        const rules = d.rules.list().filter((r) => {
          if (!r.conditions.some((c) => c.field === "command" && c.op === "glob")) return ruleMatches(r, tool, ctx.agentId, input);
          return simpleCommand(command) && ruleMatches(r, tool, ctx.agentId, spaced);
        });
        if (rules.some((r) => r.decision === "deny")) decided = { decision: "deny", reason: "denied by the person's rule" };
        else if (decided.decision === "ask" && rules.some((r) => r.decision === "allow")) decided = { decision: "allow", reason: "allowed by the person's rule" };
      }
      // Background work of an agent that may only suggest has nobody to ask.
      const agent = d.agents.get(ctx.agentId);
      if (decided.decision === "ask" && ctx.background && (agent?.initiative ?? 0) < 2) decided = { decision: "deny", reason: "background work cannot ask the person" };
      d.audit.append(`agent:${ctx.agentId}`, "native.decision", tool, { sessionId: ctx.sessionId, decision: decided.decision, reason: decided.reason, input: d.redactor.value(input) });

      if (decided.decision === "allow") return answer({ behavior: "allow", updatedInput: input });
      if (decided.decision === "deny") {
        return answer({ behavior: "deny", message: `Not allowed: ${decided.reason}. Work inside your own folder (${ctx.workspace}), or use the hub's tools for the web.` });
      }

      const text = summary(action);
      const approval = d.approvals.create({
        sessionId: ctx.sessionId,
        conversationId: ctx.conversationId,
        taskId: ctx.taskId,
        agentId: ctx.agentId,
        tool,
        input: d.redactor.value(input),
        summary: text,
        ask: askOf(action),
        effect: "external",
        tainted: ctx.tainted,
      });
      if (ctx.taskId) d.store.updateTask(ctx.taskId, { status: "waiting_approval" });
      const outcome = await d.approvals.wait(approval.id, Math.max(WAIT_MS, d.settings.get().approvalInlineWaitSec * 1000));
      if (ctx.taskId) d.store.updateTask(ctx.taskId, { status: "running" });
      if (outcome === "approved") return answer({ behavior: "allow", updatedInput: input });
      if (outcome === "timeout") {
        // Nothing runs it later: the brain's turn has moved on.
        try {
          d.approvals.resolve(approval.id, "deny", { via: "timeout" });
        } catch {
          /* already answered */
        }
        return answer({ behavior: "deny", message: `The person did not answer in time: ${text}. Ask them in your reply and try again when they say yes.` });
      }
      return answer({ behavior: "deny", message: `The person declined: ${text}.` });
    },
  );
}
