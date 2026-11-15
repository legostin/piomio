// Things are made and set up in the chat (CLAUDE.md, "Interface"). "New channel" and "Add agent" open a short setup
// chat where the agent has already asked its first question; the chat becomes what it made. Other requests go to the
// right agent's dialog in the person's words.
import type { Conversation, SetupPurpose } from "@piomio/shared";
import { useLocation } from "wouter";
import { api, errorText } from "../lib/api";
import { agentPath } from "../lib/team";
import { conversations, refreshTeam, sendMessage, session, team } from "./app";
import { closePanel } from "./panel";
import { toast } from "./toast";

/** A new setup chat ("New channel", "Add agent"), opened. */
export async function startSetup(purpose: SetupPurpose, navigate: (path: string) => void): Promise<void> {
  const c = await api.post<Conversation>("/api/setup-chats", { purpose });
  conversations.set((list) => (list.some((x) => x.id === c.id) ? list : [c, ...list]));
  navigate(`/chat/${encodeURIComponent(c.id)}`);
}

/** Where a setup chat that made something leads: the channel, or the new agent's dialog. */
export function entityPath(c: Pick<Conversation, "kind" | "purpose" | "entity">, defaultAgent: string | undefined): string | undefined {
  if (c.kind !== "setup" || !c.entity) return undefined;
  return c.purpose === "feed" ? `/channels/${encodeURIComponent(c.entity)}` : agentPath(c.entity, defaultAgent);
}

/** Opens `agentId`'s dialog (the default agent's without one) and sends `text` there as the person. */
export async function askInChat(agentId: string | undefined, text: string, navigate: (path: string) => void): Promise<void> {
  const s = session.get();
  const id = agentId ?? s?.defaultAgent;
  if (!id) return;
  const members = team.get() ?? (await refreshTeam()) ?? [];
  navigate(agentPath(id, s?.defaultAgent));
  const member = members.find((m) => m.agentId === id);
  if (member) await sendMessage(member.conversationId, text);
}

/**
 * For a section of the settings panel: `ask(text, agentId)` opens that agent's dialog (the default agent's without one)
 * with `text` as the person's words; the panel steps aside where it covers the chat (below 1280px).
 */
export function useAsk(): (text: string, agentId?: string) => void {
  const [, navigate] = useLocation();
  return (text, agentId) => {
    if (window.matchMedia("(max-width: 1279px)").matches) closePanel();
    askInChat(agentId, text, navigate).catch((e) => toast(errorText(e), "error"));
  };
}
