# What each conversation and task spends

The person runs Piomio on a Claude subscription and kept hitting its limits. Finding out why took an outside agent
summing token counts from Claude Code's transcripts: Fable at xhigh on "deep" tasks (PR #53), dialogs re-reading and
re-writing 150–360k-token contexts (PR #60), cold-cache rewrites after a pause. On 2026-11-23, 6.5M tokens (~$6 at API
prices) went in 11 minutes, ~80 % of it cache writes. Piomio itself should say which thread spent what, on which model
and effort, and how big its context is now: in the Settings panel and in the chat (CLAUDE.md "Interface": chat first).

## What the code does today

- `ClaudeStreamParser` emits a `usage` event per turn with `costUsd` = Claude Code's `result.total_cost_usd`. That
  figure is the CLI's own cost ledger for the whole process (`total_cost_usd: L_()`, `L_ = costLedger.totalCostUSD()`):
  a dialog's process lives across turns (keepWarm), so it is cumulative, not the turn's.
- The runner sums a turn's tokens into `usage` (day + agent + kind) and the session's context into `sessions`. Nothing
  records which conversation or task, which model or effort, or dollars.
- Codex, Kimi and the API brains report tokens only; Codex and Kimi no cache split.
- Bare questions to the quick model (auto mode's reviewer, trigger triage, readers) spend too and are counted nowhere.

## Decided

- **A row per turn** (`spend`), not a daily aggregate: periods are the person's own day (hub time zone), and a turn
  that wrote 300k tokens to the cache is something the chat can point at. Kept 90 days, pruned once a day.
- **Dollars are an API-price equivalent**, always said so: what the same tokens would cost on the provider's API. A
  subscription bills differently and Anthropic does not publish how its limits are counted.
- **Where a dollar figure comes from**: the brain's own reckoning when it gives one (Claude Code), else Piomio's price
  table × tokens, marked as an estimate; no known price → no dollars (the tokens still count).
- **A view of its own in the Settings panel**, `Spend` in the Activity group (beside Tasks and Inbox), not a card in the
  General form: it is read, not saved, and the form is long already.
- **A hub tool for the default agent**, `hub_usage_report`, read-only. Other agents do not see it: every tool in a
  session's list is paid for in its prompt.

## Design

### 1. Recording (`packages/core/src/spend.ts`)

```sql
create table spend(id text primary key, at text not null, agent_id text not null,
  conversation_id text, task_id text, session_id text, brain_ref text not null, model text, effort text,
  purpose text, input integer not null default 0, cache_read integer not null default 0,
  cache_write integer not null default 0, output integer not null default 0, usd real, estimated integer not null default 0);
create index spend_at on spend(at);
create index spend_conv on spend(conversation_id, at);
```

Ids are `sp_…` (`newId`), unique across replicas, and the table is in `MAIN_TABLES`: every replica shares it, as it
shares `usage` and `machine_spend`. `input` is the input read fresh (the event's whole input minus cache reads and writes). The runner records one row at
the end of every turn, beside `countUsage`: the conversation, the task, the session, the brain ref, the model that
answered (the `model` event, else the one asked for) and the effort. A bare session records one with no conversation
and `purpose` = its folder (`quick`, `review`): `BareAskDeps.spend` taps the handle's events in `openBare`.

### 2. Claude Code's cost per turn

`ClaudeCodeSession` keeps the cost ledger's last total for the running process. A turn's `costUsd` is the difference.
The first result of a process started with `--resume` gives none (the CLI may restore an earlier ledger on resume):
that turn is priced from the table. A fresh process's first total is the turn's.

### 3. Prices (`packages/shared/src/models.ts`)

`KNOWN_PRICES`: regex → `{ input, output, cacheRead?, cacheWrite?, cacheWriteLong? }` per million tokens, first match
wins, beside `KNOWN_MODELS`. Defaults: cache reads 0.1 × input, writes 1.25 × (5-minute cache), 2 × (1-hour). Claude
Code asks for the one-hour cache on a subscription, so its turns use `cacheWriteLong`.

| Family | Input | Output | Cache read | Write 5 m / 1 h |
|---|---|---|---|---|
| Fable 5.2 | 8 | 40 | 0.20 | 10 / 16 |
| Fable 5.1 / 5 | 10 | 50 | 0.25 / 1 | 12.5 / 20 |
| Opus 5.5 | 4 | 20 | 0.20 | 5 / 8 |
| Opus 5, 4.6–4.8 | 5 | 25 | 0.50 | 6.25 / 10 |
| Sonnet 5.5 | 2 | 10 | 0.10 | 2.5 / 4 |
| Sonnet 5 | 2 | 10 | 0.20 | 2.5 / 4 |
| Haiku 5.5 | 0.10 | 0.50 | 0.01 | 0.125 / 0.20 |
| GPT-6 Astra / 6.1 Sol / Terra / Luna | 10 / 2 / 1 / 0.10 | 50 / 10 / 5 / 0.50 | 1 / 0.20 / 0.10 / 0.01 | — |
| Kimi K3 / K3.1 Pro | 3 / 2 | 15 / 10 | 0.30 / 0.20 | — |

Anthropic's from its model reference (2026-11); OpenAI's and Moonshot's from public price lists, less certain. Aliases
(`fable`, `opus`, `sonnet`, `haiku`) take the newest. Haiku 5.5's higher rate over 100k-token prompts is ignored.

### 4. The report (`spendReport`, `GET /api/spend?period=today|7d|30d`)

`SpendReport` in `packages/shared/src/types.ts`: the period and its start; totals (usd, of it estimated, turns without
a price, tokens by kind); **threads** ranked by dollars (then tokens): a task, a dialog, a group chat or the hub's quick
model, with its title, agent, models × effort (dollars and turns each), tokens by kind, its context now (the newest
session's `context_tokens`) and its last turn; totals **by agent** and **by model**. "Today" starts at midnight in the
hub's time zone; 7 and 30 days are rolling.

### 5. The chat: `hub_usage_report`

`{ period?: "today" | "7d" | "30d", agent?: string, limit?: number }` → English text for the model: the totals with
the API-price caveat, the top threads with their models, efforts, cache split and context, by agent, by model, and a
line on what usually drives spend (cache writes when a long session resumes cold or its prompt changes; Fable and high
effort). The person asks "what ate my limit today?" and the default agent answers from it.

### 6. Settings: the Spend section

Today / 7 days / 30 days. The total and its token split, the caveat, the threads (title, kind, agent, model chips with
effort, dollars, a line of cache read · write · output · context; a task opens its page, a dialog its chat), and "By
agent" / "By model" folded under a details toggle. **Ask in chat** sends "What spent the most today?" to the default
agent. The demo hub answers `/api/spend` with an empty report.

## Not in this change

- Prices the person sets, or an API brain's own `/models` prices and a machine's key-mode prices (those are known at
  the gateway and recorded in `machine_spend`).
- Limits or alerts on spend. The iOS app (not in this repository) gets the chat tool, no screen.

## Tests

- `shared`: `priceOf` per family and alias, `turnCost` with short and long cache.
- `brains-cli`: Claude Code's cumulative total → per-turn cost across turns; none on a resumed process's first turn.
- `core`: `spend.ts` (record, period start in a time zone, ranking, models × effort, agents, context now, estimate
  vs reported vs unpriced, pruning); a runner turn with the fake brain leaves a row with its conversation, model and
  effort; a task's turn its task; `GET /api/spend`; `hub_usage_report`'s text; the migration on a fresh database.
