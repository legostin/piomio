// Prerendering: each page (the landing page, the server guide) per language from the client build's index.html and the
// server build's render(), the docs (scripts/docs.mjs: every line, every page, in every language, with each page's
// Markdown next to it for agents), plus the language chooser at the root (with the English page's head, so a shared
// bare link still shows a card), a 404 page, sitemap.xml, robots.txt and llms.txt.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { frontMatter } from "../src/docs/markdown.ts";
import { analyticsSnippet, indexablePaths, languageRedirectScript, robotsTxt, sitemapXml } from "../src/seo.ts";
import { loadDocs, pageData } from "./docs.mjs";

/**
 * @param {{ dist: string; ssrEntry: string; languages: readonly string[]; base: string; origin: string; release?: string; repo: string; gaMeasurementId?: string }} o
 */
export async function prerender({ dist, ssrEntry, languages, base, origin, release, repo, gaMeasurementId }) {
  const template = readFileSync(join(dist, "index.html"), "utf8");
  const { render, renderDoc, llmsTxt, PAGES, pagePath } = await import(pathToFileURL(ssrEntry).href);
  const analytics = analyticsSnippet(gaMeasurementId);
  const write = (file, text) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  // Functions as replacements: a page's text may hold `$&` or `$1` (shell commands in the docs).
  const fill = (lang, marked, head, html) =>
    template
      .replace('<html lang="en">', () => `<html lang="${lang}"${marked ? ` data-page="${marked}"` : ""}>`)
      .replace("<!--head-->", () => `${head}${analytics}`)
      .replace("<!--app-->", () => html);
  for (const lang of languages)
    for (const which of PAGES) {
      const { html, head } = render(lang, which);
      write(join(dist, lang, pagePath(which), "index.html"), fill(lang, which === "home" ? "" : which, head, html));
    }

  // The docs: the newest line at /<lang>/docs/… and /<lang>/docs/<line>/…, older lines at /<lang>/docs/<line>/….
  const lines = loadDocs({ languages, release });
  let docPages = 0;
  for (const line of lines)
    for (const prefix of line.current ? ["", `${line.id}/`] : [`${line.id}/`])
      for (const lang of languages)
        for (const slug of Object.keys(line.pages[lang])) {
          const doc = pageData({ lines, line, lang, slug, prefix, repo });
          const { html, head } = renderDoc(doc);
          const json = JSON.stringify(doc).replace(/</g, "\\u003c");
          const folder = join(dist, lang, "docs", prefix, slug === "index" ? "" : slug);
          write(join(folder, "index.html"), fill(lang, "docs", `${head}\n    <script type="application/json" id="doc-data">${json}</script>`, html));
          write(join(dist, lang, "docs", prefix, `${slug}.md`), doc.source);
          docPages++;
        }
  const newest = lines[0];
  const docSlugs = Object.keys(newest.pages.en);
  console.log(`[site] docs: ${docPages} pages, lines ${lines.map((l) => `${l.id} (${l.release})`).join(", ")}`);

  // The root and unknown addresses: the visitor's language (English by default), plain links without scripts.
  const chooser = (head) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
${head}
<link rel="icon" type="image/svg+xml" href="${base}favicon.svg" />
<script>
  ${languageRedirectScript(base, languages)}
</script>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #f7f4ef; color: #1c1814; }
  @media (prefers-color-scheme: dark) { body { background: #12100e; color: #f4eee6; } }
  a { color: #a35c00; font-weight: 600; margin: 0 .6rem; }
</style>
</head>
<body>
<p>${languages.map((l) => `<a href="${base}${l}/" hreflang="${l}">${{ en: "English", ru: "Русский", zh: "简体中文" }[l] ?? l}</a>`).join(" · ")}</p>
</body>
</html>
`;
  const alternates = [...languages.map((l) => `<link rel="alternate" hreflang="${l}" href="${origin}${base}${l}/" />`), `<link rel="alternate" hreflang="x-default" href="${origin}${base}en/" />`];
  writeFileSync(join(dist, "index.html"), chooser(render("en").head));
  writeFileSync(join(dist, "404.html"), chooser(["<title>Piomio</title>", `<meta name="robots" content="noindex" />`, ...alternates].join("\n")));
  writeFileSync(
    join(dist, "llms.txt"),
    llmsTxt(
      docSlugs.map((slug) => {
        const { meta } = frontMatter(newest.pages.en[slug]);
        return { slug, title: meta.title, description: meta.description };
      }),
    ),
  );

  const paths = indexablePaths(PAGES.map(pagePath), docSlugs);
  writeFileSync(join(dist, "sitemap.xml"), sitemapXml({ origin, base, languages, paths, lastmod: new Date().toISOString().slice(0, 10) }));
  writeFileSync(join(dist, "robots.txt"), robotsTxt({ origin, base }));
}
