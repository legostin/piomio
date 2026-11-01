// Message composer: Enter = send, Shift+Enter = newline (on the phone Return is a newline, the button sends), /command
// autocomplete, @member autocomplete (group members; teammates in an agent's dialog), files from the paperclip, the clipboard or a drop on the chat
// (uploaded at once, sent with the message), Stop while streaming (in a group: while members answer).
// Inside the iOS app an empty field shows a hold-to-talk mic (the app's on-device dictation).
// Plugins may wrap/replace it (chat.composer) and add buttons (chat.composerActions).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type PointerEvent } from "react";
import { ArrowUp, Mic, Paperclip, Square, UsersRound } from "lucide-react";
import type { AgentDef } from "@piomio/shared";
import { api, errorText } from "../../lib/api";
import { mobileMode } from "../../lib/mobile";
import { native, nativeErrorText, type NativeBridge } from "../../lib/native";
import { applyCommand, filterCommands, slashQuery, type CommandInfo } from "../../lib/commands";
import { applyMention, filterMentions, mentionQuery, type MentionOption } from "../../lib/mentions";
import { canSend, readyPaths } from "../../lib/attachments";
import { isStreaming } from "../../lib/messages";
import { useStore } from "../../lib/store";
import { agents, conversations, ensureAgents, groups, interrupt, sendMessage, useConversationMessages, useSelector, warmConversation } from "../../state/app";
import { toast } from "../../state/toast";
import { addFiles, removeFiles, usePendingFiles } from "../../state/attachments";
import { AttachmentChips } from "./AttachmentChips";
import { AgentAvatar } from "../../components/AgentAvatar";
import { cx } from "../../components/ui";
import { t } from "../../i18n";
import { PluginBoundary } from "../../plugins/boundary";
import { pickOverride } from "../../plugins/registry";
import { ComposerActions, usePluginRegistry } from "../../plugins/slots";

// Unsent text per conversation. Kept in sessionStorage too, so it survives the page reloading in the same tab
// (the phone app reloads its chat page when it signs it in again, e.g. after the hub restarted).
const DRAFTS_KEY = "ob.drafts";
const drafts = new Map<string, string>();
try {
  for (const [id, text] of Object.entries(JSON.parse(sessionStorage.getItem(DRAFTS_KEY) ?? "{}") as Record<string, unknown>)) {
    if (typeof text === "string") drafts.set(id, text);
  }
} catch {
  /* no storage: drafts last until reload */
}

function keepDraft(conversationId: string, text: string): void {
  if (text) drafts.set(conversationId, text);
  else drafts.delete(conversationId);
  try {
    sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(drafts)));
  } catch {
    /* private mode or full: in memory only */
  }
}

let commandsCache: { at: number; list: Promise<CommandInfo[]> } | undefined;
function loadCommands(): Promise<CommandInfo[]> {
  if (!commandsCache || Date.now() - commandsCache.at > 60_000) {
    commandsCache = { at: Date.now(), list: api.get<CommandInfo[]>("/api/commands").catch(() => []) };
  }
  return commandsCache.list;
}

export function useSend(conversationId: string) {
  return useCallback(
    async (text: string, attachments: string[] = []) => {
      const trimmed = text.trim();
      if (!trimmed && !attachments.length) return;
      await sendMessage(conversationId, trimmed, attachments);
    },
    [conversationId],
  );
}

/**
 * Who @mentions offer: a group chat's members; in an agent's dialog its teammates (the agent writes to the one the user
 * names); nobody elsewhere.
 */
function useMentionable(conversationId: string): { members: Array<{ id: string; name: string; avatar?: AgentDef["avatar"] }>; group: boolean } {
  const meta = useSelector(conversations, (list) => list.find((c) => c.id === conversationId));
  const agentList = useStore(agents);
  const kind = meta?.kind;
  const members = kind === "group" ? meta?.members : undefined;
  const own = kind === "main" ? meta?.agentId : undefined;
  useEffect(() => {
    if (kind === "main") ensureAgents();
  }, [kind]);
  return useMemo(() => {
    if (kind === "group") return { members: (members ?? []).map((id) => agentList?.find((a) => a.id === id) ?? { id, name: id, avatar: undefined }), group: true };
    if (kind === "main") return { members: (agentList ?? []).filter((a) => a.id !== own && !a.archived), group: false };
    return { members: [], group: false };
  }, [kind, members, own, agentList]);
}

/** A press shorter than this with no words is a tap: say how the mic works. */
const TAP_MS = 350;

/**
 * Hold-to-talk: pressing starts the app's dictation, the live words arrive as `dictation` events, letting go stops it
 * and hands over the final text. A failed start (mic or speech recognition not allowed) reports the app's reason.
 */
function MicButton({
  bridge,
  onListening,
  onWords,
  onDone,
  onError,
}: {
  bridge: NativeBridge;
  onListening: (on: boolean) => void;
  onWords: (text: string) => void;
  onDone: (text: string, tap: boolean) => void;
  onError: (reason: string) => void;
}) {
  const [held, setHeld] = useState(false);
  const run = useRef<{ started: Promise<boolean>; off: () => void; at: number; released: boolean } | null>(null);

  const press = (e: PointerEvent<HTMLButtonElement>) => {
    if (run.current || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety: pointerup still reaches us on the button */
    }
    const off = bridge.onEvent((ev) => {
      if (ev.type === "dictation" && typeof ev.text === "string") onWords(ev.text);
    });
    const started = bridge.dictation.start().then(
      () => true,
      (err: unknown) => {
        onError(nativeErrorText(err));
        return false;
      },
    );
    run.current = { started, off, at: Date.now(), released: false };
    setHeld(true);
    onListening(true);
    bridge.haptic("light").catch(() => {});
  };

  const release = async () => {
    const r = run.current;
    if (!r || r.released) return;
    r.released = true;
    setHeld(false);
    let text = "";
    if (await r.started) {
      try {
        text = (await bridge.dictation.stop()).text;
      } catch (err) {
        onError(nativeErrorText(err));
      }
    }
    r.off();
    run.current = null;
    onListening(false);
    onDone(text, Date.now() - r.at < TAP_MS);
  };

  // Leaving the chat while held stops the mic.
  useEffect(
    () => () => {
      const r = run.current;
      if (r && !r.released) {
        r.off();
        void r.started.then((ok) => {
          if (ok) bridge.dictation.stop().catch(() => {});
        });
      }
    },
    [bridge],
  );

  return (
    <button
      type="button"
      onPointerDown={press}
      onPointerUp={() => void release()}
      onPointerCancel={() => void release()}
      onLostPointerCapture={() => void release()}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={t("composer.mic")}
      aria-pressed={held}
      title={t("composer.mic")}
      className={cx(
        "mic-button inline-flex size-9 items-center justify-center rounded-full transition-transform duration-200",
        held ? "scale-125 bg-danger text-white shadow-[0_0_0_6px_color-mix(in_srgb,var(--danger)_22%,transparent)]" : "candy",
      )}
    >
      <Mic className={cx("size-[18px]", held && "animate-pulse")} />
    </button>
  );
}

export function DefaultComposer({ conversationId }: { conversationId: string }) {
  const conv = useConversationMessages(conversationId);
  const { members: mentionable, group: isGroup } = useMentionable(conversationId);
  // Between two members' answers no message streams, but the round goes on.
  const groupRunning = useSelector(groups, (list) => !!list?.find((g) => g.conversationId === conversationId)?.running);
  const streaming = isStreaming(conv.messages) || groupRunning;
  const send = useSend(conversationId);
  const [text, setText] = useState(() => drafts.get(conversationId) ?? "");
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [caret, setCaret] = useState(0);
  const [listening, setListening] = useState(false);
  const [micNote, setMicNote] = useState<{ text: string; error: boolean } | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const files = usePendingFiles(conversationId);
  const sendable = canSend(text, files);

  useEffect(() => {
    setText(drafts.get(conversationId) ?? "");
  }, [conversationId]);
  useEffect(() => {
    keepDraft(conversationId, text);
  }, [conversationId, text]);
  // Opening the chat and typing get the agent's brain ready, so the reply does not wait for it to start.
  const typing = text.length > 0;
  useEffect(() => {
    if (!isGroup) warmConversation(conversationId);
  }, [conversationId, typing, isGroup]);
  useEffect(() => {
    if (!streaming) setStopping(false);
  }, [streaming]);

  // Auto-grow up to ~40% of the viewport.
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    const max = Math.round(window.innerHeight * 0.4);
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [text]);

  const query = slashQuery(text);
  useEffect(() => {
    if (query !== null) void loadCommands().then(setCommands);
  }, [query !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const suggestions = query !== null && !dismissed ? filterCommands(commands, query) : [];
  const mention = mentionable.length ? mentionQuery(text, caret) : null;
  // "@all" is for groups; in a dialog a mention names the teammate to ask.
  const mentions = mention && !dismissed ? filterMentions(mentionable, mention.query, 8, isGroup ? t("composer.everyoneMention") : null) : [];
  // One list at a time: "/command" only at the very start, "@member" anywhere.
  const options = suggestions.length || mentions.length;
  const active = Math.min(sel, Math.max(0, options - 1));
  useEffect(() => {
    setSel(0);
    setDismissed(false);
  }, [query, mention?.start, mention?.query]);

  const submit = async (value: string = text) => {
    if (!canSend(value, files) || busy) return;
    const sent = files.filter((f) => f.status === "ready");
    setBusy(true);
    setText("");
    try {
      await send(value, readyPaths(sent));
      removeFiles(conversationId, sent.map((f) => f.id));
    } catch (e) {
      setText(value);
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
      // On the phone, focusing would bring the keyboard up after every message (and after dictation).
      if (!mobileMode) ta.current?.focus();
    }
  };

  const dictated = (words: string, tap: boolean) => {
    if (words.trim()) return void submit(words);
    setText("");
    // A short tap explains the gesture; a hold that brought no words says so instead of doing nothing.
    setMicNote((n) => n ?? { text: t(tap ? "composer.holdToTalk" : "composer.notHeard"), error: false });
  };
  // Typed words or files waiting: the send button instead of the mic.
  const showMic = !!native && ((!text.trim() && !files.length) || listening);

  const stop = async () => {
    setStopping(true);
    try {
      const ok = await interrupt(conversationId);
      if (!ok) toast(t("composer.nothingToStop"), "info");
    } catch (e) {
      toast(errorText(e), "error");
      setStopping(false);
    }
  };

  const choose = (c: CommandInfo) => {
    setText(applyCommand(c.name));
    setDismissed(true);
    ta.current?.focus();
  };

  const chooseMention = (o: MentionOption) => {
    if (!mention) return;
    const next = applyMention(text, caret, mention.start, o.id);
    setText(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  // A screenshot or a copied file: attached; text that came with it is pasted as usual.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...e.clipboardData.files];
    if (!pasted.length) return;
    if (!e.clipboardData.getData("text/plain")) e.preventDefault();
    addFiles(conversationId, pasted);
  };

  const pick = (i: number) => (suggestions.length ? choose(suggestions[i]) : chooseMention(mentions[i]));

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (options) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        return setSel(() => (active + 1) % options);
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        return setSel(() => (active - 1 + options) % options);
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        return pick(active);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        return setDismissed(true);
      }
    }
    if (e.key === "Enter" && !e.shiftKey && (!mobileMode || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="relative">
      {suggestions.length > 0 && (
        <div className="animate-zoom absolute inset-x-0 bottom-full mb-2 overflow-hidden rounded-2xl border border-hairline bg-surface p-1 shadow-pop" role="listbox" aria-label={t("composer.commands")}>
          {suggestions.map((c, i) => (
            <button
              key={c.name}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(c);
              }}
              onMouseMove={() => setSel(i)}
              className={cx("flex w-full items-baseline gap-3 rounded-xl px-3 py-2 text-left text-sm", i === active ? "bg-accent-soft" : "")}
            >
              <span className="shrink-0 font-mono font-medium text-accent-text">/{c.name.replace(/^\//, "")}</span>
              <span className="min-w-0 flex-1 truncate text-muted">{c.description}</span>
              {c.source && <span className="shrink-0 text-xs text-muted">{c.source}</span>}
            </button>
          ))}
        </div>
      )}
      {mentions.length > 0 && (
        <div className="animate-zoom absolute inset-x-0 bottom-full mb-2 overflow-hidden rounded-2xl border border-hairline bg-surface p-1 shadow-pop" role="listbox" aria-label={t("composer.mentions")}>
          {mentions.map((o, i) => {
            const a = mentionable.find((m) => m.id === o.id);
            return (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  chooseMention(o);
                }}
                onMouseMove={() => setSel(i)}
                className={cx("flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm", i === active ? "bg-accent-soft" : "")}
              >
                {o.all ? (
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
                    <UsersRound className="size-3.5" />
                  </span>
                ) : (
                  <AgentAvatar avatar={a?.avatar} id={o.id} name={o.name} size={24} />
                )}
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{o.all ? t("composer.everyone") : o.name}</span>
                  {o.all && <span className="text-muted"> · {t("composer.everyoneHint")}</span>}
                </span>
                <span className="shrink-0 font-mono text-xs text-muted">@{o.id}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="composer-box rounded-[26px] border border-hairline bg-surface p-1.5 shadow-pop transition-[border-color,box-shadow] duration-200 focus-within:border-accent/50 focus-within:shadow-[var(--shadow-pop),0_0_0_4px_color-mix(in_srgb,var(--accent)_16%,transparent)]">
        {files.length > 0 && <AttachmentChips conversationId={conversationId} files={files} />}
        <div className="flex items-end gap-1">
          <button
            type="button"
            onClick={() => picker.current?.click()}
            title={t("composer.attach")}
            aria-label={t("composer.attach")}
            className="press inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
          >
            <Paperclip className="size-[18px]" />
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(conversationId, [...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <textarea
            ref={ta}
            rows={1}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
              setMicNote(null);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            readOnly={listening}
            placeholder={listening ? t("composer.listening") : isGroup ? t(mobileMode ? "composer.groupPlaceholderShort" : "composer.groupPlaceholder") : mobileMode ? t("composer.placeholderShort") : t("composer.placeholder")}
            aria-label={t("composer.message")}
            className="max-h-[40vh] min-h-9 flex-1 resize-none overflow-hidden bg-transparent py-2 text-[15px] leading-relaxed outline-none focus-visible:outline-none placeholder:text-muted/80"
          />
          <div className="flex shrink-0 items-center gap-1 pb-0.5">
            <ComposerActions conversationId={conversationId} />
            {native && showMic && (
              <MicButton
                bridge={native}
                onListening={(on) => {
                  setListening(on);
                  if (on) setMicNote(null);
                }}
                onWords={setText}
                onDone={dictated}
                onError={(reason) => setMicNote({ text: t("composer.micFailed", { reason }), error: true })}
              />
            )}
            {streaming ? (
              <button
                type="button"
                onClick={() => void stop()}
                disabled={stopping}
                title={t("composer.stop")}
                aria-label={t("composer.stop")}
                className="press animate-pop inline-flex size-9 items-center justify-center rounded-full bg-fg text-bg hover:opacity-90 disabled:opacity-50"
              >
                <Square className="size-3 fill-current" />
              </button>
            ) : showMic ? null : (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!sendable || busy}
                title={t("composer.sendTitle")}
                aria-label={t("composer.send")}
                className={cx(
                  "press inline-flex size-9 items-center justify-center rounded-full transition-[transform,background,color,box-shadow] duration-300",
                  sendable && !busy ? "candy scale-100" : "scale-90 bg-surface-2 text-muted/70",
                )}
              >
                <ArrowUp className="size-[18px]" strokeWidth={2.4} />
              </button>
            )}
          </div>
        </div>
      </div>
      {micNote && (
        <div className={cx("mt-1.5 px-1 text-xs break-words", micNote.error ? "text-danger" : "text-muted")} role={micNote.error ? "alert" : "status"}>
          {micNote.text}
        </div>
      )}
    </div>
  );
}

/** The composer slot: a plugin override (highest priority) or the default composer. */
export function Composer({ conversationId }: { conversationId: string }) {
  const { contributions } = usePluginRegistry();
  const send = useSend(conversationId);
  const override = pickOverride(contributions, "chat.composer");
  const core = <DefaultComposer conversationId={conversationId} />;
  if (!override) return core;
  const C = override.component;
  return (
    <PluginBoundary pluginId={override.pluginId} fallback={core}>
      <C pluginId={override.pluginId} conversationId={conversationId} Default={DefaultComposer} send={send} />
    </PluginBoundary>
  );
}
