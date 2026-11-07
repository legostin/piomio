# Unified Triggers, Phase 4: Events from Composio's Apps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A trigger can listen to events of the person's apps connected through Composio: a new Gmail message, a Slack message, a GitHub push, a new Calendar event and so on. The Composio integration provides them as one subscribe-mode signal source.

**Architecture:** `integrations/composio` declares one signal `event` (subscribe mode), shown as `composio.event`. A subscription's config names the Composio trigger type (`trigger`, e.g. `GMAIL_NEW_GMAIL_MESSAGE`), optionally the app account (`app`), and that type's own `config`. On `subscribe`, the plugin upserts a Composio trigger instance (`POST /trigger_instances/{slug}/upsert`). On `stop`, it disables the instance (`PATCH /trigger_instances/manage/{id}` `{status:"disable"}`), and it re-enables it on the next subscribe. Events come in one of two ways:
1. **Webhook**, when the hub has a public HTTPS address (`settings.get().publicUrl` is https and not loopback). The plugin registers a project webhook subscription once (`POST /webhook_subscriptions`, V3, `composio.trigger.message`) at `<publicUrl>/hooks/composio/events`, keeps its secret in the plugin's storage (it is Composio's, for this hub only), and verifies Standard Webhooks signatures.
2. **Realtime channel**, otherwise. This is the Pusher channel Composio's SDK uses: `GET /api/v3/internal/sdk/realtime/credentials` → `{pusher_key, project_id, pusher_cluster}`, private channel `private-<project_id>_triggers` authorised at `/api/v3/internal/sdk/realtime/auth`, events `trigger_to_client` and `chunked-trigger_to_client`. Composio calls this channel internal; the integration says so on its card and falls back to it only when there is no public address.

Either way, an event is routed by `metadata.trigger_id` to the subscription that created the instance, and emitted with `key` = the event id. A tool `composio_triggers` (read) lists the trigger types of the person's connected apps with their config schemas, so the agent knows what to subscribe to.

Research notes (endpoints, shapes, signing, caveats): `.superpowers/sdd/composio-triggers-research.md` in the worktree. Hand them to implementers as a file.

## Global Constraints

- The integration stays self-contained in `integrations/composio/` (CLAUDE.md): nothing outside its folder changes, except docs and the egress host list if `ws-<cluster>.pusher.com` / `sockjs-<cluster>.pusher.com` must be allowed. Declare them in its `permissions.network` (`*.pusher.com`).
- The Composio key stays in the vault (`composio`); the webhook secret Composio issues is kept in `ctx.storage` (hub-only data, never logged, never in settings or prompts).
- Signals are `external: true`. `data` is Composio's `data`, plus `{ trigger, app, account }` from `metadata`. `subject` is a one-line summary when the payload has an obvious one (`subject`, `title`, `text`, `name`; first 120 chars).
- Webhook verification: HMAC-SHA256 over `"{webhook-id}.{webhook-timestamp}.{rawBody}"` with the secret as UTF-8 bytes, base64. The header may hold `v1,<sig>` entries separated by spaces; any match is enough. Constant-time compare, and timestamps older than 300 s are refused. The hub's public webhook route must pass the raw body to plugins: reuse phase 2's `rawBody` on `TriggerHttpRequest` by adding `rawBody` to `PluginHttpRequest` for public requests in `packages/core/src/server/main-app.ts` and `packages/plugin-sdk/src/types.ts`. That is the one change outside the folder; its contract changes deliberately.
- Polling apps (Gmail, Calendar) take up to their polling interval (2 min at the shortest). The tool's description says so.
- Tests use a fake Composio server (the integration's existing tests show how) and a fake Pusher server (a local `ws` server speaking the few frames used). They never reach Composio.
- Docs: `docs/guide/{en,ru}/tasks.md` (the apps' events as trigger sources) in the same PR.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

### Task 1: The API calls

Files: `integrations/composio/server/api.ts` (trigger types list/get, instance upsert/list/enable/disable/delete, webhook subscription create/get/patch, realtime credentials), tests in `integrations/composio/test/`.

### Task 2: The source, the webhook and the channel

Files: `integrations/composio/server/triggers.ts` (new: subscriptions ↔ instances, webhook registration and verification, Pusher client with reconnect and ping, routing, chunk reassembly), `server/index.ts` (declare `provide("event", …)`, `ctx.http.handle` for `/events`, the `composio_triggers` tool), `.piomio-plugin/plugin.json` (`contributes.signals`, `contributes.http: true`, `*.pusher.com`), locales, `packages/core/src/server/main-app.ts` + `packages/plugin-sdk/src/types.ts` (`rawBody`), tests: subscribe → upsert with the config; stop → disable; webhook with a good, bad and stale signature; Pusher fake delivering a normal and a chunked event; routing by trigger id; dedup key.

### Task 3: Docs, checks, PR

Docs; `npm run typecheck && npm test && npm run build`; PR "Triggers: events from apps connected through Composio (unified triggers, phase 4)"; green checks; merge. A live run needs the person's Composio key, so it is not done here; the PR says so.
