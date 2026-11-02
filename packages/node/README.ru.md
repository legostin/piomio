# piomio-node — подключение компьютера к хабу Piomio

[English](README.md)

`piomio-node` — небольшой демон, который подключает ваш компьютер (ноутбук, рабочую станцию, домашний сервер) к хабу Piomio. После подключения агенты хаба могут:

- запускать **интеллекты на подписках этой машины** — Claude Code и Codex, в которые вы уже вошли здесь (`claude-code@<машина>`, `codex@<машина>`);
- **читать, писать и просматривать файлы** в разрешённых папках (`machine_read_file`, `machine_write_file`, `machine_list_dir`);
- **выполнять команды** (`machine_exec`) — только если вы это явно включили.

Что разрешено, решает **владелец машины** в локальном файле `~/.piomio-node/policy.json`, а не хаб. Демон сам проверяет каждый запрос.

Демон работает на Windows, macOS и Linux. Он сам подключается к хабу исходящим WebSocket-соединением — открывать порты на этой машине не нужно.

## Установка

**Проще всего — один файл с хаба.** Нужен только Node.js 24.5+:

```sh
curl -fsSLo piomio-node.mjs https://bot.example.com/download/piomio-node.mjs
node piomio-node.mjs help
```

Дальше везде вместо `piomio-node` пишите `node piomio-node.mjs`.

**Из исходников.** Нужны Node.js 24.5+ и git; `<repo>` — адрес репозитория Piomio.

```sh
git clone <repo> piomio
cd Piomio
npm install
npx piomio-node help        # run straight from the source folder
```

Чтобы команда `piomio-node` была доступна из любой папки, установите пакет глобально **из этой же копии** (npm создаст ссылку на папку, поэтому не удаляйте её):

```sh
npm install -g ./packages/node
piomio-node help
```

Интеллекты работают через CLI, установленные на этой машине, — поставьте те, что нужны, и войдите в них обычным способом:

- Claude Code: `claude` (вход по подписке Claude — `claude` → `/login`);
- Codex: `npm i -g @openai/codex`, затем `codex login`.

Демон сообщает хабу только о тех CLI, что реально установлены (проверка при запуске и при каждом подключении).

## Язык

CLI и его лог говорят по-английски или по-русски. Язык берётся из `PIOMIO_LANG` (`en` или `ru`), затем из `LC_ALL`, `LC_MESSAGES` и `LANG`; во всех остальных случаях — английский. На Windows, где `LANG` обычно не задан, для русского языка задайте `PIOMIO_LANG=ru`. Служба берёт язык из своего окружения.

## Привязка

1. В веб-интерфейсе хаба откройте «Машины» → «Подключить машину» и скопируйте одноразовый код (действует 10 минут). Можно и из командной строки хаба: `node packages/core/src/cli.ts pairing-code`, а в Docker — `docker exec piomio piomio-entrypoint pairing-code laptop`.
2. На этой машине:

```sh
piomio-node pair https://bot.example.com AB12CD34 --name laptop
```

Демон создаёт ключ Ed25519, отправляет хабу **только публичный ключ** и сохраняет:

| Файл | Что внутри |
| --- | --- |
| `~/.piomio-node/config.json` | адрес хаба, id и имя машины |
| `~/.piomio-node/key.json` | закрытый ключ (права 0600; никому не передавайте) |
| `~/.piomio-node/policy.json` | локальная политика (создаётся с безопасными настройками) |
| `~/.piomio-node/brains/` | служебные файлы сессий интеллектов |

Папку можно переопределить переменной `PIOMIO_NODE_HOME`.

При каждом подключении хаб присылает случайную строку, демон подписывает её ключом — так хаб узнаёт машину. Отозвать машину можно в веб-интерфейсе одним кликом: демон получит отказ (код 4401), напишет об этом и завершится с кодом 1. Чтобы подключить машину снова, повторите `pair` с новым кодом.

## Запуск

```sh
piomio-node run       # in the terminal, with a log; Ctrl+C stops it
piomio-node status    # pairing, policy, installed CLIs, hub reachability
piomio-node policy    # path and contents of policy.json
```

`run` — работа в консоли с логом (Ctrl+C — остановка), `status` — привязка, политика, установленные CLI и доступность хаба, `policy` — путь и содержимое policy.json.

`run` переподключается к хабу бесконечно с растущей паузой (до 60 с), так что перезагрузка хаба или обрыв сети не требуют вмешательства. Каждый запрос хаба пишется в лог одной строкой — что, куда и результат, **без содержимого файлов и текстов запросов**, например:

```
[14:02:11] подключено к хабу https://bot.example.com как «laptop»
[14:02:40] fs.write /home/me/piomio-workspace/report.md (2048 B) → 2048 B (3 ms)
[14:03:05] exec.run npm test → denied: Running commands is not allowed on this machine (exec.enabled = false in policy.json)
```

Строки запросов и ошибки, которые уходят обратно агенту, всегда на английском: их читает модель, а пользователю она отвечает на его языке.

## Запуск как службы

В примерах исходники лежат в `~/piomio`; поправьте пути под себя. Служба должна видеть `claude`/`codex` в `PATH` и запускаться от **вашего** пользователя — тогда CLI используют ваш вход.

### Linux (systemd, пользовательская служба)

На сервере всё это делает `curl -fsSL https://piomio.io/install.sh | sh -s -- <ссылка-приглашение>` (свой Node, `piomio-node.mjs` хаба, этот юнит), а обновления потом приходят с хаба. Вручную:

`~/.config/systemd/user/piomio-node.service`:

```ini
[Unit]
Description=Piomio node
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node %h/piomio/packages/node/src/cli.ts run
Environment=PATH=%h/.local/bin:%h/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=10
# Exit code 1: the machine was revoked, is not paired, or policy.json is broken. Don't restart blindly.
RestartPreventExitStatus=1

[Install]
WantedBy=default.target
```

Код выхода 1 означает, что машину отозвали, она не привязана или policy.json сломан, поэтому перезапускать службу вслепую не нужно.

```sh
systemctl --user daemon-reload
systemctl --user enable --now piomio-node
loginctl enable-linger "$USER"          # keep running without a login session
journalctl --user -u piomio-node -f    # log
```

`loginctl enable-linger` нужен, чтобы служба работала и без входа в систему. Если Node установлен через nvm, укажите полный путь к `node` (`which node`).

### macOS (launchd)

`~/Library/LaunchAgents/dev.piomio.node.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.piomio.node</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/me/piomio/packages/node/src/cli.ts</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>/Users/me/Library/Logs/piomio-node.log</string>
  <key>StandardErrorPath</key><string>/Users/me/Library/Logs/piomio-node.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.piomio.node.plist
launchctl kickstart -k gui/$(id -u)/dev.piomio.node    # restart
launchctl bootout gui/$(id -u)/dev.piomio.node         # stop (for example, after the machine was revoked)
```

`kickstart -k` перезапускает службу, `bootout` останавливает её (например, после отзыва машины). На Intel-маках `node` обычно лежит в `/usr/local/bin/node`.

### Windows (Планировщик заданий)

В PowerShell от своего пользователя:

```powershell
$node = (Get-Command node).Source
$cli  = "$HOME\Piomio\packages\node\src\cli.ts"
$log  = "$HOME\.piomio-node\node.log"
$action   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"`"$node`" `"$cli`" run >> `"$log`" 2>&1`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 `
            -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "piomio-node" -Action $action -Trigger $trigger -Settings $settings -Description "Piomio node"
Start-ScheduledTask -TaskName "piomio-node"
```

Лог — в `%USERPROFILE%\.piomio-node\node.log`. Задача запускается при входе в систему; чтобы она работала без окна консоли и до входа, в свойствах задачи выберите «Выполнять для всех пользователей». Удалить: `Unregister-ScheduledTask -TaskName piomio-node`.

## Машины в разных сетях: Tailscale

Если хаб и эта машина в разных сетях, проще всего включить в хабе **доступ из любого места** (Настройки → Интеграции): у хаба появится постоянная ссылка `https://piomio.<сеть>.ts.net`, и страница «Машины» подставит её в команду привязки. Привяжите машину по этой ссылке, больше на ней ничего не нужно.

Или объедините обе машины в [Tailscale](https://tailscale.com) сами:

1. Установите Tailscale на машину с хабом и на эту машину, войдите в один tailnet (`tailscale up`).
2. На хабе: пусть он слушает адрес в tailnet и знает своё имя, например
   `PIOMIO_HOST=0.0.0.0`, `PIOMIO_PUBLIC_URL=http://hub.tailnet-name.ts.net:8080`,
   `PIOMIO_ALLOWED_HOSTS=hub.tailnet-name.ts.net` (для не-локального адреса хабу нужен заданный пароль).
   Ещё удобнее — `tailscale serve --bg 8080` на машине хаба: получится `https://hub.tailnet-name.ts.net` с TLS.
3. Привяжите машину по адресу из tailnet: `piomio-node pair https://hub.tailnet-name.ts.net <code>`.

Наружу в интернет при этом ничего не открывается. Демон использует тот же адрес и для подключения инструментов Piomio к интеллектам (MCP), так что отдельной настройки не нужно.

## Политика (`~/.piomio-node/policy.json`)

Файл создаётся при первом запуске; демон перечитывает его на лету (изменения подхватываются за пару секунд, перезапуск не нужен, хаб получает обновлённый список интеллектов и папок). Если вы сохранили файл с ошибкой, демон пишет об этом в лог и продолжает работать с предыдущей версией.

Настройки по умолчанию:

```json
{
  "allowedDirs": ["/home/me/piomio-workspace"],
  "exec": { "enabled": false, "allowCommands": [] },
  "fs": { "read": true, "write": true },
  "brains": {
    "claude-code": {
      "enabled": true,
      "allowedTools": ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite", "Task", "Skill", "mcp__piomio"]
    },
    "codex": { "enabled": true, "sandbox": "workspace-write" }
  },
  "workspacesRoot": "/home/me/piomio-workspace"
}
```

| Поле | Значение |
| --- | --- |
| `allowedDirs` | Папки, доступные хабу. Пути абсолютные, можно с `~`. Любой путь из запроса раскрывается (включая символические ссылки) и должен оставаться внутри одной из этих папок; пути с `..` отклоняются. Относительные пути считаются от первой папки. |
| `fs.read`, `fs.write` | Разрешить чтение/просмотр и запись файлов в этих папках. Читаются только текстовые файлы до 5 МБ; одна запись — не больше 10 МБ. |
| `exec.enabled` | Разрешить выполнение команд. **По умолчанию выключено.** |
| `exec.allowCommands` | Шаблоны разрешённых команд (`*` — любые символы, `?` — один), например `["git status", "git log*", "npm test*"]`. Пустой список — любые команды. Когда список задан, в команде запрещены `; & | $ < > ^`, `` ` ``, `%VAR%` и переводы строк, чтобы к разрешённой команде нельзя было «приклеить» другую. |
| `exec.shell` | Оболочка для команд (по умолчанию `/bin/sh`, на Windows — `cmd.exe`), например `"powershell.exe"`. |
| `exec.maxTimeoutMs` | Предел времени одной команды (по умолчанию 30 минут). По таймауту завершается всё дерево процессов; вывод ограничен 1 МБ. |
| `brains.claude-code.enabled` / `brains.codex.enabled` | Какие интеллекты этой машины можно использовать. |
| `brains.claude-code.allowedTools` | Встроенные инструменты Claude Code, которые разрешены без вопросов (остальные запрещены). **`Bash` по умолчанию не включён.** Можно сужать правилами Claude Code, например `"Read(//home/me/piomio-workspace/**)"`. |
| `brains.codex.sandbox` | Песочница Codex: `read-only`, `workspace-write` (по умолчанию: запись только в рабочую папку сессии) или `danger-full-access`. |
| `brains.*.command` | Необязательно: своя команда или полный путь к CLI, если он не в `PATH`. |
| `workspacesRoot` | Где создаются рабочие папки сессий интеллектов: `<workspacesRoot>/<агент>/<задача>`. Хаб передаёт только относительный ключ; ключи с `..` и абсолютные пути отклоняются. |

Что важно понимать:

- **Команды (`exec`) — это полный доступ к оболочке** с правами вашего пользователя. Ограничение папкой касается только рабочего каталога, не того, что делает команда. Включайте `exec` осознанно и по возможности со списком `allowCommands`. Хаб по умолчанию спрашивает подтверждение на каждый `machine_exec` и `machine_write_file`.
- **Интеллекты работают с правами вашего пользователя** и вашими подписками. Что им можно, задают `allowedTools` (Claude Code) и `sandbox` (Codex). Переменные окружения от хаба (кроме `TZ`, `LANG`, `LANGUAGE` и `LC_*`) не передаются, а служебные пути хаба игнорируются.
- **Папка `~/.piomio-node` недоступна** через файлы и команды хаба, даже если попадает в `allowedDirs`: хаб не может прочитать ключ или переписать политику.
- Политику правит только владелец машины; хаб её не видит целиком — он получает лишь список разрешённых папок и установленных интеллектов.

## Неполадки

- `Машина не привязана` — выполните `piomio-node pair <hub-url> <code>`.
- `Хаб отклонил привязку: Код привязки неверный или устарел` — код одноразовый и живёт 10 минут; получите новый.
- `Не удалось связаться с хабом … соединение отклонено` — хаб не запущен, слушает только `127.0.0.1` или другой порт. Проверьте адрес в браузере на этой машине.
- `Хаб не принимает адрес …` — добавьте имя хоста в `PIOMIO_ALLOWED_HOSTS` на хабе.
- `Хаб отклонил подключение (unauthorized)` — машину отозвали или ключ заменён; привяжите заново.
- Интеллекта нет в списке хаба — `piomio-node status` покажет, найден ли CLI и выполнен ли вход; проверьте `PATH` службы.
