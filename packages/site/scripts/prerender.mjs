// Prerendering: one static page per language from the client build's index.html and the server build's render(), plus
// the language chooser at the root (with the English page's head, so a shared bare link still shows a card), a 404
// page, sitemap.xml, robots.txt and llms.txt.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @param {{ dist: string; ssrEntry: string; languages: readonly string[]; base: string; origin: string }} o
 */
export async function prerender({ dist, ssrEntry, languages, base, origin }) {
  const template = readFileSync(join(dist, "index.html"), "utf8");
  const { render, llmsTxt } = await import(pathToFileURL(ssrEntry).href);
  for (const lang of languages) {
    const { html, head } = render(lang);
    const page = template
      .replace('<html lang="en">', `<html lang="${lang}">`)
      .replace("<!--head-->", head)
      .replace("<!--app-->", html);
    mkdirSync(join(dist, lang), { recursive: true });
    writeFileSync(join(dist, lang, "index.html"), page);
  }

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
  var langs = ${JSON.stringify(languages)};
  var want = (navigator.languages || [navigator.language || "en"]).map(function (l) { return String(l).slice(0, 2).toLowerCase(); });
  var pick = want.find(function (l) { return langs.indexOf(l) >= 0; }) || "en";
  location.replace(${JSON.stringify(base)} + pick + "/");
</script>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #f7f4ef; color: #1c1814; }
  @media (prefers-color-scheme: dark) { body { background: #12100e; color: #f4eee6; } }
  a { color: #a35c00; font-weight: 600; margin: 0 .6rem; }
</style>
</head>
<body>
<p><a href="${base}en/" hreflang="en">English</a> · <a href="${base}ru/" hreflang="ru">Русский</a></p>
</body>
</html>
`;
  const alternates = [...languages.map((l) => `<link rel="alternate" hreflang="${l}" href="${origin}${base}${l}/" />`), `<link rel="alternate" hreflang="x-default" href="${origin}${base}en/" />`];
  writeFileSync(join(dist, "index.html"), chooser(render("en").head));
  writeFileSync(join(dist, "404.html"), chooser(["<title>Piomio</title>", ...alternates].join("\n")));
  writeFileSync(join(dist, "llms.txt"), llmsTxt());

  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    join(dist, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${languages
  .map(
    (l) => `  <url>
    <loc>${origin}${base}${l}/</loc>
    <lastmod>${today}</lastmod>
${languages.map((x) => `    <xhtml:link rel="alternate" hreflang="${x}" href="${origin}${base}${x}/" />`).join("\n")}
  </url>`,
  )
  .join("\n")}
</urlset>
`,
  );
  writeFileSync(join(dist, "robots.txt"), `User-agent: *\nAllow: /\nDisallow: ${base}demo/\nSitemap: ${origin}${base}sitemap.xml\n`);
}
