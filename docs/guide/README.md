# Piomio docs

The documentation on the site, [piomio.io/en/docs](https://piomio.io/en/docs/) and
[piomio.io/ru/docs](https://piomio.io/ru/docs/): one Markdown file per page and language. `packages/site` turns them
into pages (`scripts/docs.mjs`, `src/docs/`) and also publishes each file as it is, at `/<lang>/docs/<page>.md`, for
agents.

## Versions

- `docs/guide/` describes the newest release line (today 0.2). A change that ships updates the pages it touches here, in
  both languages, in the same commit. Each page on the site says which release it describes: the newest one when the
  site was built.
- `docs/versions/<major.minor>/` holds an older line, frozen, with the last release it described in `release.json`. A
  minor or major release copies `docs/guide` there for the line before it, in its version PR
  (`.github/workflows/release-on-push.yml`); nobody edits it by hand except to fix a mistake.
- On the site `/<lang>/docs/<page>/` is always the newest line, `/<lang>/docs/<major.minor>/<page>/` a given line
  (the newest one too, for links that should keep pointing at it).

## Files

- `nav.json`: the groups of the sidebar (titles in every language) and the pages in them, in order. A page that is not
  listed there is not published.
- `<lang>/<page>.md`: a page. Every language that has a folder here has every page (`npm test` checks it), with the same sections. A site language with no folder is published from the English pages (Simplified Chinese, `/zh/docs/`, for now).

A page starts with its title and a sentence about it, for search engines and link previews:

```markdown
---
title: Install on a Mac or PC
nav: Install on a Mac or PC
description: The desktop app for macOS and Windows: download, first start, where the data lives, uninstall.
---
```

`nav` is an optional shorter title for the sidebar.

## Markdown

The pages use a small part of Markdown (`packages/site/src/docs/markdown.ts`); anything else shows up as text.

- `## Section` and `### Subsection` (the page's title is the `#` heading; don't write one). Sections and subsections
  make the page's "On this page" list. A heading's anchor is its text in lower case, without punctuation, with spaces as `-`
  (as on GitHub), so `## Sign in from the chat` is `#sign-in-from-the-chat`, `## Why not the server's IP?` is
  `#why-not-the-servers-ip`, and in Russian `## Вход из чата` is `#вход-из-чата`.
- Paragraphs, separated by an empty line.
- `-` lists and `1.` lists; a nested list or a code block inside an item is indented to the item's text (2 spaces after
  `-`, 3 after `1.`).
- Code blocks in three backticks with a language (`bash`, `text`, `yaml`, `json`, `ini`). They get a Copy button.
- Tables with a header row (`| a | b |`, then `|---|---|`). A `|` inside a cell is written `\|`.
- `> ` quotes, shown as a note.
- Inline: `` `code` ``, `**bold**` (the app's buttons and labels, exactly as the app shows them in that language),
  `*italic*`, `[a link](url)`.
- Links to another page: `[Brains](brains.md)`, with a section: `[Sign in](brains.md#sign-in-from-the-chat)` (the
  anchor of the page in the same language). They work on GitHub and on the site. Links elsewhere are full addresses.
- No HTML, no images yet.

## How to write

- For the person who runs Piomio, not for its developers. What they see, say and press; what happens; where things are.
  Developer guides stay in the repository (`docs/plugins.md`, `integrations/README.md`, `CLAUDE.md`) and are linked.
- Chat first: say how to do it in the chat with the assistant ("connect Telegram"), then where the same is in
  **Settings** or on a page, if it is there too.
- Only what the code does today. Read the code before writing a sentence about it; leave out what you could not confirm.
- Short sentences, plain words, the person as "you". The Russian page is written for a Russian reader, not translated
  word by word, and uses the app's Russian labels.
- The brains are the official Claude Code, Codex and Kimi Code CLIs, signed in by the person with their own plan
  (never "a Claude Code subscription"); Piomio never takes or stores their tokens.
