# Plugins

[Русский](plugins.ru.md)

Almost everything in Piomio is a plugin: brains (Claude Code, Codex, APIs), channels (Telegram), the browser, memory, web search, triggers. The core only wires them together and enforces security. Integrations (services and abilities: the weather, calendars, maps…) are plugins too and live in [`integrations/`](../integrations/README.md), each in its own folder, started from a template with `npm run new:integration -- <id>`.

A plugin can add:

| What | Where |
|---|---|
| Tools for agents | `server/` → `ctx.tools.register` |
| A brain (harness or API) | `server/` → `ctx.brains.register` |
| A channel (messenger) | `server/` → `ctx.channels.register` |
| Hooks (`tool.before`, `message.in`, …) | `server/` → `ctx.hooks.on` |
| HTTP endpoints (webhooks, an API for its own UI) | `server/` → `ctx.http.handle` |
| Skills, commands, agents | `skills/`, `commands/`, `agents/` |
| MCP servers | `.mcp.json` |
| UI: panels, tabs, tool-result renderers, a replacement composer | `ui/` |
| Translations | `.piomio-plugin/locales/` |

Claude Code plugins (`.claude-plugin/plugin.json`) and Codex plugins (`.codex-plugin/plugin.json`) install as they are: their skills, commands, agents and MCP servers become available. Claude Code plugins are also passed to the hub's Claude Code brain with `--plugin-dir`, so their hooks run there.

In `.mcp.json`, `${PIOMIO_PLUGIN_ROOT}` (or `${CLAUDE_PLUGIN_ROOT}`) is the plugin's folder, `${PIOMIO_PLUGIN_DATA}` its data folder and `${PIOMIO_NODE}` the hub's own Node, so a local server can be a TypeScript launcher in the plugin (`integrations/blender`). A local server reaches only the plugin's `permissions.network` hosts; when it exits while starting, the last line of its stderr is the error shown on the plugin.

## Layout

```
my-plugin/
  .piomio-plugin/plugin.json
  .piomio-plugin/locales/en.json   # translations, see Localization
  .piomio-plugin/locales/ru.json
  server/index.ts        # backend: a separate process, JSON-RPC over stdio
  ui/src/index.tsx       # UI module (built into ui/dist/index.js)
  skills/<name>/SKILL.md
  commands/<name>.md
  agents/<name>.md
  .mcp.json
```

## Manifest

```json
{
  "id": "weather",
  "name": "%name%",
  "description": "%description%",
  "version": "0.1.0",
  "server": "./server/index.ts",
  "ui": "./ui/dist/index.js",
  "toolPrefix": "weather",
  "contributes": {
    "tools": true,
    "hooks": ["tool.before"],
    "http": true,
    "settings": {
      "type": "object",
      "properties": {
        "city": { "type": "string", "title": "%settings.city%", "description": "%settings.city.hint%" }
      }
    }
  },
  "permissions": {
    "network": ["api.open-meteo.com"],
    "vault": [],
    "core": ["notify", "ui.emit"]
  }
}
```

- `id` uses lowercase letters, digits and dashes and starts with a letter. `server` and `ui` are paths that start with `./` and stay inside the plugin. The `"%key%"` strings are translations, see [Localization](#localization).
- Tools are named `<toolPrefix>_<name>` (the prefix defaults to the `id` with `-` replaced by `_`).
- `contributes` declares what the backend registers, and the hub refuses anything undeclared: `tools: true` for `ctx.tools.register`, `brains` and `channels` with the ids for `ctx.brains.register` and `ctx.channels.register`, `hooks` with the hook names for `ctx.hooks.on`, `http: true` for `ctx.http.handle`. `settings` is a JSON Schema that the web UI renders as a form; the values arrive in `ctx.settings`.
- `permissions.network` lists the hosts the plugin may reach (`*` means any). All traffic goes through the core's egress proxy, which lets through only those hosts.
- `permissions.vault` lists vault item ids or `<type>:*` patterns such as `login:*`. Even an allowed item is handed out only if its scope includes this plugin. The security console can grant a plugin extra items.
- `permissions.core` lists the core methods the plugin may call: `conversations.post`, `channels.inbound`, `tasks.create`, `tasks.get`, `tasks.list`, `notify`, `approvals.resolve`, `settings.get`, `agents.list`, `ui.emit`, `vault.check`, `machines.list`, `notifications.feedback`, `files.deliver` (writes a file, in base64 chunks, into the `downloads/` folder of a session workspace), `connections.token` (an access token of the hub's Google sign-in, for a plugin whose `integration.connect` is `google`), `conversations.tell` (a note an agent answers), `speech.transcribe` (the words of a short clip, base64, with the hub's speech-to-text; `{ check: true }` says whether one is set up), `speech.status` and `speech.install` (`{ voice?, stt? }`: the hub's local speech engine, `SpeechStatus` in `packages/shared/src/types.ts`; downloads go on in the background). `ctx.ui.emit` goes through `ui.emit` too, so it needs this permission.
- `integration` puts the plugin into the integrations library as a card: `category`, `icon` (a Lucide name), `connect` (`google`: the hub's Google sign-in, with the OAuth `scopes` the plugin needs; `setup`: the plugin's setup card; `signin`: its MCP server's own sign-in; `none`: works as it is) and a one-line `summary`. `entries` lists apps of its own as further cards (`<id>:<entry>`, e.g. `composio:slack`), and `via` (`name`, `about`, `link`) names the outside service they go through: every such card carries its badge, whose note is `about` (see the Composio integration and the `make-integration` skill).
- `permissions.ui` and `permissions.fs` are informational and shown in the install dialog.

Permissions are shown at install time. A plugin installed from git is pinned to its commit hash.

## Backend

```ts
import type { PluginModule } from "@piomio/plugin-sdk";

const plugin: PluginModule = {
  async activate(ctx) {
    ctx.tools.register({
      name: "forecast",
      description: "Weather forecast for tomorrow", // text for the model stays English
      effect: "read", // read | local-write | external (external → user approval)
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
      handler: async ({ city }) => {
        const r = await fetch(`https://api.open-meteo.com/...${encodeURIComponent(city ?? ctx.settings.city)}`);
        return await r.text(); // a string or { content: [...] }
      },
    });
    ctx.hooks.on("tool.before", (call) =>
      call.tool === "mail_send" && /urgent/i.test(JSON.stringify(call.input)) ? { block: "no urgent mail" } : undefined,
    );
    ctx.http.handle(async (req) => ({ status: 200, body: { ok: true, public: req.public } }));
  },
};

export default plugin;
```

Plugins only `import type` from `@piomio/plugin-sdk`: the runner provides the implementation, so a plugin needs no runtime dependency on the SDK. The SDK also exports a `definePlugin` helper, but that is a value import; a typed object as above does the same job.

What `ctx` offers: `pluginId`, `pluginDir`, `dataDir` (a private writable folder), `hubUrl`, `appRoot`, `settings`, `onSettingsChange`, `i18n` (see [Localization](#localization)), `log`, `tools`, `brains`, `channels`, `events.on`, `hooks.on`, `http.handle`, `ui.emit` / `ui.onMessage`, `vault.get`, `storage` (the plugin's key-value store: `get`, `set`, `delete`, `list`), `catalog` (its entries' state with `update`, their sign-in with `onSignIn` / `onSignOut`) and `core.call`. `tools.unregister(name)` takes one of its tools back. A module may also export `deactivate()`.

**Tools.** A handler receives the input and a context (session, agent, workspace, machine) and returns a string or a `ToolResult` (`{ content: [{ type: "text", text }], isError? }`); a thrown error becomes an error result. Besides `effect`, a tool can set `source: true` when its results come from outside (web, mail): reading them marks the session as untrusted. `availability` limits a tool to `interactive` or `background` sessions. For `effect: "external"` you can set `approvalSummary: "Send {text} to {chat}"`, which is how the action appears on the approval card; `{field}` is filled from the tool input. A `local-write` tool whose changes outlive the session (memory, profiles) can set `askWhenTainted: true`: in an untrusted session every call that changes something then waits for the user to approve it on a card in the chat, and the handler gets `ctx.approved` once they do.

**Hooks.** `session.start` can append to the system prompt (`appendSystemPrompt`), `tool.before` can block a call (`block`) or replace its `input`, `tool.after` can replace the `result`, `message.in` can block a message or rewrite its `text`, `notify.before` can block a notification or change its `level`, `digest.compose` (`{ date, time, timezone }`) can add a section `{ title, body }` to the digest going out (Google Calendar adds the day's events). Hooks run before the policy, so a hook cannot allow what the policy denied or sent for approval; it can only block the call or change its input.

**Events.** `ctx.events.on(name, cb)` receives `message.created`, `message.updated`, `task.updated`, `notification.created`, `notification.feedback`, `approval.created`, `approval.resolved`, `conversation.updated` and `vault.state`, with secrets redacted.

**HTTP.** `ctx.http.handle` serves `/api/plugins/<id>/http/*` to the signed-in web UI (`ui.plugin.http`). The same handler is also reachable **without authentication** at `/hooks/<id>/*` for webhooks: such requests have `req.public === true`, and the plugin has to check a secret itself.

**Channels.** A channel is `{ id, label, send(message), status?() }`. `send` receives replies, notifications, approval cards (with approve and deny tokens) and the digest. Incoming user messages go to the hub through `ctx.core.call("channels.inbound", { text, channel, files? })`. `files` are what the user sent along: `{ name?, mimeType?, data (base64), kind?: "photo" | "voice" | "audio" | "video" | "file", durationSec? }`, at most 10 per message and 25 MB each. The hub saves them in the conversation's workspace (`attachments/`) and the agent gets their paths; text may be empty when there are files. `context` (English, at most 2000 characters) goes to the model before the user's words and is not shown in the chat: where a forward came from, what the message replies to.

## Brains

A brain is a `BrainProviderImpl`: `probe()` (installed? signed in?) and `createSession(opts)`. The session gets the system prompt, a working folder and MCP access to the hub's tools (`opts.mcp.url`, `opts.mcp.token`, and `opts.mcp.bridgeCommand` for stdio clients). `send(turn)` yields the events `text`, `tool_call`, `tool_result`, `usage`, `limit_hit`, `error` and `done`; the session also implements `interrupt()` and `close()`. On `limit_hit` the core marks the brain busy until `resetAt` and moves on to the next brain in the agent's list. Ready-made adapters for CLIs live in `@piomio/brains-cli`. If a brain has variants (for example, API providers), list them in `variants: ["anthropic", "openai"]`: the UI shows them as separate brains `<id>:<variant>@local`, and the variant arrives in `probe(variant)` and `opts.variant`. Brain ids go into `contributes.brains`.

## UI

A UI module is an ES module. React and `@piomio/ui` come from the host through an import map, so they are not bundled.

```tsx
import { definePluginUI, Card } from "@piomio/ui";
import type { PiomioUI, ToolResultProps } from "@piomio/ui";

let ui: PiomioUI;

function Panel() {
  const time = ui.i18n.formatDate(Date.now(), { timeStyle: "short" });
  return <Card title={ui.i18n.t("panel.title")}>{ui.i18n.t("panel.updated", { time })}</Card>;
}

function ForecastCard({ result }: ToolResultProps) {
  return <Card title={ui.i18n.t("panel.title")}>{result?.output ?? "…"}</Card>;
}

export default definePluginUI((host) => {
  ui = host;
  const offs = [
    ui.slots.register("sidebar.panel", { id: "weather", title: ui.i18n.t("panel.title"), icon: "☀", component: Panel }),
    ui.slots.register("chat.toolResult", { id: "forecast", match: { tool: ["weather_*"] }, component: ForecastCard }),
    ui.statusbar.add({ id: "temp", render: () => <span>+12°</span> }),
  ];
  return () => offs.forEach((off) => off());
});
```

`definePluginUI` takes the activate function itself: it receives `ui` and may return a cleanup function. Every `register` and `add` call returns a function that removes the contribution.

Slots: `layout.sidebar`, `layout.statusbar`, `sidebar.panel`, `pane.right`, `live.view`, `chat.message`, `chat.toolResult`, `chat.composer`, `chat.composerActions`, `settings.section`, `route`. `ui.slots.override(slot, Component, { priority })` replaces a standard component entirely. Every slot is wrapped in an error boundary.

**Live view.** When an agent works in something the user may want to watch (the builtin browser; a desktop app or another machine's screen), contribute a live view. The host shows it in a floating corner window that opens on its own while the view is busy, turns into a pill shortly after the work stops, and expands into a large overlay where the user can interact (for example, take over). The plugin only provides the content and reports activity; the host draws the window and decides when it shows:

```tsx
const view = ui.liveView.register({ id: "screen", title: ui.i18n.t("screen.title"), icon: "monitor", component: Screen });
ui.plugin.on("activity", (a) => view.update({ active: a.busy, agentId: a.agentId, status: a.what, attention: a.needsUser }));
// Screen gets { mode: "mini" | "expanded", expand, collapse }. It is mounted only while the window or the overlay
// is visible (start streaming on mount, stop on unmount), and stays mounted when the mode changes.
```

`attention` reopens the window (even if the user minimized or closed it) and highlights it; `userControl` keeps it open while the user drives. A plugin may register several live views and `dispose()` them at any time.

Besides slots, `ui` offers `routes.add` (a full page, optionally in the navigation), `settings.section`, `commands.register` (the command palette), `toast`, `navigate`, `api` (the hub's REST API), `plugin` (`http`, `send` and `on` to talk to the plugin's own backend through `ctx.http`, `ctx.ui.onMessage` and `ctx.ui.emit`), `events.on` (realtime hub events) and `i18n`. `@piomio/ui` also exports the components `Button`, `Card`, `Badge`, `EmptyState`, `Spinner` and `Markdown`, the hooks `useTasks` and `useHubEvent`, plus `api` and `locale`.

Build every builtin UI plugin with `npm run build:ui-plugins` (`plugins/*/ui/src/index.tsx` → `ui/dist/index.js`), or a single plugin with `node scripts/build-ui-plugins.mjs path/to/my-plugin`. Ship the built `ui/dist/index.js` with the plugin: installing does not build it.

**Trust.** A UI plugin is trusted code on the main page. That is why approvals, the vault, rules and the audit log live on a separate origin (port 8081), and the main page's CSP does not let data leave for a foreign server.

## Localization

Piomio ships in English and Russian, and plugins follow the same rules. English is the source of truth and the fallback: a key missing in the reader's language falls back to English, then to the key itself.

### Catalogs

Translations live in `.piomio-plugin/locales/en.json` and `ru.json`: flat maps from key to string. A malformed file stops the plugin from loading. Strings use `{name}` placeholders and ICU-style plurals such as `{n, plural, one {# file} other {# files}}`, where `#` is the number formatted for the language and `=0 {…}` matches an exact value; Russian uses the categories `one`, `few`, `many` and `other`. `{kind, select, a {…} other {…}}` picks a branch by value.

`en.json`:

```json
{
  "name": "Weather",
  "description": "Forecasts from Open-Meteo",
  "settings.city": "City",
  "settings.city.hint": "Used when the agent does not name a city",
  "approval.share": "Send the forecast for {city} to {chat}",
  "notify.rain": "{city}: rain tomorrow",
  "panel.title": "Weather",
  "panel.updated": "Updated at {time}",
  "panel.alerts": "{n, plural, one {# alert} other {# alerts}}"
}
```

`ru.json`:

```json
{
  "name": "Погода",
  "description": "Прогнозы Open-Meteo",
  "settings.city": "Город",
  "settings.city.hint": "Если агент не назвал город",
  "approval.share": "Отправить прогноз для {city} в {chat}",
  "notify.rain": "{city}: завтра дождь",
  "panel.title": "Погода",
  "panel.updated": "Обновлено в {time}",
  "panel.alerts": "{n, plural, one {# предупреждение} few {# предупреждения} many {# предупреждений} other {# предупреждения}}"
}
```

### Manifest strings

A string in `plugin.json` that is exactly `"%key%"` is replaced with its translation: `name`, `description` and anything under `contributes`, such as settings titles and descriptions. These strings are resolved per reader, so the web UI and the console show them in the viewer's language. Keys may contain letters, digits, `_`, `.` and `-`. Use `%key%` only for text people read: enum values and defaults under `contributes` would be translated too.

### Approval summaries

`approvalSummary: "%approval.share%"` is resolved in the hub language, because one approval card is created for everyone, and then `{field}` is filled from the tool input (`{a.b}` reaches nested fields; secrets are redacted). Only these simple placeholders work here, not plurals or select.

### Backend

`ctx.i18n.locale()` returns the hub language. `ctx.i18n.t(key, params?, locale?)` translates into the hub language unless you pass a locale. `ctx.i18n.onChange(cb)` fires when the hub language changes in Settings. Use the hub language for text without a specific reader: channel messages, notifications.

```ts
ctx.tools.register({
  name: "share",
  description: "Send the forecast to a Telegram chat",
  effect: "external",
  approvalSummary: "%approval.share%",
  inputSchema: { type: "object", properties: { city: { type: "string" }, chat: { type: "string" } }, required: ["city", "chat"] },
  handler: async ({ city, chat }) => `Sent the forecast for ${city} to ${chat}.`,
});

await ctx.core.call("notify", { level: "notify", title: ctx.i18n.t("notify.rain", { city: "Berlin" }), body: "" });
ctx.i18n.t("panel.alerts", { n: 3 }, "ru"); // "3 предупреждения"
ctx.i18n.onChange((locale) => ctx.log.info(`hub language: ${locale}`));
```

### UI

UI modules use `ui.i18n.t(key, params?)`, `ui.i18n.locale`, `ui.i18n.formatDate(date, options?)` and `ui.i18n.formatNumber(n, options?)`. The hub delivers the plugin's messages in the interface language, with English as the fallback. When the user switches the language, the page reloads, so `locale` stays fixed for the module's lifetime and components need no language-change handling.

### Text for the model stays English

Tool descriptions, input schemas and tool results are written for the model and stay in English, as do skills and agent prompts. Agents reply to people in their own language anyway.

### Agents

An agent's name and description can be translated in its frontmatter; the prompt itself stays English:

```markdown
---
name: Weather watcher
description: Watches the forecast and warns about rain.
i18n:
  ru:
    name: Синоптик
    description: Следит за прогнозом и предупреждает о дожде.
brains: [claude-code@local, "api:anthropic"]
---
You watch the weather forecast for the user's city and warn about rain a day ahead.
```

A file in a plugin's `agents/` folder becomes an Piomio agent only if its frontmatter has `brains:`.

### Checks

`packages/core/test/i18n.test.ts` runs with `npm test`. It checks the core catalogs and every plugin under `plugins/` that has locales: each language must have exactly the English keys with the same placeholders, and every `"%key%"` in `plugin.json` must exist in `en.json`. For a plugin kept elsewhere, `catalogProblems(readPluginLayout(dir).messages)` from `@piomio/shared` returns the same list of problems.

In tests, start the plugin in a given language with `startPlugin({ locale })` and switch it with `h.setLocale()`, which fires `ctx.i18n.onChange`:

```ts
const h = await startPlugin({ dir: "plugins/weather", locale: "ru" });
h.setLocale("en");
```

## Tests

`@piomio/testkit` runs the plugin as a real process and plays the role of the core:

```ts
import { startPlugin } from "@piomio/testkit";

const h = await startPlugin({ dir: "plugins/weather", settings: { city: "Berlin" } });
expect(h.tools.has("forecast")).toBe(true);
expect(await h.invokeText("forecast", {})).toContain("°");
await h.stop();
```

The harness calls tools by their short name, without the prefix. `startPlugin` also takes `vault` (items by id), `core` (an implementation of `ctx.core.call`; every call is recorded in `h.coreCalls`), `locale` and `env`. The harness offers `http`, `hook`, `emit`, `uiMessage`, `setSettings`, `setLocale` and `channelSend`. For brains there are `brainProbe`, `brainCreate`, `brainSend`, `brainInterrupt` and `brainClose`; for API brains, `startMockLlm` is a fake LLM server that speaks the Anthropic Messages and OpenAI Chat Completions APIs.

## Installation

In the web UI, go to **Plugins** and install from a git URL (`https://`, `git@`, `ssh://`) or a folder path on the hub, review the permissions and warnings, and confirm. The hub copies the plugin into `/data/plugins/<id>` and, if the plugin's `package.json` has `dependencies`, runs `npm install --omit=dev --ignore-scripts`. A folder dropped into `/data/plugins` without going through the install dialog is ignored.
