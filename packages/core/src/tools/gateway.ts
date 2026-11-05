// The single path every tool call takes: agent allowlist → hooks → policy → approval → invoke → redact → taint → audit.

import type { AgentDef, Approval, ToolCallContext, ToolDescriptor, ToolResult } from "@piomio/shared";
import { matchesAny, newId, parseBrainRef, renderTemplate, truncate } from "@piomio/shared";
import type { Store, SessionRow } from "../store.ts";
import type { ToolRegistry } from "./registry.ts";
import type { HookRegistry } from "../hooks.ts";
import type { RuleStore } from "../policy/rules.ts";
import type { ApprovalService } from "../approvals.ts";
import type { AuditLog } from "../audit.ts";
import type { Redactor } from "../vault/redact.ts";
import type { Settings } from "../settings.ts";
import { BACKGROUND_ALWAYS_ALLOWED, decide, SKILL_RUN_TOOLS } from "../policy/engine.ts";
import { checkAsked, type AskedCheck, type PersonWords } from "../policy/asked.ts";
import type { AutoMode } from "../policy/auto.ts";
import { urlsIn, type EgressGiven, type EgressGuard } from "../policy/egress.ts";
import { picturesIn, type Pictures } from "../policy/pictures.ts";
import { NATIVE_PERMISSION_TOOL } from "./native-permission.ts";
import { HUB_TOOL_PREFIX, HUB_TOOLS_FOR_EVERY_AGENT, OWN_CARD_TOOLS } from "./hub-tools.ts";

export interface AgentLookup {
  get(id: string): AgentDef | undefined;
}

export interface GatewayDeps {
  store: Store;
  registry: ToolRegistry;
  hooks: HookRegistry;
  rules: RuleStore;
  approvals: ApprovalService;
  audit: AuditLog;
  redactor: Redactor;
  settings: Settings;
  agents: AgentLookup;
  workspaceFor: (s: SessionRow) => string;
  /** Tools a session's job needs whatever its agent's list says: a channel's run publishes in it (feeds.ts). */
  jobTools?: (s: SessionRow) => string[];
  /** Resolve "%key%" in user-facing tool texts (approval summaries) against the tool owner's messages. */
  localize?: (owner: string, text: string) => string;
  /** The hub's skills: a background task following a taught one (Task.skill) may click and type (PolicyInput.skillRun). */
  skills?: { get(name: string): { taught: boolean } | undefined };
  /** Auto mode: decides what would ask the person, when the settings say so (policy/auto.ts). */
  auto?: AutoMode;
  /** A machine's name for the reviewer ("local" is this hub's). */
  machineName?: (id: string) => string;
  /** What a tainted session may open on the web without a review (policy/egress.ts). */
  egress?: EgressGuard;
  /** Which pictures the hub may fetch when the person sees them (policy/pictures.ts). */
  pictures?: Pictures;
  /**
   * Plugins whose tools drive an app on the hub's own computer (manifest integration.localApp, Blender): a session
   * whose brain runs on another computer does not get them, so its work uses that computer's own app.
   */
  hubOnly?: (owner: string) => boolean;
}

/** How far back the person's words count as asking for an action (ToolSpec.asked): this request, not last week's. */
const ASKED_WINDOW_MS = 3 * 3600_000;

/** Tools every agent has, whatever its tool list: what draws in the person's chat (buttons, maps, pictures, cards, pages) and the team's group chats. */
const SHOW_TOOLS = ["show_choices", "show_map", "show_images", "send_files", "library_find", "library_open", "show_news", "feed_show", "page_create", "page_update", "page_read", "page_list", "page_show", "thinking_show", "profile_show", "group_create", "group_update", "group_archive", "group_delete"];

function textOf(r: ToolResult): string {
  return r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
}

export class ToolGateway {
  d: GatewayDeps;
  constructor(deps: GatewayDeps) {
    this.d = deps;
  }

  private agentFor(s: SessionRow): AgentDef {
    const a = this.d.agents.get(s.agentId);
    if (!a) throw new Error(`unknown agent ${s.agentId}`);
    return a;
  }

  /** Tools this session may see. */
  /** A tool the hub has (the brains' own tools are not). */
  has(name: string): boolean {
    return !!this.d.registry.get(name);
  }

  listFor(s: SessionRow): ToolDescriptor[] {
    const agent = this.agentFor(s);
    const skillRun = this.skillRun(s);
    return this.d.registry.list().filter((t) => this.visible(t, agent, s, skillRun));
  }

  /** A background run of a skill the person taught: its task names a skill that is `taught`. */
  private skillRun(s: SessionRow): boolean {
    if (!s.background || !s.taskId || !this.d.skills) return false;
    const skill = this.d.store.getTask(s.taskId)?.skill;
    return !!skill && !!this.d.skills.get(skill)?.taught;
  }

  private visible(t: ToolDescriptor, agent: AgentDef, s: SessionRow, skillRun = false): boolean {
    // The CLIs' permission prompt (native-permission.ts): theirs only, never on the model's list of an API brain.
    if (t.name === NATIVE_PERMISSION_TOOL) return /^(claude-code|codex)\b/.test(s.brainRef ?? "");
    if (this.d.hubOnly?.(t.owner) && parseBrainRef(s.brainRef).machineId !== "local") return false;
    const job = this.d.jobTools?.(s) ?? [];
    // Saving what the person taught is for whichever agent they showed it to (it always asks on its own card).
    const everyAgent = t.owner === "core" && HUB_TOOLS_FOR_EVERY_AGENT.includes(t.name);
    if (!matchesAny(t.name, agent.tools.length ? agent.tools : ["*"]) && !SHOW_TOOLS.includes(t.name) && !job.includes(t.name) && !everyAgent) return false;
    // Hub administration belongs to the default agent alone (see tools/hub-tools.ts).
    if (t.owner === "core" && t.name.startsWith(HUB_TOOL_PREFIX) && !everyAgent && agent.id !== this.d.settings.get().defaultAgent) return false;
    if (t.availability === "background" && !s.background) return false;
    if (t.availability === "interactive" && s.background) return false;
    if (t.agents?.length && !t.agents.includes(agent.id)) return false;
    if (s.background && agent.initiative < 2 && !(skillRun && SKILL_RUN_TOOLS.test(t.name)) && t.effect !== "read" && !BACKGROUND_ALWAYS_ALLOWED.includes(t.name)) return false;
    return true;
  }

  contextFor(s: SessionRow, callId: string): ToolCallContext {
    return {
      sessionId: s.id,
      conversationId: s.conversationId,
      taskId: s.taskId,
      agentId: s.agentId,
      callId,
      tainted: s.tainted,
      background: s.background,
      workspace: this.d.workspaceFor(s),
      machineId: parseBrainRef(s.brainRef).machineId,
    };
  }

  async call(sessionId: string, name: string, rawInput: unknown, callId = newId("call_")): Promise<ToolResult> {
    const s = this.d.store.getSession(sessionId);
    if (!s) return { content: [{ type: "text", text: "Session not found" }], isError: true };
    const agent = this.agentFor(s);
    const entry = this.d.registry.get(name);
    const skillRun = this.skillRun(s);
    if (!entry || !this.visible(entry.descriptor, agent, s, skillRun)) {
      this.d.audit.append(`agent:${s.agentId}`, "tool.denied", name, { reason: "not available" });
      return { content: [{ type: "text", text: `Tool ${name} is not available to this agent` }], isError: true };
    }
    const ctx = this.contextFor(s, callId);

    // Hooks may block or rewrite the input.
    const hooked = await this.d.hooks.run("tool.before", { tool: name, input: rawInput ?? {}, context: ctx }, (p, r) =>
      r.block ? { blocked: r.block } : r.input !== undefined ? { ...p, input: r.input } : p,
    );
    if (hooked.blocked) {
      this.d.audit.append(`agent:${s.agentId}`, "tool.blocked", name, { reason: hooked.blocked });
      return { content: [{ type: "text", text: `Blocked: ${hooked.blocked}` }], isError: true, _meta: { status: "denied" } };
    }
    const input = hooked.payload.input;
    // What this call does may be less than the tool can (machine_exec of a command that only reads).
    const effect = entry.effectOf?.(input);
    const tool = effect && effect !== entry.descriptor.effect ? { ...entry.descriptor, effect } : entry.descriptor;

    const settings = this.d.settings.get();
    const asked = this.asked(s, tool, input);
    // A read that reaches the web after outside content may carry data out in its address (policy/egress.ts).
    const urls = tool.source && tool.effect !== "external" ? urlsIn(input) : [];
    const egress = s.tainted && urls.length ? this.d.egress?.check(s.id, urls, () => this.egressGiven(s)) : undefined;
    if (!s.tainted && urls.length) this.d.egress?.opened(s.id, urls);
    // Pictures the call would put in front of the person, decided before its own input counts as the agent's writing.
    this.d.pictures?.decide(s, picturesIn(input), () => this.egressGiven(s));
    // The CLI's question carries its own tool's input: native_permission records it once it is answered.
    if (name !== NATIVE_PERMISSION_TOOL) this.d.egress?.wrote(s.id, input);
    const policy = decide(
      { tool, input, agentId: s.agentId, tainted: s.tainted, background: s.background, initiative: agent.initiative, profile: agent.policyProfile, skillRun, asked: asked?.ok, egress: egress?.host },
      this.d.rules.list(),
      (t) => this.d.rules.isKnownTarget(t),
    );
    this.d.audit.append(`agent:${s.agentId}`, "policy.decision", name, { decision: policy.decision, reason: policy.reason, ruleId: policy.ruleId, ...(asked ? { asked: asked.reason } : {}) });

    if (policy.decision === "deny") {
      return { content: [{ type: "text", text: `Denied by policy: ${policy.reason}` }], isError: true, _meta: { status: "denied" } };
    }

    if (policy.decision === "ask") {
      // A call without what the tool requires would only fail after the person's yes on its card: say so at once.
      const missing = missingRequired(tool.inputSchema, input);
      if (missing.length) {
        return {
          content: [{ type: "text", text: `Parameter${missing.length > 1 ? "s" : ""} ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} required. Nothing was done and nobody was asked; call ${name} again with ${missing.length > 1 ? "them" : "it"}.` }],
          isError: true,
        };
      }
      const summary = this.summarize(tool, input);
      const safe = this.d.redactor.value(input);
      // The person allowed this very call after auto mode had stopped it.
      const want = JSON.stringify(safe);
      if (this.d.approvals.takeAllowance(s.id, name, (stored) => JSON.stringify(stored) === want)) return this.execute(s, tool, input, { ...ctx, approved: true });
      // Auto mode decides instead of a card, except for the tools that always show the person their own.
      if (this.d.auto && settings.approvalMode !== "ask" && !OWN_CARD_TOOLS.has(name)) {
        const where = { sessionId: s.id, conversationId: s.conversationId, taskId: s.taskId, agentId: s.agentId, workspace: ctx.workspace, machine: this.d.machineName?.(ctx.machineId) ?? ctx.machineId, brain: parseBrainRef(s.brainRef).brainId };
        const why = policy.egress && egress ? egress.why : policy.reason;
        const verdict = await this.d.auto.decide({ tool: name, input: safe, summary, kind: "tool", effect: tool.effect, why }, where);
        if (verdict.decision === "allow") return this.execute(s, tool, input, { ...ctx, reviewed: true });
        if (verdict.decision === "block") {
          const blocked = this.d.approvals.block({ sessionId: s.id, conversationId: s.conversationId, taskId: s.taskId, agentId: s.agentId, tool: name, input: safe, summary, effect: tool.effect, tainted: s.tainted, auto: { rule: verdict.rule, reason: verdict.reason } });
          return {
            content: [{ type: "text", text: `Auto mode stopped this: [${verdict.rule}] ${verdict.reason} Find another way that fits what the person asked, or ask them in your reply.` }],
            isError: true,
            _meta: { status: "denied", approvalId: blocked.id },
          };
        }
      }
      // A background run of an agent that may only suggest has nobody to show a card to.
      if (policy.egress && s.background && agent.initiative < 2 && !skillRun) {
        return {
          content: [{ type: "text", text: `Denied by policy: ${policy.reason}. Nobody can approve it during a background run: open only the addresses you were given or found in what you read.` }],
          isError: true,
          _meta: { status: "denied" },
        };
      }
      const approval = this.d.approvals.create({
        sessionId: s.id,
        conversationId: s.conversationId,
        taskId: s.taskId,
        agentId: s.agentId,
        tool: name,
        input: safe,
        summary,
        effect: tool.effect,
        tainted: s.tainted,
      });
      // Mark the task as waiting while we hold the call.
      if (s.taskId) this.d.store.updateTask(s.taskId, { status: "waiting_approval" });
      const outcome = await this.d.approvals.wait(approval.id, settings.approvalInlineWaitSec * 1000);
      if (s.taskId) this.d.store.updateTask(s.taskId, { status: "running" });
      if (outcome === "denied") {
        return { content: [{ type: "text", text: `The user declined the action: ${summary}` }], isError: true, _meta: { status: "denied", approvalId: approval.id } };
      }
      if (outcome === "timeout") {
        return {
          content: [
            {
              type: "text",
              text:
                `The action is waiting for the user's approval (approvalId=${approval.id}): ${summary}. ` +
                `Do not repeat the call. End your turn and briefly tell the user the action waits for their approval ` +
                `(they answer on the approval card, in the phone app or in the security console). ` +
                `When the user answers, the system carries out the action itself and sends you the result.`,
            },
          ],
          _meta: { status: "awaiting_approval", approvalId: approval.id },
        };
      }
      this.d.auto?.personSaidYes(s.id);
      const result = await this.execute(s, tool, input, { ...ctx, approved: true });
      this.d.approvals.markExecuted(approval.id, result);
      return result;
    }

    if (policy.asked) {
      // The person's own words were the yes: kept like a card, shown as a quiet line, never waited for.
      const approval = this.d.approvals.record({
        sessionId: s.id,
        conversationId: s.conversationId,
        taskId: s.taskId,
        agentId: s.agentId,
        tool: name,
        input: this.d.redactor.value(input),
        summary: this.summarize(tool, input),
        effect: tool.effect,
        tainted: s.tainted,
        reason: asked!.reason,
      });
      const result = await this.execute(s, tool, input, { ...ctx, approved: true });
      this.d.approvals.markExecuted(approval.id, result);
      return result;
    }

    return this.execute(s, tool, input, policy.ruleId ? { ...ctx, approved: true } : ctx);
  }

  /** Did the person ask for this call in their own words? Only for a tool that says how to tell (ToolSpec.asked) and a call that quotes them. */
  private asked(s: SessionRow, tool: ToolDescriptor, input: unknown): AskedCheck | undefined {
    if (!tool.asked || tool.effect !== "external" || !input || typeof input !== "object" || typeof (input as { asked?: unknown }).asked !== "string") return undefined;
    return checkAsked(tool.asked, input, this.personWords(s));
  }

  /**
   * What the person wrote and sent lately where the session works: its dialog, or the one its task was started from.
   * Only their own messages: a teammate's (agentId set) or a task's goal is not the person speaking.
   */
  personWords(s: Pick<SessionRow, "conversationId" | "taskId">): PersonWords {
    const where = new Set<string>();
    const conv = this.d.store.getConversation(s.conversationId);
    if (conv && conv.kind !== "task" && !conv.taskId) where.add(conv.id);
    let task = s.taskId ? this.d.store.getTask(s.taskId) : undefined;
    for (let depth = 0; task && depth < 6; depth++) {
      const parent = task.parentConversationId ? this.d.store.getConversation(task.parentConversationId) : undefined;
      if (parent && parent.kind !== "task" && !parent.taskId) {
        where.add(parent.id);
        break;
      }
      task = task.parentTaskId ? this.d.store.getTask(task.parentTaskId) : undefined;
    }
    const since = Date.now() - ASKED_WINDOW_MS;
    const texts: string[] = [];
    const files: string[] = [];
    for (const c of where) {
      for (const m of this.d.store.listMessages(c, { limit: 60 })) {
        if (m.role !== "user" || m.agentId || Date.parse(m.createdAt) < since) continue;
        for (const p of m.parts) {
          if (p.type === "text") texts.push(p.text);
          else if (p.type === "attachment") {
            files.push(p.path, p.name);
            if (p.transcript) texts.push(p.transcript);
          }
        }
      }
    }
    return { texts, files };
  }

  /**
   * What the person gave a session to open on the web (policy/egress.ts): their own recent words, the goal of a task
   * that was started before any outside content, and the hosts of actions they approved.
   */
  egressGiven(s: Pick<SessionRow, "conversationId" | "taskId">): EgressGiven {
    const task = s.taskId ? this.d.store.getTask(s.taskId) : undefined;
    return { texts: [...this.personWords(s).texts, ...(task && !task.tainted && task.goal ? [task.goal] : [])], knownHost: (h) => this.d.rules.isKnownTarget(h) };
  }

  /** Run an approved action later (deferred approval). */
  async executeApproved(a: Approval): Promise<ToolResult> {
    const s = this.d.store.getSession(a.sessionId);
    const entry = this.d.registry.get(a.tool);
    if (!s || !entry) return { content: [{ type: "text", text: "The tool or session is no longer available" }], isError: true };
    const result = await this.execute(s, entry.descriptor, a.input, { ...this.contextFor(s, newId("call_")), approved: true });
    this.d.approvals.markExecuted(a.id, result);
    return result;
  }

  private async execute(s: SessionRow, tool: ToolDescriptor, input: unknown, ctx: ToolCallContext): Promise<ToolResult> {
    const entry = this.d.registry.get(tool.name)!;
    let result: ToolResult;
    const started = Date.now();
    if (tool.source) this.d.egress?.passed(s.id, urlsIn(input));
    try {
      result = await entry.invoke(input, ctx);
    } catch (e: any) {
      result = { content: [{ type: "text", text: `Tool error: ${e?.message ?? String(e)}` }], isError: true };
    }
    const after = await this.d.hooks.run("tool.after", { tool: tool.name, input, result, context: ctx }, (p, r) => (r.result ? { ...p, result: r.result } : p));
    result = after.payload.result;

    // Never let vault values reach the model.
    result = {
      ...result,
      content: result.content.map((c) => (c.type === "text" ? { ...c, text: this.d.redactor.text(c.text) } : c)),
    };

    if ((tool.source || result._meta?.taint) && !s.tainted) {
      this.d.store.updateSession(s.id, { tainted: true });
    }
    // Links in what came from outside may be followed without a review (policy/egress.ts).
    if (tool.source || result._meta?.taint) this.d.egress?.read(s.id, textOf(result));
    this.d.audit.append(`agent:${s.agentId}`, "tool.call", tool.name, {
      sessionId: s.id,
      taskId: s.taskId,
      input: truncateDeep(input),
      isError: !!result.isError,
      ms: Date.now() - started,
      output: truncate(textOf(result), 300),
    });
    return result;
  }

  summarize(tool: ToolDescriptor, input: unknown): string {
    const safe = this.d.redactor.value(input);
    const describe = this.d.registry.get(tool.name)?.describe;
    if (describe) {
      try {
        return truncate(describe(safe), 600);
      } catch {
        /* the template below */
      }
    }
    if (tool.approvalSummary) {
      const template = this.d.localize ? this.d.localize(tool.owner, tool.approvalSummary) : tool.approvalSummary;
      return truncate(renderTemplate(template, safe), 300);
    }
    return truncate(`${tool.name} ${JSON.stringify(safe)}`, 300);
  }
}

function truncateDeep(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return truncate(v, 500);
  if (depth > 4) return "…";
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => truncateDeep(x, depth + 1));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v).slice(0, 30)) o[k] = truncateDeep(x, depth + 1);
    return o;
  }
  return v;
}

/** The tool's required parameters the call left out (absent or null; an empty string is a value). */
export function missingRequired(schema: unknown, input: unknown): string[] {
  const required = (schema as { required?: unknown } | undefined)?.required;
  if (!Array.isArray(required)) return [];
  const given = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return required.filter((k): k is string => typeof k === "string" && (given[k] === undefined || given[k] === null));
}
