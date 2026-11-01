// An agent's long-lived dialog: "/" for the default agent, "/agent/:id" for everyone else on the team.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useStore } from "../../lib/store";
import { agents, conversations, ensureAgents, ensureTeam, keptUnread, markRead, refreshConversations, refreshTeam, session, team, useConversationMessages } from "../../state/app";
import { TopBar } from "../../components/Layout";
import { EmptyState, Spinner } from "../../components/ui";
import { t } from "../../i18n";
import { AgentHeader } from "./AgentHeader";
import { ChatMenu } from "./DetailsToggle";
import { editAgent } from "../../state/panel";
import { ChatView } from "./ChatView";
import { SetupGate } from "../../components/BrainSetupCard";
import { ArchivedBar } from "./AgentMenu";

/** While the dialog is on screen, tell the hub the user has seen it up to the newest finished message. */
export function useReadMarker(conversationId: string | undefined, unread: number): void {
  const conv = useConversationMessages(conversationId);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  const newest = useMemo(() => {
    for (let i = conv.messages.length - 1; i >= 0; i--) if (conv.messages[i].status !== "streaming") return conv.messages[i].createdAt;
    return undefined;
  }, [conv.messages]);
  const sent = useRef("");
  useEffect(() => {
    if (!conversationId || !visible || !newest || unread === 0 || keptUnread(conversationId, newest)) return;
    const key = `${conversationId}|${newest}`;
    if (sent.current === key) return;
    sent.current = key;
    void markRead(conversationId, newest);
  }, [conversationId, visible, newest, unread]);
}

export function AgentPage({ agentId }: { agentId?: string }) {
  const s = useStore(session);
  const list = useStore(agents);
  const members = useStore(team);
  const convs = useStore(conversations);
  useEffect(() => {
    ensureAgents();
    ensureTeam();
  }, []);

  const id = agentId ?? s?.defaultAgent;
  const agent = list?.find((a) => a.id === id);
  const member = members?.find((m) => m.agentId === id);
  const isDefault = !!s && id === s.defaultAgent;
  // An archived agent is off the team listing: its dialog is found among the conversations.
  const archived = !!agent?.archived;
  const archivedDialog = archived ? convs.find((c) => c.kind === "main" && c.agentId === id)?.id : undefined;
  const conversationId = member?.conversationId ?? archivedDialog ?? (isDefault ? s?.mainConversationId : undefined);

  // A newly added agent gets its dialog with the next team listing, an archived one with the next conversations
  // listing (once per agent).
  const asked = useRef<string>(undefined);
  useEffect(() => {
    if (!agent || asked.current === agent.id) return;
    if (agent.archived ? !archivedDialog : members && !member) {
      asked.current = agent.id;
      void (agent.archived ? refreshConversations() : refreshTeam());
    }
  }, [agent, members, member, archivedDialog]);

  useReadMarker(conversationId, member?.unread ?? 0);

  if (!s || !id) return null;

  if (list && !agent) {
    const fallback = list.find((a) => a.id === s.defaultAgent);
    return (
      <div className="flex h-full flex-col">
        <TopBar />
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6">
          <EmptyState icon="bot" title={t("agent.notFound")} hint={t("agent.notFoundHint")} />
          {fallback && (
            <Link href="/" className="text-sm text-accent-text underline">
              {t("agent.openDefault", { name: fallback.name })}
            </Link>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar>
        <AgentHeader agentId={id} />
        <ChatMenu onSettings={agent ? () => editAgent(agent.id) : undefined} />
      </TopBar>
      <div className="min-h-0 flex-1">
        {conversationId ? (
          <ChatView
            key={conversationId}
            conversationId={conversationId}
            header={false}
            bottom={archived ? undefined : <SetupGate conversationId={conversationId} agentId={id} />}
            emptyHint={archived ? "" : agent && !isDefault ? t("agent.emptyHint", { name: agent.name }) : undefined}
            dock={agent && archived ? <ArchivedBar agent={agent} /> : undefined}
          />
        ) : agent && archived ? (
          <div className="flex h-full flex-col justify-end px-3 pb-3 sm:px-6">
            <div className="mx-auto w-full max-w-3xl">
              <ArchivedBar agent={agent} />
            </div>
          </div>
        ) : (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        )}
      </div>
    </div>
  );
}
