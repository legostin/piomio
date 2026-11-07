import type { ErrorParams } from "./errors.ts";

export const TRIGGER_KINDS = ["schedule", "once", "watch", "event", "heartbeat"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

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
}
