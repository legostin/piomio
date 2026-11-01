import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { transform } from "esbuild";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const HUB = "http://127.0.0.1:8080";

// Same import map the hub injects into index.html in production (see packages/core/src/server/main-app.ts).
// In dev Vite serves index.html itself, so we add it here (dev only; the production build keeps `<head>` untouched).
const IMPORT_MAP = {
  imports: {
    react: "/shared/react.js",
    "react/jsx-runtime": "/shared/react-jsx-runtime.js",
    "react-dom": "/shared/react-dom.js",
    "react-dom/client": "/shared/react-dom-client.js",
    "@piomio/ui": "/shared/piomio-ui.js",
  },
};

function devImportMap(): Plugin {
  return {
    name: "piomio-dev-import-map",
    apply: "serve",
    // demo.html carries its own map (relative paths).
    transformIndexHtml: (_html, ctx) => (ctx.path.endsWith("demo.html") ? [] : [{ tag: "script", attrs: { type: "importmap" }, children: JSON.stringify(IMPORT_MAP), injectTo: "head-prepend" }]),
  };
}

// ----- The demo build (`vite build --mode demo`, the website's live demo: src/demo/) -----

const ROOT = resolve(import.meta.dirname, "../..");
/** UI plugins the demo hub lists in its bootstrap (src/demo/hub/routes.ts). */
const DEMO_UI_PLUGINS = ["browser", "memory", "triggers"];
/** Logos of the integrations the demo shows, from the plugins that ship them (served as logos/<id>.png). */
const DEMO_LOGOS: Record<string, string> = {
  notion: "integrations/notion/logo.png",
  linear: "integrations/linear/logo.png",
  telegram: "plugins/telegram/logo.png",
  gmail: "integrations/composio/logos/gmail.png",
  "google-calendar": "integrations/composio/logos/googlecalendar.png",
  slack: "integrations/composio/logos/slack.png",
  github: "integrations/composio/logos/github.png",
};
const MIME: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  html: "text/html; charset=utf-8",
  json: "application/json",
  js: "text/javascript",
  css: "text/css",
  woff2: "font/woff2",
};
/** Files served next to demo.html: pictures, tiles, pages (src/demo/static/). */
const DEMO_STATIC = resolve(import.meta.dirname, "src/demo/static");

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

async function serviceWorker(): Promise<string> {
  const src = readFileSync(resolve(import.meta.dirname, "src/demo/sw.ts"), "utf8");
  return (await transform(src, { loader: "ts", format: "iife", target: "es2022" })).code;
}

/** The demo's service worker, the UI plugins' modules and its static files: served in dev, emitted in the build. */
function demoFiles(): Plugin {
  const plugin = (id: string) => resolve(ROOT, "plugins", id, "ui/dist/index.js");
  return {
    name: "piomio-demo-files",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? "").split("?")[0];
        const ui = /^\/plugins-ui\/([a-z-]+)\/index\.js$/.exec(path);
        let body: string | Buffer | undefined;
        let type = "text/javascript";
        if (path === "/demo-sw.js") body = await serviceWorker();
        else if (ui && DEMO_UI_PLUGINS.includes(ui[1]) && existsSync(plugin(ui[1]))) body = readFileSync(plugin(ui[1]));
        else if (/^\/logos\/[a-z-]+\.png$/.test(path) && DEMO_LOGOS[path.slice(7, -4)]) {
          body = readFileSync(resolve(ROOT, DEMO_LOGOS[path.slice(7, -4)]));
          type = "image/png";
        } else if (/^\/(media|files|tiles|pages|frames)\//.test(path)) {
          const file = join(DEMO_STATIC, path.endsWith("/") ? `${path}index.html` : path);
          if (existsSync(file) && statSync(file).isFile()) {
            body = readFileSync(file);
            type = MIME[file.slice(file.lastIndexOf(".") + 1)] ?? "application/octet-stream";
          }
        }
        if (body === undefined) return next();
        res.setHeader("content-type", type);
        // As GitHub Pages does: the demo's page runs in a sandboxed frame and loads its kit's fonts with CORS.
        res.setHeader("access-control-allow-origin", "*");
        res.end(body);
      });
    },
    async generateBundle() {
      this.emitFile({ type: "asset", fileName: "demo-sw.js", source: await serviceWorker() });
      for (const id of DEMO_UI_PLUGINS) {
        if (!existsSync(plugin(id))) this.error(`UI plugin ${id} is not built: npm run build:ui-plugins`);
        this.emitFile({ type: "asset", fileName: `plugins-ui/${id}/index.js`, source: readFileSync(plugin(id)) });
      }
      for (const [id, src] of Object.entries(DEMO_LOGOS)) this.emitFile({ type: "asset", fileName: `logos/${id}.png`, source: readFileSync(resolve(ROOT, src)) });
      for (const f of filesUnder(DEMO_STATIC)) this.emitFile({ type: "asset", fileName: relative(DEMO_STATIC, f), source: readFileSync(f) });
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: mode === "demo" ? "./" : "/",
  plugins: [react(), tailwindcss(), devImportMap(), ...(mode === "demo" ? [demoFiles()] : [])],
  resolve: {
    // The browser-safe part of @piomio/shared, taken from this checkout (not whatever node_modules links to).
    alias: {
      "@piomio/shared/i18n": resolve(import.meta.dirname, "../shared/src/i18n.ts"),
      "@piomio/shared/avatar": resolve(import.meta.dirname, "../shared/src/avatar.ts"),
      "@piomio/shared/group": resolve(import.meta.dirname, "../shared/src/group.ts"),
      "@piomio/shared/thinking": resolve(import.meta.dirname, "../shared/src/thinking.ts"),
      "@piomio/shared/commands": resolve(import.meta.dirname, "../shared/src/commands.ts"),
      "@piomio/shared/models": resolve(import.meta.dirname, "../shared/src/models.ts"),
    },
  },
  build: {
    outDir: mode === "demo" ? "dist-demo" : "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    ...(mode === "demo" ? { rollupOptions: { input: resolve(import.meta.dirname, "demo.html") } } : {}),
  },
  server: {
    port: 5173,
    strictPort: true,
    // The demo answers /api itself (src/demo/shims.ts) and serves its own plugin modules.
    proxy:
      mode === "demo"
        ? undefined
        : {
            "/api": { target: HUB, ws: true },
            "/mcp": { target: HUB },
            "/plugins-ui": { target: HUB },
            "/shared": { target: HUB },
          },
  },
}));
