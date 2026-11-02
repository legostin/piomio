# Docs on the site, by version

The person asked for detailed documentation on piomio.io, by version, starting with the current release and updated
with every release.

## Decisions

- **Source.** Markdown in the repository, one file per page and language: `docs/guide/{en,ru}/<page>.md`, the sidebar in
  `docs/guide/nav.json`, the writing rules in `docs/guide/README.md`. People and agents edit it like code; GitHub shows it
  as it is.
- **Versions by release line.** A patch release comes with every push that ships (0.2.0 → 0.2.13 in three days), so a
  copy per patch would make dozens of near-identical versions a week. The docs version is the line (`0.2`): minor and
  major releases are made by hand for bigger changes. Each page says the exact release it describes (the newest
  published one of the line, asked from GitHub at build time) and links to itself at that release's tag when the tag
  holds the docs, so every exact snapshot stays reachable through git without copies.
- **Addresses.** `/<lang>/docs/<page>/` is always the newest line (canonical, in the sitemap, linked from the README,
  llms.txt and the app); `/<lang>/docs/<line>/<page>/` is a given line, the newest one included, for links that should
  keep pointing at it. Older lines are `noindex` and left out of the sitemap.
- **Release flow.** A change that ships updates the docs in the same commit (CLAUDE.md), so main's docs are the newest
  release's. `site.yml` rebuilds on docs changes and after every successful `release` run (`workflow_run`), so the
  version the pages name and the download links follow each release. A minor or major release (`release-on-push.yml`,
  by hand) copies `docs/guide` into `docs/versions/<old line>/` with `release.json` in its version commit. Nothing here
  touches `release.yml` or the lockfile, so the change itself releases nothing.
- **Rendering.** A small Markdown parser of our own (`packages/site/src/docs/markdown.ts`, the subset in the README),
  not `react-markdown`: declaring a dependency changes `package-lock.json`, which releases. The prerender embeds each
  page's source as JSON (`#doc-data`); the browser parses the same source and hydrates without a mismatch. Each page's
  Markdown is also published next to it (`/<lang>/docs/<page>.md`) for agents.
- **Look.** The server guide's look: a sidebar with the version switcher and the pages (a menu bar on a phone), the
  page, "On this page" on wide screens, previous and next.

## Pages

Getting started: Overview, Install on a Mac or PC, On a Linux server (reference; the walkthrough stays at
`/<lang>/server/`), In Docker, First run. Working with the team: The chat, Agents and the team, Tasks, schedules and the
Inbox, Channels, Pages, The browser and teach mode. Brains and computers: Brains and sign-in, Machines and other
computers, The iPhone app, Telegram, Access from anywhere, Updates. Safety: Approvals and auto mode, Security model.
Reference: Plugins and integrations, Settings and environment variables, Troubleshooting.

## Checks

`npm test` (`src/docs/markdown.test.ts`: the parser; `src/docs/docs.test.ts`: every page in every language with a title,
a description, the same sections, links that resolve), `npm run check:site` (every page opens and hydrates without
errors, language links and the sidebar stay on the page, the Markdown copy is served).
