// Security console (port 8081): its own origin, cookie and strict CSP. No plugin code ever runs here.
// Vault, approvals, rules, audit, passkeys and password live only on this origin. On a standby replica (cluster.ts) the
// console works on the leader: once it has checked who asks, its calls and its socket go there over the link, so a tap
// wakes the call waiting on the leader and nothing runs here. Signing in and the account stay on this replica.

import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { LOCALES, type ApprovalStatus, type Rule, type RpcPeer, type VaultScope } from "@piomio/shared";
import type { Hub } from "../app.ts";
import type { AuthSession } from "../auth.ts";
import { VaultError } from "../vault/service.ts";
import { errorText, localizePluginValue, LocalizedError, requestLocale, tFor } from "../i18n.ts";
import { suggestRule } from "../policy/engine.ts";
import { clientIp, hostAllowed, HttpError, originAllowed, originsFor, safeFile, securityHeaders, sendFile } from "./http.ts";
import { pipeToLeader, relayToLeader, vouchedSession } from "./forward.ts";

const COOKIE = "piomio_console";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export async function buildConsoleApp(hub: Hub): Promise<FastifyInstance> {
  const cfg = hub.config;
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, trustProxy: process.env.PIOMIO_TRUST_PROXY === "1" });
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);
  const secure = cfg.consoleUrl.startsWith("https://");
  const origins = originsFor(cfg.consoleUrl, cfg.allowedHosts, cfg.consolePort);
  if (process.env.PIOMIO_CONSOLE_DEV_ORIGIN) origins.push(process.env.PIOMIO_CONSOLE_DEV_ORIGIN);

  app.addHook("onRequest", async (req, reply) => {
    if (!hostAllowed(req, cfg.allowedHosts)) {
      reply.code(421).send({ error: "Host not allowed" });
      return reply;
    }
    securityHeaders(reply, CSP);
    reply.header("cache-control", "no-store");
  });

  app.setErrorHandler((err: any, req, reply) => {
    let status = err instanceof LocalizedError && err.status ? err.status : err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (err instanceof VaultError) status = err.code === "not_found" ? 404 : err.code === "bad_passphrase" || err.code === "invalid" ? 400 : err.code === "forbidden" ? 403 : 409;
    if (status >= 500) console.error("[console]", err);
    reply.code(status).send({ error: errorText(err, requestLocale(req)), code: err.code });
  });

  /** Every console API call: same origin; state-changing calls also need JSON content type. */
  const sameOrigin = (req: FastifyRequest) => {
    // Browsers omit Origin on same-origin GETs; those are protected by the custom x-csrf header (forces CORS preflight).
    const origin = req.headers.origin;
    if (origin ? !origins.includes(origin) : req.method !== "GET") throw new HttpError(403, "Origin not allowed");
    if (req.method !== "GET" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "JSON required");
  };

  /** A console call a standby checked and sent over the link (forward.ts vouchedSession). */
  const vouched = (req: FastifyRequest): AuthSession | undefined => vouchedSession(hub, req, "console");

  /** The leader, over its link, when this replica is a standby whose console it takes (an older leader doesn't). */
  const consoleLeader = (): { link: RpcPeer; name: string } | undefined => {
    const l = hub.cluster.leaderTarget();
    return l?.link && l.console ? { link: l.link, name: l.name } : undefined;
  };

  /** Session from this console's own cookie, CSRF token and same-origin check. */
  const ownGuard = async (req: FastifyRequest) => {
    sameOrigin(req);
    const s = hub.auth.session(req.cookies[COOKIE], "console");
    if (!s) throw new HttpError(401, "auth.consoleRequired");
    if (req.headers["x-csrf"] !== s.csrf) throw new HttpError(403, "CSRF token mismatch");
    (req as any).consoleSession = s as AuthSession;
  };

  /** The same, or a standby's checked call over the link. */
  const guard = async (req: FastifyRequest) => {
    const v = vouched(req);
    if (v) (req as any).consoleSession = v;
    else await ownGuard(req);
  };

  const login = (reply: FastifyReply) => {
    const { token, session } = hub.auth.createSession("console");
    reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: "strict", secure, path: "/" });
    return { ok: true, csrf: session.csrf };
  };

  // ---------- auth ----------

  app.get("/console-api/auth/state", async (req) => {
    sameOrigin(req);
    const s = hub.auth.session(req.cookies[COOKIE], "console");
    return {
      hasPassword: hub.auth.hasPassword(),
      authenticated: !!s,
      csrf: s?.csrf,
      passkeys: hub.auth.listPasskeys().length,
      publicUrl: cfg.publicUrl,
      language: hub.settings.get().language,
      locales: LOCALES,
    };
  });
  app.post("/console-api/auth/login", async (req, reply) => {
    sameOrigin(req);
    hub.auth.verifyPassword(String((req.body as any)?.password ?? ""), clientIp(req));
    return login(reply);
  });
  app.post("/console-api/auth/passkey/options", async (req) => {
    sameOrigin(req);
    return hub.auth.passkeyLoginOptions();
  });
  app.post("/console-api/auth/passkey/verify", async (req, reply) => {
    sameOrigin(req);
    await hub.auth.passkeyLogin((req.body as any)?.response, clientIp(req));
    return login(reply);
  });
  app.post("/console-api/auth/logout", async (req, reply) => {
    sameOrigin(req);
    hub.auth.logout(req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  // ---------- account: stays with the sign-in on this replica (a passkey belongs to this computer's address) ----------

  await app.register(async (api) => {
    api.addHook("preHandler", ownGuard);
    api.get("/console-api/passkeys", async () => hub.auth.listPasskeys());
    api.post("/console-api/passkeys/options", async () => hub.auth.passkeyRegistrationOptions());
    api.post("/console-api/passkeys/register", async (req) => {
      const b = req.body as any;
      await hub.auth.passkeyRegister(b?.response, String(b?.name ?? "passkey"));
      return hub.auth.listPasskeys();
    });
    api.delete("/console-api/passkeys/:id", async (req) => {
      hub.auth.removePasskey(decodeURIComponent((req.params as any).id));
      return hub.auth.listPasskeys();
    });
    api.post("/console-api/password", async (req) => {
      const b = req.body as any;
      hub.auth.changePassword(String(b?.oldPassword ?? ""), String(b?.newPassword ?? ""), clientIp(req));
      return { ok: true };
    });
  });

  // ---------- the hub's security: on a standby, the leader's ----------

  await app.register(async (api) => {
    // A standby's console works on the leader: each call, once checked here, goes there over the link, so a tap wakes
    // the call waiting on the leader, the vault is the one that serves the hub, and nothing runs here. Without a link
    // to a leader that takes it, this replica shows its own copy, a few seconds behind, and changes wait: acting on the
    // copy would run the approved action here, beside the leader's work.
    api.addHook("onRequest", async (req, reply) => {
      const standby = hub.cluster.leaderTarget();
      if (!standby || vouched(req)) return;
      await ownGuard(req);
      const leader = consoleLeader();
      if (leader) {
        relayToLeader(req, reply, leader, (req as any).consoleSession as AuthSession, { app: "console" });
        return reply;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        reply.code(503).send({ error: tFor(requestLocale(req))("cluster.standby", { leader: standby.name }) });
        return reply;
      }
    });
    api.addHook("preHandler", guard);

    // ---------- vault ----------
    api.get("/console-api/vault", async () => ({ state: hub.vault.state(), items: hub.vault.list(), autoUnlock: !!cfg.vaultPassphraseFile || existsSync(hub.rememberedPassphraseFile()) }));
    api.post("/console-api/vault/init", async (req) => {
      hub.vault.init(String((req.body as any)?.passphrase ?? ""));
      hub.audit.append("user", "vault.init");
      return { state: hub.vault.state() };
    });
    api.post("/console-api/vault/unlock", async (req) => {
      hub.vault.unlock(String((req.body as any)?.passphrase ?? ""));
      hub.audit.append("user", "vault.unlock");
      return { state: hub.vault.state() };
    });
    api.post("/console-api/vault/seal", async () => {
      hub.vault.seal();
      hub.audit.append("user", "vault.seal");
      return { state: hub.vault.state() };
    });
    api.post("/console-api/vault/passphrase", async (req) => {
      const b = req.body as any;
      if (String(b?.newPassphrase ?? "").length < 8) throw new HttpError(400, "vault.minLength");
      hub.vault.changePassphrase(String(b?.oldPassphrase ?? ""), String(b.newPassphrase));
      // A passphrase remembered for automatic unlock follows the change.
      if (existsSync(hub.rememberedPassphraseFile())) hub.rememberVaultPassphrase(String(b.newPassphrase));
      hub.audit.append("user", "vault.passphrase-change");
      return { ok: true };
    });
    api.get("/console-api/vault/items/:id", async (req) => {
      const item = hub.vault.read((req.params as any).id);
      hub.audit.append("user", "vault.reveal", item.id);
      return item;
    });
    api.put("/console-api/vault/items", async (req) => {
      const b = req.body as any;
      if (!b?.name || !b?.type || typeof b.fields !== "object") throw new HttpError(400, "vault.itemFieldsRequired");
      const fields = Object.fromEntries(Object.entries(b.fields as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")]));
      // Editing without re-entering secrets: keep previous values for empty fields.
      if (b.id) {
        try {
          const prev = hub.vault.read(b.id).fields;
          for (const [k, v] of Object.entries(fields)) if (v === "" && prev[k]) fields[k] = prev[k];
        } catch {
          /* new item */
        }
      }
      const meta = hub.vault.upsert({ id: b.id || undefined, type: b.type, name: String(b.name), fields, scope: b.scope, hints: b.hints });
      hub.audit.append("user", "vault.upsert", meta.id, { type: meta.type });
      return meta;
    });
    api.patch("/console-api/vault/items/:id/scope", async (req) => {
      const meta = hub.vault.updateScope((req.params as any).id, (req.body ?? {}) as Partial<VaultScope>);
      hub.audit.append("user", "vault.scope", meta.id, meta.scope);
      return meta;
    });
    api.delete("/console-api/vault/items/:id", async (req) => {
      hub.vault.remove((req.params as any).id);
      hub.audit.append("user", "vault.remove", (req.params as any).id);
      return { ok: true };
    });

    // ---------- approvals ----------
    api.get("/console-api/approvals", async (req) => {
      const status = String((req.query as any).status ?? "pending").split(",") as ApprovalStatus[];
      return hub.approvals.list(status, 200).map((a) => {
        const tool = hub.tools.get(a.tool)?.descriptor;
        return { ...a, agentName: hub.agents.get(a.agentId)?.name, toolDescription: tool?.description, suggestedRule: suggestRule(a.tool, a.input, a.agentId) };
      });
    });
    api.post("/console-api/approvals/:id", async (req) => {
      const b = (req.body ?? {}) as { decision?: string; remember?: boolean; rule?: Omit<Rule, "id" | "createdAt" | "createdVia"> };
      if (b.decision !== "approve" && b.decision !== "deny") throw new HttpError(400, "decision: approve | deny");
      return hub.approvals.resolve((req.params as any).id, b.decision, { via: "console", remember: b.remember, rule: b.rule });
    });

    // ---------- rules ----------
    api.get("/console-api/rules", async () => hub.rules.list());
    api.post("/console-api/rules", async (req) => {
      const b = req.body as any;
      if (!b?.tool || !["allow", "deny"].includes(b?.decision)) throw new HttpError(400, "rule.fieldsRequired");
      const r = hub.rules.create({ tool: String(b.tool), agentId: b.agentId || undefined, conditions: b.conditions ?? [], decision: b.decision, note: b.note, createdVia: "console" });
      hub.audit.append("user", "rule.create", r.id, r);
      return r;
    });
    api.patch("/console-api/rules/:id", async (req) => {
      const r = hub.rules.update((req.params as any).id, (req.body ?? {}) as any);
      if (!r) throw new HttpError(404, "rule.notFound");
      hub.audit.append("user", "rule.update", r.id, r);
      return r;
    });
    api.delete("/console-api/rules/:id", async (req) => {
      hub.rules.remove((req.params as any).id);
      hub.audit.append("user", "rule.remove", (req.params as any).id);
      return { ok: true };
    });
    api.get("/console-api/tools", async () => hub.tools.list().map((t) => ({ name: t.name, effect: t.effect, owner: t.owner, description: t.description })));

    // ---------- audit ----------
    api.get("/console-api/audit", async (req) => {
      const q = req.query as any;
      return hub.audit.list({ limit: Math.min(Number(q.limit ?? 200), 1000), before: q.before ? Number(q.before) : undefined, action: q.action || undefined });
    });
    api.get("/console-api/audit/verify", async () => hub.audit.verify());

    api.get("/console-api/plugins", async (req) =>
      hub.plugins.list().map((r) => ({ id: r.id, name: localizePluginValue(r.layout, r.layout?.manifest.name ?? r.id, requestLocale(req)), source: r.source, enabled: r.enabled, permissions: r.granted, extraVault: r.extraVault, hasUi: !!r.layout?.uiEntry })),
    );
    api.put("/console-api/plugins/:id/vault", async (req) => {
      const id = (req.params as any).id as string;
      const items = (req.body as any)?.items;
      if (!Array.isArray(items)) throw new HttpError(400, "plugin.vaultItemsArray");
      if (!hub.plugins.get(id)) throw new HttpError(404, "plugin.notFound");
      try {
        hub.plugins.setExtraVault(id, items);
      } catch (e: any) {
        throw e instanceof LocalizedError ? new HttpError(400, e.key, e.params) : new HttpError(400, e.message);
      }
      return { ok: true, extraVault: hub.plugins.get(id)!.extraVault };
    });
  });

  app.get("/console-api/ws", { websocket: true }, (socket, req) => {
    const v = vouched(req);
    const s = v ?? (originAllowed(req, origins) ? hub.auth.session(req.cookies[COOKIE], "console") : undefined);
    if (!s) {
      socket.close(4401, "unauthorized");
      return;
    }
    // On a standby, the leader's events: its cards and its vault.
    if (!v && consoleLeader() && pipeToLeader(hub, socket as unknown as WebSocket, req, "console", s)) return;
    const send = (type: string, data: unknown) => socket.readyState === 1 && socket.send(JSON.stringify({ type, data }));
    const offs = [
      hub.bus.on("approval.created", (a) => send("approval.created", a)),
      hub.bus.on("approval.resolved", (a) => send("approval.resolved", a)),
      hub.bus.on("vault.state", (s) => send("vault.state", s)),
    ];
    const ping = setInterval(() => socket.ping(), 25_000);
    socket.on("close", () => {
      offs.forEach((o) => o());
      clearInterval(ping);
    });
  });

  // ---------- static console SPA ----------
  app.get("/*", async (req, reply) => {
    const rel = decodeURIComponent((req.params as any)["*"] ?? "");
    const file = rel ? safeFile(cfg.consoleDist, rel) : undefined;
    if (file) return sendFile(reply, file, { cache: rel.startsWith("assets/") });
    const index = join(cfg.consoleDist, "index.html");
    if (!existsSync(index)) return reply.type("text/html; charset=utf-8").send(`<!doctype html><meta charset=utf-8><title>Piomio console</title>${tFor(requestLocale(req))("build.consoleMissing")}`);
    return sendFile(reply, index);
  });

  return app;
}
