// The website's checks, on the built site (npm run build:site first): the landing page, the server guide and every docs
// page open without errors in both languages, and every chapter of the demo plays to its end in both languages, fast,
// without the demo hub meeting a request it does not know.
//
//   node packages/site/scripts/check.mjs [--speed 8] [--only mail,send] [--lang ru]
//
// Exits 1 with a summary when something failed.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { siteConfig } from "../site.config.ts";
import { PAGES, pagePath } from "../src/pages.ts";
import { assertPublishedSeo, gaMeasurementId } from "../src/seo.ts";
import { builtBase, DIST, serve } from "./serve.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const speed = Number(arg("speed", "8"));
const langs = arg("lang", "en,ru").split(",");
const chaptersSrc = readFileSync(resolve(import.meta.dirname, "../src/demo/protocol.ts"), "utf8");
const all = [...(/CHAPTERS\s*=\s*\[([^\]]*)\]/.exec(chaptersSrc)?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
const chapters = arg("only", all.join(",")).split(",");
const TIMEOUT = 90_000;

if (!existsSync(join(DIST, "demo/demo.html"))) {
  console.error("packages/site/dist is not built: npm run build:site");
  process.exit(1);
}

const published = JSON.parse(readFileSync(resolve(import.meta.dirname, "../.build/data.json"), "utf8"));
const docSlugs = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../docs/guide/nav.json"), "utf8")).groups.flatMap((g) => g.pages);
assertPublishedSeo(readFileSync(join(DIST, "sitemap.xml"), "utf8"), readFileSync(join(DIST, "robots.txt"), "utf8"), {
  origin: published.origin,
  base: published.base,
  languages: siteConfig.languages,
  pagePaths: PAGES.map(pagePath),
  docSlugs,
});
const gaId = gaMeasurementId(process.env.GA_MEASUREMENT_ID !== undefined ? process.env.GA_MEASUREMENT_ID : siteConfig.gaMeasurementId);
const homeEn = readFileSync(join(DIST, "en/index.html"), "utf8");
const homeRu = readFileSync(join(DIST, "ru/index.html"), "utf8");
const docsEn = readFileSync(join(DIST, "en/docs/index.html"), "utf8");
const chooser = readFileSync(join(DIST, "index.html"), "utf8");
if (!chooser.includes("location.search")) throw new Error("the language redirect drops the query string");
if (gaId) {
  for (const [file, html] of [["/en/", homeEn], ["/ru/", homeRu], ["/en/docs/", docsEn]]) {
    if (!html.includes(`https://www.googletagmanager.com/gtag/js?id=${gaId}`)) throw new Error(`${file} is missing the GA4 snippet`);
  }
  if (!homeEn.includes('data-ga="download"') || !homeEn.includes('data-ga="testflight"') || !homeEn.includes('data-ga="github"'))
    throw new Error("the landing page is missing a Download, TestFlight or GitHub analytics anchor");
  if (chooser.includes("googletagmanager.com")) throw new Error("the language chooser loads GA4 and would count the visit twice");
} else if ([homeEn, homeRu, docsEn, chooser].some((html) => html.includes("googletagmanager.com"))) {
  throw new Error("analytics was injected with no measurement ID");
}
console.log(`[site] sitemap, robots and analytics (${gaId || "off"}) ok`);

const base = builtBase();
const server = await serve({ port: 0, base });
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const failures = [];

/** Console errors, page errors and the demo hub's unknown routes, per page. */
function watch(page, label) {
  const problems = [];
  page.on("console", (m) => {
    const text = m.text();
    if (m.type() === "error" || text.includes("[demo] unknown route") || text.includes("[demo] chapter failed")) problems.push(`${m.type()}: ${text}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    // Leaving a page cancels what it was loading; that is not a failure.
    if (!/ERR_ABORTED/.test(r.failure()?.errorText ?? "")) problems.push(`request failed: ${r.url()} ${r.failure()?.errorText}`);
  });
  return () => problems.map((p) => `${label}: ${p}`);
}

// 1. The pages themselves.
for (const lang of langs) {
  const page = await context.newPage();
  const problems = watch(page, `/${lang}/`);
  const res = await page.goto(`${origin}${base}${lang}/`, { waitUntil: "load" });
  if (!res?.ok()) failures.push(`/${lang}/: HTTP ${res?.status()}`);
  try {
    await page.waitForFunction(() => {
      const w = document.querySelector("iframe")?.contentWindow;
      const t = w?.__demo?.last?.type;
      return t === "ready" || t === "playing" || t === "ended";
    }, null, { timeout: 30_000 });
  } catch {
    failures.push(`/${lang}/: the window's demo never said it was ready`);
  }
  const title = await page.title();
  if (!title.includes("Piomio")) failures.push(`/${lang}/: title "${title}"`);
  failures.push(...problems());
  await page.close();
  console.log(`page /${lang}/ checked`);
}

// 2. The server guide: prerendered, hydrated without a mismatch, its language switch pointing at the guide.
for (const lang of langs) {
  const page = await context.newPage();
  const problems = watch(page, `/${lang}/server/`);
  const res = await page.goto(`${origin}${base}${lang}/server/`, { waitUntil: "networkidle" });
  if (!res?.ok()) failures.push(`/${lang}/server/: HTTP ${res?.status()}`);
  const seen = await page.evaluate(() => ({
    page: document.documentElement.dataset.page,
    parts: ["hub", "computer", "address", "trouble"].filter((id) => document.getElementById(id)).length,
    other: [...document.querySelectorAll("a[hreflang]")].map((a) => a.getAttribute("href")),
  }));
  if (seen.page !== "server" || seen.parts !== 4) failures.push(`/${lang}/server/: ${JSON.stringify(seen)}`);
  if (!seen.other.every((h) => h?.endsWith("/server/"))) failures.push(`/${lang}/server/: language links ${seen.other.join(", ")}`);
  failures.push(...problems());
  await page.close();
  console.log(`page /${lang}/server/ checked`);
}

// 3. The docs: every page of the newest line, prerendered and hydrated without a mismatch, its language links and its
// sidebar on the same page, its Markdown next to it; the versioned copy of the overview.
const nav = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../docs/guide/nav.json"), "utf8"));
const slugs = nav.groups.flatMap((g) => g.pages);
const line = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../package.json"), "utf8")).version.split(".").slice(0, 2).join(".");
for (const lang of langs) {
  const page = await context.newPage();
  for (const [slug, prefix] of [...slugs.map((s) => [s, ""]), ["index", `${line}/`]]) {
    const path = `/${lang}/docs/${prefix}${slug === "index" ? "" : `${slug}/`}`;
    const problems = watch(page, path);
    const res = await page.goto(`${origin}${base}${path.slice(1)}`, { waitUntil: "networkidle" });
    if (!res?.ok()) failures.push(`${path}: HTTP ${res?.status()}`);
    const seen = await page.evaluate(() => ({
      page: document.documentElement.dataset.page,
      title: document.querySelector("article h1")?.textContent ?? "",
      other: [...document.querySelectorAll("header a[hreflang]")].map((a) => a.getAttribute("href")),
      current: [...document.querySelectorAll('aside nav a[aria-current="page"]')].map((a) => a.getAttribute("href")),
    }));
    const tail = `docs/${prefix}${slug === "index" ? "" : `${slug}/`}`;
    if (seen.page !== "docs" || !seen.title) failures.push(`${path}: ${JSON.stringify(seen)}`);
    if (!seen.other.every((h) => h?.endsWith(tail))) failures.push(`${path}: language links ${seen.other.join(", ")}`);
    if (!seen.current.every((h) => h?.endsWith(tail)) || !seen.current.length) failures.push(`${path}: sidebar marks ${seen.current.join(", ")}`);
    failures.push(...problems());
    page.removeAllListeners();
  }
  const md = await context.request.get(`${origin}${base}${lang}/docs/${slugs[1]}.md`);
  if (!md.ok() || !(await md.text()).startsWith("---")) failures.push(`/${lang}/docs/${slugs[1]}.md: not the page's Markdown`);
  await page.close();
  console.log(`docs /${lang}/docs/: ${slugs.length} pages checked`);
}

// A chapter may open after a previous tab closed mid-reply. Keep a streaming snapshot on the
// site's origin: every fresh demo world must ignore it, and must leave the device's cache alone.
const cacheProbe = await context.newPage();
await cacheProbe.goto(`${origin}${base}robots.txt`);
await cacheProbe.evaluate(async () => {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open("piomio-cache", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("data")) db.createObjectStore("data");
      if (!db.objectStoreNames.contains("media")) db.createObjectStore("media", { keyPath: "url" }).createIndex("at", "at");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction("data", "readwrite");
    for (const agent of ["pio", "ada", "leo", "bit"]) {
      const id = `dlg_${agent}`;
      tx.objectStore("data").put([{ id: `cache-poison-${id}`, conversationId: id, role: "assistant", parts: [], status: "streaming", createdAt: new Date().toISOString() }], `messages:${id}`);
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
});
await cacheProbe.close();

// 4. Every chapter, in every language, to its end.
for (const lang of langs)
  for (const chapter of chapters) {
    const page = await context.newPage();
    const problems = watch(page, `${lang}/${chapter}`);
    const started = Date.now();
    await page.goto(`${origin}${base}demo/demo.html?lang=${lang}&chapter=${chapter}&autoplay=1&speed=${speed}`, { waitUntil: "load" });
    let outcome = "timeout";
    try {
      const handle = await page.waitForFunction(
        () => {
          const last = window.__demo?.last;
          return last && (last.type === "ended" || (last.type === "failed" && last.message !== "no service worker")) ? last : null;
        },
        null,
        { timeout: TIMEOUT, polling: 250 },
      );
      const last = await handle.jsonValue();
      outcome = last.type === "ended" ? "ended" : `failed: ${last.message}`;
      if (last.chapter !== chapter) outcome += ` (played "${last.chapter}": no such chapter yet)`;
    } catch {
      /* timeout */
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (!outcome.startsWith("ended")) failures.push(`${lang}/${chapter}: ${outcome}`);
    failures.push(...problems());
    console.log(`${lang}/${chapter}: ${outcome} in ${secs}s`);
    await page.close();
  }

await browser.close();
server.close();

if (failures.length) {
  console.error(`\n${failures.length} problem(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("\nsite checks passed");
