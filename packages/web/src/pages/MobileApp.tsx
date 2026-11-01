// The iOS app's chat screen: /m/chat/:conversationId in a WKWebView. Only that conversation (messages, cards,
// plugin slots, the composer), full height, no sidebar, settings panel or header (the app draws a native one), the
// composer docked above the keyboard. UI plugins load as on the computer; their live views (an agent's browser) float
// over the chat in the shell.

import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useStore } from "../lib/store";
import { chatLinkPath, isMobilePath, mobileConversationId, mobileMode, trackVisualViewport } from "../lib/mobile";
import { native, nativeErrorText, openOutside, type NativeBridge } from "../lib/native";
import { toast } from "../state/toast";
import { setShowDetails } from "../state/prefs";
import { agents, conversations, ensureAgents, ensureGroups, ensureTeam, groups, hubIsBack, session, team, useConversationMessages, useSelector } from "../state/app";
import { useUiPlugins } from "../plugins/host";
import { entityPath } from "../state/ask";
import { EmptyState } from "../components/ui";
import { SetupGate } from "../components/BrainSetupCard";
import { LiveViewWindow } from "../components/LiveViewWindow";
import { ChatView } from "./chat/ChatView";
import { useReadMarker } from "./chat/AgentPage";
import { ArchivedBar } from "./chat/AgentMenu";
import { t } from "../i18n";

/** Tell the app the page is on screen (it hides its spinner), once. */
function signalReady(conversationId: string): void {
  requestAnimationFrame(() => {
    native?.ready(conversationId).catch(() => {});
  });
}

/** The page shows an error (hub unreachable…): let the app reveal it, with its Retry button. */
export function useMobileReadyOnError(error: boolean): void {
  useEffect(() => {
    if (mobileMode && error) signalReady(mobileConversationId(window.location.pathname) ?? "");
  }, [error]);
}

/**
 * Links that leave the hub open in Safari, also the ones plugins render or open with window.open (sign-in pages
 * in plugin setup cards). Explicit handlers (markdown, sign-in cards) already did it and prevented the default.
 */
function useOutsideLinks(): void {
  useEffect(() => {
    const bridge = native;
    if (!bridge) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (a) openOutside(e, a.getAttribute("href") ?? undefined, bridge);
    };
    document.addEventListener("click", onClick);
    const open = window.open;
    window.open = (url?: string | URL, target?: string, features?: string) => {
      let handled = false;
      openOutside({ preventDefault: () => void (handled = true) }, url === undefined ? undefined : String(url), bridge);
      return handled ? null : open.call(window, url, target, features);
    };
    return () => {
      document.removeEventListener("click", onClick);
      window.open = open;
    };
  }, []);
}

/** The app opens another chat (`open` with the web UI's path) as its own screen, with its own header. */
function openChat(bridge: NativeBridge, path: string): void {
  bridge.call("open", { path }).catch((err: unknown) => toast(t("link.openFailed", { error: nativeErrorText(err) }), "error"));
}

/**
 * Links to another chat (the card of a new agent, a task line, an agent's markdown link) open in the app, not in this
 * page, which shows one conversation. The click is taken before wouter's Link sees it; a navigation that gets here
 * some other way (a plugin calling navigate) is undone, and the chat opens in the app all the same.
 */
function useChatLinks(): void {
  const [location, navigate] = useLocation();
  const shown = useRef(location);
  useEffect(() => {
    const bridge = native;
    if (!bridge) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      const path = a && chatLinkPath(a.getAttribute("href") ?? "", window.location.href);
      if (!path) return;
      e.preventDefault();
      e.stopPropagation();
      openChat(bridge, path);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  useEffect(() => {
    if (isMobilePath(location)) {
      shown.current = location;
      return;
    }
    if (!native) return;
    navigate(shown.current, { replace: true });
    const path = chatLinkPath(location, window.location.href);
    if (path) openChat(native, path);
    else toast(t("mobile.computerOnly"), "info");
  }, [location, navigate]);
}

/** What the app says: its "Show steps" switch (the web UI's detailed mode), and that the hub answers again. */
function useNativeEvents(): void {
  useEffect(
    () =>
      native?.onEvent((ev) => {
        if (ev.type === "details" && typeof ev.on === "boolean") setShowDetails(ev.on);
        if (ev.type === "online") hubIsBack();
      }),
    [],
  );
}

function MobileChat({ conversationId }: { conversationId: string }) {
  const s = useStore(session);
  const convs = useStore(conversations);
  const members = useStore(team);
  const agentList = useStore(agents);
  const groupUnread = useSelector(groups, (list) => list?.find((g) => g.conversationId === conversationId)?.unread);
  const conv = useConversationMessages(conversationId);
  useEffect(() => {
    ensureTeam();
    ensureGroups();
    ensureAgents();
  }, []);

  const member = members?.find((m) => m.conversationId === conversationId);
  const meta = convs.find((c) => c.id === conversationId);
  const isGroup = meta?.kind === "group";
  const agentId = meta?.agentId ?? member?.agentId;
  const agent = agentId ? agentList?.find((a) => a.id === agentId) : undefined;
  const isDefault = !!s && agentId === s.defaultAgent;
  // An agent's dialog counts unread in the team, a group chat in the groups.
  useReadMarker(conversationId, member?.unread ?? groupUnread ?? 0);

  // Once the first page of messages (or its error) is on screen.
  const told = useRef(false);
  useEffect(() => {
    if (told.current || !conv.loaded) return;
    told.current = true;
    signalReady(conversationId);
  }, [conv.loaded, conversationId]);

  // An archived agent's dialog: read only, with the way back to the team.
  const archived = !!agent?.archived && meta?.kind === "main";

  return (
    <ChatView
      conversationId={conversationId}
      header={false}
      bottom={archived ? undefined : <SetupGate conversationId={conversationId} agentId={agentId} />}
      emptyHint={archived ? "" : agent && !isDefault && !isGroup ? t("agent.emptyHint", { name: agent.name }) : undefined}
      dock={agent && archived ? <ArchivedBar agent={agent} /> : undefined}
    />
  );
}

/** A new agent's setup chat that made the agent: the app opens the agent's dialog. */
function useBecomes(conversationId: string | undefined): void {
  const s = useStore(session);
  const target = useSelector(conversations, (list) => {
    const c = list.find((x) => x.id === conversationId);
    return c?.kind === "setup" && c.purpose === "agent" ? entityPath(c, s?.defaultAgent) : undefined;
  });
  useEffect(() => {
    if (target && native) openChat(native, target);
  }, [target]);
}

export function MobileApp() {
  useUiPlugins();
  useOutsideLinks();
  useChatLinks();
  useNativeEvents();
  useEffect(() => trackVisualViewport(), []);
  const [location] = useLocation();
  const id = mobileConversationId(location);
  useBecomes(id ?? undefined);
  useEffect(() => {
    if (!id) signalReady("");
  }, [id]);
  // The live view sits in the shell (it follows the visual viewport), its corners measured from the shell's bottom.
  const [shell, setShell] = useState<HTMLDivElement | null>(null);

  return (
    <div ref={setShell} data-live-view-frame="" className="mobile-shell flex flex-col overflow-hidden bg-bg">
      {id ? (
        <MobileChat key={id} conversationId={id} />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <EmptyState icon="message-square" title={t("mobile.noChat")} hint={t("mobile.noChatHint")} />
        </div>
      )}
      {shell && <LiveViewWindow frame={shell} />}
    </div>
  );
}
