// What a docs page carries from the prerender to the browser (scripts/prerender.mjs writes it into the page as JSON, so
// the browser renders the same tree it hydrates), and its addresses.

import type { Lang } from "../../site.config";

export interface DocVersion {
  /** The release line: "0.2". */
  id: string;
  /** The newest release of the line the docs describe: "0.2.13". */
  release: string;
  /** The newest line: its pages are also the unversioned /<lang>/docs/…. */
  current: boolean;
}

export interface DocPageData {
  lang: Lang;
  slug: string;
  /** Language of the Markdown, which may fall back to English. */
  sourceLang?: Lang;
  /** Languages with their own articles in this release line. */
  translatedLangs?: Lang[];
  /** The page's Markdown. */
  source: string;
  version: DocVersion;
  /** Which copy this is: "" for /<lang>/docs/… (the newest line), "0.2/" for /<lang>/docs/0.2/…. */
  prefix: string;
  /** Every line, newest first. */
  versions: DocVersion[];
  /** The sidebar in this language: groups of pages with their titles. */
  nav: Array<{ title: string; pages: Array<{ slug: string; title: string }> }>;
  /** The page's file at the release's tag on GitHub, when that tag has the docs. */
  sourceUrl?: string;
  /** Where to edit it (the newest line only). */
  editUrl?: string;
}

/** A docs page's address under the site's base: /<lang>/docs/[<line>/]<page>/ (the overview is the folder itself). */
export function docHref(base: string, lang: string, prefix: string, slug: string): string {
  return `${base}${lang}/docs/${prefix}${slug === "index" ? "" : `${slug}/`}`;
}

/** A link inside a page: another page as `brains.md#anchor` becomes its address in the same copy of the docs. */
export function resolveLink(href: string, base: string, lang: string, prefix: string): string {
  const m = /^(?:\.\/)?([a-z0-9-]+)\.md(#.*)?$/.exec(href);
  return m ? `${docHref(base, lang, prefix, m[1])}${m[2] ?? ""}` : href;
}
