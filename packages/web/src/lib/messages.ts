// Pure helpers for keeping a conversation's message list in sync with realtime events.

import type { Message, MessagePart } from "@piomio/shared";

/** Append streamed text the same way the hub runner does: extend the last text part or start a new one. */
export function appendDelta(parts: MessagePart[], delta: string): MessagePart[] {
  const last = parts[parts.length - 1];
  if (last && last.type === "text") return [...parts.slice(0, -1), { type: "text", text: last.text + delta }];
  return [...parts, { type: "text", text: delta }];
}

export function applyDelta(messages: Message[], ev: { id: string; delta: string }): Message[] {
  const i = messages.findIndex((m) => m.id === ev.id);
  if (i < 0) return messages;
  const m = messages[i];
  const next = messages.slice();
  next[i] = { ...m, parts: appendDelta(m.parts, ev.delta) };
  return next;
}

function byTime(a: Message, b: Message): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

/** Insert or replace a message, keeping chronological order. A quiet turn's reply stays out until it is kept. */
export function upsertMessage(messages: Message[], msg: Message): Message[] {
  if (msg.quiet) return removeMessage(messages, msg.id);
  const i = messages.findIndex((m) => m.id === msg.id);
  if (i >= 0) {
    const next = messages.slice();
    next[i] = msg;
    return next;
  }
  const last = messages[messages.length - 1];
  if (!last || byTime(last, msg) <= 0) return [...messages, msg];
  return [...messages, msg].sort(byTime);
}

/** A message taken back ("message.deleted"). */
export function removeMessage(messages: Message[], id: string): Message[] {
  return messages.some((m) => m.id === id) ? messages.filter((m) => m.id !== id) : messages;
}

export function textLength(m: Message): number {
  let n = 0;
  for (const p of m.parts) if (p.type === "text") n += p.text.length;
  return n;
}

/**
 * Merge a freshly fetched page (newest messages) with what we already have locally.
 * Local streaming messages that already received more text via deltas win over stale fetched copies.
 * Older local messages not in the fetched page are kept (they were loaded with "before=").
 */
export function mergeFetched(local: Message[], fetched: Message[]): Message[] {
  const localById = new Map(local.map((m) => [m.id, m]));
  const fetchedIds = new Set(fetched.map((m) => m.id));
  const oldest = fetched[0]?.createdAt;
  const out: Message[] = [];
  // Keep locally loaded history older than the fetched window.
  if (oldest) for (const m of local) if (m.createdAt < oldest && !fetchedIds.has(m.id)) out.push(m);
  for (const f of fetched) {
    if (f.quiet) continue;
    const l = localById.get(f.id);
    if (l && f.status === "streaming" && l.status === "streaming" && textLength(l) > textLength(f)) out.push(l);
    else out.push(f);
  }
  // Messages that arrived over the socket after the fetch started.
  const newest = fetched[fetched.length - 1]?.createdAt;
  for (const m of local) if (!fetchedIds.has(m.id) && (!oldest || (newest && m.createdAt > newest))) out.push(m);
  return dedupe(out).sort(byTime);
}

/** Prepend an older page (loaded with before=). */
export function prependOlder(current: Message[], older: Message[]): Message[] {
  return dedupe([...older, ...current]).sort(byTime);
}

function dedupe(list: Message[]): Message[] {
  const seen = new Set<string>();
  const out: Message[] = [];
  for (const m of list) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

export function isStreaming(messages: Message[]): boolean {
  return messages.some((m) => m.status === "streaming");
}

/** When the message last changed (older hubs send no updatedAt). */
export function changedAt(m: Message): string {
  return m.updatedAt ?? m.createdAt;
}

/** The newest change among `list`, or `mark` when nothing in it is newer: a dialog's mark after a fetch. */
export function newestChange(list: Message[], mark?: string): string | undefined {
  let out = mark;
  for (const m of list) if (!out || changedAt(m) > out) out = changedAt(m);
  return out;
}

/**
 * Where to ask from: a little before the mark, so a change written by a replica whose clock runs behind still comes
 * (what comes twice merges).
 */
export function askSince(mark: string, slackMs = 120_000): string {
  const t = Date.parse(mark);
  return Number.isFinite(t) ? new Date(t - slackMs).toISOString() : mark;
}

/**
 * What changed since the mark (GET …/messages?since=) merged into what the page shows: changed messages replace
 * theirs (a streaming one with more text here stays), new ones join, and one older than everything shown stays out
 * (the page would show it alone above a gap; scrolling up loads it).
 */
export function mergeChanges(local: Message[], changed: Message[]): Message[] {
  if (!changed.length) return local;
  let out = local;
  const oldest = local[0]?.createdAt;
  for (const c of changed) {
    const l = out.find((m) => m.id === c.id);
    if (l && c.status === "streaming" && l.status === "streaming" && textLength(l) > textLength(c)) continue;
    if (!l && !c.quiet && oldest && c.createdAt < oldest) continue;
    out = upsertMessage(out, c);
  }
  return out;
}

/**
 * The latest page from the hub against what the page had: when the page is full and shares nothing with what was
 * here, the older messages here would sit above a gap, so only those newer than the page (live ones) stay.
 */
export function joinLatest(local: Message[], fetched: Message[], page: number): { messages: Message[]; gap: boolean } {
  const newest = fetched[fetched.length - 1]?.createdAt;
  // What was here up to the page's newest message (later ones came over the socket meanwhile).
  const before = newest ? local.filter((m) => m.createdAt <= newest) : [];
  const gap = fetched.length >= page && before.length > 0 && !before.some((m) => m.createdAt >= fetched[0].createdAt);
  if (!gap) return { messages: mergeFetched(local, fetched), gap };
  return { messages: mergeFetched(local.filter((m) => m.createdAt > newest!), fetched), gap };
}
