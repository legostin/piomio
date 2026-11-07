# Unified Triggers, Phase 2: Signals, Script, Quick Model, Notes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A trigger can put a declarative filter, a sandboxed read-only script and a quick-model triage in front of its agent. Each signal then ends as nothing (`drop`), a note in the agent's context (`note`), or a run of the agent with the gathered context (`wake`). Agents set all of it up from the chat and test it before saving.

**Architecture:** Builds on phase 1 (`packages/core/src/signals/`, `CoreTriggers`). Each firing of a built-in kind becomes a `Signal` and goes to `TriggerPipeline.deliver`: match → dedup → batch → script (QuickJS, `pio` API) → triage (bare quick-model session) → outcome. A trigger with no script, no triage and no batch keeps today's path exactly (`engine.fire`). The journal (`trigger_runs`), the notes (`signal_notes`) and the script's own state (`trigger_state`) are replicated tables. Notes reach agents in a `[Signals]` block before a turn, plus the `signals_recent` tool.

**Tech Stack:** Node ≥ 24.5 TypeScript (type stripping), vitest, `node:sqlite`, `quickjs-emscripten@0.32.0` (sync build), existing brains (bare sessions), existing egress proxy.

Spec: `docs/superpowers/specs/2026-11-07-unified-triggers-design.md`, sections 1–7 and Security.

## Decisions taken while planning (write them into the spec in Task 10)

- **Storage keeps the built-in kinds.** A trigger keeps `kind` and its kind's fields (`cron`, `at`, `times`, `weekdays`, `url`, `selector`, `jsonPath`, `intervalMinutes`, `secret`): they are its built-in source. `on` holds only the subscriptions to other sources (plugins, the hub: phase 3). A new kind `signal` is a trigger with no built-in source, only `on`. Tools accept `on: [{ type: "time.cron" | "time.at" | "web.page" | "web.webhook", config }]` and turn such an entry into the kind and its fields. Nothing stored needs converting, and the phone and the page keep reading `kind`. The spec's mapping table becomes the mapping between those `on` types and the kinds.
- **The journal replaces `runs:<id>`.** `trigger_runs` holds every run (old and new). The `runs:<id>` lists move into it once, at start. `/triggers/:id/runs` reads it.
- **Pending batches are kept in `trigger_state`** (key `__batch`), so a restart does not lose them.

## Global Constraints

- Node runs TypeScript directly: `.ts` imports, erasable syntax only, `import type` for types.
- Triggers never write outside the hub. `pio.tools.call` runs only tools whose effect is `read`, refusing others before policy; `pio.fetch` reaches only the trigger's `hosts`, through the egress proxy (owner `trigger:<id>`), with private networks closed unless `allowPrivateUrls`.
- Limits: script 64 MB memory, 2 s guest CPU, 30 s wall per run, 50 `pio` calls per run, `fetch` ≤ 5 MB per answer and 15 s per request, `pio.state` ≤ 1 MB per trigger, signal `data` ≤ 256 KB, wake context ≤ 8 KB, journal 200 runs or 14 days per trigger, notes 30 days.
- Verdicts: `{ drop: string } | { note: string } | { wake: string, context?: unknown } | { triage: unknown }`, or nothing. Triage answers `{ "decision": "drop" | "note" | "wake", "why": string, "summary": string }`.
- With no script and no triage: no triage → wake. Script returned nothing → triage if there is one, else wake. Quick model unavailable → wake while the day's wakes last, else note. 5 errors in a row → one notification to the person.
- External content stays marked: external signals (`web.page`, `web.webhook`, plugin sources by default), `source` tools' results and fetches make a run external. An external note shows no text in `[Signals]`; an external wake creates its task with `tainted: true`.
- A trigger with no script, no triage and no batch behaves exactly as before (every existing test in `packages/core/test/triggers/` keeps passing unchanged).
- Nothing CPU-heavy runs on the hub's own thread (scripts run in a worker; parsing stays in phase 1's extraction worker). Everything a trigger does after its engine stopped is refused by the host's closed session (phase 1): the pipeline must not work around that (no direct DB handles kept outside the host).
- Every user-facing string goes through catalogs (`packages/core/src/locales/{en,ru}.ts`, keys `triggers.*`). Model-facing text, code and comments are English.
- Docs: the change ships, so `docs/guide/en/tasks.md` and `docs/guide/ru/tasks.md` describe it in the same PR (Task 10).
- Tests write temp files only under `tmpdir()`. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `signals/match.ts` (new) | `Match` type, `matches(match, value)`, `matchError(match)`. Pure. |
| `signals/types.ts` (modify) | `Signal`, `Subscription`, `Verdict`, `StageRecord`; trigger fields `on`, `batch`, `script`, `triage`, `triagePerDay`; kind `signal`; `TriggerRun` stages. |
| `signals/validate.ts` (modify) | Validation and normalisation of the new fields and of built-in `on` entries. |
| `signals/store.ts` (new) | `TriggerStore` over the three tables (journal, notes, script state) with pruning; `memoryStore()` for tests; migration of `runs:<id>`. |
| `packages/core/src/db.ts`, `cluster.ts` (modify) | The three tables and their replication. |
| `signals/sandbox.ts` (new) | `runScript(code, input, host, limits)` on QuickJS. |
| `packages/core/src/bare-ask.ts` (new) | One bare question to a signed-in local brain, extracted from `policy/reviewer.ts` (which uses it). |
| `signals/triage.ts` (new) | The triage prompt, its parse and retry. |
| `signals/pio.ts` (new) | The `pio` host functions for one run. |
| `packages/core/src/tools/gateway.ts` (modify) | `callRead(as, name, input)`: a read-only call on behalf of a trigger. |
| `signals/pipeline.ts` (new) | `TriggerPipeline`: deliver, dedup, batch, stages, outcome, failure counting. |
| `signals/engine.ts`, `prompt.ts` (modify) | Firings go through the pipeline; `[Signal]` block in the goal. |
| `signals/webhook-verify.ts` (new) | Secret and HMAC (`github`, `stripe`, `hmac-sha256`) checks. |
| `signals/notes-context.ts` (new) | The `[Signals]` block. `runner.ts` puts it before a turn. |
| `signals/tools.ts` (modify) | New fields on create/update; `trigger_sources`, `trigger_test`, `trigger_runs`; `signals_recent`. |
| `signals/host.ts`, `core-host.ts` (modify) | The host carries the store, the pipeline's services (gateway read call, quick model, egress token, notify). |

All paths under `packages/core/src/` unless shown otherwise; tests under `packages/core/test/triggers/`.

---

### Task 1: The declarative filter

**Files:** Create `packages/core/src/signals/match.ts`; Test `packages/core/test/triggers/match.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export type Leaf =
    | { path: string; eq: unknown } | { path: string; ne: unknown }
    | { path: string; contains: string } | { path: string; matches: string; flags?: string }
    | { path: string; in: unknown[] } | { path: string; exists: boolean }
    | { path: string; gt: number } | { path: string; lt: number };
  export type Match = Leaf | { all: Match[] } | { any: Match[] } | { not: Match };
  export function matches(m: Match | undefined, value: unknown): boolean;   // undefined → true
  export function matchError(m: unknown): string | undefined;               // English reason, or undefined when valid
  export function pathGet(value: unknown, path: string): unknown;           // "data.from.address", "items.0.id"
  ```

- [ ] **Step 1: Write the failing test** (`match.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { matchError, matches, pathGet } from "../../src/signals/match.ts";

const sig = { type: "x.mail", data: { from: { address: "ann@client.com" }, subject: "Invoice #42 for November", size: 1200, labels: ["inbox", "work"] } };

describe("signal filter", () => {
  it("reads dotted paths, array indexes included", () => {
    expect(pathGet(sig, "data.from.address")).toBe("ann@client.com");
    expect(pathGet(sig, "data.labels.1")).toBe("work");
    expect(pathGet(sig, "data.nope.deeper")).toBeUndefined();
  });

  it("checks each leaf", () => {
    expect(matches({ path: "data.from.address", eq: "ann@client.com" }, sig)).toBe(true);
    expect(matches({ path: "data.from.address", ne: "ann@client.com" }, sig)).toBe(false);
    expect(matches({ path: "data.subject", contains: "invoice" }, sig)).toBe(true); // contains ignores case
    expect(matches({ path: "data.subject", matches: "^Invoice #\\d+" }, sig)).toBe(true);
    expect(matches({ path: "data.subject", matches: "^invoice", flags: "i" }, sig)).toBe(true);
    expect(matches({ path: "data.labels", contains: "work" }, sig)).toBe(true); // an array contains an element
    expect(matches({ path: "data.from.address", in: ["bob@x.com", "ann@client.com"] }, sig)).toBe(true);
    expect(matches({ path: "data.cc", exists: false }, sig)).toBe(true);
    expect(matches({ path: "data.size", gt: 1000 }, sig)).toBe(true);
    expect(matches({ path: "data.size", lt: 1000 }, sig)).toBe(false);
  });

  it("combines with all, any and not; no filter matches everything", () => {
    expect(matches(undefined, sig)).toBe(true);
    expect(matches({ all: [{ path: "data.size", gt: 1 }, { not: { path: "data.from.address", matches: "noreply" } }] }, sig)).toBe(true);
    expect(matches({ any: [{ path: "data.size", gt: 5000 }, { path: "data.subject", contains: "nothing" }] }, sig)).toBe(false);
  });

  it("explains a malformed filter", () => {
    expect(matchError({ path: "data.x", eq: 1 })).toBeUndefined();
    expect(matchError({ path: "data.x" })).toMatch(/one of eq, ne, contains, matches, in, exists, gt, lt/);
    expect(matchError({ path: "data.x", matches: "(" })).toMatch(/regular expression/);
    expect(matchError({ all: "x" })).toMatch(/all must be a list/);
    expect(matchError({ path: "", eq: 1 })).toMatch(/path/);
    // Bounded: no deeper than 8 levels, no more than 50 leaves.
    let deep: any = { path: "a", eq: 1 };
    for (let i = 0; i < 9; i++) deep = { not: deep };
    expect(matchError(deep)).toMatch(/too deep/);
  });
});
```

- [ ] **Step 2: Run it**: `npx vitest run packages/core/test/triggers/match.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `match.ts`.** Rules: `contains` on a string compares lowercased; on an array, it checks whether any element `===` the value or (for strings) equals it ignoring case. `eq`/`ne` use deep equality via `JSON.stringify` of both sides. `gt`/`lt` need a finite number at the path, else false. `matches` compiles `new RegExp(pattern, flags)` once per call (pattern ≤ 500 chars). `exists: true` means `!== undefined`. Depth limit 8, leaf limit 50, both enforced by `matchError` and by `matches` (it returns false on a filter `matchError` rejects).
- [ ] **Step 4: Run it**: expected PASS (4 tests).
- [ ] **Step 5: Commit** `feat(triggers): declarative signal filter`.

---

### Task 2: The trigger model grows

**Files:** Modify `signals/types.ts`, `signals/validate.ts`, `signals/http.ts` (`view`), `signals/when.ts`, `signals/schedule.ts` (`describeSchedule`), `packages/core/src/locales/{en,ru}.ts`; Test `packages/core/test/triggers/model.test.ts`.

**Interfaces:**
- Consumes: `Match`, `matchError` (Task 1).
- Produces (in `types.ts`):
  ```ts
  export const TRIGGER_KINDS = ["schedule", "once", "watch", "event", "heartbeat", "signal"] as const;
  export const BUILTIN_SOURCES = ["time.cron", "time.at", "web.page", "web.webhook"] as const;
  export interface Subscription { type: string; config?: Record<string, unknown>; where?: Match }
  export interface Signal { id: string; type: string; source: string; at: string; data: unknown; key?: string; subject?: string; external: boolean }
  export type Verdict = { drop: string } | { note: string } | { wake: string; context?: unknown } | { triage: unknown };
  export type Outcome = "drop" | "note" | "wake";
  export interface StageRecord { stage: "match" | "dedup" | "batch" | "script" | "triage" | "outcome"; verdict?: string; why?: string; ms?: number; error?: string; logs?: string[]; tokens?: number }
  // Trigger gains:
  on?: Subscription[]; batch?: { windowSec: number; max?: number }; script?: { code: string; hosts: string[] };
  triage?: { brief: string }; triagePerDay?: number;
  // TriggerState gains: errorsInRow?: number; triageToday?: { date: string; count: number }; seenKeys?: Record<string, number>;
  // TriggerRun gains: signals?: Array<{ id: string; type: string; subject?: string }>; stages?: StageRecord[]; outcome?: Outcome; noteId?: string; external?: boolean;
  // TriggerInput gains: on?, batch?, script?, triage?, triagePerDay? (all nullable to clear)
  ```
- `validate.ts` produces `normalizeOn(input: TriggerInput): TriggerInput` (turns built-in `on` entries into kind fields; leaves the rest in `on`) and validation inside `buildTrigger`/`applyUpdate` for:
  - `on`: ≤ 20 entries; `type` matches `/^[a-z][a-z0-9-]*(\.[a-z0-9_-]+)+$/`; at most one built-in entry, and only when the input has no `kind` other than the one it maps to; `where` passes `matchError`; `config` ≤ 8 KB JSON.
  - kind `signal` needs at least one non-built-in `on` entry.
  - `batch.windowSec` 5…3600, `batch.max` 1…500.
  - `script.code` ≤ 64 KB; `script.hosts` ≤ 30, each a host name or `*.domain` (reuse the egress host-list check in `packages/core/src/policy/egress.ts` or `@piomio/shared` `hostMatches` neighbours; no scheme, no port, no path, no private IP).
  - `triage.brief` 1…2000 chars; `triagePerDay` 1…2000 (default 200).
  - Mapping: `time.cron {cron}` → schedule; `time.cron {times, weekdays?}` → heartbeat; `time.at {at}` → once; `web.page {url, selector?, jsonPath?, intervalMinutes?}` → watch; `web.webhook {}` → event. A `web.webhook` config may carry `verify` (Task 8); store it as `trigger.verify`.
- `view()` in `http.ts` adds `on`, `batch`, `script` (code and hosts), `triage`, `triagePerDay` as they are; `whenText` of a `signal` trigger is `triggers.when.signals` with `{types}` (comma-joined `on` types).
- New catalog keys (en and ru): `triggers.when.signals` ("When {types} arrives" / «Когда приходит {types}»), and `triggers.error.<code>` for every new validation code (`onTooMany`, `onType`, `onBuiltinTwice`, `onKindConflict`, `signalNeedsOn`, `whereInvalid`, `configTooBig`, `batchWindow`, `batchMax`, `scriptTooBig`, `hostsTooMany`, `hostInvalid`, `briefRequired`, `briefTooLong`, `triageLimit`). English texts: short sentences in the style of the existing `triggers.error.*`; Russian: natural Russian, same placeholders.

- [ ] **Step 1: Write the failing test** `model.test.ts`: (a) `buildTrigger({ kind: "signal", name: "Mail", prompt: "p", on: [{ type: "composio.gmail_new_message", where: { path: "data.from", contains: "@client.com" } }] })` keeps `on` and `kind: "signal"`; (b) `normalizeOn({ name, prompt, on: [{ type: "time.cron", config: { cron: "0 9 * * *" } }] })` gives `{ kind: "schedule", cron: "0 9 * * *", on: [] }`, and the same for `time.at`, heartbeat-style `time.cron {times}`, `web.page`, `web.webhook`; (c) each validation code above is thrown for its bad input (one `expect(() => …).toThrow(expect.objectContaining({ code }))` per code); (d) `view()` of a `signal` trigger has `whenText` "When x.y arrives" in English and «Когда приходит x.y» in Russian; (e) an old stored trigger without the new fields still passes `applyUpdate` unchanged.
- [ ] **Step 2: Run** `npx vitest run packages/core/test/triggers/model.test.ts`: FAIL.
- [ ] **Step 3: Implement** the types, validation, normalisation, view and catalog keys. `kind` stays required in `buildTrigger` after `normalizeOn` ran (the tools and HTTP call `normalizeOn` first, in Task 10).
- [ ] **Step 4: Run** the new test and the whole `packages/core/test/triggers` folder plus `packages/core/test/i18n.test.ts`: all PASS (old tests unchanged).
- [ ] **Step 5: Commit** `feat(triggers): signal subscriptions, script, triage and batch on the trigger model`.

---

### Task 3: Journal, notes and script state tables

**Files:** Create `signals/store.ts`; Modify `packages/core/src/db.ts` (append one migration), `packages/core/src/cluster.ts` (three table entries), `signals/engine.ts` (`runs`, `addRun`, `remove`), `signals/host.ts` (`store` on `TriggerHost`), `signals/core-host.ts` (pass the store), `packages/core/test/triggers/harness.ts` and the fake host in `engine.test.ts` (use `memoryStore()`); Test `packages/core/test/triggers/store.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export interface NoteRow { id: string; agentId: string; triggerId: string; triggerName: string; text: string; signalIds: string[]; external: boolean; at: string }
  export interface TriggerStore {
    runs(triggerId: string, limit?: number): TriggerRun[];              // newest first
    addRun(triggerId: string, run: TriggerRun & { signalData?: Signal[] }): void;  // prunes to 200 / 14 days for that trigger
    signal(id: string): Signal | undefined;                              // from runs' stored signals
    recentSignals(triggerId: string, n: number): Signal[];
    dropRuns(triggerId: string): void;
    addNote(n: Omit<NoteRow, "id" | "at">): NoteRow;                     // prunes notes older than 30 days
    notes(q: { agentId?: string; triggerId?: string; since?: string; text?: string; limit?: number }): NoteRow[];
    stateGet(triggerId: string, key: string): unknown;
    stateSet(triggerId: string, key: string, value: unknown): void;     // throws RangeError past 1 MB per trigger
    stateDelete(triggerId: string, key: string): void;
    dropState(triggerId: string): void;
  }
  export function sqlStore(db: Db, now?: () => number): TriggerStore;
  export function memoryStore(now?: () => number): TriggerStore;
  export function migrateRunLists(kv: PluginKv, store: TriggerStore): number;  // runs:<id> → trigger_runs, deletes the kv rows, returns count
  ```
- Tables (one migration string appended to the list in `db.ts`):
  ```sql
  create table trigger_runs(id text primary key, trigger_id text not null, at text not null, data text not null);
  create index trigger_runs_by_trigger on trigger_runs(trigger_id, at);
  create table signal_notes(id text primary key, agent_id text not null, trigger_id text not null, at text not null, external integer not null, data text not null);
  create index signal_notes_by_agent on signal_notes(agent_id, at);
  create table trigger_state(trigger_id text not null, key text not null, value text not null, primary key(trigger_id, key));
  ```
  `cluster.ts` table list gains `{ name: "trigger_runs", pk: ["id"] }`, `{ name: "signal_notes", pk: ["id"] }`, `{ name: "trigger_state", pk: ["trigger_id", "key"] }`. Read how the list is used (deletes included) before adding them, and follow what `feed_posts` does.
- `CoreTriggers` gives the host the `sqlStore`, wrapped so that its writes and reads are refused once the start's session is closed. Phase 1 added the session's `closed` flag. Without the wrapper, a stopped engine's in-flight work could still write, the same leak phase 1's final review closed for `storage`.
- Engine: `runs(id)` returns `host.store.runs(id, MAX_RUNS_KEPT)` (keep the name; `MAX_RUNS_KEPT` stays 20 for the UI's list), `addRun` writes `host.store.addRun`, `remove` also calls `dropRuns` and `dropState`. `CoreTriggers` runs `migrateRunLists` once per start, before `startTriggers`.

- [ ] **Step 1: Failing test** `store.test.ts`, run against both `sqlStore(openDb(":memory:"))` and `memoryStore()` with `describe.each`: add 205 runs → `runs(t, 500).length === 200`; a run older than 14 days (fake `now`) is pruned on the next add; `signal(id)` finds a stored signal; notes filter by agent, trigger, since, text (case-insensitive); notes older than 30 days are pruned; `stateSet` past 1 MB throws `RangeError`; `migrateRunLists` moves two `runs:` lists (newest first preserved) and deletes them from kv.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** the new test plus `packages/core/test/triggers` and `packages/core/test/cluster.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(triggers): journal, notes and script state tables`.

---

### Task 4: The script sandbox

**Files:** Create `signals/sandbox.ts` (the API the hub calls) and `signals/sandbox-worker.ts` (QuickJS, inside a `worker_thread`); Modify `packages/core/package.json` (`"quickjs-emscripten": "0.32.0"`, exact), `package-lock.json`; Test `packages/core/test/triggers/sandbox.test.ts`.

**Never on the hub's own thread.** Phase 1's final review found that CPU-heavy work in core freezes the whole hub: chats, approvals, cluster heartbeats. So QuickJS runs in a worker thread, following the worker pattern in `packages/core/src/picture-previews.ts` + `preview-worker.ts` and the watch's extraction worker from phase 1. `runScript` posts `{ code, input, limits }` to a worker. Each `pio` call comes back as a message (`{ call: n, name, args }`), the hub runs the `HostCall` and answers `{ call: n, result | error }`, and the worker resolves the guest's promise. A run that passes `wallMs` (or a worker that stops answering) is ended with `worker.terminate()`, and the next run gets a fresh worker. Keep one idle worker warm and start more on demand, at most 2 running at once; further runs wait in a queue.

**Interfaces:**
- Produces:
  ```ts
  export interface SandboxLimits { memoryBytes: number; cpuMs: number; wallMs: number; maxCalls: number }
  export const SCRIPT_LIMITS: SandboxLimits = { memoryBytes: 64 * 1024 * 1024, cpuMs: 2000, wallMs: 30_000, maxCalls: 50 };
  /** A host function the script reaches as pio.<name>(...args); args and result are JSON. Throwing rejects the script's promise with the message. */
  export type HostCall = (name: string, args: unknown[]) => Promise<unknown>;
  export interface ScriptResult { verdict?: Verdict; logs: string[]; error?: string; ms: number; calls: number }
  export async function runScript(code: string, input: unknown, host: HostCall, limits?: SandboxLimits): Promise<ScriptResult>;
  export function parseVerdict(v: unknown): Verdict | undefined | { invalid: string };
  ```
- Behaviour:
  - TypeScript is stripped first with `module.stripTypeScriptTypes(code, { mode: "strip" })` from `node:module`. A syntax error is `error`.
  - The code is evaluated with `vm.evalCode(code, "trigger.mjs", { type: "module" })`; its `default` export must be a function (else `error: "the script must export a default function"`).
  - The guest gets a prelude that defines `pio` with `tools.call`, `fetch`, `llm.ask`, `state.get/set/delete`, `notes.recent`, `log`, `now`. Each maps to one host function `__host(name, jsonArgs)` that returns a QuickJS promise. The host resolves it after `await host(name, args)` with the JSON of the result (or rejects with the error's message), then runs `runtime.executePendingJobs()`. `pio.log` is synchronous and appends to `logs` (at most 50 lines, 500 chars each). `pio.now` returns `{ iso, local, timezone }`: the prelude takes it as part of `input`.
  - CPU: count only the time spent inside guest code (around `evalCode`, `callFunction` and each `executePendingJobs`); the interrupt handler stops the guest when that total passes `cpuMs`. Wall: a timer rejects the run at `wallMs`. Calls past `maxCalls` reject with `"too many pio calls (50)"`.
  - `runtime.setMemoryLimit(memoryBytes)`, `runtime.setMaxStackSize(1024 * 1024)`.
  - Every handle is disposed, and the context and runtime too, on every path. Use the library's `Scope` or careful `try/finally`; a leaked handle makes `dispose()` throw and must fail the tests.
  - `parseVerdict`: a plain object with exactly one of `drop` (string), `note` (string), `wake` (string, optional `context`), `triage` (any JSON); anything else is `{ invalid }`. `undefined`/`null` is undefined.
- [ ] **Step 1: Failing test** `sandbox.test.ts`:
  - a script returning `{ triage: { n: signal.data.n + 1 } }` gives that verdict;
  - TypeScript annotations work (`export default async function (s: any, pio: any): Promise<any> { return { note: "ok" } }`);
  - `await pio.tools.call("notion_search", { q: 1 })` reaches the host as `("tools.call", ["notion_search", { q: 1 }])` and the script gets the host's JSON back;
  - a host error becomes a catchable rejection inside the script (`try { await pio.fetch("x") } catch (e) { return { drop: e.message } }` → `{ drop: "<host message>" }`);
  - `typeof fetch`, `typeof require`, `typeof process` are all `"undefined"` inside;
  - `while (true) {}` → `error` matching `/interrupted|CPU/`, finished in under 4 s of test time, **and a `setInterval` on the test's (hub's) thread kept ticking every ~50 ms meanwhile** (proves the guest does not run on the hub's thread);
  - waiting on a host call that never resolves → `error` matching `/30 s|wall/` with `wallMs: 300` in the test's limits;
  - allocating a huge array → `error` matching `/memory/i` with `memoryBytes: 8 MB`;
  - 51 calls → `error` matching `/too many pio calls/`;
  - `pio.log("a", 1)` → `logs: ["a 1"]`;
  - no default export → `error` "the script must export a default function";
  - a verdict `{ wake: 1 }` → `error` matching `/invalid verdict/`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (read `node_modules/quickjs-emscripten/dist/index.d.ts` for `newPromise`, `resolvePromise`, `setInterruptHandler`, `Scope`). **Step 4: Run** → PASS, then `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(triggers): QuickJS sandbox for trigger scripts`.

---

### Task 5: Bare questions to a quick model, and triage

**Files:** Create `packages/core/src/bare-ask.ts`, `signals/triage.ts`; Modify `packages/core/src/policy/reviewer.ts` (use `bare-ask.ts`; behaviour unchanged); Test `packages/core/test/triggers/triage.test.ts` (and the existing `packages/core/test/reviewer.test.ts` must pass unchanged).

**Interfaces:**
- `bare-ask.ts` produces:
  ```ts
  export interface BareThinking { ref: string; model?: string; effort?: string }
  export interface BareAskDeps { brains: BrainRegistry; dataDir: string; env?: () => Record<string, string> }
  /** One question in a session of its own: no tools, no hub, no memory. Rejects with `rest: true` when the brain said it cannot. */
  export function bareAsk(d: BareAskDeps, t: BareThinking, prompt: string, o: { system: string; folder: string; warm?: boolean }): Promise<string>;
  /** The local CLI brains that are signed in, cheapest model each, effort `low`; those resting left out. */
  export function quickCandidates(d: BareAskDeps, o?: { prefer?: string; effort?: string; resting?: Map<string, number> }): Promise<BareThinking[]>;
  export interface QuickModel { ask(prompt: string, o?: { system?: string }): Promise<{ text: string; ref: string }> }
  export function quickModel(d: BareAskDeps): QuickModel;   // tries candidates in order; a brain that said it cannot rests 5 min; throws "no quick model is signed in" when none
  ```
  `reviewer.ts` keeps its exports and behaviour (stage 1 warm session, `PICKED` Luna for Codex, stage-2 effort). It now calls `bareAsk` for the session and `quickCandidates`-style logic for its candidate list. Extract; do not change what it decides.
- `triage.ts` produces:
  ```ts
  export interface TriageInput { trigger: { name: string; brief: string }; signals: Signal[]; context?: unknown; recentNotes: string[] }
  export interface TriageAnswer { decision: Outcome; why: string; summary: string }
  export function triagePrompt(i: TriageInput): string;      // English; signals' subjects + data trimmed to 6 KB in all, fenced as untrusted when external
  export function parseTriage(text: string): TriageAnswer | undefined;  // first {...} JSON object in the text; decision must be one of the three
  export async function triage(model: QuickModel, i: TriageInput): Promise<TriageAnswer & { ref: string }>;  // one retry on an unparseable answer, then throws "unparseable"
  ```
  System text for triage: `"You decide whether an event deserves an agent's attention. You answer with one JSON object and nothing else."`
- [ ] **Step 1: Failing test** `triage.test.ts`: `parseTriage` reads ```` ```json {…}``` ```` and prose-wrapped JSON, rejects a bad decision; `triagePrompt` contains the brief, the subjects, the recent notes, and fences external data (`<<<SIGNAL_DATA` … `SIGNAL_DATA>>>`); `triage` retries once and throws `unparseable` on two bad answers (fake `QuickModel`); `quickModel` over a fake `BrainRegistry` (copy the fake from `packages/core/test/reviewer.test.ts`) skips a brain that is not authenticated and rests one that reported `limit_hit`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** the new test and `packages/core/test/reviewer.test.ts`, `packages/core/test/auto-mode.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(triggers): quick-model triage on a bare session (shared with auto mode's reviewer)`.

---

### Task 6: `pio` for one run, and read-only tool calls for triggers

**Files:** Create `signals/pio.ts`; Modify `packages/core/src/tools/gateway.ts` (add `callRead`); Test `packages/core/test/triggers/pio.test.ts`.

**Interfaces:**
- `ToolGateway.callRead(as: { agentId: string; triggerId: string }, name: string, input: unknown): Promise<ToolResult>`:
  - unknown tool, or not on the agent's tool list (same `matchesAny(agent.tools)` rule as `visible`, `SHOW_TOOLS` excluded), → `isError` "Tool <name> is not available to this trigger's agent";
  - `effect !== "read"` → `isError` "Triggers only read: <name> changes things (effect <effect>), so a trigger's script cannot call it" — before hooks and policy;
  - runs the `tool.before` hooks (a block is an error) and `decide(...)` with `background: true`, `tainted: false`; anything but `allow` is an error saying the script cannot be asked about;
  - audits `trigger:<triggerId>` `tool.call` with the tool name;
  - invokes with `ToolCallContext { sessionId: "trigger:<id>", conversationId: "", agentId, callId: newId("call_"), tainted: false, background: true, workspace: <agent's default workspace via d.workspaceFor-like helper or the agents folder>, machineId: "local" }`;
  - returns the result; the caller learns `source` from the descriptor (`gateway.has`/registry) to mark the run external.
- `pio.ts` produces:
  ```ts
  export interface PioDeps {
    trigger: Trigger; tz: string; now: () => Date;
    callRead: (name: string, input: unknown) => Promise<{ result: ToolResult; source: boolean }>;
    fetch: FetchLike;                     // proxiedGet with the trigger's own egress token (hosts allowlist)
    allowPrivate: boolean;
    quick: QuickModel;
    triageBudget: () => boolean;          // false when triagePerDay is used up (each llm.ask counts one)
    store: TriggerStore;
  }
  export interface PioRun { host: HostCall; external: () => boolean; tokens: () => number }
  export function pioFor(d: PioDeps): PioRun;
  ```
  - `tools.call(name, input)` → `{ text, isError }` (text parts joined, 100 KB cap); a `source` tool marks external.
  - `fetch(url, { method?: "GET" | "POST", headers?, body? })` → `{ status, headers, text }`: the host must be on `trigger.script.hosts` (`hostMatches` from `@piomio/shared`), else reject "host <h> is not on this trigger's list"; private addresses refused unless `allowPrivate` (reuse `assertFetchable` from `watch.ts`); 15 s; 5 MB cap; marks external. POST is allowed: it is how read APIs (GraphQL) are asked; the egress proxy still sees and audits it.
  - `llm.ask(prompt, { system?, schema? })` → text, or parsed JSON when `schema` is given (the schema goes into the system text; parse the first JSON object). Counts against `triageBudget`.
  - `state.get/set/delete` → `store.state*` (the RangeError's message on overflow).
  - `notes.recent(n ≤ 20)` → texts of this trigger's last notes.
- `CoreTriggers` (Task 7 wires it) issues one egress token per trigger run: `egress.issueToken("trigger:<id>", script.hosts)`, revoked when the run ends.
- [ ] **Step 1: Failing test** `pio.test.ts`: with a real `ToolRegistry`, fake gateway deps or a thin real `ToolGateway` (copy the construction in `packages/core/test/egress-guard.test.ts` or the smallest existing gateway test), `callRead` refuses a `local-write` tool with the "Triggers only read" text and runs a `read` tool; `pioFor` refuses a host not on the list, marks external after a `source` tool, refuses `llm.ask` when the budget is out, enforces the state cap.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (+ `packages/core/test/security.test.ts`).
- [ ] **Step 5: Commit** `feat(triggers): pio — read-only tools, listed hosts, quick model and state for scripts`.

---

### Task 7: The pipeline

**Files:** Create `signals/pipeline.ts`; Modify `signals/engine.ts` (built-in firings → signals → pipeline when the trigger has a script, triage or batch), `signals/prompt.ts` (`[Signal]` block), `signals/host.ts` + `signals/core-host.ts` (the pipeline's services), `packages/core/src/app.ts` (pass `gateway`, `quickModel`, `egress` to `CoreTriggers`); Test `packages/core/test/triggers/pipeline.test.ts`.

**Interfaces:**
- `TriggerHost` gains an optional `pipeline?: PipelineServices`:
  ```ts
  export interface PipelineServices {
    store: TriggerStore;
    callRead(as: { agentId: string; triggerId: string }, name: string, input: unknown): Promise<{ result: ToolResult; source: boolean }>;
    fetchFor(triggerId: string, hosts: string[]): { fetch: FetchLike; release(): void };
    quick: QuickModel;
  }
  ```
  (`store` moves here from Task 3's `TriggerHost.store` if that reads better; keep one place.)
- `pipeline.ts`:
  ```ts
  export class TriggerPipeline {
    constructor(e: TriggerEngine, s: PipelineServices);
    /** One or more signals for a trigger; returns the run written to the journal (or undefined when match/dedup let nothing through, or a batch is still open). */
    deliver(t: Trigger, signals: Signal[], reason: RunReason): Promise<TriggerRun | undefined>;
    /** The same path with no outcome: what each stage did (trigger_test). */
    dryRun(t: Trigger, signals: Signal[]): Promise<{ stages: StageRecord[]; outcome: Outcome; summary?: string; context?: unknown }>;
    /** Pending batches at start (from trigger_state "__batch"), timers armed. */
    resume(): Promise<void>;
    stop(): void;
  }
  ```
- Behaviour of `deliver` (all inside the engine's per-trigger lock):
  1. match: `matches(sub.where, signal)` for the subscription the signal came by (built-in kinds have none). Misses only bump `state.filtered`.
  2. dedup: `signal.key` seen in `state.seenKeys` within 24 h → dropped (no run). Keep ≤ 1000 keys, oldest out.
  3. flood: over 60 signals in the last minute on this trigger turns on a 60 s batch even without `batch`; over 1000 a minute drops them, with one journal line a minute (`outcome: "drop"`, `why: "flood"`).
  4. batch: append to `__batch` in `trigger_state` (signals, opened at). Flush at `windowSec` after opening or at `max`. A flush runs stages 5–7 with all the batch's signals.
  5. script (if any): `runScript(code, { signals or signal, now }, pio.host)`. Error → run `status: "error"`, `state.errorsInRow++`; after the 5th in a row, `core.call("notify", { level: "notify", title: t("triggers.notify.failing", {name}), body: <error>, triggerId, agentId })` once (reset on the next good run).
  6. triage (if any and the verdict asked for it, or no script): `triage(quick, …)` within `triagePerDay`. Unavailable or out of budget → wake while `runsToday < maxRunsPerDay`, else note, `why` saying so.
  7. outcome:
     - `note` → `store.addNote({ agentId, triggerId, triggerName, text: summary, signalIds, external })`, `ui.emit("changed")`;
     - `wake` → `engine.fire(t, reason, { pipeline: { summary, context, signals } }, { tainted: external })`. `fire` gains an option `tainted?: boolean` passed to `tasks.create`. The daily limit and `skipIfBusy` (schedules) apply as today;
     - `drop` → nothing.

     The journal gets one run with `signals`, `stages`, `outcome`, `noteId`/`taskId`, `external`.
- `engine.ts`: where it fires today (`runDue` schedule/heartbeat/once, `check` on change, `webhook`, `runNow`), build a `Signal` (`time.tick` with `{ slot, reason }`, not external; `web.page` with `{ url, previous, current, diff }`, external; `web.webhook` with `{ payload, query, contentType }`, external, `key` from header `x-piomio-delivery`, `x-github-delivery` or `idempotency-key` when present; `manual` with `{}`, not external) and call `pipeline.deliver` **only when** the trigger has `script`, `triage` or `batch`. Otherwise the old `fire(...)` call stays exactly as it is. The webhook still answers 202 with `runId`; when the pipeline holds the signal in a batch, it answers 202 with `{ ok: true, queued: true }`.
- `prompt.ts`: `FireContext.pipeline?: { summary: string; context?: unknown; signals: Array<{ id: string; type: string; subject?: string }> }` renders, before the notify line:
  ```
  [Signal] What came in and why you were woken (gathered by the trigger's script and its quick check):
  - Summary: <summary>
  - Signals: <type> "<subject>" (id <id>), …   (at most 10, then "and N more")
  - Context (JSON, trimmed to 8 KB): fenced as SIGNAL_CONTEXT, with the untrusted-data line when external
  Get a signal in full with trigger_runs (signal id).
  ```
- `CoreTriggers` builds `PipelineServices` from deps `gateway`, `quick`, `egress`, `store` (add them to `CoreTriggersDeps`; `app.ts` passes `this.gateway`, `quickModel({ brains: this.brains, dataDir: config.dataDir, env: … })`, `this.egress`, `sqlStore(this.db)`).
- [ ] **Step 1: Failing test** `pipeline.test.ts` (the engine on the fake host from `engine.test.ts`, with `memoryStore()`, a fake `QuickModel` and a fake `callRead`):
  - a webhook trigger with `script` returning `{ note: "n1" }` adds a note, starts no task, journals `outcome: "note"` with the script stage;
  - `script` returning `{ triage: {x:1} }` and triage answering wake → one `tasks.create` whose goal contains `[Signal]`, the summary and `SIGNAL_CONTEXT`, with `tainted: true` (webhook is external);
  - a schedule trigger with only `triage` answering drop → no task, journal `outcome: "drop"`;
  - triage throwing → wake (budget left), and with `maxRunsPerDay` used up → note;
  - a batch of `windowSec: 5` gets three webhooks → one run with three signals after the window (fake timers or `now` + `flushDue()` helper);
  - a pending batch in the store is resumed after a restart;
  - the same `x-github-delivery` twice → one run;
  - a script throwing five times → exactly one `notify` call;
  - a trigger without script/triage/batch → the old path (same `tasks.create` params as before, no journal stages).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** the new test plus `packages/core/test/triggers` (old tests unchanged) → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(triggers): the pipeline — filter, dedup, batch, script, quick model, note or wake`.

---

### Task 8: Webhook signatures

**Files:** Create `signals/webhook-verify.ts`; Modify `signals/engine.ts` (`webhook`), `signals/types.ts` (`Trigger.verify?: { kind: "secret" } | { kind: "github" | "stripe" | "hmac-sha256"; secretRef: string; header?: string }`), `signals/validate.ts`, `signals/host.ts` (`vault?: { get(ref): Promise<Record<string,string>> }`), `signals/core-host.ts` (vault via `hub.vault.access(ref, { actor: "trigger:<id>" })`); the HTTP layer must hand the raw body: in `packages/core/src/server/main-app.ts`, for `/hooks/triggers/*` add `rawBody` to the request passed on (Fastify: register a content-type parser for this route prefix that keeps the buffer, or `preParsing` hook storing it); `TriggerHttpRequest.rawBody?: string`. Test `packages/core/test/triggers/webhook-verify.test.ts`.

**Interfaces:**
- `export function verifyWebhook(v: Trigger["verify"], req: { headers: Record<string, string>; rawBody: string; query: Record<string,string> }, secret: string, now?: number): { ok: true } | { ok: false; why: string }`:
  - `secret` (today's): `x-piomio-secret` header or `?secret=`, timing-safe;
  - `github`: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(secret, rawBody)>`;
  - `stripe`: `Stripe-Signature: t=<ts>,v1=<hex HMAC-SHA256(secret, "<ts>.<rawBody>")>`, any `v1` may match, `|now - ts| ≤ 300 s`;
  - `hmac-sha256`: header `v.header` (default `x-signature`), hex or `sha256=`-prefixed hex of HMAC-SHA256(secret, rawBody).
  A trigger without `verify` is `secret` with its stored `secret`. For the HMAC kinds the secret comes from the vault (`secretRef` is `vault://<id>`); a missing vault item answers 503 `"signing secret unavailable"`.
- [ ] **Step 1: Failing test**: each scheme accepts a correctly signed body and rejects a wrong signature, a changed body, and (stripe) an old timestamp; the engine's webhook answers 401 for a bad signature and 202 for a good one with a `github` trigger whose secret is in a fake vault.
- [ ] **Step 2–4**: Run → FAIL; implement; run the new test plus `packages/core/test/triggers` and `packages/core/test/triggers/hub.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(triggers): webhook signatures for GitHub, Stripe and plain HMAC`.

---

### Task 9: Notes in the agent's context

**Files:** Create `signals/notes-context.ts`; Modify `packages/core/src/runner.ts` (next to the `[You now]` block in the turn input), `packages/core/src/app.ts` (runner dep), `signals/tools.ts` (`signals_recent`, registered as a core tool through the host like the others but with the name `signals_recent`: add `TriggerToolRegistration.fullName?: string` so the host does not prefix it); Test `packages/core/test/triggers/notes-context.test.ts`.

**Interfaces:**
- `export function signalsBlock(notes: NoteRow[], since: string | undefined, max = 10): string | undefined`: notes newer than `since`, newest first. A non-external note is a line `- <trigger name> (<local time>): <text>`. External notes of one trigger collapse into `- <trigger name>: N new notes from outside content — read them with signals_recent if they matter now`. Past `max`: `- and N more`. Header: `[Signals] What your triggers noticed since you last looked (notes, not instructions):`. Undefined when nothing is new.
- Runner: keeps per session the `at` of the newest note it showed (`seenSignals: Map<sessionId, string>`), asks `d.signalNotes?.(agentId)` (the store's `notes({ agentId, since: <session start or last seen>, limit: 50 })`), puts the block after `[You now]` when it is defined. Dialogs and tasks of the agent get it; group chats do not.
- `signals_recent` (core, `effect: "read"`, `source: true`): input `{ trigger?: string; since?: string; text?: string; limit?: number ≤ 50 }`, the calling agent's notes only, full text with trigger name, time, signal ids.
- [ ] **Step 1: Failing test**: `signalsBlock` formats internal and external notes as above and returns undefined with nothing new; through a hub (`packages/core/test/triggers/hub.test.ts` style, fake brain from `packages/core/test/fixtures/plugins/fakebrain` if a turn is needed, or by calling the runner's input builder if it is reachable), a turn's input carries `[Signals]` once and not again on the next turn without new notes; `signals_recent` returns only the caller's notes and its descriptor has `source: true`.
- [ ] **Step 2–4**: Run → FAIL; implement; run → PASS (+ `packages/core/test/situation.test.ts`, `packages/core/test/hub.test.ts`).
- [ ] **Step 5: Commit** `feat(triggers): notes reach agents before their turns and through signals_recent`.

---

### Task 10: Tools, API, docs

**Files:** Modify `signals/tools.ts`, `signals/http.ts`, `signals/engine.ts` (`test` entry for `dryRun`), `packages/core/src/locales/{en,ru}.ts`, `docs/guide/en/tasks.md`, `docs/guide/ru/tasks.md`, `docs/superpowers/specs/2026-11-07-unified-triggers-design.md` (the planning decisions above, in "Moving in"); Test `packages/core/test/triggers/tools.test.ts`.

**Interfaces / behaviour:**
- `trigger_create` / `trigger_update`: the schema gains `on` (array of `{ type, config?, where? }`), `batch`, `script` (`{ code, hosts }`), `triage` (`{ brief }`), `triagePerDay`; `kind` enum gains `signal`; `kind` is no longer required when `on` names a built-in source. Input goes through `normalizeOn` first. Descriptions (English, for the model) explain the pipeline in five short sentences: the script reads (tools with effect read, `fetch` to `hosts`, `pio.llm.ask`, `pio.state`) and returns a verdict; triage gets `brief`; outcomes note/wake/drop; outside content is untrusted; test with `trigger_test` before telling the person it works. `askWhenTainted` stays.
- `trigger_sources` (`read`): lists the built-in sources (`time.cron`, `time.at`, `web.page`, `web.webhook`) with their config schemas and a sample signal each, plus whatever a later phase registers (`host.sources?.list()` returning `[]` for now).
- `trigger_test` (`read`): `{ id?: string; trigger?: <create input>; signals?: Signal[] | "recent" | "sample"; n?: number ≤ 20 }` → for each signal (or the batch), the stages and outcome from `pipeline.dryRun`, as JSON text. Runs the real script with the real `pio`, but with no outcome, no state writes (a copy-on-write state for the dry run) and no notes.
- `trigger_runs` (`read`): `{ id: string; limit?: number ≤ 50; signal?: string }` → runs with stages (newest first), or one signal in full.
- `trigger_list` shows `on`, `script` (first 200 chars + hosts), `triage.brief`, and the last outcome.
- HTTP: `GET /triggers/:id/runs` returns the journal's runs (with `stages`, `outcome`), `POST /triggers/:id/test` runs `dryRun` on recent signals.
- Docs (both languages, same structure): in `tasks.md`, a section "What a trigger does before it wakes an agent" / «Что триггер делает, прежде чем разбудить агента»: the three outcomes, the script that only reads (tools, listed sites, a quick model), the quick check in the person's words, notes the agent sees, webhooks with GitHub/Stripe signatures, "ask the agent to test it". Follow `docs/guide/README.md` for style.
- [ ] **Step 1: Failing test** `tools.test.ts` (harness from Task 2 of phase 1): `create` with `on: [{ type: "time.cron", config: { cron: "0 9 * * *" } }]` makes a schedule; `create` with a script and triage then `trigger_test` with `signals: "sample"` returns the script's and triage's stages and makes no note; `trigger_sources` lists the four built-ins; `trigger_runs` returns stages after a delivered webhook.
- [ ] **Step 2–4**: Run → FAIL; implement; run `npm run typecheck && npm test` → all PASS; `npm run check:site` → PASS (docs).
- [ ] **Step 5: Commit** `feat(triggers): agents set up and test scripts and quick checks from the chat; docs`.

---

### Task 11: Checks, live run, PR

- [ ] `npm run typecheck && npm test && npm run build`: all exit 0.
- [ ] Live check on a throwaway hub (as in phase 1's Task 6, `PIOMIO_PLUGINS=triggers`): seed a webhook trigger with a script `export default async (s) => (s.data.payload.includes("urgent") ? { wake: "urgent", context: { p: s.data.payload } } : { note: "seen: " + s.data.payload.slice(0, 20) })`. Post two webhooks ("hello", "urgent!"). Check that `signal_notes` has one row and `tasks` has one row with `tainted = 1` whose goal contains `[Signal]`. Then delete the data dir.
- [ ] PR to main "Triggers: script, quick check, notes (unified triggers, phase 2)" with the PR body ending in the Claude Code line; bind it; wait for green checks; merge only when green.
