// Main web app (port 8080): sign-in, the hub API (server/api.ts) behind cookie sessions, MCP endpoint for brains,
// node daemon endpoints, plugin webhooks and the SPA. The same app in remote mode is the link's gateway (remote.ts):
// on loopback behind the hub's Tailscale node, the link's host only, no desktop sign-in, passkeys, Google's return page
// or webhooks; its first-run setup and sign-in count toward the link's shared budget.

import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";
import { LOCALES, localeFromEnv } from "@piomio/shared";
import { errorText, hubLocale, localizePluginValue, LocalizedError, requestLocale, t, tFor } from "../i18n.ts";
import { forwardToLeader, pipeToLeader, relayToLeader, vouchedSession } from "./forward.ts";
import type { WebSocket } from "ws";
import type { RpcPeer } from "@piomio/shared";
import type { Hub } from "../app.ts";
import { AuthError, type AuthSession } from "../auth.ts";
import { clientIp, FailureBudget, hostAllowed, HttpError, originAllowed, originsFor, registerCompression, sendFile } from "./http.ts";
import { registerJoinPage } from "./join-page.ts";
import { registerApi } from "./api.ts";
import { registerSpa } from "./spa.ts";
import { registerPages } from "./pages.ts";

const COOKIE = "piomio_session";

declare module "fastify" {
  interface FastifyRequest {
    authSession?: AuthSession;
  }
}

export interface MainAppOptions {
  /** The link's gateway: `host` is the link's host while the node serves it. */
  remote?: { host: () => string | undefined };
}

export async function buildMainApp(hub: Hub, opts: MainAppOptions = {}): Promise<FastifyInstance> {
  const cfg = hub.config;
  const remote = opts.remote;
  // The gateway trusts the node's X-Forwarded-For (it sets it, dropping the client's own): clientIp() is the real one.
  const trustProxy = remote ? "127.0.0.1" : process.env.PIOMIO_TRUST_PROXY === "1";
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024, trustProxy });
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, { options: { maxPayload: 4 * 1024 * 1024 } });
  registerCompression(app);

  const secure = !!remote || cfg.publicUrl.startsWith("https://");
  const localOrigins = originsFor(cfg.publicUrl, cfg.allowedHosts, cfg.port);
  if (process.env.PIOMIO_DEV_ORIGIN) localOrigins.push(process.env.PIOMIO_DEV_ORIGIN);
  /** Where state-changing requests may come from: the link itself on the gateway. */
  const origins = (): string[] => {
    if (!remote) return localOrigins;
    const host = remote.host();
    return host ? [`https://${host}`] : [];
  };
  const hosts = (): string[] => {
    if (!remote) return cfg.allowedHosts;
    const host = remote.host();
    return host ? [host.split(":")[0].toLowerCase()] : [];
  };

  /** A web-UI call a standby checked and sent over the link (never on the link's remote gateway). */
  const vouched = (req: FastifyRequest): AuthSession | undefined => (remote ? undefined : vouchedSession(hub, req, "main"));

  /** The leader, over its link, when this replica is a standby whose web UI it takes (an older leader doesn't). */
  const uiLeader = (): { link: RpcPeer; name: string } | undefined => {
    const l = hub.cluster.leaderTarget();
    return l?.link && l.webUi ? { link: l.link, name: l.name } : undefined;
  };

  // Keep raw text for non-JSON bodies (webhooks).
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));

  app.addHook("onRequest", async (req, reply) => {
    if (!hostAllowed(req, hosts())) {
      reply.code(421).send({ error: "Host not allowed. Add it to PIOMIO_ALLOWED_HOSTS." });
      return reply;
    }
    // A machine's MCP calls on a standby belong to the leader that opened its session.
    if (req.url.startsWith("/mcp") && hub.cluster.leaderTarget()?.link) {
      forwardToLeader(hub, req, reply, () => {}, "main");
      return reply;
    }
    // A standby takes no changes of its own: with a link to the leader the web UI's calls go there (the API's hook
    // below, once it knows who asks); without one, or for a call that came over a link already, they wait.
    const leader = hub.cluster.leaderTarget();
    if (leader && req.method !== "GET" && req.method !== "HEAD" && req.url.startsWith("/api/") && !req.url.startsWith("/api/auth/")) {
      if (uiLeader() && !req.url.startsWith("/api/node/") && !vouched(req)) return;
      reply.code(503).send({ error: t("cluster.standby", { leader: leader.name }) });
      return reply;
    }
  });

  app.setErrorHandler((err: any, _req, reply) => {
    const status = err instanceof LocalizedError && err.status ? err.status : err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) console.error("[http]", err);
    reply.code(status).send({ error: hub.vault.redactor.text(errorText(err, requestLocale(_req))) });
  });

  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: "strict", secure, path: "/", maxAge: 30 * 24 * 3600 });

  const authed = (req: FastifyRequest): AuthSession => {
    const s = hub.auth.session(req.cookies[COOKIE], "main");
    if (!s) throw new HttpError(401, "auth.required");
    return s;
  };

  /** Session + (for state-changing requests) CSRF token and same-origin check; a standby's checked call over the link. */
  const guard = async (req: FastifyRequest) => {
    const v = vouched(req);
    if (v) {
      req.authSession = v;
      return;
    }
    const s = authed(req);
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (req.headers["x-csrf"] !== s.csrf) throw new HttpError(403, "CSRF token mismatch");
      if (!originAllowed(req, origins())) throw new HttpError(403, "Origin not allowed");
    }
    req.authSession = s;
  };

  // ---------- public: auth ----------

  app.get("/api/auth/state", async (req) => ({
    hasPassword: hub.auth.hasPassword(),
    authenticated: !!hub.auth.session(req.cookies[COOKIE], "main"),
    // Passkeys belong to the computer's address: through the link it is the password.
    passkeys: remote ? 0 : hub.auth.listPasskeys().length,
    version: cfg.version,
    language: hubLocale(),
    locales: LOCALES,
  }));

  // Also through the link: a server's hub opens there first (install.sh prints it with the setup code, which only the
  // installer's terminal and the data folder have).
  app.post("/api/auth/setup", async (req, reply) => {
    if (!originAllowed(req, origins())) throw new HttpError(403, "Origin not allowed");
    const b = req.body as { token?: string; password?: string };
    hub.auth.setup(String(b?.token ?? ""), String(b?.password ?? ""), clientIp(req), { remote: !!remote });
    // The first user's browser language becomes the hub language unless PIOMIO_LANG pins it.
    if (!localeFromEnv({ PIOMIO_LANG: process.env.PIOMIO_LANG })) hub.settings.update({ language: requestLocale(req) });
    const { token } = hub.auth.createSession("main");
    setCookie(reply, token);
    return { ok: true };
  });

  if (!remote) {
    // The desktop app's own window: a one-time ticket the app gave the hub over its stdin (desktop-login.ts).
    app.post("/api/auth/desktop", async (req, reply) => {
      if (!originAllowed(req, origins())) throw new HttpError(403, "Origin not allowed");
      if (!hub.auth.hasPassword()) throw new AuthError(409, "auth.noPassword");
      const ticket = String((req.body as { ticket?: string })?.ticket ?? "");
      if (!hub.desktopTickets.consume(ticket)) {
        hub.audit.append("user", "auth.failure", "desktop", { ip: clientIp(req) });
        throw new AuthError(401, "auth.badDesktopTicket");
      }
      // The app's windows share their cookies (the hub window, Pio's): one signed in already, its session stays, so a
      // page open in the other window keeps its CSRF token.
      if (hub.auth.session(req.cookies[COOKIE], "main")) {
        hub.audit.append("user", "auth.desktop", undefined, { kept: true });
        return { ok: true };
      }
      const { token } = hub.auth.createSession("main");
      hub.audit.append("user", "auth.desktop");
      setCookie(reply, token);
      return { ok: true };
    });
  }

  app.post("/api/auth/login", async (req, reply) => {
    if (!originAllowed(req, origins())) throw new HttpError(403, "Origin not allowed");
    const b = req.body as { password?: string };
    hub.auth.verifyPassword(String(b?.password ?? ""), clientIp(req), { remote: !!remote });
    const { token } = hub.auth.createSession("main");
    setCookie(reply, token);
    return { ok: true };
  });

  if (!remote) {
    app.post("/api/auth/passkey/options", async (req) => {
      if (!originAllowed(req, origins())) throw new HttpError(403, "Origin not allowed");
      return hub.auth.passkeyLoginOptions();
    });

    app.post("/api/auth/passkey/verify", async (req, reply) => {
      if (!originAllowed(req, origins())) throw new HttpError(403, "Origin not allowed");
      await hub.auth.passkeyLogin((req.body as any)?.response, clientIp(req));
      const { token } = hub.auth.createSession("main");
      setCookie(reply, token);
      return { ok: true };
    });
  }

  app.post("/api/auth/logout", async (req, reply) => {
    hub.auth.logout(req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  // ---------- public: MCP for brains (a session's bearer token; machines paired through the link use it too) ----------

  app.post("/mcp", async (req, reply) => {
    const session = hub.mcp.authenticate(req.headers.authorization);
    if (!session) {
      reply.code(401).header("www-authenticate", 'Bearer realm="piomio"');
      return { jsonrpc: "2.0", id: null, error: { code: -32001, message: "invalid session token" } };
    }
    const out = await hub.mcp.handle(session, req.body);
    if (out === undefined) return reply.code(202).send();
    return out;
  });
  app.get("/mcp", async (_req, reply) => reply.code(405).header("allow", "POST").send());
  app.delete("/mcp", async () => ({}));

  // ---------- public: machine nodes ----------

  // Wrong invite codes, from a machine pairing or the invite page: 10 per address in 15 minutes.
  const pairBudget = new FailureBudget(10, 15 * 60_000);
  app.post("/api/node/pair", async (req) => {
    if (pairBudget.exhausted(req)) throw new HttpError(429, "auth.tooManyAttempts");
    try {
      const b = req.body as any;
      const m = hub.machines.pair({ code: String(b?.code ?? ""), publicKey: String(b?.publicKey ?? ""), name: b?.name, info: b?.info });
      return { machineId: m.id, name: m.name };
    } catch (e: any) {
      pairBudget.fail(req);
      throw e instanceof LocalizedError ? new HttpError(400, e.key, e.params) : new HttpError(400, e.message);
    }
  });

  app.get("/node/ws", { websocket: true }, (socket, req) => {
    // A standby hands the machine to the leader over the link (the machine may not reach the leader itself).
    if (pipeToLeader(hub, socket as unknown as WebSocket, req, "main")) return;
    hub.machines.attach(socket as any, clientIp(req));
  });

  // The invite's page and the desktop installers (join-page.ts).
  registerJoinPage(app, hub, { remote: !!remote, budget: pairBudget });

  // Single-file machine daemon (public code, no secrets): `node piomio-node.mjs pair <hub> <code>`.
  app.get("/download/piomio-node.mjs", async (_req, reply) => {
    const file = join(cfg.appRoot, "packages", "node", "dist", "piomio-node.mjs");
    if (!existsSync(file)) throw new HttpError(404, "build.daemonMissing");
    return sendFile(reply, file, { download: true });
  });

  // ---------- public: plugin webhooks ----------

  if (!remote) {
    app.all("/hooks/:pluginId/*", async (req, reply) => {
      const { pluginId } = req.params as { pluginId: string };
      if (!hub.plugins.hasHttp(pluginId)) throw new HttpError(404, "not found");
      const rest = (req.params as any)["*"] as string;
      const r = await hub.plugins.http(pluginId, {
        method: req.method,
        path: "/" + rest,
        query: req.query as Record<string, string>,
        headers: req.headers as Record<string, string>,
        body: req.body ?? null,
        public: true,
        locale: hubLocale(),
      });
      reply.code(r.status ?? 200);
      for (const [k, v] of Object.entries(r.headers ?? {})) if (!/^(set-cookie|content-security-policy)$/i.test(k)) reply.header(k, v);
      return reply.send(r.body ?? "");
    });

    // ---------- A sign-in sends the browser back here (state is the proof, no session needed) ----------

    /** The page the browser lands on: done (with who or what was connected) or why not. */
    const oauthPage = async (req: FastifyRequest, reply: FastifyReply, finish: (q: URLSearchParams) => Promise<string>) => {
      const t = tFor(requestLocale(req));
      let ok = true;
      let detail = "";
      try {
        detail = await finish(new URLSearchParams(req.url.split("?")[1] ?? ""));
      } catch (e) {
        ok = false;
        detail = errorText(e, requestLocale(req));
      }
      const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
      const title = t(ok ? "oauth.doneTitle" : "oauth.failedTitle");
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
  <style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#111}h1{font-size:1.4rem}a{color:inherit}</style></head>
  <body><h1>${esc(title)}</h1><p>${esc(ok ? `${detail}. ${t("oauth.doneText")}` : detail)}</p><p><a href="${esc(cfg.publicUrl)}">${esc(t("oauth.back"))}</a></p></body></html>`;
      return reply.code(ok ? 200 : 400).header("content-type", "text/html; charset=utf-8").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'").send(html);
    };

    // Google.
    app.get("/oauth/callback", (req, reply) =>
      oauthPage(req, reply, async (q) => {
        const r = await hub.connections.complete(q);
        hub.connectionDone(r.account, r.origin);
        return r.account.account;
      }),
    );

    // An MCP server's own sign-in (an integration such as Granola).
    app.get("/oauth/mcp", (req, reply) =>
      oauthPage(req, reply, async (q) => {
        const r = await hub.mcpClients.completeSignIn(q);
        hub.mcpSignedIn(r.source, r.conversationId);
        const rec = hub.plugins.get(r.source);
        return rec?.layout ? localizePluginValue(rec.layout, rec.layout.manifest.name, requestLocale(req)) : r.name;
      }),
    );
  }

  // The local-only routes do not exist on the link: say so instead of serving the page.
  if (remote) for (const path of ["/hooks/*", "/oauth/callback", "/oauth/mcp"]) app.all(path, async () => Promise.reject(new HttpError(404, "not found")));

  // ---------- authenticated API ----------

  await app.register(async (api) => {
    // A standby's web UI works on the leader: each call, once checked here, goes there over the link, so what it shows
    // and changes is the leader's at once, not a copy seconds behind. A call that came over a link stays (no loops).
    api.addHook("onRequest", async (req, reply) => {
      const leader = uiLeader();
      if (!leader || req.headers.upgrade || vouched(req)) return;
      await guard(req);
      const bootstrap = req.url.split("?")[0] === "/api/bootstrap";
      relayToLeader(req, reply, leader, req.authSession!, {
        // The hub as the leader has it, at this computer's own addresses (its console is the one here).
        headers: (h) => {
          if (bootstrap) delete h["accept-encoding"];
        },
        edit: (a) => {
          if (!bootstrap || a.status !== 200) return a;
          try {
            return { ...a, body: Buffer.from(JSON.stringify({ ...JSON.parse(a.body.toString("utf8")), publicUrl: cfg.publicUrl, consoleUrl: cfg.consoleUrl })) };
          } catch {
            return a;
          }
        },
      });
      return reply;
    });
    api.addHook("preHandler", guard);
    await registerApi(api, hub, {
      kind: "web",
      bootstrap: (req) => ({ csrf: req.authSession!.csrf }),
      wsAllowed: (req) => !!vouched(req) || originAllowed(req, origins()),
      relaySocket: (socket, req) => !!uiLeader() && !vouched(req) && pipeToLeader(hub, socket, req, "main", req.authSession),
      authenticate: guard,
    });
  });

  // ---------- pages agents make: their links are their capability, no session ----------

  await registerPages(app, hub);

  // ---------- SPA ----------

  registerSpa(app, cfg.webDist, () => true);

  return app;
}
