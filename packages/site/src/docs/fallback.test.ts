import { describe, expect, it, vi } from "vitest";
import { renderDoc } from "../entry-server";
import type { DocPageData } from "./page";

vi.mock("../data", () => ({ data: {
  origin: "https://piomio.io", base: "/piomio/", repo: "legostin/piomio",
  release: { page: "https://github.com/legostin/piomio/releases/latest" }, testflightUrl: "",
} }));

const version = { id: "0.2", release: "0.2.36", current: true };
const doc: DocPageData = {
  lang: "zh", sourceLang: "en", translatedLangs: ["en", "ru"], slug: "install", prefix: "",
  source: "---\ntitle: Install Piomio\ndescription: Install on your computer\n---\n\nEnglish instructions.",
  version, versions: [version], nav: [{ title: "Get started", pages: [{ slug: "install", title: "Install" }] }],
};

describe("docs without a translation", () => {
  it("tells the Chinese reader and marks the English article for assistive technology", () => {
    const { html } = renderDoc(doc);
    expect(html).toContain("这篇文档尚未翻译成中文");
    expect(html).toMatch(/<article lang="en"/);
    expect(html).toContain("English instructions.");
  });

  it("points at the English original, including versioned and archived pages", () => {
    for (const current of [true, false]) {
      const { head } = renderDoc({ ...doc, prefix: "0.2/", version: { ...version, current } });
      expect(head).toContain(`rel="canonical" href="https://piomio.io/piomio/en/docs/${current ? "" : "0.2/"}install/"`);
      expect(head).not.toContain('hreflang="zh"');
      expect(head).toContain('hreflang="ru"');
    }
  });

  it("keeps a translated article in its own language without the fallback notice", () => {
    const { html, head } = renderDoc({ ...doc, lang: "ru", sourceLang: "ru" });
    expect(html).toContain('<article lang="ru"');
    expect(html).not.toContain("Эта статья пока не переведена");
    expect(head).toContain('rel="canonical" href="https://piomio.io/piomio/ru/docs/install/"');
  });

  it("carries the actual source language and edit links from the build into hydration data", async () => {
    // @ts-expect-error Build scripts run directly as ESM and have no declaration files.
    const { loadDocs, pageData } = await import("../../scripts/docs.mjs");
    const lines = loadDocs({ languages: ["en", "ru", "zh"] });
    const data = pageData({ lines, line: lines[0], lang: "zh", slug: "install", prefix: "", repo: "legostin/piomio" });
    expect(data.sourceLang).toBe("en");
    expect(data.translatedLangs).toEqual(["en", "ru"]);
    expect(data.source).toBe(lines[0].pages.en.install);
    expect(data.editUrl).toBe("https://github.com/legostin/piomio/edit/main/docs/guide/en/install.md");
  });
});
