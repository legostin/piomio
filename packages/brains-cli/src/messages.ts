// Messages the CLI brains show to people (probe details, failures). The caller passes the language.

import { DEFAULT_LOCALE, translator, type Catalog, type Locale, type Translate } from "@piomio/shared/i18n";

const en = {
  "claude.label": "Claude Code",
  "claude.notInstalled": "Claude Code is not installed (the claude command was not found)",
  "claude.notInstalledShort": "Claude Code is not installed",
  "claude.notSignedIn": "Claude Code is not signed in: ask the assistant to sign in to Claude Code, or paste a token from `claude setup-token` into the chat",
  "claude.failed": "Claude Code exited with an error",
  "claude.mcpUnavailable": "Piomio tools are unavailable in Claude Code (MCP: {status})",
  "claude.limit": "Claude: subscription limit ({kind})",
  "claude.vaultToken": "token from the vault",
  "claude.signedIn": "signed in: {method}",
  "claude.noLogin": "not signed in: sign in from the chat or paste a token from `claude setup-token`",
  "claude.loginUnknown": "could not check the sign-in: sign in from the chat or paste a token from `claude setup-token`",
  "codex.label": "Codex (ChatGPT)",
  "codex.notInstalled": "Codex CLI is not installed",
  "codex.notSignedIn": "Codex is not signed in: ask the assistant to sign in to Codex",
  "codex.failed": "Codex exited with an error",
  "codex.apiKey": "API key",
  "codex.noLogin": "not signed in: sign in from the chat",
  "kimi.label": "Kimi Code",
  "kimi.notInstalled": "Kimi Code CLI is not installed (the kimi command was not found)",
  "kimi.notSignedIn": "Kimi Code is not signed in: ask the assistant to sign in to Kimi Code",
  "kimi.failed": "Kimi Code exited with an error",
  "kimi.refused": "Kimi declined to answer this (its provider's content policy)",
  "kimi.noPlan": "Kimi Code: this Kimi account's plan does not include Kimi Code ({detail})",
  "kimi.signedIn": "signed in with the Kimi account",
  "kimi.noLogin": "not signed in: sign in from the chat",
  "kimi.checkFailed": "could not check Kimi Code: {detail}",
  "login.failed": "Sign-in failed: {detail}",
  "login.expired": "The code expired before the sign-in was finished",
  "login.noCode": "This sign-in is not waiting for a code",
  "login.badCode": "Paste the whole code from the sign-in page",
};

const ru: Record<keyof typeof en, string> = {
  "claude.label": "Claude Code",
  "claude.notInstalled": "Claude Code не установлен (команда claude не найдена)",
  "claude.notInstalledShort": "Claude Code не установлен",
  "claude.notSignedIn": "Claude Code не авторизован: попросите ассистента войти в Claude Code или вставьте в чат токен из `claude setup-token`",
  "claude.failed": "Claude Code завершился с ошибкой",
  "claude.mcpUnavailable": "Инструменты Piomio недоступны в Claude Code (MCP: {status})",
  "claude.limit": "Claude: лимит подписки ({kind})",
  "claude.vaultToken": "токен из хранилища",
  "claude.signedIn": "вход: {method}",
  "claude.noLogin": "нет входа: войдите из чата или вставьте токен из `claude setup-token`",
  "claude.loginUnknown": "не удалось проверить вход: войдите из чата или вставьте токен из `claude setup-token`",
  "codex.label": "Codex (ChatGPT)",
  "codex.notInstalled": "Codex CLI не установлен",
  "codex.notSignedIn": "Codex не авторизован: попросите ассистента войти в Codex",
  "codex.failed": "Codex завершился с ошибкой",
  "codex.apiKey": "ключ API",
  "codex.noLogin": "нет входа: войдите из чата",
  "kimi.label": "Kimi Code",
  "kimi.notInstalled": "Kimi Code CLI не установлен (команда kimi не найдена)",
  "kimi.notSignedIn": "Kimi Code не авторизован: попросите ассистента войти в Kimi Code",
  "kimi.failed": "Kimi Code завершился с ошибкой",
  "kimi.refused": "Kimi отказался отвечать на это (правила его провайдера)",
  "kimi.noPlan": "Kimi Code: тариф этого аккаунта Kimi не включает Kimi Code ({detail})",
  "kimi.signedIn": "вход через аккаунт Kimi",
  "kimi.noLogin": "нет входа: войдите из чата",
  "kimi.checkFailed": "не удалось проверить Kimi Code: {detail}",
  "login.failed": "Вход не удался: {detail}",
  "login.expired": "Код истёк раньше, чем вход был завершён",
  "login.noCode": "Этот вход не ждёт кода",
  "login.badCode": "Вставьте код со страницы входа целиком",
};

export const brainsCatalog: Catalog = { en, ru };

const cache = new Map<Locale, Translate>();

/** Translate function for a language (English when none is given). */
export function brainsT(locale: Locale = DEFAULT_LOCALE): Translate {
  let t = cache.get(locale);
  if (!t) cache.set(locale, (t = translator(brainsCatalog, locale)));
  return t;
}
