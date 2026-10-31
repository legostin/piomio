// Repositories for conversations, messages, tasks and brain sessions.

import { createHash, randomBytes } from "node:crypto";
import type { Conversation, Message, MessagePart, Task, TaskStatus } from "@piomio/shared";
import { newId, nowIso, parseThinkingChoice } from "@piomio/shared";
import { json, type Db } from "./db.ts";
import type { EventBus } from "./bus.ts";
import { t } from "./i18n.ts";

export interface SessionRow {
  id: string;
  conversationId: string;
  taskId?: string;
  agentId: string;
  brainRef: string;
  resumeToken?: string;
  tainted: boolean;
  status: "active" | "closed";
  background: boolean;
  createdAt: string;
  updatedAt: string;
}

const convFrom = (r: any): Conversation => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  agentId: r.agent_id,
  ...(r.kind === "group" ? { members: json<string[]>(r.members, [r.agent_id]) } : {}),
  ...(r.purpose ? { purpose: r.purpose } : {}),
  ...(r.entity ? { entity: r.entity } : {}),
  taskId: r.task_id ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const msgFrom = (r: any): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  parts: json<MessagePart[]>(r.parts, []),
  status: r.status,
  agentId: r.agent_id ?? undefined,
  taskId: r.task_id ?? undefined,
  brainRef: r.brain_ref ?? undefined,
  ...(r.model ? { model: r.model } : {}),
  ...(r.effort ? { effort: r.effort } : {}),
  channel: r.channel ?? undefined,
  createdAt: r.created_at,
});

const taskFrom = (r: any): Task => ({
  id: r.id,
  conversationId: r.conversation_id,
  parentConversationId: r.parent_conversation_id ?? undefined,
  parentTaskId: r.parent_task_id ?? undefined,
  agentId: r.agent_id,
  title: r.title,
  goal: r.goal,
  status: r.status,
  brainRef: r.brain_ref ?? undefined,
  createdBy: r.created_by,
  triggerId: r.trigger_id ?? undefined,
  background: !!r.background,
  result: r.result ?? undefined,
  error: r.error ?? undefined,
  resumeAt: r.resume_at ?? undefined,
  question: r.question ?? undefined,
  ...(r.kind === "message" ? { kind: "message" as const } : {}),
  ...(r.from_agent ? { from: r.from_agent } : {}),
  ...(r.tainted ? { tainted: true } : {}),
  ...(r.feed_id ? { feedId: r.feed_id } : {}),
  ...(r.skill ? { skill: r.skill } : {}),
  ...(r.deliver === "report" || r.deliver === "digest" ? { deliver: r.deliver as "report" | "digest" } : {}),
  ...(parseThinkingChoice(json(r.thinking, undefined)) ? { thinking: parseThinkingChoice(json(r.thinking, undefined)) } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const sessionFrom = (r: any): SessionRow => ({
  id: r.id,
  conversationId: r.conversation_id,
  taskId: r.task_id ?? undefined,
  agentId: r.agent_id,
  brainRef: r.brain_ref,
  resumeToken: r.resume_token ?? undefined,
  tainted: !!r.tainted,
  status: r.status,
  background: !!r.background,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class Store {
  db: Db;
  bus: EventBus;
  constructor(db: Db, bus: EventBus) {
    this.db = db;
    this.bus = bus;
  }

  // ---------- conversations ----------

  /** A group's lead is its first member: `agentId` is taken from `members` then. */
  createConversation(c: { kind: Conversation["kind"]; title: string; agentId: string; members?: string[]; taskId?: string; id?: string; purpose?: Conversation["purpose"] }): Conversation {
    const now = nowIso();
    const members = c.kind === "group" ? (c.members?.length ? c.members : [c.agentId]) : undefined;
    const agentId = members ? members[0] : c.agentId;
    const conv: Conversation = {
      id: c.id ?? newId("c_"),
      kind: c.kind,
      title: c.title,
      agentId,
      ...(members ? { members } : {}),
      ...(c.purpose ? { purpose: c.purpose } : {}),
      taskId: c.taskId,
      createdAt: now,
      updatedAt: now,
    };
    // read_at stays empty: everything that arrives in a new conversation is unread until the user looks.
    this.db
      .prepare("insert into conversations(id, kind, title, agent_id, members, task_id, purpose, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)")
      .run(conv.id, conv.kind, conv.title, conv.agentId, members ? JSON.stringify(members) : null, conv.taskId ?? null, c.purpose ?? null, now, now);
    this.bus.emit("conversation.updated", conv);
    return conv;
  }

  /** A setup chat became what it made (a channel, an agent). */
  setEntity(id: string, entity: string): Conversation | undefined {
    this.db.prepare("update conversations set entity = ? where id = ?").run(entity, id);
    const c = this.getConversation(id);
    if (c) this.bus.emit("conversation.updated", c);
    return c;
  }

  getConversation(id: string): Conversation | undefined {
    const r = this.db.prepare("select * from conversations where id = ?").get(id);
    return r ? convFrom(r) : undefined;
  }

  /**
   * The agent's one long-lived dialog with the user, created on first use. The dialog of an install from before
   * per-agent dialogs (id "main") stays with the agent it belongs to, so its history carries on.
   */
  agentConversation(agentId: string): Conversation {
    const r = this.db.prepare("select * from conversations where kind = 'main' and agent_id = ? order by created_at limit 1").get(agentId);
    if (r) return convFrom(r);
    return this.createConversation({ kind: "main", title: agentId, agentId });
  }

  listConversations(limit = 100): Conversation[] {
    return this.db.prepare("select * from conversations order by updated_at desc limit ?").all(limit).map(convFrom);
  }

  /** Every group chat, the latest activity first. */
  listGroups(): Conversation[] {
    return this.db.prepare("select * from conversations where kind = 'group' order by updated_at desc").all().map(convFrom);
  }

  touchConversation(id: string): void {
    this.db.prepare("update conversations set updated_at = ? where id = ?").run(nowIso(), id);
  }

  /** The user has seen the conversation up to `at` (a message's createdAt; default: now). The marker only moves forward. */
  markRead(id: string, at?: string): void {
    const ms = at === undefined ? Date.now() : Date.parse(at);
    if (!Number.isFinite(ms)) return;
    const ts = new Date(Math.min(ms, Date.now())).toISOString();
    this.db.prepare("update conversations set read_at = ? where id = ? and (read_at is null or read_at < ?)").run(ts, id, ts);
  }

  /** Finished messages from the agent or the system after the user's read marker. */
  unreadCount(id: string): number {
    const r = this.db
      .prepare(
        "select count(*) as n from messages m join conversations c on c.id = m.conversation_id " +
          "where m.conversation_id = ? and m.role != 'user' and m.status != 'streaming' and m.created_at > coalesce(c.read_at, '')",
      )
      .get(id) as { n: number };
    return r.n;
  }

  /** New `members` of a group also set its lead (`agentId`), the first of them. */
  updateConversation(id: string, patch: { title?: string; agentId?: string; members?: string[] }): Conversation | undefined {
    if (patch.title !== undefined) this.db.prepare("update conversations set title = ? where id = ?").run(patch.title, id);
    if (patch.members?.length) {
      this.db.prepare("update conversations set members = ?, agent_id = ? where id = ?").run(JSON.stringify(patch.members), patch.members[0], id);
    } else if (patch.agentId !== undefined) this.db.prepare("update conversations set agent_id = ? where id = ?").run(patch.agentId, id);
    const c = this.getConversation(id);
    if (c) this.bus.emit("conversation.updated", c);
    return c;
  }

  // ---------- messages ----------

  addMessage(m: Omit<Message, "id" | "createdAt"> & { id?: string }): Message {
    const msg: Message = { ...m, id: m.id ?? newId("m_"), createdAt: nowIso() };
    this.db
      .prepare("insert into messages(id, conversation_id, role, parts, status, agent_id, task_id, brain_ref, model, effort, channel, created_at) values (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(msg.id, msg.conversationId, msg.role, JSON.stringify(msg.parts), msg.status, msg.agentId ?? null, msg.taskId ?? null, msg.brainRef ?? null, msg.model ?? null, msg.effort ?? null, msg.channel ?? null, msg.createdAt);
    this.touchConversation(msg.conversationId);
    this.bus.emit("message.created", msg);
    return msg;
  }

  updateMessage(id: string, patch: { parts?: MessagePart[]; status?: Message["status"]; brainRef?: string; model?: string }, emit = true): Message | undefined {
    if (patch.parts) this.db.prepare("update messages set parts = ? where id = ?").run(JSON.stringify(patch.parts), id);
    if (patch.status) this.db.prepare("update messages set status = ? where id = ?").run(patch.status, id);
    if (patch.brainRef) this.db.prepare("update messages set brain_ref = ? where id = ?").run(patch.brainRef, id);
    if (patch.model) this.db.prepare("update messages set model = ? where id = ?").run(patch.model, id);
    const m = this.getMessage(id);
    if (m && emit) this.bus.emit("message.updated", m);
    return m;
  }

  getMessage(id: string): Message | undefined {
    const r = this.db.prepare("select * from messages where id = ?").get(id);
    return r ? msgFrom(r) : undefined;
  }

  listMessages(conversationId: string, opts: { limit?: number; before?: string } = {}): Message[] {
    const limit = opts.limit ?? 200;
    const rows = opts.before
      ? this.db.prepare("select * from messages where conversation_id = ? and created_at < ? order by created_at desc limit ?").all(conversationId, opts.before, limit)
      : this.db.prepare("select * from messages where conversation_id = ? order by created_at desc limit ?").all(conversationId, limit);
    return rows.map(msgFrom).reverse();
  }

  /** Whether any message of the conversation has `text` in its parts' JSON (a file's path). */
  messagesMention(conversationId: string, text: string): boolean {
    return !!this.db.prepare("select 1 from messages where conversation_id = ? and instr(parts, ?) > 0 limit 1").get(conversationId, text);
  }

  /** The conversation's first message (a task's goal, a thread's opening message). */
  firstMessage(conversationId: string): Message | undefined {
    const r = this.db.prepare("select * from messages where conversation_id = ? order by created_at, rowid limit 1").get(conversationId);
    return r ? msgFrom(r) : undefined;
  }

  /** Mark leftover streaming messages as errored (after a crash). */
  failStreamingMessages(): void {
    const rows = this.db.prepare("select * from messages where status = 'streaming'").all().map(msgFrom);
    for (const m of rows) {
      this.updateMessage(m.id, { status: "error", parts: [...m.parts, { type: "error", message: t("message.interruptedByRestart") }] }, false);
    }
  }

  // ---------- tasks ----------

  createTask(t: Omit<Task, "id" | "createdAt" | "updatedAt" | "status" | "conversationId"> & { status?: TaskStatus }): Task {
    const id = newId("t_");
    const conv = this.createConversation({ kind: "task", title: t.title, agentId: t.agentId, taskId: id });
    const now = nowIso();
    const task: Task = { ...t, id, conversationId: conv.id, status: t.status ?? "queued", createdAt: now, updatedAt: now };
    this.db
      .prepare(
        "insert into tasks(id, conversation_id, parent_conversation_id, parent_task_id, agent_id, title, goal, status, brain_ref, created_by, trigger_id, background, result, error, resume_at, kind, tainted, from_agent, feed_id, thinking, skill, deliver, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        task.id,
        task.conversationId,
        task.parentConversationId ?? null,
        task.parentTaskId ?? null,
        task.agentId,
        task.title,
        task.goal,
        task.status,
        task.brainRef ?? null,
        task.createdBy,
        task.triggerId ?? null,
        task.background ? 1 : 0,
        null,
        null,
        null,
        task.kind ?? null,
        task.tainted ? 1 : 0,
        task.from ?? null,
        task.feedId ?? null,
        task.thinking ? JSON.stringify(task.thinking) : null,
        task.skill ?? null,
        task.deliver ?? null,
        now,
        now,
      );
    this.bus.emit("task.updated", task);
    return task;
  }

  getTask(id: string): Task | undefined {
    const r = this.db.prepare("select * from tasks where id = ?").get(id);
    return r ? taskFrom(r) : undefined;
  }

  listTasks(opts: { status?: TaskStatus[]; limit?: number } = {}): Task[] {
    const limit = opts.limit ?? 200;
    if (opts.status?.length) {
      const q = `select * from tasks where status in (${opts.status.map(() => "?").join(",")}) order by created_at desc limit ?`;
      return this.db.prepare(q).all(...opts.status, limit).map(taskFrom);
    }
    return this.db.prepare("select * from tasks order by created_at desc limit ?").all(limit).map(taskFrom);
  }

  updateTask(id: string, patch: Partial<Pick<Task, "status" | "brainRef" | "result" | "error" | "resumeAt" | "title" | "question" | "tainted">>): Task | undefined {
    const cols: Record<string, string> = { status: "status", brainRef: "brain_ref", result: "result", error: "error", resumeAt: "resume_at", title: "title", question: "question" };
    for (const [k, col] of Object.entries(cols)) {
      if (k in patch) this.db.prepare(`update tasks set ${col} = ? where id = ?`).run((patch as any)[k] ?? null, id);
    }
    if (patch.tainted !== undefined) this.db.prepare("update tasks set tainted = ? where id = ?").run(patch.tainted ? 1 : 0, id);
    this.db.prepare("update tasks set updated_at = ? where id = ?").run(nowIso(), id);
    const t = this.getTask(id);
    if (t) this.bus.emit("task.updated", t);
    return t;
  }

  // ---------- brain sessions ----------

  createSession(s: { conversationId: string; taskId?: string; agentId: string; brainRef: string; background: boolean; tainted?: boolean }): { row: SessionRow; token: string } {
    const id = newId("s_");
    const token = randomBytes(32).toString("base64url");
    const now = nowIso();
    this.db
      .prepare(
        "insert into sessions(id, conversation_id, task_id, agent_id, brain_ref, resume_token, tainted, status, background, token_hash, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(id, s.conversationId, s.taskId ?? null, s.agentId, s.brainRef, null, s.tainted ? 1 : 0, "active", s.background ? 1 : 0, hashToken(token), now, now);
    return { row: this.getSession(id)!, token };
  }

  /** Issue a fresh MCP token for an existing session (tokens are not stored in plain text). */
  rotateSessionToken(id: string): string {
    const token = randomBytes(32).toString("base64url");
    this.db.prepare("update sessions set token_hash = ?, updated_at = ? where id = ?").run(hashToken(token), nowIso(), id);
    return token;
  }

  getSession(id: string): SessionRow | undefined {
    const r = this.db.prepare("select * from sessions where id = ?").get(id);
    return r ? sessionFrom(r) : undefined;
  }

  sessionByToken(token: string): SessionRow | undefined {
    const r = this.db.prepare("select * from sessions where token_hash = ? and status = 'active'").get(hashToken(token));
    return r ? sessionFrom(r) : undefined;
  }

  activeSession(conversationId: string, agentId: string): SessionRow | undefined {
    const r = this.db
      .prepare("select * from sessions where conversation_id = ? and agent_id = ? and status = 'active' order by created_at desc limit 1")
      .get(conversationId, agentId);
    return r ? sessionFrom(r) : undefined;
  }

  updateSession(id: string, patch: { resumeToken?: string | null; tainted?: boolean; status?: SessionRow["status"]; brainRef?: string }): void {
    if (patch.resumeToken !== undefined) this.db.prepare("update sessions set resume_token = ? where id = ?").run(patch.resumeToken, id);
    if (patch.tainted !== undefined) this.db.prepare("update sessions set tainted = ? where id = ?").run(patch.tainted ? 1 : 0, id);
    if (patch.status) this.db.prepare("update sessions set status = ? where id = ?").run(patch.status, id);
    if (patch.brainRef) this.db.prepare("update sessions set brain_ref = ? where id = ?").run(patch.brainRef, id);
    this.db.prepare("update sessions set updated_at = ? where id = ?").run(nowIso(), id);
  }
}
