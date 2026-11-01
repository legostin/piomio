// Builds the website into packages/site/dist: the live demo (packages/web, demo mode) at dist/demo/, the page
// prerendered per language, Open Graph pictures, sitemap and robots.
//
//   SITE_BASE    where the site lives: "/" with a domain (default), "/piomio/" on legostin.github.io
//   SITE_ORIGIN  its address for canonical links (default: https://legostin.github.io, or siteConfig.siteUrl)
//   SITE_CNAME   a domain to write into dist/CNAME (GitHub Pages)
//   GITHUB_TOKEN optional, for the release and star count lookups
//   --skip-demo  reuse packages/web/dist-demo as it is

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "vite";
import { siteConfig } from "../site.config.ts";
import { ogImages } from "./og.mjs";
import { prerender } from "./prerender.mjs";

const SITE = resolve(import.meta.dirname, "..");
const ROOT = resolve(SITE, "../..");
const WEB = join(ROOT, "packages/web");
const DIST = join(SITE, "dist");
const WORK = join(SITE, ".build");

const slash = (b) => `/${b.replace(/^\/+|\/+$/g, "")}/`.replace(/\/+/g, "/");
const base = slash(process.env.SITE_BASE || "/");
const origin = (process.env.SITE_ORIGIN || siteConfig.siteUrl || "https://legostin.github.io").replace(/\/+$/, "");
const skipDemo = process.argv.includes("--skip-demo");

async function github(path) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "piomio-site-build" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/${path}`, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

/** The latest release's installers and the star count; without network, the releases page and no count. */
async function releaseData() {
  const page = `https://github.com/${siteConfig.repo}/releases`;
  const out = { release: { page: `${page}/latest` }, stars: undefined };
  try {
    const r = await github(`repos/${siteConfig.repo}/releases/latest`);
    const asset = (re) => r.assets?.find((a) => re.test(a.name))?.browser_download_url;
    out.release = { version: String(r.tag_name ?? "").replace(/^v/, "") || undefined, mac: asset(/\.dmg$/i), win: asset(/setup.*\.exe$/i), page: r.html_url ?? `${page}/latest` };
  } catch (e) {
    console.warn(`[site] no release info: ${e.message}`);
  }
  try {
    out.stars = (await github(`repos/${siteConfig.repo}`)).stargazers_count;
  } catch (e) {
    console.warn(`[site] no star count: ${e.message}`);
  }
  return out;
}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: process.env });
}

// 1. What the page needs to know, for Vite's define.
mkdirSync(WORK, { recursive: true });
const { release, stars } = await releaseData();
const data = { base, origin, release, ...(stars !== undefined ? { stars } : {}), testflightUrl: siteConfig.testflightUrl, repo: siteConfig.repo };
writeFileSync(join(WORK, "data.json"), JSON.stringify(data, null, 2));
process.env.SITE_BASE = base;

// 2. The live demo: the web UI's demo build.
if (!skipDemo) {
  if (!existsSync(join(ROOT, "plugins/browser/ui/dist/index.js"))) run("node", ["scripts/build-ui-plugins.mjs"], ROOT);
  run("node", ["scripts/gen-shims.mjs"], WEB);
  // The agent-made page of the "pages" chapter: the kit, then the page compiled the way the hub serves it.
  if (!existsSync(join(ROOT, "packages/pages-kit/dist/kit.js"))) run("node", ["build.mjs"], join(ROOT, "packages/pages-kit"));
  run("node", ["scripts/build-demo-pages.mjs"], WEB);
  await build({ root: WEB, configFile: join(WEB, "vite.config.ts"), mode: "demo", logLevel: "warn" });
}
if (!existsSync(join(WEB, "dist-demo/demo.html"))) throw new Error("packages/web/dist-demo is missing: build it without --skip-demo");

// 3. The page: the client build, then the server build that prerenders it.
await build({ root: SITE, configFile: join(SITE, "vite.config.ts"), logLevel: "warn" });
const ssrOut = join(WORK, "ssr");
await build({ root: SITE, configFile: join(SITE, "vite.config.ts"), logLevel: "warn", build: { ssr: "src/entry-server.tsx", outDir: ssrOut, emptyOutDir: true, copyPublicDir: false } });
await prerender({ dist: DIST, ssrEntry: join(ssrOut, "entry-server.js"), languages: siteConfig.languages, base, origin });
rmSync(ssrOut, { recursive: true, force: true });

// 4. The demo next to the page, the server installer (curl -fsSL <site>/install.sh | sh), the pictures for links, and
// GitHub Pages' own files.
cpSync(join(WEB, "dist-demo"), join(DIST, "demo"), { recursive: true });
cpSync(join(ROOT, "packaging", "linux", "install.sh"), join(DIST, "install.sh"));
await ogImages(DIST, siteConfig.languages);
writeFileSync(join(DIST, ".nojekyll"), "");
if (process.env.SITE_CNAME) writeFileSync(join(DIST, "CNAME"), `${process.env.SITE_CNAME.trim()}\n`);

console.log(`[site] built ${DIST} for ${origin}${base} (${siteConfig.languages.join(", ")})`);
