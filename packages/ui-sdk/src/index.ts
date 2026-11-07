// @piomio/ui — the contract between the web UI host and UI plugins.
//
// A UI plugin is an ES module (built by scripts/build-ui-plugins.mjs) whose default export or named export
// `activate(ui: PiomioUI)` registers contributions. "react", "react/jsx-runtime", "react-dom" and "@piomio/ui"
// are provided by the host through an import map (shared instances); plugins must not bundle them.
//
// At runtime "@piomio/ui" resolves to /shared/piomio-ui.js, which re-exports `window.__PIOMIO_SHARED__.ui`
// (the host's implementation of everything exported below as values).

import type { ComponentType, ReactNode } from "react";
import type { Locale, Message, MessagePart, Params, RouteMode, Task, UiEvent } from "@piomio/shared";

// ---------- slots ----------

export type SlotName =
  | "layout.sidebar" // extra items at the bottom of the left navigation
  | "layout.statusbar" // small items in the status bar
  | "sidebar.panel" // collapsible panels in the left sidebar
  | "pane.right" // right-side pane tabs
  | "live.view" // the floating live view of an agent's screen (prefer ui.liveView.register: it reports activity)
  | "chat.message" // replace rendering of a whole message (match by role / agent)
  | "chat.toolResult" // custom renderer for a tool call + result (match by tool name glob)
  | "chat.composer" // wrap/replace the message composer
  | "chat.composerActions" // extra buttons next to the send button
  | "settings.section" // extra section on the settings page
  | "route"; // full page (prefer ui.routes.add)

export interface SlotProps {
  pluginId: string;
}

export interface ToolResultProps extends SlotProps {
  call: Extract<MessagePart, { type: "tool_call" }>;
  result?: Extract<MessagePart, { type: "tool_result" }>;
  message: Message;
}

export interface MessageProps extends SlotProps {
  message: Message;
  /** Render the default message (for wrappers). */
  Default: ComponentType<{ message: Message }>;
}

export interface ComposerProps extends SlotProps {
  conversationId: string;
  /** Default composer, for wrappers. */
  Default: ComponentType<{ conversationId: string }>;
  send(text: string): Promise<void>;
}

export interface SlotContribution<P = any> {
  id: string;
  title?: string;
  /** Lucide icon name (e.g. "globe", "brain") or an emoji. */
  icon?: string;
  component: ComponentType<P>;
  /** chat.toolResult: tool name globs, e.g. ["browser_*"]. chat.message: {role?, agentId?}. */
  match?: { tool?: string[]; role?: Message["role"]; agentId?: string };
  /** Higher wins for overrides; default 0. */
  priority?: number;
  /**
   * chat.toolResult: the renderer is a line meant for the person ("Remembered: …"), shown in the chat without the
   * details mode; a message holding only such calls is shown too. Default: a service detail, like core tool cards.
   */
  inline?: boolean;
}

// ---------- widgets ----------

/**
 * A plugin's card in the chat (a `widget` part: the plugin's tool called ctx.widgets.show(call, kind, data)).
 * The host draws the card's frame; the component fills it. Use the theme's CSS variables (var(--fg), var(--muted),
 * var(--surface-2), var(--border), var(--accent)…) so it fits light and dark, the web and the phone.
 */
export interface WidgetProps<D = any> extends SlotProps {
  kind: string;
  /** What the tool passed, as it was when shown. */
  data: D;
  /** The agent's message the card is in. */
  message: Message;
}

// ---------- live view ----------
//
// A floating picture-in-picture window, owned by the host, onto something an agent works in (a browser, a desktop
// app, another machine's screen). A plugin contributes the content and reports activity; the host decides when the
// window shows (it opens on its own while a view is busy, turns into a pill a little after the work stops), where it
// sits, and draws its frame, title bar and the expanded overlay.

/** What a live view is doing now. Report the truth; the host smooths short gaps between bursts of work. */
export interface LiveViewActivity {
  /** An agent is working there right now: the window opens on its own. */
  active: boolean;
  /** The work needs the user (a captcha, a sign-in): the window reopens even if minimized or closed, highlighted. */
  attention?: boolean;
  /** The user drives it right now (takeover): the view counts as busy. */
  userControl?: boolean;
  /** The agent working there: the host shows its name and avatar. */
  agentId?: string;
  /** One line about what is going on, in the interface language ("Opened a page · example.com"). */
  status?: string;
}

export interface LiveViewProps extends SlotProps {
  /**
   * "mini": the compact corner window (view only; the host turns a click into expand).
   * "expanded": the large overlay where the user can interact (e.g. take over).
   * The component stays mounted when the mode changes, and is unmounted while the view is a pill or hidden:
   * start streaming on mount, stop on unmount.
   */
  mode: "mini" | "expanded";
  expand(): void;
  /** Back to the compact window. */
  collapse(): void;
}

export interface LiveViewContribution {
  id: string;
  title: string;
  /** Lucide icon name or an emoji. */
  icon?: string;
  component: ComponentType<LiveViewProps>;
}

export interface LiveViewHandle {
  /** Merge an activity update (call on every change). */
  update(activity: Partial<LiveViewActivity>): void;
  /** Remove the view. */
  dispose(): void;
}

// ---------- maps ----------

/** A place a map card opens in a maps app. */
export interface MapAppPlace {
  lat: number;
  lon: number;
  label?: string;
  zoom: number;
}

/** A route a map card opens in a maps app: two or more stops in order, and the way of travel. */
export interface MapAppRoute {
  stops: Array<{ lat: number; lon: number; label?: string }>;
  mode: RouteMode;
}

/** A maps app in the "Open in…" menu of map cards (ui.maps.addApp): links for a place and, if it can, a route. */
export interface MapAppContribution {
  id: string;
  /** The app's name in the menu. */
  title: string;
  place(p: MapAppPlace): string;
  /** A link that opens the route planned; without it the menu opens the route's destination. */
  route?(r: MapAppRoute): string | undefined;
}

// ---------- host services ----------

export interface HubApi {
  get<T = any>(path: string): Promise<T>;
  post<T = any>(path: string, body?: unknown): Promise<T>;
  put<T = any>(path: string, body?: unknown): Promise<T>;
  patch<T = any>(path: string, body?: unknown): Promise<T>;
  del<T = any>(path: string): Promise<T>;
}

export interface PluginChannel {
  /** Call this plugin's backend HTTP handler: /api/plugins/<id>/http/<path>. */
  http<T = any>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
  /** Send a message to this plugin's backend (ctx.ui.onMessage). */
  send(payload: unknown): void;
  /** Subscribe to this plugin's backend events (ctx.ui.emit(channel, payload)). Returns unsubscribe. */
  on(channel: string, cb: (payload: any) => void): () => void;
}

export interface PiomioUI {
  pluginId: string;
  slots: {
    register<P = any>(slot: SlotName, contribution: SlotContribution<P>): () => void;
    /** Replace a core component (chat.composer, chat.message); highest priority wins. */
    override<P = any>(slot: SlotName, component: ComponentType<P>, opts?: { priority?: number; match?: SlotContribution["match"] }): () => void;
  };
  /**
   * A full page. `bare`: drawn alone, without the sidebar and panels (the desktop app's Pio overlay at /pio/overlay);
   * never in the navigation.
   */
  routes: { add(r: { path: string; title: string; icon?: string; component: ComponentType<SlotProps>; nav?: boolean; bare?: boolean }): () => void };
  statusbar: { add(item: { id: string; render: ComponentType<SlotProps> }): () => void };
  commands: { register(c: { id: string; title: string; run: () => void | Promise<void> }): () => void };
  settings: { section(s: { id: string; title: string; component: ComponentType<SlotProps> }): () => void };
  /** Live views: a plugin can register several (one per screen) and dispose them at any time. */
  liveView: { register(c: LiveViewContribution): LiveViewHandle };
  /** Maps apps for the "Open in…" menu of map cards (after Apple Maps, Google Maps and OpenStreetMap). */
  maps: { addApp(app: MapAppContribution): () => void };
  /** Draw this plugin's chat cards: `kind` as in contributes.widgets and ctx.widgets.show. */
  widgets: { add<D = any>(kind: string, component: ComponentType<WidgetProps<D>>): () => void };
  toast(text: string, kind?: "info" | "success" | "error"): void;
  /** Navigate inside the SPA. */
  navigate(path: string): void;
  api: HubApi;
  plugin: PluginChannel;
  /** All realtime hub events (messages, tasks, notifications...). Returns unsubscribe. */
  events: { on(cb: (e: UiEvent) => void): () => void };
  /**
   * Interface language and this plugin's translations (.piomio-plugin/locales/<locale>.json, delivered by the hub).
   * The page reloads when the user switches language, so `locale` is fixed for the plugin's lifetime.
   */
  i18n: {
    locale: Locale;
    /** Translate a key from this plugin's messages; falls back to English, then to the key. */
    t(key: string, params?: Params): string;
    /** Dates and numbers in the interface language. */
    formatDate(d: Date | string | number, opts?: Intl.DateTimeFormatOptions): string;
    formatNumber(n: number, opts?: Intl.NumberFormatOptions): string;
  };
}

export type UiPluginModule = { activate(ui: PiomioUI): void | (() => void) };

// ---------- shared components and hooks (values provided by the host at runtime) ----------

export interface ButtonProps {
  children?: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
}
export interface CardProps {
  title?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}
export interface BadgeProps {
  children?: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
}
export interface EmptyStateProps {
  title: string;
  hint?: ReactNode;
  icon?: string;
}

// ---------- the iOS app's bridge ----------

/** Haptic feedback the phone can play. */
export type NativeHapticKind = "light" | "success" | "warning";

/** What the app tells the page (a `piomio-native` CustomEvent on window): live words while the mic is held. */
/** What the app tells the page: live dictation words, the "Show steps" switch in its header, the hub answering again, its "Library" menu item. */
export type NativeEvent =
  | { type: "dictation"; text: string }
  | { type: "details"; on: boolean }
  | { type: "online" }
  | { type: "library" }
  /** The app hands a page it kept warm (at /m/) a chat to show: the page switches to it without loading again. */
  | { type: "show"; conversationId: string };

/**
 * The Piomio iOS app around the page (its chat screen is the web UI's chat in a WKWebView). Every call is
 * `window.webkit.messageHandlers.piomio.postMessage({ type, ... })`; a failed call rejects with an Error whose
 * message is the app's reason.
 */
export interface NativeBridge {
  /** Any bridge message: resolves with the app's reply object. */
  call<T = Record<string, unknown>>(type: string, payload?: Record<string, unknown>): Promise<T>;
  /** The page has rendered the conversation (the app hides its spinner). */
  ready(conversationId: string): Promise<{ ok: boolean }>;
  /** The app loads the approval from the hub, asks for Face ID and signs it; `cancelled` when the user backed out. */
  approve(approvalId: string): Promise<{ ok: boolean; cancelled?: boolean }>;
  deny(approvalId: string): Promise<{ ok: boolean }>;
  /** Hold-to-talk: `start` rejects with the reason when the mic or speech recognition is not allowed. */
  dictation: { start(): Promise<{ ok: boolean }>; stop(): Promise<{ text: string }> };
  /** Open a link in Safari (sign-in pages, anything outside the hub). */
  openURL(url: string): Promise<{ ok: boolean }>;
  haptic(kind: NativeHapticKind): Promise<{ ok: boolean }>;
  /** The page's session ended: the app gets a new one and reloads the page (no reply). */
  reauth(): void;
  /** Messages from the app. Returns unsubscribe. */
  onEvent(listener: (e: NativeEvent) => void): () => void;
}

declare global {
  interface Window {
    __PIOMIO_SHARED__?: {
      react: unknown;
      reactDom: unknown;
      reactDomClient: unknown;
      jsxRuntime: unknown;
      ui: PiomioUIRuntime;
    };
  }
}

/** What the "@piomio/ui" module exports at runtime. */
export interface PiomioUIRuntime {
  definePluginUI(activate: (ui: PiomioUI) => void | (() => void)): UiPluginModule;
  Button: ComponentType<ButtonProps>;
  Card: ComponentType<CardProps>;
  Badge: ComponentType<BadgeProps>;
  EmptyState: ComponentType<EmptyStateProps>;
  Spinner: ComponentType<{ size?: number }>;
  Markdown: ComponentType<{ text: string }>;
  /** Live list of tasks from the hub. */
  useTasks(): Task[];
  /** Subscribe to hub events inside a component. */
  useHubEvent(cb: (e: UiEvent) => void, deps?: unknown[]): void;
  api: HubApi;
  /**
   * Where the page loads a picture from: the page may only load images from the hub, so an http(s) address goes
   * through the hub's image proxy. Undefined for what cannot be shown. The proxy fetches a picture an agent's words
   * or tools put up only once the hub decided it carries no data out; one it never saw (a site's icon) it fetches for
   * a plugin's UI as asked.
   */
  mediaSrc(src: string): string | undefined;
  /** Interface language (same as ui.i18n.locale). */
  locale: Locale;
  /**
   * The iOS app's bridge when the page runs inside the Piomio app; `undefined` in a browser, so check it first:
   * `native?.haptic("success")`.
   */
  native: NativeBridge | undefined;
}

// Value exports: declared here for type-checking only. At runtime the import map points "@piomio/ui"
// to the host shim (/shared/piomio-ui.js), which provides these values. Plugins must mark "@piomio/ui" external.
export declare const definePluginUI: PiomioUIRuntime["definePluginUI"];
export declare const Button: PiomioUIRuntime["Button"];
export declare const Card: PiomioUIRuntime["Card"];
export declare const Badge: PiomioUIRuntime["Badge"];
export declare const EmptyState: PiomioUIRuntime["EmptyState"];
export declare const Spinner: PiomioUIRuntime["Spinner"];
export declare const Markdown: PiomioUIRuntime["Markdown"];
export declare const useTasks: PiomioUIRuntime["useTasks"];
export declare const useHubEvent: PiomioUIRuntime["useHubEvent"];
export declare const api: PiomioUIRuntime["api"];
export declare const mediaSrc: PiomioUIRuntime["mediaSrc"];
export declare const locale: PiomioUIRuntime["locale"];
/** The iOS app's bridge; `undefined` in a browser. */
export declare const native: PiomioUIRuntime["native"];
export type { Locale, Message, MessagePart, Params, Task, UiEvent };
