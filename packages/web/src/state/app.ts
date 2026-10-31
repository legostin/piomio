// Global client state: auth/bootstrap, realtime connection, the team (agents and their dialogs), group chats,
// conversations, messages, tasks.

import { useSyncExternalStore } from "react";
import type { AgentDef, Catalog, Conversation, GroupChat, Locale, MachineActivity, Message, Task, TeamMember, UiEvent, VaultState } from "@piomio/shared";
import { api, ApiError, onUnauthorized, request, setCsrf } from "../lib/api";
import { createStore, Emitter, type Store } from "../lib/store";
import { HubSocket, type ConnectionState } from "../lib/socket";
import { applyDelta, mergeFetched, prependOlder, upsertMessage } from "../lib/messages";
import { desktopTicketFrom } from "../lib/desktop";
import { mobileMode } from "../lib/mobile";
import { toastWorthy } from "../lib/notifications";
import { native } from "../lib/native";
import { adoptHubLocale, t } from "../i18n";
import { toast } from "./toast";
import { clearFeeds, feeds, onFeedEvent, refreshFeeds } from "./feeds";
import { clearPages, onPageEvent } from "./pages";

export interface UiPluginEntry {
  id: string;
  /** Already in the interface language. */
  name: string;
  url: string;
  /** The plugin's own messages: English plus the interface language (for ui.i18n.t). */
  messages?: Catalog;
}

export interface ChannelEntry {
  id: string;
  label: string;
  pluginId: string;
}

export interface Bootstrap {
  csrf: string;
  version: string;
  publicUrl: string;
  consoleUrl: string;
  /** The default agent's dialog (what "/" opens). */
  mainConversationId: string;
  defaultAgent: string;
  timezone: string;
  /** Hub language (Settings → language). */
  language: Locale;
  locales: Locale[];
  vaultState: VaultState;
  /** A new hub: only the setup card until a brain works, then the assistant opens the intro (FirstRun.tsx). */
  firstRun?: boolean;
  pendingApprovals: number;
  /** Reports, digests, alerts and questions not read yet (the Inbox's badge); missing on an older hub. */
  inboxUnread?: number;
  uiPlugins: UiPluginEntry[];
  channels: ChannelEntry[];
}

export interface AuthState {
  hasPassword: boolean;
  authenticated: boolean;
  passkeys: number;
  version: string;
  /** Hub language: the interface language for browsers without their own choice. */
  language?: Locale;
  locales?: Locale[];
}

/** `reauth`: the phone app's page lost its session and waits for the app to sign it in again (and reload it). */
export type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "setup" | "login"; auth: AuthState }
  | { kind: "ready" }
  | { kind: "reauth" };

export interface ConvMessages {
  messages: Message[];
  loaded: boolean;
  loading: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  error?: string;
}

const PAGE = 60;
const EMPTY_CONV: ConvMessages = { messages: [], loaded: false, loading: false, loadingOlder: false, hasMore: false };

export const phase = createStore<Phase>({ kind: "loading" });
export const session = createStore<Bootstrap | null>(null);
export const connection = createStore<ConnectionState>("connecting");
export const conversations = createStore<Conversation[]>([]);
export const tasks = createStore<Task[] | null>(null);
export const agents = createStore<AgentDef[] | null>(null);
/** Each agent's dialog and what happens there (`/api/team`, kept current by "team.updated"). */
export const team = createStore<TeamMember[] | null>(null);
/** Group chats and what happens there (`/api/groups`, kept current by "group.updated"). */
export const groups = createStore<GroupChat[] | null>(null);
/** The hub's computer and the paired machines with what runs there (`/api/machines/activity`, "machines.activity"). */
export const machineActivity = createStore<MachineActivity[] | null>(null);
export const messages = createStore<Record<string, ConvMessages>>({});

/** Every realtime event from the hub. */
export const hubEvents = new Emitter<UiEvent>();
/** Fired after the socket reconnects (pages refetch their data). */
export const reconnected = new Emitter<void>();

export function useSelector<T, S>(store: Store<T>, select: (s: T) => S): S {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.get()),
    () => select(store.get()),
  );
}

export function useConversationMessages(id: string | undefined): ConvMessages {
  return useSelector(messages, (s) => (id ? (s[id] ?? EMPTY_CONV) : EMPTY_CONV));
}

// ---------- auth & bootstrap ----------

let socket: HubSocket | undefined;

/** The desktop app's one-time sign-in ticket: read once when the page loads, then dropped from the address bar. */
let desktopTicket = (() => {
  const ticket = desktopTicketFrom(window.location.hash);
  if (ticket) history.replaceState(null, "", window.location.pathname + window.location.search);
  return ticket;
})();

export async function init(): Promise<void> {
  phase.set({ kind: "loading" });
  if (mobileMode) return initMobile();
  const ticket = desktopTicket;
  desktopTicket = undefined;
  // A used or expired ticket just leaves the usual sign-in form.
  if (ticket) await request("POST", "/api/auth/desktop", { ticket }).catch(() => undefined);
  try {
    const auth = await request<AuthState>("GET", "/api/auth/state");
    adoptHubLocale(auth.language);
    if (!auth.hasPassword) return phase.set({ kind: "setup", auth });
    if (!auth.authenticated) return phase.set({ kind: "login", auth });
    adoptHubLocale((await bootstrap()).language);
    phase.set({ kind: "ready" });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return void showLogin();
    phase.set({ kind: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * The phone app's chat page (/m/*): the device port has no /api/auth/state, the page's cookie session comes from
 * the app, and /api/bootstrap there returns its CSRF token. The interface follows the phone's language
 * (navigator.language), like the app around it, rather than the hub language.
 */
async function initMobile(): Promise<void> {
  try {
    await bootstrap();
    phase.set({ kind: "ready" });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return signInAgain();
    phase.set({ kind: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

/** The session is gone: inside the app, the app signs the page in again; elsewhere, the usual sign-in screen. */
async function signInAgain(): Promise<void> {
  if (!(mobileMode && native)) return showLogin();
  if (phase.get().kind === "reauth") return;
  stopSocket();
  session.set(null);
  phase.set({ kind: "reauth" });
  native.reauth();
}

async function showLogin(): Promise<void> {
  stopSocket();
  session.set(null);
  try {
    const auth = await request<AuthState>("GET", "/api/auth/state");
    phase.set({ kind: auth.hasPassword ? "login" : "setup", auth });
  } catch {
    phase.set({ kind: "login", auth: { hasPassword: true, authenticated: false, passkeys: 0, version: "" } });
  }
}

onUnauthorized(() => {
  if (phase.get().kind !== "ready") return;
  if (mobileMode && native) return void signInAgain();
  toast(t("app.sessionExpired"), "info");
  void showLogin();
});

export async function bootstrap(): Promise<Bootstrap> {
  const b = await request<Bootstrap>("GET", "/api/bootstrap");
  setCsrf(b.csrf);
  session.set(b);
  startSocket();
  void refreshConversations();
  void refreshTeam();
  void refreshGroups();
  return b;
}

export async function refreshBootstrap(): Promise<void> {
  try {
    const b = await request<Bootstrap>("GET", "/api/bootstrap");
    setCsrf(b.csrf);
    session.set(b);
  } catch {
    /* handled by onUnauthorized */
  }
}

export async function logout(): Promise<void> {
  try {
    await request("POST", "/api/auth/logout", {});
  } catch {
    /* ignore */
  }
  stopSocket();
  session.set(null);
  messages.set({});
  tasks.set(null);
  agents.set(null);
  team.set(null);
  groups.set(null);
  clearFeeds();
  clearPages();
  machineActivity.set(null);
  conversations.set([]);
  await showLogin();
}

// ---------- realtime ----------

function startSocket(): void {
  if (socket) return;
  socket = new HubSocket({
    onEvent: handleEvent,
    onState: (s) => connection.set(s),
    onReconnect: () => {
      void refreshBootstrap();
      void refreshConversations();
      void refreshTeam();
      void refreshGroups();
      if (feeds.get()) void refreshFeeds();
      if (tasks.get()) void refreshTasks();
      if (machineActivity.get()) void refreshMachineActivity();
      for (const id of Object.keys(messages.get())) if (messages.get()[id].loaded) void loadMessages(id, true);
      reconnected.emit();
    },
    onRepeatedFailure: async () => {
      // A failed upgrade may mean the session expired. The device port has no auth/state: a 401 from the
      // bootstrap reaches onUnauthorized.
      if (mobileMode) return refreshBootstrap();
      try {
        const auth = await request<AuthState>("GET", "/api/auth/state");
        if (!auth.authenticated && phase.get().kind === "ready") {
          toast(t("app.sessionExpired"), "info");
          void showLogin();
        }
      } catch {
        /* hub offline */
      }
    },
  });
  socket.start();
}

/**
 * The phone app says the hub answers again: reconnect now, and check the session (a restarted hub forgot it;
 * the 401 has the app sign the page in again).
 */
export function hubIsBack(): void {
  if (!socket) return;
  socket.retryNow();
  void refreshBootstrap();
}

function stopSocket(): void {
  socket?.stop();
  socket = undefined;
  connection.set("connecting");
}

export function sendToHub(msg: unknown): void {
  socket?.send(msg);
}

function patchConv(id: string, fn: (c: ConvMessages) => ConvMessages): void {
  messages.set((all) => {
    const cur = all[id];
    if (!cur) return all;
    return { ...all, [id]: fn(cur) };
  });
}

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [item, ...list];
  const next = list.slice();
  next[i] = { ...list[i], ...item };
  return next;
}

function sortConversations(list: Conversation[]): Conversation[] {
  return list.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

function handleEvent(e: UiEvent): void {
  switch (e.type) {
    case "message.created":
      patchConv(e.data.conversationId, (c) => ({ ...c, messages: upsertMessage(c.messages, e.data) }));
      conversations.set((list) => {
        const i = list.findIndex((c) => c.id === e.data.conversationId);
        if (i < 0) return list;
        const next = list.slice();
        next[i] = { ...list[i], updatedAt: e.data.createdAt };
        return sortConversations(next);
      });
      break;
    case "message.updated":
      patchConv(e.data.conversationId, (c) => ({ ...c, messages: upsertMessage(c.messages, e.data) }));
      break;
    case "message.delta":
      patchConv(e.data.conversationId, (c) => ({ ...c, messages: applyDelta(c.messages, e.data) }));
      break;
    case "conversation.updated":
      conversations.set((list) => sortConversations(upsertById(list, e.data)));
      break;
    case "team.updated":
      team.set((list) => (list ? upsertMember(list, e.data) : list));
      break;
    case "group.updated":
      groups.set((list) => (list ? upsertGroup(list, e.data) : list));
      break;
    case "feed.updated":
    case "feed.deleted":
    case "feed.post":
      onFeedEvent(e);
      break;
    case "page.updated":
    case "page.deleted":
      onPageEvent(e);
      break;
    case "task.updated":
      tasks.set((list) => (list ? upsertById(list, e.data) : list));
      break;
    case "machines.activity":
      machineActivity.set(e.data);
      break;
    case "approval.pending":
      session.set((s) => (s ? { ...s, pendingApprovals: e.data.count } : s));
      break;
    case "inbox.changed":
      session.set((s) => (s ? { ...s, inboxUnread: e.data.unread } : s));
      break;
    case "vault.state":
      session.set((s) => (s ? { ...s, vaultState: e.data.state } : s));
      break;
    case "notification.created":
      if (toastWorthy(e.data)) toast(e.data.title, "info");
      break;
    case "plugins.updated":
      void refreshBootstrap();
      break;
    case "settings.updated":
      // The assistant may change settings from chat: keep hub language, default agent etc. current.
      void refreshBootstrap();
      break;
    case "agents.updated":
      if (agents.get()) void refreshAgents().catch(() => {});
      void refreshTeam();
      break;
  }
  hubEvents.emit(e);
}

// ---------- conversations & messages ----------

export async function refreshConversations(): Promise<void> {
  try {
    conversations.set(sortConversations(await api.get<Conversation[]>("/api/conversations")));
  } catch {
    /* keep previous */
  }
}

/** New `members` of a group also make its first member the lead. */
export async function updateConversation(id: string, patch: { title?: string; agentId?: string; members?: string[] }): Promise<Conversation> {
  const c = await api.patch<Conversation>(`/api/conversations/${encodeURIComponent(id)}`, patch);
  conversations.set((list) => sortConversations(upsertById(list, c)));
  return c;
}

export async function loadMessages(id: string, refresh = false): Promise<void> {
  const cur = messages.get()[id];
  if (cur && (cur.loading || (cur.loaded && !refresh))) return;
  messages.set((all) => ({ ...all, [id]: { ...(all[id] ?? EMPTY_CONV), loading: true, error: undefined } }));
  try {
    const list = await api.get<Message[]>(`/api/conversations/${encodeURIComponent(id)}/messages?limit=${PAGE}`);
    messages.set((all) => {
      const prev = all[id] ?? EMPTY_CONV;
      return {
        ...all,
        [id]: { ...prev, messages: mergeFetched(prev.messages, list), loaded: true, loading: false, hasMore: refresh && prev.loaded ? prev.hasMore : list.length >= PAGE },
      };
    });
  } catch (e) {
    messages.set((all) => ({ ...all, [id]: { ...(all[id] ?? EMPTY_CONV), loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) } }));
  }
}

export async function loadOlder(id: string): Promise<void> {
  const cur = messages.get()[id];
  if (!cur || cur.loadingOlder || !cur.hasMore || !cur.messages.length) return;
  patchConv(id, (c) => ({ ...c, loadingOlder: true }));
  try {
    const before = cur.messages[0].createdAt;
    const list = await api.get<Message[]>(`/api/conversations/${encodeURIComponent(id)}/messages?limit=${PAGE}&before=${encodeURIComponent(before)}`);
    patchConv(id, (c) => ({ ...c, messages: prependOlder(c.messages, list), loadingOlder: false, hasMore: list.length >= PAGE }));
  } catch (e) {
    patchConv(id, (c) => ({ ...c, loadingOlder: false }));
    toast(e instanceof Error ? e.message : String(e), "error");
  }
}

/** A message with the paths of files uploaded for it (state/attachments.ts). */
export async function sendMessage(id: string, text: string, attachments: string[] = []): Promise<void> {
  const m = await api.post<Message>(`/api/conversations/${encodeURIComponent(id)}/messages`, attachments.length ? { text, attachments } : { text });
  // The live events may already have a newer copy (a voice note's transcript): the reply only fills a gap.
  if (m && m.id) patchConv(id, (c) => (c.messages.some((x) => x.id === m.id) ? c : { ...c, messages: upsertMessage(c.messages, m) }));
}

/** When each dialog last asked the hub to get its brain ready. */
const warmedAt = new Map<string, number>();

/** The person opened the dialog or is typing: the hub gets its brain ready for the message (at most once a minute). */
export function warmConversation(id: string): void {
  const now = Date.now();
  if (now - (warmedAt.get(id) ?? 0) < 60_000) return;
  warmedAt.set(id, now);
  api.post(`/api/conversations/${encodeURIComponent(id)}/warm`, {}).catch(() => {});
}

export async function interrupt(id: string): Promise<boolean> {
  const r = await api.post<{ interrupted: boolean }>(`/api/conversations/${encodeURIComponent(id)}/interrupt`, {});
  return !!r?.interrupted;
}

// ---------- team ----------

function upsertMember(list: TeamMember[], m: TeamMember): TeamMember[] {
  const i = list.findIndex((x) => x.agentId === m.agentId);
  if (i < 0) return [...list, m];
  const next = list.slice();
  next[i] = m;
  return next;
}

/** When the user last marked each conversation read here (ms): a listing asked for before that is stale on unread. */
const readHere = new Map<string, number>();

/** A fetched list without unread counts the user cleared after the request went out. */
function withoutStaleUnread<T extends { conversationId: string; unread: number }>(list: T[], askedAt: number): T[] {
  return list.map((x) => (x.unread && (readHere.get(x.conversationId) ?? 0) >= askedAt ? { ...x, unread: 0 } : x));
}

export async function refreshTeam(): Promise<TeamMember[] | null> {
  try {
    const askedAt = Date.now();
    const list = withoutStaleUnread(await api.get<TeamMember[]>("/api/team"), askedAt);
    team.set(list);
    return list;
  } catch {
    return team.get();
  }
}

export function ensureTeam(): void {
  if (!team.get()) void refreshTeam();
}

// ---------- group chats ----------

function upsertGroup(list: GroupChat[], g: GroupChat): GroupChat[] {
  const i = list.findIndex((x) => x.conversationId === g.conversationId);
  if (i < 0) return [g, ...list];
  const next = list.slice();
  next[i] = g;
  return next;
}

let groupsLoading: Promise<GroupChat[] | null> | undefined;

export function refreshGroups(): Promise<GroupChat[] | null> {
  groupsLoading ??= (async () => {
    try {
      const askedAt = Date.now();
      const list = withoutStaleUnread(await api.get<GroupChat[]>("/api/groups"), askedAt);
      groups.set(list);
      return list;
    } catch {
      return groups.get();
    } finally {
      groupsLoading = undefined;
    }
  })();
  return groupsLoading;
}

/** Load the group chats once (several views ask at start-up; one request answers them all). */
export function ensureGroups(): void {
  if (!groups.get() && !groupsLoading) void refreshGroups();
}

/** A new group chat with these agents (the first one leads). */
export async function createGroup(title: string, members: string[]): Promise<Conversation> {
  const c = await api.post<Conversation>("/api/conversations", { kind: "group", title, members });
  conversations.set((list) => sortConversations(upsertById(list, c)));
  groups.set((list) =>
    upsertGroup(list ?? [], { conversationId: c.id, title: c.title, members: c.members ?? members, lastActivityAt: c.updatedAt, running: false, speaking: [], unread: 0 }),
  );
  return c;
}

/** The user has seen the dialog up to the message created at `at`. */
export async function markRead(conversationId: string, at: string): Promise<void> {
  readHere.set(conversationId, Date.now());
  team.set((list) => (list ? list.map((m) => (m.conversationId === conversationId && m.unread ? { ...m, unread: 0 } : m)) : list));
  groups.set((list) => (list ? list.map((g) => (g.conversationId === conversationId && g.unread ? { ...g, unread: 0 } : g)) : list));
  try {
    await api.post(`/api/conversations/${encodeURIComponent(conversationId)}/read`, { at });
  } catch {
    /* the next team update corrects the count */
  }
}

// ---------- tasks & agents ----------

export async function refreshTasks(): Promise<Task[]> {
  const list = await api.get<Task[]>("/api/tasks?limit=300");
  tasks.set(list);
  return list;
}

export function ensureTasks(): void {
  if (!tasks.get()) void refreshTasks().catch(() => {});
}

export async function refreshAgents(): Promise<AgentDef[]> {
  const list = await api.get<AgentDef[]>("/api/agents");
  agents.set(list);
  return list;
}

export function ensureAgents(): void {
  if (!agents.get()) void refreshAgents().catch(() => {});
}

// ---------- machines ----------

export async function refreshMachineActivity(): Promise<void> {
  try {
    machineActivity.set(await api.get<MachineActivity[]>("/api/machines/activity"));
  } catch {
    /* the next "machines.activity" brings it */
  }
}

export function ensureMachineActivity(): void {
  if (!machineActivity.get()) void refreshMachineActivity();
}
