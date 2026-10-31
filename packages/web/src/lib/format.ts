// Formatting helpers: status labels, relative times and dates in the interface language.

import type { TaskStatus } from "@piomio/shared";
import { formatDate, formatRelative, locale, t, type MessageKey } from "../i18n";
import { sizeParts } from "./attachments";

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const TASK_STATUS: Record<TaskStatus, { key: MessageKey; tone: Tone }> = {
  queued: { key: "taskStatus.queued", tone: "neutral" },
  running: { key: "taskStatus.running", tone: "info" },
  waiting_approval: { key: "taskStatus.waitingApproval", tone: "warning" },
  waiting_input: { key: "taskStatus.waitingInput", tone: "warning" },
  interrupted: { key: "taskStatus.interrupted", tone: "warning" },
  paused: { key: "taskStatus.paused", tone: "neutral" },
  done: { key: "taskStatus.done", tone: "success" },
  failed: { key: "taskStatus.failed", tone: "danger" },
  cancelled: { key: "taskStatus.cancelled", tone: "neutral" },
};

// A teammate's thread reads as a message: sent, answering, answered.
const THREAD_STATUS: Partial<Record<TaskStatus, { key: MessageKey; tone: Tone }>> = {
  queued: { key: "threadStatus.sent", tone: "neutral" },
  running: { key: "threadStatus.answering", tone: "info" },
  waiting_input: { key: "threadStatus.asksBack", tone: "warning" },
  done: { key: "threadStatus.answered", tone: "success" },
  failed: { key: "threadStatus.failed", tone: "danger" },
  interrupted: { key: "threadStatus.interrupted", tone: "warning" },
  cancelled: { key: "threadStatus.cancelled", tone: "neutral" },
};

/** Label and tone of a teammate's thread (team_message): the task's own label where a thread has none of its own. */
export function threadStatus(s: string): { label: string; tone: Tone } {
  const st = THREAD_STATUS[s as TaskStatus];
  return st ? { label: t(st.key), tone: st.tone } : taskStatus(s);
}

/** Label and badge tone of a task status (unknown statuses are shown as they are). */
export function taskStatus(s: string): { label: string; tone: Tone } {
  const st = TASK_STATUS[s as TaskStatus];
  return st ? { label: t(st.key), tone: st.tone } : { label: s, tone: "neutral" };
}

export const ACTIVE_STATUSES: TaskStatus[] = ["queued", "running", "waiting_approval", "waiting_input", "interrupted", "paused"];

/** "just now", "5 minutes ago", "in 2 hours", or a date for older values. */
export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const diff = ts - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return diff <= 0 ? t("time.justNow") : t("time.inAMinute");
  if (abs < 3_600_000) return formatRelative(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return formatRelative(Math.round(diff / 3_600_000), "hour");
  if (abs < 7 * 86_400_000) return formatRelative(Math.round(diff / 86_400_000), "day");
  return formatDateTime(iso);
}

export function formatDateTime(iso: string | undefined): string {
  return iso ? formatDate(iso, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
}

export function formatTime(iso: string | undefined): string {
  return iso ? formatDate(iso, { hour: "2-digit", minute: "2-digit" }) : "";
}

/** Compact time for lists: the time today, the weekday within the last week, otherwise the date. */
export function shortTime(iso: string | undefined, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  if (d.toDateString() === now.toDateString()) return formatTime(iso);
  const age = now.getTime() - d.getTime();
  if (age > 0 && age < 6 * 86_400_000) return formatDate(iso, { weekday: "short" });
  return formatDate(iso, { day: "numeric", month: "short" });
}

/** A one-time code in groups of four, easier to type: "ABCD-2345". */
export function groupedCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

/** Seconds left as m:ss. */
export function countdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Transliteration for ids made from Cyrillic names: U+0430..U+044F in alphabet order, then U+0451 (yo).
// Built from code points so the source stays ASCII (Cyrillic lives only in i18n/ru.ts).
const CYRILLIC_LATIN = ["a", "b", "v", "g", "d", "e", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p", "r", "s", "t", "u", "f", "h", "c", "ch", "sh", "sch", "", "y", "", "e", "yu", "ya"];
const TRANSLIT: Record<string, string> = Object.fromEntries([...CYRILLIC_LATIN.map((l, i) => [String.fromCharCode(0x430 + i), l]), [String.fromCharCode(0x451), "e"]]);

/** Lowercase slug for ids: latin letters, digits, dashes. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .split("")
    .map((c) => TRANSLIT[c] ?? c)
    .join("")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 40);
}

const SIZE_UNITS = { b: "units.bytes", kb: "units.kb", mb: "units.mb" } as const;

/** A file size in the interface language and its number format: 512 B, 47 KB, 1.2 MB. */
export function fileSize(bytes: number): string {
  const { n, unit } = sizeParts(bytes);
  return t(SIZE_UNITS[unit], { n: new Intl.NumberFormat(locale).format(n) });
}

/** 0:12, 1:12, 1:02:03 (a voice note's length). */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
