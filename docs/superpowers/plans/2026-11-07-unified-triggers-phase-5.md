# Unified Triggers, Phase 5: The Triggers Page in the App, Hub Settings, the Plugin Removed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Triggers are a part of the hub, not a plugin: the web app has its own Triggers section with each trigger's pipeline and journal, the two settings are hub settings, and `plugins/triggers` is gone. Old addresses keep working.

**Architecture:** `packages/web` gets a core section `triggers` (where other Settings sections live, following how `Machines.tsx` or `Skills.tsx` is a section opened by `OpenSection`). It is built from what the plugin's `ui/src/index.tsx` does today: list, on/off, run now, check, history, delete, and "Change in the chat" (chat-first: create and edit open the agent's chat with a short request; the old create/edit form stays as the second way). Each trigger's page adds its pipeline (sources, filter, script with hosts, quick check) and the journal: each run opens to its stages. Core serves `/api/triggers/*`; `/api/plugins/triggers/http/*` stays an alias. The engine stops depending on the plugin record: it runs whenever the hub leads. The two plugin settings move to `packages/core/src/settings.ts` (`triggersAllowPrivateUrls`, `triggersWatchTimeoutSec`), carried over once from the plugin row's saved settings.

## Global Constraints

- Chat first (CLAUDE.md "Interface (law)"): "New trigger" and "Change" open the right agent's chat with a short request in the person's words; a form may stay as the second way, never the only one. Full minimalism: the list shows name, when, last outcome; details on tap.
- Every string through the web catalogs `packages/web/src/i18n/{en,ru}.ts` (parity test `packages/web/src/i18n/i18n.test.ts`).
- Old addresses keep working: `/api/plugins/triggers/http/*` (iOS `HubSession.swift`, `packages/web/src/pages/Tasks.tsx`), `/hooks/triggers/<id>`. The demo hub (`packages/web/src/demo/hub/routes.ts`) keeps answering what the page asks.
- Stored data stays in `plugin_kv` under `triggers` (no move). The plugin's `plugins` row is left alone (harmless) except that its saved settings are read once for the carry-over.
- The engine no longer needs the Triggers card: `CoreTriggers.wanted()` is "the hub leads and `PIOMIO_PLUGINS` is not `none`". The `trigger_*` tools are always there.
- Docs `docs/guide/{en,ru}/tasks.md`, `settings.md` (the two settings; they are hub settings in Settings, not env vars), `plugins.md` (Triggers no longer a plugin) in the same PR.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

### Task 1: Core API and settings

Files: `packages/core/src/server/api.ts` (`/api/triggers/*` → `hub.triggers.http`), `packages/core/src/server/plugin-http.ts` (alias kept), `packages/core/src/settings.ts` (+ the two settings with defaults false / 30, validation 1…120), `packages/core/src/signals/core-host.ts` (settings from hub settings; listen to settings changes; carry-over from `plugins.get("triggers")?.settings` once, recorded in `meta`), `packages/core/src/app.ts` (`wanted` without the card). Tests: `packages/core/test/triggers/hub.test.ts` updated (no fixture card needed; settings through hub settings; carry-over test with a plugin row holding `{ allowPrivateUrls: true }`).

### Task 2: The web section

Files: create `packages/web/src/pages/Triggers.tsx` (list + detail with pipeline and journal), register the section where Settings sections are registered (read `App.tsx`'s `OpenSection` and the sidebar/settings nav), `packages/web/src/i18n/{en,ru}.ts` (port the plugin's `ui.*` strings as `triggers.*`, plus pipeline/journal strings), `packages/web/src/pages/Tasks.tsx` (`TRIGGERS_URL` → `/api/triggers`), `packages/web/src/demo/hub/routes.ts` (demo answers `/api/triggers`). Tests: a component test in the style of the web package's existing tests if there are any; otherwise the i18n parity test plus `npm run build`.

### Task 3: Remove the plugin

Files: delete `plugins/triggers/` (UI module, locales, manifest, package.json); `package-lock.json` (`npm install`); `scripts/build-ui-plugins.mjs` if it lists plugins by name; `packages/web/src/demo/hub/routes.ts` (drop the `triggers` UI plugin entry); `packages/core/test/i18n.test.ts` keeps passing (plugin list is read from disk). Check `packaging/` for references (`grep -rn "plugins/triggers" packaging scripts packages`).

### Task 4: Docs, checks, live run, PR

- Docs as in Global Constraints; `npm run check:site`.
- `npm run typecheck && npm test && npm run build`.
- Live: throwaway hub; open `http://127.0.0.1:<port>/` in the built-in browser, sign in with the setup token from the log, open Triggers, see the default review, open its journal; then delete the data dir.
- PR "Triggers become part of the hub: their page, settings, the plugin removed (unified triggers, phase 5)"; green checks; merge.
