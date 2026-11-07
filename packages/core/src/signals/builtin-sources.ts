// Core's own signal sources, as an agent reads about them (trigger_sources) and as a test run samples them
// (trigger_test). A trigger keeps one of them as its kind and fields (validate.ts normalizeOn): time.cron is a
// schedule or a heartbeat, time.at a one-time reminder, web.page a watch, web.webhook an event. The signals they
// bring are built in engine.ts (tickSignal, pageSignal, hookSignal); a run now brings a `manual` one.

import type { TriggerSourceInfo } from "./host.ts";
import { builtinSignal } from "./pipeline.ts";
import type { Signal, Trigger } from "./types.ts";

export interface BuiltinSource extends TriggerSourceInfo {
  /** The trigger kinds it becomes. */
  kinds: Trigger["kind"][];
  /** The type of the signals it brings (time.cron and time.at bring time.tick). */
  signal: string;
}

const SAMPLE_SLOT = "2026-11-09T06:00:00.000Z";

export const BUILTIN_SOURCES_INFO: BuiltinSource[] = [
  {
    type: "time.cron",
    kinds: ["schedule", "heartbeat"],
    signal: "time.tick",
    source: "hub",
    description:
      "A recurring time in the person's timezone: cron (5 fields, e.g. '0 9 * * 1-5') makes a schedule; times ['HH:MM'] with weekdays (0 = Sunday) a heartbeat review. Each slot brings a time.tick signal; a slot missed while the hub was off comes once, as reason catch-up with missedAt.",
    config: {
      type: "object",
      properties: {
        cron: { type: "string" },
        times: { type: "array", items: { type: "string" } },
        weekdays: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 } },
      },
    },
    sample: { slot: SAMPLE_SLOT, reason: "schedule" },
    external: false,
    online: true,
  },
  {
    type: "time.at",
    kinds: ["once"],
    signal: "time.tick",
    source: "hub",
    description: "One moment, a reminder: at is an ISO datetime in the future (without an offset it is the person's local time). It brings one time.tick signal with reason once.",
    config: { type: "object", properties: { at: { type: "string" } }, required: ["at"] },
    sample: { slot: SAMPLE_SLOT, reason: "once" },
    external: false,
    online: true,
  },
  {
    type: "web.page",
    kinds: ["watch"],
    signal: "web.page",
    source: "hub",
    description:
      "A watched page or JSON address, read every intervalMinutes (at least 5): the text of a CSS selector, a jsonPath's value, or the whole page. The first read keeps a baseline; each change brings a web.page signal with the url, the previous and current values and a line diff (cut to fit 256 KB, then truncated: true). Outside content.",
    config: {
      type: "object",
      properties: { url: { type: "string" }, selector: { type: "string" }, jsonPath: { type: "string" }, intervalMinutes: { type: "number", minimum: 5 } },
      required: ["url"],
    },
    sample: { url: "https://shop.example.com/item", previous: "Price: 120", current: "Price: 99", diff: "- Price: 120\n+ Price: 99" },
    external: true,
    online: true,
  },
  {
    type: "web.webhook",
    kinds: ["event"],
    signal: "web.webhook",
    source: "hub",
    description:
      "A webhook address of the trigger's own. A sender proves itself with the trigger's secret (x-piomio-secret header or ?secret=), or verify signs every delivery: github (X-Hub-Signature-256), stripe (Stripe-Signature) or hmac-sha256 (the header it names, x-signature by default), the key kept in the vault as secretRef vault://<id>. Each delivery is answered 202 at once and brings a web.webhook signal: payload (the parsed JSON body, or its text), query, contentType. A delivery id (X-GitHub-Delivery, Idempotency-Key, x-piomio-delivery) is its key: a repeat within 24 h is dropped. Outside content.",
    config: {
      type: "object",
      properties: {
        verify: {
          type: "object",
          properties: { kind: { type: "string", enum: ["secret", "github", "stripe", "hmac-sha256"] }, secretRef: { type: "string" }, header: { type: "string" } },
        },
      },
    },
    sample: { payload: { action: "completed", status: "failure", repository: "acme/site" }, query: {}, contentType: "application/json" },
    external: true,
    online: true,
  },
];

/** A source's sample data as a signal, marked as outside content when the source's real ones are. */
export function sampleSignal(type: string, data: unknown, o: { external: boolean; source?: string; at: Date }): Signal {
  return { ...builtinSignal(type, data, { at: o.at, external: o.external }), source: o.source ?? "hub" };
}

/**
 * Sample signals for a trigger: one for its built-in source (fitted to its kind and fields), one for each subscription
 * whose source gives a sample. `missing`: the subscribed types with none.
 */
export function triggerSamples(t: Trigger, others: TriggerSourceInfo[], at: Date): { signals: Signal[]; missing: string[] } {
  const signals: Signal[] = [];
  const builtin = BUILTIN_SOURCES_INFO.find((b) => b.kinds.includes(t.kind));
  if (builtin) {
    let data = builtin.sample as Record<string, unknown>;
    if (builtin.signal === "time.tick") data = { slot: t.state.nextRunAt ?? at.toISOString(), reason: t.kind };
    if (t.kind === "watch") data = { ...data, url: t.url };
    signals.push({ ...sampleSignal(builtin.signal, data, { external: !!builtin.external, at }), ...(t.kind === "watch" && t.url ? { subject: t.url } : {}) });
  }
  const missing: string[] = [];
  for (const sub of t.on ?? []) {
    const info = others.find((s) => s.type === sub.type);
    if (!info || info.sample === undefined) missing.push(sub.type);
    else signals.push(sampleSignal(sub.type, info.sample, { external: info.external ?? true, source: info.source ?? sub.type.split(".")[0], at }));
  }
  return { signals, missing };
}
