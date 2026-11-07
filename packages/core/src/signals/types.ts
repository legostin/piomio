import type { ErrorParams } from "./errors.ts";
import type { Match } from "./match.ts";

export const TRIGGER_KINDS = ["schedule", "once", "watch", "event", "heartbeat", "signal"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** Sources a trigger carries as its kind and fields; `on` names them only in input (normalizeOn). */
export const BUILTIN_SOURCES = ["time.cron", "time.at", "web.page", "web.webhook"] as const;

/** A subscription to a signal type, optionally narrowed by a declarative filter. */
export interface Subscription {
  type: string;
  config?: Record<string, unknown>;
  where?: Match;
}

/** Something that happened, as the pipeline sees it. */
export interface Signal {
  id: string;
  type: string;
  source: string;
  at: string;
  data: unknown;
  key?: string;
  subject?: string;
  external: boolean;
}

/** What a trigger's script (or the triage step) decides. */
export type Verdict = { drop: string } | { note: string } | { wake: string; context?: unknown } | { triage: unknown };
export type Outcome = "drop" | "note" | "wake";

/** One step of a run through the pipeline, for the journal. */
export interface StageRecord {
  stage: "match" | "dedup" | "batch" | "script" | "triage" | "outcome";
  verdict?: string;
  why?: string;
  ms?: number;
  error?: string;
  logs?: string[];
  tokens?: number;
}

export type RunReason = "schedule" | "catch-up" | "once" | "change" | "webhook" | "heartbeat" | "manual";

export interface TriggerState {
  /** Next planned firing (ISO). Persisted so missed runs can be detected after a restart. */
  nextRunAt?: string;
  /** The planned time (ISO) of the last slot that fired, so a slot never fires twice. */
  lastSlot?: string;
  lastRunAt?: string;
  lastStatus?: "ok" | "error" | "skipped";
  /** English text (tools, logs); the UI shows "error.<lastErrorCode>" from the catalog when there is a code. */
  lastError?: string;
  lastErrorCode?: string;
  lastErrorParams?: ErrorParams;
  /**
   * The last error came from a script run that had read outside content (TriggerRun.external): its text may carry that
   * content, so the tools and the notification show a fixed line instead, and trigger_runs shows it marked.
   */
  lastErrorExternal?: boolean;
  lastTaskId?: string;
  /** Runs started today (local date in the user's timezone). */
  runsToday?: { date: string; count: number };
  /** once: already fired. */
  done?: boolean;
  /** watch: last poll, extracted value and its hash. */
  lastCheckedAt?: string;
  lastValue?: string;
  lastHash?: string;
  lastChangeAt?: string;
  lastFeedback?: { value: "useful" | "less" | "off"; at: string };
  /**
   * Signals: consecutive failed pipeline runs, and the quick-model checks used today. What changes with every signal
   * (seen delivery keys, the filter's count, the open batch, the queue) is in trigger_state instead (pipeline.ts).
   */
  errorsInRow?: number;
  triageToday?: { date: string; count: number };
}

export interface Trigger {
  id: string;
  kind: TriggerKind;
  name: string;
  prompt: string;
  agentId: string;
  enabled: boolean;
  maxRunsPerDay: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  /** The computer the runs happen on (a machines.list id, "local" for the hub's own) and its name; unset: the agent's usual brain. */
  machine?: string;
  machineName?: string;
  /** schedule, once: each run's final reply is a report delivered to the user as is (no notify levels). */
  report?: boolean;
  /** A skill every run follows (one the person taught by showing): its tasks carry it (Task.skill). */
  skill?: string;
  /** schedule: 5-field cron in the user's timezone. */
  cron?: string;
  /** once: ISO datetime. */
  at?: string;
  /** watch */
  url?: string;
  selector?: string;
  jsonPath?: string;
  intervalMinutes?: number;
  /** event: shared secret for the public webhook. */
  secret?: string;
  /** heartbeat: local "HH:MM" slots and ISO weekdays (0 = Sunday … 6 = Saturday). */
  times?: string[];
  weekdays?: number[];
  /** Subscriptions to non-built-in sources (kind "signal" needs at least one). */
  on?: Subscription[];
  /** Collect signals for windowSec seconds (at most max) and handle them as one run. */
  batch?: { windowSec: number; max?: number };
  /** Code that looks at signals and returns a Verdict; fetches only from `hosts`. */
  script?: { code: string; hosts: string[] };
  /** A quick-model check with this brief, run when the script has no verdict (or there is none). */
  triage?: { brief: string };
  triagePerDay?: number;
  /** web.webhook: how the sender is verified (set from the web.webhook config); none: the stored `secret`. */
  verify?: { kind: "secret" } | { kind: "github" | "stripe" | "hmac-sha256"; secretRef: string; header?: string };
  state: TriggerState;
}

export interface TriggerRun {
  id: string;
  at: string;
  reason: RunReason;
  status: "started" | "skipped" | "error";
  taskId?: string;
  /** English text (tools, webhook responses); the UI shows "error.<code>" from the catalog when there is a code. */
  detail?: string;
  code?: string;
  params?: ErrorParams;
  signals?: Array<{ id: string; type: string; subject?: string }>;
  stages?: StageRecord[];
  outcome?: Outcome;
  noteId?: string;
  external?: boolean;
  /** The same error in a row is one line: how many runs ended with it, and when the last did (ISO). */
  count?: number;
  lastAt?: string;
}

/** Fields accepted from tools and the UI for create / update. */
export interface TriggerInput {
  kind?: string;
  name?: string;
  prompt?: string;
  agent?: string;
  agentId?: string;
  enabled?: boolean;
  maxRunsPerDay?: number;
  /** A computer's id or name; null or "" clears it. */
  machine?: string | null;
  /** A skill's name; null or "" clears it. */
  skill?: string | null;
  /** schedule, once: true when each run's final reply is a report delivered as is; unset takes the default. */
  report?: boolean;
  cron?: string;
  at?: string;
  url?: string;
  selector?: string | null;
  jsonPath?: string | null;
  intervalMinutes?: number;
  times?: string[];
  weekdays?: number[];
  /** Subscriptions; null clears them. Built-in sources (see BUILTIN_SOURCES) become the kind and its fields in normalizeOn. */
  on?: Subscription[] | null;
  batch?: { windowSec: number; max?: number } | null;
  script?: { code: string; hosts?: string[] } | null;
  triage?: { brief: string } | null;
  triagePerDay?: number | null;
  /** web.webhook: sender verification, set by normalizeOn from the web.webhook config. */
  verify?: unknown;
}
