// Domain types shared by core, plugins, web and the node daemon.
// This file is the contract: change it deliberately.

import type { Locale } from "./i18n.ts";
import type { ModelProfile, ModelSkill } from "./models.ts";
import type { AgentAvatar } from "./avatar.ts";

export type ISODate = string;

// ---------- Tools ----------

/** What a tool does to the world. Drives the default policy decision. */
export type ToolEffect = "read" | "local-write" | "external";

export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  additionalProperties?: boolean | JsonSchema;
  [k: string]: unknown;
};

/** Tool names use only [a-zA-Z0-9_-] (Anthropic/OpenAI tool-name rules). Plugin tools are `<pluginId>_<name>`. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  effect: ToolEffect;
  /** Results come from outside (web, email, external MCP): reading them taints the session. */
  source?: boolean;
  /**
   * Template for approval cards, e.g. "Send an email to {to}: {subject}" or a "%key%" from the plugin's locales.
   * "{url|host}" shows only the host of a URL field.
   */
  approvalSummary?: string;
  /**
   * A local-write whose change outlives the session (memory, an agent's profile): after outside content the user
   * approves each call that changes something (a call with no input only reads).
   */
  askWhenTainted?: boolean;
  /** The person may ask for this action in their own words, and then it needs no card (see AskedSpec). */
  asked?: AskedSpec;
  /** Only available to background tasks / interactive sessions. Default: both. */
  availability?: "all" | "interactive" | "background";
}

/** What an action is, for matching it to the person's words: the verb on its control, or the one thing a tool does. */
export type AskedKind = "delete" | "send" | "publish" | "upload" | "confirm" | "unsubscribe";

/**
 * How the hub tells that the person asked for a call in so many words (core policy/asked.ts). The call carries
 * `asked`, their words quoted from this conversation; the hub finds the quote in the person's own recent messages,
 * the action's kind and the control's other words in the quote, and the site's name in what the person wrote. Then
 * the action runs without a card and the chat shows a quiet line. Payments never go this way.
 */
export interface AskedSpec {
  /** The input field with the page's URL. */
  site: string;
  /** The input field with the control's name («Remove», «Delete record»): its verb gives the kind. */
  label?: string;
  /** The kind of a tool that always does one thing (uploading files), instead of a label. */
  kind?: AskedKind;
  /** The input field with an amount of money: a call with one set always asks. */
  amount?: string;
  /** The input field with the files the action sends: each must be one the person sent in their messages. */
  files?: string;
}

export interface ToolDescriptor extends ToolSpec {
  /** "core", a plugin id, or "mcp:<server>". */
  owner: string;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** MCP CallToolResult shape plus our metadata. */
export interface ToolResult {
  content: ContentPart[];
  isError?: boolean;
  _meta?: {
    /** Force-taint the session even if the tool is not a source. */
    taint?: boolean;
    /** Files produced, relative to the workspace. */
    artifacts?: string[];
    status?: "awaiting_approval" | "denied";
    approvalId?: string;
    /**
     * A plugin tool's cards for the reply (PluginContext.widgets.show): the hub turns each into a `widget` part of the
     * agent's message and drops them from the result the model reads. Kinds must be listed in contributes.widgets.
     */
    widgets?: Array<{ kind: string; data: unknown }>;
  };
}

export interface ToolCallContext {
  sessionId: string;
  conversationId: string;
  taskId?: string;
  agentId: string;
  callId: string;
  tainted: boolean;
  /** The user approved this call: on its approval card, or ahead of time with an "always allow" rule. */
  approved?: boolean;
  background: boolean;
  workspace: string;
  machineId: string;
}

// ---------- Policy ----------

export type PolicyDecision = "allow" | "ask" | "deny";

export type RuleCondition =
  | { field: string; op: "eq"; value: string }
  | { field: string; op: "glob"; value: string }
  | { field: string; op: "domain"; value: string }
  /** A number (or a numeric string like "2400") no larger than `value`: a pre-approved amount's limit. */
  | { field: string; op: "max"; value: number };

export interface Rule {
  id: string;
  tool: string; // exact tool name or glob like "browser_*"
  agentId?: string;
  conditions: RuleCondition[];
  decision: "allow" | "deny";
  note?: string;
  createdAt: ISODate;
  /** "skill": a taught skill's pre-approval, noted `skill:<name>` (hub_skill_save, on the person's tap). */
  createdVia: "console" | "telegram" | "approval" | "chat" | "skill";
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "executed" | "failed";

/**
 * What an approval asks, for the card to say it plainly in the viewer's language: a command, a file to read or
 * change, or another tool (then the card shows `Approval.summary`). `detail` is the command or the path as is;
 * `reason` is the agent's own words for why, when it gave some.
 */
export interface ApprovalAsk {
  kind: "command" | "read" | "write" | "tool";
  detail: string;
  reason?: string;
  /** A command that reaches the network: the host. */
  host?: string;
}

/** "request": the person asked for the action in their own words (ToolSpec.asked), so nobody was asked again. */
export type ApprovalVia = "console" | "telegram" | "device" | "web" | "rule" | "timeout" | "request";

export interface Approval {
  id: string;
  sessionId: string;
  conversationId: string;
  taskId?: string;
  agentId: string;
  tool: string;
  input: unknown;
  summary: string;
  ask?: ApprovalAsk;
  effect: ToolEffect;
  tainted: boolean;
  status: ApprovalStatus;
  result?: ToolResult;
  createdAt: ISODate;
  resolvedAt?: ISODate;
  resolvedVia?: ApprovalVia;
}

// ---------- Secrets entered in the chat ----------

export type SecretRequestStatus = "pending" | "saved" | "cancelled";

/**
 * The hub asked the user for a secret in the chat. The value is typed into a card (or pasted as the next message)
 * and stored in the vault; the model only ever learns `vault://<vaultId>`.
 */
export interface SecretRequest {
  id: string;
  vaultId: string;
  /** What it is, e.g. "Telegram bot token". */
  title: string;
  /** Why it is needed / where to get it (written by the agent or the plugin manifest). */
  hint?: string;
  link?: string;
  /** Plugin that uses the secret; its `setting` receives "vault://<vaultId>". */
  pluginId?: string;
  setting?: string;
  /** A site's login instead of one value: the card asks for a username and a password, kept for this domain only. */
  login?: { domain: string; username?: string };
  conversationId?: string;
  status: SecretRequestStatus;
  /** Whether the vault already holds an item with this id (saving replaces it). */
  exists?: boolean;
  createdAt: ISODate;
  resolvedAt?: ISODate;
}

/** What a plugin needs before it works, for the setup card in the chat and the plugins page. */
export interface PluginSetupView {
  pluginId: string;
  name: string;
  enabled: boolean;
  status: string;
  lastError?: string;
  vaultState: VaultState;
  /** pattern: the declared format, for a warning before saving something that does not match. */
  secrets: Array<{ vaultId: string; title: string; hint?: string; link?: string; pattern?: string; required: boolean; present: boolean; setting?: string }>;
}

/** A new team agent the default agent puts together with the user in the chat. Nothing exists until it is created. */
export interface AgentDraft {
  id: string;
  conversationId: string;
  name: string;
  /** Shown to the user, in their language. */
  description: string;
  /** The new agent's instructions. */
  prompt: string;
  avatar: AgentAvatar;
  /** Unset until the user has said how proactive the agent should be (the agent then gets the default). */
  initiative?: 0 | 1 | 2;
  brains: string[];
  status: "draft" | "created";
  /** The agent made from the draft. */
  agentId?: string;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ---------- Conversations, messages ----------

export type MessageRole = "user" | "assistant" | "system";

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string; isError?: boolean }
  /** `asked`: the person asked for it in their own words (ToolSpec.asked): a quiet line, not a card. */
  | { type: "approval"; approvalId: string; summary: string; status: ApprovalStatus; ask?: ApprovalAsk; asked?: boolean }
  /**
   * Something an agent or the hub tells the person. `kind` says how it reads: a report or a digest is the agent
   * speaking (with `caption`, and `sources` under a digest), an alert or a question a card (`feedbackable`: a check's,
   * so the person can rate it). Parts saved before kinds have none and read by `level`.
   */
  | {
      type: "notification";
      level: NotifyLevel;
      title: string;
      body: string;
      kind?: NotificationKind;
      notificationId?: string;
      caption?: string;
      sources?: NotificationSource[];
      feedbackable?: boolean;
    }
  | { type: "error"; message: string }
  /** A line from the hub itself, for the person (a command's answer or hint): quiet, not the agent speaking. */
  | { type: "note"; text: string }
  /** A file the user sent (or a plugin attached): `path` is relative to the workspaces root, `size` in bytes. */
  | { type: "attachment"; path: string; name: string; mimeType?: string; size?: number; kind?: AttachmentKind; durationSec?: number; transcript?: string }
  /** A secret the user types into the chat card; the value goes straight to the vault and never into the conversation. */
  | { type: "secret_request"; requestId: string; vaultId: string; title: string; status: SecretRequestStatus }
  /** A plugin's setup card: its secrets and its own setup UI (e.g. Telegram pairing), live. */
  | { type: "plugin_setup"; pluginId: string }
  /** A new agent being put together in the chat: its look, description and proactivity, live, with a button that creates it. */
  | { type: "agent_draft"; draftId: string }
  /** An agent's own profile (profile_show): its look and proactivity as a live card, saved as the person picks them. */
  | { type: "agent_profile"; agentId: string }
  /** A CLI brain's sign-in card (device code or browser code), live. */
  | { type: "brain_login"; ref: string }
  /** No brain of the agent works yet: the hub's own setup card (sign in, install, API key), live. */
  | { type: "brain_setup" }
  /** Connect a phone: the card makes a one-time QR and link when the user asks for it. */
  | { type: "device_pairing" }
  /** An integration's card from the library (integration_connect), live: connect, set up, turn on. */
  | { type: "integration"; id: string }
  /** Pictures the agent shows (show_images): one item is a single image, two or more a carousel. */
  | { type: "images"; items: ImageItem[] }
  /** An OpenStreetMap map the agent shows (show_map), centred on lat/lon; without zoom it fits the markers and the route. */
  | { type: "map"; lat: number; lon: number; zoom?: number; title?: string; markers?: MapMarker[]; route?: MapRoute }
  /**
   * A task the agent started (task_delegate): one line with its live status that opens the task. A message to a
   * teammate (team_message) carries what the agent wrote (`text`) and, once it came, the teammate's answer (`reply`).
   */
  | { type: "task"; taskId: string; text?: string; reply?: string }
  /** The user's message this reply answers, when the dialog moved on since (a task's result for the request that started it). */
  | { type: "reply_to"; messageId: string; text: string }
  /** News the agent shows (show_news): cards from a channel's posts or found by the agent; `feedId` links the channel. */
  | { type: "news"; title?: string; feedId?: string; items: NewsItem[] }
  /**
   * Quick replies under the agent's message (show_choices): a tap sends the option's text as the person's message;
   * `chosen` is the one they tapped, after which the buttons rest.
   */
  | { type: "choices"; options: string[]; chosen?: number }
  /** A channel's live card in the chat: its state and buttons (open, gather now, how often, pause, delete). */
  | { type: "feed"; feedId: string }
  /**
   * How an agent thinks for each kind of work (AgentDef.thinking): a live card with a preset per kind. `focus`: only
   * that part of its chats' choice, as the header picker shows it (the /brain and /effort commands).
   */
  | { type: "thinking"; agentId: string; focus?: "brain" | "effort" }
  /** The /archive command's card: archive the agent (in the default agent's chat, after picking who takes over), then Restore. */
  | { type: "agent_archive"; agentId: string }
  /** A page the agent made (page_create, page_show): its card, which opens the page full screen. */
  | { type: "page"; pageId: string }
  /**
   * A plugin's own card (its tool called PluginContext.widgets.show): the plugin's UI module draws `data` with the
   * component it registered for `kind` (ui.widgets.add). Without that module the part shows nothing.
   */
  | { type: "widget"; plugin: string; kind: string; data: unknown };

/** A page an agent made: TSX on the pages kit plus its data, served sandboxed at `url` (core/src/pages.ts). */
export interface PageView {
  id: string;
  title: string;
  /** One or two lines for the card in the chat. */
  summary?: string;
  /** The card's picture: an http(s) URL (through the image proxy) or `file:<path>`. */
  cover?: string;
  agentId: string;
  /** The chat it was made in. */
  conversationId?: string;
  /** The page's own address with its secret token: `/p/<id>/<token>/`. */
  url: string;
  /** Goes up with every change, so open pages reload. */
  version: number;
  /** The last error the page hit in a browser, until the next change. */
  lastError?: string;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** One card of a `news` part. */
export interface NewsItem {
  title: string;
  text?: string;
  url?: string;
  source?: string;
  /** An http(s) picture, shown through the hub's image proxy. */
  image?: string;
  /** When it came out (or was posted in the channel). */
  at?: ISODate;
}

/** What a sent file is: a voice note and a photo are told apart from an audio file or a document by the channel. */
export type AttachmentKind = "photo" | "voice" | "audio" | "video" | "file";

/** `src` is an http(s) URL (shown through the hub's image proxy) or `file:<path relative to the workspaces root>`. */
export interface ImageItem {
  src: string;
  alt?: string;
  caption?: string;
}

export interface MapMarker {
  lat: number;
  lon: number;
  label?: string;
  /** A line under the label: an address, opening hours, why it is there. */
  note?: string;
  /** What the place is: the marker's symbol (default "pin"; a route's stops without one are numbered). */
  icon?: MapIcon;
}

/** Marker symbols (show_map; MAP_ICONS lists them). "user" is where the user is; "start" and "finish" end a route. */
export type MapIcon =
  | "pin"
  | "food"
  | "cafe"
  | "bar"
  | "hotel"
  | "sight"
  | "museum"
  | "park"
  | "shop"
  | "transport"
  | "parking"
  | "fuel"
  | "hospital"
  | "home"
  | "work"
  | "photo"
  | "star"
  | "start"
  | "finish"
  | "user";

export type RouteMode = "walk" | "drive" | "bike" | "transit";

/** A route over a map's markers. */
export interface MapRoute {
  mode: RouteMode;
  /** The markers it goes through, in order, by index (at least two). */
  stops: number[];
  /** The line, [lat, lon] pairs: along roads and paths when the hub found it, otherwise straight between the stops. */
  path: Array<[number, number]>;
  /** Length in metres and time in seconds, for a route along roads. */
  distanceM?: number;
  durationS?: number;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  parts: MessagePart[];
  status: "streaming" | "complete" | "error";
  /** The agent that wrote it. On a user-role message: a teammate writing in a thread (team_message), not the user. */
  agentId?: string;
  taskId?: string;
  brainRef?: string;
  /** How the agent thought for this reply: the model that answered (as the brain named it) and the effort it was asked for. */
  model?: string;
  effort?: string;
  /** Where a user message came from / where an assistant reply should also go. */
  channel?: string;
  createdAt: ISODate;
}

/** What a setup chat makes ("New channel", "Add agent"). */
export type SetupPurpose = "feed" | "agent";

export interface Conversation {
  id: string;
  /**
   * "main": an agent's long-lived dialog with the user (one per agent); "task": a task's thread; "chat": an older ad-hoc chat;
   * "group": the user with several agents (`members`); "setup": a short chat that makes something (`purpose`) and then
   * becomes it (`entity`).
   */
  kind: "main" | "task" | "chat" | "group" | "setup";
  /** A setup chat's aim: a channel or a new agent. */
  purpose?: SetupPurpose;
  /** What the setup chat became: the channel's or the agent's id. */
  entity?: string;
  title: string;
  /** The agent who answers; in a group, its lead (`members[0]`). */
  agentId: string;
  /** A group's agents in order, the lead first (2–8, see GROUP_MAX_MEMBERS). */
  members?: string[];
  taskId?: string;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** An agent of the user's team as the sidebar shows it: its long-lived dialog and what happens there. */
export interface TeamMember {
  agentId: string;
  /** The agent's dialog (kind "main"). */
  conversationId: string;
  /** The latest message worth a preview, as short plain text. */
  lastMessage?: { role: MessageRole; text: string; createdAt: ISODate };
  lastActivityAt: ISODate;
  /** A turn is in progress in the dialog. */
  running: boolean;
  /** Messages from the agent (or the system) the user has not seen yet. */
  unread: number;
  /** Pinned to the top of the list (under the default agent): its place among the pinned, 0 first. */
  pinned?: number;
}

/** A group chat as the sidebar shows it, kept current by "group.updated". */
export interface GroupChat {
  conversationId: string;
  title: string;
  /** The lead first. */
  members: string[];
  /** The latest message worth a preview, as short plain text; `agentId` says who wrote it. */
  lastMessage?: { role: MessageRole; text: string; createdAt: ISODate; agentId?: string };
  lastActivityAt: ISODate;
  /** Members are answering. */
  running: boolean;
  /** While running: the member who has the floor, then those who answer after them. */
  speaking: string[];
  unread: number;
}

// ---------- Tasks ----------

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "interrupted"
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  conversationId: string;
  parentConversationId?: string;
  parentTaskId?: string;
  agentId: string;
  title: string;
  goal: string;
  status: TaskStatus;
  brainRef?: string;
  createdBy: "user" | "agent" | "trigger";
  triggerId?: string;
  background: boolean;
  result?: string;
  error?: string;
  resumeAt?: ISODate;
  /** A question the task asked whoever started it (task_ask), until it gets an answer. */
  question?: string;
  /**
   * "message": a thread between two agents of the team (team_message); it reads like a conversation, not a job.
   * "goal": a long goal (the /goal command): it keeps going round after round until the agent reports it reached.
   */
  kind?: "message" | "goal";
  /** A goal's rounds so far (kind "goal"): it pauses every GOAL_ROUNDS of them. */
  rounds?: number;
  /** A thread's other side (kind "message"): the teammate who wrote. `agentId` is the one answering. */
  from?: string;
  /** Started or messaged from a session that had read outside content: its sessions are marked the same way. */
  tainted?: boolean;
  /** A channel's gathering run (Feed): it works in the channel's own folder, and its output is the channel's posts. */
  feedId?: string;
  /** How the result reaches the person: "report", a schedule's report delivered as the agent's message; "digest", the digest the default agent writes. */
  deliver?: "report" | "digest";
  /** The brain and depth whoever started it chose for this job (task_delegate), over the agent's choice for tasks. */
  thinking?: ThinkingChoice;
  /** The skill the task follows (a trigger's run of a taught skill): a taught one may click and type in the background. */
  skill?: string;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ---------- Channels (feeds) ----------

/**
 * A channel: news on a topic the user described, which an agent of the team (its editor) gathers at set times from
 * whatever fits (RSS, the web, a browser, its own scripts, plugins) and posts like a channel in a messenger. The code
 * calls it a feed: "channels" there are where messages travel (Telegram).
 */
export interface Feed {
  id: string;
  title: string;
  /** What the user wants from it, in their words. */
  brief: string;
  /** The agent who edits it. */
  agentId: string;
  /** When it is gathered: local "HH:MM" times in the user's time zone. */
  times: string[];
  /** The days it is gathered, 0 = Sunday … 6 = Saturday; empty: every day. */
  weekdays: number[];
  /** What the editor reads, one line each as it noted them ("rss https://…", "search …", "script digest.py"). */
  sources: string[];
  enabled: boolean;
  /** The editor is gathering now: its run's task. */
  runningTaskId?: string;
  /** The setup chat it was made in: its settings are talked over there. */
  chatId?: string;
  lastRunAt?: ISODate;
  nextRunAt?: ISODate;
  /** Posts the user has not seen yet, and the newest post. */
  unread: number;
  lastPost?: { title: string; createdAt: ISODate };
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** One news item in a channel. */
export interface FeedPost {
  id: string;
  feedId: string;
  title: string;
  /** A few lines on what matters (markdown). */
  text: string;
  url?: string;
  /** Where it comes from: a site's or a feed's name. */
  source?: string;
  /** A picture for it: an http(s) address, shown through the hub's image proxy. */
  image?: string;
  createdAt: ISODate;
}

// ---------- Agents ----------

export interface AgentDef {
  id: string;
  name: string;
  description: string;
  /** Ordered brain refs, e.g. ["claude-code@local", "api:anthropic"]. */
  brains: string[];
  /**
   * The computers the agent thinks on (machine ids; the hub's own by its replica id in a cluster, else "local"): only
   * their brains, and an error when none of them is online. Unset or empty: anywhere.
   */
  machines?: string[];
  /** An exact model for every brain (from before `thinking`): used when no choice names one. */
  model?: string;
  /** How the agent thinks for each kind of work: kinds without a choice of their own follow `chat`. */
  thinking?: AgentThinking;
  /** 0 = only reacts, 1 = suggests (read-only background), 2 = acts within rules. */
  initiative: 0 | 1 | 2;
  /** Tool name globs. ["*"] = all. */
  tools: string[];
  skills: string[];
  policyProfile: string;
  budget: { backgroundRunsPerDay: number; tokensPerDay?: number };
  prompt: string;
  source: "builtin" | "user" | string;
  /** Colour + shape picked when the agent was created; the UI derives one from the id when absent. */
  avatar?: AgentAvatar;
  /**
   * In the archive, asleep: out of the team list, its schedules and channels do not run, teammates do not see it; its
   * dialog, memory and settings stay. Set by the hub when it lists agents (agents-state.ts), not stored in the file.
   */
  archived?: boolean;
  /** Translated name / description shown in the UI ("i18n: { ru: { name: … } }" in the frontmatter). */
  i18n?: Partial<Record<Locale, { name?: string; description?: string }>>;
}

/**
 * How deeply an agent thinks, in plain words: each brain maps it to one of its models and an effort (ProbeResult.presets).
 * "auto": the hub decides per request (core/src/model-router.ts): a dialog's front desk answers at once, a word in
 * passing or a channel run takes a light model, a task what its starter chose (Task.thinking) or everyday depth.
 */
export type ThinkingPreset = "auto" | "fast" | "balanced" | "deep";

/**
 * How an agent thinks for a kind of work: a preset, or an exact model and effort (they win over the preset's). `brain`
 * is the brain the choice was made for: it is tried first, and the exact model and effort apply only on it.
 */
export interface ThinkingChoice {
  preset?: ThinkingPreset;
  model?: string;
  effort?: string;
  brain?: string;
  /** What the work is mostly about, for choosing a model good at it (a task's, from task_delegate). */
  skill?: ModelSkill;
}

/**
 * The kinds of work an agent does: "chat" its dialogs and group chats (and messages from teammates), "task" what it
 * does on the side (delegated, background and user tasks), "feed" a channel's runs, "schedule" runs a trigger started.
 */
export type WorkKind = "chat" | "task" | "feed" | "schedule";

/** An agent's choice per kind of work; `chat` is the general one the other kinds follow when they have none. */
export type AgentThinking = Partial<Record<WorkKind, ThinkingChoice>>;

// ---------- Brains ----------

export interface BrainRef {
  brainId: string;
  variant?: string;
  machineId: string; // "local" for the hub host
}

export interface ProbeResult {
  available: boolean;
  authenticated: boolean;
  version?: string;
  models?: string[];
  /** The model the brain answers with when the agent names none, for people to see. */
  model?: string;
  /** Names people read for `models`, by id (e.g. "opus" → "Opus"). */
  modelNames?: Record<string, string>;
  /** Reasoning efforts the brain takes, least first (e.g. ["low", "medium", "high"]); absent: it takes none. */
  efforts?: string[];
  /** What each preset means on this brain: one of its models and efforts (unset: the brain's default). */
  presets?: Partial<Record<ThinkingPreset, { model?: string; effort?: string }>>;
  /**
   * What each of its models is like (models.ts): how capable, quick and costly, and what it is good at. The hub picks
   * a model per request from these (core/src/model-router.ts); a model without one gets the known family's profile.
   */
  catalog?: ModelProfile[];
  detail?: string;
}

// ---------- Brain sign-in from the chat ----------

/**
 * [installing (the hub installs a missing CLI first)] → starting → waiting (the user signs in on the page) → verifying
 * (a pasted code is being checked) → succeeded, or failed / cancelled / expired (the code ran out before the user finished).
 */
export type BrainLoginStatus = "installing" | "starting" | "waiting" | "verifying" | "succeeded" | "failed" | "cancelled" | "expired";

/** What a sign-in reports while it runs (from the brain's host to the hub). */
export interface BrainLoginUpdate {
  status: BrainLoginStatus;
  /** Page the user opens to sign in. */
  url?: string;
  /** One-time code the user types on that page (device flow, e.g. Codex). */
  userCode?: string;
  /** The page shows a code the user pastes back into the card (browser flow, e.g. Claude Code). */
  needsCode?: boolean;
  expiresAt?: ISODate;
  /** Why it failed, for people. */
  error?: string;
}

/** A CLI brain signing in without a terminal, as the sign-in card shows it. */
export interface BrainLoginState extends BrainLoginUpdate {
  id: string;
  ref: string;
  startedAt: ISODate;
  finishedAt?: ISODate;
}

/** Everything the sign-in card needs for one brain. */
export interface BrainLoginView {
  ref: string;
  label: string;
  connected: boolean;
  /** The brain can sign in from the chat. */
  supported: boolean;
  probe?: ProbeResult;
  /** The latest sign-in since the hub started, running or finished. */
  login?: BrainLoginState;
}

// ---------- First-run setup ----------

/**
 * What the default agent walks the user through once a brain works. "identity" (its name, look, proactivity) and
 * "team" (who else to add) open a new hub's intro and exist only on hubs that went through it.
 */
export type SetupStep = "identity" | "team" | "telegram" | "backupBrain" | "machines" | "profile";

/** One of the agent's brains on this hub, as the setup card shows it. */
export interface SetupBrain {
  ref: string;
  label: string;
  /** A CLI that signs in from the chat (Claude Code, Codex), or a brain that takes a key or token. */
  kind: "cli" | "api";
  /** The CLI starts on this computer (always true for api brains). */
  installed: boolean;
  signedIn: boolean;
  /** The hub can install the missing CLI itself (desktop installs). */
  canInstall: boolean;
  detail?: string;
}

export interface SetupState {
  agentId: string;
  brains: SetupBrain[];
  /** The hub has a working brain (rate limits aside): the agent's own, or any other the agent falls back to. */
  usable: boolean;
  /** The hub has not started talking with the person yet: no brain until now, or the intro has not begun. */
  firstRun: boolean;
  /**
   * The hub is still starting (a replica waits to see whether another one leads, then starts its plugins), or another
   * replica leads: its brains are not all here, so `usable` says nothing yet and no setup card should show.
   */
  starting: boolean;
  vault: "absent" | "locked" | "open";
  /** Model access through API keys is on (PIOMIO_API_KEYS=1): the card may offer keys besides signing in. */
  apiKeys: boolean;
  telegram: boolean;
  machines: number;
  done: SetupStep[];
  skipped: SetupStep[];
  /** Steps neither done nor skipped, in the order the agent offers them. */
  remaining: SetupStep[];
}

export interface BrainSessionOptions {
  sessionId: string;
  agent: AgentDef;
  variant?: string;
  model?: string;
  /** Reasoning effort, one of the brain's ProbeResult.efforts; unset: the brain's default. */
  effort?: string;
  workspace: string;
  mcp: {
    url: string;
    token: string;
    /** Command that runs the stdio MCP bridge, e.g. ["node", "/app/packages/mcp-bridge/src/index.ts"]. */
    bridgeCommand: string[];
  };
  systemPrompt: string;
  /** Where materialized skills live for this session (already copied into the workspace). */
  skillsDir?: string;
  /** Claude Code-format plugin dirs to pass via --plugin-dir. */
  claudePluginDirs?: string[];
  resume?: string;
  env: Record<string, string>;
  background: boolean;
  /**
   * Keep the brain's own tools (shell, files) in a sandbox, when it has one (core/src/native-permissions.ts): commands
   * may write only in the workspace and temp folders and reach the network only through the hub's egress proxy; they
   * may not read `denyRead` (the person's credentials, the hub's data) except `allowRead` inside it. Anything beyond
   * that, the brain asks the hub through the MCP tool `permissionTool`, which may ask the person. Unset: no sandbox
   * (a remote machine, or a hub isolated by unix users).
   */
  confine?: { denyRead: string[]; allowRead: string[]; allowWrite?: string[]; permissionTool: string };
  /**
   * A dialog the person talks in: the brain keeps its process between turns (and may start it before the first one,
   * `warm`), so a reply does not wait for a CLI to start. Unset for tasks: their process ends with the turn.
   */
  keepWarm?: boolean;
  /**
   * The person's dialog is a front desk: the brain's own tools only look (read files, search the web); running
   * commands and changing files is work for a task (task_delegate), so the dialog never waits on it.
   */
  frontDesk?: boolean;
}

export type BrainEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string; isError?: boolean }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number }
  /** The model that answers this turn, as the brain names it (an alias it resolved, its default), when it can tell. */
  | { type: "model"; model: string }
  | { type: "limit_hit"; resetAt?: ISODate; detail: string }
  | { type: "error"; message: string; fatal?: boolean }
  | { type: "done"; resumeToken?: string };

export interface BrainTurn {
  text: string;
  attachments?: string[];
  /**
   * What came before in this conversation (a summary and the recent turns), for a session that was to resume but cannot
   * (its history is gone, or too full to go on): the brain starts afresh with it before `text`. Ignored otherwise.
   */
  recap?: string;
  /**
   * How this turn thinks, when the hub chose for it (core/src/model-router.ts): one of the brain's models and efforts.
   * The session thinks this way from here on; a brain that can switches without starting over.
   */
  model?: string;
  effort?: string;
}

// ---------- Notifications ----------

export type NotifyLevel = "silent" | "digest" | "notify" | "ask";

/** What a notification is for the person (docs/superpowers/specs/2026-10-31-notifications-inbox-design.md). */
export type NotificationKind = "report" | "alert" | "question" | "digest" | "item" | "approval";

/** What a digest drew on: a schedule, an agent, a channel or a connected service; `href` is a hub path. */
export interface NotificationSource {
  label: string;
  href?: string;
  count?: number;
}

export interface Notification {
  id: string;
  level: NotifyLevel;
  kind: NotificationKind;
  title: string;
  body: string;
  agentId?: string;
  taskId?: string;
  triggerId?: string;
  conversationId?: string;
  createdAt: ISODate;
  deliveredAt?: ISODate;
  feedback?: "useful" | "less" | "off";
  /** Why it did not reach the person now (quiet hours, the rate limit, replaced by a newer one). */
  reason?: string;
  /** The chat message that carries it. */
  messageId?: string;
  /** Opened in the Inbox. */
  readAt?: ISODate;
  /** The digest an item went into. */
  digestId?: string;
  supersededBy?: string;
}

/** One Inbox row: a report, a digest, an alert or a question that reached the person. */
export interface InboxEntry {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  caption?: string;
  agentId?: string;
  taskId?: string;
  /** The conversation of its chat message (the agent's dialog). */
  conversationId?: string;
  messageId?: string;
  sources?: NotificationSource[];
  createdAt: ISODate;
  unread: boolean;
  /** From a check (a trigger): the person can rate it. */
  feedbackable: boolean;
  feedback?: Notification["feedback"];
}

export interface InboxView {
  /** Items wait for the next digest: its local time ("19:00", none without digest times) and how many. */
  next?: { time?: string; count: number };
  /** Questions the person has not read yet ("Waiting for you"). */
  questions: InboxEntry[];
  /** The rest, newest first; more before the last one with `?before=` its createdAt. */
  entries: InboxEntry[];
  hasMore: boolean;
  behindCount: number;
  unread: number;
}

/** A row behind the scenes: an item (silent, held for the digest) or an approval push, and why it did not reach the person. */
export interface BehindEntry {
  id: string;
  level: NotifyLevel;
  kind: NotificationKind;
  title: string;
  body: string;
  agentId?: string;
  taskId?: string;
  createdAt: ISODate;
  reason?: string;
  /** Held for the digest and not out in one yet (level digest, not replaced, and not digested or its digest still being written). */
  waiting: boolean;
  /** The digest it went into. */
  digest?: { id: string; title: string; createdAt: ISODate };
  supersededBy?: string;
}

// ---------- Channels ----------

export interface OutboundMessage {
  kind: "reply" | "notification" | "approval" | "digest";
  text: string;
  /** A reply to a message the user wrote elsewhere (the web UI): their words, so the channel shows the exchange. */
  quote?: string;
  /** Deep link into the web UI or console. */
  link?: string;
  conversationId?: string;
  notificationId?: string;
  approval?: {
    id: string;
    summary: string;
    approveToken: string;
    denyToken: string;
  };
  feedback?: { notificationId: string; tokens: { useful: string; less: string; off: string } };
  /** Deliver without sound (quiet hours). */
  silent?: boolean;
  /** Images and maps of the reply, sent after its text. */
  media?: OutboundMedia[];
}

/**
 * Media for a channel. An image comes as a public URL (the channel may let its service fetch it) or inline as base64
 * `data` (a file from the agent's workspace, at most 10 MB).
 */
export type OutboundMedia =
  | { kind: "image"; url?: string; data?: string; mimeType?: string; name?: string; caption?: string }
  | { kind: "map"; lat: number; lon: number; title?: string };

// ---------- Machines ----------

export interface MachineInfo {
  os: string;
  hostname: string;
  arch: string;
  clis: Array<{ brainId: string } & ProbeResult>;
  allowedDirs: string[];
  nodeVersion: string;
}

export interface Machine {
  id: string;
  name: string;
  publicKey: string;
  status: "online" | "offline";
  info?: MachineInfo;
  lastSeenAt?: ISODate;
  createdAt: ISODate;
}

/**
 * A computer an agent may be bound to (AgentDef.machines): the hub's own (`id` its replica id in a cluster, else
 * "local"), a paired machine, or another replica of the hub (`standby`: it is not leading, so nothing runs there now).
 */
export interface Computer {
  id: string;
  name: string;
  online: boolean;
  standby?: boolean;
}

/**
 * What a brain is doing in a turn right now: thinking (nothing streamed yet, or between tool calls), writing the
 * answer, running a command, reading or editing files, on the web, calling another tool, or waiting for the user to
 * approve a call.
 */
export type WorkStep = "thinking" | "writing" | "command" | "reading" | "editing" | "web" | "tool" | "approval";

/** One turn in progress on a machine. */
export interface MachineWork {
  agentId: string;
  conversationId: string;
  /** The task the turn works on. */
  taskId?: string;
  /** What the turn is about when the agent's name does not say it: the task's goal or the group chat's title. */
  title?: string;
  brainId: string;
  step: WorkStep;
  /** What the step is about: a file's name, a search or a site, a command's first words, or the tool's name. */
  detail?: string;
  startedAt: ISODate;
}

/** A computer agents run on and what they do there now (GET /api/machines/activity, "machines.activity"). */
export interface MachineActivity {
  /** "local" for the hub's own computer. */
  id: string;
  name: string;
  online: boolean;
  work: MachineWork[];
}

// ---------- Machines: brain setup, keys and spend (docs/superpowers/specs/2026-10-30-cluster-design.md) ----------

/** The CLI brains a machine (piomio-node) runs. */
export type MachineBrainId = "claude-code" | "codex";

/** A model a machine's brain may use; price in dollars per million tokens. */
export interface MachineModel {
  id: string;
  /** KEY_PROVIDERS id the model is served by (key mode); unset: the brain's own (subscription). */
  provider?: string;
  price?: { input: number; output: number };
}

/** How one CLI brain on a machine signs in and what it may use. */
export interface MachineBrainSetup {
  /** subscription: the CLI's own sign-in on that machine; key: provider keys from the hub's vault, through the machine's gateway. */
  auth: "subscription" | "key";
  /** Key mode: KEY_PROVIDERS ids whose keys the machine may use. */
  providers?: string[];
  /** The models it may use; none listed: any (subscription), none (key). */
  models?: MachineModel[];
}

/** What the person set for a machine in the hub (machine_settings). */
export interface MachineSettings {
  brains: Partial<Record<MachineBrainId, MachineBrainSetup>>;
  /** How much the machine's key-mode brains may spend per period, in dollars. */
  limit?: { usd: number; period: "day" | "month" };
}

/** What the hub sends a node (node.setup): its settings with the keys resolved, and the spend so far. */
export interface NodeSetup {
  brains: Partial<Record<MachineBrainId, { auth: "subscription" | "key"; models: MachineModel[]; providers?: Array<{ id: string; key: string }> }>>;
  limit?: { usd: number; period: "day" | "month"; spent: number; resetsAt: ISODate };
  /** The hub's vault is locked: key-mode brains wait for it. */
  sealed?: boolean;
  /** Every replica of the hub, for /node/ws and /mcp (the daemon keeps a connection to each). */
  hubs?: string[];
  /** The daemon shares its workspaces folder with this hub (files.* both ways). */
  files?: boolean;
  /** What the hub calls itself in file conflicts. */
  filesName?: string;
}

/** One model call a machine's gateway made (node.usage). */
export interface MachineUsage {
  brainId: MachineBrainId;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usd: number;
  at: ISODate;
}

/** A machine's setup and what it spent this period (GET /api/machines/:id/setup, machine_setup_get). */
export interface MachineSetupView {
  machineId: string;
  settings: MachineSettings;
  spent: { usd: number; period: "day" | "month"; since: ISODate };
  /** Providers with a key in the vault. */
  keys: string[];
}

// ---------- Cluster: hub replicas ----------

/** A hub replica: a machine that holds the whole hub and may lead (replicas). */
export interface Replica {
  id: string;
  name: string;
  /** Device-app addresses (https, the hub's shared certificate). */
  urls: string[];
  /** Who leads first: 1, then 2… */
  priority: number;
  createdAt: ISODate;
}

/** A replica as the cluster sees it now (GET /api/cluster). */
export interface ReplicaState extends Replica {
  self: boolean;
  online: boolean;
  role: "leader" | "standby" | "unknown";
  sealed: boolean;
  lastSeenAt?: ISODate;
}

// ---------- Devices (phones running the Piomio app) ----------

export interface Device {
  id: string;
  name: string;
  /** "ios" for now. */
  platform: string;
  /** Hardware model identifier, e.g. "iPhone18,1". */
  model?: string;
  createdAt: ISODate;
  lastSeenAt?: ISODate;
}

/** What the web UI shows to pair a phone: the QR carries the link. */
export interface DevicePairing {
  code: string;
  expiresAt: ISODate;
  /** piomio://pair?v=1&c=…&n=…&fp=…&u=…&u=… */
  link: string;
  qrSvg: string;
  /** The device port's addresses, as the phone tries them. */
  urls: string[];
  /** base64url SHA-256 of the device port's certificate (DER). */
  fingerprint: string;
}

/** An invite for any device (a computer or a phone): POST /api/invites. */
export interface Invite {
  code: string;
  expiresAt: ISODate;
  /** https://<hub>/join/<code>: forwarded to the device or opened there. Absent when only this computer reaches the hub. */
  url?: string;
  /** piomio://pair?hub=…&code=…: opens the desktop app on the computer the web UI is open on. */
  appLink?: string;
  /** piomio://pair?v=1&c=…: the phone's link, while phones can reach the hub; `qrSvg` draws it. */
  phoneLink?: string;
  qrSvg?: string;
}

/** A device joined with an invite. */
export interface InviteUsed {
  code: string;
  kind: "machine" | "device";
  name: string;
}

/** The device port: whether phones can reach the hub, and where. */
export interface DeviceNetwork {
  /** False only when PIOMIO_DEVICES=0 closed the port: phones then use the link alone. */
  enabled: boolean;
  listening: boolean;
  port: number;
  urls: string[];
  error?: string;
}

/** Access from anywhere: the hub's own Tailscale node and its Funnel link (remote.ts). */
export type RemoteState = "off" | "starting" | "needs-login" | "needs-funnel" | "running" | "error";

export interface RemoteView {
  /** The node program is in this build. */
  available: boolean;
  enabled: boolean;
  state: RemoteState;
  /** The permanent link: https://piomio.<tailnet>.ts.net */
  url?: string;
  /** The phones' address behind the link (port 8443). */
  deviceUrl?: string;
  /** Tailscale's sign-in page (needs-login). */
  authUrl?: string;
  /** Tailscale's page that allows Funnel in the tailnet (needs-funnel). */
  enableUrl?: string;
  /** The tailnet account the node belongs to. */
  account?: string;
  /** When the node's key expires (ISO); absent when expiry is off. */
  keyExpiry?: string;
  /** Why it is unavailable or failing (in the reader's language). */
  error?: string;
  /** The link as a QR code (SVG), from GET /api/remote while it is up. */
  qrSvg?: string;
}

// ---------- Vault ----------

export type VaultState = "uninitialized" | "sealed" | "unlocked";
export type VaultItemType = "login" | "secret" | "identity" | "note";

export interface VaultScope {
  domains: string[];
  plugins: string[];
  agents: string[];
  tools: string[];
  mode: "auto" | "ask";
  revealToModel: boolean;
}

export interface VaultItemMeta {
  id: string;
  type: VaultItemType;
  name: string;
  scope: VaultScope;
  /** Non-secret hints shown to the model, e.g. username or url. */
  hints: Record<string, string>;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface VaultItem extends VaultItemMeta {
  /** Secret fields: login → {url, username, password, totp?}; secret → {value}; identity → any; note → {text}. */
  fields: Record<string, string>;
}

// ---------- Audit ----------

export interface AuditEntry {
  seq: number;
  ts: ISODate;
  actor: string; // "user", "agent:<id>", "plugin:<id>", "core", "machine:<id>"
  action: string; // "tool.call", "policy.decision", "approval.resolve", "vault.access", ...
  target?: string;
  data?: unknown;
  prevHash: string;
  hash: string;
}

// ---------- Realtime events (hub → web) ----------

export type UiEvent =
  | { type: "message.created"; data: Message }
  | { type: "message.delta"; data: { id: string; conversationId: string; delta: string } }
  | { type: "message.updated"; data: Message }
  | { type: "conversation.updated"; data: Conversation }
  | { type: "team.updated"; data: TeamMember }
  | { type: "group.updated"; data: GroupChat }
  | { type: "feed.updated"; data: Feed }
  | { type: "feed.deleted"; data: { id: string } }
  | { type: "feed.post"; data: FeedPost }
  | { type: "page.updated"; data: PageView }
  | { type: "page.deleted"; data: { id: string } }
  | { type: "task.updated"; data: Task }
  | { type: "notification.created"; data: Notification }
  | { type: "inbox.changed"; data: { unread: number } }
  | { type: "approval.pending"; data: { count: number } }
  | { type: "brains.updated"; data: Record<string, never> }
  | { type: "plugins.updated"; data: Record<string, never> }
  | { type: "agents.updated"; data: Record<string, never> }
  | { type: "skills.updated"; data: Record<string, never> }
  | { type: "settings.updated"; data: Record<string, unknown> }
  | { type: "connections.updated"; data: { provider: string } }
  | { type: "machine.updated"; data: Machine }
  | { type: "machine.setup"; data: { machineId: string } }
  | { type: "machine.spend"; data: { machineId: string } }
  | { type: "cluster.updated"; data: ReplicaState[] }
  | { type: "replica.synced"; data: { tables: string[] } }
  | { type: "machines.activity"; data: MachineActivity[] }
  | { type: "device.updated"; data: { id: string } }
  | { type: "devices.network"; data: DeviceNetwork }
  | { type: "invite.used"; data: InviteUsed }
  | { type: "remote.updated"; data: RemoteView }
  | { type: "vault.state"; data: { state: VaultState } }
  | { type: "secret.request"; data: SecretRequest }
  | { type: "agent_draft.updated"; data: AgentDraft }
  | { type: "brain.login"; data: BrainLoginState }
  | { type: "plugin.event"; data: { pluginId: string; channel: string; payload: unknown } };

// ---------- Integrations ----------

export type IntegrationStatus = "connected" | "needs-setup" | "off" | "unavailable" | "broken";

/** The outside service an integration goes through (Composio): its badge, and the note about it in the reader's language. */
export interface IntegrationVia {
  name: string;
  about: string;
  link?: string;
}

/** A card of the integrations library (GET /api/integrations) and an entry of the catalog (GET /api/catalog). */
export interface IntegrationView {
  /** The plugin's id, or a core entry's ("remote-access"). */
  id: string;
  name: string;
  summary: string;
  category: string;
  icon: string;
  /** "remote": the core's access from anywhere (RemoteView); "signin": its MCP server's own sign-in (Granola). */
  connect: "google" | "setup" | "signin" | "none" | "remote";
  status: IntegrationStatus;
  /** The connected account (e.g. an email), when there is one. */
  account?: string;
  /** Why it is broken or unavailable (in the reader's language). */
  detail?: string;
  /** Something to ask once it is on, in the person's words (the catalog's "Try"). */
  example?: string;
  /** The service's logo, on the hub (GET /api/integrations/:id/logo, a PNG): drawn instead of the icon. */
  logo?: string;
  /** One of a plugin's entries ("composio:slack"): the plugin it belongs to, which holds its setup and its switch. */
  plugin?: string;
  /** The outside service it goes through (Composio), with the badge's note in the reader's language. */
  via?: IntegrationVia;
  /** False: its sign-in finishes by itself, nothing is pasted back (an entry whose plugin watches for it). */
  signinReturn?: false;
}

/**
 * What a plugin reports about one of its catalog entries (ctx.catalog.update): the entries of its manifest and those
 * it added (which also carry their name and look). Each report replaces the last.
 */
export interface CatalogEntryState {
  /** The entry's own id ("slack"), as in the manifest. */
  id: string;
  name?: string;
  summary?: string;
  category?: string;
  icon?: string;
  example?: string;
  status: "connected" | "needs-setup" | "broken";
  /** "setup": the plugin's own secrets are missing (its setup card); "signin": the entry's Sign in button. */
  connect: "setup" | "signin";
  /** The connected account, when the service says. */
  account?: string;
  /** Why it is broken or what it waits for: plain text or a "%key%" of the plugin's locales. */
  detail?: string;
}

/** A group of the catalog: a situation in life (everyday, travel, money…) and what helps in it. */
export interface CatalogSection {
  id: string;
  /** In the reader's language. */
  title: string;
  items: IntegrationView[];
}

/**
 * Everything the person can turn on (GET /api/catalog): integrations, widgets and abilities, by situation.
 * With `?all=1` (the Plugins panel) every plugin is in it, those without a catalog card too.
 */
export interface CatalogView {
  /** Ids of the popular entries, most popular first: the ones the person uses most, then the hub's own picks. */
  popular: string[];
  sections: CatalogSection[];
}

/** A connected account of a provider (Google), as the hub keeps it. */
export interface ConnectionAccount {
  provider: "google";
  account: string;
  scopes: string[];
  connectedAt: ISODate;
  /** The provider refused the refresh token: the user must connect again. */
  broken?: boolean;
}
