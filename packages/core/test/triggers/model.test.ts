// The trigger model's signal fields: subscriptions, script, triage, batch, and the built-in source mapping.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { format } from "@piomio/shared";
import { coreCatalog } from "../../src/i18n.ts";
import { TRIGGER_KINDS, type Trigger } from "../../src/signals/types.ts";
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
    expect(normalizeOn({ ...base, on: [{ type: "web.webhook", config: { verify: { kind: "github", secretRef: "vault://gh" } } }] })).toEqual({ ...base, kind: "event", verify: { kind: "github", secretRef: "vault://gh" }, on: [] });
    expect(normalizeOn({ ...base, on: [{ type: "web.webhook" }] })).toEqual({ ...base, kind: "event", on: [] });
  });

  it("leaves other subscriptions in on and input without built-ins alone", () => {
    const out = normalizeOn({ ...base, on: [{ type: "time.at", config: { at: "x" } }, mail] });
    expect(out.on).toEqual([mail]);
    const plain = { ...base, kind: "signal", on: [mail] };
    expect(normalizeOn(plain)).toBe(plain);
    // A new trigger with only other sources' subscriptions is a signal trigger; a change keeps its trigger's kind.
    expect(normalizeOn({ ...base, on: [mail] }, { create: true }).kind).toBe("signal");
    expect(normalizeOn({ ...base, on: [mail] }).kind).toBeUndefined();
  });

  it("refuses a filter on a built-in source, which its kind could not keep", () => {
    bad("onWhereBuiltin", () => normalizeOn({ ...base, on: [{ type: "web.webhook", where: { path: "data.payload.kind", eq: "push" } }] }));
  });

  it("refuses two built-ins and a conflicting kind", () => {
    bad("onBuiltinTwice", () => normalizeOn({ ...base, on: [{ type: "time.at", config: {} }, { type: "web.webhook" }] }));
    bad("onKindConflict", () => normalizeOn({ ...base, kind: "watch", on: [{ type: "time.cron", config: { cron: "* * * * *" } }] }));
    expect(normalizeOn({ ...base, kind: "schedule", on: [{ type: "time.cron", config: { cron: "0 9 * * *" } }] }).kind).toBe("schedule");
  });

  it("refuses fields that disagree with the source config, and cron with times", () => {
    const base = { name: "n", prompt: "p" };
    bad("onFieldConflict", () => normalizeOn({ ...base, cron: "0 8 * * *", on: [{ type: "time.cron", config: { cron: "0 9 * * *" } }] }));
    bad("onFieldConflict", () => normalizeOn({ ...base, url: "https://a.com", on: [{ type: "web.page", config: { url: "https://b.com" } }] }));
    expect(normalizeOn({ ...base, cron: "0 9 * * *", on: [{ type: "time.cron", config: { cron: "0 9 * * *" } }] }).cron).toBe("0 9 * * *");
    bad("cronAndTimes", () => normalizeOn({ ...base, on: [{ type: "time.cron", config: { cron: "0 9 * * *", times: ["09:00"] } }] }));
    bad("cronAndTimes", () => normalizeOn({ ...base, cron: "0 9 * * *", on: [{ type: "time.cron", config: { times: ["09:00"] } }] }));
  });

  it("refuses cron with weekdays: they would turn it into a 10:00 and 18:00 review and drop the cron", () => {
    const base = { name: "n", prompt: "p" };
    bad("cronAndWeekdays", () => normalizeOn({ ...base, on: [{ type: "time.cron", config: { cron: "0 9 * * *", weekdays: [1, 2] } }] }));
    bad("cronAndWeekdays", () => normalizeOn({ ...base, weekdays: [1], on: [{ type: "time.cron", config: { cron: "0 9 * * *" } }] }));
    bad("cronAndWeekdays", () => normalizeOn({ ...base, cron: "0 9 * * *", on: [{ type: "time.cron", config: { weekdays: [1] } }] }));
    bad("cronAndWeekdays", () => normalizeOn({ ...base, kind: "schedule", on: [{ type: "time.cron", config: { cron: "0 9 * * 1-5", weekdays: [1] } }] }));
    expect(normalizeOn({ ...base, on: [{ type: "time.cron", config: { cron: "0 9 * * 1-5" } }] })).toMatchObject({ kind: "schedule", cron: "0 9 * * 1-5" });
  });

  it("validates verify and keeps it to webhooks", () => {
    const hook = (verify: unknown) => () => buildTrigger({ kind: "event", name: "n", prompt: "p", verify } as never, opts);
    expect(hook({ kind: "stripe", secretRef: "vault://s", header: "Stripe-Signature" })).not.toThrow();
    expect(hook({ kind: "secret" })).not.toThrow();
    bad("verifyInvalid", hook({ kind: "hmac-sha256", secretRef: "rawsecret" }));
    bad("verifyInvalid", hook({ kind: "github" }));
    bad("verifyInvalid", hook({ kind: "nope" }));
    bad("verifyEventOnly", () => signal({ verify: { kind: "secret" } }));
  });

  it("stores triagePerDay with a quick check or a script: it bounds pio.llm.ask too", () => {
    expect(signal({ triagePerDay: 50 }).triagePerDay).toBeUndefined();
    expect(signal({ triage: { brief: "b" }, triagePerDay: 50 }).triagePerDay).toBe(50);
    expect(signal({ script: { code: "x" }, triagePerDay: 50 }).triagePerDay).toBe(50);
    // A script alone takes the default without storing it.
    expect(signal({ script: { code: "x" } }).triagePerDay).toBeUndefined();
    expect(applyUpdate(signal({ script: { code: "x" } }), { triagePerDay: 30 }, upd).triagePerDay).toBe(30);
    // The quick check goes and the script stays, or the other way round: the limit stays.
    const both = signal({ script: { code: "x" }, triage: { brief: "b" }, triagePerDay: 40 });
    expect(applyUpdate(both, { triage: null }, upd).triagePerDay).toBe(40);
    expect(applyUpdate(both, { script: null }, upd).triagePerDay).toBe(40);
    expect(applyUpdate(both, { triage: null, script: null }, upd).triagePerDay).toBeUndefined();
    // null takes the default back: stored with a quick check, not without one.
    expect(applyUpdate(both, { triagePerDay: null }, upd).triagePerDay).toBe(200);
    expect(applyUpdate(applyUpdate(both, { triage: null }, upd), { triagePerDay: null }, upd).triagePerDay).toBeUndefined();
    expect(applyUpdate(signal(), { triagePerDay: 30 }, upd).triagePerDay).toBeUndefined();
  });

  it("builds a trigger from a normalized built-in source", () => {
    const t = buildTrigger(normalizeOn({ name: "n", prompt: "p", on: [{ type: "web.webhook", config: { verify: { kind: "github", secretRef: "vault://gh" } } }] }), opts);
    expect(t.kind).toBe("event");
    expect(t.verify).toEqual({ kind: "github", secretRef: "vault://gh" });
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
    for (const host of ["https://example.com", "*", "*.com", "пример.рф", "example.com:8080", "example.com/path", "10.0.0.1", "192.168.1.5", "localhost", "*.10.0.0.1", "a b.com", ""])
      bad("hostInvalid", sig({ script: { code: "x", hosts: [host] } }));
    bad("briefRequired", sig({ triage: { brief: "  " } }));
    bad("briefTooLong", sig({ triage: { brief: "a".repeat(2001) } }));
    bad("triageLimit", sig({ triage: { brief: "b" }, triagePerDay: 0 }));
    bad("triageLimit", sig({ triage: { brief: "b" }, triagePerDay: 2001 }));
  });

  it("accepts a punycode host", () => {
    expect(signal({ script: { code: "x", hosts: ["xn--e1afmkfd.xn--p1ai"] } }).script?.hosts).toEqual(["xn--e1afmkfd.xn--p1ai"]);
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

describe("the Triggers page's words", () => {
  const catalog = (lang: string) =>
    JSON.parse(readFileSync(join(import.meta.dirname, "../../../../plugins/triggers/.piomio-plugin/locales", `${lang}.json`), "utf8")) as Record<string, string>;
  it("names every kind, the outcomes that start nothing and the codes the pipeline writes, and labels a check's own words", () => {
    for (const lang of ["en", "ru"]) {
      const c = catalog(lang);
      for (const kind of TRIGGER_KINDS) {
        expect(c[`ui.kind.${kind}`], `${lang} ui.kind.${kind}`).toBeTruthy();
        expect(c[`ui.kindHint.${kind}`], `${lang} ui.kindHint.${kind}`).toBeTruthy();
      }
      for (const key of ["ui.run.note", "ui.run.drop", "ui.card.noted", "ui.card.dropped", "error.queueFull"]) expect(c[key], `${lang} ${key}`).toBeTruthy();
      expect(c["ui.run.asWritten"], lang).toContain("{text}");
    }
  });
});
