# Piomio website: a live demo of the real app, chapter by chapter

Approved by the person on 2026-10-31. A landing site for Piomio on GitHub Pages (a custom domain comes later). Its main
widget is the app itself: the real web UI (`packages/web`) running against a demo hub inside the visitor's browser, with
scripted scenarios a director plays on both sides. Below the first screen, the page tells a day of a person and their
team of agents, one chapter per feature, while the same app window plays each chapter. Two languages at launch (English,
Russian), each with its own stories, not translations.

Choices made in the conversation:
- The demo uses the app's own components in a demo mode, embedded in the page; nothing reaches a real hub or a database.
- The visitor cannot type: the script types the person's messages into the composer, sends them and waits for the
  answers. Buttons on cards are pressed by the script after a short pause; a visitor who presses first wins.
- One live window: scrollytelling. The app window from the first screen sticks beside the chapters; entering a chapter
  plays it. On a phone the window sticks on top and the chapter text runs under it.
- Style "Paper" (option A of the mockups): the app's own Amber look, warm paper and ink, amber as the one light, Onest
  and Unbounded. Dark mode follows the system with the app's dark tokens.
- Languages: `/en/` and `/ru/`; each has its own person, city, currency, shop and letters.
- An "iPhone app — coming soon" section with a public TestFlight link (a site setting; until it is set the button says
  "soon").
- Killer features to show: the browser and teach mode, pages on request, channels with collections.

## The story

The person: **Alex** in Lisbon (EUR) on the English site, **Саша** in Almaty (KZT) on the Russian one. All companies,
addresses and letters are made up (`example.com`, `*.example`).

The team (candy avatars as in the app):
| id | EN | RU | avatar | role |
|---|---|---|---|---|
| `pio` | Pio | Пио | teal circle | the assistant and front desk: answers quick things, hands the rest to the team |
| `ada` | Ada | Ада | pink square | mail and calendar (Gmail and Google Calendar through integrations) |
| `leo` | Leo | Лев | violet hexagon | research, comparisons, channels, the agents' browser |
| `bit` | Bit | Бит | blue diamond | developer: Claude Code on the person's MacBook |

Security is not an agent: it is the system (vault, approvals, sandbox, egress filter, audit) and shows in the cards.

Chapters (each one a section of the page and a script of the demo):
1. **morning**: Pio's morning digest arrives by itself: three meetings, two important letters, the weather, a reminder.
2. **mail**: "Go through my mail" → Ada reads 47 letters with live steps ("via Gmail"): 3 important, 2 draft replies, an
   invoice turned into a task, newsletters archived.
3. **send**: the draft reply → an approval card "Send email to anna@…" → one tap → sent; "always allow this recipient".
4. **security**: a phishing letter asks to forward all invoices to a stranger. The session has read outside content, so
   the new recipient needs approval, with a warning; the person denies it. A key the person needs to give goes through
   the secret card in the chat: the model only sees `vault://…`.
5. **services**: "Connect Notion" → the integration card → signed in → Ada books a meeting in the calendar (approval).
6. **team**: "Compare three laptops, find tickets for Friday, remind me to call mum at 7" → Pio splits it into tasks:
   Leo compares with a live step line, a reminder is set, results come back as replies to the request.
7. **machines**: Bit fixes a failing test on the MacBook through the Claude Code subscription; the subscription hits its
   limit and Bit moves to Codex; the machines block shows who works where.
8. **browser** (the killer feature): "Watch how I order water" → the live view opens with the teach bar; the person's
   cursor walks a made-up water shop, steps appear in words, speech lands between them, a Highlight frames "Total";
   at Done, Leo retells the steps, asks with quick replies whether to press "Place order" alone up to an amount, the
   "Save skill" card with the pre-approved click → one tap. Then "Order water" → Leo does it alone while the person
   watches; "Every Friday" → a schedule card.
9. **pages**: "Make a page for a Saturday walk: route, places, weather" → a page card → it opens in the in-app viewer:
   a real pages-kit page with the route map, places, weather and a gallery.
10. **channels**: "Every morning collect news about AI and electric cars" → a short setup chat → the channel card with
   cadence chips → the channel opens with Leo's posts: the gist, numbers and big pictures.

The section text tells what the window shows and what is underneath (the audit log, the egress filter and the sandbox
are described on the page, not acted in the window).

## Architecture

### The demo app (`packages/web`, demo entry)

A second Vite entry, `packages/web/demo.html` with code in `packages/web/src/demo/`, built with `vite build --mode demo`
into `packages/web/dist-demo` with relative paths (`base: "./"`). The app's own code stays as it is; the demo entry
wraps `<App />` in a wouter `<Router>` with a memory location (the iframe's address never changes and the director can
navigate). The site embeds it in an `<iframe>`, which keeps the app's CSS, globals and stores apart from the page.

- **Shims** (installed before the app's modules run): `window.fetch` sends `/api/*` to the demo hub in the same page;
  `window.WebSocket` for `/api/ws` is a fake socket the hub pushes `UiEvent`s into and reads `plugin.message`s from.
  Everything else goes to the network as usual (only the site's own files).
- **Service worker** (`demo-sw.js`, scope: the demo folder): serves what the app loads without `fetch`, from the demo's
  own files: `/api/files?path=…` (pictures in messages and posts), `/api/media?url=…`, `/api/map/tiles/…`,
  `/plugins-ui/…`. It holds no state: a map from request to a bundled file, 404 otherwise. The page waits for it to
  control the frame before the app starts. Without service workers (Firefox private windows) the frame shows a still
  picture and a note.
- **Demo hub** (`src/demo/hub/`): the state of a hub (agents, team, conversations, messages, tasks, feeds and posts,
  pages, machines, triggers, catalog, approvals, settings) built from the locale's seed, and a route table answering the
  requests the UI makes, typed with `@piomio/shared`. A request it does not know answers 404 and is reported
  (`console.warn("[demo] unknown route …")`), which the checks treat as a failure. Actions the visitor can still reach
  (opening panels, settings, the catalog) answer from the state; changes outside the script answer a gentle error
  ("not in the demo").
- **Director** (`src/demo/director/`): plays a chapter. Person side: open a dialog, type a message letter by letter into
  the real composer, send it with the real button, move a visible cursor and click real buttons, draw a Highlight,
  wait. Hub side: start an assistant message, stream text in deltas, show tool calls and live steps, add parts (cards,
  tasks, news, pages, images), raise approvals and wait for their answer, update tasks, feeds and machines, push
  browser frames. Both sides are one linear script per chapter (`src/demo/scenarios/<chapter>.ts`) with `await`s; an
  abort signal stops it when the chapter changes. A speed factor makes checks fast.
- **Content** per locale (`src/demo/content/{en,ru}.ts`): names, letters, the shop, the walk, posts, every line. The
  scripts read only from it; a test checks both locales have the same shape.
- **Composer**: the visitor cannot type (a quiet "the demo writes for you" over it); the director writes into it
  through the element's value setter and input events, so the app's own composer logic runs.
- **Browser chapter**: the made-up water shop is HTML in `src/demo/assets/shop/`, rendered into JPEG frames per locale
  at build time (Playwright). The hub sends them as the browser plugin's `frame` events; the person's cursor is drawn
  by the director over the live view.
- **Pages chapter**: the walk page is TSX on the pages kit (`packages/web/demo-pages/walk/`), compiled at build time
  with the hub's own page compiler and HTML template (`scripts/build-demo-pages.mjs`) into static files next to the
  demo, with its pictures beside it. The route is drawn stop by stop, so no map tiles are needed.
- **Control from the site**: `postMessage` between the page and the frame: `{play: chapter}`, `{pause}`, `{resume}`,
  `{lang}`; the frame answers `{ready}`, `{chapter, step, of}`, `{ended}`. Changing chapter reloads the frame with
  `?chapter=…&lang=…` under a short fade, so every chapter starts from a clean world.

### The site (`packages/site`)

A new workspace on the repo's own stack: Vite, React and Tailwind 4, prerendered to static HTML per language by a
script (React's server renderer), then hydrated. No new framework.

- `/en/` and `/ru/` prerendered, `hreflang` alternates, a canonical link, Open Graph images per language, `sitemap.xml`,
  `robots.txt`. `/` sends the browser to its language (English by default) with a plain link for no-script visitors.
- Texts: `src/locales/{en,ru}.json`, one key set (a test checks parity), the app's `{name}` placeholders.
- Settings in `site.config.ts`: the repository, the TestFlight link (empty: "soon"), the GA4 measurement ID (empty: no
  analytics script), the download links and the star count filled at build time from the latest GitHub release (a
  build without network keeps the release page link).
- Fonts are the app's bundled Onest and Unbounded. The only outside request is gtag.js, and only when a GA4 measurement
  ID is set.
- The base path comes from `SITE_BASE` (`/piomio/` on `legostin.github.io`, `/` with a domain). A `CNAME` file is added
  when the domain is chosen.

Page, top to bottom:
1. **Top bar**: owl + Piomio; Demo · Features · Security · iPhone; RU/EN switch; GitHub ★; Download (picks macOS or
   Windows by the visitor's system).
2. **First screen**: the headline with an amber marker, a lead, Download and the other platforms; on the right the app
   window plays "morning" (a still picture until the demo is ready). Chapter chips under the window.
3. **A day with the team**: the ten chapters. Desktop: the window sticks on the right, the chapter texts scroll on the
   left (time, title, two or three lines, what happens underneath); the chapter in view plays. Phone: the window
   sticks on top (about 55% of the screen), the text scrolls under it. Pause, replay and the chips work everywhere.
4. **How it works**: your subscriptions are the brains (Claude Code, Codex, API fallbacks); your hardware (Mac,
   Windows, Docker, other machines as nodes); your data stays home.
5. **Security**: vault, approvals, sandbox, egress filter, hash-chained audit, as a small diagram with words.
6. **Integrations**: the catalog's services as a wall of logos (the logos the plugins already ship).
7. **iPhone — coming soon**: real screenshots of the iOS app in both languages and the TestFlight button.
8. **Install**: macOS, Windows, Docker tabs with the commands from the README.
9. **Footer**: GitHub, license, README.

Motion: chapters fade and slide in, the marker draws in; `prefers-reduced-motion` turns that off (the demo still plays).

### Build and publish

- `npm run build:site` (root): UI plugins → the web demo (`dist-demo`, shop frames, the walk page) → the site → prerender
  → `packages/site/dist` with the demo at `dist/demo/`.
- `.github/workflows/site.yml`: on pushes to `main` that touch the site, the web UI, UI plugins, the pages kit or
  shared types, and by hand: build, run the checks, publish with `actions/deploy-pages`.
- `npm run check:site`: Playwright serves `dist`, opens both languages, plays every chapter at high speed and fails on a
  console error, an unknown demo route, a director step whose element never appeared, or a chapter that did not end.
  It runs in CI before publishing, so an app change that breaks the demo does not ship silently.
- Unit tests (vitest): site catalog parity, scenario content parity, the hub's routes for the requests the UI makes at
  start-up.

### Assets

- News pictures and other art: drawn for the site (SVG in the Amber palette), no stock photos.
- The walk page's pictures and the made-up water shop are drawn for the demo too; the shop's frames are rendered once
  by `packages/web/scripts/render-shop.mjs` and kept in git.
- iOS screenshots (`packages/site/src/assets/iphone/<lang>-<n>-<what>.jpg`): taken in the simulator from a throwaway
  copy of the iOS app that pairs and opens a chat by itself, against throwaway hubs seeded with the demo's team and
  stories (deleted afterwards). Without them the section draws a phone in CSS.

## Order of work

1. Demo hub, shims, service worker, director, the demo build; chapters mail + send end to end.
2. The site skeleton (both languages, first screen, scrollytelling with the frame), the build and the Pages workflow.
3. The other chapters, the browser chapter's frames, the walk page.
4. The checks, the iPhone section, polish, Open Graph images.

Not now: more languages (needs the app translated too), a sign-up form, analytics, the security console in the demo.
