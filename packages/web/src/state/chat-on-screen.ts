// The chat the person is looking at, for plugins (ui.chat.current()): a live view open over a chat asks whose it is
// (the browser's Teach is a lesson for that agent).

import { useEffect } from "react";
import type { ChatOnScreen } from "@piomio/ui";

let shown: ChatOnScreen | undefined;

export const chatOnScreen = (): ChatOnScreen | undefined => shown;

/** A chat came on screen; the function returned is for when it leaves (a chat shown since then stays). */
export function showChat(chat: ChatOnScreen): () => void {
  shown = chat;
  return () => {
    if (shown === chat) shown = undefined;
  };
}

/** While the page is mounted its chat is the one on screen. `agentId`: the agent whose own dialog it is. */
export function useChatOnScreen(conversationId: string | undefined, agentId?: string): void {
  useEffect(() => (conversationId ? showChat({ conversationId, ...(agentId ? { agentId } : {}) }) : undefined), [conversationId, agentId]);
}
