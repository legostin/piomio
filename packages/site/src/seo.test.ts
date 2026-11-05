// Sitemap, robots and the GA4 hook: every public page, hreflang, and no script unless a measurement ID is set.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { siteConfig } from "../site.config";
import { PAGES, pagePath } from "./pages";
import { analyticsSnippet, assertPublishedSeo, gaMeasurementId, indexablePaths, languageRedirectScript, measurementIdFrom, robotsTxt, sitemapXml, withSearch } from "./seo";

const nav = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../docs/guide/nav.json"), "utf8")) as {
  groups: Array<{ pages: string[] }>;
};
const docSlugs = nav.groups.flatMap((g) => g.pages);
const paths = indexablePaths(PAGES.map(pagePath), docSlugs);

describe("sitemap and robots", () => {
  const languages = [...siteConfig.languages];
  const xml = sitemapXml({ origin: "https://piomio.io", base: "/", languages, paths, lastmod: "2026-11-04" });

  it("lists every public page in every language, with hreflang and an absolute sitemap URL", () => {
    expect(languages).toEqual(["en", "ru", "zh"]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    for (const path of ["", "server/", "docs/", "docs/install/", "docs/troubleshooting/"])
      for (const lang of languages) {
        const loc = `https://piomio.io/${lang}/${path}`;
        expect(xml, loc).toContain(`<loc>${loc}</loc>`);
      }
    expect(xml).toContain('<xhtml:link rel="alternate" hreflang="en" href="https://piomio.io/en/docs/install/" />');
    expect(xml).toContain('<xhtml:link rel="alternate" hreflang="ru" href="https://piomio.io/ru/docs/install/" />');
    expect(xml).toContain('<xhtml:link rel="alternate" hreflang="zh" href="https://piomio.io/zh/docs/install/" />');
    expect(xml).toContain('<xhtml:link rel="alternate" hreflang="x-default" href="https://piomio.io/en/docs/install/" />');
    expect(xml.match(/<loc>/g)?.length).toBe(paths.length * languages.length);
    expect(paths.length).toBeGreaterThan(docSlugs.length);

    const robots = robotsTxt({ origin: "https://piomio.io", base: "/" });
    expect(robots).toBe("User-agent: *\nAllow: /\nDisallow: /demo/\nSitemap: https://piomio.io/sitemap.xml\n");
    assertPublishedSeo(xml, robots, { origin: "https://piomio.io", base: "/", languages, pagePaths: PAGES.map(pagePath), docSlugs });
  });

  it("keeps the GitHub Pages base path in every URL", () => {
    const nested = sitemapXml({ origin: "https://legostin.github.io", base: "/piomio/", languages: siteConfig.languages, paths: ["", "docs/"], lastmod: "2026-11-04" });
    expect(nested).toContain("<loc>https://legostin.github.io/piomio/en/</loc>");
    expect(nested).toContain("<loc>https://legostin.github.io/piomio/ru/docs/</loc>");
    expect(nested).toContain("<loc>https://legostin.github.io/piomio/zh/</loc>");
    expect(robotsTxt({ origin: "https://legostin.github.io", base: "/piomio/" })).toContain("Sitemap: https://legostin.github.io/piomio/sitemap.xml");
    expect(robotsTxt({ origin: "https://legostin.github.io", base: "/piomio/" })).toContain("Disallow: /piomio/demo/");
  });

  it("keeps untranslated docs out of the sitemap and language alternates", () => {
    const sitemap = sitemapXml({ origin: "https://piomio.io", base: "/piomio/", languages,
      docLanguages: ["en", "ru"], paths, lastmod: "2026-11-04" });
    expect(sitemap).toContain("<loc>https://piomio.io/piomio/zh/</loc>");
    expect(sitemap).toContain("<loc>https://piomio.io/piomio/zh/server/</loc>");
    expect(sitemap).not.toContain("/zh/docs/");
    expect(sitemap).toContain("/ru/docs/install/");
    assertPublishedSeo(sitemap, robotsTxt({ origin: "https://piomio.io", base: "/piomio/" }), {
      origin: "https://piomio.io", base: "/piomio/", languages, docLanguages: ["en", "ru"],
      pagePaths: PAGES.map(pagePath), docSlugs,
    });
  });

  it("refuses to emit an empty urlset", () => {
    expect(() => sitemapXml({ origin: "https://piomio.io", base: "/", languages: ["en"], paths: [], lastmod: "2026-11-04" })).toThrow(/no public pages/);
    expect(() => assertPublishedSeo("", "User-agent: *\nAllow: /\nSitemap: https://piomio.io/sitemap.xml\n", { origin: "https://piomio.io", base: "/", languages: ["en"], pagePaths: [""], docSlugs: [] })).toThrow(/empty/);
  });
});

describe("language redirect keeps the query string", () => {
  it("appends location.search so UTM parameters survive the hop to /en/ or /ru/", () => {
    const script = languageRedirectScript("/", ["en", "ru"]);
    expect(script).toContain('location.replace("/" + pick + "/" + location.search + location.hash)');
    expect(script).not.toContain('pick + "/" )');
  });

  it("puts the search back on a server redirect", () => {
    expect(withSearch("/en/", "?utm_source=newsletter&utm_campaign=nov")).toBe("/en/?utm_source=newsletter&utm_campaign=nov");
    expect(withSearch("/piomio/", "")).toBe("/piomio/");
    expect(withSearch("https://piomio.io/en/", "?")).toBe("https://piomio.io/en/");
  });
});

describe("GA4", () => {
  it("injects nothing unless the value is a measurement ID", () => {
    for (const value of ["", "   ", undefined, "UA-123456", "GTM-XXXX", "G-", 'G-ABC"><script>']) expect(analyticsSnippet(value)).toBe("");
    expect(gaMeasurementId(" G-ABC123XYZ ")).toBe("G-ABC123XYZ");
  });

  it("loads gtag.js async and sends named events for Download, TestFlight and GitHub", () => {
    const html = analyticsSnippet("G-ABC123XYZ");
    expect(html).toContain('<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123XYZ"></script>');
    expect(html).toContain(`gtag('config', "G-ABC123XYZ")`);
    expect(html).toContain("a[data-ga]");
    expect(html).toContain("name !== 'download' && name !== 'testflight' && name !== 'github'");
    expect(html).not.toContain("cookie");
    expect(html.match(/G-ABC123XYZ/g)?.length).toBe(2);
  });

  it("uses the piomio.io property unless GA_MEASUREMENT_ID is set empty", () => {
    expect(siteConfig.gaMeasurementId).toBe("G-RCPYYNZ3CQ");
    const workflow = readFileSync(resolve(import.meta.dirname, "../../../.github/workflows/site.yml"), "utf8");
    expect(workflow).toContain("GA_MEASUREMENT_ID: G-RCPYYNZ3CQ");
    expect(measurementIdFrom(undefined, siteConfig.gaMeasurementId)).toBe("G-RCPYYNZ3CQ");
    expect(measurementIdFrom("", siteConfig.gaMeasurementId)).toBe("");
    expect(analyticsSnippet(measurementIdFrom("", siteConfig.gaMeasurementId))).toBe("");
  });

  it("marks those anchors in the page", () => {
    const read = (file: string) => readFileSync(resolve(import.meta.dirname, file), "utf8");
    expect(read("components/Download.tsx")).toContain('data-ga="download"');
    expect(read("components/Download.tsx")).toContain('data-ga="github"');
    expect(read("sections/TopBar.tsx")).toContain('data-ga="github"');
    const sections = read("sections/Sections.tsx");
    expect(sections).toContain('data-ga="testflight"');
    expect(sections).toContain('data-ga="download"');
    expect(sections).toContain('data-ga="github"');
  });
});
