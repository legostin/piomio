// The docs for the site (docs/guide/README.md): the newest release line from docs/guide, older lines from
// docs/versions/<major.minor> (frozen through a PR before a new release line), each with its sidebar and every page per language, and
// what one prerendered docs page carries (src/docs/page.ts).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { frontMatter } from "../src/docs/markdown.ts";

export const ROOT = resolve(import.meta.dirname, "../../..");
export const GUIDE = join(ROOT, "docs/guide");
const VERSIONS = join(ROOT, "docs/versions");

const lineOf = (version) => version.split(".").slice(0, 2).join(".");
const byNewest = (a, b) => {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  return y[0] - x[0] || y[1] - x[1];
};

/**
 * One line's sidebar and pages from its folder. A page listed in nav.json but missing in a language that has its own
 * folder stops the build. A site language with no folder (Simplified Chinese, for now) is published from the English
 * pages: same sections, English anchors, and the edit link points at the English file.
 */
export function readLine(dir, languages) {
  const nav = JSON.parse(readFileSync(join(dir, "nav.json"), "utf8"));
  const pages = {};
  /** Which folder each language's Markdown was read from. */
  const sourceLang = {};
  for (const lang of languages) {
    const from = existsSync(join(dir, lang)) ? lang : "en";
    sourceLang[lang] = from;
    pages[lang] = {};
    for (const group of nav.groups)
      for (const slug of group.pages) {
        const file = join(dir, from, `${slug}.md`);
        if (!existsSync(file)) throw new Error(`docs: ${file} is missing (nav.json lists "${slug}")`);
        pages[lang][slug] = readFileSync(file, "utf8");
      }
  }
  return { nav, pages, sourceLang };
}

/**
 * Every line, newest first. GitHub's latest published release defines the current line. The source manifest is
 * only an offline/development fallback: releases no longer bump it on main.
 */
export function loadDocs({ languages, release }) {
  const version = release || JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const id = lineOf(version);
  const lines = [{ id, release: version, current: true, ...readLine(GUIDE, languages) }];
  if (existsSync(VERSIONS))
    for (const old of readdirSync(VERSIONS).filter((d) => /^\d+\.\d+$/.test(d) && d !== id).sort(byNewest)) {
      const dir = join(VERSIONS, old);
      const { release: last } = JSON.parse(readFileSync(join(dir, "release.json"), "utf8"));
      lines.push({ id: old, release: last, current: false, ...readLine(dir, languages) });
    }
  return lines;
}

const tagged = new Map();
/** Whether the release's tag holds the docs (the tag is fetched when the checkout doesn't have it, as on CI). */
function tagHasDocs(release) {
  if (tagged.has(release)) return tagged.get(release);
  const git = (...args) => execFileSync("git", ["-C", ROOT, ...args], { stdio: "ignore", timeout: 20_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } });
  let has = false;
  try {
    try {
      git("rev-parse", "-q", "--verify", `refs/tags/v${release}`);
    } catch {
      git("fetch", "-q", "--depth=1", "origin", "tag", `v${release}`);
    }
    git("cat-file", "-e", `v${release}:docs/guide/nav.json`);
    has = true;
  } catch {
    /* no tag, no network or no docs in it */
  }
  tagged.set(release, has);
  return has;
}

/** What a docs page carries into the page (src/docs/page.ts DocPageData). */
export function pageData({ lines, line, lang, slug, prefix, repo }) {
  const nav = line.nav.groups.map((group) => ({
    title: group.title[lang] ?? group.title.en,
    pages: group.pages.map((s) => {
      const { meta } = frontMatter(line.pages[lang][s]);
      return { slug: s, title: meta.nav || meta.title || s };
    }),
  }));
  return {
    lang,
    slug,
    sourceLang: line.sourceLang?.[lang] ?? lang,
    translatedLangs: Object.keys(line.pages).filter((l) => (line.sourceLang?.[l] ?? l) === l),
    source: line.pages[lang][slug],
    version: { id: line.id, release: line.release, current: line.current },
    prefix,
    versions: lines.map((l) => ({ id: l.id, release: l.release, current: l.current })),
    nav,
    ...(tagHasDocs(line.release) ? { sourceUrl: `https://github.com/${repo}/blob/v${line.release}/docs/guide/${line.sourceLang?.[lang] ?? lang}/${slug}.md` } : {}),
    ...(line.current ? { editUrl: `https://github.com/${repo}/edit/main/docs/guide/${line.sourceLang?.[lang] ?? lang}/${slug}.md` } : {}),
  };
}
