// Which chats the agents may see. The person opens kinds of chats (private, groups, channels, bots) and makes
// exceptions for single chats: always open or always closed. Nothing is open until they say so. Every tool, the search
// and the signal go through canRead: a closed chat does not exist for an agent.

import type { ChatKind, TgChat } from "./client.ts";

export const CHAT_KINDS: readonly ChatKind[] = ["private", "group", "channel", "bot"];

export type Mode = "read" | "write";

export interface ChatRef {
  title: string;
  kind: ChatKind;
}

export interface Access {
  /** Kinds of chats the agents may read. */
  kinds: Record<ChatKind, boolean>;
  /** Chats open whatever their kind, by id. */
  open: Record<string, ChatRef>;
  /** Chats closed whatever their kind, by id: this wins over everything. */
  closed: Record<string, ChatRef>;
}

/** Telegram's own service chat: sign-in codes arrive there, so no setting opens it. */
const SERVICE_CHATS = new Set(["777000"]);

/** How many single-chat exceptions are kept. */
export const MAX_EXCEPTIONS = 500;

export function emptyAccess(): Access {
  return { kinds: { private: false, group: false, channel: false, bot: false }, open: {}, closed: {} };
}

/** What storage held, made whole: anything that is not a clear "open" stays closed. */
export function cleanAccess(v: unknown): Access {
  const a = emptyAccess();
  const src = v && typeof v === "object" ? (v as Partial<Access>) : {};
  for (const k of CHAT_KINDS) a.kinds[k] = src.kinds?.[k] === true;
  const refs = (m: unknown): Record<string, ChatRef> => {
    const out: Record<string, ChatRef> = {};
    if (!m || typeof m !== "object") return out;
    for (const [id, r] of Object.entries(m as Record<string, any>).slice(0, MAX_EXCEPTIONS)) {
      if (!/^-?\d{1,20}$/.test(id) || !CHAT_KINDS.includes(r?.kind)) continue;
      out[id] = { title: String(r.title ?? "").slice(0, 200), kind: r.kind };
    }
    return out;
  };
  a.open = refs(src.open);
  a.closed = refs(src.closed);
  for (const id of Object.keys(a.closed)) delete a.open[id];
  return a;
}

export type ChatState = "open" | "closed";
/** Why a chat is open or closed: its kind's switch, the person's exception, or a rule nothing changes. */
export type ChatReason = "kind" | "exception" | "service" | "saved";

export function chatAccess(access: Access, chat: Pick<TgChat, "id" | "kind" | "self">): { state: ChatState; reason: ChatReason } {
  if (SERVICE_CHATS.has(chat.id)) return { state: "closed", reason: "service" };
  if (access.closed[chat.id]) return { state: "closed", reason: "exception" };
  if (access.open[chat.id]) return { state: "open", reason: "exception" };
  // Saved Messages is where people keep notes and passwords for themselves: it opens only by name.
  if (chat.self) return { state: "closed", reason: "saved" };
  return { state: access.kinds[chat.kind] ? "open" : "closed", reason: "kind" };
}

export function canRead(access: Access, chat: Pick<TgChat, "id" | "kind" | "self">): boolean {
  return chatAccess(access, chat).state === "open";
}

/** Whether any setting can open this chat. */
export function canBeOpened(chat: Pick<TgChat, "id">): boolean {
  return !SERVICE_CHATS.has(chat.id);
}

/** The access with one chat's exception set: "open", "closed", or back to what its kind says. */
export function withException(access: Access, chat: Pick<TgChat, "id" | "kind" | "title">, to: ChatState | "default"): Access {
  const next: Access = { kinds: { ...access.kinds }, open: { ...access.open }, closed: { ...access.closed } };
  delete next.open[chat.id];
  delete next.closed[chat.id];
  if (to === "default" || !canBeOpened(chat)) return next;
  const list = to === "open" ? next.open : next.closed;
  if (Object.keys(list).length >= MAX_EXCEPTIONS) throw new Error(`no more than ${MAX_EXCEPTIONS} exceptions`);
  list[chat.id] = { title: chat.title.slice(0, 200), kind: chat.kind };
  return next;
}
