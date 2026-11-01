// What piomio-node says to the person at this machine (CLI output, logs), in their language
// (PIOMIO_LANG / LC_ALL / LC_MESSAGES / LANG, English by default). Errors returned to the hub over RPC
// reach the agent as tool results, so they stay in English and are not translated.

import { DEFAULT_LOCALE, localeFromEnv, translator, type Catalog, type Locale, type Params, type Translate } from "@piomio/shared/i18n";

const en = {
  // cli
  "cli.help":
    "piomio-node — connects this computer to an Piomio hub\n\nCommands:\n  piomio-node pair <invite-link> [--name <name>]      pair this machine (ask Piomio in the chat to connect a computer)\n  piomio-node run                                     connect to the hub and serve requests (in the terminal)\n  piomio-node status                                  pairing, policy, installed CLIs, hub reachability\n  piomio-node policy                                  path and contents of the policy file\n\nState folder: {home} (override with PIOMIO_NODE_HOME)",
  "cli.pairUsage": "Usage: piomio-node pair <invite-link> [--name <name>]\nExample: piomio-node pair https://piomio.example.ts.net/join/AB12CD34\nThe link comes from the chat: ask Piomio to connect a computer.",
  "cli.badLink": "{link} is not an Piomio invite link. It looks like https://<hub>/join/<code>: ask Piomio in the chat to connect a computer.",
  "cli.checkingClis": "Checking installed CLIs…",
  "cli.paired": "\nThis machine is paired with the hub {hub}: “{name}” ({id})",
  "cli.replaced": "The previous pairing ({id}) was replaced — you can revoke it in the web UI.",
  "cli.line.key": "Key:      {file}",
  "cli.line.policy": "Policy:   {file}",
  "cli.line.brains": "Brains:   {list}",
  "cli.brain.present": "{id} — installed{version}",
  "cli.brain.noLoginSuffix": " (not signed in)",
  "cli.brain.absent": "{id} — {detail}",
  "cli.brain.none": "none",
  "cli.next": "\nNext: piomio-node run   (or install it as a service — see the README)",
  "cli.run.header": "piomio-node: machine “{name}” ({id}), hub {hub}",
  "cli.run.policy": "Policy:   {file} (changes apply on the fly)",
  "cli.stopping": "{signal}: stopping…",
  "cli.unhandledRejection": "unhandled error: {error}",
  "cli.uncaughtException": "uncaught exception: {error}",
  "cli.status.home": "Folder:   {home}",
  "cli.status.hub": "Hub:      {hub}",
  "cli.status.machine": "Machine:  “{name}” ({id})",
  "cli.status.pairedAt": ", paired {at}",
  "cli.status.notPaired": "Pairing:  none (piomio-node pair <hub-url> <code>)",
  "cli.status.pairError": "Pairing:  error — {error}",
  "cli.status.system": "System:   {os}, {arch}, Node {node}",
  "cli.status.brains": "Brain CLIs:",
  "cli.status.brainInstalled": "  {id}: installed{version}, {login}{detail}",
  "cli.status.brainMissing": "  {id}: unavailable{detail}",
  "cli.status.signedIn": "signed in",
  "cli.status.notSignedIn": "not signed in",
  "cli.status.hubOk": "Hub is reachable (Piomio {version})",
  "cli.status.hubStatus": "Hub answered {status}",
  "cli.policy.notPaired": "\n(this machine is not paired yet: piomio-node pair <hub-url> <code>)",
  "cli.unknownCommand": "Unknown command “{command}”.\n\n{help}",
  "cli.error": "Error: {error}",
  // pairing and the hub address
  "net.refused": "connection refused — the hub is not running or listens on another address/port",
  "net.notFound": "host name not found",
  "net.timeout": "timed out",
  "net.tls": "TLS certificate error ({detail})",
  "net.unreachable": "Could not reach the hub {hub}: {reason}.\nCheck the address. If the hub is on another network, connect both machines to Tailscale and use the hub's tailnet address.",
  "net.phoneAddress": "{hub} answers with the hub's own certificate: this is the address for phones. Machines connect to the hub's main address — the one shown in the web UI under Machines → Connect a machine.",
  "pair.noCode": "No pairing code. Get one in the hub's web UI: Machines → Connect a machine.",
  "pair.rejected": "The hub rejected the pairing: {error}.",
  "pair.badRequest": "bad request",
  "pair.tooMany": "Too many failed pairing attempts. Wait 15 minutes.",
  "pair.badHost": "The hub does not accept the address {host}. Add it to PIOMIO_ALLOWED_HOSTS on the hub.",
  "pair.notHub": "There is no Piomio hub at {hub} (404). Check the address.",
  "pair.hubError": "The hub answered with error {status}{detail}",
  "pair.unexpected": "The hub sent an unexpected answer (no machineId). Is this really Piomio?",
  "home.notPaired": "This machine is not paired with a hub (no {file}).\nFirst run: piomio-node pair <hub-url> <code>",
  "home.readFailed": "Could not read {file}: {error}",
  "home.configCorrupt": "{file} is damaged: no hubUrl or machineId. Pair the machine again: piomio-node pair <hub-url> <code>",
  "home.keyCorrupt": "{file} is damaged: pair the machine again",
  "home.badUrl": "Invalid hub address “{url}”. Example: https://bot.example.com or http://100.64.0.1:8080",
  "home.badScheme": "The hub address must start with http:// or https:// (got “{url}”)",
  // connection
  "client.helloTimeout": "the hub did not answer in time",
  "client.rejected": "The hub refused the connection ({reason}): the machine was revoked or the key does not match.\nPair the machine again: piomio-node pair {hub} <code>",
  "client.lost": "lost the connection to the hub ({code})",
  "client.retry": "hub {hub} is unreachable ({reason}), retrying in {after}",
  "client.reconnect": "reconnecting in {after}",
  "client.ms": "{n} ms",
  "client.sec": "{n} s",
  "client.connected": "connected to the hub {hub} as “{name}”",
  "client.pingLost": "the hub does not answer pings, reconnecting",
  "client.helloFailed": "node.hello failed: {error}",
  "client.offline": "not connected to the hub",
  "client.brains": "brains: {list}",
  // policy file
  "policy.expectedPath": "{field}: expected a non-empty path",
  "policy.mustBeAbsolute": "{field}: the path must be absolute (or start with ~): {path}",
  "policy.expectedBool": "{field}: expected true or false",
  "policy.expectedStrings": "{field}: expected an array of strings",
  "policy.expectedObject": "expected a JSON object",
  "policy.sandbox": "brains.codex.sandbox: one of {values}",
  "policy.maxTimeout": "exec.maxTimeoutMs: expected a positive number",
  "policy.expectedString": "{field}: expected a string",
  "policy.created": "created a policy file with safe settings: {file}",
  "policy.mkdirFailed": "could not create {dir}: {error}",
  "policy.errorIn": "Error in {file}: {error}",
  "policy.keepPrevious": "error in {file}: {error} — keeping the previous policy",
  "policy.reloaded": "policy reloaded",
  "policy.summary.dirs": "Allowed folders: {dirs}",
  "policy.summary.workspaces": "Brain workspaces: {dir}",
  "policy.summary.files": "Files: read {read}, write {write}",
  "policy.summary.commands": "Commands: {commands}",
  "policy.summary.claude": "Claude Code: {state}",
  "policy.summary.codex": "Codex: {state}",
  "policy.summary.claudeOn": "enabled, tools: {tools}",
  "policy.summary.codexOn": "enabled, sandbox {sandbox}",
  "policy.summary.kimi": "Kimi Code: {state}",
  "policy.summary.kimiOn": "enabled, commands and writes as the policy allows",
  "policy.summary.off": "disabled",
  "policy.summary.yes": "yes",
  "policy.summary.no": "no",
  "policy.summary.none": "none",
  "policy.summary.anyCommand": "any",
  "policy.summary.onlyCommands": "only {list}",
  "policy.summary.noCommands": "not allowed",
  // brains (shown in the hub's brain list, in the hub's language)
  "brains.disabled": "disabled in policy.json",
  "brains.keyVia": "API key from the hub ({providers})",
  "brains.keyMissing": "API key mode, but the hub has no key for it yet",
  "brains.keyWaitsVault": "API key mode: waiting for the hub's vault to be unlocked",
  "gateway.ready": "model gateway on 127.0.0.1:{port}",
  "gateway.setup": "setup from the hub: {brains}",
  "update.applied": "updated to Piomio {version} by the hub: restarting",
};

const ru: Record<keyof typeof en, string> = {
  "cli.help":
    "piomio-node — подключает этот компьютер к хабу Piomio\n\nКоманды:\n  piomio-node pair <ссылка> [--name <имя>]             привязать машину (попросите Piomio в чате подключить компьютер)\n  piomio-node run                                     подключиться к хабу и обслуживать запросы (в консоли)\n  piomio-node status                                  привязка, политика, установленные CLI, доступность хаба\n  piomio-node policy                                  путь и содержимое файла политики\n\nПапка состояния: {home} (переопределяется PIOMIO_NODE_HOME)",
  "cli.pairUsage": "Использование: piomio-node pair <ссылка> [--name <имя>]\nПример: piomio-node pair https://piomio.example.ts.net/join/AB12CD34\nСсылку даёт чат: попросите Piomio подключить компьютер.",
  "cli.badLink": "{link} — не ссылка-приглашение Piomio. Она выглядит как https://<хаб>/join/<код>: попросите Piomio в чате подключить компьютер.",
  "cli.checkingClis": "Проверяю установленные CLI…",
  "cli.paired": "\nМашина привязана к хабу {hub}: «{name}» ({id})",
  "cli.replaced": "Предыдущая привязка ({id}) заменена — её можно отозвать в веб-интерфейсе.",
  "cli.line.key": "Ключ:      {file}",
  "cli.line.policy": "Политика:  {file}",
  "cli.line.brains": "Интеллект: {list}",
  "cli.brain.present": "{id} — есть{version}",
  "cli.brain.noLoginSuffix": " (нет входа)",
  "cli.brain.absent": "{id} — {detail}",
  "cli.brain.none": "нет",
  "cli.next": "\nДальше: piomio-node run   (или установите как службу — см. README)",
  "cli.run.header": "piomio-node: машина «{name}» ({id}), хаб {hub}",
  "cli.run.policy": "Политика: {file} (изменения применяются на лету)",
  "cli.stopping": "{signal}: остановка…",
  "cli.unhandledRejection": "необработанная ошибка: {error}",
  "cli.uncaughtException": "необработанное исключение: {error}",
  "cli.status.home": "Папка:    {home}",
  "cli.status.hub": "Хаб:      {hub}",
  "cli.status.machine": "Машина:   «{name}» ({id})",
  "cli.status.pairedAt": ", привязана {at}",
  "cli.status.notPaired": "Привязка: нет (piomio-node pair <адрес-хаба> <код>)",
  "cli.status.pairError": "Привязка: ошибка — {error}",
  "cli.status.system": "Система:  {os}, {arch}, Node {node}",
  "cli.status.brains": "CLI интеллекта:",
  "cli.status.brainInstalled": "  {id}: установлен{version}, {login}{detail}",
  "cli.status.brainMissing": "  {id}: недоступен{detail}",
  "cli.status.signedIn": "вход выполнен",
  "cli.status.notSignedIn": "нет входа",
  "cli.status.hubOk": "Хаб доступен (Piomio {version})",
  "cli.status.hubStatus": "Хаб ответил {status}",
  "cli.policy.notPaired": "\n(машина ещё не привязана: piomio-node pair <адрес-хаба> <код>)",
  "cli.unknownCommand": "Неизвестная команда «{command}».\n\n{help}",
  "cli.error": "Ошибка: {error}",
  "net.refused": "соединение отклонено — хаб не запущен или слушает другой адрес/порт",
  "net.notFound": "имя хоста не найдено",
  "net.timeout": "превышено время ожидания",
  "net.tls": "ошибка TLS-сертификата ({detail})",
  "net.unreachable": "Не удалось связаться с хабом {hub}: {reason}.\nПроверьте адрес. Если хаб в другой сети — подключите обе машины к Tailscale и используйте адрес хаба в tailnet.",
  "net.phoneAddress": "{hub} отвечает собственным сертификатом хаба: это адрес для телефонов. Машины подключаются к основному адресу хаба — он показан в веб-интерфейсе: «Машины» → «Подключить машину».",
  "pair.noCode": "Не задан код привязки. Получите его в веб-интерфейсе хаба: «Машины» → «Подключить машину».",
  "pair.rejected": "Хаб отклонил привязку: {error}.",
  "pair.badRequest": "неверный запрос",
  "pair.tooMany": "Слишком много неудачных попыток привязки. Подождите 15 минут.",
  "pair.badHost": "Хаб не принимает адрес {host}. Добавьте его в PIOMIO_ALLOWED_HOSTS на хабе.",
  "pair.notHub": "По адресу {hub} нет хаба Piomio (404). Проверьте адрес.",
  "pair.hubError": "Хаб ответил ошибкой {status}{detail}",
  "pair.unexpected": "Хаб вернул неожиданный ответ (нет machineId). Это точно Piomio?",
  "home.notPaired": "Машина не привязана к хабу (нет {file}).\nСначала выполните: piomio-node pair <адрес-хаба> <код>",
  "home.readFailed": "Не удалось прочитать {file}: {error}",
  "home.configCorrupt": "{file} повреждён: нет hubUrl или machineId. Привяжите машину заново: piomio-node pair <адрес-хаба> <код>",
  "home.keyCorrupt": "{file} повреждён: привяжите машину заново",
  "home.badUrl": "Неверный адрес хаба «{url}». Пример: https://bot.example.com или http://100.64.0.1:8080",
  "home.badScheme": "Адрес хаба должен начинаться с http:// или https:// (получено «{url}»)",
  "client.helloTimeout": "хаб не ответил вовремя",
  "client.rejected": "Хаб отклонил подключение ({reason}): машина отозвана или ключ не подходит.\nПривяжите машину заново: piomio-node pair {hub} <код>",
  "client.lost": "соединение с хабом потеряно ({code})",
  "client.retry": "хаб {hub} недоступен ({reason}), повтор через {after}",
  "client.reconnect": "переподключение через {after}",
  "client.ms": "{n} мс",
  "client.sec": "{n} с",
  "client.connected": "подключено к хабу {hub} как «{name}»",
  "client.pingLost": "хаб не отвечает на ping, переподключение",
  "client.helloFailed": "node.hello не удался: {error}",
  "client.offline": "нет соединения с хабом",
  "client.brains": "интеллект: {list}",
  "policy.expectedPath": "{field}: ожидается непустая строка с путём",
  "policy.mustBeAbsolute": "{field}: путь должен быть абсолютным (или начинаться с ~): {path}",
  "policy.expectedBool": "{field}: ожидается true или false",
  "policy.expectedStrings": "{field}: ожидается массив строк",
  "policy.expectedObject": "ожидается JSON-объект",
  "policy.sandbox": "brains.codex.sandbox: одно из {values}",
  "policy.maxTimeout": "exec.maxTimeoutMs: ожидается положительное число",
  "policy.expectedString": "{field}: ожидается строка",
  "policy.created": "создан файл политики с безопасными настройками: {file}",
  "policy.mkdirFailed": "не удалось создать {dir}: {error}",
  "policy.errorIn": "Ошибка в {file}: {error}",
  "policy.keepPrevious": "ошибка в {file}: {error} — продолжаю с предыдущей политикой",
  "policy.reloaded": "политика перечитана",
  "policy.summary.dirs": "Разрешённые папки: {dirs}",
  "policy.summary.workspaces": "Рабочие папки интеллекта: {dir}",
  "policy.summary.files": "Файлы: чтение {read}, запись {write}",
  "policy.summary.commands": "Команды: {commands}",
  "policy.summary.claude": "Claude Code: {state}",
  "policy.summary.codex": "Codex: {state}",
  "policy.summary.claudeOn": "включён, инструменты: {tools}",
  "policy.summary.codexOn": "включён, песочница {sandbox}",
  "policy.summary.kimi": "Kimi Code: {state}",
  "policy.summary.kimiOn": "включён, команды и запись — как разрешает политика",
  "policy.summary.off": "отключён",
  "policy.summary.yes": "да",
  "policy.summary.no": "нет",
  "policy.summary.none": "нет",
  "policy.summary.anyCommand": "любые",
  "policy.summary.onlyCommands": "только {list}",
  "policy.summary.noCommands": "запрещены",
  "brains.disabled": "отключён в policy.json",
  "brains.keyVia": "ключ API от хаба ({providers})",
  "brains.keyMissing": "режим ключа API, но у хаба ещё нет ключа",
  "brains.keyWaitsVault": "режим ключа API: ждёт, пока хранилище хаба разблокируют",
  "gateway.ready": "шлюз моделей на 127.0.0.1:{port}",
  "gateway.setup": "настройка от хаба: {brains}",
  "update.applied": "хаб обновил программу до Piomio {version}: перезапуск",
};

export const nodeCatalog: Catalog = { en, ru };

let local: Locale | undefined;
let hub: Locale | undefined;
const cache = new Map<Locale, Translate>();

function tr(locale: Locale): Translate {
  let t = cache.get(locale);
  if (!t) cache.set(locale, (t = translator(nodeCatalog, locale)));
  return t;
}

/** Language of the person at this machine. */
export function nodeLocale(): Locale {
  return (local ??= localeFromEnv(process.env) ?? DEFAULT_LOCALE);
}

/** For tests and embedders: pin the local language (undefined re-reads the environment). */
export function setNodeLocale(locale: Locale | undefined): void {
  local = locale;
}

/** Language of the hub this machine serves (from node.hello); texts the hub shows its users use it. */
export function hubLocale(): Locale {
  return hub ?? nodeLocale();
}

export function setHubLocale(locale: Locale | undefined): void {
  hub = locale;
}

/** A message in the local language. */
export function t(key: string, params?: Params): string {
  return tr(nodeLocale())(key, params);
}

/** A message in the hub's language. */
export function tHub(key: string, params?: Params): string {
  return tr(hubLocale())(key, params);
}
