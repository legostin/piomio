// The trigger model's signal fields: subscriptions, script, triage, batch, and the built-in source mapping.

import { describe, expect, it } from "vitest";
import { format } from "@piomio/shared";
import { coreCatalog } from "../../src/i18n.ts";
import type { Trigger } from "../../src/signals/types.ts";
import { whenText } from "../../src/signals/when.ts";
import { applyUpdate, buildTrigger, normalizeOn } from "../../src/signals/validate.ts";

const opts = { now: new Date("2026-10-26T10:00:00Z"), tz: "UTC", defaultAgent: "assistant", createdBy: "user" };
const upd = { now: opts.now, tz: "UTC" };
const mail = { type: "composio.gmail_new_message" };
const signal = (extra: Record<string, unknown> = {}) => buildTrigger({ kind: "signal", name: "Mail", prompt: "p", on: [mail], ...extra } as never, opts);
const bad = (code: string, fn: () => unknown) => expect(fn).toThrow(expect.objectContaining({ code }));

describe("signal triggers", () => {
  it("keeps on and the signal kind", () => {
    const t = buildTrigger({ kind: "signal", name: "Mail", prompt: "p", on: [{ ...mail, where: { path: "data.from", contains: "@client.com" } }] }, opts);
    expect(t.kind).toBe("signal");
    expect(t.on).toEqual([{ ...mail, where: { path: "data.from", contains: "@client.com" } }]);
  });

  it("stores script, triage, batch and the default triage limit", () => {
    const t = signal({ script: { code: "return {}", hosts: ["API.example.com", "*.example.org"] }, triage: { brief: " urgent only " }, batch: { windowSec: 60, max: 10 } });
    expect(t.script).toEqual({ code: "return {}", hosts: ["api.example.com", "*.example.org"] });
    expect(t.triage).toEqual({ brief: "urgent only" });
    expect(t.triagePerDay).toBe(200);
    expect(t.batch).toEqual({ windowSec: 60, max: 10 });
  });

  it("clears the fields with null on update", () => {
    const t = signal({ script: { code: "x", hosts: [] }, triage: { brief: "b" }, batch: { windowSec: 30 } });
    const n = applyUpdate(t, { script: null, triage: null, batch: null }, upd);
    expect(n.script).toBeUndefined();
    expect(n.triage).toBeUndefined();
    expect(n.triagePerDay).toBeUndefined();
    expect(n.batch).toBeUndefined();
  });
});

describe("normalizeOn", () => {
  const base = { name: "n", prompt: "p" };
  it("turns built-in sources into a kind and its fields", () => {
    expect(normalizeOn({ ...base, on: [{ type: "time.cron", config: { cron: "0 9 * * *" } }] })).toEqual({ ...base, kind: "schedule", cron: "0 9 * * *", on: [] });
    expect(normalizeOn({ ...base, on: [{ type: "time.cron", config: { times: ["09:00"], weekdays: [1] } }] })).toEqual({ ...base, kind: "heartbeat", times: ["09:00"], weekdays: [1], on: [] });
    expect(normalizeOn({ ...base, on: [{ type: "time.at", config: { at: "2026-11-01T09:00" } }] })).toEqual({ ...base, kind: "once", at: "2026-11-01T09:00", on: [] });
    expect(normalizeOn({ ...base, on: [{ type: "web.page", config: { url: "https://e.com", selector: "h1", intervalMinutes: 10 } }] })).toEqual({
      ...base, kind: "watch", url: "https://e.com", selector: "h1", intervalMinutes: 10, on: [],
    });
    expect(normalizeOn({ ...base, on: [{ type: "web.webhook", config: { verify: { kind: "hmac" } } }] })).toEqual({ ...base, kind: "event", verify: { kind: "hmac" }, on: [] });
    expect(normalizeOn({ ...base, on: [{ type: "web.webhook" }] })).toEqual({ ...base, kind: "event", on: [] });
  });

  it("leaves other subscriptions in on and input without built-ins alone", () => {
    const out = normalizeOn({ ...base, on: [{ type: "time.at", config: { at: "x" } }, mail] });
    expect(out.on).toEqual([mail]);
    const plain = { ...base, kind: "signal", on: [mail] };
    expect(normalizeOn(plain)).toBe(plain);
  });

  it("refuses two built-ins and a conflicting kind", () => {
    bad("onBuiltinTwice", () => normalizeOn({ ...base, on: [{ type: "time.at", config: {} }, { type: "web.webhook" }] }));
    bad("onKindConflict", () => normalizeOn({ ...base, kind: "watch", on: [{ type: "time.cron", config: { cron: "* * * * *" } }] }));
    expect(normalizeOn({ ...base, kind: "schedule", on: [{ type: "time.cron", config: { cron: "0 9 * * *" } }] }).kind).toBe("schedule");
  });

  it("builds a trigger from a normalized built-in source", () => {
    const t = buildTrigger(normalizeOn({ name: "n", prompt: "p", on: [{ type: "web.webhook", config: { verify: { kind: "hmac" } } }] }), opts);
    expect(t.kind).toBe("event");
    expect(t.verify).toEqual({ kind: "hmac" });
    expect(t.on).toBeUndefined();
  });
});

describe("validation", () => {
  const sig = (extra: Record<string, unknown>) => () => signal(extra);
  it("rejects bad subscriptions", () => {
    bad("onTooMany", () => buildTrigger({ kind: "signal", name: "n", prompt: "p", on: Array.from({ length: 21 }, () => mail) }, opts));
    bad("onType", () => buildTrigger({ kind: "signal", name: "n", prompt: "p", on: [{ type: "Bad Type" }] }, opts));
    bad("onType", () => buildTrigger({ kind: "signal", name: "n", prompt: "p", on: [{ type: "nodot" }] }, opts));
    bad("onKindConflict", () => buildTrigger({ kind: "signal", name: "n", prompt: "p", on: [{ type: "time.cron" }] }, opts));
    bad("signalNeedsOn", () => buildTrigger({ kind: "signal", name: "n", prompt: "p" }, opts));
    bad("signalNeedsOn", () => buildTrigger({ kind: "signal", name: "n", prompt: "p", on: [] }, opts));
    bad("signalNeedsOn", () => applyUpdate(signal(), { on: null }, upd));
    bad("whereInvalid", () => buildTrigger({ kind: "signal", name: "n", prompt: "p", on: [{ ...mail, where: { path: "a" } as never }] }, opts));
    bad("configTooBig", () => buildTrigger({ kind: "signal", name: "n", prompt: "p", on: [{ ...mail, config: { x: "a".repeat(9000) } }] }, opts));
  });

  it("rejects bad batch, script, triage", () => {
    bad("batchWindow", sig({ batch: { windowSec: 4 } }));
    bad("batchWindow", sig({ batch: { windowSec: 3601 } }));
    bad("batchMax", sig({ batch: { windowSec: 10, max: 0 } }));
    bad("batchMax", sig({ batch: { windowSec: 10, max: 501 } }));
    bad("scriptTooBig", sig({ script: { code: "a".repeat(64 * 1024 + 1), hosts: [] } }));
    bad("hostsTooMany", sig({ script: { code: "x", hosts: Array.from({ length: 31 }, (_, i) => `h${i}.example.com`) } }));
    for (const host of ["https://example.com", "example.com:8080", "example.com/path", "10.0.0.1", "192.168.1.5", "localhost", "*.10.0.0.1", "a b.com", ""])
      bad("hostInvalid", sig({ script: { code: "x", hosts: [host] } }));
    bad("briefRequired", sig({ triage: { brief: "  " } }));
    bad("briefTooLong", sig({ triage: { brief: "a".repeat(2001) } }));
    bad("triageLimit", sig({ triage: { brief: "b" }, triagePerDay: 0 }));
    bad("triageLimit", sig({ triage: { brief: "b" }, triagePerDay: 2001 }));
  });

  it("accepts the boundaries", () => {
    expect(() => signal({ batch: { windowSec: 5, max: 1 } })).not.toThrow();
    expect(() => signal({ batch: { windowSec: 3600, max: 500 } })).not.toThrow();
    expect(() => signal({ triage: { brief: "a".repeat(2000) }, triagePerDay: 2000 })).not.toThrow();
  });
});

describe("view text", () => {
  const t: Trigger = signal();
  const tr = (l: "en" | "ru") => (key: string, params?: Record<string, string | number>) => format((coreCatalog[l] as Record<string, string>)[`triggers.${key}`] ?? key, params, l);
  it("says when a signal trigger runs", () => {
    const x = { ...t, on: [{ type: "x.y" }] };
    expect(whenText(x, tr("en"), "en", "UTC")).toBe("When x.y arrives");
    expect(whenText(x, tr("ru"), "ru", "UTC")).toBe("Когда приходит x.y");
  });
});

describe("old triggers", () => {
  it("pass an update unchanged by the new fields", () => {
    const old = buildTrigger({ kind: "schedule", name: "s", prompt: "p", cron: "0 9 * * *" }, opts);
    const n = applyUpdate(old, { name: "s2" }, upd);
    expect(n).toEqual({ ...old, name: "s2", updatedAt: n.updatedAt });
    expect(n.on).toBeUndefined();
    expect(n.script).toBeUndefined();
  });
});
