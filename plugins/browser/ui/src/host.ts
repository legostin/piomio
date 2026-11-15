// What every part of the browser's UI shares: the host, translations, the backend's messages and their types.

import { mediaSrc, native } from "@piomio/ui";
import type { PiomioUI } from "@piomio/ui";

export interface Tab {
  index: number;
  title: string;
  url: string;
  active: boolean;
  loading?: boolean;
  /** The site's icon (an http(s) or data: URL). */
  icon?: string;
}

/** Playwright's Chromium being downloaded by the plugin (on first use). */
export interface InstallStatus {
  installing: boolean;
  step: string | null;
  progress: number | null;
  error: string | null;
}

export interface BrowserState {
  running: boolean;
  headless: boolean | null;
  control: "agent" | "user";
  busy: string | null;
  tabs: Tab[];
  url: string;
  title: string;
  loading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  searchEngine?: string;
  /** The computer this browser runs on, when the hub has several: its sign-ins are that computer's. */
  machine?: string;
  install?: InstallStatus;
  /** The person is showing an agent a task (teach mode); null otherwise. */
  teach?: TeachState | null;
}

/** A demonstration going on: the person shows the agent a task (or one step of it) in this browser. */
export interface TeachState {
  id: string;
  /** What is being shown, in the agent's words ("" when the person started it from the menu). */
  goal: string;
  scope: "task" | "step";
  startedAt: number;
  /** Steps recorded so far. */
  steps: number;
  /** The hub can write down speech: the microphone is offered. */
  speech: boolean;
}

/** The backend's "activity" event: sent on every change, whether or not anyone watches. */
export interface Activity {
  running: boolean;
  busy: string | null;
  agentId: string | null;
  url: string;
  control: "agent" | "user";
  attention: boolean;
  /** A demonstration is going on (the window opens highlighted). */
  teach?: boolean;
}

/** A page in the history (server/history.ts). */
export interface Visit {
  id: string;
  url: string;
  title: string;
  at: number;
  /** "user" or an agent's id. */
  by: string;
  icon?: string;
}

export interface Site {
  url: string;
  title: string;
  icon?: string;
  visits: number;
}

export let host: PiomioUI;
export let t: PiomioUI["i18n"]["t"] = (key) => key;

export function setHost(ui: PiomioUI): void {
  host = ui;
  t = (key, params) => ui.i18n.t(key, params);
}

export const send = (payload: Record<string, unknown>) => host.plugin.send(payload);

/** This open view among the person's devices: the backend's answers to a probe name it. */
export const viewerId = Math.random().toString(36).slice(2);

/** The backend sends `code` + `params` (ui.error.<code>) with an English `message` as a fallback. */
export function errorText(e: { message?: string; code?: string; params?: Record<string, string> } | undefined): string {
  if (e?.code) {
    const key = `ui.error.${e.code}`;
    const text = t(key, e.params ?? {});
    if (text !== key) return text;
  }
  return e?.message ? t("ui.error.other", { detail: e.message }) : t("ui.error.generic");
}

export const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** "example.com" of an http(s) address ("" for anything else). */
export function hostOf(u: string): string {
  try {
    const x = new URL(u);
    return x.protocol === "http:" || x.protocol === "https:" ? x.host.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

/** A blank tab: the live view shows the new tab page instead of a white picture. */
export const isBlank = (url: string | undefined) => !url || url === "about:blank";

/** A phone or tablet: taps and drags instead of a mouse, and a system keyboard that needs a text field. */
export const touchScreen = () => typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;

export function engineName(id: string | undefined): string {
  return t(`ui.engine.${id && ["duckduckgo", "google", "yandex", "bing"].includes(id) ? id : "duckduckgo"}`);
}

/** A site's icon through the hub's image proxy (the page's CSP keeps pictures on the hub). */
export const iconSrc = (icon: string | undefined) => (icon ? mediaSrc(icon) : undefined);

/** Agents' names for "who opened it" in the history (loaded once). */
let agentNames: Promise<Map<string, string>> | null = null;
export function loadAgentNames(): Promise<Map<string, string>> {
  agentNames ??= host.api
    .get<Array<{ id: string; name: string }>>("/api/agents")
    .then((list) => new Map(list.map((a) => [a.id, a.name])))
    .catch(() => {
      agentNames = null;
      return new Map();
    });
  return agentNames;
}

/** Open a link in the person's own browser (Safari in the iOS app). */
export function openOutside(url: string): void {
  if (native) void native.openURL(url).catch(() => window.open(url, "_blank", "noopener"));
  else window.open(url, "_blank", "noopener");
}

/** Tools with a label (ui.call.<name>). */
export const LABELED = new Set([
  "open",
  "search",
  "snapshot",
  "get_text",
  "screenshot",
  "scroll",
  "back",
  "tabs",
  "wait",
  "click",
  "type",
  "press_key",
  "fill_secret",
  "download",
  "submit",
  "history",
  "history_clear",
]);

export const toolLabel = (name: string) => (LABELED.has(name) ? t(`ui.call.${name}`) : name);
