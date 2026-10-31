// Rendering of one message and its parts. Plugins can override whole messages (chat.message) or tool cards
// (chat.toolResult); overrides run inside an error boundary that falls back to the core rendering.

import { memo, useState } from "react";
import { Check, CircleAlert, CornerUpLeft, FilePen, FileText, Mic, Play, ShieldAlert, SquareTerminal, X } from "lucide-react";
import type { AgentDef, ApprovalStatus, Message, MessagePart } from "@piomio/shared";
import { groupParts } from "../../lib/parts";
import { fileSize, formatDuration, formatTime } from "../../lib/format";
import { useStore } from "../../lib/store";
import { api, errorText } from "../../lib/api";
import { showDetails } from "../../state/prefs";
import { openViewer, saveMedia } from "../../state/viewer";
import { fileHref, mediaKind, partKey } from "../../lib/gallery";
import { native } from "../../lib/native";
import { Markdown } from "../../components/markdown";
import { Badge, Button, cx } from "../../components/ui";
import { AgentAvatar } from "../../components/AgentAvatar";
import { PluginBoundary } from "../../plugins/boundary";
import { pickMessageRenderer, pickToolRenderer } from "../../plugins/registry";
import { usePluginRegistry } from "../../plugins/slots";
import { ToolCard } from "./ToolCard";
import { PluginSetupCard, SecretRequestCard } from "../../components/SecretCards";
import { AgentDraftCard } from "./AgentDraftCard";
import { AgentProfileCard } from "./AgentProfileCard";
import { BrainLoginCard } from "../../components/BrainLoginCard";
import { BrainSetupCard } from "../../components/BrainSetupCard";
import { IntegrationChatCard } from "../../components/IntegrationCard";
import { ImagesCard } from "./ImagesCard";
import { NotificationCard } from "./NotificationCard";
import { MapCard } from "./MapCard";
import { NewsCard } from "./NewsCard";
import { Choices, FeedCard } from "./ChatButtons";
import { ThinkingCard } from "./ThinkingCard";
import { PageCard } from "./PageCard";
import { TaskLine } from "./TaskLine";
import { LiveStep } from "./LiveStep";
import { ModelBadge } from "./ModelBadge";
import { ConnectDeviceCard } from "./ConnectDeviceCard";
import { WidgetCard } from "./WidgetCard";
import { t, type MessageKey } from "../../i18n";
import { mobileMode } from "../../lib/mobile";

const APPROVAL: Record<ApprovalStatus, { label: MessageKey; tone: "warning" | "success" | "danger" | "neutral" | "info" }> = {
  pending: { label: "approvalStatus.pending", tone: "warning" },
  approved: { label: "approvalStatus.approved", tone: "success" },
  denied: { label: "approvalStatus.denied", tone: "danger" },
  expired: { label: "approvalStatus.expired", tone: "neutral" },
  executed: { label: "approvalStatus.executed", tone: "success" },
  failed: { label: "approvalStatus.failed", tone: "danger" },
};

/** The card's words for what the agent asks: a plain headline in the viewer's language and the detail as is. */
function approvalWords(part: Extract<MessagePart, { type: "approval" }>): { headline: string; detail?: string; reason?: string; Icon: typeof ShieldAlert } {
  const ask = part.ask;
  switch (ask?.kind) {
    case "command":
      return {
        headline: ask.host ? t("message.approval.ask.commandNetwork", { host: ask.host }) : t("message.approval.ask.command"),
        detail: ask.detail,
        reason: ask.reason,
        Icon: SquareTerminal,
      };
    case "read":
      return { headline: t("message.approval.ask.read"), detail: ask.detail, Icon: FileText };
    case "write":
      return { headline: t("message.approval.ask.write"), detail: ask.detail, Icon: FilePen };
    default:
      return { headline: part.summary, Icon: ShieldAlert };
  }
}

/** The card's buttons, as in any agent: allow once, allow always (a rule from the card), or deny. */
function ApprovalActions({ approvalId }: { approvalId: string }) {
  const [busy, setBusy] = useState<"approve" | "always" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answer = async (kind: "approve" | "always" | "deny") => {
    setBusy(kind);
    setError(null);
    try {
      await api.post(`/api/approvals/${encodeURIComponent(approvalId)}`, { decision: kind === "deny" ? "deny" : "approve", remember: kind === "always" });
    } catch (e) {
      setError(t("message.approval.failed", { error: errorText(e) }));
      setBusy(null);
    }
  };
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <div className="flex gap-2">
        <Button variant="primary" className="flex-1" loading={busy === "approve"} disabled={busy !== null} onClick={() => void answer("approve")}>
          {t("message.approval.approve")}
        </Button>
        <Button variant="secondary" className="flex-1" loading={busy === "deny"} disabled={busy !== null} onClick={() => void answer("deny")}>
          {t("message.approval.deny")}
        </Button>
      </div>
      <button
        type="button"
        className="self-center px-2 py-1 text-xs font-medium text-muted hover:text-fg disabled:opacity-50"
        disabled={busy !== null}
        onClick={() => void answer("always")}
      >
        {t("message.approval.always")}
      </button>
      {error && (
        <div className="text-xs break-words text-danger" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** An action the person asked for in their own words: their words were the yes, so only a quiet line of what was done. */
function AskedLine({ part }: { part: Extract<MessagePart, { type: "approval" }> }) {
  const [open, setOpen] = useState(false);
  const failed = part.status === "failed";
  return (
    <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full max-w-md items-start gap-1.5 px-1 text-left text-xs leading-relaxed text-muted">
      {failed ? <X className="mt-0.5 size-3.5 shrink-0 text-danger" /> : <Check className={cx("mt-0.5 size-3.5 shrink-0", part.status === "executed" && "text-success")} />}
      <span className={cx("min-w-0 break-words", !open && "line-clamp-2")}>
        {part.summary}
        <span className="text-muted/70"> · {t(failed ? "message.approval.askedFailed" : "message.approval.asked")}</span>
      </span>
    </button>
  );
}

function ApprovalCard({ part }: { part: Extract<MessagePart, { type: "approval" }> }) {
  if (part.asked) return <AskedLine part={part} />;
  const known = APPROVAL[part.status];
  const st = known ? { label: t(known.label), tone: known.tone } : { label: part.status, tone: "neutral" as const };
  const pending = part.status === "pending";
  const { headline, detail, reason, Icon } = approvalWords(part);
  const [open, setOpen] = useState(false);
  return (
    <div className={cx("w-full max-w-md rounded-2xl border bg-surface p-3.5 shadow-card", pending ? "border-warning/35 ring-4 ring-warning/8" : "border-hairline")}>
      <div className="flex items-start gap-2.5">
        <span className={cx("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full", pending ? "bg-warning-soft text-warning" : "bg-surface-2 text-muted")}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-muted">{pending ? t("message.approval.asks") : <Badge tone={st.tone}>{st.label}</Badge>}</div>
          <div className="mt-0.5 text-sm leading-snug font-semibold break-words">{headline}</div>
        </div>
      </div>
      {reason && <div className="mt-2 text-sm leading-relaxed break-words text-fg/80">{reason}</div>}
      {detail && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={open ? undefined : t("message.approval.showAll")}
          className="mt-2 block w-full rounded-lg bg-surface-2 px-2.5 py-2 text-left font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg/90 [overflow-wrap:anywhere]"
        >
          <span className={open ? "block" : "line-clamp-3"}>{detail}</span>
        </button>
      )}
      {pending && <ApprovalActions approvalId={part.approvalId} />}
    </div>
  );
}

function ErrorPart({ message }: { message: string }) {
  return (
    <div className="flex max-w-md items-start gap-2 rounded-2xl bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-words whitespace-pre-wrap">{message}</span>
    </div>
  );
}

/**
 * A file in a message. A picture or a video is its own thumbnail and opens the viewer on the chat's media; any other
 * file is a chip that opens it (inside the phone app, the share sheet: the app's web view cannot show it itself).
 */
function Attachment({ part, message, index }: { part: Extract<MessagePart, { type: "attachment" }>; message: Message; index: number }) {
  const href = fileHref(part.path);
  const media = part.kind === "voice" ? undefined : mediaKind(part.mimeType);
  const isAudio = part.mimeType?.startsWith("audio/");
  const voice = part.kind === "voice";
  const meta = [part.durationSec !== undefined ? formatDuration(part.durationSec) : undefined, part.size !== undefined ? fileSize(part.size) : part.mimeType].filter(Boolean).join(" · ");
  const key = partKey(message.id, index);
  const open = () => openViewer({ kind: "chat", conversationId: message.conversationId }, key);
  const label = t("viewer.open", { name: part.name || t("viewer.video") });
  if (media === "image") {
    return (
      <button type="button" data-media-key={key} onClick={open} aria-label={label} title={part.name} className="my-1.5 block max-w-full cursor-zoom-in overflow-hidden rounded-2xl border border-hairline bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <img src={href} alt={part.name} className="block max-h-72 max-w-full" loading="lazy" decoding="async" />
      </button>
    );
  }
  if (media === "video") {
    return (
      <button type="button" data-media-key={key} onClick={open} aria-label={label} title={part.name} className="group relative my-1.5 block max-w-full overflow-hidden rounded-2xl border border-hairline bg-black outline-none focus-visible:ring-2 focus-visible:ring-accent">
        {/* The first frame as the thumbnail (#t: iOS draws none for preload=metadata otherwise). */}
        <video src={`${href}#t=0.1`} preload="metadata" muted playsInline className="pointer-events-none block max-h-72 min-h-32 max-w-full min-w-48" />
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-black/50 text-white ring-1 ring-white/20 backdrop-blur transition group-hover:scale-105">
            <Play className="size-5 translate-x-px fill-current" />
          </span>
        </span>
        {part.durationSec !== undefined && <span className="absolute right-2 bottom-2 rounded-full bg-black/55 px-1.5 py-0.5 text-[11px] font-medium text-white tabular-nums">{formatDuration(part.durationSec)}</span>}
      </button>
    );
  }
  return (
    <div className="my-1.5">
      {isAudio && <audio controls preload="none" src={href} className="mb-1 h-10 w-72 max-w-full" />}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          if (!native) return;
          e.preventDefault();
          saveMedia({ key, kind: "image", src: href, name: part.name, download: fileHref(part.path, true) });
        }}
        className="press inline-flex max-w-full items-center gap-2 rounded-full border border-hairline bg-surface py-1.5 pr-3.5 pl-2 text-sm text-fg shadow-[0_1px_2px_rgb(70_45_10/0.06)] hover:bg-surface-2"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-text">
          {voice ? <Mic className="size-3.5" /> : <FileText className="size-3.5" />}
        </span>
        <span className="min-w-0 truncate font-medium">{voice ? t("message.voice") : part.name || part.path}</span>
        {meta && <span className="shrink-0 text-xs text-muted">{meta}</span>}
      </a>
      {part.transcript && <p className="mt-1.5 max-w-prose whitespace-pre-wrap">{part.transcript}</p>}
    </div>
  );
}

/** The person's message this reply answers (a task's report after the talk moved on): a click scrolls to it. */
function ReplyQuote({ part }: { part: Extract<MessagePart, { type: "reply_to" }> }) {
  const jump = () => {
    const el = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(part.messageId)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("reply-flash");
    void el.offsetWidth;
    el.classList.add("reply-flash");
  };
  return (
    <button
      type="button"
      onClick={jump}
      title={t("message.replyTo")}
      className="press flex max-w-full items-center gap-1.5 self-start rounded-xl border-l-[3px] border-accent bg-surface-2/80 py-1 pr-3 pl-2 text-left text-[13px] text-muted hover:text-fg"
    >
      <CornerUpLeft className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{part.text}</span>
    </button>
  );
}

function TypingDots() {
  return (
    <span className="msg-bubble inline-flex items-center gap-1.5 px-4 py-3" aria-label={t("message.typing")}>
      <span className="typing-dot size-[7px] rounded-full" />
      <span className="typing-dot size-[7px] rounded-full" />
      <span className="typing-dot size-[7px] rounded-full" />
    </span>
  );
}

/**
 * Without detailed mode the chat shows only what is meant for the person: answers, cards, errors, files.
 * Tool calls and results, and text in system messages (notes for the model, "[System] …"), are service details.
 */
function partShown(p: MessagePart, role: Message["role"], details: boolean): boolean {
  if (details) return true;
  if (p.type === "tool_call" || p.type === "tool_result") return false;
  return !(role === "system" && p.type === "text");
}

/** Whether the chat shows the message at all: a finished one with nothing for the person (only tool calls, a note for the model) is left out. */
/** `inline`: tools whose plugin line ("Remembered: …") is for the person, shown without the details mode. */
export function messageShown(message: Message, details: boolean, inline?: (tool: string) => boolean): boolean {
  return (
    message.status === "streaming" ||
    message.parts.some((p) => (p.type === "tool_call" && !details && !!inline?.(p.name)) || (p.type !== "reply_to" && partShown(p, message.role, details)))
  );
}

/** Who wrote it, for runs of messages: the person, an agent (or a teammate writing in a thread), or nobody (system). */
export function authorOf(message: Message): string | undefined {
  if (message.role === "system") return undefined;
  if (message.role === "user" && !message.agentId) return "user";
  return `agent:${message.agentId ?? ""}`;
}

function Parts({ message }: { message: Message }) {
  const { contributions } = usePluginRegistry();
  const details = useStore(showDetails);
  // Without the details mode, a plugin's inline lines ("Remembered: …") go under a finished message, after its words.
  const streaming = message.status === "streaming";
  const grouped = groupParts(message.parts);
  const inline = (it: (typeof grouped)[number]) => it.kind === "tool" && !!pickToolRenderer(contributions, it.call.name)?.inline;
  const items = details || streaming ? grouped : [...grouped.filter((it) => !inline(it)), ...grouped.filter(inline)];
  const lastPart = message.parts[message.parts.length - 1];
  return (
    <>
      {items.map((it, idx) => {
        // A plugin's inline line ("Remembered: …") is for the person: shown without the details mode.
        const plugin = it.kind === "tool" ? pickToolRenderer(contributions, it.call.name) : undefined;
        if (!details && it.kind !== "part" && !plugin?.inline) return null;
        if (it.kind === "part" && !partShown(it.part, message.role, details)) return null;
        if (it.kind === "tool") {
          const running = streaming && !it.result;
          const core = <ToolCard call={it.call} result={it.result} running={running} />;
          if (!plugin) return <div key={it.key}>{core}</div>;
          const C = plugin.component;
          return (
            <PluginBoundary key={it.key} pluginId={plugin.pluginId} fallback={core}>
              <C pluginId={plugin.pluginId} call={it.call} result={it.result} message={message} />
            </PluginBoundary>
          );
        }
        if (it.kind === "orphan_result") return <ToolCard key={it.key} result={it.result} />;
        const p = it.part;
        switch (p.type) {
          case "text": {
            const caret = streaming && idx === items.length - 1 && lastPart?.type === "text";
            return message.role === "user" && !message.agentId ? (
              <Markdown key={it.key} text={p.text} className="md-bubble" user />
            ) : (
              <Markdown key={it.key} text={p.text} className={cx(caret && "stream-caret")} />
            );
          }
          case "approval":
            return <ApprovalCard key={it.key} part={p} />;
          case "notification":
            return <NotificationCard key={it.key} part={p} taskId={message.taskId} />;
          case "error":
            return <ErrorPart key={it.key} message={p.message} />;
          case "attachment":
            return <Attachment key={it.key} part={p} message={message} index={it.index} />;
          case "images":
            return <ImagesCard key={it.key} items={p.items} messageId={message.id} part={it.index} conversationId={message.conversationId} />;
          case "map":
            return <MapCard key={it.key} part={p} />;
          case "secret_request":
            return <SecretRequestCard key={it.key} part={p} />;
          case "plugin_setup":
            return <PluginSetupCard key={it.key} pluginId={p.pluginId} />;
          case "agent_draft":
            return <AgentDraftCard key={it.key} draftId={p.draftId} messageId={message.id} />;
          case "agent_profile":
            return <AgentProfileCard key={it.key} agentId={p.agentId} />;
          case "brain_login":
            return <BrainLoginCard key={it.key} brainRef={p.ref} />;
          case "integration":
            return <IntegrationChatCard key={it.key} id={p.id} conversationId={message.conversationId} />;
          case "brain_setup":
            return <BrainSetupCard key={it.key} conversationId={message.conversationId} />;
          case "device_pairing":
            return <ConnectDeviceCard key={it.key} />;
          case "task":
            return <TaskLine key={it.key} taskId={p.taskId} text={p.text} reply={p.reply} from={message.agentId} />;
          case "reply_to":
            return <ReplyQuote key={it.key} part={p} />;
          case "news":
            return <NewsCard key={it.key} part={p} />;
          case "choices":
            return <Choices key={it.key} part={p} messageId={message.id} />;
          case "feed":
            return <FeedCard key={it.key} feedId={p.feedId} />;
          case "thinking":
            return <ThinkingCard key={it.key} agentId={p.agentId} />;
          case "page":
            return <PageCard key={it.key} pageId={p.pageId} conversationId={message.conversationId} />;
          case "widget":
            return <WidgetCard key={it.key} part={p} message={message} />;
          default:
            return null;
        }
      })}
      {streaming && (items.length === 0 || items[items.length - 1].kind !== "part") && <LiveStep conversationId={message.conversationId} agentId={message.agentId} fallback={<TypingDots />} />}
    </>
  );
}

/** Where a person's message came from, before its time: nothing for the web UI, and on the phone nothing for the phone. */
function channelLabel(channel: string | undefined): string {
  if (!channel || channel === "web" || (channel === "app" && mobileMode)) return "";
  return `${channel === "app" ? t("message.fromPhone") : channel} · `;
}

/**
 * Core rendering of a message (also passed to chat.message overrides as `Default`). Yours is an amber bubble on the
 * right; an agent's words are paper bubbles beside its face, its cards bare under them. `grouped`: the same author
 * wrote just before, so no face or name again. `fresh`: it arrived while the chat was open, so it comes in with motion.
 */
export const DefaultMessage = memo(function DefaultMessage({
  message,
  agentName,
  agent,
  grouped,
  fresh,
}: {
  message: Message;
  agentName?: string;
  agent?: AgentDef;
  grouped?: boolean;
  fresh?: boolean;
}) {
  const details = useStore(showDetails);
  const { contributions } = usePluginRegistry();
  const name = agentName ?? agent?.name ?? message.agentId ?? t("message.assistant");
  // A finished message with nothing for the person (only tool calls, or a note for the model) is not shown at all.
  if (!messageShown(message, details, (tool) => !!pickToolRenderer(contributions, tool)?.inline)) return null;
  // A teammate writing in a thread is a user-role message with its agent: it reads as that agent's message.
  if (message.role === "user" && !message.agentId) {
    return (
      <div className={cx("flex justify-end", grouped && "-mt-3.5")} data-message-id={message.id}>
        <div
          className={cx(
            "bubble-user flex max-w-[86%] flex-wrap items-end gap-x-2.5 px-3.5 py-2 text-[15px] leading-relaxed sm:max-w-[72%]",
            grouped && "is-grouped",
            fresh && "animate-send",
          )}
        >
          {/* The time sits on the last line when it fits there, as in a messenger. */}
          <div className="min-w-0">
            <Parts message={message} />
          </div>
          <div className="ml-auto translate-y-[2px] text-[10.5px] leading-5 font-medium whitespace-nowrap tabular-nums opacity-55">
            {channelLabel(message.channel)}
            {formatTime(message.createdAt)}
          </div>
        </div>
      </div>
    );
  }
  if (message.role === "system") {
    return (
      <div className={cx("mx-auto w-full max-w-[640px] text-sm", fresh && "animate-in")} data-message-id={message.id}>
        <Parts message={message} />
      </div>
    );
  }
  const streaming = message.status === "streaming";
  return (
    <div className={cx("flex gap-2.5", grouped && "-mt-3.5", fresh && "animate-in")} data-message-id={message.id}>
      <div className="w-8 shrink-0">{!grouped && <AgentAvatar avatar={agent?.avatar} id={message.agentId} name={name} size={32} running={streaming} />}</div>
      <div className={cx("min-w-0 flex-1", grouped && "is-grouped")}>
        {!grouped && (
          <div className="mb-1 flex flex-wrap items-baseline gap-x-2 pl-0.5 text-[12.5px] text-muted">
            <span className="font-semibold text-fg">{name}</span>
            {details && message.brainRef && <span className="font-mono text-[11px]">{message.brainRef}</span>}
            <span className="tabular-nums">{formatTime(message.createdAt)}</span>
            {/* Which brain, model and effort answered: said when tapped. */}
            {!streaming && <ModelBadge message={message} className="self-center" />}
          </div>
        )}
        <div className={cx("msg-parts text-[15px] leading-relaxed", grouped && "group/msg relative")}>
          <Parts message={message} />
          {/* A reply after another of the agent's: its mark shows on hover (the first one's is in the header). */}
          {grouped && !streaming && <ModelBadge message={message} className="absolute top-0 -right-1 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100" />}
        </div>
      </div>
    </div>
  );
});

function DefaultMessageForPlugins({ message }: { message: Message }) {
  return <DefaultMessage message={message} />;
}

export function MessageView({ message, agent, grouped, fresh }: { message: Message; agent?: AgentDef; grouped?: boolean; fresh?: boolean }) {
  const { contributions } = usePluginRegistry();
  const override = pickMessageRenderer(contributions, message);
  const core = <DefaultMessage message={message} agentName={agent?.name} agent={agent} grouped={grouped} fresh={fresh} />;
  if (!override) return core;
  const C = override.component;
  return (
    <PluginBoundary pluginId={override.pluginId} fallback={core}>
      <C pluginId={override.pluginId} message={message} Default={DefaultMessageForPlugins} />
    </PluginBoundary>
  );
}
