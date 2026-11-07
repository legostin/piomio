// HTTP API: authenticated routes for the UI, public webhooks for event triggers.
// Errors shown by the UI carry the catalog message in the reader's language plus the code and params;
// webhook responses go to other programs and stay in English.

import type { TriggerHttpRequest, TriggerHttpResponse } from "./host.ts";
import type { Locale } from "@piomio/shared";
import { NotFoundError, type TriggerEngine } from "./engine.ts";
import type { ErrorParams, TriggerError } from "./errors.ts";
import { describeSchedule } from "./schedule.ts";
import type { Trigger, TriggerInput } from "./types.ts";
import { normalizeOn, ValidationError } from "./validate.ts";
import { whenText } from "./when.ts";

/** A trigger for the UI and the phone: with when it runs and its last error in the reader's language. */
export function view(e: TriggerEngine, t: Trigger, locale: Locale = e.ctx.i18n.locale()) {
  const tr = (key: string, params?: ErrorParams) => e.ctx.i18n.t(key, params, locale);
  const code = t.state.lastErrorCode;
  return {
    ...t,
    nextRunAt: t.state.nextRunAt ?? null,
    webhookUrl: e.webhookUrl(t) ?? null,
    scheduleText: describeSchedule(t),
    whenText: whenText(t, tr, locale, e.tz),
    on: t.on ?? [],
    batch: t.batch ?? null,
    script: t.script ?? null,
    triage: t.triage ?? null,
    triagePerDay: t.triagePerDay ?? null,
    lastErrorText: t.state.lastError ? (code ? tr(`error.${code}`, t.state.lastErrorParams) : t.state.lastError) : null,
  };
}

const ok = (body: unknown, status = 200): TriggerHttpResponse => ({ status, body });
const failure = (e: TriggerEngine, req: TriggerHttpRequest, err: TriggerError, status: number): TriggerHttpResponse =>
  ok({ error: e.ctx.i18n.t(`error.${err.code}`, err.params, req.locale), code: err.code, params: err.params }, status);
const body = (req: TriggerHttpRequest): TriggerInput => (req.body && typeof req.body === "object" ? (req.body as TriggerInput) : {});

export async function handleHttp(e: TriggerEngine, req: TriggerHttpRequest): Promise<TriggerHttpResponse> {
  if (req.public) return e.webhook(req);
  const method = req.method.toUpperCase();
  const path = req.path.replace(/\/+$/, "") || "/";
  try {
    if (path === "/triggers") {
      if (method === "GET")
        return ok({ triggers: e.list().map((t) => view(e, t, req.locale)), timezone: e.tz, publicUrl: e.publicUrl, agents: await e.agents(), computers: await e.computers() });
      if (method === "POST") return ok(view(e, await e.create(normalizeOn(body(req), { create: true }), { createdBy: "user" }), req.locale), 201);
      return ok({ error: "method not allowed" }, 405);
    }
    const m = /^\/triggers\/([A-Za-z0-9_-]+)(?:\/(run|runs|check|test))?$/.exec(path);
    if (m) {
      const [, id, sub] = m;
      const t = e.require(id);
      if (!sub && method === "GET") return ok(view(e, t, req.locale));
      if (!sub && method === "PATCH") return ok(view(e, await e.update(id, normalizeOn(body(req))), req.locale));
      if (!sub && method === "DELETE") {
        await e.remove(id);
        return ok({ ok: true });
      }
      if (sub === "run" && method === "POST") {
        const run = await e.runNow(id, { force: true });
        // Why it did not start, in the reader's language (the phone shows it as is).
        const text = run.status === "started" ? undefined : run.code ? e.ctx.i18n.t(`error.${run.code}`, run.params, req.locale) : run.detail;
        return ok(text ? { ...run, text } : run);
      }
      if (sub === "check" && method === "POST") return ok(await e.checkNow(id));
      if (sub === "runs" && method === "GET") {
        // The journal keeps 200 runs; the page and the phone ask for the last 20 unless they say how many.
        const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query?.limit) || 20)));
        return ok({ runs: await e.runsWithStatus(id, limit) });
      }
      if (sub === "test" && method === "POST") {
        // A test run on the trigger's recent signals (or "sample", or signals given): stages and outcomes, nothing carried out.
        const b = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
        return ok(await e.test({ id, signals: b.signals ?? b.from, n: b.n }));
      }
      return ok({ error: "method not allowed" }, 405);
    }
    return ok({ error: "not found" }, 404);
  } catch (err: any) {
    if (err instanceof ValidationError) return failure(e, req, err, 400);
    if (err instanceof NotFoundError) return failure(e, req, err, 404);
    return ok({ error: err?.message ?? String(err) }, 500);
  }
}
