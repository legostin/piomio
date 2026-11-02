// Policy decisions for tool calls. Pure functions: easy to test, no I/O.

import type { PolicyDecision, Rule, RuleCondition, ToolDescriptor } from "@piomio/shared";
import { globToRegExp, hostMatches, hostOf } from "@piomio/shared";
import { t } from "../i18n.ts";
import { commandRule } from "../native-permissions.ts";

export interface PolicyInput {
  tool: ToolDescriptor;
  input: unknown;
  agentId: string;
  tainted: boolean;
  background: boolean;
  initiative: 0 | 1 | 2;
  profile: string;
  /**
   * A background run of a skill the person taught (Task.skill names a taught one): it may click and type though its
   * agent only suggests; anything external still needs a rule (the skill's pre-approvals) or a card.
   */
  skillRun?: boolean;
  /** The person asked for this call in their own words (policy/asked.ts, checked by the gateway): an external action needs no card. */
  asked?: boolean;
  /** The call opens a web address that may carry data out of a tainted session (policy/egress.ts): its host. */
  egress?: string;
}

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
  ruleId?: string;
  /** Allowed because the person asked for it in their own words: the chat shows a quiet line for it. */
  asked?: boolean;
  /** Asks because the address it opens may carry data out (policy/egress.ts). */
  egress?: boolean;
}

/** What a run of a taught skill may do by itself beyond reading: drive the browser the person showed it in. */
export const SKILL_RUN_TOOLS = /^browser_/;

/** Tools background tasks may always use regardless of effect. */
// memory_remember, memory_write: the nightly reflection is a background task; a remembered or updated fact is local,
// shown and undoable.
export const BACKGROUND_ALWAYS_ALLOWED = ["notify", "task_status", "skill_load", "vault_list", "memory_search", "memory_read", "memory_list", "memory_remember", "memory_write", "feed_post", "feed_sources", "feed_update", "page_create", "page_update"];

function getField(input: unknown, path: string): unknown {
  let v: any = input;
  for (const k of path.split(".")) v = v?.[k];
  return v;
}

/** A finite number, or a string that is just one ("2400", "34.5"); anything else is not an amount. */
function amountOf(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && /^-?\d+(?:\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

export function conditionMatches(c: RuleCondition, input: unknown): boolean {
  const raw = getField(input, c.field);
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.length === 0 || values.every((v) => v === undefined || v === null)) return false;
  return values.every((v) => {
    if (c.op === "max") {
      const n = amountOf(v);
      return n !== undefined && Number.isFinite(c.value) && n <= c.value;
    }
    const s = typeof v === "string" ? v : JSON.stringify(v);
    switch (c.op) {
      case "eq":
        return s === c.value;
      case "glob":
        return globToRegExp(c.value).test(s);
      case "domain": {
        const host = s.includes("@") && !s.includes("/") ? s.split("@").pop()!.toLowerCase() : hostOf(s.includes("://") ? s : `https://${s}`);
        return !!host && (hostMatches(host, c.value) || hostMatches(host, "*." + c.value.replace(/^\*\./, "")));
      }
    }
  });
}

export function ruleMatches(rule: Rule, tool: string, agentId: string, input: unknown): boolean {
  if (!globToRegExp(rule.tool).test(tool)) return false;
  if (rule.agentId && rule.agentId !== agentId) return false;
  return rule.conditions.every((c) => conditionMatches(c, input));
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;
/** Fields that name who a message goes to, whatever they hold (a chat id, a handle, a phone number). */
const RECIPIENT_KEYS = /^(?:to|cc|bcc|recipients?|chat|chat_?id|phone)$/i;

/** Recipients and domains an action reaches: used to decide whether a tainted session may rely on "always" rules. */
export function extractTargets(input: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, recipient = false) => {
    if (typeof v === "string") {
      const emails = v.match(EMAIL_RE) ?? [];
      for (const m of emails) out.add(m.toLowerCase());
      const urls = v.match(URL_RE) ?? [];
      for (const m of urls) {
        const h = hostOf(m);
        if (h) out.add(h);
      }
      if (recipient && !emails.length && !urls.length && v.trim()) out.add(v.trim().toLowerCase());
    } else if (typeof v === "number" && recipient) out.add(String(v));
    else if (Array.isArray(v)) v.forEach((x) => walk(x, recipient));
    else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => walk(x, RECIPIENT_KEYS.test(k)));
  };
  walk(input);
  return [...out];
}

export function decide(p: PolicyInput, rules: Rule[], isKnownTarget: (t: string) => boolean): PolicyResult {
  const { tool, input, agentId } = p;

  for (const r of rules) {
    if (r.decision === "deny" && ruleMatches(r, tool.name, agentId, input)) {
      return { decision: "deny", reason: r.note ? t("policy.deniedByRuleNote", { note: r.note }) : t("policy.deniedByRule"), ruleId: r.id };
    }
  }

  if (p.background && p.initiative < 2 && !(p.skillRun && SKILL_RUN_TOOLS.test(tool.name)) && tool.effect !== "read" && !BACKGROUND_ALWAYS_ALLOWED.includes(tool.name)) {
    return { decision: "deny", reason: t("policy.backgroundReadOnly") };
  }

  // After outside content, a read that opens an address which may carry data out is reviewed like an action.
  if (p.egress && p.tainted && tool.effect !== "external") return allowedByRule() ?? { decision: "ask", reason: t("policy.taintedEgress", { host: p.egress }), egress: true };

  if (tool.effect === "read") return { decision: "allow", reason: t("policy.read") };
  if (tool.effect === "local-write") {
    if (p.profile === "strict") return { decision: "ask", reason: t("policy.strictLocalWrite") };
    // Changes that outlive the session (tool.askWhenTainted) need the user's yes after outside content; a call with no input only reads.
    const changes = !!input && typeof input === "object" && Object.keys(input).length > 0;
    if (p.tainted && changes && tool.askWhenTainted) return allowedByRule() ?? { decision: "ask", reason: t("policy.taintedLastingChange") };
    return { decision: "allow", reason: t("policy.localWrite") };
  }

  // external
  return allowedByRule() ?? (p.asked ? { decision: "allow", reason: t("policy.askedByPerson"), asked: true } : { decision: "ask", reason: t("policy.externalNeedsApproval") });

  /** The person's "always allow" for this kind of call; after outside content it still asks for a target it never saw. */
  function allowedByRule(): PolicyResult | undefined {
    for (const r of rules) {
      if (r.decision === "allow" && ruleMatches(r, tool.name, agentId, input)) {
        if (p.tainted) {
          const unknown = extractTargets(input).filter((t) => !isKnownTarget(t));
          if (unknown.length > 0) {
            return { decision: "ask", reason: t("policy.taintedNewTargets", { targets: unknown.join(", ") }), ruleId: r.id };
          }
        }
        return { decision: "allow", reason: r.note ? t("policy.allowedByRuleNote", { note: r.note }) : t("policy.allowedByRule"), ruleId: r.id };
      }
    }
    return undefined;
  }
}

/** Build a rule that would allow this exact kind of action next time ("always for this"). */
export function suggestRule(tool: string, input: unknown, agentId?: string): Omit<Rule, "id" | "createdAt" | "createdVia"> {
  const conditions: RuleCondition[] = [];
  const targets = extractTargets(input);
  // Prefer narrowing by recipients/domains found in well-known fields.
  // The brains' own tools (native-permission.ts): the exact command or file. The hub's: the machine or replica it is for.
  // A tool that runs other tools by name (composio_tool_run): that tool only, never all it can run.
  const fields = ["to", "recipient", "email", "chat", "chatId", "channel", "url", "domain", "host", "command", "file_path", "notebook_path", "path", "machine", "replica", "tool"];
  for (const f of fields) {
    const v = getField(input, f);
    if (typeof v !== "string" || !v) continue;
    if (f === "command") conditions.push({ field: f, ...commandRule(v) });
    else conditions.push(v.includes("://") ? { field: f, op: "domain", value: hostOf(v) } : { field: f, op: "eq", value: v });
  }
  if (conditions.length === 0 && targets.length === 1) {
    // Fall back to nothing specific: allow the tool for this agent only.
  }
  return { tool, agentId, conditions, decision: "allow" };
}
