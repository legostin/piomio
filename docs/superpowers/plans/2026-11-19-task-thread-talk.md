# Talking to a task's thread — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Whoever started a task can read its thread (`task_status`), get its answer at once (`task_tell` after `task_message`), and the person sees the task's latest progress line under the task in the chat.

**Architecture:** Two new `Task` fields (`progress`, `owesReply`) carry the state. A pure module formats a thread's tail for the model; the runner glues it to the store, the activity feed and `tellStarter`. Core tools expose it; the web shows `task.progress` wherever a task line is.

**Tech Stack:** Node 24 type-stripped TypeScript, node:sqlite store, vitest, React (web).

Spec: `docs/superpowers/specs/2026-11-19-task-thread-talk-design.md`.

## Global Constraints

- Local imports carry `.ts`; erasable syntax only; `import type` for types.
- Text for the model (tool results, descriptions, prompts, system notes) is English and not translated.
- Person-facing strings go through a catalog (`packages/web/src/i18n/{en,ru}.ts`), both languages.
- Contracts in `packages/shared/src/types.ts` change deliberately: only the two `Task` fields below.
- Docs `docs/guide/{en,ru}/tasks.md` change in the same commit as the feature.
- Tests write temp files only under `tmpdir()`.

## Files

- `packages/shared/src/types.ts` — `Task.progress`, `Task.owesReply`.
- `packages/core/src/db.ts` — migration: `progress`, `progress_at`, `owes_reply` on `tasks`.
- `packages/core/src/store.ts` — read and write the new fields.
- `packages/core/src/task-thread.ts` (new) — `threadLines`, `stepLine`: a thread's tail as lines for the model.
- `packages/core/src/runner.ts` — `lookTask`, `tellFromTask`; `messageTask` sets `owesReply`; `reportTaskDone` clears it; `openTasks` lines carry the step and the last update.
- `packages/core/src/tools/core-tools.ts` — `task_status` reads the thread, new `task_tell`; `TaskLine.look` / `.tell`.
- `packages/core/src/app.ts` — wiring.
- `packages/core/src/policy/engine.ts` — `task_tell` allowed in background runs like `task_status`.
- `packages/core/src/prompt.ts` — `IN_A_TASK`, `howYouWork`.
- `packages/web/src/pages/chat/TaskLine.tsx`, `packages/web/src/pages/TaskDetail.tsx`, `packages/web/src/i18n/{en,ru}.ts`.
- `packages/core/test/task-thread.test.ts` (new), `packages/core/test/dispatch.test.ts` (prompt lines).
- `docs/guide/{en,ru}/tasks.md`.

---

### Task 1: The contract and the store

**Files:** `packages/shared/src/types.ts`, `packages/core/src/db.ts`, `packages/core/src/store.ts`.

**Produces:**

```ts
// Task
/** What the task last told whoever started it (task_tell): the person sees it under the task's line. */
progress?: { text: string; at: ISODate };
/** Its starter wrote to it (task_message) and has not heard back: the next task_tell reaches them at once. */
owesReply?: boolean;
```

`store.updateTask` accepts `progress` (object or `undefined`) and `owesReply`.

- [ ] Add the fields to `Task` after `question`.
- [ ] Append a migration at the end of `MIGRATIONS`:

```ts
  // What a task last told its starter (task_tell), and whether it owes them an answer (task_message).
  `
  alter table tasks add column progress text;
  alter table tasks add column progress_at text;
  alter table tasks add column owes_reply integer not null default 0;
  `,
```

- [ ] `taskFrom`: `...(r.progress ? { progress: { text: r.progress, at: r.progress_at ?? r.updated_at } } : {})`, `...(r.owes_reply ? { owesReply: true } : {})`.
- [ ] `updateTask`: widen the `Pick` with `"progress" | "owesReply"`; write `progress`/`progress_at` together and `owes_reply` as 0/1.
- [ ] `npm run typecheck` passes.

### Task 2: A thread's tail as lines

**Files:** create `packages/core/src/task-thread.ts`; test in `packages/core/test/task-thread.test.ts` (first `describe`).

**Produces:**

```ts
export const THREAD_LAST = 20;
export const THREAD_LAST_MAX = 80;
/** One line per thing that happened in a task's thread, oldest first: the newest `last` after skipping `skip` newest. */
export function threadLines(messages: Message[], o?: { last?: number; skip?: number }): { lines: string[]; total: number; from: number };
/** A turn's step for the model: "command: npm test", "thinking". */
export function stepLine(work: Pick<MachineWork, "step" | "detail">): string;
```

Line shapes (each cut to 500 characters, whitespace collapsed; the whole tail to 12 000 from the newest back):

| Source | Line |
|---|---|
| assistant text | `Task: <text>` |
| assistant `tool_call` | `→ <step>: <detail>` (`stepOfTool`/`detailOfTool`), ` (failed)` when its `tool_result` in the thread is an error |
| system text `[System] …` | the text without `[System] ` |
| user text, no `agentId` | `The user: <text>` |
| user text with `agentId` | `<agentId> writes: <text>` |
| `error` part | `Error: <message>` |
| `approval` part | `Approval “<summary>”: <status>` |
| `attachment` part | `File: <name>` |

The first message (the goal) is skipped: `task_status` prints the goal itself. Streaming messages count.

- [ ] Write the unit tests: a thread of goal + narration + tool call (ok and failed) + starter note + user line gives the lines above in order; `last: 2` keeps the two newest and `from` says where they start; `skip: 1` drops the newest; a 2000-character text is cut to 500 with `…`.
- [ ] Run: `npx vitest run packages/core/test/task-thread.test.ts` → fails (no module).
- [ ] Implement; run again → passes.

### Task 3: The runner and the tools

**Files:** `packages/core/src/runner.ts`, `packages/core/src/tools/core-tools.ts`, `packages/core/src/app.ts`, `packages/core/src/policy/engine.ts`; integration tests in `packages/core/test/task-thread.test.ts`.

**Consumes:** Task 1 fields, Task 2 `threadLines` / `stepLine`.

**Produces:**

```ts
// SessionRunner
lookTask(taskId: string, from: TaskSender, o?: { last?: number; skip?: number }): { ok: boolean; text: string; taint?: boolean };
tellFromTask(taskId: string, text: string): Promise<{ ok: boolean; text: string }>;
// TaskLine (core-tools.ts)
look(taskId: string, from: TaskSender, o: { last?: number; skip?: number }): { ok: boolean; text: string; taint?: boolean };
tell(taskId: string, text: string): Promise<{ ok: boolean; text: string }>;
```

Behaviour:

- `lookTask`: header `Task <id> “<title>” — <agent><where>, since <time>: <state>`; `Goal:`; `Now: <stepLine>` while a turn of the task is in the activity feed; `Last update (<time>): …`; `Asked: …`; `Thread (entries a–b of n, oldest first; skip: <n> reads older):` + lines, only when `mayDirect`; `Result:` whole; `Error:`. `taint` when `carriesTaint(task)`. Unknown id → `{ ok: false, text: "No task <id>." }`.
- `tellFromTask`: refuses outside a task's own id, in a thread (`kind: "message"`: "your reply goes back by itself when you finish"), and with empty text. Saves `progress`. With `owesReply`: clears it and `tellStarter(task, "[System] Task <id> “<title>” (<who><where>) replies: <text>\nIt is still working; its result comes when it finishes.")`. Result text says which happened and "go on with the work".
- `messageTask`: sets `owesReply: true` unless the task had an open question; the note to the task ends with `(If they ask you something, answer with task_tell — it reaches them at once — and go on.)`; the tool result says the task's answer comes back as a message.
- `reportTaskDone`: clears `owesReply` first.
- `openTasks`: after the state, ` (now: <stepLine>)` for a running task with a turn in the feed, then `; last update <time>: <text ≤ 200>` — or `; wrote an update at <time> (task_status shows it)` when the task carries taint.
- `task_status`: schema `{ taskId, last?, skip? }`, description says what it shows; result carries `_meta: { taint: true }` when `taint`.
- `task_tell`: `effect: "local-write"`, inside a task only; added to `BACKGROUND_ALWAYS_ALLOWED`.

Tests (fake brain; `plodder` runs on `fake2`, which cannot steer, so its `SLOW` task stays in one turn for 5 s):

- [ ] `task_tell` from a task (`goal: CALL task_tell {"text":"halfway there"}`) → `task.progress.text === "halfway there"`, no `replies:` note in the dialog.
- [ ] A `plodder` `SLOW` task started from the dialog; `runner.messageTask` → `owesReply`; `runner.tellFromTask(id, "found three")` → the dialog gets `[System] Task <id> “…” (Plodder) replies: found three`, `owesReply` cleared; a second `tellFromTask` adds no note and updates `progress`.
- [ ] `task_message` answering a `task_ask` leaves `owesReply` unset.
- [ ] `task_status` from the dialog on a `THINK` task shows `Task: Let me look.`, `→ reading: notes.md`, `fake found it`; from another agent's dialog: no `Thread`.
- [ ] `[Open tasks you started]` (dialog turn `INPUT?`) carries `last update` and the text; once the task is tainted, `wrote an update` without the text.
- [ ] A tainted task's `task_status` marks the reader's session tainted (last test: it taints the dialog).
- [ ] Run the file → fails; implement; run → passes. Then `npx vitest run packages/core/test/dispatch.test.ts packages/core/test/team-messages.test.ts packages/core/test/errands.test.ts`.

### Task 4: Prompts

**Files:** `packages/core/src/prompt.ts`; `packages/core/test/dispatch.test.ts` (the prompt test).

- [ ] `IN_A_TASK[0]` becomes: `- You do this task yourself; the result is what matters. Start a sub-task only for parts that truly run in parallel.`
- [ ] New line after it: ``- On work that takes more than a few minutes, say where you are with `task_tell` at real milestones (found the cause, half done, the plan changed): one line the person reads under the task, not every step. It does not end your turn and nobody answers it.``
- [ ] The starter line becomes: ``- A message "[System] <name>, who started this task, writes: …" comes from your starter: follow it. When it asks you something, answer with `task_tell` (it reaches them at once) and go on with the work.``
- [ ] `howYouWork`, after the `task_message` line: ``- When the user asks how a task is going, look with `task_status`: it shows what the task did, what it does now and what it last said; answer from that in a few lines. To ask the task itself, write to it with `task_message`: its answer comes back here as a message.``
- [ ] Extend the prompt test: dialog contains `` `task_status` ``, task contains `` `task_tell` ``; run `dispatch.test.ts`.

### Task 5: The web

**Files:** `packages/web/src/pages/chat/TaskLine.tsx`, `packages/web/src/pages/TaskDetail.tsx`, `packages/web/src/i18n/{en,ru}.ts`.

- [ ] `TaskLine`: for a task (and an errand) that is not done/failed/cancelled and has `progress`, a second row under the pill: the text clamped to two lines, muted, with `shortTime(progress.at)`; the pill and the row share one `max-w-md` column.
- [ ] `TaskDetail`: a block like the question's (`task.progress` label: "Last update" / «Последнее сообщение») while the task is open.
- [ ] `npm run typecheck`; `npx vitest run packages/web` and the i18n parity test.

### Task 6: Docs, the whole suite, commit

- [ ] `docs/guide/{en,ru}/tasks.md`: «Строка задачи» — the progress line; «Вопросы в обе стороны» — asking a running task, "how is it going?".
- [ ] `npm run typecheck && npm test`.
- [ ] Commit: `feat: a task's starter reads its thread and hears from it mid-work (task_status, task_tell)`.
