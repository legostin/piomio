// An agent's question to the person: "open this chat?" or "may I send?". The agent only names what the person said;
// the card it shows finds the chats itself and is answered by the person's tap, so an agent neither opens anything
// nor learns which closed chats exist. The agent hears the answer as a note.

import { randomUUID } from "node:crypto";
import type { PluginContext } from "@piomio/plugin-sdk";
import type { ToolCallContext } from "@piomio/shared";
import type { Account, ChatRow } from "./account.ts";
import type { ChatKind } from "./client.ts";

const KEEP = 50;
const MAX_CANDIDATES = 8;

interface Stored {
  id: string;
  /** The chat's name as the person said it; unset for a request to send. */
  query?: string;
  sending: boolean;
  reason: string;
  status: "pending" | "allowed" | "denied";
  createdAt: string;
  agentId: string;
  conversationId: string;
  taskId?: string;
  /** The chat the person opened. */
  chat?: { id: string; title: string; kind: ChatKind };
}

export interface RequestView {
  id: string;
  query?: string;
  sending: boolean;
  reason: string;
  status: Stored["status"];
  chat?: Stored["chat"];
  /** While pending: the account's chats the name fits, for the person to pick from. */
  candidates: Array<Pick<ChatRow, "id" | "title" | "kind" | "username" | "state">>;
  /** The account is not connected, so nothing can be opened now. */
  offline: boolean;
}

export class RequestError extends Error {
  code: "notFound" | "answered" | "noChat" | "offline";
  constructor(code: RequestError["code"]) {
    super(code);
    this.code = code;
  }
}

export class Requests {
  private ctx: PluginContext;
  private account: Account;

  constructor(ctx: PluginContext, account: Account) {
    this.ctx = ctx;
    this.account = account;
  }

  async create(o: { query?: string; sending: boolean; reason: string; call: ToolCallContext }): Promise<string> {
    const id = randomUUID().slice(0, 13);
    const r: Stored = {
      id,
      ...(o.query ? { query: o.query } : {}),
      sending: o.sending,
      reason: o.reason,
      status: "pending",
      createdAt: new Date().toISOString(),
      agentId: o.call.agentId,
      conversationId: o.call.conversationId,
      ...(o.call.taskId ? { taskId: o.call.taskId } : {}),
    };
    await this.ctx.storage.set(`request:${id}`, r);
    // Old cards stay in their conversations as they were answered; only the newest are kept answerable.
    const all = (await this.ctx.storage.list("request:")).map((x) => x.value as Stored).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const old of all.slice(0, Math.max(0, all.length - KEEP))) await this.ctx.storage.delete(`request:${old.id}`);
    return id;
  }

  private async candidates(r: Stored): Promise<ChatRow[]> {
    if (!r.query || !this.account.connected) return [];
    return (await this.account.chatRows(r.query, 50)).filter((c) => c.canOpen).slice(0, MAX_CANDIDATES);
  }

  private async view_(r: Stored): Promise<RequestView> {
    const candidates = r.status === "pending" ? await this.candidates(r).catch(() => []) : [];
    return {
      id: r.id,
      ...(r.query ? { query: r.query } : {}),
      sending: r.sending,
      reason: r.reason,
      status: r.status,
      ...(r.chat ? { chat: r.chat } : {}),
      candidates: candidates.map((c) => ({ id: c.id, title: c.title, kind: c.kind, ...(c.username ? { username: c.username } : {}), state: c.state })),
      offline: !this.account.connected,
    };
  }

  async view(id: string): Promise<RequestView> {
    const r = await this.ctx.storage.get<Stored>(`request:${id}`);
    if (!r) throw new RequestError("notFound");
    return this.view_(r);
  }

  /** The person's tap. `chatId` picks one of the chats the name fits. */
  async answer(id: string, o: { allow: boolean; chatId?: string }): Promise<RequestView> {
    const r = await this.ctx.storage.get<Stored>(`request:${id}`);
    if (!r) throw new RequestError("notFound");
    if (r.status !== "pending") throw new RequestError("answered");
    let note: string;
    if (!o.allow) {
      r.status = "denied";
      note = r.sending && !r.query ? "The person declined to turn on sending from their Telegram account. Do not ask again unless they bring it up." : "The person declined the Telegram access you asked for. Do not ask again unless they bring it up.";
    } else {
      if (!this.account.connected) throw new RequestError("offline");
      const parts: string[] = [];
      if (r.query) {
        const chat = (await this.candidates(r)).find((c) => c.id === o.chatId);
        if (!chat) throw new RequestError("noChat");
        await this.account.setException(chat, "open");
        r.chat = { id: chat.id, title: chat.title, kind: chat.kind };
        parts.push(`the Telegram chat "${chat.title}" (id ${chat.id}, ${chat.kind}) is now open to agents`);
      }
      if (r.sending) {
        await this.account.setMode("write");
        parts.push("sending from their Telegram account is on (telegram_account_send; each message still waits for their approval)");
      }
      r.status = "allowed";
      note = `The person allowed it: ${parts.join(", and ")}.`;
    }
    await this.ctx.storage.set(`request:${id}`, r);
    try {
      await this.ctx.core.call("conversations.tell", { text: note, conversationId: r.conversationId, agentId: r.agentId, ...(r.taskId ? { taskId: r.taskId } : {}) });
    } catch (e: any) {
      this.ctx.log.warn(`telegram-account: the agent could not be told the answer: ${e?.message ?? e}`);
    }
    return this.view_(r);
  }
}
