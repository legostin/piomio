# Unified Triggers, Phase 3: Signals from Plugins and from the Hub — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any plugin can declare the signals it produces in its manifest and emit them, or provide them on subscription. The hub's own events are sources too. A trigger subscribes to any of them with `on` (kind `signal`, or alongside a built-in kind).

**Architecture:** A `SignalSources` registry in core (`packages/core/src/signals/sources.ts`) knows every source: the built-ins (`time.*`, `web.*`), the hub's (`hub.*`, mapped from the bus), and each running plugin's (`<pluginId>.<type>` from `contributes.signals`). It keeps the live subscriptions: one per distinct `(type, config)` among enabled triggers. It routes each incoming signal to the triggers listening, through `TriggerPipeline.deliver` (phase 2). Plugins talk to it over their RPC peer: `signals.emit` (plugin → hub), `signals.subscribe` / `signals.stop` (hub → plugin).

**Tech Stack:** as phases 1–2; `ajv` (already in core) validates signal data against the declared schema.

Spec: `docs/superpowers/specs/2026-11-07-unified-triggers-design.md`, section 1.

## Global Constraints

- A plugin can emit only types declared in its manifest; the hub exposes them as `<pluginId>.<type>`; `data` ≤ 256 KB and valid against the declared `data` schema (when it has one), else the emit is refused with an English error the plugin logs.
- `external` defaults to true for plugin sources; the hub's sources are not external.
- `mode: "broadcast"` sources are emitted whenever something happens; `mode: "subscribe"` sources do work only while some enabled trigger subscribes: `subscribe` once per distinct `(type, canonical JSON of config)`, `stop` when no enabled trigger uses it, and again on the plugin's restart.
- Plugins only `import type` from `@piomio/plugin-sdk`; the runner provides the implementation. Contracts change deliberately in `packages/shared/src/manifest.ts` and `packages/plugin-sdk/src/types.ts`.
- `integrations/_template`, its `SKILL.md` (the agents' `make-integration` skill) and `integrations/README.md` stay in step with the plugin API: they show a signal source.
- The catalog strings of a source (`title`) go through the plugin's locales (`"%key%"`); `description` is English, for the model.
- Everything from phases 1–2 keeps working; their tests pass unchanged.
- Docs: `docs/guide/{en,ru}/plugins.md` (writing a source) and `tasks.md` (what can start a trigger) in the same PR.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: The manifest and the SDK contract

**Files:** Modify `packages/shared/src/manifest.ts` (`contributes.signals`; drop the unused `contributes.triggers` with a schema that still accepts and ignores it so old manifests parse), `packages/plugin-sdk/src/types.ts` (`PluginContext.signals`), `packages/shared/src/index.ts` (export the new types); Test `packages/shared/src/manifest-signals.test.ts`.

**Interfaces:**
```ts
// manifest.ts
export const SignalDeclSchema = z.object({
  type: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  mode: z.enum(["broadcast", "subscribe"]).default("broadcast"),
  title: z.string().min(1),                 // "%key%" in the plugin's locales
  description: z.string().min(1).max(1000), // English, for the model
  data: z.record(z.string(), z.unknown()).optional(),    // JSON Schema of data
  config: z.record(z.string(), z.unknown()).optional(),  // JSON Schema of a subscription's config (subscribe mode)
  sample: z.unknown().optional(),
  external: z.boolean().default(true),
});
export type SignalDecl = z.infer<typeof SignalDeclSchema>;
// contributes.signals: z.array(SignalDeclSchema).default([])

// plugin-sdk types.ts
export interface SignalSubscription { id: string; config: Record<string, unknown> }
export interface SignalEmitOptions { key?: string; subject?: string }
export interface SignalProvider { subscribe(sub: SignalSubscription, emit: (data: unknown, o?: SignalEmitOptions) => void): { stop(): void } | Promise<{ stop(): void }> }
// PluginContext.signals:
signals: {
  /** A broadcast signal of a declared type. */
  emit(type: string, data: unknown, o?: SignalEmitOptions): void;
  /** The provider of a declared subscribe-mode type. */
  provide(type: string, p: SignalProvider): void;
};
```
- [ ] Failing test: a manifest with two signals parses with defaults (`mode`, `external`); a bad `type` is rejected; a manifest with the old `contributes.triggers: ["x"]` still parses. Run → FAIL; implement; run → PASS; `npm run typecheck`; commit `feat(sdk): plugins declare the signals they produce`.

### Task 2: The runner, the host and the registry

**Files:** Modify `packages/plugin-sdk/src/runner.ts` (implement `ctx.signals`: `emit` → `peer.request("signals.emit", { type, data, key, subject })`; keep providers; handle `signals.subscribe {id, type, config}` by calling the provider with an `emit` that sends `signals.emit` with `subscription: id`; handle `signals.stop {id}`), `packages/core/src/plugins/host.ts` (handle `signals.emit`: deny undeclared types; forward to `d.signals?.fromPlugin(pluginId, msg)`; on plugin start, `d.signals?.pluginUp(pluginId)`, on stop `pluginDown`), create `packages/core/src/signals/sources.ts`, modify `packages/testkit/src/plugin-harness.ts` (`signals` emitted by the plugin recorded; `subscribeSignal(type, config)` / `stopSignal(id)` to drive providers), `packages/core/src/signals/core-host.ts` and `app.ts` (create the registry, give it to the host and to the engine's `trigger_sources`, and pass `TriggerPipeline.deliver` as its sink); Test `packages/core/test/triggers/sources.test.ts`, `packages/testkit` harness test if one exists for events.

**Interfaces:**
```ts
// sources.ts
export interface SourceInfo { type: string; source: string; mode: "broadcast" | "subscribe"; title: string; description: string; config?: unknown; data?: unknown; sample?: unknown; external: boolean; online: boolean }
export interface SourceSink { deliver(triggerId: string, signals: Signal[], reason: "signal"): Promise<unknown> }
export class SignalSources {
  constructor(d: { plugins: { declared(): Array<{ pluginId: string; decls: SignalDecl[]; running: boolean; title(key: string): string }>; subscribe(pluginId: string, id: string, type: string, config: unknown): Promise<void>; stop(pluginId: string, id: string): Promise<void> }; triggers: () => Trigger[]; sink: SourceSink; bus: EventBus; now?: () => number });
  list(locale?: Locale): SourceInfo[];                       // built-ins + hub.* + plugins'
  /** Recompute live subscriptions from the enabled triggers (after create/update/delete/enable, plugin up/down). */
  sync(): Promise<void>;
  fromPlugin(pluginId: string, m: { type: string; data: unknown; key?: string; subject?: string; subscription?: string }): { ok: true } | { ok: false; error: string };
  pluginUp(pluginId: string): Promise<void>;
  pluginDown(pluginId: string): void;
  start(): void; stop(): void;                              // hub.* bus listeners
}
```
- Routing: a broadcast signal of type T goes to every enabled trigger with an `on` entry of type T (each entry's `where` checked by the pipeline). A subscribe-mode signal goes only to the triggers whose entry has the same canonical config as the subscription it came by.
- `RunReason` gains `"signal"` (prompt reason text: "a signal arrived from <source>").
- The engine calls `sources.sync()` after create, update, delete, enable/disable and at boot (`TriggerHost.sources?: { list, sync }`).
- [ ] Failing tests (`sources.test.ts`, fake plugins object + fake sink): an undeclared type is refused; data over 256 KB or against its schema is refused; a broadcast reaches two subscribed triggers and not a third; two triggers with the same config share one plugin subscription, and deleting one keeps it while deleting both stops it; `pluginUp` re-subscribes; `list()` includes the four built-ins with `online: true`, the plugin's with `online` following `running`. Plus an end-to-end test with the testkit harness on a tiny fixture plugin (`packages/core/test/fixtures/signal-plugins/pinger`) whose `provide("ping")` emits once per subscribe, through a real hub (`PIOMIO_PLUGINS=triggers,pinger`): a `signal` trigger on `pinger.ping` with a script returning `{ note: "pong" }` ends with a note.
- [ ] Run → FAIL; implement; run → PASS (+ `packages/core/test/triggers`, `packages/core/test/hub.test.ts`); typecheck; commit `feat(triggers): plugins emit and provide signals; the hub routes them to triggers`.

### Task 3: The hub's own sources

**Files:** Modify `packages/core/src/signals/sources.ts` (hub sources), `packages/core/src/locales/{en,ru}.ts` (`triggers.source.hub.<name>` titles); Test `packages/core/test/triggers/hub-sources.test.ts`.

**Sources (all broadcast, not external), from bus events:**
| type | from | data |
|---|---|---|
| `hub.task.finished` | `task.updated` with status `done` | `{ taskId, agentId, title, result (≤ 2 KB) }` |
| `hub.task.failed` | `task.updated` with status `failed` | `{ taskId, agentId, title, error }` |
| `hub.machine.online` / `hub.machine.offline` | `machine.status` (or the bus event machines.ts emits; read it) | `{ machineId, name }` |
| `hub.location.changed` | the user-location update (`user-location.ts`) | `{ place, lat, lon, at }` (only what the hub already keeps) |
| `hub.library.file` | a file added to an agent's library (`library.ts` event, or the attachment save) | `{ agentId, name, kind, path }` |
| `hub.feed.post` | `feed.post` | `{ feedId, title, url? }` |
| `hub.approval.waiting` | `approval.created` | `{ approvalId, agentId, summary }` |

Each has `key` (the task id + status, the machine id + state + minute, …) so repeats are deduped. A trigger's own wake task finishing must not wake it again: `hub.task.*` signals for tasks whose `triggerId` is the receiving trigger are dropped before delivery.
- [ ] Failing test per source (emit the bus event, see `deliver` called with the right signal), plus the self-loop guard. Run → FAIL; implement; run → PASS; commit `feat(triggers): the hub's own events as signals`.

### Task 4: A reference source, the template, the docs

**Files:** Modify `plugins/web/.piomio-plugin/plugin.json` (`contributes.signals`: `rss_item`, subscribe mode, config `{ url, intervalMinutes? ≥ 10 }`, data `{ feed, title, link, published, summary }`), `plugins/web/server/*` (a provider that polls the feed with the existing `web_rss` code, remembers seen item ids in `ctx.storage`, emits new ones with `key` = item id, first poll is a baseline), `plugins/web/.piomio-plugin/locales/{en,ru}.json`, `integrations/_template/.piomio-plugin/plugin.json` + `server/index.ts` (an example broadcast signal `sun.changed` is not natural; add a subscribe source `sunrise` that emits once a day at local sunrise for the configured place: shows `provide`), `integrations/_template/SKILL.md` (a "Signals" section: when to declare one, broadcast vs subscribe, key/subject, data schema, external), `integrations/README.md` + `README.ru.md`, `docs/guide/{en,ru}/plugins.md`, `docs/guide/{en,ru}/tasks.md`; Tests `plugins/web/test/rss-signal.test.ts`, `integrations/_template/test/sun.test.ts` (extended).
- [ ] Failing tests: the rss provider with a local feed server: baseline on first poll, one signal per new item afterwards, none for a seen id; the template's provider emits with the configured place. Run → FAIL; implement; run → PASS; `npm run check:site`; commit `feat(triggers): RSS items as a signal source; the integration template shows a source`.

### Task 5: Checks, live run, PR

- [ ] `npm run typecheck && npm test && npm run build`.
- [ ] Live: throwaway hub with `PIOMIO_PLUGINS=triggers,web`, a `signal` trigger on `web.rss_item` for a local feed served by `python3 -m http.server` from a temp dir; add an item; see a note. Delete the data dir and the temp dir.
- [ ] PR "Triggers: signals from plugins and the hub (unified triggers, phase 3)"; green checks; merge.
