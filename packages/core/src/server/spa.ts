// The web UI's single-page app: its static files and index.html with the import map UI plugins resolve React and
// @piomio/ui through. Served by the main app (every path) and by the device port (the phone's chat under /m/).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requestLocale, tFor } from "../i18n.ts";
import { HttpError, safeFile, securityHeaders, sendFile } from "./http.ts";

const IMPORT_MAP = JSON.stringify({
  imports: {
    react: "/shared/react.js",
    "react/jsx-runtime": "/shared/react-jsx-runtime.js",
    "react-dom": "/shared/react-dom.js",
    "react-dom/client": "/shared/react-dom-client.js",
    "@piomio/ui": "/shared/piomio-ui.js",
  },
});

export function sendSpaIndex(webDist: string, req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const host = String(req.headers.host ?? "localhost");
  const nonce = randomBytes(16).toString("base64");
  securityHeaders(
    reply,
    [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self' ws://${host} wss://${host}`,
      "media-src 'self' blob:",
      // Pages agents make open in a sandboxed frame from /p/ (server/pages.ts).
      "frame-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
    // The browser's live view records the person's voice while they show an agent a task.
    { microphone: true },
  );
  const indexFile = join(webDist, "index.html");
  if (!existsSync(indexFile)) {
    return reply
      .type("text/html; charset=utf-8")
      .send(`<!doctype html><meta charset="utf-8"><title>Piomio</title><body style="font-family:sans-serif;padding:2rem">${tFor(requestLocale(req))("build.webMissing")}</body>`);
  }
  const html = readFileSync(indexFile, "utf8").replace("<head>", `<head>\n<script type="importmap" nonce="${nonce}">${IMPORT_MAP}</script>`);
  return reply.type("text/html; charset=utf-8").header("cache-control", "no-cache").send(html);
}

/** Static files of the web build, and index.html for the app's own routes (`isPage`). */
export function registerSpa(app: FastifyInstance, webDist: string, isPage: (rel: string) => boolean): void {
  app.get("/*", async (req, reply) => {
    const rel = decodeURIComponent((req.params as any)["*"] ?? "");
    if (rel.startsWith("api/")) throw new HttpError(404, "not found");
    if (rel && rel !== "index.html") {
      const file = safeFile(webDist, rel);
      if (file) {
        reply.header("x-content-type-options", "nosniff");
        return sendFile(reply, file, { cache: rel.startsWith("assets/"), compress: true });
      }
      if (/\.[a-z0-9]{1,8}$/i.test(rel)) throw new HttpError(404, "not found");
    }
    if (!isPage(rel)) throw new HttpError(404, "not found");
    return sendSpaIndex(webDist, req, reply);
  });
}
