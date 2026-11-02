# Kimi Code and the API keys flag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** API-key model access behind `PIOMIO_API_KEYS` (off by default), and a `kimi` brain that runs the official
Kimi Code CLI on the person's plan, signed in from the chat.

**Architecture:** The flag is a `Config` field read once; the plugin host, machine setups, secrets, setup state,
bootstrap and hub tools consult it. The Kimi brain is a provider in `packages/brains-cli` speaking ACP to `kimi acp`,
registered by a builtin plugin on the hub and by `piomio-node` on machines.

**Tech Stack:** Node ≥ 24 (TypeScript by type stripping), vitest, React (web, site), npm workspaces.

## Global Constraints

- `PIOMIO_API_KEYS`: on only when exactly `"1"`; off otherwise. Spec: `docs/superpowers/specs/2026-11-01-kimi-code-and-api-keys-flag-design.md`.
- Imports with `.ts` extension, `import type` for types, erasable syntax only.
- Every user-facing string in en + ru catalogs; text for models in English.
- Tests write temp files only under `tmpdir()`.
- Kimi CLI package `@moonshot-ai/kimi-code`; brain id `kimi`; label "Kimi Code"; never touch or copy its token.

---

### Task 1: Flag in core config, plugin host, secrets

**Files:**
- Modify: `packages/core/src/config.ts` (field `apiKeys: boolean`)
- Modify: `packages/core/src/plugins/host.ts` (`discover()` skips `brain-api` when off; `prepareInstall` refuses id
  `brain-api`; builtin grant for `brain-codex` drops `openai_api_key` when off; `pluginView`/settings hide
  `apiKeyRef` when off)
- Modify: `packages/core/src/secrets.ts` (`KNOWN` gains Anthropic, OpenAI, OpenRouter, Gemini, xAI, Groq key patterns)
- Test: `packages/core/test/api-keys-flag.test.ts`

**Interfaces:**
- Produces: `Config.apiKeys: boolean`; `HELD_BACK_WITHOUT_KEYS = ["brain-api"]` in host.ts.

- [ ] Write failing tests: `loadConfig({})` → `apiKeys === false`, `loadConfig({PIOMIO_API_KEYS:"1"})` → true;
  a PluginHost over the real `plugins/` dir does not list `brain-api` when off and lists it when on; codex grant has
  no `openai_api_key` when off; `secrets` capture of a pasted `sk-ant-api03-…` with no plugin patterns.
- [ ] Implement, run `npx vitest run packages/core/test/api-keys-flag.test.ts`, then commit.

### Task 2: Key mode of machines behind the flag

**Files:**
- Modify: `packages/core/src/machine-setup.ts` (deps `apiKeys: () => boolean`; `normalizeSettings(raw, vault, apiKeys)`
  refuses `auth: "key"` when off; `nodeSetup()` downgrades key mode to subscription; `view()` returns `keys: []`)
- Modify: `packages/core/src/app.ts` (pass `apiKeys`)
- Modify: `packages/core/src/tools/hub-tools.ts` (machine_setup_* descriptions, schema enum, missing-key hint)
- Modify: `packages/core/test/machine-setup.test.ts`, `packages/core/test/hub-approval.test.ts` (flag on)
- Test: add cases to `packages/core/test/machine-setup.test.ts`

- [ ] Failing tests: off → set key mode throws `SetupError` naming `PIOMIO_API_KEYS`; stored key mode → `nodeSetup`
  has `auth: "subscription"` and no providers.
- [ ] Implement, run tests, commit.

### Task 3: UI, setup state, tool texts, docs

**Files:**
- Modify: `packages/shared/src/types.ts` (`SetupState.apiKeys: boolean`)
- Modify: `packages/core/src/setup.ts`, `packages/core/src/server/api.ts` (bootstrap `apiKeys`, `/api/brains` drops
  wildcard refs)
- Modify: `packages/core/src/tools/hub-tools.ts` (brains_list, brain_check, brain_login, plugin_enable refuses
  held-back), `packages/core/src/locales/{en,ru}.ts` (`chat.cannotStart` variants)
- Modify: `packages/web/src/state/app.ts` (Bootstrap.apiKeys), `packages/web/src/components/BrainSetupCard.tsx`,
  `packages/web/src/pages/Brains.tsx`, `packages/web/src/i18n/{en,ru}.ts`, demo routes
- Modify: `.env.example`, `README.md`, `README.ru.md`
- Test: `packages/core/test/setup.test.ts` (apiKeys in state), i18n parity tests

- [ ] Implement with tests, run `npm run typecheck` and the touched tests, commit.

### Task 4: Kimi ACP client, login parser, provider

**Files:**
- Create: `packages/brains-cli/src/acp.ts` (JSON-RPC over stdio: `AcpConnection` with `request`, `notify`,
  handlers for `session/update` and `session/request_permission`)
- Create: `packages/brains-cli/src/kimi.ts` (`createKimiProvider(o: KimiOptions)`, `KimiUpdateParser`,
  `kimiThinking(configOptions)`, `parseKimiDeviceLogin`, `kimiCommand(command, env)`)
- Modify: `packages/brains-cli/src/index.ts`, `packages/brains-cli/src/messages.ts` (kimi.* strings en/ru)
- Test: `packages/brains-cli/test/kimi.test.ts` + fake ACP agent `packages/brains-cli/test/fake-kimi.mjs`

**Interfaces:**
- Produces: `createKimiProvider({ command: () => string; stateDir: string; mode?: (opts) => "default" | "yolo";
  log?; locale?; loginTimeoutMs? }): BrainProviderImpl` with id `"kimi"`.
- Permission tool name for the hub: `kimi.<KimiToolName>` with the raw input.

- [ ] Failing tests: login parser on the captured real output; session against the fake agent (text deltas, tool
  call + result, permission confined → askHub stub, front desk rejects Bash, unconfined yolo mode, cancel, -32000 →
  notSignedIn error, resume id reused); probe (not installed, not signed in, models/efforts/presets).
- [ ] Implement, run `npx vitest run packages/brains-cli/test/kimi.test.ts`, commit.

### Task 5: Kimi on the hub, machines, installer, Docker, permissions

**Files:**
- Create: `plugins/brain-kimi/{package.json,.piomio-plugin/plugin.json,.piomio-plugin/locales/{en,ru}.json,server/index.ts}`
- Modify: `packages/core/src/cli-tools.ts` (Kimi spec, `.bin` dir), `packages/core/src/settings.ts` (egress hosts),
  `packages/core/src/agents.ts` + `agents/*.md` (`kimi@local`), `packages/core/src/runner.ts` (skills dir),
  `packages/core/src/native-permissions.ts` + `tools/native-permission.ts` (`classifyKimi`),
  `packages/shared/src/thinking.ts` (order), `packages/node/src/{brains,policy,messages}.ts`, `docker/Dockerfile`
- Test: `packages/core/test/cli-tools.test.ts`, `packages/core/test/native-permission.test.ts`,
  `packages/node/test/policy.test.ts`

- [ ] Implement with tests, typecheck, commit.

### Task 6: Site and demo

**Files:** `packages/site/src/locales/{en,ru}.json`, `packages/site/src/sections/Sections.tsx`,
`packages/site/src/components/Diagrams.tsx`, `packages/site/src/entry-server.tsx`, `packages/web/src/demo/world.ts`

- [ ] Copy: plans are Claude Code, Codex, Kimi Code; API keys opt-in for servers. Build the site, commit.

### Task 7: Verify

- [ ] `npm run typecheck`, `npm test`, `npm run build`.
- [ ] Live: run a throwaway hub from this worktree, install Kimi from the card, the person signs in, one dialog turn
  and one task with a hub tool and a shell command; stop the hub and delete its data dir.
