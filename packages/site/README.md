# Piomio website

The landing page per language (`/en/`, `/ru/`, `/zh/`) with the live demo: the real web UI (`packages/web`, demo entry
`demo.html`, code in `packages/web/src/demo/`) running against a demo hub in the visitor's browser and playing one
chapter of the story per section, the server guide (`/en/server/`, `/ru/server/`, `/zh/server/`) and the docs (`/en/docs/`,
`/ru/docs/`, `/zh/docs/`). Vite + React + Tailwind, prerendered with React's server renderer and hydrated.
Simplified Chinese (`zh`, Open Graph `zh_CN`) translates the landing page and the server guide. The long guide under
`docs/guide/` has no `zh/` folder, so `/zh/docs/` is the English pages. The live demo still shows the English app.
Design: [docs/superpowers/specs/2026-10-31-website-design.md](../../docs/superpowers/specs/2026-10-31-website-design.md).

## Build, look, check

```bash
npm run build:ui-plugins   # once: the UI plugins the demo loads
npm run build:site         # → packages/site/dist (the demo at dist/demo/)
node packages/site/scripts/serve.mjs 5198   # http://127.0.0.1:5198/
npm run check:site         # the pages in every language, every chapter in English and Russian, at ×8
```

`build:site` builds the demo too; `node packages/site/scripts/build.mjs --skip-demo` reuses `packages/web/dist-demo`.
The checks fail on a console error, a request the demo hub does not know (`[demo] unknown route …`), or a chapter that
does not reach its end; `--only mail,send`, `--lang ru` and `--speed 4` narrow them down.

## Where things are

- `src/sections/`: the page. `Stage.tsx` holds the first screen and the story with the one live window
  (`src/demo/DemoWindow.tsx`), which loads `demo/demo.html?lang=…&chapter=…&autoplay=1` and talks to it by
  `postMessage` (`src/demo/protocol.ts`, a copy of `packages/web/src/demo/protocol.ts`; a test keeps the chapter lists
  equal).
- `src/sections/ServerGuide.tsx`: the server guide at `/<lang>/server/` (`src/pages.ts` lists the pages; `prerender.mjs`
  writes each one per language and marks it on `<html data-page>`). The README's server section says the
  same in each language: change them together.
- The docs: Markdown in `docs/guide/{en,ru}/` at the repository's root (how to write it and how versions work:
  [docs/guide/README.md](../../docs/guide/README.md)), older release lines in `docs/versions/`. `scripts/docs.mjs` reads
  them; a site language with no folder is filled from English. `prerender.mjs` writes each page of each line in each
  language with what it was made from (`#doc-data`), so `src/docs/` (the Markdown parser `markdown.ts`, the page
  `DocsPage.tsx`) renders the same in the browser; each page's Markdown is published next to it (`/en/docs/install.md`)
  and listed in llms.txt. `npm test` checks the pages (`src/docs/docs.test.ts`), `npm run check:site` opens every one.
- `src/locales/{en,ru,zh}.json`: every word of the pages. Same keys in each (`src/locales/locales.test.ts`).
- `site.config.ts`: the repository, the TestFlight link, the site's address, the GA4 measurement ID.
- `scripts/build.mjs`: release links and the star count from GitHub (at build time; no network → the releases page),
  the demo, the page, prerendering (`prerender.mjs`), Open Graph pictures (`og.mjs`, Playwright), sitemap, robots, and the GA4 snippet when a measurement ID is set.

## Common changes

**The TestFlight link.** Put the public link (`https://testflight.apple.com/join/…`) into `testflightUrl` in
`site.config.ts`. While it is empty the badge says “Soon” and the button “Soon in TestFlight” and does nothing; with
the link the badge says “Beta”.

**A domain.** On GitHub Pages the site lives at `https://legostin.github.io/piomio/`. To connect a domain:

1. Point the domain at GitHub Pages (a `CNAME` record to `legostin.github.io` for a subdomain, or GitHub's `A` records
   for an apex domain) and add it under **Settings → Pages → Custom domain**.
2. Set the repository variables `SITE_BASE=/`, `SITE_ORIGIN=https://<domain>` and `SITE_CNAME=<domain>` (Settings →
   Secrets and variables → Actions → Variables), and set `siteUrl` in `site.config.ts` to the same address.
3. Run the **site** workflow (or push to `main`): the build writes `CNAME` and prerenders with the new base.

**Analytics (GA4).** The build injects gtag.js only when the measurement ID is a `G-…` value. Nothing is injected when it is empty or invalid, and there is no cookie banner. Production uses `G-RCPYYNZ3CQ` (the piomio.io property). Change it in both places, and keep them the same:

- `gaMeasurementId` in `site.config.ts` — what `npm run build:site` uses when `GA_MEASUREMENT_ID` is not set;
- `GA_MEASUREMENT_ID` in `.github/workflows/site.yml` — what the GitHub Pages build sets. This value wins. Set it to an empty string to publish with analytics off.

The script is async, on every language page (the landing page, the server guide, the docs). `/` only redirects, and does not load the tag, so a visit is counted once. That redirect keeps the query string, including UTM parameters. Download, TestFlight and GitHub links are normal outbound anchors with `data-ga="download"`, `data-ga="testflight"` or `data-ga="github"`; the snippet sends a gtag event with that name. GA4 enhanced measurement also records the outbound click.

**A language.** The short code goes in `siteConfig.languages` and in `CATALOGS` (`src/i18n.ts`), with
`src/locales/<lang>.json` (every key of `en.json`), a name in the language chooser (`scripts/prerender.mjs`) and Open
Graph text in `scripts/og.mjs`. `html lang`, the path and `hreflang` use that code; `og:locale` is the regional tag
(`zh` → `zh_CN`, in `src/entry-server.tsx`). The root redirect matches the first two letters of `navigator.language`,
so `zh-CN` lands on `/zh/`.

Docs need `docs/guide/<lang>/` (and a title in `nav.json`) or they are published from English. A fully translated demo
needs the app translated first (the window shows the real UI: `packages/core` and `packages/web` catalogs, the plugins'
`locales/`), then `packages/web/src/demo/content/<lang>.ts` (same shape as `en.ts`) and its entry in `content/index.ts`.
Simplified Chinese currently has the site catalog only.

`npm test` checks that the catalogs and the demo's content match English.
