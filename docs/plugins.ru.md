# Плагины

[English](plugins.md)

Почти всё в Piomio — плагины: интеллекты (Claude Code, Codex, API), каналы (Telegram), браузер, память, веб-поиск, триггеры. Ядро только связывает их и следит за безопасностью. Интеграции (сервисы и умения: погода, календари, карты…) — тоже плагины; они лежат в [`integrations/`](../integrations/README.ru.md), каждая в своей папке, и начинаются с шаблона: `npm run new:integration -- <id>`.

Плагин может добавить:

| Что | Где |
|---|---|
| Инструменты для агентов | `server/` → `ctx.tools.register` |
| Интеллект (харнесс или API) | `server/` → `ctx.brains.register` |
| Канал (мессенджер) | `server/` → `ctx.channels.register` |
| Хуки (`tool.before`, `message.in`, …) | `server/` → `ctx.hooks.on` |
| HTTP-эндпоинты (вебхуки, API для своего UI) | `server/` → `ctx.http.handle` |
| Скиллы, команды, агенты | `skills/`, `commands/`, `agents/` |
| MCP-серверы | `.mcp.json` |
| Интерфейс: панели, вкладки, рендер результатов, замена композера | `ui/` |
| Переводы | `.piomio-plugin/locales/` |

Плагины Claude Code (`.claude-plugin/plugin.json`) и Codex (`.codex-plugin/plugin.json`) ставятся как есть: их скиллы, команды, агенты и MCP-серверы становятся доступны. Плагины Claude Code к тому же передаются интеллекту Claude Code на хабе через `--plugin-dir`, поэтому их хуки работают там.

В `.mcp.json` `${PIOMIO_PLUGIN_ROOT}` (или `${CLAUDE_PLUGIN_ROOT}`) — папка плагина, `${PIOMIO_PLUGIN_DATA}` — его папка данных, `${PIOMIO_NODE}` — собственный Node хаба, так что локальный сервер может быть запускателем на TypeScript внутри плагина (`integrations/blender`). Локальный сервер ходит только на хосты из `permissions.network` плагина; если он завершился при запуске, последняя строка его stderr становится ошибкой, которую видно на плагине.

## Структура

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

## Манифест

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

- `id` — строчные латинские буквы, цифры и дефисы, начинается с буквы. `server` и `ui` — пути, которые начинаются с `./` и не выходят за папку плагина. Строки `"%key%"` — это переводы, см. [Локализация](#локализация).
- Инструменты называются `<toolPrefix>_<name>` (по умолчанию префикс — `id` с `_` вместо `-`).
- `contributes` объявляет, что регистрирует бэкенд; всё необъявленное хаб отклоняет: `tools: true` — для `ctx.tools.register`, `brains` и `channels` со списком id — для `ctx.brains.register` и `ctx.channels.register`, `hooks` с именами хуков — для `ctx.hooks.on`, `http: true` — для `ctx.http.handle`. `settings` — JSON Schema, которую веб-интерфейс показывает формой; значения приходят в `ctx.settings`.
- `permissions.network` — куда плагину можно ходить (`*` — куда угодно). Весь трафик идёт через egress-прокси ядра, который пропускает только эти хосты.
- `permissions.vault` — id записей vault или шаблоны `<тип>:*`, например `login:*`. Даже разрешённая запись отдаётся, только если её область (scope) включает этот плагин. Пульт безопасности может выдать плагину дополнительные записи.
- `permissions.core` — методы ядра, которые плагину можно вызывать: `conversations.post`, `channels.inbound`, `tasks.create`, `tasks.get`, `tasks.list`, `notify`, `approvals.resolve`, `settings.get`, `agents.list`, `ui.emit`, `vault.check`, `machines.list`, `notifications.feedback`, `connections.token` (токен доступа входа хаба в Google, для плагина, у которого `integration.connect` — `google`), `files.deliver` (записывает файл, кусками в base64, в папку `downloads/` рабочей папки сессии). `ctx.ui.emit` тоже идёт через `ui.emit`, поэтому ему нужно это право.
- `integration` добавляет плагин в библиотеку интеграций карточкой: `category`, `icon` (имя иконки Lucide), `connect` (`google` — вход хаба в Google с нужными плагину OAuth-`scopes`; `setup` — карточка настройки плагина; `none` — работает как есть) и `summary` в одну строку.
- `permissions.ui` и `permissions.fs` — справочные, их показывает окно установки.

Права показываются при установке. Плагин из git закрепляется на хэше коммита.

## Бэкенд

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

Из `@piomio/plugin-sdk` плагины импортируют только типы (`import type`): реализацию даёт раннер, поэтому плагину не нужна зависимость от SDK во время работы. В SDK есть и помощник `definePlugin`, но это импорт значения; типизированный объект, как в примере, делает то же самое.

Что есть в `ctx`: `pluginId`, `pluginDir`, `dataDir` (личная папка с правом записи), `hubUrl`, `appRoot`, `settings`, `onSettingsChange`, `i18n` (см. [Локализация](#локализация)), `log`, `tools`, `brains`, `channels`, `events.on`, `hooks.on`, `http.handle`, `ui.emit` / `ui.onMessage`, `vault.get`, `storage` (хранилище ключ-значение плагина: `get`, `set`, `delete`, `list`) и `core.call`. Модуль может также экспортировать `deactivate()`.

**Инструменты.** Обработчик получает вход и контекст (сессия, агент, рабочая папка, машина) и возвращает строку или `ToolResult` (`{ content: [{ type: "text", text }], isError? }`); брошенная ошибка превращается в результат с ошибкой. Кроме `effect`, инструмент может указать `source: true`, если его результаты приходят извне (веб, почта): после их чтения сессия считается недоверенной. `availability` ограничивает инструмент сессиями `interactive` или `background`. Для `effect: "external"` можно задать `approvalSummary: "Send {text} to {chat}"` — так действие будет показано в карточке подтверждения; `{поле}` подставляется из входа инструмента. Инструмент `local-write`, чьи изменения переживают сессию (память, профили), может указать `askWhenTainted: true`: тогда в недоверенной сессии каждый вызов, который что-то меняет, ждёт подтверждения пользователя в карточке в чате, а после подтверждения обработчик получает `ctx.approved`.

**Хуки.** `session.start` может дописать системный промпт (`appendSystemPrompt`), `tool.before` — заблокировать вызов (`block`) или заменить его `input`, `tool.after` — заменить `result`, `message.in` — заблокировать сообщение или переписать его `text`, `notify.before` — заблокировать уведомление или поменять его `level`, `digest.compose` (`{ date, time, timezone }`) — добавить в уходящую сводку раздел `{ title, body }` (Google Календарь добавляет события дня). Хуки выполняются до политики, поэтому хук не может разрешить то, что политика запретила или отправила на подтверждение: он может только заблокировать вызов или изменить вход.

**События.** `ctx.events.on(name, cb)` получает `message.created`, `message.updated`, `task.updated`, `notification.created`, `notification.feedback`, `approval.created`, `approval.resolved`, `conversation.updated` и `vault.state`; секреты из них вырезаны.

**HTTP.** `ctx.http.handle` обслуживает `/api/plugins/<id>/http/*` для веб-интерфейса, в который выполнен вход (`ui.plugin.http`). Тот же обработчик доступен **без аутентификации** по адресу `/hooks/<id>/*` для вебхуков: у таких запросов `req.public === true`, и секрет плагин проверяет сам.

**Каналы.** Канал — это `{ id, label, send(message), status?() }`. В `send` приходят ответы, уведомления, карточки подтверждения (с токенами «разрешить» и «отклонить») и дайджест. Входящие сообщения пользователя плагин передаёт хабу через `ctx.core.call("channels.inbound", { text, channel, files? })`. В `files` то, что пользователь приложил: `{ name?, mimeType?, data (base64), kind?: "photo" | "voice" | "audio" | "video" | "file", durationSec? }`, не больше 10 файлов по 25 МБ. Хаб сохраняет их в рабочей папке переписки (`attachments/`), а агент получает их пути. Если есть файлы, текст может быть пустым. `context` (по-английски, до 2000 символов) модель получает перед словами пользователя, в чате его не видно: откуда переслано сообщение, на что оно отвечает.

## Интеллект

Интеллект — это `BrainProviderImpl`: `probe()` (установлен? есть вход?) и `createSession(opts)`. Сессия получает системный промпт, рабочую папку и MCP-доступ к инструментам хаба (`opts.mcp.url`, `opts.mcp.token`, `opts.mcp.bridgeCommand` для stdio-клиентов). `send(turn)` выдаёт события `text`, `tool_call`, `tool_result`, `usage`, `limit_hit`, `error`, `done`; ещё сессия реализует `interrupt()` и `close()`. При `limit_hit` ядро помечает интеллект занятым до `resetAt` и переключается на следующий в списке агента. Готовые адаптеры для CLI — в `@piomio/brains-cli`. Если у интеллекта есть варианты (например, провайдеры API), перечислите их в `variants: ["anthropic", "openai"]` — в интерфейсе они появятся отдельными интеллектами `<id>:<вариант>@local`, а вариант придёт в `probe(variant)` и `opts.variant`. Id интеллектов перечисляются в `contributes.brains`.

## UI

UI-модуль — ES-модуль; React и `@piomio/ui` берутся у хоста через import map, поэтому в сборку не попадают.

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

`definePluginUI` принимает саму функцию активации: она получает `ui` и может вернуть функцию очистки. Каждый вызов `register` и `add` возвращает функцию, которая убирает добавленное.

Слоты: `layout.sidebar`, `layout.statusbar`, `sidebar.panel`, `pane.right`, `live.view`, `chat.message`, `chat.toolResult`, `chat.composer`, `chat.composerActions`, `settings.section`, `route`. `ui.slots.override(slot, Component, { priority })` заменяет стандартный компонент целиком. Каждый слот обёрнут в error boundary.

**Живой просмотр.** Если агент работает в чём-то, за чем пользователю стоит следить (встроенный браузер; приложение на рабочем столе или экран другой машины), добавьте живой просмотр. Хост показывает его в плавающем окне в углу: оно открывается само, пока идёт работа, вскоре после её конца сворачивается в «таблетку» и разворачивается в большое окно поверх приложения, где пользователь может действовать сам (например, взять управление). Плагин даёт только содержимое и сообщает об активности; окно рисует хост и сам решает, когда его показать:

```tsx
const view = ui.liveView.register({ id: "screen", title: ui.i18n.t("screen.title"), icon: "monitor", component: Screen });
ui.plugin.on("activity", (a) => view.update({ active: a.busy, agentId: a.agentId, status: a.what, attention: a.needsUser }));
// Screen получает { mode: "mini" | "expanded", expand, collapse }. Он смонтирован, только пока видно окно или
// большое окно (начинайте трансляцию при монтировании, останавливайте при размонтировании), и не перемонтируется при смене режима.
```

`attention` снова открывает окно (даже если пользователь его свернул или закрыл) и подсвечивает его; `userControl` держит его открытым, пока управляет пользователь. Плагин может зарегистрировать несколько живых просмотров и убрать любой через `dispose()`.

Кроме слотов, в `ui` есть `routes.add` (отдельная страница, по желанию — в навигации), `settings.section`, `commands.register` (палитра команд), `toast`, `navigate`, `api` (REST API хаба), `plugin` (`http`, `send` и `on` — связь со своим бэкендом через `ctx.http`, `ctx.ui.onMessage` и `ctx.ui.emit`), `events.on` (события хаба в реальном времени) и `i18n`. Ещё `@piomio/ui` экспортирует компоненты `Button`, `Card`, `Badge`, `EmptyState`, `Spinner`, `Markdown`, хуки `useTasks` и `useHubEvent`, а также `api` и `locale`.

Сборка всех встроенных UI-плагинов: `npm run build:ui-plugins` (`plugins/*/ui/src/index.tsx` → `ui/dist/index.js`); одного плагина — `node scripts/build-ui-plugins.mjs path/to/my-plugin`. Собранный `ui/dist/index.js` поставляется вместе с плагином: при установке он не собирается.

**Доверие.** UI-плагин — доверенный код в основной странице. Поэтому подтверждения, vault, правила и аудит живут на отдельном origin (порт 8081), а CSP основной страницы не даёт отправить данные на чужой сервер.

## Локализация

Piomio работает на английском и русском, и плагины следуют тем же правилам. Английский — основной язык и запасной вариант: если ключа нет на языке читателя, берётся английский текст, а если нет и его — сам ключ.

### Каталоги

Переводы лежат в `.piomio-plugin/locales/en.json` и `ru.json` — плоских словарях «ключ → строка». Если файл некорректен, плагин не загрузится. В строках есть подстановки `{name}` и множественные формы в стиле ICU, например `{n, plural, one {# file} other {# files}}`, где `#` — число в формате языка, а `=0 {…}` срабатывает на точное значение; в русском используются категории `one`, `few`, `many` и `other`. `{kind, select, a {…} other {…}}` выбирает вариант по значению.

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

### Строки манифеста

Строка в `plugin.json`, которая целиком имеет вид `"%key%"`, заменяется переводом: `name`, `description` и всё внутри `contributes`, например заголовки и описания настроек. Такие строки переводятся для каждого читателя: веб-интерфейс и пульт показывают их на языке того, кто смотрит. В ключах допустимы буквы, цифры, `_`, `.` и `-`. Используйте `%key%` только для текста, который читают люди: значения enum и значения по умолчанию внутри `contributes` тоже будут переведены.

### Карточки подтверждения

`approvalSummary: "%approval.share%"` переводится на язык хаба (карточка подтверждения создаётся одна на всех), а затем `{поле}` заполняется из входа инструмента (`{a.b}` — вложенное поле; секреты вырезаются). Здесь работают только такие простые подстановки — без plural и select.

### Бэкенд

`ctx.i18n.locale()` возвращает язык хаба. `ctx.i18n.t(key, params?, locale?)` переводит на язык хаба, если не передать другой язык. `ctx.i18n.onChange(cb)` вызывается, когда язык хаба меняют в «Настройках». Язык хаба нужен для текстов без конкретного читателя: сообщений в каналы и уведомлений.

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

UI-модули используют `ui.i18n.t(key, params?)`, `ui.i18n.locale`, `ui.i18n.formatDate(date, options?)` и `ui.i18n.formatNumber(n, options?)`. Хаб передаёт сообщения плагина на языке интерфейса и английские как запасные. Когда пользователь переключает язык, страница перезагружается, поэтому `locale` не меняется за время жизни модуля, и компонентам не нужно отслеживать смену языка.

### Текст для модели остаётся английским

Описания инструментов, схемы входа и результаты инструментов пишутся для модели и остаются на английском, как и скиллы и промпты агентов. Людям агенты всё равно отвечают на их языке.

### Агенты

Имя и описание агента можно перевести во frontmatter; сам промпт остаётся английским:

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

Файл из папки `agents/` плагина становится агентом Piomio, только если в его frontmatter есть `brains:`.

### Проверки

`packages/core/test/i18n.test.ts` запускается вместе с `npm test`. Он проверяет каталоги ядра и каждый плагин из `plugins/`, у которого есть переводы: в каждом языке должны быть ровно те же ключи, что в английском, с теми же подстановками, а каждый `"%key%"` из `plugin.json` должен быть в `en.json`. Для плагина вне репозитория тот же список проблем вернёт `catalogProblems(readPluginLayout(dir).messages)` из `@piomio/shared`.

В тестах плагин запускается на нужном языке через `startPlugin({ locale })`, а `h.setLocale()` переключает язык и вызывает `ctx.i18n.onChange`:

```ts
const h = await startPlugin({ dir: "plugins/weather", locale: "ru" });
h.setLocale("en");
```

## Тесты

`@piomio/testkit` запускает плагин как настоящий процесс и эмулирует ядро:

```ts
import { startPlugin } from "@piomio/testkit";

const h = await startPlugin({ dir: "plugins/weather", settings: { city: "Berlin" } });
expect(h.tools.has("forecast")).toBe(true);
expect(await h.invokeText("forecast", {})).toContain("°");
await h.stop();
```

Тестовая обвязка вызывает инструменты по короткому имени, без префикса. Ещё `startPlugin` принимает `vault` (записи по id), `core` (реализация `ctx.core.call`; все вызовы записываются в `h.coreCalls`), `locale` и `env`. У обвязки есть `http`, `hook`, `emit`, `uiMessage`, `setSettings`, `setLocale` и `channelSend`. Для интеллектов — `brainProbe`, `brainCreate`, `brainSend`, `brainInterrupt` и `brainClose`; для API-интеллектов — `startMockLlm`, фейковый LLM-сервер с API Anthropic Messages и OpenAI Chat Completions.

## Установка

В веб-интерфейсе откройте «Плагины» и установите плагин по git URL (`https://`, `git@`, `ssh://`) или из папки на хабе, проверьте права и предупреждения и подтвердите. Хаб копирует плагин в `/data/plugins/<id>` и, если в `package.json` плагина есть `dependencies`, выполняет `npm install --omit=dev --ignore-scripts`. Папку, положенную в `/data/plugins` в обход окна установки, хаб игнорирует.
