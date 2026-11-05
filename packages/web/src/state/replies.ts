import type { Message } from "@piomio/shared";
import { replyText, type ReplyPart } from "@piomio/shared/replies";
import { createStore } from "../lib/store";

/** Independent drafts: switching chats never sends another chat's reply. */
export const replies = createStore<Record<string, ReplyPart | undefined>>({});
export function selectReply(message: Message, author: string): void {
  if (message.role === "system" || message.status === "streaming" || message.quiet) return;
  replies.set((all) => ({ ...all, [message.conversationId]: { type: "reply_to", messageId: message.id, text: replyText(message), author } }));
}
export function clearReply(conversationId: string, expected?: ReplyPart): void {
  replies.set((all) => {
    if (expected && all[conversationId] !== expected) return all;
    const next = { ...all };
    delete next[conversationId];
    return next;
  });
}
