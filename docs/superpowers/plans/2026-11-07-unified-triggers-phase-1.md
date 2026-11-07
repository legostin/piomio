# Unified Triggers, Phase 1: the Engine Moves into Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run today's trigger engine (schedules, once, heartbeat, page watches, webhooks) inside the hub core instead of the `triggers` plugin process, with no change anyone can see. The phases after it then build on core services directly.

**Architecture:** The engine's files move from `plugins/triggers/server/` to `packages/core/src/signals/` almost unchanged. They depend on a small `TriggerHost` interface, the part of the plugin context they used. `CoreTriggers` (`signals/core-host.ts`) implements that host on hub services: `plugin_kv` rows under `triggers` (where the data already is), core calls, the bus, the tool registry and the egress proxy. The hub starts it on `lead()` and stops it on `standby()`/`stop()`. The plugin stays as a UI-only plugin: its page, its settings form and its on/off switch. Core serves its old HTTP API and webhook addresses.

**Tech Stack:** Node ≥ 24.5 (TypeScript by type stripping), vitest, Fastify (existing routes), `node:sqlite` (existing `Db`), croner, node-html-parser, Node's built-in `http.Agent({ proxyEnv })`.

Spec: `docs/superpowers/specs/2026-11-07-unified-triggers-design.md` (phase 1 in "Moving in" and "Phases").

## Global Constraints

- Node runs TypeScript directly: import local files with the `.ts` extension; erasable syntax only (no enums, no parameter properties, no namespaces); `import type` for types (`verbatimModuleSyntax`).
- Behaviour is unchanged: same tool names (`trigger_create`, `trigger_list`, `trigger_update`, `trigger_delete`, `trigger_run_now`), same tool descriptions and schemas, same HTTP API at `/api/plugins/triggers/http/*`, same webhook URLs `/hooks/triggers/<id>`, same stored data (`plugin_kv`, `plugin_id = 'triggers'`, keys `trigger:<id>`, `runs:<id>`, `initialized`).
- Every user-facing string goes through a catalog. Core catalogs `packages/core/src/locales/{en,ru}.ts` keep identical keys (checked by `packages/core/test/i18n.test.ts`). Text for the model, code and comments stay English.
- The engine runs only on the leading replica and only while the Triggers card exists, is on, and the hub's `PIOMIO_PLUGINS` filter lets `triggers` in (`"all"`, or a list that names it).
- Watch page loads keep going through the hub's egress proxy (audited), as the plugin process's did, with loopback hosts direct (`NO_PROXY=127.0.0.1,localhost,::1`), as before.
- Tests write temp files only under `tmpdir()`. No docs/guide change: nothing visible changes in this phase.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Changes reach main only through a PR with green `typecheck`, `test`, `site`, `panel-layout`; never push main.

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/plugins/kv.ts` (new) | `pluginKv(db, pluginId)`: read/write `plugin_kv` rows, shared by the plugin host and core. |
| `packages/core/src/plugins/host.ts` (modify) | Use `pluginKv`; `onSettings(id, cb)` so core hears the Triggers card's settings. |
| `packages/core/src/signals/host.ts` (new) | `TriggerHost`, `TriggerHttpRequest`, `TriggerHttpResponse`, `TriggerToolRegistration`, `FetchLike`. |
| `packages/core/src/signals/{engine,errors,http,prompt,schedule,tools,types,validate,watch,when}.ts` (moved) | The engine as it was, importing `TriggerHost` instead of `PluginContext`. |
| `packages/core/src/signals/index.ts` (new) | `startTriggers(host)`: the plugin's old `activate`. |
| `packages/core/src/signals/net.ts` (new) | `proxiedGet(proxyUrl)`: a GET through the egress proxy, for the watch. |
| `packages/core/src/signals/core-host.ts` (new) | `CoreTriggers`: the host on hub services; start/stop/sync; HTTP entry. |
| `packages/core/src/server/plugin-http.ts` (new) | `pluginHttp(hub, id, req)` and `hasPluginHttp(hub, id)`: the Triggers card's HTTP goes to core. |
| `packages/core/src/app.ts`, `server/api.ts`, `server/main-app.ts` (modify) | Wire `CoreTriggers`; route through `pluginHttp`. |
| `packages/core/src/locales/{en,ru}.ts` (modify) | `triggers.*` keys the engine uses. |
| `plugins/triggers/` (modify) | UI-only: manifest without server/tools/http, package.json without deps, locales without the moved keys. |
| `packages/core/test/triggers/*` (moved + new) | The engine's tests, an in-process harness, host and hub tests. |

---

### Task 1: `pluginKv` and settings listeners in the plugin host

**Files:**
- Create: `packages/core/src/plugins/kv.ts`
- Modify: `packages/core/src/plugins/host.ts` (the `storage.*` handlers near line 553; `setSettings` near line 683)
- Test: `packages/core/test/plugin-kv.test.ts`

**Interfaces:**
- Produces: `pluginKv(db: Db, pluginId: string): PluginKv` with `get(key): unknown` (null when missing), `set(key, value): void`, `delete(key): void`, `list(prefix?: string): Array<{ key: string; value: unknown }>`; `PluginHost.onSettings(id: string, cb: (settings: Record<string, unknown>) => void): () => void`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/plugin-kv.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { pluginKv } from "../src/plugins/kv.ts";

describe("plugin key-value storage", () => {
  it("keeps JSON values per plugin", () => {
    const db = openDb(":memory:");
    const a = pluginKv(db, "triggers");
    const b = pluginKv(db, "memory");
    a.set("trigger:t_1", { id: "t_1", state: { n: 1 } });
    b.set("trigger:t_1", "other plugin");
    expect(a.get("trigger:t_1")).toEqual({ id: "t_1", state: { n: 1 } });
    expect(b.get("trigger:t_1")).toBe("other plugin");
    expect(a.get("missing")).toBeNull();
    a.set("trigger:t_1", { id: "t_1", state: { n: 2 } });
    expect(a.get("trigger:t_1")).toEqual({ id: "t_1", state: { n: 2 } });
    a.delete("trigger:t_1");
    expect(a.get("trigger:t_1")).toBeNull();
    expect(b.get("trigger:t_1")).toBe("other plugin");
  });

  it("lists by an exact prefix, in key order", () => {
    const db = openDb(":memory:");
    const kv = pluginKv(db, "triggers");
    kv.set("runs:t_2", [2]);
    kv.set("trigger:t_2", { id: "t_2" });
    kv.set("trigger:t_1", { id: "t_1" });
    kv.set("a_b", 1);
    kv.set("axb", 2);
    expect(kv.list("trigger:").map((r) => r.key)).toEqual(["trigger:t_1", "trigger:t_2"]);
    // "_" and "%" in a prefix are literal, not LIKE wildcards.
    expect(kv.list("a_").map((r) => r.key)).toEqual(["a_b"]);
    expect(kv.list().length).toBe(5);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/test/plugin-kv.test.ts`
Expected: FAIL, `Failed to load url ../src/plugins/kv.ts` (or "Cannot find module").

- [ ] **Step 3: Write `packages/core/src/plugins/kv.ts`**

```ts
// A plugin's key-value storage (table plugin_kv): what ctx.storage reads and writes, and what core reads for work that
// moved from a plugin into core (signals/core-host.ts keeps the triggers where the plugin kept them).

import type { Db } from "../db.ts";

export interface PluginKv {
  /** The stored value, or null when there is none. */
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  /** Rows whose key starts with `prefix` ("_" and "%" are literal), in key order. */
  list(prefix?: string): Array<{ key: string; value: unknown }>;
}

export function pluginKv(db: Db, pluginId: string): PluginKv {
  return {
    get(key) {
      const r = db.prepare("select value from plugin_kv where plugin_id = ? and key = ?").get(pluginId, key) as { value: string } | undefined;
      return r ? JSON.parse(r.value) : null;
    },
    set(key, value) {
      db.prepare("insert into plugin_kv(plugin_id, key, value) values (?,?,?) on conflict(plugin_id, key) do update set value = excluded.value").run(
        pluginId,
        key,
        JSON.stringify(value ?? null),
      );
    },
    delete(key) {
      db.prepare("delete from plugin_kv where plugin_id = ? and key = ?").run(pluginId, key);
    },
    list(prefix = "") {
      const pattern = `${prefix.replace(/[\\%_]/g, "\\$&")}%`;
      const rows = db.prepare("select key, value from plugin_kv where plugin_id = ? and key like ? escape '\\' order by key").all(pluginId, pattern) as Array<{
        key: string;
        value: string;
      }>;
      return rows.map((r) => ({ key: r.key, value: JSON.parse(r.value) }));
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/test/plugin-kv.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Use it in the plugin host**

In `packages/core/src/plugins/host.ts`, add the import next to the other local imports:

```ts
import { pluginKv } from "./kv.ts";
```

Replace the whole block that starts with `const kv = this.d.db;` and ends with the `storage.list` handler's closing `});` (four handlers: `storage.get`, `storage.set`, `storage.delete`, `storage.list`) with:

```ts
    const kv = pluginKv(this.d.db, id);
    peer.handle("storage.get", (p: { key: string }) => kv.get(p.key));
    peer.handle("storage.set", (p: { key: string; value: unknown }) => {
      kv.set(p.key, p.value);
      return {};
    });
    peer.handle("storage.delete", (p: { key: string }) => {
      kv.delete(p.key);
      return {};
    });
    peer.handle("storage.list", (p: { prefix?: string }) => kv.list(p.prefix ?? ""));
```

- [ ] **Step 6: Add settings listeners**

In the `PluginHost` class, next to its other private fields, add:

```ts
  /** Core work that belongs to a plugin's card hears its settings change (signals/core-host.ts). */
  private settingsListeners = new Map<string, Set<(settings: Record<string, unknown>) => void>>();
```

Above `setSettings`, add:

```ts
  /** Hear a plugin's settings change; returns the way to stop hearing it. */
  onSettings(id: string, cb: (settings: Record<string, unknown>) => void): () => void {
    let set = this.settingsListeners.get(id);
    if (!set) this.settingsListeners.set(id, (set = new Set()));
    set.add(cb);
    return () => void set.delete(cb);
  }
```

In `setSettings`, after the line `if (r && !r.peer.closed) r.peer.notify("settings.changed", { settings });`, add:

```ts
    for (const cb of this.settingsListeners.get(id) ?? []) cb(settings);
```

- [ ] **Step 7: Run the plugin tests and typecheck**

Run: `npx vitest run packages/core/test && npm run typecheck`
Expected: all PASS (the hub tests start fixture plugins through the changed storage handlers); typecheck prints nothing and exits 0.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/plugins/kv.ts packages/core/src/plugins/host.ts packages/core/test/plugin-kv.test.ts
git commit -m "refactor: plugin_kv access in one place, settings listeners on the plugin host

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The engine's code and tests in core; the plugin keeps only its UI

**Files:**
- Move: `plugins/triggers/server/{engine,errors,http,prompt,schedule,tools,types,validate,watch,when}.ts` → `packages/core/src/signals/`
- Delete: `plugins/triggers/server/index.ts`
- Create: `packages/core/src/signals/host.ts`, `packages/core/src/signals/index.ts`
- Move: `plugins/triggers/test/{engine,schedule,watch,when,triggers}.test.ts` → `packages/core/test/triggers/`
- Create: `packages/core/test/triggers/harness.ts`
- Modify: `packages/core/package.json`, `plugins/triggers/package.json`, `plugins/triggers/.piomio-plugin/plugin.json`, `plugins/triggers/.piomio-plugin/locales/{en,ru}.json`, `packages/core/src/locales/{en,ru}.ts`, `package-lock.json`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `TriggerHost` (below), `TriggerHttpRequest`, `TriggerHttpResponse`, `TriggerToolRegistration`, `FetchLike` from `packages/core/src/signals/host.ts`;
  - `startTriggers(host: TriggerHost): Promise<TriggerEngine>` from `packages/core/src/signals/index.ts`;
  - `TriggerEngine` (class, unchanged API: `start`, `boot`, `stop`, `updateSettings`, `settings`, `list`, `get`, `create`, `update`, `remove`, `runNow`, `checkNow`, `webhook`, `onFeedback`, `removeAgent`) from `signals/engine.ts`;
  - core catalog keys `triggers.<key>` for every plugin key starting with `heartbeat.`, `notify.`, `when.`, `error.`.

- [ ] **Step 1: Move the files**

```bash
mkdir -p packages/core/src/signals packages/core/test/triggers
for f in engine errors http prompt schedule tools types validate watch when; do git mv plugins/triggers/server/$f.ts packages/core/src/signals/$f.ts; done
git rm -q plugins/triggers/server/index.ts
for f in engine schedule watch when triggers; do git mv plugins/triggers/test/$f.test.ts packages/core/test/triggers/$f.test.ts; done
```

- [ ] **Step 2: Write `packages/core/src/signals/host.ts`**

```ts
// What the trigger engine needs from where it runs: the part of a plugin's context it used when it was the triggers
// plugin. Core gives it one (core-host.ts); tests give it a fake. Keeping that shape lets the engine and its tests move
// unchanged (docs/superpowers/specs/2026-11-07-unified-triggers-design.md, phase 1).

import type { CoreMethod, Locale, Params, ToolCallContext, ToolResult, ToolSpec } from "@piomio/shared";

export interface TriggerHttpRequest {
  method: string;
  /** Path after /api/plugins/triggers/http (or /hooks/triggers for public requests), starting with "/". */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  /** True for unauthenticated public webhooks: the engine checks the trigger's secret itself. */
  public: boolean;
  /** Language of whoever made the request; the hub language for public webhooks. */
  locale: Locale;
}

export interface TriggerHttpResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface TriggerToolRegistration extends ToolSpec {
  /** Short name; the hub exposes it as `trigger_<name>`. */
  name: string;
  handler: (input: any, ctx: ToolCallContext) => Promise<ToolResult | string> | ToolResult | string;
}

/** A GET the watch makes (watch.ts fetchPage): the global fetch, or core's through the egress proxy (net.ts). */
export type FetchLike = (url: string, init: { redirect?: "manual"; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

export interface TriggerHost {
  /** "triggers": the webhook addresses (/hooks/triggers/<id>) and the UI events carry it. */
  pluginId: string;
  /** The hub's own address, for webhook URLs when it has no public one. */
  hubUrl: string;
  /** The Triggers card's settings (allowPrivateUrls, watchTimeoutSec). */
  settings: Record<string, any>;
  onSettingsChange(cb: (settings: Record<string, any>) => void): void;
  i18n: {
    /** The hub language. */
    locale(): Locale;
    /** The engine's message `key` in `locale` (default: the hub language). */
    t(key: string, params?: Params, locale?: Locale): string;
  };
  log: { debug(...a: unknown[]): void; info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  tools: { register(tool: TriggerToolRegistration): void };
  events: { on(name: "notification.feedback" | "agent.removed", cb: (payload: any) => void): void };
  http: { handle(handler: (req: TriggerHttpRequest) => Promise<TriggerHttpResponse> | TriggerHttpResponse): void };
  /** Tell the web clients something changed ({type:"plugin.event", data:{pluginId, channel, payload}}). */
  ui: { emit(channel: string, payload: unknown): void };
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
  };
  core: { call<T = any>(method: CoreMethod, params?: unknown): Promise<T> };
  /** How the watch loads pages; unset: the global fetch. */
  fetch?: FetchLike;
}
```

- [ ] **Step 3: Point the moved files at it**

```bash
cd packages/core/src/signals
perl -pi -e 's/\bPluginContext\b/TriggerHost/g; s/\bPluginHttpRequest\b/TriggerHttpRequest/g; s/\bPluginHttpResponse\b/TriggerHttpResponse/g; s#"\@piomio/plugin-sdk"#"./host.ts"#' engine.ts http.ts tools.ts
grep -n "host.ts\|plugin-sdk" engine.ts http.ts tools.ts
cd -
```

Expected output of the grep (three lines, no `plugin-sdk`):

```
engine.ts:4:import type { TriggerHost, TriggerHttpRequest, TriggerHttpResponse } from "./host.ts";
http.ts:5:import type { TriggerHttpRequest, TriggerHttpResponse } from "./host.ts";
tools.ts:3:import type { TriggerHost } from "./host.ts";
```

In `packages/core/src/signals/engine.ts`, change the first line comment to:

```ts
// Trigger engine (in core since the unified triggers, phase 1): persistence, timers, firing tasks, watch polling, webhooks, feedback.
```

- [ ] **Step 4: Write `packages/core/src/signals/index.ts`**

```ts
// The trigger engine in core (docs/superpowers/specs/2026-11-07-unified-triggers-design.md): schedules, one-off
// reminders, page watches, webhooks and heartbeat reviews that start background tasks for agents. It was the triggers
// plugin; startTriggers is that plugin's activate, on a TriggerHost.

import { TriggerEngine } from "./engine.ts";
import type { TriggerHost } from "./host.ts";
import { handleHttp } from "./http.ts";
import { registerTools } from "./tools.ts";

export async function startTriggers(host: TriggerHost): Promise<TriggerEngine> {
  const e = new TriggerEngine(host);
  registerTools(host, e);
  host.http.handle((req) => handleHttp(e, req));
  host.events.on("notification.feedback", (n) => {
    void e.onFeedback(n).catch((err) => host.log.error(`feedback failed: ${err?.message ?? err}`));
  });
  host.events.on("agent.removed", (p: { agentId: string }) => {
    void e.removeAgent(p.agentId).catch((err) => host.log.error(`removing ${p.agentId}'s triggers failed: ${err?.message ?? err}`));
  });
  host.onSettingsChange((s) => e.updateSettings(s));
  await e.start();
  // Catch-up runs and timers start after this returns, so the hub is not kept waiting.
  setImmediate(() => void e.boot().catch((err) => host.log.error(`boot failed: ${err?.message ?? err}`)));
  return e;
}

export type { TriggerEngine } from "./engine.ts";
export type { TriggerHost, TriggerHttpRequest, TriggerHttpResponse } from "./host.ts";
```

- [ ] **Step 5: Move the engine's messages into core's catalogs**

```bash
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const MOVE = /^(heartbeat|notify|when|error)\./;
const KEEP = /^error\./; // the page still translates API error codes itself (ui/src/index.tsx)
for (const lang of ["en", "ru"]) {
  const pf = `plugins/triggers/.piomio-plugin/locales/${lang}.json`;
  const plugin = JSON.parse(readFileSync(pf, "utf8"));
  const moved = Object.entries(plugin).filter(([k]) => MOVE.test(k));
  const cf = `packages/core/src/locales/${lang}.ts`;
  const core = readFileSync(cf, "utf8");
  const end = core.lastIndexOf("} satisfies");
  const lines = moved.map(([k, v]) => `  ${JSON.stringify("triggers." + k)}: ${JSON.stringify(v)},`).join("\n");
  writeFileSync(cf, core.slice(0, end) + "\n  // triggers (signals/): the engine that was the triggers plugin\n" + lines + "\n" + core.slice(end));
  writeFileSync(pf, JSON.stringify(Object.fromEntries(Object.entries(plugin).filter(([k]) => !MOVE.test(k) || KEEP.test(k))), null, 2) + "\n");
  console.log(lang, "moved", moved.length);
}'
```

Expected output:

```
en moved 65
ru moved 65
```

- [ ] **Step 6: Make the plugin UI-only**

Replace `plugins/triggers/.piomio-plugin/plugin.json` with (the `settings` block and the `integration` line are unchanged from the old file):

```json
{
  "id": "triggers",
  "name": "%name%",
  "version": "0.2.0",
  "description": "%description%",
  "builtin": true,
  "ui": "./ui/dist/index.js",
  "contributes": {
    "settings": {
      "type": "object",
      "properties": {
        "allowPrivateUrls": {
          "type": "boolean",
          "title": "%settings.allowPrivateUrls.title%",
          "description": "%settings.allowPrivateUrls.description%",
          "default": false
        },
        "watchTimeoutSec": {
          "type": "integer",
          "title": "%settings.watchTimeoutSec.title%",
          "default": 30,
          "minimum": 1,
          "maximum": 120
        }
      }
    }
  },
  "integration": {"category": "assistant", "icon": "alarm-clock", "connect": "none", "summary": "%integration.summary%", "example": "%integration.example%"},
  "permissions": {
    "ui": ["route"]
  }
}
```

Replace `plugins/triggers/package.json` with:

```json
{
  "name": "@piomio/plugin-triggers",
  "version": "0.2.0",
  "private": true,
  "type": "module",
  "description": "The Triggers page and its settings; the engine runs in core (packages/core/src/signals)"
}
```

In `packages/core/package.json`, add to `dependencies` (keeping alphabetical order):

```json
    "croner": "^10.0.1",
```

after `"ajv"`, and

```json
    "node-html-parser": "^9.0.4",
```

after `"jpeg-js"`. Then:

Run: `npm install`
Expected: exits 0; `git diff --stat package-lock.json` shows the lockfile changed.

- [ ] **Step 7: Point the moved tests at core**

```bash
cd packages/core/test/triggers
perl -pi -e 's#"\.\./server/#"../../src/signals/#g' engine.test.ts schedule.test.ts watch.test.ts when.test.ts triggers.test.ts
perl -pi -e 's#import type \{ PluginContext \} from "\@piomio/plugin-sdk";#import type { TriggerHost } from "../../src/signals/host.ts";#; s/as unknown as PluginContext/as unknown as TriggerHost/' engine.test.ts
perl -0pi -e 's#import \{ startPlugin, type PluginHarness \} from "\@piomio/testkit";#import { startTriggerHarness as startPlugin, type TriggerHarness as PluginHarness } from "./harness.ts";#; s#import \{ join \} from "node:path";\n##; s#const dir = join\(import\.meta\.dirname, "\.\."\);\n\n?##; s#\n\s*dir,##g' triggers.test.ts
grep -n "dir\b\|testkit\|server/" triggers.test.ts engine.test.ts schedule.test.ts watch.test.ts when.test.ts
cd -
```

Expected: the grep prints nothing.

- [ ] **Step 8: Write the in-process harness `packages/core/test/triggers/harness.ts`**

```ts
// The old plugin's end-to-end harness, in process: the engine on a fake TriggerHost with the surface the SDK harness
// gave (tools, invoke, http, emit, coreCalls, subscriptions, setLocale), so the old tests read the same.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locale, ToolCallContext, ToolResult, ToolSpec } from "@piomio/shared";
import { tFor } from "../../src/i18n.ts";
import type { TriggerEngine } from "../../src/signals/engine.ts";
import type { TriggerHost, TriggerHttpRequest, TriggerHttpResponse, TriggerToolRegistration } from "../../src/signals/host.ts";
import { startTriggers } from "../../src/signals/index.ts";

export interface TriggerHarnessOptions {
  settings?: Record<string, unknown>;
  /** The hub language (default "en"). */
  locale?: Locale;
  /** Answers the engine's core calls; undefined for the rest. */
  core?: (method: string, params: any) => unknown;
}

export interface TriggerHarness {
  engine: TriggerEngine;
  storage: Map<string, unknown>;
  /** Tools by short name. */
  tools: Map<string, ToolSpec>;
  /** Bus events the engine listens to. */
  subscriptions: Set<string>;
  /** Core calls and UI events (as method "ui.emit"), in order. */
  coreCalls: Array<{ method: string; params: any }>;
  invoke(name: string, input?: unknown, ctx?: Partial<ToolCallContext>): Promise<ToolResult>;
  invokeText(name: string, input?: unknown, ctx?: Partial<ToolCallContext>): Promise<string>;
  http(req: { method?: string; path: string; query?: Record<string, string>; headers?: Record<string, string>; body?: unknown; public?: boolean; locale?: Locale }): Promise<TriggerHttpResponse>;
  emit(event: string, payload: unknown): void;
  /** Change the hub language (and the default language of requests). */
  setLocale(locale: Locale): void;
  stop(): Promise<void>;
}

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

export async function startTriggerHarness(o: TriggerHarnessOptions = {}): Promise<TriggerHarness> {
  let locale: Locale = o.locale ?? "en";
  const storage = new Map<string, unknown>();
  const tools = new Map<string, ToolSpec>();
  const handlers = new Map<string, TriggerToolRegistration["handler"]>();
  const listeners = new Map<string, Array<(payload: any) => void>>();
  const subscriptions = new Set<string>();
  const coreCalls: Array<{ method: string; params: any }> = [];
  let handle: ((req: TriggerHttpRequest) => Promise<TriggerHttpResponse> | TriggerHttpResponse) | undefined;

  const host: TriggerHost = {
    pluginId: "triggers",
    hubUrl: "http://127.0.0.1:8080",
    settings: { ...(o.settings ?? {}) },
    onSettingsChange() {},
    i18n: { locale: () => locale, t: (key, params, l) => tFor(l ?? locale)(`triggers.${key}`, params) },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    tools: {
      register(r) {
        const { handler, ...spec } = r;
        tools.set(r.name, spec);
        handlers.set(r.name, handler);
      },
    },
    events: {
      on(name, cb) {
        subscriptions.add(name);
        listeners.set(name, [...(listeners.get(name) ?? []), cb]);
      },
    },
    http: { handle: (h) => void (handle = h) },
    ui: { emit: (channel, payload) => void coreCalls.push({ method: "ui.emit", params: { channel, payload } }) },
    storage: {
      get: async (k) => clone(storage.get(k)) as any,
      set: async (k, v) => void storage.set(k, clone(v)),
      delete: async (k) => void storage.delete(k),
      list: async (prefix = "") => [...storage.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value: clone(value) })),
    },
    core: {
      call: async (method, params) => {
        coreCalls.push({ method, params });
        return (await o.core?.(method, params)) as any;
      },
    },
  };

  const engine = await startTriggers(host);
  const context = (over: Partial<ToolCallContext> = {}): ToolCallContext => ({
    sessionId: "s_test",
    conversationId: "c_test",
    agentId: "assistant",
    callId: "call_test",
    tainted: false,
    background: false,
    workspace: over.workspace ?? mkdtempSync(join(tmpdir(), "owl-ws-")),
    machineId: "local",
    ...over,
  });

  const h: TriggerHarness = {
    engine,
    storage,
    tools,
    subscriptions,
    coreCalls,
    async invoke(name, input = {}, ctx) {
      const fn = handlers.get(name);
      if (!fn) throw new Error(`unknown tool ${name}`);
      try {
        const r = await fn(input, context(ctx));
        return typeof r === "string" ? { content: [{ type: "text", text: r }] } : r;
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e?.message ?? String(e)}` }], isError: true };
      }
    },
    async invokeText(name, input, ctx) {
      const r = await h.invoke(name, input, ctx);
      return r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
    },
    async http(req) {
      if (!handle) throw new Error("the engine registered no HTTP handler");
      return handle({ method: "GET", query: {}, headers: {}, body: null, public: false, locale, ...req });
    },
    emit(event, payload) {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
    setLocale(l) {
      locale = l;
    },
    async stop() {
      engine.stop();
    },
  };
  return h;
}
```

- [ ] **Step 9: Run the moved tests**

Run: `npx vitest run packages/core/test/triggers packages/core/test/i18n.test.ts`
Expected: PASS: every test that passed in `plugins/triggers/test` before (engine, schedule, watch, when, triggers), and the i18n parity tests, including `plugin triggers: translations match English and cover the manifest`.

If a `triggers.test.ts` case fails on wording, compare the failing string with the key in `packages/core/src/locales/{en,ru}.ts` under `triggers.`. The values must be byte-identical to the old plugin's JSON (Step 5 copies them), so a mismatch means the key prefix is missing in a `host.i18n.t` call path.

- [ ] **Step 10: Typecheck and run the whole suite**

Run: `npm run typecheck && npm test`
Expected: typecheck exits 0 with no output; vitest reports no failures. (Until Task 5 the hub runs no trigger engine. No test depends on that: the plugin's own tests moved here.)

- [ ] **Step 11: Commit**

```bash
git add -A packages/core/src/signals packages/core/test/triggers packages/core/src/locales packages/core/package.json package-lock.json plugins/triggers
git commit -m "refactor: the trigger engine's code and tests move into core; the plugin keeps its page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Watch page loads through the egress proxy

**Files:**
- Create: `packages/core/src/signals/net.ts`
- Modify: `packages/core/src/signals/watch.ts` (`fetchPage`), `packages/core/src/signals/engine.ts` (`check`)
- Test: `packages/core/test/triggers/net.test.ts`

**Interfaces:**
- Consumes: `FetchLike` from `signals/host.ts` (Task 2).
- Produces: `proxiedGet(proxyUrl: string, noProxy?: string): FetchLike`; `fetchPage(url, { allowPrivate, timeoutMs, fetch?: FetchLike })`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/triggers/net.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { proxiedGet } from "../../src/signals/net.ts";
import { fetchPage } from "../../src/signals/watch.ts";

describe("watch page loads", () => {
  let proxy: Server;
  let site: Server;
  let proxyPort = 0;
  let sitePort = 0;
  const seen: Array<{ url: string; auth?: string }> = [];
  let siteHits = 0;

  beforeAll(async () => {
    // A stand-in for the egress proxy: plain HTTP requests arrive with the absolute URL.
    proxy = createServer((req, res) => {
      seen.push({ url: req.url ?? "", auth: req.headers["proxy-authorization"] as string | undefined });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-from": "proxy" });
      res.end("<p>через прокси</p>");
    });
    site = createServer((_req, res) => {
      siteHits++;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("direct");
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    proxyPort = (proxy.address() as AddressInfo).port;
    sitePort = (site.address() as AddressInfo).port;
  });

  afterAll(() => {
    proxy?.close();
    site?.close();
  });

  it("sends outside addresses through the proxy, with its token", async () => {
    const get = proxiedGet(`http://tok123:x@127.0.0.1:${proxyPort}`);
    const res = await get("http://example.test/page?a=1", { headers: { accept: "text/html" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-from")).toBe("proxy");
    expect(await res.text()).toBe("<p>через прокси</p>");
    expect(seen.at(-1)).toEqual({ url: "http://example.test/page?a=1", auth: `Basic ${Buffer.from("tok123:x").toString("base64")}` });
  });

  it("loads loopback addresses directly, as the plugin's NO_PROXY did", async () => {
    const before = seen.length;
    const res = await proxiedGet(`http://tok123:x@127.0.0.1:${proxyPort}`)(`http://127.0.0.1:${sitePort}/`, {});
    expect(await res.text()).toBe("direct");
    expect(siteHits).toBe(1);
    expect(seen.length).toBe(before);
  });

  it("fetchPage uses the given fetch and reports its timeout as a timeout", async () => {
    const page = await fetchPage("https://example.com/x", {
      allowPrivate: true,
      timeoutMs: 1000,
      fetch: async () => new Response("<b>ok</b>", { status: 200, headers: { "content-type": "text/html" } }),
    });
    expect(page).toEqual({ body: "<b>ok</b>", contentType: "text/html", url: "https://example.com/x" });

    const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError", cause: new DOMException("timed out", "TimeoutError") });
    await expect(
      fetchPage("https://example.com/x", { allowPrivate: true, timeoutMs: 1000, fetch: async () => Promise.reject(abort) }),
    ).rejects.toMatchObject({ code: "fetchTimeout" });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/core/test/triggers/net.test.ts`
Expected: FAIL, `Failed to load url ../../src/signals/net.ts`.

- [ ] **Step 3: Write `packages/core/src/signals/net.ts`**

```ts
// The watch's page loads from core go through the hub's egress proxy, as the triggers plugin's process did
// (HTTP(S)_PROXY with its token, NO_PROXY for loopback): every connection is checked and audited there. Node's own
// proxy support in http.Agent (proxyEnv) does the proxying.

import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import type { FetchLike } from "./host.ts";

/** What the plugin process had in NO_PROXY: the hub's own machine is reached directly. */
export const LOOPBACK_NO_PROXY = "127.0.0.1,localhost,::1";

export function proxiedGet(proxyUrl: string, noProxy = LOOPBACK_NO_PROXY): FetchLike {
  const proxyEnv = { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: noProxy };
  const agents = { http: new http.Agent({ keepAlive: true, proxyEnv }), https: new https.Agent({ keepAlive: true, proxyEnv }) };
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const u = new URL(url);
      const secure = u.protocol === "https:";
      const req = (secure ? https : http).request(u, { method: "GET", headers: init.headers, agent: secure ? agents.https : agents.http, signal: init.signal }, (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) for (const x of Array.isArray(v) ? v : [v]) headers.append(k, x);
        const status = res.statusCode ?? 502;
        // A Response cannot carry a body with these statuses.
        const empty = status === 204 || status === 205 || status === 304;
        if (empty) res.resume();
        resolve(new Response(empty ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), { status, headers }));
      });
      req.on("error", reject);
      req.end();
    });
}
```

- [ ] **Step 4: Let `fetchPage` take a fetch**

In `packages/core/src/signals/watch.ts`, add to the imports:

```ts
import type { FetchLike } from "./host.ts";
```

Change the signature line of `fetchPage` from

```ts
export async function fetchPage(url: string, opts: { allowPrivate: boolean; timeoutMs: number }): Promise<{ body: string; contentType: string; url: string }> {
```

to

```ts
export async function fetchPage(url: string, opts: { allowPrivate: boolean; timeoutMs: number; fetch?: FetchLike }): Promise<{ body: string; contentType: string; url: string }> {
```

Inside it, change `res = await fetch(current, {` to `res = await (opts.fetch ?? fetch)(current, {`, and change

```ts
      if (e?.name === "TimeoutError") throw new WatchError("fetchTimeout", `Could not load ${current}: timeout`, { url: current });
```

to

```ts
      // fetch rejects with TimeoutError; node:http (net.ts) with an AbortError whose cause is the TimeoutError.
      if (e?.name === "TimeoutError" || e?.cause?.name === "TimeoutError") throw new WatchError("fetchTimeout", `Could not load ${current}: timeout`, { url: current });
```

- [ ] **Step 5: Pass the host's fetch from the engine**

In `packages/core/src/signals/engine.ts`, in `check()`, change

```ts
      const page = await fetchPage(t.url!, { allowPrivate: this.settings.allowPrivateUrls, timeoutMs: this.settings.watchTimeoutSec * 1000 });
```

to

```ts
      const page = await fetchPage(t.url!, { allowPrivate: this.settings.allowPrivateUrls, timeoutMs: this.settings.watchTimeoutSec * 1000, fetch: this.ctx.fetch });
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run packages/core/test/triggers && npm run typecheck`
Expected: PASS (net.test.ts 3 tests plus the moved tests); typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/signals/net.ts packages/core/src/signals/watch.ts packages/core/src/signals/engine.ts packages/core/test/triggers/net.test.ts
git commit -m "feat: watch page loads from core go through the egress proxy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `CoreTriggers`, the engine's host on hub services

**Files:**
- Create: `packages/core/src/signals/core-host.ts`
- Test: `packages/core/test/triggers/core-host.test.ts`

**Interfaces:**
- Consumes: `pluginKv` (Task 1); `startTriggers`, `TriggerHost`, `TriggerHttpRequest`, `TriggerHttpResponse`, `FetchLike` (Task 2); `EventBus.on(name, cb): () => void` (`packages/core/src/bus.ts`); `ToolRegistry.register(descriptor, invoke)` / `unregister(name, owner)` (`packages/core/src/tools/registry.ts`); `tFor`, `hubLocale` (`packages/core/src/i18n.ts`).
- Produces: `TRIGGERS_ID = "triggers"`; `class CoreTriggers` with `engine?: TriggerEngine`, `wanted(): boolean`, `start(): Promise<void>`, `stop(): void`, `sync(): Promise<void>`, `http(req: TriggerHttpRequest): Promise<TriggerHttpResponse>`; `interface CoreTriggersDeps` (below).

- [ ] **Step 1: Write the failing test**

`packages/core/test/triggers/core-host.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ToolCallContext } from "@piomio/shared";
import { EventBus } from "../../src/bus.ts";
import { openDb } from "../../src/db.ts";
import { pluginKv } from "../../src/plugins/kv.ts";
import { CoreTriggers } from "../../src/signals/core-host.ts";
import type { TriggerHttpRequest } from "../../src/signals/host.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

type Card = { enabled: boolean; settings: Record<string, unknown> } | undefined;

function setup(card: Card = { enabled: true, settings: {} }) {
  const db = openDb(":memory:");
  const bus = new EventBus();
  const tools = new ToolRegistry();
  const settingsListeners = new Set<(s: Record<string, unknown>) => void>();
  const calls: Array<{ pluginId: string; method: string; params: any }> = [];
  let current = card;
  const ct = new CoreTriggers({
    db,
    bus,
    tools,
    hubUrl: "http://127.0.0.1:8080",
    card: {
      get: () => current,
      onSettings: (cb) => {
        settingsListeners.add(cb);
        return () => void settingsListeners.delete(cb);
      },
    },
    coreCall: async (pluginId, method, params) => {
      calls.push({ pluginId, method, params });
      if (method === "settings.get") return { timezone: "Europe/Moscow", defaultAgent: "assistant" };
      if (method === "agents.list") return [{ id: "assistant", name: "A" }];
      if (method === "tasks.create") return { id: "task_1" };
      return [];
    },
  });
  return { db, bus, tools, ct, calls, settingsListeners, setCard: (c: Card) => void (current = c) };
}

const call: ToolCallContext = { sessionId: "s", conversationId: "c", agentId: "assistant", callId: "x", tainted: false, background: false, workspace: "/tmp", machineId: "local" };
const req = (over: Partial<TriggerHttpRequest>): TriggerHttpRequest => ({ method: "GET", path: "/triggers", query: {}, headers: {}, body: null, public: false, locale: "en", ...over });
const triggerTools = (tools: ToolRegistry) => tools.list().filter((t) => t.name.startsWith("trigger_"));

describe("the trigger engine's host in core", () => {
  it("runs on the plugin's storage, with its tools as core tools named trigger_*", async () => {
    const s = setup();
    await s.ct.start();
    expect(triggerTools(s.tools).map((t) => [t.name, t.owner]).sort()).toEqual([
      ["trigger_create", "core"],
      ["trigger_delete", "core"],
      ["trigger_list", "core"],
      ["trigger_run_now", "core"],
      ["trigger_update", "core"],
    ]);
    // A new hub's default heartbeat is written where the plugin kept its triggers.
    const stored = pluginKv(s.db, "triggers").list("trigger:");
    expect(stored).toHaveLength(1);
    expect(stored[0].value).toMatchObject({ kind: "heartbeat", agentId: "assistant" });
    const listed = await s.tools.get("trigger_list")!.invoke({}, call);
    expect(listed.isError).toBeFalsy();
    expect(listed.content[0]).toMatchObject({ type: "text" });
    expect((listed.content[0] as { text: string }).text).toContain('"kind": "heartbeat"');
    s.ct.stop();
  });

  it("keeps the triggers the plugin saved, serves its API and its webhooks", async () => {
    const s = setup();
    const kv = pluginKv(s.db, "triggers");
    kv.set("initialized", true);
    kv.set("trigger:t_old", {
      id: "t_old", kind: "event", name: "Hook", prompt: "Look at the payload.", agentId: "assistant", enabled: true, maxRunsPerDay: 24,
      createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", createdBy: "user", secret: "s3cret", report: false, state: {},
    });
    await s.ct.start();
    const list = await s.ct.http(req({}));
    expect((list.body as any).triggers.map((t: any) => t.id)).toEqual(["t_old"]);
    expect((list.body as any).triggers[0].webhookUrl).toBe("http://127.0.0.1:8080/hooks/triggers/t_old");
    expect((await s.ct.http(req({ method: "POST", path: "/t_old", headers: { "x-piomio-secret": "nope" }, public: true }))).status).toBe(401);
    const hook = await s.ct.http(req({ method: "POST", path: "/t_old", headers: { "x-piomio-secret": "s3cret" }, body: { a: 1 }, public: true }));
    expect(hook.status).toBe(202);
    expect(s.calls.find((c) => c.method === "tasks.create")).toMatchObject({ pluginId: "triggers", params: { triggerId: "t_old", background: true, agentId: "assistant" } });
    expect(s.calls.some((c) => c.method === "ui.emit" && c.params.channel === "changed")).toBe(true);
    s.ct.stop();
  });

  it("stops when the card is switched off, takes its tools back, and starts again", async () => {
    const s = setup();
    await s.ct.start();
    s.setCard({ enabled: false, settings: {} });
    await s.ct.sync();
    expect(s.ct.engine).toBeUndefined();
    expect(triggerTools(s.tools)).toEqual([]);
    expect(s.settingsListeners.size).toBe(0);
    expect((await s.ct.http(req({}))).status).toBe(404);
    s.setCard({ enabled: true, settings: {} });
    await s.ct.sync();
    expect(s.ct.engine).toBeDefined();
    expect(triggerTools(s.tools)).toHaveLength(5);
    s.ct.stop();
  });

  it("does not run without the Triggers card", async () => {
    const s = setup(undefined);
    await s.ct.start();
    expect(s.ct.engine).toBeUndefined();
    expect(triggerTools(s.tools)).toEqual([]);
  });

  it("hands the card's settings to the engine, now and when they change", async () => {
    const s = setup({ enabled: true, settings: { allowPrivateUrls: true } });
    await s.ct.start();
    expect(s.ct.engine!.settings.allowPrivateUrls).toBe(true);
    for (const cb of s.settingsListeners) cb({ allowPrivateUrls: false, watchTimeoutSec: 10 });
    expect(s.ct.engine!.settings).toEqual({ allowPrivateUrls: false, watchTimeoutSec: 10 });
    s.ct.stop();
  });

  it("hears the bus: an agent deleted for good takes its triggers along", async () => {
    const s = setup();
    await s.ct.start();
    expect(s.ct.engine!.list()).toHaveLength(1);
    s.bus.emit("agent.removed", { agentId: "assistant" });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.ct.engine!.list()).toHaveLength(0);
    s.ct.stop();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/test/triggers/core-host.test.ts`
Expected: FAIL, `Failed to load url ../../src/signals/core-host.ts`.

- [ ] **Step 3: Write `packages/core/src/signals/core-host.ts`**

```ts
// The trigger engine's host in core (host.ts): plugin_kv under "triggers" for its storage (where the plugin kept it),
// core's own calls, the hub bus, the tool registry (core tools named trigger_*), the Triggers card's switch and
// settings, and page loads through the egress proxy. The hub starts it while it leads and stops it when it stands
// down; it runs only while the Triggers card exists and is on.

import type { CoreMethod, ToolResult } from "@piomio/shared";
import type { EventBus } from "../bus.ts";
import type { Db } from "../db.ts";
import { hubLocale, tFor } from "../i18n.ts";
import { pluginKv } from "../plugins/kv.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { TriggerEngine } from "./engine.ts";
import type { FetchLike, TriggerHost, TriggerHttpRequest, TriggerHttpResponse } from "./host.ts";
import { startTriggers } from "./index.ts";

/** The Triggers card's id: its storage, its webhook addresses (/hooks/triggers/…) and its UI events carry it. */
export const TRIGGERS_ID = "triggers";
/** Its tools are named trigger_<name>, as the plugin's were (manifest toolPrefix "trigger"). */
const TOOL_PREFIX = "trigger";

export interface CoreTriggersDeps {
  db: Db;
  bus: EventBus;
  tools: ToolRegistry;
  /** The Triggers card in Plugins: undefined when the hub has none (or its plugin filter leaves it out). */
  card: {
    get(): { enabled: boolean; settings: Record<string, unknown> } | undefined;
    onSettings(cb: (settings: Record<string, unknown>) => void): () => void;
  };
  /** Core calls as a plugin makes them (core-call.ts), on behalf of "triggers". */
  coreCall: (pluginId: string, method: CoreMethod, params: unknown) => Promise<unknown>;
  hubUrl: string;
  /** How the watch loads pages (net.ts proxiedGet); unset: the global fetch. Made once per start. */
  fetch?: () => FetchLike;
}

export class CoreTriggers {
  engine?: TriggerEngine;
  private d: CoreTriggersDeps;
  private starting?: Promise<void>;
  private handler?: (req: TriggerHttpRequest) => Promise<TriggerHttpResponse> | TriggerHttpResponse;
  private offs: Array<() => void> = [];
  private toolNames: string[] = [];

  constructor(d: CoreTriggersDeps) {
    this.d = d;
  }

  /** The Triggers card exists and is on. */
  wanted(): boolean {
    return !!this.d.card.get()?.enabled;
  }

  /** Start the engine when it should run and does not; a call while it starts waits for that start. */
  start(): Promise<void> {
    if (this.engine || !this.wanted()) return this.starting ?? Promise.resolve();
    this.starting ??= (async () => {
      try {
        this.engine = await startTriggers(this.host());
      } catch (e) {
        this.release();
        throw e;
      } finally {
        this.starting = undefined;
      }
    })();
    return this.starting;
  }

  /** Stop it: its timers, its tools, its bus and settings listeners, its HTTP. */
  stop(): void {
    this.engine?.stop();
    this.engine = undefined;
    this.release();
  }

  /** Start or stop it to match the card (the person turned Triggers on or off). */
  async sync(): Promise<void> {
    if (this.wanted()) await this.start();
    else this.stop();
  }

  /** Its HTTP API (/api/plugins/triggers/http/*) and webhooks (/hooks/triggers/*): 404 while it does not run. */
  async http(req: TriggerHttpRequest): Promise<TriggerHttpResponse> {
    if (!this.handler) return { status: 404, body: { error: "not found" } };
    return this.handler(req);
  }

  private release(): void {
    for (const off of this.offs.splice(0)) off();
    for (const name of this.toolNames.splice(0)) this.d.tools.unregister(name, "core");
    this.handler = undefined;
  }

  private host(): TriggerHost {
    const d = this.d;
    const kv = pluginKv(d.db, TRIGGERS_ID);
    const log =
      (level: "info" | "warn" | "error") =>
      (...a: unknown[]) =>
        console.log(`[piomio] triggers${level === "info" ? "" : ` ${level}`}: ${a.map(String).join(" ")}`);
    const fetch = d.fetch?.();
    return {
      pluginId: TRIGGERS_ID,
      hubUrl: d.hubUrl,
      settings: { ...(d.card.get()?.settings ?? {}) },
      onSettingsChange: (cb) => void this.offs.push(d.card.onSettings(cb)),
      i18n: { locale: hubLocale, t: (key, params, locale) => tFor(locale ?? hubLocale())(`triggers.${key}`, params) },
      log: { debug() {}, info: log("info"), warn: log("warn"), error: log("error") },
      tools: {
        register: (r) => {
          const { handler, name: short, ...spec } = r;
          const name = `${TOOL_PREFIX}_${short}`;
          // As the plugin runner did: a string is the text, a throw is an error result.
          d.tools.register({ ...spec, name, owner: "core" }, async (input, ctx): Promise<ToolResult> => {
            try {
              const out = await handler(input ?? {}, ctx);
              return typeof out === "string" ? { content: [{ type: "text", text: out }] } : out;
            } catch (e: any) {
              return { content: [{ type: "text", text: `Error: ${e?.message ?? String(e)}` }], isError: true };
            }
          });
          this.toolNames.push(name);
        },
      },
      events: { on: (name, cb) => void this.offs.push(d.bus.on(name, cb)) },
      http: { handle: (h) => void (this.handler = h) },
      ui: { emit: (channel, payload) => void d.coreCall(TRIGGERS_ID, "ui.emit", { channel, payload }).catch(() => {}) },
      storage: {
        get: async (key) => (kv.get(key) ?? undefined) as any,
        set: async (key, value) => kv.set(key, value),
        delete: async (key) => kv.delete(key),
        list: async (prefix) => kv.list(prefix),
      },
      core: { call: (method, params) => d.coreCall(TRIGGERS_ID, method, params) as Promise<any> },
      ...(fetch ? { fetch } : {}),
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/test/triggers/core-host.test.ts && npm run typecheck`
Expected: PASS (6 tests); typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/signals/core-host.ts packages/core/test/triggers/core-host.test.ts
git commit -m "feat: CoreTriggers, the trigger engine's host on hub services

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The hub runs the engine and serves its old addresses

**Files:**
- Create: `packages/core/src/server/plugin-http.ts`
- Modify: `packages/core/src/app.ts` (field, constructor near the `PluginHost` construction at line ~442, `lead()`, `standby()`, `stop()`), `packages/core/src/server/api.ts` (route `/api/plugins/:id/http/*`, line ~501), `packages/core/src/server/main-app.ts` (route `/hooks/:pluginId/*`, line ~236)
- Create: `packages/core/test/fixtures/triggers-card/triggers/.piomio-plugin/plugin.json`
- Test: `packages/core/test/triggers/hub.test.ts`

**Interfaces:**
- Consumes: `CoreTriggers`, `TRIGGERS_ID` (Task 4); `proxiedGet` (Task 3); `PluginHost.onSettings`, `PluginHost.get`, `PluginHost.setEnabled`, `PluginHost.setSettings` (Task 1 and existing).
- Produces: `Hub.triggers: CoreTriggers`; `pluginHttp(hub, id, req)`, `hasPluginHttp(hub, id)`.

- [ ] **Step 1: Write the fixture card**

`packages/core/test/fixtures/triggers-card/triggers/.piomio-plugin/plugin.json`:

```json
{
  "id": "triggers",
  "name": "Triggers",
  "version": "0.2.0",
  "builtin": true,
  "contributes": {
    "settings": {
      "type": "object",
      "properties": {
        "allowPrivateUrls": { "type": "boolean", "default": false },
        "watchTimeoutSec": { "type": "integer", "default": 30 }
      }
    }
  },
  "permissions": {}
}
```

- [ ] **Step 2: Write the failing hub test**

`packages/core/test/triggers/hub.test.ts`:

```ts
// The hub runs the trigger engine itself: core tools, the old webhook address, the card's switch and settings.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallContext } from "@piomio/shared";
import { freePort } from "@piomio/testkit";
import { Hub, loadConfig } from "../../src/index.ts";

const fixtures = join(import.meta.dirname, "..", "fixtures");

const until = async <T>(fn: () => T | Promise<T>, what: string, timeoutMs = 8000): Promise<NonNullable<T>> => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("the hub's trigger engine", () => {
  let hub: Hub;
  let base = "";
  const call: ToolCallContext = { sessionId: "s", conversationId: "c", agentId: "assistant", callId: "x", tainted: false, background: false, workspace: tmpdir(), machineId: "local" };

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-triggers-hub-")), builtinPluginsDirs: [join(fixtures, "triggers-card")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    base = config.publicUrl;
    await until(() => hub.triggers.engine, "the trigger engine to start");
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("has the trigger tools as core tools", () => {
    expect(hub.tools.get("trigger_create")?.descriptor.owner).toBe("core");
    expect(hub.tools.get("trigger_run_now")?.descriptor.effect).toBe("local-write");
  });

  it("answers a webhook at its old address and starts the agent's task", async () => {
    const out = await hub.tools.get("trigger_create")!.invoke({ kind: "event", name: "Deploys", prompt: "Look at the deploy." }, call);
    const text = (out.content[0] as { text: string }).text;
    const id = /trigger (t_[0-9a-f]+)/.exec(text)![1];
    const secret = /Secret: (\S+)/.exec(text)![1];
    expect((await fetch(`${base}/hooks/triggers/${id}`, { method: "POST", headers: { "x-piomio-secret": "wrong" } })).status).toBe(401);
    const r = await fetch(`${base}/hooks/triggers/${id}`, { method: "POST", headers: { "x-piomio-secret": secret, "content-type": "application/json" }, body: JSON.stringify({ build: 42 }) });
    expect(r.status).toBe(202);
    const task = await until(() => hub.store.listTasks({ limit: 50 }).find((t) => t.triggerId === id), "the webhook's task");
    expect(task).toMatchObject({ agentId: "assistant", background: true, createdBy: "trigger" });
    expect(task.goal).toContain("42");
  });

  it("follows the card: settings reach the engine, off stops it, on starts it again", async () => {
    hub.plugins.setSettings("triggers", { allowPrivateUrls: true, watchTimeoutSec: 5 });
    expect(hub.triggers.engine!.settings).toEqual({ allowPrivateUrls: true, watchTimeoutSec: 5 });
    await hub.plugins.setEnabled("triggers", false);
    await until(() => !hub.triggers.engine, "the engine to stop");
    expect(hub.tools.get("trigger_create")).toBeUndefined();
    expect((await fetch(`${base}/hooks/triggers/t_any`, { method: "POST" })).status).toBe(404);
    await hub.plugins.setEnabled("triggers", true);
    await until(() => hub.triggers.engine && hub.tools.get("trigger_create"), "the engine to start again");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run packages/core/test/triggers/hub.test.ts`
Expected: FAIL with `Cannot read properties of undefined (reading 'engine')`: the hub has no `triggers` yet.

- [ ] **Step 4: Write `packages/core/src/server/plugin-http.ts`**

```ts
// A plugin's HTTP (its API for the UI and its public webhooks). The Triggers card's goes to the trigger engine in core
// (signals/core-host.ts), at the same addresses the triggers plugin had.

import type { Hub } from "../app.ts";
import { TRIGGERS_ID } from "../signals/core-host.ts";
import type { TriggerHttpRequest, TriggerHttpResponse } from "../signals/host.ts";

export function pluginHttp(hub: Pick<Hub, "plugins" | "triggers">, id: string, req: TriggerHttpRequest): Promise<TriggerHttpResponse> {
  return id === TRIGGERS_ID ? hub.triggers.http(req) : hub.plugins.http(id, req);
}

/** Whether public webhooks of this plugin are answered at all. */
export function hasPluginHttp(hub: Pick<Hub, "plugins">, id: string): boolean {
  return id === TRIGGERS_ID || hub.plugins.hasHttp(id);
}
```

- [ ] **Step 5: Route through it**

In `packages/core/src/server/api.ts`, import `import { pluginHttp } from "./plugin-http.ts";` and in the `api.all("/api/plugins/:id/http/*", …)` handler change `const r = await hub.plugins.http(id, {` to `const r = await pluginHttp(hub, id, {`. The object passed stays exactly as it is.

In `packages/core/src/server/main-app.ts`, import `import { hasPluginHttp, pluginHttp } from "./plugin-http.ts";` and in the `app.all("/hooks/:pluginId/*", …)` handler change

```ts
      if (!hub.plugins.hasHttp(pluginId)) throw new HttpError(404, "not found");
```

to

```ts
      if (!hasPluginHttp(hub, pluginId)) throw new HttpError(404, "not found");
```

and `const r = await hub.plugins.http(pluginId, {` to `const r = await pluginHttp(hub, pluginId, {`.

- [ ] **Step 6: Wire `CoreTriggers` into the hub**

In `packages/core/src/app.ts`:

Add imports next to the other local ones:

```ts
import { CoreTriggers, TRIGGERS_ID } from "./signals/core-host.ts";
import { proxiedGet } from "./signals/net.ts";
```

Add the field next to `plugins: PluginHost;`:

```ts
  /** The trigger engine (signals/): runs while this hub leads and the Triggers card is on. */
  triggers: CoreTriggers;
  /** The egress token the trigger engine's page loads use, issued once (like reviewToken). */
  private triggersToken?: string;
```

Replace `coreCall: createCoreCall(this),` in the `new PluginHost({…})` call with `coreCall,`, and put this line just before `this.plugins = new PluginHost({`:

```ts
    const coreCall = createCoreCall(this);
```

Right after the `new PluginHost({…});` statement, add:

```ts
    this.triggers = new CoreTriggers({
      db: this.db,
      bus: this.bus,
      tools: this.tools,
      card: {
        get: () => {
          const r = this.plugins.get(TRIGGERS_ID);
          const allowed = config.plugins === "all" || (Array.isArray(config.plugins) && config.plugins.includes(TRIGGERS_ID));
          return r && allowed ? { enabled: r.enabled, settings: r.settings } : undefined;
        },
        onSettings: (cb) => this.plugins.onSettings(TRIGGERS_ID, cb),
      },
      coreCall,
      hubUrl: config.internalUrl,
      // Page loads go through the egress proxy, checked and audited like the plugin process's were.
      fetch: () => proxiedGet(`http://${(this.triggersToken ??= this.egress.issueToken("plugin:triggers", ["*"]))}:x@127.0.0.1:${config.egressPort}`),
    });
    // The person turned the Triggers card on or off.
    this.bus.on("plugins.updated", () => {
      if (this.leading && !this.stopping) void this.triggers.sync().catch((e) => console.log(`[piomio] triggers: ${e?.message ?? e}`));
    });
```

In `lead()`, right after `if (cfg.plugins !== "none") await this.plugins.startAll(cfg.plugins);`, add:

```ts
    await this.triggers.start().catch((e) => console.log(`[piomio] triggers did not start: ${e?.message ?? e}`));
```

In `standby()` and in `stop()`, right after `this.feeds.stop();`, add:

```ts
    this.triggers.stop();
```

- [ ] **Step 7: Run the hub test and the core suite**

Run: `npx vitest run packages/core/test/triggers packages/core/test/hub.test.ts packages/core/test/cluster.test.ts && npm run typecheck`
Expected: PASS; typecheck exits 0. (`setEnabled` on the UI-only card is safe: `PluginHost.start` marks a plugin without a server `"no-server"` and returns.)

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/server/plugin-http.ts packages/core/src/server/api.ts packages/core/src/server/main-app.ts packages/core/src/app.ts packages/core/test/fixtures/triggers-card packages/core/test/triggers/hub.test.ts
git commit -m "feat: the hub runs the trigger engine itself and serves the triggers plugin's addresses

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Whole-repo checks, a live check on a throwaway hub, the PR

**Files:**
- No source changes expected. Fix only what the checks find.

- [ ] **Step 1: Full checks**

Run: `npm run typecheck && npm test && npm run build`
Expected: all exit 0. `npm run build` builds the Triggers page (`plugins/triggers/ui/dist/index.js`) exactly as before.

- [ ] **Step 2: Live check on a throwaway hub, with plugin-era data**

```bash
LIVE=$(mktemp -d)/hub
export PIOMIO_DATA_DIR=$LIVE PIOMIO_PORT=18780 PIOMIO_CONSOLE_PORT=18781 PIOMIO_EGRESS_PORT=18789 PIOMIO_DEVICES=0 PIOMIO_PLUGINS=triggers PIOMIO_TAILNET_BIN=/nonexistent
npm start > $LIVE.log 2>&1 &
HUB=$!
sleep 8 && kill $HUB && wait $HUB 2>/dev/null
# A webhook trigger as the plugin saved it, before this change:
sqlite3 $LIVE/piomio.db "insert into plugin_kv(plugin_id, key, value) values ('triggers', 'trigger:t_live01', '{\"id\":\"t_live01\",\"kind\":\"event\",\"name\":\"Live\",\"prompt\":\"Look at the payload.\",\"agentId\":\"assistant\",\"enabled\":true,\"maxRunsPerDay\":24,\"createdAt\":\"2026-11-01T00:00:00Z\",\"updatedAt\":\"2026-11-01T00:00:00Z\",\"createdBy\":\"user\",\"secret\":\"live-secret\",\"report\":false,\"state\":{}}')"
npm start > $LIVE.log 2>&1 &
HUB=$!
sleep 8
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "x-piomio-secret: live-secret" -H "content-type: application/json" -d '{"hello":"world"}' http://127.0.0.1:18780/hooks/triggers/t_live01
sqlite3 $LIVE/piomio.db "select trigger_id, created_by from tasks where trigger_id = 't_live01'"
sqlite3 $LIVE/piomio.db "select count(*) from plugin_kv where plugin_id = 'triggers' and key like 'trigger:%'"
grep -i "triggers" $LIVE.log | head -5
kill $HUB && wait $HUB 2>/dev/null
rm -rf "$(dirname $LIVE)"
unset PIOMIO_DATA_DIR PIOMIO_PORT PIOMIO_CONSOLE_PORT PIOMIO_EGRESS_PORT PIOMIO_DEVICES PIOMIO_PLUGINS PIOMIO_TAILNET_BIN
```

Expected:
- the `curl` prints `202`;
- the first `select` prints `t_live01|trigger`;
- the count is `2` (the seeded trigger and the default heartbeat the first start made);
- the log has no `triggers error` / `triggers did not start` lines.

If the column names differ (`tasks.trigger_id`, `tasks.created_by`), read them with `sqlite3 $LIVE/piomio.db ".schema tasks"` before the select. The throwaway data dir is deleted at the end either way.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin claude/unified-trigger-event-system-e68bd2
gh pr create --base main --title "Triggers engine moves into core (unified triggers, phase 1)" --body "$(cat <<'EOF'
Phase 1 of docs/superpowers/specs/2026-11-07-unified-triggers-design.md: the trigger engine (schedules, once, heartbeat, page watches, webhooks) runs inside the hub core instead of the triggers plugin's process. Nothing visible changes.

- `packages/core/src/signals/`: the engine's files, moved almost unchanged, behind `TriggerHost` (the part of the plugin context they used). `CoreTriggers` implements it on hub services.
- Data stays where it is (`plugin_kv`, `triggers`); the same `trigger_*` tools; the same API at `/api/plugins/triggers/http/*` and webhooks at `/hooks/triggers/<id>`, now served by core.
- Watch page loads still go through the egress proxy (Node's `proxyEnv`), loopback direct, as before.
- The plugin keeps its page, settings form and on/off switch (UI-only); the switch starts and stops the engine in core.
- The engine's tests moved to `packages/core/test/triggers/` and pass unchanged, plus host, proxy and hub tests.

Live check: a throwaway hub with a webhook trigger saved the plugin's way answered its old address with 202 and started the agent's task.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: the PR URL is printed. Then bind it with the ccd_pr tools and wait for `typecheck`, `test`, `site`, `panel-layout` to be green; never merge with a red check or the owner's bypass.

---

## After this phase

Phases 2–5 each get their own plan, written against the code this phase leaves:
2. The new trigger shape (`on`, `batch`, `script`, `triage`, `wake`, `limits`) migrated in place, the sources registry with `time.*`, `web.page`, `web.webhook` (secret + HMAC), then match, dedup, batch, the QuickJS sandbox with `pio`, triage, `signal_notes` with `[Signals]` and `signals_recent`, the journal (`trigger_runs`), `trigger_test`, `trigger_sources`.
3. Plugin sources: `contributes.signals`, `ctx.signals`, `hub.*`, `web.rss_item`, the integration template and `make-integration`.
4. Composio triggers.
5. The web page, hub settings, the plugin removed, docs.
