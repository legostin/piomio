# Memory: how the team remembers, and how the person sees it

2026-10-29. The memory plugin (`plugins/memory`) becomes structured, time-aware and self-maintaining, and the person gets
a memory manager on the web and on the phone. Markdown files with git history stay the record: people can read them,
edit them and roll them back without Piomio.

## What the best systems do, and what we take

| System | Idea | Taken here |
|---|---|---|
| Letta / MemGPT | Tiers: core memory always in context, recall and archival memory searched on demand; "sleep-time" agents tidy memory in the background. | A small **core** block at session start (who the user is, strongest preferences); everything else is **recalled per turn** within a budget; a nightly **tidy** pass plus an optional **reflection** task on the agent's own brain. |
| mem0 | Extract → update loop: new facts are compared with similar ones and the model chooses ADD / UPDATE / DELETE / NOOP. | `memory_remember` does the comparison on the hub (duplicates, slots, `replaces`) and shows the agent related facts so its own brain decides; no extra model call per turn. |
| Zep / Graphiti | Temporal knowledge graph: facts link entities and carry validity intervals; a newer fact invalidates an older one instead of deleting it. | Facts name their **entities** (`about`), carry **valid_from / valid_until**, and a superseded fact is archived with `superseded_by`, so history and "what was true when" survive. Entity pages are derived from `about`. |
| ChatGPT / Claude memory | The model saves memories with a tool, the chat shows "Memory updated", the person can see, edit and delete everything. | A quiet **"Remembered: … · Undo"** line under the agent's message; the memory manager lists everything grouped by meaning; forget goes to a trash with undo and stays in git. |
| Generative agents | Retrieval score = recency + importance + relevance; reflection turns observations into higher-level insights. | Hybrid recall score = lexical (FTS5 bm25) + entity overlap + importance + recency + confidence, with a relevance gate. Reflection runs as a background task over the day's messages. |

Embeddings are not required: lexical + entities + time works offline on every hub. `recall.ts` has a seam
(`Embedder`) for a local embedding model later; none ships tonight.

## The fact

One fact per markdown file. New frontmatter fields are optional, so v1 files load unchanged ("lazy migration"):
missing fields are derived when a file is read and written only when the fact is next saved. Unknown keys a person
added by hand are kept.

```yaml
---
title: Lives in Perm
kind: self            # self | person | place | preference | project | event | howto | note
about: [Perm]         # entities the fact mentions
slot: home city       # a changeable attribute: a newer fact with the same subject + slot supersedes this one
tags: []
importance: 4         # 1..5
confidence: 0.9       # 0..1
valid_from: 2026-10-20
valid_until: ""       # set when it stopped being true (superseded, expired)
superseded_by: ""     # the fact that replaced it
supersedes: []        # facts this one replaced (undo restores them)
scope: team           # team | agent:<id> (private to one agent)
sensitive: false
created: …
updated: …
source: assistant/s_1 # v1 provenance, kept
sources: [{agent: assistant, conversation: c_1, session: s_1, at: …, quote: "I moved to Perm"}]
status: active        # active | review | archived
---

The user moved from Kazan to Perm in October 2026.
```

Folders by kind for new facts: `you/`, `people/`, `places/`, `preferences/`, `projects/`, `timeline/`, `howto/`,
`notes/`. Existing files keep their paths; their kind comes from the folder (`profile.md` → self, importance 5).

Derived, not stored in files: usage (times recalled, last recalled), the reflection journal and when memory was last
tidied live in the hub's plugin storage (`plugin_kv`, one row per fact, entry or setting), so recall never makes a git
commit. Until 2026-11 this was a `state.db` next to the search index; the plugin takes such files in once and deletes
them.

On hubs with replicas (cluster spec, "Files") only the facts travel between hubs, file by file; only the leading hub
runs the plugin. Each hub builds the rest itself: the search index, `MEMORY.md` and the git history (a fact that
arrives is committed as "memory: sync" by the hub it arrives at). A `.gitignore` in the plugin's data folder keeps
those out of the file sync, and the plugin storage replicates row by row, so usage and the journal merge. The running
plugin watches its folder and takes in facts that arrive (after a handover, or when both hubs led for a while). When
both hubs changed one fact, the sync keeps the newer version in place and the other as a conflict copy; the plugin
commits the copy, adds its sources to the fact and deletes it. The index is built from the files, so a failure there
never fails a save: it is built again.

## Capture

1. **In the turn, by the agent** (`memory_remember`). The system prompt asks agents to save durable facts the moment
   they learn them: one self-contained fact per call, in the third person, with kind, entities and a slot for
   changeable attributes. The hub then:
   - refuses secrets (passwords, tokens, keys, card numbers, private keys): they belong in the vault (`vault://id`);
   - finds a **duplicate** (token overlap ≥ 0.8): adds the new source, raises confidence, "Already known";
   - **supersedes** facts named in `replaces`, or with the same subject + slot: they are archived with
     `valid_until` and `superseded_by`, the new fact lists them in `supersedes`;
   - marks **sensitive** facts (health, money, beliefs, intimate life, documents; or `sensitive: true`) with
     `sensitive: true` and saves them like any other (since 2026-10-31, at the person's request: no yes needed). Facts
     an earlier version left waiting in `.pending/` or `.review/` still wait for "Remember / Don't" in the manager;
   - never archives a longer note (the profile, a v1 page about a person) through `replaces`: those are updated with
     `memory_write`; a negated claim ("does not", "без") is never a duplicate of the positive one;
   - after untrusted content too, without an approval card (since 2026-10-31): every change is in git, shown in the
     chat with Undo and in the manager;
   - returns related facts so the agent can correct itself (`replaces`) in the next call.
2. **After the day, by reflection.** The plugin keeps a short journal of the person's own messages (from the
   `turn.context` hook, secrets already replaced by vault references). Once a day, when there are new messages, it
   starts a background task for the default agent: read these messages, remember what is durable and missing, fix
   what changed. The journal is emptied after the task is created (setting `reflect`, on by default).

## Recall

- **Session start** (`session.start`): instructions plus the core block: the strongest facts about the user and their
  preferences (importance ≥ 4) and the v1 `profile.md`, within `promptMaxChars`. No more whole-index dumps.
- **Every turn** (new hook `turn.context`, also for input that joins a running turn): the person's message is scored against active facts the agent may see
  (team facts and its own private ones). Facts above the gate, not shown to this session in its last turns, go before
  the message as a `[Memory]` block within `recallMaxChars`. Nothing relevant → nothing added.
- `memory_search` uses the same ranking; archived facts appear only when asked (`include_archived`).

## Consolidation ("sleep")

Hourly check, runs when the last pass is older than 20 hours, or on demand ("Tidy up"):
- expire facts whose `valid_until` passed;
- merge near-duplicates (overlap ≥ 0.85, same scope): keep the newer, move sources, tags and entities into it,
  archive the other with `superseded_by`;
- archive stale low-value facts (importance ≤ 2, untouched for 180 days, not recalled for 90);
- regenerate `MEMORY.md` (grouped by kind) — the profile is the "You" group, always current;
- start the reflection task (above).
Every change is one git commit, so a pass can be rolled back.

## Control and privacy

- Everything is visible and editable in the manager; edits by the person get confidence 1 and source "user".
- **Forget** moves the file to `.trash/` (hidden, outside git) and commits the deletion; **Undo** puts it back (and
  restores what it had superseded, unless it was itself replaced meanwhile). The nightly pass empties trash older than
  30 days only while git keeps the history. Git keeps every version: the detail shows the history and can restore one.
- **Export**: one JSON file with every fact and its raw markdown.
- Secrets never enter memory; sensitive facts are marked as such.

## Contract changes

- Hook `turn.context` (plugin-sdk `HookName`, `HookPayloads`, `HookResults`; core `hooks.ts`):
  payload `{ sessionId, agentId, conversationId, taskId?, background, text, fromUser }`, result `{ context?: string }`.
  The runner puts the returned blocks before the turn's input (after the time and `[You now]` lines).
- Core method `tasks.create` accepts `quiet: true`: the task reports like a trigger's run, only through the agent's
  own `notify()` (the nightly reflection is silent), not with a "Task done" notification.
- Policy: `memory_remember` and `memory_list` join the tools a background run may always use (the reflection runs in
  the background; a remembered fact is local, shown and undoable). `memory_write` / `memory_forget` do not.
- UI SDK: `SlotContribution.inline?: boolean` for `chat.toolResult` — the renderer is shown in the chat without the
  details mode (a line meant for the person), and a message holding only such a call is not hidden.

## HTTP API (`/api/plugins/memory/http`, web port and device port)

Fact JSON (`FactView`):

```json
{
  "path": "you/lives-in-perm.md", "title": "Lives in Perm", "text": "The user moved …",
  "kind": "self", "about": ["Perm"], "slot": "home city", "tags": [],
  "importance": 4, "confidence": 0.9, "validFrom": "2026-10-20", "validUntil": "",
  "supersededBy": "", "supersedes": [], "scope": "team", "sensitive": false,
  "status": "active", "created": "…", "updated": "…",
  "source": { "agentId": "assistant", "conversationId": "c_1", "at": "…", "quote": "…" }
}
```
`source` is the latest provenance or null (`sources` in the detail: oldest first; agent "user" = the person's own
edit); `scope` is "team" or "agent:<id>"; `validFrom` / `validUntil` are dates (`YYYY-MM-DD`) or empty. History
entries are `{rev, at, action, message}`: `action` is one of remember, confirm, edit, forget, restore, undo, approve,
reject, tidy, revert, create, update, sync; `message` is that action in the reader's language. Errors are
`{error, code, params}` with `error` already in the reader's language.

| Route | Result |
|---|---|
| `GET /facts?q=&kind=&status=active\|archived\|all&limit=` | `{ facts: FactView[], review: n, counts: {kind: n} }` (ranked by relevance with `q`, else importance and recency) |
| `GET /fact?path=` | `{ fact: FactView & {sources: Source[]}, before: FactView[], history: [{rev, at, message}] }` |
| `PATCH /fact` `{path, text?, title?, kind?, importance?, validUntil?, scope?, about?}` | `{ fact }` |
| `POST /forget` `{path}` | `{ path, title }` (moved to trash) |
| `POST /restore` `{path}` | `{ fact }` (back from trash, superseded facts restored) |
| `POST /undo` `{path}` | undo of a remember: forget the fact, restore what it superseded |
| `GET /trash` | `{ facts: FactView[] }` (recently forgotten) |
| `GET /review` | `{ items }` (as before, items are FactView + `current`) |
| `POST /review/approve` / `POST /review/reject` `{path}` | as before |
| `GET /history?path=` / `POST /revert {path, rev}` | git versions of a fact / restore one |
| `POST /tidy` | `{ expired, merged, archived, reflection }` |
| `GET /export` | `{ exportedAt, facts: [FactView & {raw}] }` |

v1 routes (`/tree`, `/file`, `/search`) stay for compatibility.
Events: `ctx.ui.emit("changed", {path, action})` after every change.

## Interfaces

- **Web** (`/memory`, the plugin's UI module): "What the team knows about you" — groups You, People, Places,
  Preferences, Projects, Timeline, How-to, Notes; search on top; the review queue first when it has items; a fact
  opens inline with its source ("from your message in the chat with Ada, 29 Oct"), entities, dates, what it replaced
  and its history; edit in place; Forget leaves an "Forgotten · Undo" row. No dialogs.
- **Chat**: under an agent's message, "Remembered: <fact> · Undo" (a sensitive one too).
- **Phone**: a Memory screen from the Hub tab with the same groups, search, review (approve / reject), swipe to forget
  with undo, and the fact's detail.

## Built on 2026-10-29

Everything above except what is listed below. Checked on a throwaway hub with a scripted model: the agent remembers a
move (the old city is superseded and shown as "Before"), a sensitive fact waits for "Remember / Don't" in the chat,
the next message about Anna arrives with her facts in a `[Memory]` block, Undo and "Remember again" in the chat change
memory for real.

## Roadmap

1. **Local embeddings** behind the `Embedder` seam (a small multilingual model run by the hub), joined into
   `relevance`; keep lexical + entities as the fallback.
2. **Entity pages**: a person or place with all its facts and a short summary the nightly pass writes; links between
   entities (who is whose sister) as a light graph.
3. **Conflicts in review**: when a new fact contradicts one without a shared slot, show both side by side with "keep
   the new one / keep both".
4. **"Why did you say that"**: the memories a reply was given, behind a small toggle under the message.
5. **Learning importance** from use: facts recalled and then used in replies rise, ones never used fade sooner.
6. **The phone**: live updates from a socket event and a waiting-count badge on the Hub row; the "Before" and
   history sections can restore a version as on the web.
7. **Agents' own memory**: each agent's notes about how it works with the person (private scope exists already; a
   page per agent to see them).
8. **Import**: bring memories from ChatGPT / Claude exports as review items.
9. **Journal hygiene**: forwarded channel context and expanded skill text reach the reflection journal as the user's
   words; keep only what the person typed.
