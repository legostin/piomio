// Sitemap, robots.txt and the GA4 snippet for the prerendered site. An empty or invalid measurement ID injects nothing.

const GA_ID = /^G-[A-Za-z0-9]+$/;

/** A GA4 measurement ID, or "" when the value is missing or not an ID. */
export function gaMeasurementId(value: string | undefined | null): string {
  const id = (value ?? "").trim();
  return GA_ID.test(id) ? id : "";
}

/**
 * What the build should inject. `GA_MEASUREMENT_ID` wins when the variable is present, including when it is empty
 * (that turns analytics off). When the variable is absent, `configured` (site.config.ts) is the default.
 */
export function measurementIdFrom(envValue: string | undefined, configured: string): string {
  return gaMeasurementId(envValue !== undefined ? envValue : configured);
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Absolute page URL: origin + base + /<lang>/<path>. `path` is "" or "server/" or "docs/install/". */
export function pageUrl(origin: string, base: string, lang: string, path: string): string {
  const root = origin.replace(/\/+$/, "");
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return `${root}${prefix.startsWith("/") ? prefix : `/${prefix}`}${lang}/${path.replace(/^\/+/, "")}`;
}

/** Fixed pages plus the current docs line. Older lines stay out (they are noindex). Adding a nav page adds it here. */
export function indexablePaths(pagePaths: readonly string[], docSlugs: readonly string[]): string[] {
  return [...pagePaths, ...docSlugs.map((slug) => (slug === "index" ? "docs/" : `docs/${slug}/`))];
}

export function sitemapXml(o: { origin: string; base: string; languages: readonly string[]; paths: readonly string[]; lastmod: string; docLanguages?: readonly string[] }): string {
  if (o.paths.length === 0 || o.languages.length === 0) throw new Error("sitemap has no public pages");
  const languagesFor = (path: string) => path.startsWith("docs/") ? o.docLanguages ?? o.languages : o.languages;
  const urls = o.paths.flatMap((path) =>
    languagesFor(path).map((lang) => {
      const alternates = [
        ...languagesFor(path).map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${xml(pageUrl(o.origin, o.base, l, path))}" />`),
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${xml(pageUrl(o.origin, o.base, "en", path))}" />`,
      ];
      return `  <url>
    <loc>${xml(pageUrl(o.origin, o.base, lang, path))}</loc>
    <lastmod>${xml(o.lastmod)}</lastmod>
${alternates.join("\n")}
  </url>`;
    }),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join("\n")}
</urlset>
`;
}

export function robotsTxt(o: { origin: string; base: string }): string {
  const root = o.origin.replace(/\/+$/, "");
  const prefix = o.base.endsWith("/") ? o.base : `${o.base}/`;
  const base = prefix.startsWith("/") ? prefix : `/${prefix}`;
  return `User-agent: *\nAllow: /\nDisallow: ${base}demo/\nSitemap: ${root}${base}sitemap.xml\n`;
}

/** The language chooser redirect. Keeps the query string and the hash, so UTM parameters survive the hop. */
export function languageRedirectScript(base: string, languages: readonly string[]): string {
  return `var langs = ${JSON.stringify(languages)};
  var want = (navigator.languages || [navigator.language || "en"]).map(function (l) { return String(l).slice(0, 2).toLowerCase(); });
  var pick = want.find(function (l) { return langs.indexOf(l) >= 0; }) || "en";
  location.replace(${JSON.stringify(base)} + pick + "/" + location.search + location.hash);`;
}

/** Append a request's search (`?utm_source=…`) to a redirect target. An empty search stays off the URL. */
export function withSearch(location: string, search: string): string {
  if (!search || search === "?") return location;
  return `${location}${search.startsWith("?") ? search : `?${search}`}`;
}

/**
 * GA4 gtag.js for one measurement ID, or "" when there is nothing to load. Download, TestFlight and GitHub anchors
 * carry data-ga="download|testflight|github"; the snippet sends that name as an event. Enhanced measurement still
 * records the outbound click on its own.
 */
export function analyticsSnippet(id: string | undefined | null): string {
  const measurementId = gaMeasurementId(id);
  if (!measurementId) return "";
  return `<script async src="https://www.googletagmanager.com/gtag/js?id=${measurementId}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', ${JSON.stringify(measurementId)});
  document.addEventListener('click', function (event) {
    var el = event.target && event.target.closest ? event.target.closest('a[data-ga]') : null;
    if (!el) return;
    var name = el.getAttribute('data-ga');
    if (name !== 'download' && name !== 'testflight' && name !== 'github') return;
    gtag('event', name, { link_url: el.href, transport_type: 'beacon' });
  });
</script>
`;
}

/** Fail when the published files would leave a crawler with nothing to index. */
export function assertPublishedSeo(
  sitemap: string,
  robots: string,
  o: { origin: string; base: string; languages: readonly string[]; pagePaths: readonly string[]; docSlugs: readonly string[]; docLanguages?: readonly string[] },
): void {
  if (!sitemap.trim() || !sitemap.includes("<urlset")) throw new Error("sitemap.xml is empty");
  if (!robots.trim()) throw new Error("robots.txt is empty");
  const locs = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
  if (locs.size === 0) throw new Error("sitemap.xml is empty");
  for (const path of indexablePaths(o.pagePaths, o.docSlugs))
    for (const lang of path.startsWith("docs/") ? o.docLanguages ?? o.languages : o.languages) {
      const url = pageUrl(o.origin, o.base, lang, path);
      if (!locs.has(url)) throw new Error(`sitemap.xml is missing ${url}`);
    }
  const root = o.origin.replace(/\/+$/, "");
  const prefix = o.base.endsWith("/") ? o.base : `${o.base}/`;
  const base = prefix.startsWith("/") ? prefix : `/${prefix}`;
  const sitemapUrl = `${root}${base}sitemap.xml`;
  if (!robots.includes(`Sitemap: ${sitemapUrl}`)) throw new Error(`robots.txt does not point at ${sitemapUrl}`);
  if (!/^User-agent:\s*\*/m.test(robots) || !/^Allow:\s*\//m.test(robots)) throw new Error("robots.txt does not allow crawling");
}
