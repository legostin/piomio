// Approval cards for external actions: create, wait inline, resolve from console/Telegram,
// deferred execution when the user answers after the inline wait timed out.

import { createHmac, randomBytes } from "node:crypto";
import type { Approval, ApprovalAsk, ApprovalStatus, ApprovalVia, AutoBlock, Rule, ToolEffect, ToolResult } from "@piomio/shared";
import { newId, nowIso } from "@piomio/shared";
import { json, type Db } from "./db.ts";
import type { EventBus } from "./bus.ts";
import type { AuditLog } from "./audit.ts";
import type { RuleStore } from "./policy/rules.ts";
import { extractTargets, suggestRule } from "./policy/engine.ts";
import { LocalizedError } from "./i18n.ts";

/**
 * Cards whose yes grants something lasting (a taught skill with its pre-approvals, an always-allow rule): "always"
 * there would let the next one through without the person, so it counts as a single yes.
 */
const NO_STANDING_YES = new Set(["hub_skill_save", "hub_permission_always"]);

const fromRow = (r: any): Approval => ({
  id: r.id,
  sessionId: r.session_id,
  conversationId: r.conversation_id,
  taskId: r.task_id ?? undefined,
  agentId: r.agent_id,
  tool: r.tool,
  input: json(r.input, {}),
  summary: r.summary,
  ...(r.ask ? { ask: json<ApprovalAsk>(r.ask, { kind: "tool", detail: "" }) } : {}),
  effect: r.effect,
  tainted: !!r.tainted,
  status: r.status,
  result: json<ToolResult | undefined>(r.result, undefined),
  createdAt: r.created_at,
  resolvedAt: r.resolved_at ?? undefined,
  resolvedVia: r.resolved_via ?? undefined,
  ...(r.auto ? { auto: json<AutoBlock>(r.auto, { rule: "", reason: "" }) } : {}),
});

export type Decision = "approve" | "deny";


export interface ResolveOptions {
  via: ApprovalVia;
  /** Create an "always allow" rule from this approval. */
  remember?: boolean;
  /** Custom rule conditions (console can edit before saving). */
  rule?: Omit<Rule, "id" | "createdAt" | "createdVia">;
}

type Waiter = (d: "approved" | "denied") => void;

export class ApprovalService {
  db: Db;
  bus: EventBus;
  audit: AuditLog;
  rules: RuleStore;
  private waiters = new Map<string, Waiter[]>();
  private secret: Buffer;
  /** Called when an approval is approved but nobody is waiting inline: the core executes and reports back. */
  onDeferredApproved?: (a: Approval) => Promise<void>;
  onDeferredDenied?: (a: Approval) => Promise<void>;
  /** The person allowed an action auto mode had stopped: the agent hears it may try again. */
  onBlockedAllowed?: (a: Approval) => Promise<void>;
  /** Network permission persists a host, never a tool/action rule. Runs before resolving the card. */
  onNetworkRemember?: (a: Approval) => void;

  constructor(db: Db, bus: EventBus, audit: AuditLog, rules: RuleStore) {
    this.db = db;
    this.bus = bus;
    this.audit = audit;
    this.rules = rules;
    const row = db.prepare("select value from meta where key = 'approval_secret'").get() as { value: string } | undefined;
    if (row) this.secret = Buffer.from(row.value, "base64");
    else {
      this.secret = randomBytes(32);
      db.prepare("insert into meta(key, value) values ('approval_secret', ?)").run(this.secret.toString("base64"));
    }
  }

  create(a: { sessionId: string; conversationId: string; taskId?: string; agentId: string; tool: string; input: unknown; summary: string; ask?: ApprovalAsk; effect: ToolEffect; tainted: boolean }): Approval {
    const approval: Approval = { ...a, id: newId("a"), status: "pending", createdAt: nowIso() };
    if (!a.ask) delete approval.ask;
    this.db
      .prepare(
        "insert into approvals(id, session_id, conversation_id, task_id, agent_id, tool, input, summary, ask, effect, tainted, status, created_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(approval.id, a.sessionId, a.conversationId, a.taskId ?? null, a.agentId, a.tool, JSON.stringify(a.input), a.summary, a.ask ? JSON.stringify(a.ask) : null, a.effect, a.tainted ? 1 : 0, "pending", approval.createdAt);
    this.audit.append(`agent:${a.agentId}`, "approval.create", a.tool, { id: approval.id, summary: a.summary });
    this.bus.emit("approval.created", approval);
    return approval;
  }

  /**
   * An action the person asked for in their own words (ToolSpec.asked): approved by those words, so it is kept like
   * any card (the console, the audit) but never waits, and the chat shows it as a quiet line.
   */
  record(a: { sessionId: string; conversationId: string; taskId?: string; agentId: string; tool: string; input: unknown; summary: string; effect: ToolEffect; tainted: boolean; reason: string }): Approval {
    const at = nowIso();
    const id = newId("a");
    this.db
      .prepare(
        "insert into approvals(id, session_id, conversation_id, task_id, agent_id, tool, input, summary, effect, tainted, status, created_at, resolved_at, resolved_via) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(id, a.sessionId, a.conversationId, a.taskId ?? null, a.agentId, a.tool, JSON.stringify(a.input), a.summary, a.effect, a.tainted ? 1 : 0, "approved", at, at, "request");
    this.rules.addKnownTargets(extractTargets(a.input));
    this.audit.append(`agent:${a.agentId}`, "approval.asked", a.tool, { id, summary: a.summary, reason: a.reason });
    const approval = this.get(id)!;
    this.bus.emit("approval.asked", approval);
    return approval;
  }

  /**
   * An action auto mode stopped (policy/auto.ts): kept like any card (the console, the audit), shown as a quiet line
   * with its reason; the person may still allow it once (resolve), and then the same call goes through (takeAllowance).
   */
  block(a: { sessionId: string; conversationId: string; taskId?: string; agentId: string; tool: string; input: unknown; summary: string; ask?: ApprovalAsk; effect: ToolEffect; tainted: boolean; auto: AutoBlock }): Approval {
    const at = nowIso();
    const id = newId("a");
    this.db
      .prepare(
        "insert into approvals(id, session_id, conversation_id, task_id, agent_id, tool, input, summary, ask, effect, tainted, status, created_at, resolved_at, resolved_via, auto) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(id, a.sessionId, a.conversationId, a.taskId ?? null, a.agentId, a.tool, JSON.stringify(a.input), a.summary, a.ask ? JSON.stringify(a.ask) : null, a.effect, a.tainted ? 1 : 0, "blocked", at, at, "auto", JSON.stringify(a.auto));
    this.audit.append(`agent:${a.agentId}`, "approval.blocked", a.tool, { id, summary: a.summary, rule: a.auto.rule, reason: a.auto.reason });
    const approval = this.get(id)!;
    this.bus.emit("approval.asked", approval);
    return approval;
  }

  /**
   * The person allowed this very call after auto mode stopped it: true once, for the same session and tool and an
   * input `same` takes for it (as stored, redacted), and the allowance is used up.
   */
  takeAllowance(sessionId: string, tool: string, same: (input: unknown) => boolean): boolean {
    const rows = this.db.prepare("select id, input from approvals where session_id = ? and tool = ? and status = 'approved' and auto is not null").all(sessionId, tool) as { id: string; input: string }[];
    const hit = rows.find((r) => {
      try {
        return same(JSON.parse(r.input));
      } catch {
        return false;
      }
    });
    if (!hit) return false;
    this.db.prepare("update approvals set status = 'executed' where id = ?").run(hit.id);
    this.bus.emit("approval.resolved", this.get(hit.id));
    return true;
  }

  get(id: string): Approval | undefined {
    const r = this.db.prepare("select * from approvals where id = ?").get(id);
    return r ? fromRow(r) : undefined;
  }

  list(status?: ApprovalStatus[], limit = 100): Approval[] {
    if (status?.length) {
      return this.db
        .prepare(`select * from approvals where status in (${status.map(() => "?").join(",")}) order by created_at desc limit ?`)
        .all(...status, limit)
        .map(fromRow);
    }
    return this.db.prepare("select * from approvals order by created_at desc limit ?").all(limit).map(fromRow);
  }

  pendingCount(): number {
    return (this.db.prepare("select count(*) as n from approvals where status = 'pending'").get() as { n: number }).n;
  }

  /** Wait for a decision up to timeoutMs. */
  wait(id: string, timeoutMs: number): Promise<"approved" | "denied" | "timeout"> {
    const cur = this.get(id);
    if (cur && cur.status !== "pending") return Promise.resolve(cur.status === "approved" || cur.status === "executed" ? "approved" : "denied");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(id) ?? [];
        this.waiters.set(
          id,
          list.filter((w) => w !== waiter),
        );
        resolve("timeout");
      }, timeoutMs);
      const waiter: Waiter = (d) => {
        clearTimeout(timer);
        resolve(d);
      };
      const list = this.waiters.get(id) ?? [];
      list.push(waiter);
      this.waiters.set(id, list);
    });
  }

  resolve(id: string, decision: Decision, opts: ResolveOptions): Approval {
    const a = this.get(id);
    if (!a) throw new LocalizedError("approval.notFound", undefined, 404);
    if (a.status === "blocked" && decision === "approve") return this.allowBlocked(a, opts.via);
    if (a.status !== "pending") throw new LocalizedError("approval.alreadyResolved", { status: a.status }, 409);
    const status: ApprovalStatus = decision === "approve" ? "approved" : "denied";
    const network = a.ask?.kind === "network";
    if (network && decision === "approve" && opts.remember) {
      if (!this.onNetworkRemember) throw new Error("Network permission service unavailable");
      this.onNetworkRemember(a);
    }
    this.db.prepare("update approvals set status = ?, resolved_at = ?, resolved_via = ? where id = ?").run(status, nowIso(), opts.via, id);
    if (decision === "approve" && !network) {
      this.rules.addKnownTargets(extractTargets(a.input));
      if (opts.remember && !NO_STANDING_YES.has(a.tool)) {
        const base = opts.rule ?? suggestRule(a.tool, a.input, a.agentId);
        const rule = this.rules.create({ ...base, createdVia: opts.via === "telegram" ? "telegram" : "approval" });
        this.audit.append("user", "rule.create", rule.tool, rule);
      }
    }
    this.audit.append("user", "approval.resolve", a.tool, { id, decision, via: opts.via, remember: !!opts.remember });
    const updated = this.get(id)!;
    this.bus.emit("approval.resolved", updated);
    const waiters = this.waiters.get(id) ?? [];
    this.waiters.delete(id);
    if (waiters.length > 0) {
      for (const w of waiters) w(status === "approved" ? "approved" : "denied");
    } else if (network) {
      // A socket may have gone away, or the hub restarted. Never replay a network approval as a tool.
    } else if (status === "approved") {
      void this.onDeferredApproved?.(updated).catch((e) => console.error("[approvals] deferred execution failed", e));
    } else {
      void this.onDeferredDenied?.(updated).catch(() => {});
    }
    return updated;
  }

  /** A live request ended: close its card without scheduling deferred execution. */
  expire(id: string): void {
    const a = this.get(id);
    if (!a || a.status !== "pending") return;
    this.db.prepare("update approvals set status = 'expired', resolved_at = ?, resolved_via = 'timeout' where id = ?").run(nowIso(), id);
    this.audit.append("core", "approval.expire", a.tool, { id });
    const waiters = this.waiters.get(id) ?? [];
    this.waiters.delete(id);
    for (const waiter of waiters) waiter("denied");
    this.bus.emit("approval.resolved", this.get(id));
  }

  /** "Allow" on a line auto mode left: the agent may run that call once (takeAllowance) and hears so. */
  private allowBlocked(a: Approval, via: ApprovalVia): Approval {
    this.db.prepare("update approvals set status = 'approved', resolved_at = ?, resolved_via = ? where id = ?").run(nowIso(), via, a.id);
    this.audit.append("user", "approval.resolve", a.tool, { id: a.id, decision: "approve", via, blocked: true });
    const updated = this.get(a.id)!;
    this.bus.emit("approval.resolved", updated);
    void this.onBlockedAllowed?.(updated).catch(() => {});
    return updated;
  }

  markExecuted(id: string, result: ToolResult): void {
    this.db.prepare("update approvals set status = ?, result = ? where id = ?").run(result.isError ? "failed" : "executed", JSON.stringify(result), id);
    this.bus.emit("approval.resolved", this.get(id));
  }

  /** Short signed tokens for channel buttons (Telegram callback_data is limited to 64 bytes). */
  token(id: string, action: Decision): string {
    return createHmac("sha256", this.secret).update(`${id}:${action}`).digest("base64url").slice(0, 16);
  }

  resolveByToken(id: string, action: Decision, token: string, via: "telegram"): Approval {
    if (this.token(id, action) !== token) throw new LocalizedError("approval.badSignature");
    return this.resolve(id, action, { via });
  }

  /** Sign arbitrary short payloads for channel buttons (e.g. notification feedback). */
  sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url").slice(0, 12);
  }

  /** Expire stale approvals; returns those that need a reminder. */
  sweep(expireHours: number): { expired: Approval[]; remind: Approval[] } {
    const pending = this.list(["pending"], 1000);
    const now = Date.now();
    const expired: Approval[] = [];
    const remind: Approval[] = [];
    for (const a of pending) {
      const age = now - Date.parse(a.createdAt);
      if (age > expireHours * 3600_000) {
        this.db.prepare("update approvals set status = 'expired', resolved_at = ?, resolved_via = 'timeout' where id = ?").run(nowIso(), a.id);
        this.audit.append("core", "approval.expire", a.tool, { id: a.id });
        const w = this.waiters.get(a.id) ?? [];
        this.waiters.delete(a.id);
        w.forEach((fn) => fn("denied"));
        expired.push(this.get(a.id)!);
        this.bus.emit("approval.resolved", this.get(a.id));
      } else if (age > 3600_000) {
        const r = this.db.prepare("select reminded from approvals where id = ?").get(a.id) as { reminded: number };
        if (!r.reminded) {
          this.db.prepare("update approvals set reminded = 1 where id = ?").run(a.id);
          remind.push(a);
        }
      }
    }
    return { expired, remind };
  }
}
