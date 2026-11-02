// The docs themselves (docs/guide, docs/versions/*): every page in every language, with a title and a description,
// the same sections in each language, and links that lead somewhere.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { siteConfig } from "../../site.config";
import { anchors, links, parseDoc, type Doc } from "./markdown";

const ROOT = resolve(import.meta.dirname, "../../../..");
const versions = join(ROOT, "docs/versions");
const lines = [join(ROOT, "docs/guide"), ...(existsSync(versions) ? readdirSync(versions).filter((v) => /^\d+\.\d+$/.test(v)).map((v) => join(versions, v)) : [])];

for (const dir of lines)
  describe(`the docs in ${dir.slice(ROOT.length + 1)}`, () => {
    const nav = JSON.parse(readFileSync(join(dir, "nav.json"), "utf8")) as { groups: Array<{ title: Record<string, string>; pages: string[] }> };
    const slugs = nav.groups.flatMap((g) => g.pages);
    const docs: Record<string, Record<string, Doc>> = {};
    for (const lang of siteConfig.languages) {
      docs[lang] = {};
      for (const slug of slugs) {
        const file = join(dir, lang, `${slug}.md`);
        if (existsSync(file)) docs[lang][slug] = parseDoc(readFileSync(file, "utf8"));
      }
    }

    it("list each page once, starting with the overview, with group titles in every language", () => {
      expect(slugs[0]).toBe("index");
      expect(new Set(slugs).size).toBe(slugs.length);
      for (const g of nav.groups) for (const lang of siteConfig.languages) expect(g.title[lang]?.trim(), `${lang}: ${g.title.en}`).toBeTruthy();
    });

    it("have every page in every language, and no page that isn't listed", () => {
      for (const lang of siteConfig.languages) {
        expect(Object.keys(docs[lang]).sort(), lang).toEqual([...slugs].sort());
        const files = readdirSync(join(dir, lang)).filter((f) => f.endsWith(".md"));
        expect(files.map((f) => f.slice(0, -3)).sort(), lang).toEqual([...slugs].sort());
      }
    });

    it("give each page a title and a description, and no title of its own in the body", () => {
      for (const lang of siteConfig.languages)
        for (const [slug, doc] of Object.entries(docs[lang])) {
          expect(doc.meta.title, `${lang}/${slug}`).toBeTruthy();
          expect(doc.meta.description, `${lang}/${slug}`).toBeTruthy();
          const source = readFileSync(join(dir, lang, `${slug}.md`), "utf8");
          expect(source.match(/^# /m), `${lang}/${slug}: a "# " heading`).toBeNull();
        }
    });

    it("have the same sections in every language", () => {
      const sections = (doc: Doc) => doc.blocks.filter((b) => b.t === "h" && b.level === 2).length;
      for (const slug of slugs)
        for (const lang of siteConfig.languages)
          if (docs[lang][slug] && docs.en[slug]) expect(sections(docs[lang][slug]), `${lang}/${slug}`).toBe(sections(docs.en[slug]));
    });

    it("link only to pages and sections that exist", () => {
      for (const lang of siteConfig.languages)
        for (const [slug, doc] of Object.entries(docs[lang]))
          for (const href of links(doc.blocks)) {
            const where = `${lang}/${slug}.md → ${href}`;
            if (/^(https?:|mailto:)/.test(href)) continue;
            const m = /^(?:([a-z0-9-]+)\.md)?(?:#(.+))?$/.exec(href);
            expect(m, `${where}: other pages are linked as page.md or page.md#section`).not.toBeNull();
            const target = m![1] ?? slug;
            expect(slugs, where).toContain(target);
            if (m![2] && docs[lang][target]) expect(anchors(docs[lang][target].blocks), where).toContain(decodeURIComponent(m![2]));
          }
    });
  });

describe("the site's links into the docs", () => {
  it("lead to a page and section that exist", async () => {
    for (const lang of siteConfig.languages) {
      const catalog = (await import(`../locales/${lang}.json`)).default as Record<string, string>;
      for (const [key, value] of Object.entries(catalog)) {
        const m = /^docs\/([a-z0-9-]+)\/(?:#(.+))?$/.exec(value);
        if (!m) continue;
        const file = join(ROOT, "docs/guide", lang, `${m[1]}.md`);
        expect(existsSync(file), `${lang} ${key}`).toBe(true);
        if (m[2]) expect(anchors(parseDoc(readFileSync(file, "utf8")).blocks), `${lang} ${key}`).toContain(m[2]);
      }
    }
  });
});
