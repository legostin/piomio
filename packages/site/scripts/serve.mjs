// A small static server for the built site (packages/site/dist), mounted at the site's base path as GitHub Pages
// would: `node packages/site/scripts/serve.mjs [port]`. The checks (check.mjs) use it too.

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

export const DIST = resolve(import.meta.dirname, "../dist");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** The base the site was built for (scripts/build.mjs writes it next to the build). */
export function builtBase() {
  try {
    return JSON.parse(readFileSync(resolve(import.meta.dirname, "../.build/data.json"), "utf8")).base || "/";
  } catch {
    return "/";
  }
}

export function serve({ port = 5198, dist = DIST, base = builtBase() } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let path = decodeURIComponent(url.pathname);
    if (!path.startsWith(base)) {
      if (path === "/" || path === base.slice(0, -1)) {
        res.writeHead(302, { location: base });
        return res.end();
      }
      return notFound(res);
    }
    path = path.slice(base.length);
    let file = normalize(join(dist, path));
    if (file !== dist && !file.startsWith(dist + sep)) return notFound(res);
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!path.endsWith("/") && path !== "") {
        res.writeHead(301, { location: `${base}${path}/` });
        return res.end();
      }
      file = join(file, "index.html");
    }
    if (!existsSync(file)) return notFound(res);
    // GitHub Pages answers every file with an open CORS header: the demo's agent-made page runs in a sandboxed frame
    // (an opaque origin) and loads its kit's fonts with CORS.
    res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache", "access-control-allow-origin": "*" });
    createReadStream(file).pipe(res);
  });
  const notFound = (res) => {
    const page = join(dist, "404.html");
    res.writeHead(404, { "content-type": TYPES[".html"] });
    if (existsSync(page)) createReadStream(page).pipe(res);
    else res.end("not found");
  };
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok(server)));
}

if (import.meta.main) {
  const port = Number(process.argv[2] ?? 5198);
  const base = builtBase();
  await serve({ port, base });
  console.log(`site: http://127.0.0.1:${port}${base}`);
}
