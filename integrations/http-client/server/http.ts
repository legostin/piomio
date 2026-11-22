// What the HTTP page calls. Each request is the person's own hand; errors come back in their language.

import type { PluginHttpRequest, PluginHttpResponse } from "@piomio/plugin-sdk";
import { looksLikeCurl, parseCurl, toCurl } from "./curl.ts";
import { ClientError } from "./errors.ts";
import { cleanSpec } from "./saved.ts";
import type { Kit } from "./tools.ts";
import { ME, type ClientState } from "./types.ts";

const ok = (body: unknown, status = 200): PluginHttpResponse => ({ status, body });

async function state(k: Kit): Promise<ClientState> {
  const settings = await k.ctx.core.call<{ defaultAgent?: string }>("settings.get").catch(() => undefined);
  return {
    requests: k.saved.requestList(),
    environments: k.saved.environmentList(),
    ...(k.saved.active ? { activeEnvironment: k.saved.active } : {}),
    ...(settings?.defaultAgent ? { defaultAgent: settings.defaultAgent } : {}),
    total: k.history.count(),
  };
}

export async function handleHttp(k: Kit, req: PluginHttpRequest): Promise<PluginHttpResponse> {
  if (req.public) return ok({ error: "not found" }, 404);
  const { client, history, saved, ctx } = k;
  const method = req.method.toUpperCase();
  const path = req.path.replace(/\/+$/, "") || "/";
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as any;

  try {
    if (path === "/state" && method === "GET") return ok(await state(k));

    if (path === "/history" && method === "GET") {
      const q = req.query;
      const since = q.since ? Number(q.since) : undefined;
      return ok(history.search({ q: q.q, host: q.host, method: q.method, status: q.status, by: q.by, since, before: q.before, limit: q.limit ? Number(q.limit) : undefined }));
    }
    if (path === "/history" && method === "DELETE") {
      history.clear();
      k.changed();
      return ok({ ok: true });
    }
    let m = /^\/history\/([\w-]+)$/.exec(path);
    if (m) {
      if (method === "GET") {
        const e = history.get(m[1]);
        if (!e) throw new ClientError("entryNotFound", { id: m[1] });
        return ok(e);
      }
      if (method === "DELETE") {
        if (!history.remove(m[1])) throw new ClientError("entryNotFound", { id: m[1] });
        k.changed();
        return ok({ ok: true });
      }
    }

    if (path === "/send" && method === "POST") {
      const environment = body.environment === null ? null : body.environment ? String(body.environment) : undefined;
      return ok(await client.run({ request: body.request, saved: body.saved ? String(body.saved) : undefined, environment, by: ME }));
    }

    if (path === "/requests" && method === "POST") {
      const spec = cleanSpec(body.request);
      if (!spec.url) throw new ClientError("noUrl");
      return ok(await saved.saveRequest({ name: body.name, folder: body.folder, request: spec }), 201);
    }
    m = /^\/requests\/([\w-]+)$/.exec(path);
    if (m) {
      const r = saved.request(m[1]);
      if (method === "PUT") {
        const spec = body.request ? cleanSpec(body.request) : r.request;
        if (!spec.url) throw new ClientError("noUrl");
        return ok(await saved.saveRequest({ id: r.id, name: body.name ?? r.name, folder: body.folder ?? r.folder, request: spec }));
      }
      if (method === "DELETE") {
        await saved.removeRequest(r);
        return ok({ ok: true });
      }
    }

    if (path === "/environments" && method === "POST") return ok(await saved.saveEnvironment({ name: body.name, vars: body.vars ?? {} }), 201);
    m = /^\/environments\/([\w-]+)$/.exec(path);
    if (m) {
      const e = saved.environment(m[1]);
      if (method === "PUT") return ok(await saved.saveEnvironment({ id: e.id, name: body.name ?? e.name, ...(body.vars !== undefined ? { vars: body.vars } : {}) }));
      if (method === "DELETE") {
        await saved.removeEnvironment(e);
        return ok({ ok: true });
      }
    }
    if (path === "/active-environment" && method === "PUT") {
      await saved.setActive(body.id ? saved.environment(String(body.id)) : undefined);
      return ok(await state(k));
    }

    if (path === "/curl/parse" && method === "POST") {
      const text = String(body.text ?? "");
      if (!looksLikeCurl(text)) throw new ClientError("badCurl");
      return ok({ request: cleanSpec(parseCurl(text)) });
    }
    if (path === "/curl/format" && method === "POST") return ok({ text: toCurl(cleanSpec(body.request)) });

    return ok({ error: "not found" }, 404);
  } catch (e: any) {
    if (e instanceof ClientError) return ok({ error: ctx.i18n.t(`error.${e.code}`, e.params, req.locale), code: e.code, params: e.params }, e.status);
    ctx.log.error(`${method} ${path} failed: ${e?.message ?? e}`);
    return ok({ error: e?.message ?? String(e) }, 500);
  }
}
