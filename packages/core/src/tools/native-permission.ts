// native_permission: where a CLI brain asks before its own tools reach beyond its folder (native-permissions.ts).
// Claude Code calls it as its permission prompt tool ({tool_name, input}); the Codex brain calls it for the approval
// requests its sandbox raises ("codex.command", "codex.fileChange", "codex.permissions"); the Kimi brain for Kimi's
// permission requests ("kimi.<tool>"). The answer is Claude Code's
// format, a JSON text: {"behavior":"allow","updatedInput":…} or {"behavior":"deny","message":…}. When the person
// has to say yes, the hub shows the same approval card as for an external action and waits for it.
import type { ApprovalAsk, ToolResult } from "@piomio/shared";
import { parseBrainRef, truncate } from "@piomio/shared";
import type { ToolRegistry } from "./registry.ts";
import type { ApprovalService } from "../approvals.ts";
import type { RuleStore } from "../policy/rules.ts";
import type { Store } from "../store.ts";
import type { Settings } from "../settings.ts";
import type { AuditLog } from "../audit.ts";
import type { Redactor } from "../vault/redact.ts";
import type { AgentRegistry } from "../agents.ts";
import type { AutoAction, AutoMode } from "../policy/auto.ts";
import type { EgressGiven, EgressGuard } from "../policy/egress.ts";
import { ruleMatches } from "../policy/engine.ts";
import { t } from "../i18n.ts";
import { agentRoot, classifyClaudeTool, classifyKimiTool, confinement, decideNative, grantFolder, shownPath, simpleCommand, type NativeAction } from "../native-permissions.ts";
import { shownCommand } from "../policy/commands.ts";

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
  /** Auto mode: decides what would ask the person, when the settings say so. */
  auto?: AutoMode;
  /** A machine's name for the reviewer ("local" is this hub's). */
  machineName?: (id: string) => string;
  /** What a tainted session may open on the web without a review (policy/egress.ts), and what the person gave it. */
  egress?: EgressGuard;
  given?: (s: { conversationId: string; taskId?: string }) => EgressGiven;
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

/** What a brain asks about, as an action. */
function classify(tool: string, input: Record<string, unknown>, workspace: string): NativeAction {
  if (tool.startsWith("codex.")) return classifyCodex(tool, input, workspace);
  if (tool.startsWith("kimi.")) return classifyKimiTool(tool.slice(5), input, workspace);
  return classifyClaudeTool(tool, input, workspace);
}

/**
 * Two requests for the same action: the same command or path. What the brain says around it (Claude Code's
 * description, Codex's reason) is new every time it asks.
 */
function actionKey(a: NativeAction, input: unknown): string {
  if (a.kind === "command") return `command:${a.command.trim()}`;
  if (a.kind === "read" || a.kind === "write") return `${a.kind}:${a.path}`;
  // The CLI's prompt for its fetch is new every time; the address is the action.
  if (a.kind === "fetch") return `fetch:${a.url ?? ""}`;
  return `other:${JSON.stringify(input)}`;
}

/** The action for auto mode's reviewer, with why it was not let through at once. */
function autoAction(a: NativeAction, input: unknown, why: string): AutoAction {
  const kind = a.kind === "command" || a.kind === "read" || a.kind === "write" ? a.kind : "tool";
  const effect = a.kind === "fetch" ? ("read" as const) : ("external" as const);
  return { tool: a.tool, input, summary: summary(a), kind, ...(kind === "tool" ? { effect } : {}), ...(a.kind === "command" && a.reason ? { reason: a.reason } : {}), why };
}

function summary(a: NativeAction): string {
  switch (a.kind) {
    case "command":
      return truncate(a.network ? t("native.commandNetwork", { command: a.command, host: a.network }) : t("native.command", { command: a.command }), 300);
    case "read":
      return t("native.read", { path: shownPath(a.path) });
    case "write":
      return t("native.write", { path: shownPath(a.path) });
    case "fetch":
      return a.url ? truncate(t("native.fetch", { url: a.url }), 300) : t("native.other", { tool: a.tool });
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
    case "fetch":
      return { kind: "tool", detail: truncate(a.url ?? a.tool, 2000) };
    default:
      return { kind: "tool", detail: a.tool };
  }
}

export function registerNativePermission(d: NativePermissionDeps): void {
  /** Folders a yes opened for reading, by session: the rest of a repository is read without asking again. */
  const opened = new Map<string, Set<string>>();
  const open = (sessionId: string, a: NativeAction) => {
    const dir = a.kind === "read" ? grantFolder(a.path) : undefined;
    if (dir) opened.set(sessionId, (opened.get(sessionId) ?? new Set()).add(dir));
  };
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
      const given = i.input && typeof i.input === "object" ? (i.input as Record<string, unknown>) : {};
      // Codex runs every command as `zsh -lc '<script>'`: the person's rules, the card and the reviewer see the script.
      const input = tool === "codex.command" && typeof given.command === "string" ? { ...given, command: shownCommand(given.command) } : given;
      const action = classify(tool, input, ctx.workspace);
      const { denyRead } = confinement(d.dataDir, ctx.workspace);
      const own = agentRoot(ctx.workspace);
      const readRoots = [...(own ? [own] : []), ...(opened.get(ctx.sessionId) ?? [])];
      let decided = decideNative(action, { workspace: ctx.workspace, roots: d.roots(), readRoots, denied: denyRead });
      // The CLI's own fetch after outside content: its address may carry data out (policy/egress.ts).
      const urls = action.kind === "fetch" && action.url ? [action.url] : [];
      if (urls.length && d.egress) {
        if (!ctx.tainted) d.egress.opened(ctx.sessionId, urls);
        else if (decided.decision === "allow") {
          const risk = d.egress.check(ctx.sessionId, urls, () => d.given?.(ctx) ?? { texts: [], knownHost: (h) => d.rules.isKnownTarget(h) });
          if (risk) decided = { decision: "ask", reason: risk.why };
        }
        // Only the address: the CLI's prompt about the page names its site, which is not the agent writing it out.
        d.egress.wrote(ctx.sessionId, { url: urls[0] });
      }
      /** The fetch goes out: opening its address again tells nobody anything new. */
      const out = () => {
        if (urls.length) d.egress?.passed(ctx.sessionId, urls);
        return answer({ behavior: "allow", updatedInput: input });
      };

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
        else if (decided.decision === "ask" && rules.some((r) => r.decision === "allow")) {
          decided = { decision: "allow", reason: "allowed by the person's rule" };
          open(ctx.sessionId, action);
        }
      }
      const safe = d.redactor.value(input);
      // The person allowed this very call after auto mode had stopped it.
      const key = actionKey(classify(tool, safe as Record<string, unknown>, ctx.workspace), safe);
      const same = (stored: unknown) => !!stored && typeof stored === "object" && actionKey(classify(tool, stored as Record<string, unknown>, ctx.workspace), stored) === key;
      if (decided.decision === "ask" && d.approvals.takeAllowance(ctx.sessionId, tool, same)) decided = { decision: "allow", reason: "the person allowed it after auto mode stopped it" };
      // Background work of an agent that may only suggest has nobody to ask.
      const agent = d.agents.get(ctx.agentId);
      if (decided.decision === "ask" && ctx.background && (agent?.initiative ?? 0) < 2) decided = { decision: "deny", reason: "background work cannot ask the person" };

      // Auto mode decides instead of a card; what it hands over still gets one.
      if (decided.decision === "ask" && d.auto && d.settings.get().approvalMode !== "ask") {
        const ref = d.store.getSession(ctx.sessionId)?.brainRef;
        const where = { sessionId: ctx.sessionId, conversationId: ctx.conversationId, taskId: ctx.taskId, agentId: ctx.agentId, workspace: ctx.workspace, machine: d.machineName?.(ctx.machineId ?? "local") ?? ctx.machineId ?? "local", ...(ref ? { brain: parseBrainRef(ref).brainId } : {}) };
        const verdict = await d.auto.decide(autoAction(action, safe, decided.reason), where);
        if (verdict.decision === "allow") {
          decided = { decision: "allow", reason: `auto mode: allowed at stage ${verdict.stage}` };
          open(ctx.sessionId, action);
        } else if (verdict.decision === "block") {
          d.audit.append(`agent:${ctx.agentId}`, "native.decision", tool, { sessionId: ctx.sessionId, decision: "deny", reason: `auto mode: ${verdict.rule}`, input: safe });
          d.approvals.block({ sessionId: ctx.sessionId, conversationId: ctx.conversationId, taskId: ctx.taskId, agentId: ctx.agentId, tool, input: safe, summary: summary(action), ask: askOf(action), effect: "external", tainted: ctx.tainted, auto: { rule: verdict.rule, reason: verdict.reason } });
          return answer({ behavior: "deny", message: `Auto mode stopped this: [${verdict.rule}] ${verdict.reason} Find another way that fits what the person asked, or ask them in your reply.` });
        }
      }
      d.audit.append(`agent:${ctx.agentId}`, "native.decision", tool, { sessionId: ctx.sessionId, decision: decided.decision, reason: decided.reason, input: safe });

      if (decided.decision === "allow") return out();
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
        input: safe,
        summary: text,
        ask: askOf(action),
        effect: "external",
        tainted: ctx.tainted,
      });
      if (ctx.taskId) d.store.updateTask(ctx.taskId, { status: "waiting_approval" });
      const outcome = await d.approvals.wait(approval.id, Math.max(WAIT_MS, d.settings.get().approvalInlineWaitSec * 1000));
      if (ctx.taskId) d.store.updateTask(ctx.taskId, { status: "running" });
      if (outcome === "approved") {
        open(ctx.sessionId, action);
        d.auto?.personSaidYes(ctx.sessionId);
        return out();
      }
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
