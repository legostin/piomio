// UI plugin host: builds the per-plugin PiomioUI object and loads plugin modules listed in /api/bootstrap.

import { useEffect, type ComponentType } from "react";
import type { Catalog } from "@piomio/shared";
import type { LiveViewContribution, PiomioUI, SlotContribution, SlotName, SlotProps } from "@piomio/ui";
import { translator } from "@piomio/shared/i18n";
import { navigate } from "wouter/use-browser-location";
import { api, request, type Method } from "../lib/api";
import { createStore, useStore } from "../lib/store";
import { hubEvents, refreshBootstrap, sendToHub, session, type UiPluginEntry } from "../state/app";
import { chatOnScreen } from "../state/chat-on-screen";
import { toast } from "../state/toast";
import { formatDate, formatNumber, locale, t } from "../i18n";
import { addCommand, addContribution, addLiveView, addMapApp, addRoute, addSettings, addStatus, addWidget, normalizePath, removePlugin } from "./registry";
import { resolveActivate } from "./activate";

export interface PluginLoadState {
  name: string;
  status: "loading" | "active" | "error";
  error?: string;
}

export const pluginLoad = createStore<Record<string, PluginLoadState>>({});

function setLoad(id: string, s: PluginLoadState): void {
  pluginLoad.set((all) => ({ ...all, [id]: s }));
}

/** `messages`: the plugin's own catalog from /api/bootstrap (English plus the interface language). */
export function createPiomioUI(pluginId: string, messages: Catalog = {}): PiomioUI {
  const register = <P = any>(slot: SlotName, c: SlotContribution<P>): (() => void) => {
    switch (slot) {
      case "route":
        return addRoute(pluginId, {
          path: (c as { path?: string }).path ?? `/plugins/${pluginId}/${c.id}`,
          title: c.title ?? c.id,
          icon: c.icon,
          component: c.component as ComponentType<SlotProps>,
          nav: (c as { nav?: boolean }).nav ?? true,
        });
      case "settings.section":
        return addSettings(pluginId, { id: c.id, title: c.title ?? c.id, component: c.component as ComponentType<SlotProps> });
      case "layout.statusbar":
        return addStatus(pluginId, { id: c.id, render: c.component as ComponentType<SlotProps> });
      case "live.view":
        return addLiveView(pluginId, c as unknown as LiveViewContribution).dispose;
      default:
        return addContribution(pluginId, slot, c as SlotContribution);
    }
  };

  return {
    pluginId,
    slots: {
      register,
      override: (slot, component, opts) => register(slot, { id: `override:${slot}`, component, priority: opts?.priority ?? 0, match: opts?.match }),
    },
    routes: {
      add: (r) => addRoute(pluginId, { ...r, path: normalizePath(r.path) }),
    },
    statusbar: { add: (item) => addStatus(pluginId, item) },
    commands: { register: (c) => addCommand(pluginId, c) },
    settings: { section: (s) => addSettings(pluginId, s) },
    liveView: { register: (c) => addLiveView(pluginId, c) },
    maps: { addApp: (a) => addMapApp(pluginId, a) },
    widgets: { add: (kind, component) => addWidget(pluginId, kind, component as ComponentType<any>) },
    chat: { current: chatOnScreen },
    toast: (text, kind) => toast(text, kind ?? "info"),
    navigate: (path) => navigate(path),
    api,
    plugin: {
      http: (method, path, body) => {
        const m = String(method || "GET").toUpperCase() as Method;
        const url = `/api/plugins/${encodeURIComponent(pluginId)}/http/${String(path ?? "").replace(/^\/+/, "")}`;
        return request(m, url, m === "GET" ? undefined : body);
      },
      send: (payload) => sendToHub({ type: "plugin.message", pluginId, payload }),
      on: (channel, cb) =>
        hubEvents.on((e) => {
          if (e.type === "plugin.event" && e.data.pluginId === pluginId && e.data.channel === channel) cb(e.data.payload);
        }),
    },
    events: { on: (cb) => hubEvents.on(cb) },
    i18n: { locale, t: translator(messages, locale), formatDate, formatNumber },
  };
}

const loaded = new Map<string, { url: string; cleanup?: () => void }>();
/** Plugins loaded earlier in this page: re-imports get a cache-busting query (the plugin may have been updated). */
const everLoaded = new Set<string>();

function unload(id: string): void {
  const l = loaded.get(id);
  loaded.delete(id);
  try {
    l?.cleanup?.();
  } catch (e) {
    console.error(`[ui-plugin ${id}] cleanup failed`, e);
  }
  removePlugin(id);
  pluginLoad.set((all) => {
    const next = { ...all };
    delete next[id];
    return next;
  });
}

async function load(entry: UiPluginEntry): Promise<void> {
  const reload = everLoaded.has(entry.id);
  everLoaded.add(entry.id);
  loaded.set(entry.id, { url: entry.url });
  setLoad(entry.id, { name: entry.name, status: "loading" });
  try {
    const url = reload ? `${entry.url}${entry.url.includes("?") ? "&" : "?"}v=${Date.now()}` : entry.url;
    const mod = await import(/* @vite-ignore */ url);
    const activate = resolveActivate(mod);
    if (!activate) throw new Error(t("plugins.noActivate"));
    const ret = await activate(createPiomioUI(entry.id, entry.messages));
    const cur = loaded.get(entry.id);
    if (cur) cur.cleanup = typeof ret === "function" ? ret : undefined;
    setLoad(entry.id, { name: entry.name, status: "active" });
  } catch (e) {
    if (!ours(entry)) return;
    removePlugin(entry.id);
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ui-plugin ${entry.id}] failed to load`, e);
    // A hub of several replicas may hand the lead over between the list and the import: the list came from one hub,
    // the module was asked of the next, which may not have that plugin (or has another revision). Only what the hub
    // lists now is worth a word; the sync after the new list loads that.
    if (!(await stillListed(entry)) || !ours(entry)) return;
    setLoad(entry.id, { name: entry.name, status: "error", error: msg });
    toast(t("plugins.loadFailed", { name: entry.name, error: msg }), "error");
  }
}

/** This load is still the one for its plugin (no later sync unloaded or replaced it). */
const ours = (entry: UiPluginEntry): boolean => loaded.get(entry.id)?.url === entry.url;

async function stillListed(entry: UiPluginEntry): Promise<boolean> {
  await refreshBootstrap();
  return (session.get()?.uiPlugins ?? []).some((e) => e.id === entry.id && e.url === entry.url);
}

/** Load new UI plugins and unload ones that disappeared (called after bootstrap and on plugins.updated). */
export async function syncUiPlugins(entries: UiPluginEntry[]): Promise<void> {
  for (const [id, l] of [...loaded]) if (!entries.some((e) => e.id === id && e.url === l.url)) unload(id);
  await Promise.allSettled(entries.filter((e) => !loaded.has(e.id)).map(load));
}

export function unloadAllUiPlugins(): void {
  for (const id of [...loaded.keys()]) unload(id);
}

/** Load the UI plugins the hub lists, follow changes, and unload them when the signed-in view goes away. */
export function useUiPlugins(): void {
  const uiPlugins = useStore(session)?.uiPlugins;
  const key = JSON.stringify(uiPlugins ?? []);
  useEffect(() => {
    void syncUiPlugins(uiPlugins ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => () => unloadAllUiPlugins(), []);
}
