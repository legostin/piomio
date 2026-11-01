// A conversation: top bar (agent and title, or a group's members), scrolling message list with history loading, composer.
// Files dropped anywhere on it go to the composer.

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { ArrowDown, Check, Paperclip, Pencil, X } from "lucide-react";
import type { Message } from "@piomio/shared";
import { AVATAR_PALETTE, defaultAvatar } from "@piomio/shared/avatar";
import { useStore } from "../../lib/store";
import { stickAfterScroll } from "../../lib/stick";
import { errorText } from "../../lib/api";
import { agents, conversations, ensureAgents, loadMessages, loadOlder, updateConversation, useConversationMessages } from "../../state/app";
import { showDetails } from "../../state/prefs";
import { toast } from "../../state/toast";
import { addFiles } from "../../state/attachments";
import { Button, EmptyState, ErrorNote, IconButton, Input, Spinner } from "../../components/ui";
import { AgentAvatar } from "../../components/AgentAvatar";
import { TopBar } from "../../components/Layout";
import { useComposerInsetRef } from "../../components/LiveViewWindow";
import { AgentHeader } from "./AgentHeader";
import { GroupFloor, GroupHeader } from "./GroupHeader";
import { ChatMenu } from "./DetailsToggle";
import { formatDate, formatRelative, t } from "../../i18n";
import { authorOf, messageShown, MessageView } from "./MessageView";
import { pickToolRenderer } from "../../plugins/registry";
import { usePluginRegistry } from "../../plugins/slots";
import { LatestDraftCards } from "./AgentDraftCard";
import { Composer } from "./Composer";

/** Messages closer than this by one author read as one run. */
const GROUP_MS = 5 * 60_000;

function dayOf(iso: string): string {
  return new Date(iso).toDateString();
}

/** "Today", "Yesterday", or the weekday and date, in the interface language. */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  const s = days === 0 || days === 1 ? formatRelative(-days, "day") : formatDate(d, { weekday: "long", day: "numeric", month: "long" });
  return s.charAt(0).toLocaleUpperCase() + s.slice(1);
}

function TitleEditor({ id, title }: { id: string; title: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  useEffect(() => setValue(title), [title]);
  if (!editing)
    return (
      <div className="flex min-w-0 items-center gap-1">
        <span className="truncate">{title}</span>
        <IconButton label={t("common.rename")} onClick={() => setEditing(true)} className="size-7 shrink-0">
          <Pencil className="size-3.5" />
        </IconButton>
      </div>
    );
  const save = async () => {
    setEditing(false);
    if (value.trim() && value.trim() !== title) {
      try {
        await updateConversation(id, { title: value.trim() });
      } catch (e) {
        toast(errorText(e), "error");
      }
    }
  };
  return (
    <form
      className="flex min-w-0 items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} className="h-8 min-w-0" maxLength={120} />
      <IconButton label={t("common.save")} onClick={() => void save()} className="size-8 shrink-0">
        <Check className="size-4" />
      </IconButton>
      <IconButton label={t("common.cancel")} onClick={() => setEditing(false)} className="size-8 shrink-0">
        <X className="size-4" />
      </IconButton>
    </form>
  );
}

export function ChatView({
  conversationId,
  top,
  bottom,
  header = true,
  emptyHint,
  dock,
}: {
  conversationId: string;
  /** Rendered above the messages (e.g. a task summary). */
  top?: ReactNode;
  /** Rendered after the messages (e.g. the setup card while no brain works). */
  bottom?: ReactNode;
  header?: boolean;
  emptyHint?: ReactNode;
  /** In place of the composer (an archived agent's dialog, where nobody writes). */
  dock?: ReactNode;
}) {
  const conv = useConversationMessages(conversationId);
  const convList = useStore(conversations);
  const meta = convList.find((c) => c.id === conversationId);
  const agentList = useStore(agents);
  const agentById = useMemo(() => new Map((agentList ?? []).map((a) => [a.id, a])), [agentList]);
  const latestDrafts = useMemo(() => {
    const m = new Map<string, string>();
    for (const msg of conv.messages) for (const p of msg.parts) if (p.type === "agent_draft") m.set(p.draftId, msg.id);
    return m;
  }, [conv.messages]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const prevHeight = useRef<number | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const lastId = useRef<string | undefined>(undefined);
  const lastTop = useRef(0);
  const [showDown, setShowDown] = useState(false);
  const composerArea = useComposerInsetRef();
  const [dropping, setDropping] = useState(false);
  // dragenter/dragleave fire for every child the pointer crosses: count them.
  const dragDepth = useRef(0);
  // Dropped files go to the composer: without one (an archived agent's dialog) nothing is taken.
  const carriesFiles = (e: DragEvent) => !dock && [...e.dataTransfer.types].includes("Files");

  useEffect(() => {
    stick.current = true;
    void loadMessages(conversationId);
    ensureAgents();
  }, [conversationId]);

  // Keep the view pinned to the bottom while new content streams in; keep position when older messages load.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // The person's own new message brings the view down, wherever they were reading.
    const last = conv.messages[conv.messages.length - 1];
    if (last && lastId.current !== undefined && last.id !== lastId.current && last.role === "user") stick.current = true;
    lastId.current = last?.id;
    if (prevHeight.current !== null) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
      prevHeight.current = null;
    } else if (stick.current) el.scrollTop = el.scrollHeight;
  }, [conv.messages]);

  // Content that grows after it rendered (plugin cards, images) and a list that shrinks (the phone's keyboard) keep
  // a pinned view at the bottom.
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stick.current && prevHeight.current === null) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  const older = () => {
    if (!scroller.current) return;
    prevHeight.current = scroller.current.scrollHeight;
    void loadOlder(conversationId).finally(() => {
      // If nothing was prepended the layout effect may not run; reset.
      setTimeout(() => (prevHeight.current = null), 50);
    });
  };

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = stickAfterScroll(stick.current, lastTop.current, el);
    lastTop.current = el.scrollTop;
    setShowDown(fromBottom > 400);
    if (el.scrollTop < 60 && conv.hasMore && !conv.loadingOlder && prevHeight.current === null) older();
  };

  const title = meta?.title || (meta?.kind === "main" ? t("chat.main") : t("chat.defaultTitle"));
  const editable = meta?.kind === "chat";
  const isGroup = meta?.kind === "group";
  const groupHint = isGroup ? t("group.emptyHint", { lead: agentById.get(meta.agentId)?.name ?? meta.agentId }) : undefined;
  const host = meta && !isGroup ? agentById.get(meta.agentId) : undefined;

  // Runs of messages by one author share a face and a name; a new day gets a chip. What was there when the chat opened
  // stands still; what arrives afterwards comes in with motion.
  const details = useStore(showDetails);
  const { contributions } = usePluginRegistry();
  const opened = useRef<Set<string> | null>(null);
  if (opened.current === null && conv.loaded) opened.current = new Set(conv.messages.map((m) => m.id));
  const rows = useMemo(() => {
    let prev: Message | undefined;
    return conv.messages.map((m) => {
      if (!messageShown(m, details, (tool) => !!pickToolRenderer(contributions, tool)?.inline)) return { m, grouped: false, day: undefined };
      const day = dayOf(m.createdAt);
      const newDay = !prev || dayOf(prev.createdAt) !== day;
      const author = authorOf(m);
      const grouped = !newDay && !!prev && !!author && author === authorOf(prev) && Date.parse(m.createdAt) - Date.parse(prev.createdAt) < GROUP_MS;
      prev = m;
      return { m, grouped, day: newDay ? dayLabel(m.createdAt) : undefined };
    });
  }, [conv.messages, details, contributions]);

  return (
    <div
      className="relative flex h-full min-w-0 flex-1 flex-col"
      onDragEnter={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        dragDepth.current++;
        setDropping(true);
      }}
      onDragOver={(e) => {
        if (carriesFiles(e)) e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDropping(false);
      }}
      onDrop={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDropping(false);
        addFiles(conversationId, [...e.dataTransfer.files]);
      }}
    >
      {dropping && (
        <div className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-accent/60 bg-bg/85 text-sm font-medium backdrop-blur-sm">
          <Paperclip className="size-6 text-muted" />
          {t("composer.dropHere")}
        </div>
      )}
      {header && (
        <TopBar>
          {meta && isGroup ? (
            <GroupHeader conv={meta} />
          ) : (
            <>
              {meta && <AgentHeader agentId={meta.agentId} settings={meta.kind !== "task"} />}
              {(editable || meta?.kind === "task") && (
                <div className="hidden min-w-0 flex-1 text-[13px] text-muted sm:block">{editable ? <TitleEditor id={conversationId} title={title} /> : <span className="block truncate">{title}</span>}</div>
              )}
            </>
          )}
          <ChatMenu />
        </TopBar>
      )}

      <div ref={scroller} onScroll={onScroll} className="chat-scroll relative min-h-0 flex-1 overflow-y-auto">
        <div ref={content} className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-3 pt-6 pb-4 sm:px-6">
          {top}
          {conv.hasMore && (
            <div className="flex justify-center">
              <Button size="sm" variant="ghost" onClick={older} loading={conv.loadingOlder}>
                {t("chat.loadOlder")}
              </Button>
            </div>
          )}
          {conv.error && <ErrorNote onRetry={() => void loadMessages(conversationId, true)}>{conv.error}</ErrorNote>}
          {!conv.loaded && conv.loading && (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          )}
          {conv.loaded && !conv.messages.length && !conv.error && (
            <div className="flex min-h-[46vh] flex-col justify-center">
              {host ? (
                <EmptyState
                  title={host.name}
                  art={
                    <span className="block" style={{ "--halo": `${AVATAR_PALETTE[(host.avatar ?? defaultAvatar(host.id)).color].bottom}66` } as CSSProperties}>
                      <AgentAvatar avatar={host.avatar} id={host.id} name={host.name} size={76} />
                    </span>
                  }
                  hint={
                    <>
                      {host.description && <span className="block">{host.description}</span>}
                      <span className="mt-2 block text-[13px] text-muted/80">{emptyHint ?? t("chat.emptyHint")}</span>
                    </>
                  }
                />
              ) : (
                <EmptyState icon={isGroup ? "users" : "sparkles"} title={isGroup ? t("group.emptyTitle") : t("chat.empty")} hint={emptyHint ?? groupHint ?? t("chat.emptyHint")} />
              )}
            </div>
          )}
          <LatestDraftCards.Provider value={latestDrafts}>
            {rows.map(({ m, grouped, day }) => (
              <Fragment key={m.id}>
                {day && (
                  <div className="flex justify-center">
                    <span className="day-chip">{day}</span>
                  </div>
                )}
                <MessageView message={m} agent={m.agentId ? agentById.get(m.agentId) : undefined} grouped={grouped} fresh={!!opened.current && !opened.current.has(m.id)} />
              </Fragment>
            ))}
          </LatestDraftCards.Provider>
          {isGroup && <GroupFloor conversationId={conversationId} />}
          {bottom}
        </div>
        {showDown && (
          <button
            type="button"
            onClick={() => {
              stick.current = true;
              scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
            }}
            aria-label={t("chat.scrollDown")}
            className="glass press animate-pop sticky bottom-3 left-full mr-4 ml-auto flex size-9 items-center justify-center rounded-full border border-hairline text-muted shadow-pop hover:text-fg"
          >
            <ArrowDown className="size-4" />
          </button>
        )}
      </div>

      <div ref={composerArea} className="chat-dock relative shrink-0 px-3 pb-3 sm:px-6">
        <div className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-gradient-to-b from-transparent to-bg" aria-hidden />
        <div className="mx-auto w-full max-w-3xl">
          {dock ?? <Composer key={conversationId} conversationId={conversationId} />}
        </div>
      </div>
    </div>
  );
}
