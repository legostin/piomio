# Kimi Code on the person's plan, and API keys behind a flag

2026-11-01. Asked by the person: "давай добавим флаг для того чтобы отключать функционал доступ через просто апи
ключи -- все равно не работает нормально. но добавим oauth авторизацию через Кими через их подписку", then "сайт
тоже поправить". Decided with them: Kimi comes in as the official Kimi Code CLI (a brain like Claude Code and Codex),
not as an OAuth token in our own API loop; the flag covers the API brain and key mode of machines (and Codex with a
key); it is off by default.

## Why the CLI and not the token

Kimi Code's membership guide lets only its own clients (Kimi Code CLI, desktop, VS Code) sign in with the account;
third-party tools must use an API key, and changing the client's User-Agent is a violation that can cost the
membership. Running the unmodified `kimi` CLI that the person signs in to is what the guide allows, the same stance
as Claude Code (memory: no Claude tokens). The hub never reads, copies or replicates the CLI's token.

## Part 1: `PIOMIO_API_KEYS`

Server setting, read like the others (`=== "1"`): unset or anything else means off. Replicas of one cluster should
set it alike (each reads its own env; the leader pushes machine setups).

Off:

- **API brain.** `PluginHost.discover()` does not discover the builtin `brain-api`: no `api:*` brains, no key cards,
  not in the catalog, nothing to enable. Its id stays reserved (an install under that id is refused). The local
  OpenAI-compatible server (Ollama) goes with it. Its DB row and the vault keys stay; `"api:*"` in agents expands to
  nothing; explicit `api:<variant>` refs show as not connected.
- **Key mode of machines.** `machine_setup_set` refuses `auth: "key"` with a message that says why; stored key-mode
  settings are sent to nodes as subscription (`nodeSetup`), so a node never enters key mode; the setup view has no
  `keys`; tool descriptions and the schema speak of subscriptions only.
- **Codex with a key.** The hub does not grant `brain-codex` the `openai_api_key` vault permission and hides its
  `apiKeyRef` setting: Codex runs on the ChatGPT plan only.
- **Pasted keys are still caught.** The key patterns that lived only in `brain-api`'s setup (Anthropic, OpenAI,
  OpenRouter, Gemini, xAI, Groq) move to the hub's own list (`secrets.ts` `KNOWN`), so a key typed in the chat never
  reaches the model whatever the flag.
- **Untouched:** speech-to-text keys (`openai_api_key` / `groq_api_key` for transcription are not model access for
  agents), `secret_request` in general.
- **UI.** `/api/bootstrap` and `SetupState` carry `apiKeys`. The first-run card and the Brains page show no key
  card and no "Codex with a key" hint; the Brains list drops wildcard rows (`api:*@local`). Texts that offered "or an
  API key" (`chat.cannotStart`, `brains_list`, `brain_check`, `brain_login`) have a variant without keys and name
  Kimi Code.

On: everything as before.

## Part 2: the Kimi Code brain

Brain id `kimi` (`kimi@local` on the hub, `kimi@<machine>` on nodes), label "Kimi Code".

- **CLI.** `@moonshot-ai/kimi-code` (MIT, a Node `.mjs`, Node ≥ 22.19). The command is `kimi` from the PATH; a
  `.mjs`/`.js` behind it (an npm link) runs with the hub's own Node, a Windows `.cmd` shim through its target. The
  desktop hub installs it into `<data>/tools` on Sign in (`cli-tools.ts`, `node_modules/.bin` on the plugin PATH);
  the Docker image carries it like `claude` and `codex`.
- **Sign-in.** `kimi login` (RFC 8628 device code) prints `…/code/authorize_device?user_code=XXXX-XXXX` and the code
  to stderr, expires in 1800 s, exits 0 when the person confirms. `runCliLogin` with a Kimi parser feeds the existing
  sign-in card. The token stays where the CLI keeps it: `$HOME/.kimi-code` of the brains' HOME.
- **Sessions.** `kimi acp` (Agent Client Protocol, JSON-RPC over stdio), one process per session, kept between
  turns for dialogs (`keepWarm`), ended with the turn for tasks and resumed with `session/resume`.
  - `initialize` (no fs/terminal client capabilities: Kimi uses its own tools), `session/new` with `cwd` and
    `mcpServers` (the hub's stdio bridge, like Codex), or `session/resume` with the saved id.
  - "Authentication required" (-32000) means not signed in.
  - The system prompt goes into the workspace's `AGENTS.md` between markers, as for Codex; skills into
    `.agents/skills`.
  - Model and thinking: `session/set_config_option` (`model`, `thinking`) when the hub chose them for a turn.
  - `session/prompt` with a text block (attachments as `resource_link`); `session/update` → BrainEvents:
    `agent_message_chunk` → text, `tool_call` → tool_call, terminal `tool_call_update` → tool_result. The prompt's
    result ends the turn; `refusal` and JSON-RPC errors become error events; quota and rate-limit messages become
    `limit_hit`.
  - `interrupt()` → `session/cancel`; `steer()` → false (the hub sends it as the next turn).
- **Probe.** `kimi --version` (installed), then `initialize` + `session/new` in a scratch folder: -32000 → not
  signed in; otherwise the `configOptions` give the models (catalog from their names and descriptions), the thinking
  levels (efforts: those other than `off`) and presets (fast = lowest effort, balanced = the default, deep = the
  highest). The scratch session is deleted. Cached ten minutes per command and version.
- **Permissions.** Kimi has no OS sandbox. Its modes: `default` (manual approvals; Read/Grep/Glob/web pass),
  `plan`, `auto`, `yolo`.
  - Confined (local hub on a Mac): `default` mode; every `session/request_permission` goes to the hub's
    `native_permission` as `kimi.<tool>` with the raw input. A Kimi classifier there: Write/Edit → write (inside the
    agent's folder: allowed), Bash/Terminal → command (asks the person unless it only reads the computer's status, or
    a rule allows it), hub MCP tools → allowed (the hub checks its own tools), anything else → asks.
  - Front desk: writes and commands are rejected (the dialog only looks), hub tools pass.
  - Not confined (Unix-user isolation, remote machines): `yolo`, as Codex runs `danger-full-access` there.
  - Questions Kimi would ask the person (its AskUserQuestion) are declined: agents ask through the hub.
  - A Seatbelt sandbox around `kimi acp` is a later step.
- **Environment.** `KIMI_DISABLE_TELEMETRY=1`, `NO_COLOR=1`; the egress proxy as for every brain;
  `DEFAULT_BRAIN_EGRESS` gains `kimi.com`, `*.kimi.com`, `kimi.ai`, `*.kimi.ai`.
- **Where.** Hub plugin `plugins/brain-kimi` (setting: `command`); `piomio-node` (`brains.kimi` in its policy:
  `enabled`, `command`); `DEFAULT_BRAINS` and the builtin agents get `kimi@local` after Codex; the router orders it
  after Codex.

## Site and docs

- `.env.example`, both READMEs' env tables: `PIOMIO_API_KEYS`. README sections on keys say they need
  `PIOMIO_API_KEYS=1`; brains are Claude Code, Codex and Kimi Code plans.
- piomio.io: plans are Claude Code, Codex and Kimi Code through their official CLIs; API keys are an opt-in for
  servers (`PIOMIO_API_KEYS=1`). The "when a subscription runs out" diagram falls back to Kimi Code instead of an API
  key; llms.txt likewise. The live demo's API brain becomes Kimi Code.

## Tests

- Config default off; `brain-api` not discovered when off, discovered when on; install of id `brain-api` refused.
- `machine_setup_set` refuses key mode when off; `nodeSetup` downgrades stored key mode; key-mode tests run with the
  flag on.
- Codex: no `openai_api_key` grant and no `apiKeyRef` in the view when off.
- Secrets: a pasted `sk-ant-api…` is captured with `brain-api` absent.
- Kimi: login parser on the real output; ACP session against a fake `kimi acp` script (text, tool calls, results,
  permission requests confined / front desk / free, cancel, auth error, resume); probe models and presets.
- i18n parity for every new string (core, web, brains-cli, node, plugin locales, site).
- Live: the person signs in to Kimi once from the card; a dialog turn and a task with a hub tool and a shell command.
