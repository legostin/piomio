# Unified triggers: signals from anywhere, a script and a quick model in front of the agent

The person, 2026-11-07: «единая система триггеров… и вебхуки и скрипты и подключение к внешним сервисам, чтобы мы могли на что угодно завязываться. И изначально скрипт обрабатывает информацию… принять быстрое решение нужно ли вообще ллм задействовать, далее второй уровень — быстрая ллм модель решает надо ли тут что то делать и передает сигнал дальше… будет круто если сам скрипт сможет mcp интеграции вызывать, без ллм».

## Today

`plugins/triggers` has five kinds: `schedule`, `once`, `heartbeat`, `watch` (poll a page, fire on change) and `event` (a public webhook with a secret). Every firing goes straight to `tasks.create`: the whole agent wakes for each one, with nothing in front of it that drops noise or gathers context. Plugins cannot add kinds of their own (`contributes.triggers` is a list of names and nothing reads it), and nothing in the hub (a task failing, a computer going offline) can start anything.

## Decided with the person

- **Trigger kinds come from plugins.** Any ordinary plugin can declare in its manifest the signals it produces; the hub is just another source.
- **All four kinds of sources matter**: mail and messengers, service webhooks, monitoring and polls, the hub's own events.
- **Triggers are a context engine, not n8n.** «Система триггеров не должна писать во внешние системы — она должна писать только в свой контекст выводы для агента и триггерить его запуск если нужно». A script reads (tools with `effect: "read"`, the web, a quick model); it writes only to its own state and to notes for its agent. Every action stays with the agent.
- **Scripts may reach the network, to the hosts they need**, through the hub's layer: the egress proxy.
- **The engine lives in core** (`packages/core/src/signals/`). `plugins/triggers` moves into it, along with its data.

## 1. Signals and sources

A **signal** is one event from any source:

```ts
interface Signal {
  id: string;         // sig_…
  type: string;       // "<source>.<name>": "web.rss_item", "composio.gmail_new_message", "hub.task.failed", "time.tick"
  source: string;     // plugin id, or "hub"
  at: string;
  data: unknown;      // JSON, at most 256 KB, matching the declaration's schema
  key?: string;       // dedup key (a message id): the same key on the same trigger within 24 h is dropped
  subject?: string;   // one line for the journal and the UI
  external: boolean;  // outside content (see Security); from the declaration
}
```

**Declared in the manifest** (`packages/shared/src/manifest.ts`, `contributes.signals`, replacing the unused `contributes.triggers`):

```json
"signals": [
  { "type": "rss_item", "mode": "subscribe",
    "title": "%signals.rss_item.title%",
    "description": "A new item in an RSS or Atom feed (English, for the model)",
    "config": { "type": "object", "properties": { "url": { "type": "string" } }, "required": ["url"] },
    "data": { "...JSON Schema of the signal's data..." },
    "sample": { "...data for test runs..." },
    "external": true }
]
```

The hub sees the type as `<pluginId>.<type>` (the same rule as tool prefixes). A plugin can emit only the types it declared. `external` defaults to true for plugin sources.

**In the SDK** (`packages/plugin-sdk/src/types.ts`, `PluginContext.signals`):

- `emit(type, data, { key?, subject? })`: a **broadcast** signal. The plugin sends it whenever it happens; triggers filter.
- `provide(type, { subscribe(sub: { id, config }, emit): { stop(): void } | Promise<…> })`: a **subscribe** signal. The hub calls `subscribe` once for each distinct `config` that some enabled trigger uses, and `stop` when none does. A source does no work (polls nothing, registers no webhook) while nobody listens.

Plugin → hub over the existing RPC: `signals.emit`. Hub → plugin: `signals.subscribe` / `signals.stop`. A plugin that restarts gets its live subscriptions again.

**Core's own sources:**

- `time.cron` (`cron`, or `times` + `weekdays`) and `time.at` (`at`): today's schedule, heartbeat and once, with the engine's catch-up, the slot that never fires twice, the sleep detection and the replica hand-over carried over as they are.
- `web.webhook`: each trigger gets `/hooks/t/<triggerId>`. It is verified by a shared secret (`x-piomio-secret` or `?secret=`), or by an HMAC signature: `github` (`X-Hub-Signature-256`), `stripe` (`Stripe-Signature`, with its timestamp tolerance), or `hmac-sha256` with the header the trigger names. The HMAC key lives in the vault (`vault://…`). Answers stay as today: 202, 401, 404, 409, 429.
- `web.page`: today's `watch` (url, selector or jsonPath, interval). It emits a signal with `previous`, `current` and `diff` when the extracted value changes.
- `hub.*`, mapped from the bus: `hub.task.finished`, `hub.task.failed`, `hub.machine.online`, `hub.machine.offline`, `hub.location.changed`, `hub.library.file`, `hub.feed.post`, `hub.approval.waiting`. These are not external.

**A poll is not a source of its own.** It is `time.cron` plus a script that calls a tool or an API, compares with `pio.state` and drops the signal when nothing changed.

## 2. A trigger

```ts
interface Trigger {
  id: string; name: string; agentId: string; enabled: boolean;
  createdAt: string; updatedAt: string; createdBy: string;
  on: Array<{ type: string; config?: Record<string, unknown>; where?: Match }>;
  batch?: { windowSec: number; max?: number };   // gather signals, then run once for the group
  script?: { code: string; hosts: string[] };    // stage 1
  triage?: { brief: string };                    // stage 2: what matters, in the person's words
  wake: { prompt: string; machine?: string; machineName?: string; skill?: string; report?: boolean };
  limits: { wakesPerDay: number; triagePerDay: number };  // wakesPerDay is today's maxRunsPerDay
  state: TriggerState;                           // today's fields (nextRunAt, lastSlot, lastHash, runsToday…) plus the script's
}
```

`Match` is a small declarative filter over a signal's fields, with no code: `eq`, `ne`, `contains`, `matches` (regex), `in`, `exists`, `gt`/`lt`, combined with `all`/`any`/`not`. Paths are dotted (`data.from.address`).

## 3. The pipeline

For each signal (or each batch):

1. **match**: `where` of the subscription the signal came by. A miss leaves no run in the journal; only a counter goes up.
2. **dedup** by `key`.
3. **batch**: with a window, signals collect until it closes (or `max` is reached) and go on as one group.
4. **script** (optional), in the sandbox. It returns a verdict:
   - `{ drop: reason }`: nothing happens;
   - `{ note: text }`: a note for the agent, no wake;
   - `{ wake: summary, context? }`: wake the agent now, without the model;
   - `{ triage: context }`: let the quick model decide, with what the script gathered.

   If the script returns nothing, the signal goes to triage when there is one, and otherwise wakes the agent.
5. **triage** (optional): the quick model gets the trigger's `brief`, the signals' subjects and data (trimmed), the script's context, and this trigger's last five notes, so it does not repeat itself. It answers strict JSON, `{ "decision": "drop" | "note" | "wake", "why": "…", "summary": "…" }`. An answer that does not parse is retried once, then handled as "model unavailable".
6. **outcome** (section 5).

A trigger with neither a script nor triage wakes the agent on every signal: today's schedules keep today's behaviour exactly.

Every run (from step 2 on) is written to `trigger_runs`: the signal ids and subjects, each stage's verdict and why, durations, the script's log lines, triage tokens, and the outcome (note id or task id). Each trigger keeps 200 runs or 14 days. This is how anyone answers «почему ты меня не разбудил из-за того письма».

## 4. The script sandbox and `pio`

A script is JavaScript, or TypeScript stripped by Node's `module.stripTypeScriptTypes`. It is an ES module whose default export is `async (signal | signals[], pio) => Verdict | void`. It runs in **QuickJS compiled to WASM** (`quickjs-emscripten` 0.32, sync build; host functions return QuickJS promises, which the host resolves while it pumps `executePendingJobs`):

- no files, processes or network, no `require` or `import` of anything; the only way out is `pio`;
- limits: 64 MB of memory, 2 s of CPU (interrupt handler), 30 s for the whole run including waits, 50 `pio` calls per run;
- a fresh runtime for every run; only `pio.state` lives between runs.

```ts
pio.tools.call(name, input)          // → { text, data? }; a hub tool with effect "read" only
pio.fetch(url, { method?, headers?, body? })  // → { status, headers, text, json() }; only `hosts`, through the egress proxy
pio.llm.ask(prompt, { schema?, system? })     // → string or parsed JSON; the quick model
pio.state.get(key) / set(key, value) / delete(key)  // the trigger's own KV (table trigger_state), 1 MB in all
pio.notes.recent(n)                   // this trigger's last notes
pio.log(...args)                      // into the run's journal
pio.now()                             // { iso, local, timezone }
```

**`pio.tools.call`** goes through `ToolGateway` under the identity `trigger:<id>` and the agent's tool list. A tool whose effect is not `read` is refused before policy, with a clear error in the run's journal. Its calls are audited like an agent's. That one call covers our plugins, every MCP server (`<server>_<tool>`) and Composio. A tool that needs a person (a card) is refused: nobody is there to approve it.

**`pio.fetch`** is made by core, not inside QuickJS. It uses an egress token `trigger:<id>` whose allowlist is the trigger's `hosts`. Private networks are closed unless the person allowed them (today's `allowPrivateUrls`), answers are capped at 5 MB, and 15 s is the limit per request. The hosts are on the trigger's card. When an agent adds a host the trigger did not have, the person confirms it once on the existing network approval card (`network-approvals.ts`), so what was read from the mail cannot quietly go to an address nobody saw.

**`pio.llm.ask`** is a bare session with no tools, the way auto mode's reviewer runs (`policy/reviewer.ts`): the router's `need: "light"` over the brains that are signed in. Its answer goes back only to the script. It counts against `triagePerDay`.

## 5. Outcomes

**note**: a row in `signal_notes` (agent, trigger, text, signal ids, `external`, at). It is kept for 30 days. The agent learns of notes in two ways:

- **Without asking.** Before a turn of its dialog or its tasks, a `[Signals]` block (next to `[You now]`, only when something changed since the session last saw it) lists what is new. A note that is not external shows its text. An external one shows only the trigger's name and a count («Почта: 3 new notes»), because outside text in every dialog would taint every session.
- **On demand.** `signals_recent` (by trigger, by time, by text; `effect: "read"`, `source: true`) returns the notes in full. Reading external ones taints the session, as reading the web does today.

**wake**: today's `tasks.create` with today's settings (machine, skill, report, the daily limit, skipped while the previous run still works). The task's goal is the trigger's `prompt` plus a `[Signal]` block: the summary from triage or the script, the gathered context (trimmed to 8 KB), the signals' subjects and ids. The agent starts with what it needs, and gets a whole signal from the journal by id (`trigger_runs`) when it wants one. A wake whose signals or script reads were external creates the task with `tainted: true`.

**Feedback** on a trigger's notifications works as today (useful / less / off). New: "less" on a trigger with triage also adds a line to its `brief`, «the person asked for fewer: be stricter», besides polling less often.

## 6. In the chat first

The agent's tools (core tools, the same `trigger_*` names as today):

- `trigger_sources`: the signal types available now, each with its description, config schema and sample. The agent learns what it can subscribe to from this.
- `trigger_create` / `trigger_update` take the new fields (`on`, `batch`, `script`, `triage`, `wake`, `limits`). The old ones (`kind`, `cron`, `at`, `url`, `selector`, `jsonPath`, `intervalMinutes`, `times`, `weekdays`, `prompt`, `maxRunsPerDay`) are still accepted and translated, so calls made the old way keep working.
- `trigger_test`: a **test run with no outcome**, on the source's sample, on the trigger's last real signals, or on data the agent gives. It returns the whole path: what match dropped, what the script returned and logged, what the model decided. The agent writes, tests and fixes the script before the person ever sees it.
- `trigger_runs`: the journal.
- `trigger_list`, `trigger_delete`, `trigger_run_now`: as today.
- A `trigger` card in the chat: what the trigger listens to, its stages, its hosts, its last runs, on/off, Test and Delete. A new host is confirmed on it.

A typical exchange: «Следи за почтой, буди меня только по счетам и письмам от клиентов, остальное просто запоминай». The agent finds the mail source, writes the filter and the brief, runs `trigger_test` on the last 20 messages and shows: 3 would wake, 5 would become notes, 12 are dropped, and which ones.

**Web**: Tasks → «Расписания» becomes «Триггеры». A trigger's page shows its pipeline and its journal; each run opens to every stage's verdict. **iOS**: today's API keeps working (section 7), so `TriggerView` keeps working. Showing the pipeline and the journal on the phone is a separate task in `piomio-ios`.

## 7. Moving in, the cluster, failures

**Moving in** happens in steps, so nothing breaks on the way:

- Phase 1 moves the engine's code into core behind a small host interface (`TriggerHost`, the part of the plugin context it used) and keeps everything else where it is. The triggers stay in `plugin_kv` under `triggers` (already replicated), the settings stay on the Triggers card in Plugins, and the page stays the plugin's UI module. The plugin stays as a UI-only plugin, and its on/off switch still turns triggers on and off. The old addresses keep working as they are: webhooks at `/hooks/triggers/<id>` and the API at `/api/plugins/triggers/http/*`, both served by core. The `trigger_*` tools keep their names.
- Phase 2 changes the stored shape in place, once, at start (a trigger without `on` is converted):

| before | after |
|---|---|
| `schedule` | `on: [{ type: "time.cron", config: { cron } }]` |
| `once` | `time.at { at }` |
| `heartbeat` | `time.cron { times, weekdays }`, same prompt |
| `watch` | `web.page { url, selector, jsonPath, intervalMinutes }` |
| `event` | `web.webhook { secret }` |

  `prompt` → `wake.prompt`, `maxRunsPerDay` → `limits.wakesPerDay`, and `machine`, `skill`, `report` → `wake`. State moves with it, so no slot fires twice. The default heartbeat is still created once, for a new hub. The API answers in the same shape plus the new fields, so the phone keeps working.
- Phase 5 moves the page into the web app (`/api/triggers/*`, with the old path kept as an alias), turns the plugin's settings into hub settings in `packages/core/src/settings.ts` (`triggersAllowPrivateUrls`, `triggersWatchTimeoutSec`, carried over from the plugin's saved values; not environment variables), and removes the plugin.

**Cluster**: the engine runs on the leading replica only, as plugins do today. Triggers live in `plugin_kv`, which is replicated already; `trigger_runs`, `signal_notes` and `trigger_state` join replication (`cluster.ts` tables) when phase 2 adds them. A webhook that reaches a standby replica is forwarded to the leader (`server/forward.ts`).

**Failures:**

- A script that throws, runs out of a limit, or calls what it may not: the run is an `error`, and the trigger keeps working. The same error in a row is collapsed. After 5 in a row the person gets one notification, and the agent can fix the script in the chat.
- The quick model is unavailable (nobody signed in, over a limit, unparseable twice): the signal wakes the agent while the day's wakes last, and becomes a note after that. Nothing is lost, and the agent is the stronger judge.
- A flood: over 60 signals a minute on one trigger turns on a 60 s batch by itself; over 1000 a minute, signals are dropped with one line in the journal per minute.
- A source plugin that stops or is turned off: its subscriptions wait. The trigger's card says so («источник выключен»), and they start again with the plugin.

## Security

- Nothing a trigger does writes outside the hub: the gateway refuses non-read tools for `trigger:<id>`, and `fetch` reaches only the hosts on the card.
- Outside content stays marked: an external signal, a `source` tool's result or a fetch makes the run external. Its notes show no text in `[Signals]`, and its wake task is tainted, so EgressGuard and the reviewer treat the agent as they do after it reads the web.
- Triage and `llm.ask` are bare sessions: a prompt injection in an email can at most change a decision (wake instead of drop), not act.
- A source can emit only the types it declared; core validates `data` against the declared schema and its size.
- The script's code is on the card and in the journal. Changing it, adding a host or turning a trigger on is audited (`trigger.update`), like any hub change.

## Phases

One spec, built in this order, each phase shipping on its own:

1. **Core engine**: the code moves into `packages/core/src/signals/` behind `TriggerHost`; the data, the settings and the page stay; core serves the old addresses; the same `trigger_*` tools; today's behaviour unchanged. Its tests move with it.
2. **Model and stages**: the new trigger shape migrated in place (section 7), the sources registry with `time.*`, `web.page` and `web.webhook` (secret + HMAC), then match, dedup, batch, the QuickJS sandbox with `pio`, triage, `signal_notes` with `[Signals]` and `signals_recent`, the journal, `trigger_test`, `trigger_sources`.
3. **Plugin sources**: `contributes.signals`, `ctx.signals` in the SDK and runner, the RPC, `hub.*`; `web.rss_item` in the web plugin as the reference subscribe source; `integrations/_template`, its guide and the `make-integration` skill.
4. **Outside services**: Composio triggers in the Composio integration (one source per app's trigger the person's connected accounts have, e.g. Gmail's new message, Slack, GitHub, Notion, Linear). Before building, check whether Composio's delivery needs the hub's public URL or offers a channel the hub opens itself. An IMAP integration for mail with no one in between comes after.
5. **Web**: the Triggers tab, a trigger's page with its pipeline and journal, the plugin's settings as hub settings, the plugin removed; docs in `docs/guide/{en,ru}` for triggers, sources and writing a source in a plugin.

## Testing

- Unit: `Match`, dedup, batch windows, the sandbox's limits (memory, CPU, wall time, call count), `pio`'s refusals (a write tool, a host not on the list, a private address), triage's JSON and its fallback, the migration's mapping, the `[Signals]` block for external and internal notes.
- The engine's current tests (`plugins/triggers/test/*`) move to core and pass unchanged against the migrated engine: schedules, catch-up, sleep, webhooks, watches, feedback.
- Integration (testkit): a fake plugin declares a subscribe source and emits a signal. The test checks that `subscribe` is called with the trigger's config, the signal passes match, script and triage (a stub brain), and ends as a note, and, in a second trigger, as a tainted task. `stop` is called when the trigger is deleted.
