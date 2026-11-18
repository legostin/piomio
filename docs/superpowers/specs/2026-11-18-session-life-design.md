# Sessions that do not re-read the whole dialog

Issue legostin/piomio#58 (2026-11-18): a dialog keeps one Claude Code conversation for days, every message re-reads
145–156k tokens, and a changed system prompt (a new work rule) or a cold cache rewrites all of it (133–144k tokens
written). Tasks reach 290–450k. Asked with it: «в конфиг самого пиомио в интерфейсе возможность кап ставить и размер
пересказа максимальный».

## What the code does today

- `openSession` renders the system prompt anew every time (`runner.ts`), so it changes after each hub restart too: the
  team, the computers and the brains' readiness are in it as they are at that moment.
- A session's stamp (`stampOf`) holds the whole agent, the tool names, the connections and, for a main dialog, the work
  rules. Any change closes the CLI and resumes the conversation with another prompt: the cached prefix is gone.
- The hub does not know how big a session's context is: `ClaudeStreamParser` reports a turn's token sum only.
- Claude Code compacts by itself near the model's window (1M for the big models). Its idle compaction is for
  interactive sessions only, so a headless one never gets it. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (100000–1000000) sets
  the window per process. On a subscription the main conversation's prompt cache lives one hour.

## Decided with the person

- Dialogs start afresh from the hub's recap; tasks keep their history and get Claude Code's own compaction at a lower
  window (the model writes the summary of its work, so a task loses no working state).
- The caps and the recap's size are hub settings, in the Settings panel and in the chat.

## Design

### 1. What the hub knows about a session

`sessions` gets: `system_prompt`, `stamp` (a hash of what it was opened with), `briefed` (a hash of the team and rules
it was last told), `context_tokens` (the prompt of its last model call), `base_tokens` (the prompt of the first call of
this life: instructions, tools, the recap) and `used_at` (when its prompt was last rendered or a turn of it ended).

A brain reports each model call's prompt size as a new event, `{ type: "context", tokens }`. Claude Code's parser emits
it from every top-level `assistant` message (once per API message). The **history** of a session is
`context_tokens − base_tokens`: what was said and done, without the instructions and tools. A session from before this
change has no base, so all of its context counts. Brains that report no size (Codex, Kimi, API brains) are never
renewed by size.

### 2. A session's life (`session-life.ts`, a pure function)

Before every turn and in `warm()`, for a session that would resume on the same brain:

| State | What happens |
|---|---|
| history > cap | **fresh**: the resume token is dropped, the session starts from the recap with a new prompt |
| cold (idle > 60 min) or the stamp changed, history > cap / 3 | **fresh** |
| cold or the stamp changed, history ≤ cap / 3 | **reopen**: resume with a newly rendered prompt (as today) |
| otherwise | **keep**: resume with the stored prompt; the cache stays valid |

The cap is the setting `dialogContextCap` for dialogs and group chats; a task's session is never made fresh (its cap is
infinite), but keeps its stored prompt the same way. "Fresh" uses what is already there: `openSession` without a resume
token returns `fresh`, and the turn gets `recapOf` before its input.

Every fresh start is in the audit log (`session.renew`, with the sizes it was decided on).

A session from before this change has neither a stamp nor a size: its next turn resumes with a new prompt as it did
before (one more full rewrite), its brain says how big it is, and the turn after that starts afresh if it is past the cap.

A hub restart no longer changes the prompt of a session that is still warm: `openSession` with **keep** passes the
stored prompt to the brain.

### 3. What changes mid-life comes as a message

The work rules leave the stamp (`WorkRules.stamp` goes). In a main dialog's turn the hub compares the team and rules as
they are now with what the session was told (`briefed`); when they differ, the turn's input starts with a
`[Your team and rules now]` block carrying both lists as they are now, and `briefed` follows. A session opened with a new prompt has them in the
prompt and gets no note. A changed agent, tool list or connection set still ends the life: those change the cached
prefix whatever the hub does.

### 4. Tasks

`BrainSessionOptions.compactWindow`: the runner sets it for a task's session from the setting `taskContextCap`; Claude
Code's brain passes it as `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. Other brains ignore it.

### 5. Settings

| Key | Default | Range | What |
|---|---|---|---|
| `dialogContextCap` | 120000 | 20000–1000000 | tokens of history after which a dialog's session starts afresh |
| `taskContextCap` | 200000 | 100000–1000000 | tokens at which Claude Code compacts a task's history |
| `recapMaxChars` | 16000 | 4000–200000 | the recap's size in characters |

All three: `CoreSettings`, `settings_update` (agents may change them), `PATCH /api/settings`, the **Brains** card of the
Settings page, the docs' settings page in both languages. The iOS app has no field for them yet: there they are set in
the chat.

### 6. Where the tokens go

The `usage` event gets `cacheReadTokens` and `cacheWriteTokens` (parts of `inputTokens`, which stays the whole input);
the `usage` table gets `output`, `cache_read` and `cache_write` beside `tokens`. No screen for them in this change.

## What it costs

- The recap is mechanical: recent messages in full, older ones a line each, tool results only named. A dialog renewed
  after a quiet hour remembers less than one that resumed.
- A changed tool list or agent with a long history now gives a fresh session instead of a full resume.
- With a 5-minute cache (an API key without the 1-hour setting) "cold" still means an hour: renewing every five minutes
  would cost the dialog its memory.

## Tests

- `session-life.test.ts`: the table above, legacy rows, a context smaller than its base.
- `claude-code.test.ts`: `context` events and the cache split from recorded messages; the compaction window in the env.
- `session-renewal.test.ts` (integration, the fake brain reports context sizes): a dialog past the cap starts from the
  recap; a cold big one does; a cold small one resumes; a new work rule keeps the session and arrives as a note; a
  restarted hub passes the same prompt; a task never starts afresh and gets the window.
- `continuity.test.ts`: the recap follows `maxChars`. Settings: validation in `settings_update` and the API.
