# Agents That Don't Give Up — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tasks keep going through obstacles and brief outages, and the team follows the person's standing rules for where work goes (a computer, its brain, an agent).

**Architecture:** Spec `docs/superpowers/specs/2026-11-02-persistent-agents-design.md`. Fixes in the Codex config, the runner's task loop (`afterTaskTurn`/`turn`/`scheduleTasks`), prompts, `task_message`; a small `work-rules.ts` module with two core tools; GPU names from `@piomio/shared/hardware` in machine info and computers lists.

**Tech Stack:** TypeScript on Node 24 (type stripping), vitest, the fake brain plugin in `packages/core/test/fixtures`.

## Global Constraints

- Import local files with `.ts`; erasable syntax only; `import type` for types.
- Every user-facing string goes through `packages/core/src/locales/{en,ru}.ts`; model-facing text is English.
- Tests write temp files only under `tmpdir()`.
- `npm run typecheck` and `npm test` pass; docs in `docs/guide/{en,ru}` change in the same commit.

---

### Task 1: Codex runs the hub's tools without asking

**Files:** Modify `packages/brains-cli/src/codex.ts` (the `mcp_servers.piomio.*` overrides). Test: `packages/brains-cli/test/codex-config.test.ts` (new) or the existing Codex test.

- [ ] Test: the `-c` overrides the brain builds contain `mcp_servers.piomio.default_tools_approval_mode="approve"`.
- [ ] Add the override next to `tool_timeout_sec`.
- [ ] Run the test, commit.

### Task 2: task_message takes a guessed field and refuses an empty one

**Files:** Modify `packages/core/src/tools/core-tools.ts` (`task_message`). Test: `packages/core/test/dispatch.test.ts`.

- [ ] Test: `CALL task_message {"taskId":…,"message":"use B"}` delivers "writes: use B"; `{"taskId":…}` returns an error and adds no message.
- [ ] Implement: `const body = [i.text, i.message, i.note].find(nonEmptyString)`; none → error "Nothing sent: give `text`…".
- [ ] Run, commit.

### Task 3: Tasks wait for a brain instead of failing

**Files:** Modify `packages/core/src/runner.ts` (`TurnResult`, `turn`, `streamTurn`, `afterTaskTurn`, `runTask`, `scheduleTasks`), `packages/core/src/locales/{en,ru}.ts` (`task.waitingBrain`, `task.waitingMachine`). Test: `packages/core/test/task-persistence.test.ts` (new; same hub setup as `agent-machines.test.ts`).

**Interfaces:**
- `TurnResult.errorCode?: "no-brain" | "brain-offline"`; `TurnResult.broken?: boolean`.
- `Runner.waitWindowMs` (instance field, default `{ brain: 30 min, machine: 24 h }`, `retryMs: 60_000`) so tests can shorten it.

- [ ] Test A: an agent whose only brain is `fake@mach_box`, box disconnected → its task stays `queued` with `error` = waiting text and no error message in its chat; connect box → the task runs and is `done`.
- [ ] Test B: same, but the window is shortened to 0 → the task fails with "Can't start the agent…" as before.
- [ ] Test C: a turn that dies mid-way (fake brain `CRASH` keyword, if the fixture has one; else a fake turn throwing) → the task is retried ("Continue…") and ends `done`.
- [ ] Implement in `turn()`: when `!ref`, task set, every reason is "not connected" (`hard === 0`, no limits, no busy) → `errorCode: "brain-offline"` and skip the chat error message.
- [ ] `streamTurn`: `fatal && !limited` → `broken: true` (also the end-of-loop fallback when every brain broke).
- [ ] `afterTaskTurn`: `brain-offline`/`broken` within the window (map `waiting: Map<taskId, {since, broken}>`, broken ≤ 3) → `updateTask({status:"queued", resumeAt: now+retryMs, error: t(waiting…)})`; past it → today's failure path (and the chat error message). Clear the map on any other outcome.
- [ ] `scheduleTasks`: skip a queued task whose `resumeAt` is in the future.
- [ ] `runTask`: count `background_run` only after a turn that ran (not `brain-offline`).
- [ ] Run, commit.

### Task 4: Prompts — keep going

**Files:** Modify `packages/core/src/prompt.ts` (`IN_A_TASK`, `howYouWork`, `goalPrompt`). Test: `packages/core/test/dispatch.test.ts` ("tells the dialog's agent how to route work…").

- [ ] Test: a task prompt contains "two or three really different ways" and "never work around"; a dialog prompt contains "start it again at once another way".
- [ ] Add the lines (spec §3).
- [ ] Run, commit.

### Task 5: Work rules

**Files:** Create `packages/core/src/work-rules.ts`; modify `packages/core/src/tools/core-tools.ts` (tools `work_rule_set`, `work_rule_remove`; `task_agents` lists rules), `packages/core/src/app.ts` (deps), `packages/core/src/runner.ts` (`dispatchContext` gets rules; `sessionStamp` includes them; `placeTask` offline), `packages/core/src/prompt.ts` (rules in "How you work"), `packages/shared/src/types.ts` (`WorkRule`). Test: `packages/core/test/work-rules.test.ts` (new).

**Interfaces:**
- `interface WorkRule { id: string; when: string; machine?: string; agent?: string; brain?: string; createdAt: string }` (shared types).
- `class WorkRules { constructor(settings: Settings); list(): WorkRule[]; set(r: {id?, when, machine?, agent?, brain?}): WorkRule; remove(id): boolean; stamp(): string }`.
- `PromptContext.dispatch.rules?: Array<{ id: string; when: string; machine?: string; agent?: string; brain?: string }>` (names already resolved).

- [ ] Test: `work_rule_set {"when":"rendering","machine":"box"}` stores `machine: "mach_box"`; unknown computer/agent refused with the list; `work_rule_remove` removes; dialog prompt lists "rendering → computer box"; `task_delegate` to offline box returns "starts when box comes online" and the task waits.
- [ ] Implement module, tools, prompt, stamp, placeTask offline (brain from `machine.info.clis` signed in, or the agent's own entry there).
- [ ] Run, commit.

### Task 6: Graphics cards

**Files:** Create `packages/shared/src/hardware.ts` (+ export `./hardware` in `packages/shared/package.json`); modify `packages/shared/src/types.ts` (`MachineInfo.gpus?`, `Computer.gpus?`), `packages/node/src/info.ts` and its caller, `packages/core/src/runner.ts` (`computers()` carries gpus; local reads its own), `packages/core/src/prompt.ts`, `machine_list` / `task_agents` output. Test: `packages/shared/test/hardware.test.ts` or `packages/core/test/hardware.test.ts`.

**Interfaces:** `parseGpus(platform: NodeJS.Platform, output: string): string[]`; `graphicsCards(): Promise<string[]>` (cached).

- [ ] Test parsing: macOS JSON (`sppci_model`), Windows names list, `nvidia-smi` csv, `lspci` lines; duplicates and "Microsoft Basic Display Adapter" dropped.
- [ ] Implement; wire node info (`gpus`), hub's local computer, prompt line "- mach_x: box (GPU: …)".
- [ ] Run, commit.

### Task 7: Docs, full check, ship

- [ ] `docs/guide/{en,ru}`: tasks page (waiting for a brain/computer, retries), computers page (GPU, rules).
- [ ] `npm run typecheck`, `npm test` (file-by-file if the Mac is loaded).
- [ ] Merge into main, push (release by itself).
