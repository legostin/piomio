// Triggers in the web UI: the hub's API for them, the shapes it answers, and the words for what they hold and what
// their runs came to (a run's stages, a filter, an error code). Pure: the Triggers section draws what this returns.

import type { UiEvent } from "@piomio/shared";
import { catalog, formatDate, formatNumber, t, type MessageKey } from "../i18n";
import { formatDateTime, type Tone } from "./format";

/** Where the hub serves triggers (core `/api/triggers/*`; `/api/plugins/triggers/http/triggers/*` is the old alias). */
export const TRIGGERS_API = "/api/triggers";

/** A trigger's address, or one of its actions (run, runs, check). */
export function triggerUrl(id?: string, sub?: "run" | "runs" | "check"): string {
  if (!id) return TRIGGERS_API;
  return `${TRIGGERS_API}/${encodeURIComponent(id)}${sub ? `/${sub}` : ""}`;
}

/** The trigger a hub event says changed: its id, "" for some trigger, undefined when the event is about something else. */
export function changedTrigger(e: UiEvent): string | undefined {
  if (e.type !== "plugin.event" || e.data.pluginId !== "triggers" || e.data.channel !== "changed") return undefined;
  const id = (e.data.payload as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : "";
}

export type TriggerKind = "schedule" | "once" | "watch" | "event" | "heartbeat" | "signal";
export type ErrorParams = Record<string, string | number>;

/** A subscription to a signal type, narrowed by an optional filter (core signals/match.ts). */
export interface Subscription {
  type: string;
  config?: Record<string, unknown>;
  where?: unknown;
}

export type WebhookVerify = { kind: "secret" } | { kind: "github" | "stripe" | "hmac-sha256"; secretRef: string; header?: string };

/** A trigger as the hub shows it (core signals/http.ts `view`). */
export interface TriggerView {
  id: string;
  kind: TriggerKind;
  name: string;
  prompt: string;
  agentId: string;
  enabled: boolean;
  maxRunsPerDay: number;
  machine?: string;
  machineName?: string;
  skill?: string;
  report?: boolean;
  cron?: string;
  at?: string;
  url?: string;
  selector?: string;
  jsonPath?: string;
  intervalMinutes?: number;
  /** event: the shared secret the hub checks when there is no signature to check (`verify`). */
  secret?: string;
  /**
   * event: how the hub checks the sender (core signals/types.ts). The signing kinds name the key's vault reference, never
   * the key; without `verify` (or with "secret") it is the shared secret.
   */
  verify?: WebhookVerify;
  times?: string[];
  weekdays?: number[];
  on: Subscription[];
  batch: { windowSec: number; max?: number } | null;
  script: { code: string; hosts: string[] } | null;
  triage: { brief: string } | null;
  triagePerDay: number | null;
  nextRunAt: string | null;
  webhookUrl: string | null;
  /** When it runs, in the reader's language. */
  whenText: string;
  /** The last error in the reader's language (a code's catalog text, else as the engine or the check wrote it). */
  lastErrorText: string | null;
  state: {
    lastRunAt?: string;
    lastStatus?: "ok" | "error" | "skipped";
    lastErrorCode?: string;
    /** The last error came from a run that read outside content (TriggerRun.external): its text may carry that content. */
    lastErrorExternal?: boolean;
    lastCheckedAt?: string;
    lastValue?: string;
    done?: boolean;
  };
}

/** One step of a run through the pipeline. */
export interface StageRecord {
  stage: "match" | "dedup" | "batch" | "script" | "triage" | "outcome";
  verdict?: string;
  why?: string;
  ms?: number;
  error?: string;
  logs?: string[];
  tokens?: number;
}

/** A run in the journal (core signals/types.ts TriggerRun, with its task's status). */
export interface TriggerRun {
  id: string;
  at: string;
  reason: string;
  status: "started" | "skipped" | "error";
  outcome?: "note" | "wake" | "drop";
  taskId?: string;
  taskStatus?: string;
  detail?: string;
  code?: string;
  params?: ErrorParams;
  signals?: Array<{ id: string; type: string; subject?: string }>;
  stages?: StageRecord[];
  noteId?: string;
  /** It read outside content (a page, a webhook, a letter): its words may carry that content. */
  external?: boolean;
  /** The same error in a row is one line: how many runs ended with it, and when the last did. */
  count?: number;
  lastAt?: string;
}

export interface TriggersList {
  triggers: TriggerView[];
  timezone: string;
  agents: Array<{ id: string; name: string }>;
  /** The computers runs can happen on, the hub's own first. */
  computers?: Array<{ id: string; name: string; status: string }>;
}

/** What a request loaded (null before the first answer) and why the last one failed, if it did. */
export interface Loaded<T> {
  value: T | null;
  error?: string;
}

/** After a request: its answer replaces what was loaded; a failure keeps what was loaded and says why. */
export function afterLoad<T>(prev: Loaded<T>, outcome: { value: T } | { error: string }): Loaded<T> {
  return "error" in outcome ? { value: prev.value, error: outcome.error } : { value: outcome.value };
}

/** The line a failed load shows: nothing loaded yet, or what is shown is from before (it could not refresh). */
export function loadNote(what: "triggers" | "journal", l: Loaded<unknown>): string | undefined {
  if (!l.error) return undefined;
  if (l.value !== null) return t("triggers.refreshFailed", { error: l.error });
  return what === "journal" ? t("triggers.journal.loadFailed", { error: l.error }) : t("triggers.loadFailed", { error: l.error });
}

/** The hub's trigger settings (core settings.ts), which the Triggers section's settings part shows. */
export interface TriggerSettings {
  triggersAllowPrivateUrls: boolean;
  triggersWatchTimeoutSec: number;
}

/** A watch's page load timeout, whole seconds (core settings.ts TRIGGERS_WATCH_TIMEOUT). */
export const WATCH_TIMEOUT = { min: 1, max: 120 };

/** What Save sends: the settings that changed; or, for a timeout that is not a whole number in range, why not. */
export function settingsPatch(orig: TriggerSettings, allowPrivate: boolean, timeout: string): { patch: Partial<TriggerSettings> } | { error: string } {
  const n = timeout.trim() ? Number(timeout) : NaN;
  if (!Number.isInteger(n) || n < WATCH_TIMEOUT.min || n > WATCH_TIMEOUT.max) return { error: t("settings.error.integer", { field: t("triggers.settings.timeoutName"), ...WATCH_TIMEOUT }) };
  const patch: Partial<TriggerSettings> = {};
  if (allowPrivate !== orig.triggersAllowPrivateUrls) patch.triggersAllowPrivateUrls = allowPrivate;
  if (n !== orig.triggersWatchTimeoutSec) patch.triggersWatchTimeoutSec = n;
  return { patch };
}

/** The kinds the form makes; a signal trigger is made in the chat (it needs `on`). */
export const FORM_KINDS: TriggerKind[] = ["schedule", "once", "watch", "event", "heartbeat"];

export const KIND_LABEL: Record<TriggerKind, MessageKey> = {
  schedule: "triggers.kind.schedule",
  once: "triggers.kind.once",
  watch: "triggers.kind.watch",
  event: "triggers.kind.event",
  heartbeat: "triggers.kind.heartbeat",
  signal: "triggers.kind.signal",
};

export const KIND_HINT: Record<TriggerKind, MessageKey> = {
  schedule: "triggers.kindHint.schedule",
  once: "triggers.kindHint.once",
  watch: "triggers.kindHint.watch",
  event: "triggers.kindHint.event",
  heartbeat: "triggers.kindHint.heartbeat",
  signal: "triggers.kindHint.signal",
};

/** A catalog message by a key built at run time, or undefined when the catalog (English, the source of truth) has none. */
function known(key: string, params?: ErrorParams): string | undefined {
  return key in catalog.en ? t(key as MessageKey, params) : undefined;
}

/** Why a run happened ("scheduled", "manually"…); an unknown reason as it is. */
export function reasonText(reason: string): string {
  return known(`triggers.reason.${reason}`) ?? reason;
}

/**
 * An error from the engine in the interface language: the catalog message for its code, else its own words, labelled:
 * the trigger's check (its script, the engine) writes in English, and that is shown as written.
 */
export function errorMessage(code: string | undefined, params: ErrorParams | undefined, fallback: string | undefined): string {
  const text = code ? known(`triggers.error.${code}`, params) : undefined;
  if (text) return text;
  return fallback ? t("triggers.run.asWritten", { text: fallback }) : "";
}

/**
 * A trigger's last error for its page: the hub's text (a code's catalog message as is, the engine's or the check's own
 * words labelled), and whether the run it came from read outside content, so the page marks it as the journal does.
 */
export function lastErrorLine(tr: Pick<TriggerView, "lastErrorText" | "state">): { text: string; external: boolean } | undefined {
  if (!tr.lastErrorText) return undefined;
  return { text: tr.state.lastErrorCode ? tr.lastErrorText : t("triggers.run.asWritten", { text: tr.lastErrorText }), external: tr.state.lastErrorExternal === true };
}

/** A run's badge: what came of it when it started nothing (a note, a drop), else how it went. */
export function runBadge(r: Pick<TriggerRun, "status" | "outcome">): { label: string; tone: Tone } {
  if (r.status !== "error" && r.outcome === "note") return { label: t("triggers.run.note"), tone: "info" };
  if (r.status !== "error" && r.outcome === "drop") return { label: t("triggers.run.drop"), tone: "neutral" };
  if (r.status === "started") return { label: t("triggers.run.started"), tone: "success" };
  if (r.status === "skipped") return { label: t("triggers.run.skipped"), tone: "warning" };
  return { label: t("triggers.run.error"), tone: "danger" };
}

/** A trigger's state as a badge; undefined while it simply works (the list stays quiet). */
export function statusBadge(tr: Pick<TriggerView, "kind" | "enabled" | "state">): { label: string; tone: Tone } | undefined {
  if (tr.kind === "once" && tr.state.done) return { label: t("triggers.status.done"), tone: "neutral" };
  if (!tr.enabled) return { label: t("triggers.status.off"), tone: "neutral" };
  if (tr.state.lastStatus === "error") return { label: t("triggers.status.error"), tone: "danger" };
  if (tr.state.lastStatus === "skipped") return { label: t("triggers.status.skipped"), tone: "warning" };
  return undefined;
}

/**
 * What the run-now answer says, for a toast, and whether it went well. The hub's `text` is the catalog's message for a
 * code, in the reader's language; without a code it is the check's own words, labelled as the journal labels them.
 */
export function runNowText(r: Partial<TriggerRun> & { text?: string }): { text: string; ok: boolean } {
  if (r.status === "started" && r.outcome === "note") return { text: t("triggers.action.noted"), ok: true };
  if (r.status === "started" && r.outcome === "drop") return { text: t("triggers.action.dropped"), ok: true };
  if (r.status === "started") return { text: t("triggers.action.started"), ok: true };
  const reason = r.code ? (r.text ?? errorMessage(r.code, r.params, r.detail)) : errorMessage(undefined, r.params, r.detail ?? r.text);
  return { text: t("triggers.action.notStarted", { reason }), ok: false };
}

/** What a watch's check found, for a toast. */
export function checkText(r: { changed?: boolean; baseline?: boolean; error?: string; code?: string; params?: ErrorParams }): { text: string; ok: boolean } {
  if (r.error) return { text: t("triggers.action.checkError", { error: errorMessage(r.code, r.params, r.error) }), ok: false };
  if (r.changed) return { text: t("triggers.action.changed"), ok: true };
  if (r.baseline) return { text: t("triggers.action.baseline"), ok: true };
  return { text: t("triggers.action.unchanged"), ok: true };
}

/** The built-in source a trigger's kind stands for; a signal trigger has only its subscriptions. */
export function builtinSource(kind: TriggerKind): string | undefined {
  switch (kind) {
    case "schedule":
    case "heartbeat":
      return "time.cron";
    case "once":
      return "time.at";
    case "watch":
      return "web.page";
    case "event":
      return "web.webhook";
    default:
      return undefined;
  }
}

/** The signing kinds by their senders' names and the header each signature comes in (core signals/webhook-verify.ts). */
const SIGNATURE: Record<"github" | "stripe" | "hmac-sha256", { name: string; header: string }> = {
  github: { name: "GitHub", header: "x-hub-signature-256" },
  stripe: { name: "Stripe", header: "stripe-signature" },
  "hmac-sha256": { name: "HMAC-SHA256", header: "x-signature" },
};

/**
 * What a webhook delivery must carry for the hub to take it: the shared secret (shown hidden, to copy), or a signature
 * made with a key kept in the vault, in words; undefined when the trigger has neither.
 */
export function webhookCheck(tr: Pick<TriggerView, "secret" | "verify">): { kind: "secret"; secret: string } | { kind: "signed"; text: string } | undefined {
  const v = tr.verify;
  if (v && v.kind !== "secret") {
    const s = SIGNATURE[v.kind];
    return s ? { kind: "signed", text: t("triggers.detail.signature", { name: s.name, header: (v.kind === "hmac-sha256" && v.header) || s.header }) } : undefined;
  }
  return tr.secret ? { kind: "secret", secret: tr.secret } : undefined;
}

/** A source's name in the person's words ("When a task finishes"); undefined for a type the catalog does not know. */
export function sourceLabel(type: string): string | undefined {
  return known(`triggers.source.${type}`);
}

/** A value of a filter or a config, short: strings in quotes, lists and objects as JSON. */
function shown(v: unknown, max = 80): string {
  const s = typeof v === "string" ? JSON.stringify(v) : (JSON.stringify(v) ?? String(v));
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A source's settings, one "key: value" each. */
export function configLines(config: Record<string, unknown> | undefined): string[] {
  if (!config) return [];
  return Object.entries(config)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : shown(v)}`);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A filter (where) in words: "subject contains "invoice" and (from is "a" or from is "b")". */
export function describeMatch(m: unknown): string {
  if (!isObject(m)) return "";
  const group = (list: unknown[], key: "triggers.match.and" | "triggers.match.or") => {
    const parts = list.map((x) => (isObject(x) && (Array.isArray(x.all) || Array.isArray(x.any)) ? `(${describeMatch(x)})` : describeMatch(x))).filter(Boolean);
    return parts.length ? parts.reduce((a, b) => t(key, { a, b })) : "";
  };
  if (Array.isArray(m.all)) return group(m.all, "triggers.match.and");
  if (Array.isArray(m.any)) return group(m.any, "triggers.match.or");
  if ("not" in m) return t("triggers.match.not", { x: describeMatch(m.not) });
  const path = typeof m.path === "string" ? m.path : "";
  if ("eq" in m) return t("triggers.match.eq", { path, value: shown(m.eq) });
  if ("ne" in m) return t("triggers.match.ne", { path, value: shown(m.ne) });
  if ("contains" in m) return t("triggers.match.contains", { path, value: shown(m.contains) });
  if ("matches" in m) return t("triggers.match.matches", { path, value: `/${String(m.matches)}/${typeof m.flags === "string" ? m.flags : ""}` });
  if ("in" in m) return t("triggers.match.in", { path, values: shown(m.in) });
  if ("exists" in m) return t(m.exists === false ? "triggers.match.missing" : "triggers.match.exists", { path });
  if ("gt" in m) return t("triggers.match.gt", { path, value: shown(m.gt) });
  if ("lt" in m) return t("triggers.match.lt", { path, value: shown(m.lt) });
  return shown(m);
}

const STAGE_LABEL: Record<StageRecord["stage"], MessageKey> = {
  match: "triggers.stage.match",
  dedup: "triggers.stage.dedup",
  batch: "triggers.stage.batch",
  script: "triggers.stage.script",
  triage: "triggers.stage.triage",
  outcome: "triggers.stage.outcome",
};

const VERDICT_TONE: Record<string, Tone> = { drop: "neutral", note: "info", wake: "success", triage: "info", unavailable: "warning" };

/** One stage of a run, ready to draw: its name, its verdict as a badge, and the details it carries. */
export interface StageLine {
  label: string;
  verdict?: { label: string; tone: Tone };
  why?: string;
  error?: string;
  /** How long it took and what it cost ("12 ms · 40 tokens"). */
  cost?: string;
  logs: string[];
}

/** "12 ms", "1.4 s" in the interface language. */
export function formatMs(ms: number): string {
  if (Math.round(ms) < 1000) return formatNumber(Math.round(ms), { style: "unit", unit: "millisecond", unitDisplay: "short" });
  return formatNumber(Math.round(ms / 100) / 10, { style: "unit", unit: "second", unitDisplay: "short" });
}

export function stageLines(stages: StageRecord[] | undefined): StageLine[] {
  return (stages ?? []).map((s) => {
    const cost = [s.ms !== undefined ? formatMs(s.ms) : "", s.tokens ? t("triggers.stage.tokens", { n: s.tokens }) : ""].filter(Boolean).join(" · ");
    const verdict = s.verdict ? { label: known(`triggers.verdict.${s.verdict}`) ?? s.verdict, tone: VERDICT_TONE[s.verdict] ?? "neutral" } : s.error !== undefined ? { label: t("triggers.run.error"), tone: "danger" as Tone } : undefined;
    return {
      label: STAGE_LABEL[s.stage] ? t(STAGE_LABEL[s.stage]) : s.stage,
      ...(verdict ? { verdict } : {}),
      ...(s.why ? { why: s.why } : {}),
      ...(s.error ? { error: s.error } : {}),
      ...(cost ? { cost } : {}),
      logs: s.logs ?? [],
    };
  });
}

/** An instant in the hub's time zone (the zone the trigger's times are in), short; the browser's own zone if it is unknown. */
export function formatAt(iso: string | null | undefined, tz: string): string {
  if (!iso) return "";
  try {
    return formatDate(iso, { timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return formatDateTime(iso);
  }
}

/** ISO instant → "YYYY-MM-DDTHH:MM" wall clock in tz, for <input type="datetime-local">. */
export function toLocalInput(iso: string | undefined, tz: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** "10:00, 18:00" or "10:00 18:00" → ["10:00", "18:00"]. */
export function parseTimes(text: string): string[] {
  return text
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Form order of weekdays: Monday first, Sunday last (0 = Sunday). */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** A short weekday name in the interface language (0 = Sunday), capitalised; 2026-10-25 is a Sunday. */
export function weekdayName(d: number): string {
  const name = formatDate(Date.UTC(2026, 9, 25 + d, 12), { weekday: "short", timeZone: "UTC" });
  return name.charAt(0).toUpperCase() + name.slice(1);
}
