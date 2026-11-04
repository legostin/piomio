// The device port (default 8082): the hub for paired phones over HTTPS with the hub's own pinned certificate.
// The app calls the API with its bearer token; its chat screen is the web UI's chat (/m/*) in a WebView, signed in by
// a one-time ticket the app trades for a cookie session, so the token never reaches the page. No password sign-in,
// no MCP, no desktop pages. It listens on the network (home Wi-Fi, Tailscale) while the web UI and the security
// console stay on their own host. In remote mode the same app is the link's phone gateway (remote.ts): plain HTTP on
// loopback behind the hub's Tailscale node, which presents this port's certificate to the phones itself.

import { registerReplicaRoutes } from "./replica-routes.ts";
import { forwardToLeader } from "./forward.ts";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import type { Device } from "@piomio/shared";
import { errorText, LocalizedError, requestLocale } from "../i18n.ts";
import type { Hub } from "../app.ts";
import { agentName } from "../agents.ts";
import { pushNote } from "../push.ts";
import type { DeviceTls } from "../devices-tls.ts";
import { DEVICE_COOKIE } from "../devices.ts";
import { hubName } from "../pairing.ts";
import { registerApi } from "./api.ts";
import { clientIp, HttpError } from "./http.ts";
import { registerSpa } from "./spa.ts";
import { registerPages } from "./pages.ts";

declare module "fastify" {
  interface FastifyRequest {
    device?: Device;
    /** Set for the chat page's cookie session (not for the app's bearer token). */
    webCsrf?: string;
  }
}

export async function buildDeviceApp(hub: Hub, tls: DeviceTls, opts: { remote?: boolean } = {}): Promise<FastifyInstance> {
  const cfg = hub.config;
  // Replicas keep connections to each other open (long polls, keep-alive): closing does not wait for them.
  const app: FastifyInstance = opts.remote
    ? Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024, trustProxy: "127.0.0.1", forceCloseConnections: true })
    : (Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024, https: { key: tls.key, cert: tls.cert }, forceCloseConnections: true }) as unknown as FastifyInstance);
  await app.register(fastifyCookie);
  // Replica links (replica-link.ts) carry batches of rows and pieces of files: up to 64 MB a frame.
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 * 1024 } });

  /** The page's own origin: phones reach the port by IP, so there is no fixed list of hosts. */
  const sameOrigin = (req: FastifyRequest) => !!req.headers.host && req.headers.origin === `https://${req.headers.host}`;

  app.setErrorHandler((err: any, req, reply) => {
    const status = err instanceof LocalizedError && err.status ? err.status : err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) console.error("[devices]", err);
    reply.code(status).send({ error: hub.vault.redactor.text(errorText(err, requestLocale(req))) });
  });

  // ---------- public ----------

  // The phone probes every address from the QR with this and keeps the first that answers.
  app.get("/api/device/hello", async () => ({ piomio: true, name: hubName(), version: cfg.version }));

  const pairFailures = new Map<string, number[]>();
  app.post("/api/devices/pair", async (req) => {
    const ip = clientIp(req);
    const now = Date.now();
    const recent = (pairFailures.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
    if (recent.length >= 10) throw new HttpError(429, "auth.tooManyAttempts");
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const { device, token } = hub.devices.pair({
        code: String(b.code ?? ""),
        name: String(b.name ?? ""),
        platform: String(b.platform ?? ""),
        model: String(b.model ?? ""),
        publicKey: String(b.publicKey ?? ""),
      });
      return { deviceId: device.id, token, device, hub: { name: hubName(), version: cfg.version } };
    } catch (e) {
      recent.push(now);
      pairFailures.set(ip, recent);
      throw e;
    }
  });

  // The chat page signs in: the app opens this with a ticket it got with its token.
  app.get("/m/session", async (req, reply) => {
    const q = req.query as { ticket?: string; to?: string };
    const to = typeof q.to === "string" && /^\/m\/[\w\-/.%]*$/.test(q.to) ? q.to : "/m/";
    const opened = hub.devices.openWebSession(String(q.ticket ?? ""));
    if (!opened) throw new HttpError(401, "auth.required");
    reply.setCookie(DEVICE_COOKIE, opened.token, { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 30 * 24 * 3600 });
    return reply.redirect(to, 303);
  });

  // ---------- the paired phone: the app (bearer token) or its chat page (cookie) ----------

  const sockets = new Map<string, Set<WebSocket>>();
  // A revoked phone loses its open sockets at once, not at its next request.
  const offRevoke = hub.bus.on("device.updated", ({ id }) => {
    if (hub.devices.get(id)) return;
    for (const s of sockets.get(id) ?? []) s.close(4401, "revoked");
    sockets.delete(id);
  });
  app.addHook("onClose", async () => offRevoke());

  // Replicas of this hub talk here (cluster.ts); a standby sends the apps on to the leader.
  await registerReplicaRoutes(app, hub);
  app.addHook("onRequest", (req, reply, done) => forwardToLeader(hub, req, reply, done));

  await app.register(async (api) => {
    const authenticate = async (req: FastifyRequest) => {
      const device = hub.devices.authenticate(req.headers.authorization);
      if (device) {
        req.device = device;
        return;
      }
      const web = hub.devices.webSession(req.cookies[DEVICE_COOKIE]);
      if (!web) throw new HttpError(401, "auth.required");
      if (req.method !== "GET" && req.method !== "HEAD") {
        if (req.headers["x-csrf"] !== web.csrf) throw new HttpError(403, "CSRF token mismatch");
        if (!sameOrigin(req)) throw new HttpError(403, "Origin not allowed");
      }
      req.device = web.device;
      req.webCsrf = web.csrf;
    };
    api.addHook("preHandler", authenticate);

    await registerApi(api, hub, {
      authenticate,
      kind: "device",
      bootstrap: (req) => ({ device: req.device, hubName: hubName(), ...(req.webCsrf ? { csrf: req.webCsrf } : {}) }),
      // The app's socket carries its token; the page's carries the cookie and must come from the page itself.
      wsAllowed: (req) => !req.webCsrf || sameOrigin(req),
      onSocket: (socket, req) => {
        const id = req.device!.id;
        const set = sockets.get(id) ?? new Set();
        set.add(socket);
        sockets.set(id, set);
        socket.on("close", () => set.delete(socket));
      },
    });

    api.get("/api/devices/me", async (req) => req.device);
    // Where the app can find the hub now (the link may have come after the pairing): it keeps the list.
    api.get("/api/devices/addresses", async () => ({ urls: hub.cluster.phoneUrls(hub.phoneUrls()) }));
    // Only the app (its token) gets tickets for its chat page; the page cannot mint more.
    api.post("/api/devices/web-ticket", async (req) => {
      if (req.webCsrf) throw new HttpError(403, "auth.required");
      return hub.devices.webTicket(req.device!.id);
    });
    api.delete("/api/devices/me", async (req) => {
      hub.devices.revoke(req.device!.id, `device:${req.device!.id}`);
      return { ok: true };
    });
    // Location sharing (the app's switch): the phone reports where the user is when it moves; agents see the last place.
    api.post("/api/devices/location", async (req) => {
      if (req.webCsrf) throw new HttpError(403, "auth.required");
      if (!hub.locations.set(req.device!, req.body)) throw new HttpError(400, "device.badLocation");
      return { ok: true };
    });
    api.delete("/api/devices/location", async (req) => {
      if (req.webCsrf) throw new HttpError(403, "auth.required");
      hub.locations.forget(req.device!.id);
      return { ok: true };
    });
    // Pushes (the person allowed them on the phone): the relay seals the phone's APNs token, the hub keeps the handle.
    api.put("/api/devices/me/push", async (req) => {
      if (req.webCsrf) throw new HttpError(403, "auth.required");
      const b = (req.body ?? {}) as Record<string, unknown>;
      await hub.pushes.register(req.device!.id, b.token, b.environment);
      return { ok: true };
    });
    api.delete("/api/devices/me/push", async (req) => {
      if (req.webCsrf) throw new HttpError(403, "auth.required");
      hub.pushes.forget(req.device!.id);
      return { ok: true };
    });
    // What a push was about: the app's notification extension shows these words in place of "New message".
    api.get("/api/devices/notifications/:id", async (req) => {
      const n = hub.notifier.get((req.params as { id: string }).id);
      if (!n?.deliveredAt) throw new HttpError(404, "push.notFound");
      const locale = requestLocale(req);
      return pushNote(n, hub.settings.get().defaultAgent, (id) => {
        const a = hub.agents.get(id);
        return a ? agentName(a, locale) : id;
      });
    });

    // ----- approvals: listed with everything the card shows; approving needs the phone's key (Face ID) -----
    api.get("/api/approvals", async (req) => {
      const locale = requestLocale(req);
      return hub.approvals.list(["pending"], 200).map((a) => {
        const agent = hub.agents.get(a.agentId);
        return { ...a, agentName: agent ? agentName(agent, locale) : a.agentId, toolDescription: hub.tools.get(a.tool)?.descriptor.description };
      });
    });
    api.post("/api/approvals/:id/challenge", async (req) => {
      const id = (req.params as { id: string }).id;
      const a = hub.approvals.get(id);
      if (!a) throw new HttpError(404, "approval.notFound");
      if (a.status !== "pending") throw new HttpError(409, "approval.alreadyResolved", { status: a.status });
      return hub.devices.challenge(req.device!.id, id);
    });
    api.post("/api/approvals/:id/resolve", async (req) => {
      const id = (req.params as { id: string }).id;
      const b = (req.body ?? {}) as { decision?: unknown; nonce?: unknown; signature?: unknown };
      if (b.decision !== "approve" && b.decision !== "deny") throw new HttpError(400, "decision: approve | deny");
      if (b.decision === "approve" && !hub.devices.verifyApproval(req.device!.id, id, String(b.nonce ?? ""), String(b.signature ?? ""))) {
        hub.audit.append(`device:${req.device!.id}`, "device.approval-refused", id);
        throw new HttpError(403, "device.badSignature");
      }
      return hub.approvals.resolve(id, b.decision, { via: "device" });
    });
  });

  // ---------- the chat page: the web UI's build, its own routes under /m/ ----------
  // Pages agents make, opened from the chat: their links are their capability.
  await registerPages(app, hub);
  registerSpa(app, cfg.webDist, (rel) => rel === "m" || rel.startsWith("m/"));

  return app;
}
