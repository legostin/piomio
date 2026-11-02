// Pages agents make (pages.ts), served on the main port, the link and the phones' port. A page's link carries its
// token: /p/<id>/<token>/ is the page, and next to it are what the kit uses: the compiled script, pictures and map tiles
// through the hub, road routes, the allowed APIs, and where the page saves its state and reports errors. The page runs
// sandboxed (CSP `sandbox`, no same-origin), so it has an opaque origin: it cannot read the hub's cookies or call its
// API, and every request it makes is cross-origin, hence the open CORS on these routes, which hold nothing but the page.
// The kit's own files are public and cached forever under their hash.
import { gzipSync } from "node:zlib";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouteMode } from "@piomio/shared";
import type { Hub } from "../app.ts";
import { hubLocale } from "../i18n.ts";
import { MediaError } from "../media.ts";
import { loadKit, PageError, pageApiHostAllowed } from "../pages.ts";
import { roadRoute } from "../routing.ts";
import { HttpError } from "./http.ts";

const MAX_ROUTE_STOPS = 25;

export async function registerPages(app: FastifyInstance, hub: Hub): Promise<void> {
  let kit: ReturnType<typeof loadKit>;
  const getKit = () => (kit ??= loadKit(hub.config.pagesKitDir));
  const zipped = new Map<string, Buffer>();

  app.get("/p/kit/:hash/:file", async (req, reply) => {
    const { hash, file } = req.params as { hash: string; file: string };
    const k = getKit();
    const f = k?.files.get(file);
    if (!k || !f || hash !== k.hash) throw new HttpError(404, "not found");
    // A page's fonts load in CORS mode from its opaque origin.
    reply
      .header("content-type", f.type)
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("x-content-type-options", "nosniff")
      .header("access-control-allow-origin", "*")
      .header("vary", "accept-encoding");
    if (!/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) return reply.send(f.data);
    let z = zipped.get(file);
    if (!z) zipped.set(file, (z = gzipSync(f.data)));
    return reply.header("content-encoding", "gzip").send(z);
  });

  await app.register(async (p) => {
    p.addHook("onSend", async (_req, reply, payload) => {
      reply.header("access-control-allow-origin", "*");
      reply.header("referrer-policy", "no-referrer");
      reply.header("x-content-type-options", "nosniff");
      return payload;
    });

    const page = (req: FastifyRequest) => {
      const { id, token } = req.params as { id: string; token: string };
      const found = hub.pages.open(id, token);
      if (!found) throw new HttpError(404, "not found");
      return found;
    };
    const media = (e: unknown) => (e instanceof MediaError ? new HttpError(e.status, e.key, { detail: e.message }) : e);
    const image = (reply: FastifyReply, data: Buffer, type: string, maxAge: number) =>
      reply.header("content-type", type).header("cache-control", `private, max-age=${maxAge}`).header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox").send(data);
    const body = (req: FastifyRequest): any => {
      const raw = req.body;
      if (raw && typeof raw === "object") return raw;
      try {
        return JSON.parse(String(raw ?? ""));
      } catch {
        throw new HttpError(400, "bad request");
      }
    };

    p.get("/p/:id/:token", async (req, reply) => {
      page(req);
      return reply.redirect(`${req.url.split("?")[0]}/`);
    });

    p.get("/p/:id/:token/", async (req, reply) => {
      const view = page(req);
      const k = getKit();
      if (!k) throw new HttpError(503, "pages.kitMissing");
      const host = String(req.headers.host ?? "").replace(/[^\w.:[\]-]/g, "");
      // In a sandboxed document 'self' may not match the hub: its own address is listed as well.
      const self = host ? `'self' http://${host} https://${host}` : "'self'";
      const csp = [
        "default-src 'none'",
        `script-src ${self}`,
        `style-src ${self} 'unsafe-inline'`,
        `img-src ${self} data: blob:`,
        `media-src ${self} https: blob:`,
        `font-src ${self} data:`,
        `connect-src ${self}`,
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        `frame-ancestors ${self}`,
        "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms",
      ].join("; ");
      return reply
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-cache")
        .header("content-security-policy", csp)
        .header("permissions-policy", "camera=(), microphone=(), geolocation=()")
        .send(hub.pages.html(view, { base: `/p/kit/${k.hash}/`, theme: k.theme }, hubLocale()));
    });

    p.get("/p/:id/:token/page.js", async (req, reply) => {
      const view = page(req);
      const script = hub.pages.script(view.id);
      if (!script) throw new HttpError(404, "not found");
      return reply.header("content-type", "text/javascript; charset=utf-8").header("cache-control", "no-cache").send(script);
    });

    p.get("/p/:id/:token/img", async (req, reply) => {
      page(req);
      try {
        // A page runs its own code: what it asks for is fetched, except a picture the hub held (policy/pictures.ts).
        const url = (req.query as { url?: string }).url;
        const r = hub.pictures.state(url) === "held" ? hub.media.cachedImage(url) : await hub.media.image(url);
        if (!r) throw new HttpError(403, "media.held");
        return image(reply, r.data, r.type, 24 * 3600);
      } catch (e) {
        throw media(e);
      }
    });

    p.get("/p/:id/:token/tiles/:z/:x/:y", async (req, reply) => {
      page(req);
      const { z, x, y } = req.params as { z: string; x: string; y: string };
      if (!y.endsWith(".png")) throw new HttpError(400, "media.badTile");
      try {
        return image(reply, await hub.media.tile(z, x, y), "image/png", 7 * 24 * 3600);
      } catch (e) {
        throw media(e);
      }
    });

    // A road route through the given points: { path, distanceM, durationS }.
    p.get("/p/:id/:token/route", async (req) => {
      page(req);
      const q = req.query as { mode?: string; points?: string };
      const mode = q.mode as Exclude<RouteMode, "transit">;
      if (!["walk", "drive", "bike"].includes(mode)) throw new HttpError(400, "bad request");
      const points = String(q.points ?? "")
        .split(";")
        .map((s) => s.split(",").map(Number) as [number, number]);
      if (points.length < 2 || points.length > MAX_ROUTE_STOPS || points.some(([la, lo]) => !(Math.abs(la) <= 90 && Math.abs(lo) <= 180))) throw new HttpError(400, "bad request");
      const found = await roadRoute(hub.config.routerUrl, mode, points);
      if ("error" in found) throw new HttpError(502, found.error);
      return found;
    });

    // JSON from the APIs pages may use (PAGE_API_HOSTS).
    p.get("/p/:id/:token/fetch", async (req, reply) => {
      page(req);
      try {
        const r = await hub.media.api((req.query as { url?: string }).url, pageApiHostAllowed);
        return reply.header("content-type", r.type).header("cache-control", "private, max-age=300").send(r.data);
      } catch (e) {
        throw media(e);
      }
    });

    p.post("/p/:id/:token/state", async (req, reply) => {
      const view = page(req);
      try {
        hub.pages.saveState(view.id, body(req));
      } catch (e) {
        throw e instanceof PageError ? new HttpError(400, e.message) : e;
      }
      return reply.code(204).send();
    });

    p.post("/p/:id/:token/error", async (req, reply) => {
      const view = page(req);
      const b = body(req);
      hub.pages.reportError(view.id, b?.message, b?.stack);
      return reply.code(204).send();
    });
  });
}
