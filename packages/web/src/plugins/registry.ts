// Registry of UI plugin contributions (slots, routes, status bar items, commands, settings sections, live views).
// State is an immutable snapshot so React can subscribe with useSyncExternalStore.

import type { ComponentType } from "react";
import type { Message } from "@piomio/shared";
import type { LiveViewContribution, LiveViewHandle, LiveViewProps, MapAppContribution, SlotContribution, SlotName, SlotProps, WidgetProps } from "@piomio/ui";
import { createStore } from "../lib/store";
import { globSpecificity, matchesGlob } from "../lib/glob";
import { applyActivity, IDLE_VIEW, type LiveViewState } from "./liveview";

export interface Contribution extends SlotContribution {
  pluginId: string;
  slot: SlotName;
  /** Unique registration key (pluginId + sequence). */
  key: string;
  /** Registration order, later wins ties. */
  seq: number;
}

export interface RouteEntry {
  pluginId: string;
  key: string;
  path: string;
  title: string;
  icon?: string;
  component: ComponentType<SlotProps>;
  nav: boolean;
  /** Drawn alone, without the sidebar and panels (the desktop app's overlay window). */
  bare?: boolean;
}

export interface StatusEntry {
  pluginId: string;
  key: string;
  id: string;
  render: ComponentType<SlotProps>;
}

export interface CommandEntry {
  pluginId: string;
  key: string;
  id: string;
  title: string;
  run: () => void | Promise<void>;
}

export interface SettingsEntry {
  pluginId: string;
  key: string;
  id: string;
  title: string;
  component: ComponentType<SlotProps>;
}

export interface LiveViewEntry extends LiveViewState {
  pluginId: string;
  key: string;
  id: string;
  title: string;
  icon?: string;
  component: ComponentType<LiveViewProps>;
}

export interface MapAppEntry extends MapAppContribution {
  pluginId: string;
  key: string;
}

/** A plugin's chat card renderer (ui.widgets.add). */
export interface WidgetEntry {
  pluginId: string;
  key: string;
  kind: string;
  component: ComponentType<WidgetProps>;
}

export interface RegistryState {
  contributions: Contribution[];
  routes: RouteEntry[];
  statusbar: StatusEntry[];
  commands: CommandEntry[];
  settings: SettingsEntry[];
  liveViews: LiveViewEntry[];
  mapApps: MapAppEntry[];
  widgets: WidgetEntry[];
}

export const registry = createStore<RegistryState>({ contributions: [], routes: [], statusbar: [], commands: [], settings: [], liveViews: [], mapApps: [], widgets: [] });

let seq = 0;
function nextKey(pluginId: string): { key: string; seq: number } {
  seq++;
  return { key: `${pluginId}#${seq}`, seq };
}

type ListKey = keyof RegistryState;

function addTo<K extends ListKey>(list: K, item: RegistryState[K][number]): () => void {
  registry.set((s) => ({ ...s, [list]: [...s[list], item] }));
  const key = (item as { key: string }).key;
  return () => registry.set((s) => ({ ...s, [list]: (s[list] as Array<{ key: string }>).filter((x) => x.key !== key) }));
}

export function addContribution(pluginId: string, slot: SlotName, c: SlotContribution): () => void {
  if (!c || (typeof c.component !== "function" && (typeof c.component !== "object" || c.component === null))) throw new Error(`slot ${slot}: component is required`);
  const k = nextKey(pluginId);
  return addTo("contributions", { ...c, id: c.id ?? k.key, pluginId, slot, ...k });
}

export function addRoute(pluginId: string, r: { path: string; title: string; icon?: string; component: ComponentType<SlotProps>; nav?: boolean; bare?: boolean }): () => void {
  const path = normalizePath(r.path);
  const bare = r.bare === true;
  return addTo("routes", { pluginId, key: nextKey(pluginId).key, path, title: r.title, icon: r.icon, component: r.component, nav: bare ? false : (r.nav ?? true), ...(bare ? { bare } : {}) });
}

export function addStatus(pluginId: string, item: { id: string; render: ComponentType<SlotProps> }): () => void {
  return addTo("statusbar", { pluginId, key: nextKey(pluginId).key, id: item.id, render: item.render });
}

export function addCommand(pluginId: string, c: { id: string; title: string; run: () => void | Promise<void> }): () => void {
  return addTo("commands", { pluginId, key: nextKey(pluginId).key, id: c.id, title: c.title, run: c.run });
}

export function addSettings(pluginId: string, s: { id: string; title: string; component: ComponentType<SlotProps> }): () => void {
  return addTo("settings", { pluginId, key: nextKey(pluginId).key, id: s.id, title: s.title, component: s.component });
}

export function addLiveView(pluginId: string, c: LiveViewContribution): LiveViewHandle {
  if (!c || (typeof c.component !== "function" && (typeof c.component !== "object" || c.component === null))) throw new Error("live view: component is required");
  const { key } = nextKey(pluginId);
  const dispose = addTo("liveViews", { ...IDLE_VIEW, pluginId, key, id: c.id ?? key, title: c.title ?? c.id ?? key, icon: c.icon, component: c.component });
  return {
    update: (patch) =>
      registry.set((s) => {
        const i = s.liveViews.findIndex((v) => v.key === key);
        if (i < 0) return s;
        const liveViews = s.liveViews.slice();
        liveViews[i] = { ...liveViews[i], ...applyActivity(liveViews[i], patch ?? {}, Date.now()) };
        return { ...s, liveViews };
      }),
    dispose,
  };
}

export function addMapApp(pluginId: string, a: MapAppContribution): () => void {
  if (!a || typeof a.place !== "function") throw new Error("maps.addApp: place() is required");
  return addTo("mapApps", { ...a, pluginId, key: nextKey(pluginId).key });
}

export function addWidget(pluginId: string, kind: string, component: ComponentType<WidgetProps>): () => void {
  if (typeof component !== "function" && (typeof component !== "object" || component === null)) throw new Error(`widgets.add ${kind}: component is required`);
  return addTo("widgets", { pluginId, key: nextKey(pluginId).key, kind: String(kind), component });
}

/** The renderer of a plugin's card: the one it registered last for the kind. */
export function pickWidget(widgets: WidgetEntry[], pluginId: string, kind: string): WidgetEntry | undefined {
  return widgets.findLast((w) => w.pluginId === pluginId && w.kind === kind);
}

/** Drop everything a plugin registered (on unload / disable). */
export function removePlugin(pluginId: string): void {
  registry.set((s) => ({
    contributions: s.contributions.filter((x) => x.pluginId !== pluginId),
    routes: s.routes.filter((x) => x.pluginId !== pluginId),
    statusbar: s.statusbar.filter((x) => x.pluginId !== pluginId),
    commands: s.commands.filter((x) => x.pluginId !== pluginId),
    settings: s.settings.filter((x) => x.pluginId !== pluginId),
    liveViews: s.liveViews.filter((x) => x.pluginId !== pluginId),
    mapApps: s.mapApps.filter((x) => x.pluginId !== pluginId),
    widgets: s.widgets.filter((x) => x.pluginId !== pluginId),
  }));
}

export function normalizePath(p: string): string {
  let path = String(p || "/").trim();
  if (!path.startsWith("/")) path = "/" + path;
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path;
}

// ---------- selection (pure) ----------

export function inSlot(contribs: Contribution[], slot: SlotName): Contribution[] {
  return contribs.filter((c) => c.slot === slot).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.seq - b.seq);
}

function toolGlobs(c: Contribution): string[] {
  const t = c.match?.tool as string | string[] | undefined;
  return !t ? [] : Array.isArray(t) ? t : [t];
}

/** Best chat.toolResult renderer for a tool name: highest priority, then most specific glob, then latest. */
export function pickToolRenderer(contribs: Contribution[], toolName: string): Contribution | undefined {
  let best: { c: Contribution; spec: number } | undefined;
  for (const c of contribs) {
    if (c.slot !== "chat.toolResult") continue;
    const matching = toolGlobs(c).filter((g) => matchesGlob(toolName, g));
    if (!matching.length) continue;
    const spec = Math.max(...matching.map(globSpecificity));
    if (!best) best = { c, spec };
    else {
      const dp = (c.priority ?? 0) - (best.c.priority ?? 0);
      if (dp > 0 || (dp === 0 && (spec > best.spec || (spec === best.spec && c.seq > best.c.seq)))) best = { c, spec };
    }
  }
  return best?.c;
}

/** chat.message override for a message: all given match fields must equal; highest priority, then latest. */
export function pickMessageRenderer(contribs: Contribution[], m: Pick<Message, "role" | "agentId">): Contribution | undefined {
  let best: Contribution | undefined;
  for (const c of contribs) {
    if (c.slot !== "chat.message") continue;
    if (c.match?.role && c.match.role !== m.role) continue;
    if (c.match?.agentId && c.match.agentId !== m.agentId) continue;
    if (!best || (c.priority ?? 0) > (best.priority ?? 0) || ((c.priority ?? 0) === (best.priority ?? 0) && c.seq > best.seq)) best = c;
  }
  return best;
}

/** Highest-priority (then latest) contribution for single-instance slots such as chat.composer. */
export function pickOverride(contribs: Contribution[], slot: SlotName): Contribution | undefined {
  let best: Contribution | undefined;
  for (const c of contribs) {
    if (c.slot !== slot) continue;
    if (!best || (c.priority ?? 0) > (best.priority ?? 0) || ((c.priority ?? 0) === (best.priority ?? 0) && c.seq > best.seq)) best = c;
  }
  return best;
}

/** Plugin route for a path (exact match, then the longest prefix registered with a trailing "/*"). */
export function matchRoute(routes: RouteEntry[], path: string): RouteEntry | undefined {
  const p = normalizePath(path);
  const exact = routes.filter((r) => r.path === p).pop();
  if (exact) return exact;
  let best: RouteEntry | undefined;
  for (const r of routes) {
    if (!r.path.endsWith("/*")) continue;
    const base = r.path.slice(0, -2);
    if ((p === base || p.startsWith(base + "/")) && (!best || r.path.length > best.path.length)) best = r;
  }
  return best;
}
