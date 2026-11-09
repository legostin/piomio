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
- `hub.*`, mapped from the bus: `hub.task.finished`, `hub.task.failed`, `hub.machine.online`, `hub.machine.offline`, `hub.location.changed`, `hub.library.file`, `hub.feed.post`, `hub.approval.waiting`. These are not external. (Phase 3 left out `hub.location.changed` and `hub.library.file` and marks some hub signals external: see "Decided in phase 3" in section 7.)

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

Phase 2 kept the stored shape it found (see "Decided in phase 2" in section 7): a trigger keeps `kind` and its kind's fields as its built-in source, `prompt`, `maxRunsPerDay`, `machine`, `skill` and `report` stay where they were, and the new fields sit beside them: `on` (other sources only), `batch`, `script`, `triage`, `triagePerDay`, and `verify` for a webhook. The shape above is where phase 5 may take it.

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

A script is JavaScript, or TypeScript stripped by Node's `module.stripTypeScriptTypes`. It is an ES module whose default export is `async (signal | signals[], pio, signals) => Verdict | void`: the first argument is the trigger's own shape (the list when it batches, else one signal; a flood batch of a trigger that does not batch hands it the first), the third is always the whole list. It runs in **QuickJS compiled to WASM** (`quickjs-emscripten` 0.32, sync build; host functions return QuickJS promises, which the host resolves while it pumps `executePendingJobs`):

- no files, processes or network, no `require` or `import` of anything; the only way out is `pio`;
- limits: 64 MB of memory, 2 s of CPU (interrupt handler), 30 s for the whole run including waits, 50 `pio` calls per run;
- a fresh runtime for every run; only `pio.state` lives between runs.

```ts
pio.tools.call(name, input)          // → { text, isError, truncated? }; a hub tool with effect "read" only
pio.fetch(url, { method?, headers?, body? })  // → { status, headers, text, json() }; only `hosts`, through the egress proxy
pio.llm.ask(prompt, { schema?, system? })     // → string or parsed JSON; the quick model
pio.state.get(key) / set(key, value) / delete(key)  // the trigger's own KV (table trigger_state), 1 MB in all
pio.notes.recent(n)                   // this trigger's last notes
pio.log(...args)                      // into the run's journal
pio.now()                             // { iso, local, timezone }
```

**`pio.tools.call`** goes through `ToolGateway` under the identity `trigger:<id>` and the agent's tool list. A tool whose effect is not `read` is refused before policy, with a clear error in the run's journal. Its calls are audited like an agent's. That one call covers our plugins, every MCP server (`<server>_<tool>`) and Composio. A tool that needs a person (a card) is refused: nobody is there to approve it. Refusals reject inside the script.

**`pio.fetch`** is made by core, not inside QuickJS. It uses an egress token `trigger:<id>` whose allowlist is the trigger's `hosts`. Private networks are closed unless the person allowed them (today's `allowPrivateUrls`), answers are capped at 5 MB, and 15 s is the limit per request. The hosts are on the trigger's card. An agent's `trigger_create`, `trigger_update` or `trigger_test` call that gives a script a host its trigger did not have counts as an outside action (effect `external` for that call, through the registry's per-call `effectOf`), so the normal policy decides it: the person's card, a rule of theirs, or auto mode's reviewer, with the new hosts named on the card. What was read from the mail cannot quietly go to an address nobody saw. (Phase 2 decided this instead of the network approval card the plan named: a script's token carries no session, so no network card can be raised from a run.)

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
- `trigger_create` / `trigger_update` take the new fields (`on`, `batch`, `script`, `triage`, `triagePerDay`, and `verify` for a webhook, whose key is a `vault://` reference the person stores through the secret card). The old ones (`kind`, `cron`, `at`, `url`, `selector`, `jsonPath`, `intervalMinutes`, `times`, `weekdays`, `prompt`, `maxRunsPerDay`) stay as they are; an `on` entry for a built-in source becomes the kind and its fields (`normalizeOn`), and a new trigger with only other subscriptions is a `signal` trigger.
- `trigger_test`: a **test run with no outcome**, on the source's sample, on the trigger's last real signals (dedup does not drop them: they are its own), or on data the agent gives, for a trigger as it is, a draft before it exists, or a change before it is made. It returns the whole path: what match dropped, what the script returned and logged, what the model decided. No state, note, task or journal line is written; its quick-model calls count against the day's `triagePerDay`. A test of the trigger as it is only reads; of a draft or the agent's own signals it is a change (asked about after outside content); of new hosts, an outside action. Its answer is marked as outside content when the test read some. The agent writes, tests and fixes the script before the person ever sees it.
- `trigger_runs`: the journal, newest first with each run's stages, or one signal in full; marked as outside content when a run read some. Over HTTP: `GET /triggers/:id/runs` and `POST /triggers/:id/test`.
- `trigger_list`, `trigger_delete`, `trigger_run_now`: as today.
- A `trigger` card in the chat: what the trigger listens to, its stages, its hosts, its last runs, on/off, Test and Delete (a later phase; until then a new host is confirmed on the approval card of the call that adds it).

A typical exchange: «Следи за почтой, буди меня только по счетам и письмам от клиентов, остальное просто запоминай». The agent finds the mail source, writes the filter and the brief, runs `trigger_test` on the last 20 messages and shows: 3 would wake, 5 would become notes, 12 are dropped, and which ones.

**Web**: Tasks → «Расписания» becomes «Триггеры». A trigger's page shows its pipeline and its journal; each run opens to every stage's verdict. **iOS**: today's API keeps working (section 7), so `TriggerView` keeps working. Showing the pipeline and the journal on the phone is a separate task in `piomio-ios`.

## 7. Moving in, the cluster, failures

**Moving in** happens in steps, so nothing breaks on the way:

- Phase 1 moves the engine's code into core behind a small host interface (`TriggerHost`, the part of the plugin context it used) and keeps everything else where it is. The triggers stay in `plugin_kv` under `triggers` (already replicated), the settings stay on the Triggers card in Plugins, and the page stays the plugin's UI module. The plugin stays as a UI-only plugin, and its on/off switch still turns triggers on and off. The old addresses keep working as they are: webhooks at `/hooks/triggers/<id>` and the API at `/api/plugins/triggers/http/*`, both served by core. The `trigger_*` tools keep their names.
- Phase 2 keeps the stored shape (below): the built-in kinds are the built-in sources, and tools accept them as `on` entries, mapped like this:

| `on` entry | stored as |
|---|---|
| `time.cron { cron }` | `schedule` with `cron` |
| `time.at { at }` | `once` with `at` |
| `time.cron { times, weekdays }` | `heartbeat` with `times`, `weekdays` |
| `web.page { url, selector, jsonPath, intervalMinutes }` | `watch` with those fields |
| `web.webhook { verify? }` | `event` with its `secret` (and `verify`) |

  Nothing stored is converted, so no slot fires twice and the default heartbeat is still created once, for a new hub. The API answers in the same shape plus the new fields, so the phone keeps working.
- Phase 5 moves the page into the web app (`/api/triggers/*`, with the old path kept as an alias), turns the plugin's settings into hub settings in `packages/core/src/settings.ts` (`triggersAllowPrivateUrls`, `triggersWatchTimeoutSec`, carried over from the plugin's saved values; not environment variables), and removes the plugin.

**Decided in phase 2:**

- **Storage keeps the built-in kinds.** A trigger keeps `kind` and its kind's fields (`cron`, `at`, `times`, `weekdays`, `url`, `selector`, `jsonPath`, `intervalMinutes`, `secret`): they are its built-in source. `on` holds only subscriptions to other sources (plugins and the hub, phase 3); a new kind `signal` is a trigger with only `on`. A filter (`where`) on a built-in `on` entry is refused, since the kind cannot keep it: the script drops what does not matter.
- **The journal replaces `runs:<id>`.** `trigger_runs` holds every run, old and new; the plugin's `runs:<id>` lists move into it once, at start, each list whole or not at all. `/triggers/:id/runs` reads it.
- **Pending batches and the queue live in `trigger_state`** (`__batch`, `__queue`; keys starting with `__` are the engine's own, 4 MB apart from the script's 1 MB; the `__ext:` marks beside the script's keys count with them). A restart, a stop or another replica taking the lead carries them on. The queue goes one run per turn of the trigger's lock, so an update or a delete waits for one run at most.
- **The sandbox:** a fresh QuickJS runtime per run on a worker thread, with a 256 KB QuickJS stack in a 16 MB worker stack (QuickJS's own check fires well before V8's stack runs out inside the WASM). One warm worker is kept and goes after 5 minutes without a script; at most two runs hold a slot at once, the rest wait their turn.
- **What a script may reach.** Tool families closed to triggers whatever their effect: `browser_`, `web_`, `voice_`, `transcribe_`, `hub_`, `pio_`, `machine_`, `vault_`, and any tool marked `forTriggers: false` (it acts or spends though it reads). Every address in a tool's input, however written, must be on the trigger's `hosts` (an input too deep to read through is refused); a `source` tool refuses any host name in its input (an e-mail address in a text field is fine), because its own fetches could follow redirects anywhere. `pio.fetch` reaches only `hosts`, on ports 80 and 443, with every redirect checked again and no credentials in the address. The run's egress token carries no session, so nothing in it raises a network card.
- **Filters run on V8's linear-time regexp engine** (the `l` flag): no backreferences or lookaround; `i` is emulated by lowering the text and the pattern.
- **Webhooks answer 202 at once** for a trigger with a pipeline: the signal is taken in (matched, deduplicated, counted for floods) synchronously and its run follows under the trigger's lock. 429 for a flood or a full queue.
- **Runs queued before a start wait once** (45 s) when the hub takes the lead, as a batch due while it was away does: a run the old leader carried out may not have reached it yet, and when its journal line arrives meanwhile it is not carried out again. Runs this hub queued itself go on at once.
- **The quick model:** each question is bounded at 25 s, after which it is unavailable and its CLI session is closed; at most 2 questions are in flight on the hub, a third waits its turn. A question that brought no answer gives its `triagePerDay` check back.
- **Notes:** what a note was made from reaches the quick model fenced as data (`RECENT_NOTES`, `SIGNAL_DATA`, `SIGNAL_CONTEXT`); in `[Signals]` an internal note is one line under a header that calls them notes, not instructions, and an external one shows only its trigger's name and a count. Outside content kept in `pio.state` stays marked (`__ext:<key>`), so a later run that reads it is external too.
- **A new script host is an outside action** for the call that adds it (section 4).
- **A run's script state goes with its outcome.** `pio.state` writes stay in the run and reach `trigger_state` in the same step as its journal line (a note, a drop, a wake that started or became a note). A stop before that, or a run that fails (the script's error, the sandbox unavailable, a wake that could not start), keeps none of them, so a retry starts from the state as it was and a poll does not lose a change.
- **A script's error after outside content stays marked.** Its text may carry what the run read, so `trigger_list`, `trigger_run_now` and the "keeps failing" notification show a fixed line instead (`lastErrorExternal`); `trigger_runs` shows it, marked as outside content.

**Decided in phase 3:**

- **Two hub sources are left out.** `hub.location.changed` and `hub.library.file` have no event behind them: the phone's place report is only stored (`user-location.ts`) and an agent's library is read from its conversations (`library.ts`). They come when the hub emits such events.
- **Some hub signals are external.** `hub.feed.post` always (channel posts are gathered from the web); `hub.task.finished` and `hub.task.failed` when the task was started or messaged with outside content or a session of its conversation read some (a task that browsed taints only its session); `hub.approval.waiting` when the approval is tainted. A finish brings one signal (an update while a task stays done brings none; a task that finishes again after another turn brings a new one, keyed by its time). The self-loop guard follows a trigger's wake task to its subtasks and to the approvals asked for in them. Hub signals carry a subject: the task's title, the computer's name, the post's title, the approval's summary.
- **Plugin trust.** A declaration's `external: false` is believed only from a plugin that ships with the hub; an installed plugin's signals (the person's or an agent's) are always outside content.
- **Schemas run on the hub against outside content.** A declaration is checked once, when it is first read, and refused whole when its schema is over 16 KB or 32 levels, uses `uniqueItems`, `$ref`, `$dynamicRef`, `$recursiveRef` or `$async`, has an enum of over 1000 values or over 100 patterns, or a pattern V8's linear-time engine cannot run (backreferences, lookaround, a counted repeat over 16; patterns run without flags, so no `\p{…}` or `\u{…}`); `format` is not checked. A refused declaration is said in the plugin's log, listed with why in `trigger_sources`, and fails the testkit's `startPlugin`, which applies the hub's own checks (`@piomio/core/signal-check`).
- **What a plugin's signal costs the hub.** 600 signals a minute per plugin; the data is checked against its schema only when an enabled trigger listens, within 1 s of the hub's time per plugin a minute (past it, refused until the minute is over). A key and a subject are cut with room to spare, redacted, then cut to 200 and 500 characters.
- **The RPC line.** A plugin's messages travel as NDJSON lines of at most 256 MB (`NDJSON_LINE_MAX`): a signal's data is capped at 256 KB long before that, and the runner refuses data over it before sending.
- **A trigger's `on` is checked against the registry**, by the tools and by the HTTP API alike. A config its source's schema refuses makes no trigger (the API answers 400 with the reason in the reader's language); a type no source brings now, a plugin that does not run and a refused declaration are kept, with a note in the tool's answer or `warnings` in the API's. The hosts in every `on` entry's config and a watch's url are read as the gateway reads a trigger's tool input, since a source sends the address it is given to that host (the web plugin's feeds go outside the egress guard): in a tainted session a host the trigger did not have is an outside action named on the card; in one that read nothing from outside it stays a change, as creating a watch always was. A new script host is an outside action always.
- **`web.rss_item`** keeps what each subscription saw by its whole config, looks at a feed's newest 1000 items only, and starts a new subscription from a new baseline unless its state is from just before (a restart); state unread for 30 days is forgotten. Its interval comes from the config only, at least 10 minutes.

**Cluster**: the engine runs on the leading replica only, as plugins do today. Triggers live in `plugin_kv`, which is replicated already; `trigger_runs`, `signal_notes` and `trigger_state` join replication (`cluster.ts` tables) when phase 2 adds them. A webhook that reaches a standby replica is forwarded to the leader (`server/forward.ts`).

**Failures:**

- A script that throws, runs out of a limit, or calls what it may not: the run is an `error`, and the trigger keeps working. The same error in a row is collapsed. After 5 in a row the person gets one notification, and the agent can fix the script in the chat.
- The quick model is unavailable (nobody signed in, over a limit, unparseable twice): the signal wakes the agent while the day's wakes last, and becomes a note after that. Nothing is lost, and the agent is the stronger judge.
- A flood: over 60 signals a minute on one trigger turns on a 60 s batch by itself; over 1000 a minute, signals are dropped with one line in the journal per minute.
- A full queue (the engine's 4 MB of state for the trigger): signals are refused with a journal line (one a minute; every time for a run now or a one-time reminder), a webhook gets 429, a one-time reminder stays due and is tried again a minute later, and run now says so (`queueFull`). A queued run that cannot be read (a malformed entry) leaves the queue with a journal line instead of failing every step after it.
- A source plugin that stops or is turned off: its subscriptions wait. The trigger's card says so («источник выключен»), and they start again with the plugin.

## Security

- Nothing a trigger does changes the hub: the gateway refuses non-read tools for `trigger:<id>`. Its only reach outside is `fetch` to the hosts on the card, which may send requests there, POST included (searches and GraphQL reads need it): the card that adds a host says so, and what was read can go only to a host the person saw.
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
