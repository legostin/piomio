// A notification in the chat. A report or a digest is the agent speaking: a thin caption, then its words as an ordinary
// message bubble and, under a digest, what it drew on. An alert or a question is a compact card; a check's alert can be
// rated behind "⋯".

import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Clock, Ellipsis, Sparkles } from "lucide-react";
import type { MessagePart, Notification, NotificationSource } from "@piomio/shared";
import { api, errorText } from "../../lib/api";
import { partKind, sourceLabel } from "../../lib/notifications";
import { toast } from "../../state/toast";
import { t, type MessageKey } from "../../i18n";
import { Markdown } from "../../components/markdown";
import { cx } from "../../components/ui";

type Part = Extract<MessagePart, { type: "notification" }>;
type Feedback = NonNullable<Notification["feedback"]>;

export const FEEDBACK: Array<{ value: Feedback; label: MessageKey; thanks: MessageKey }> = [
  { value: "useful", label: "notifications.feedback.useful", thanks: "notifications.thanks.useful" },
  { value: "less", label: "notifications.feedback.less", thanks: "notifications.thanks.less" },
  { value: "off", label: "notifications.feedback.off", thanks: "notifications.thanks.off" },
];

export async function sendFeedback(id: string, value: Feedback): Promise<boolean> {
  try {
    await api.post(`/api/notifications/${encodeURIComponent(id)}/feedback`, { value });
    const option = FEEDBACK.find((f) => f.value === value);
    if (option) toast(t(option.thanks), "success");
    return true;
  } catch (e) {
    toast(errorText(e), "error");
    return false;
  }
}

/** What a digest drew on: chips that open the schedule's task, the agent or the channel. `bare`: under a chat bubble, not inside a card. */
export function Sources({ sources, bare }: { sources: NotificationSource[]; bare?: boolean }) {
  const chip = "rounded-full border border-border px-2 py-0.5 text-muted";
  return (
    <div className={cx("flex flex-wrap items-center gap-1.5 text-[11.5px]", bare ? "px-1" : "mt-2.5 border-t border-hairline pt-2")}>
      <span className="text-muted">{t("notifications.sources")}</span>
      {sources.map((s, i) =>
        s.href ? (
          <Link key={i} href={s.href} className={cx(chip, "hover:bg-surface-2 hover:text-fg")}>
            {sourceLabel(s)}
          </Link>
        ) : (
          <span key={i} className={chip}>
            {sourceLabel(s)}
          </span>
        ),
      )}
    </div>
  );
}

function FeedbackMenu({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // An open menu closes on a tap elsewhere or Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("notifications.feedback.menu")}
        aria-expanded={open}
        className="flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
      >
        <Ellipsis className="size-4" />
      </button>
      {open && (
        <div role="menu" className="absolute top-8 right-0 z-10 flex min-w-40 flex-col rounded-xl border border-hairline bg-surface p-1 shadow-card">
          {FEEDBACK.map((f) => (
            <button
              key={f.value}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void sendFeedback(id, f.value);
              }}
              className="rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-surface-2"
            >
              {t(f.label)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function NotificationCard({ part, taskId }: { part: Part; taskId?: string }) {
  const kind = partKind(part);
  const [all, setAll] = useState(false);
  if (kind === "report" || kind === "digest") {
    const Icon = kind === "report" ? Clock : Sparkles;
    // The agent's words, so they sit straight under the message's parts like any other text: the same bubble, tail and
    // grouping (index.css `.msg-parts > .md`). Parts saved before kinds are lines joined with single newlines, which
    // assistant Markdown would run into one paragraph: those keep their breaks, as the old card showed them.
    return (
      <>
        <div className="flex items-center gap-1.5 px-0.5 text-[12px] text-muted">
          <Icon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{part.caption ? `${part.title} · ${part.caption}` : part.title}</span>
        </div>
        <Markdown text={part.body} user={!part.kind} />
        {part.sources?.length ? <Sources sources={part.sources} bare /> : null}
      </>
    );
  }
  const long = part.body.split("\n").length > 6 || part.body.length > 420;
  return (
    <div className={cx("w-full max-w-md rounded-2xl border bg-surface p-3.5 shadow-card", kind === "question" ? "border-accent" : "border-hairline")}>
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-sm font-semibold">{part.title}</span>
        {part.feedbackable && part.notificationId && <FeedbackMenu id={part.notificationId} />}
      </div>
      {/* The hub's own lines keep their breaks. */}
      {part.body && (
        <div className={cx("mt-1", long && !all && "max-h-36 overflow-hidden")}>
          <Markdown text={part.body} className="text-sm" user />
        </div>
      )}
      {(long || taskId) && (
        <div className="mt-2 flex items-center gap-3 text-xs">
          {long && (
            <button type="button" onClick={() => setAll((v) => !v)} className="text-accent-text hover:underline">
              {all ? t("notifications.showLess") : t("notifications.showAll")}
            </button>
          )}
          <span className="flex-1" />
          {taskId && (
            <Link href={`/tasks/${taskId}`} className="text-accent-text underline decoration-border underline-offset-2 hover:decoration-current">
              {t("notifications.toTask")}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
