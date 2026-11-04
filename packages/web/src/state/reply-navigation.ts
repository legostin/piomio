import { loadOlder, messages } from "./app";
import { Emitter } from "../lib/store";

export const messageJumps = new Emitter<{ conversationId: string; active: boolean }>();

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Keep the history contiguous so normal pagination and the scroll position still work. */
export async function jumpToMessage(conversationId: string, messageId: string): Promise<boolean> {
  messageJumps.emit({ conversationId, active: true });
  try {
    while (true) {
      const cur = messages.get()[conversationId];
      if (!cur || cur.messages.some((m) => m.id === messageId) || !cur.hasMore) break;
      if (cur.loadingOlder) {
        await new Promise<void>((resolve) => {
          const off = messages.subscribe(() => {
            if (!messages.get()[conversationId]?.loadingOlder) { off(); resolve(); }
          });
        });
      } else {
        await loadOlder(conversationId);
        if (messages.get()[conversationId]?.messages[0]?.id === cur.messages[0]?.id) break;
      }
    }
    await frame();
    const el = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (!el) return false;
    el.scrollIntoView({ behavior: "instant", block: "center" });
    el.classList.remove("reply-flash");
    void el.offsetWidth;
    el.classList.add("reply-flash");
    await frame();
    return true;
  } finally {
    messageJumps.emit({ conversationId, active: false });
  }
}
