// How notifications read: a part's kind (parts saved before kinds read by level), source labels, the Inbox's days and paging.

import type { BehindEntry, InboxEntry, InboxView, Notification, NotificationKind, NotificationSource, NotifyLevel } from "@piomio/shared";

export function partKind(p: { kind?: NotificationKind; level: NotifyLevel }): NotificationKind {
  if (p.kind) return p.kind;
  return p.level === "digest" ? "digest" : p.level === "ask" ? "question" : "alert";
}

export function sourceLabel(s: NotificationSource): string {
  return s.count && s.count > 1 ? `${s.label} · ${s.count}` : s.label;
}

const dayOf = (tz: string | undefined) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });

/** Entries by the person's local day (YYYY-MM-DD), keeping their order. */
export function groupByDay<T extends { createdAt: string }>(list: T[], tz?: string): Array<{ day: string; entries: T[] }> {
  const fmt = dayOf(tz);
  const out: Array<{ day: string; entries: T[] }> = [];
  for (const e of list) {
    const day = fmt.format(new Date(e.createdAt));
    const last = out[out.length - 1];
    if (last?.day === day) last.entries.push(e);
    else out.push({ day, entries: [e] });
  }
  return out;
}

/** "Today", "Yesterday", otherwise the date in the interface language. */
export function dayLabel(day: string, now: Date, tz: string | undefined, locale: string, words: { today: string; yesterday: string }): string {
  const fmt = dayOf(tz);
  if (day === fmt.format(now)) return words.today;
  if (day === fmt.format(new Date(now.getTime() - 86_400_000))) return words.yesterday;
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
}

/** The first page's size: the `limit` the web asks for on the Inbox and on "Behind the scenes". */
export const INBOX_PAGE = 50;
/** The most rows the hub gives in one page. */
export const INBOX_PAGE_MAX = 200;

/**
 * How many rows a load asks for: the first page, or, once the person has paged in beyond it, as many rows as they have (up to the
 * hub's most), so a refresh keeps their place.
 */
export function reloadLimit(loaded: number): number {
  return Math.min(Math.max(loaded, INBOX_PAGE), INBOX_PAGE_MAX);
}

/** Remember the questions the view holds under "Waiting for you" (the rows themselves): for the rest of the visit they stay there. */
export function pinWaiting(pinned: Map<string, InboxEntry>, view: Pick<InboxView, "questions">): void {
  for (const q of view.questions) pinned.set(q.id, q);
}

const newestFirst = (a: InboxEntry, b: InboxEntry): number => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.createdAt < b.createdAt ? 1 : -1);

/**
 * The view as the page shows it: "Waiting for you" and the by-day list. Reading a question makes the hub list it by its time
 * instead of under Waiting; one that was under Waiting earlier in this visit (`pinned`) stays there, newest first, and is not
 * in the by-day list. A pinned question comes from the view's entries when it is there (fresher), else as it was stored: with
 * enough newer rows it falls off the first page and is in neither list.
 */
export function splitWaiting(view: Pick<InboxView, "questions" | "entries">, pinned: ReadonlyMap<string, InboxEntry>): { waiting: InboxEntry[]; byDay: InboxEntry[] } {
  const asked = new Set(view.questions.map((q) => q.id));
  const listed = new Map(view.entries.map((e) => [e.id, e]));
  const held = [...pinned].filter(([id]) => !asked.has(id)).map(([id, stored]) => listed.get(id) ?? stored);
  return { waiting: [...view.questions, ...held].sort(newestFirst), byDay: view.entries.filter((e) => !pinned.has(e.id) && !asked.has(e.id)) };
}

/**
 * The page after `afterId` joined to the view, skipping rows already shown. The view is returned untouched when its last row is no
 * longer `afterId`: a refresh landed while the page was on its way, and this page would follow a different list.
 */
export function appendPage(view: InboxView, next: Pick<InboxView, "entries" | "hasMore">, afterId: string): InboxView {
  if (view.entries.at(-1)?.id !== afterId) return view;
  const shown = new Set(view.entries.map((e) => e.id));
  return { ...view, entries: [...view.entries, ...next.entries.filter((e) => !shown.has(e.id))], hasMore: next.hasMore };
}

/** Rows of a page of "Behind the scenes" added to those already shown (none when it starts afresh), each row once. */
export function mergeBehind(kept: BehindEntry[], page: BehindEntry[]): BehindEntry[] {
  const shown = new Set(kept.map((b) => b.id));
  return [...kept, ...page.filter((b) => !shown.has(b.id))];
}

/** The list of "Behind the scenes" is a bare array: a page as long as asked for (the hub may run it longer on a tie of times) may have more after it. */
export function behindMayHaveMore(page: readonly unknown[], limit: number = INBOX_PAGE): boolean {
  return page.length >= limit;
}

/** What the Inbox shows that the person has not been counted as seeing: unread and not yet sent to the hub as read. */
export function idsToMarkRead(view: Pick<InboxView, "questions" | "entries">, fresh: ReadonlySet<string>): string[] {
  return [...view.questions, ...view.entries].filter((e) => e.unread && !fresh.has(e.id)).map((e) => e.id);
}

export type BehindReason = "superseded" | "inDigest" | "inEarlierDigest" | "approval" | "waiting" | "silent";

/**
 * Why a row stayed behind the scenes: what became of it, and the hub's own reason (quiet hours, the rate limit, a muted
 * schedule…) when it has one. A replaced row and an approval push need no reason beyond their line. A row held for the
 * digest waits only while the hub says so; one that went into a digest with nothing to link (sent before digests were linked
 * to their items) went into an earlier one.
 */
export function behindWhy(b: Pick<BehindEntry, "supersededBy" | "digest" | "kind" | "level" | "reason" | "waiting">): { key: BehindReason; reason?: string } {
  if (b.supersededBy) return { key: "superseded" };
  const reason = b.reason ? { reason: b.reason } : {};
  if (b.digest) return { key: "inDigest", ...reason };
  if (b.kind === "approval") return { key: "approval" };
  if (b.waiting) return { key: "waiting", ...reason };
  return { key: b.level === "digest" ? "inEarlierDigest" : "silent", ...reason };
}

/** A notification that pops up as it arrives: an alert or a question that reached the person; nothing the hub held back (it says why). */
export function toastWorthy(n: Pick<Notification, "kind" | "reason">): boolean {
  return (n.kind === "alert" || n.kind === "question" || n.kind === "report" || n.kind === "digest") && !n.reason;
}
