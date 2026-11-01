// The demo hub's world: what a real hub would hold (the team, their dialogs and messages, tasks, channels, pages,
// machines, approvals), made fresh from a locale's content at the start of every chapter. Times are the visitor's own
// clock: history sits in the past relative to now, and what the chapter plays happens now.

import type { AgentDef, Approval, Conversation, Feed, FeedPost, IntegrationView, Locale, MachineActivity, Message, MessagePart, PageView, ProbeResult, SecretRequest, Task } from "@piomio/shared";
import type { Content } from "./content/types";

export const TEAM = ["pio", "ada", "leo", "bit"] as const;
export type AgentId = (typeof TEAM)[number];

const AVATARS: Record<AgentId, AgentDef["avatar"]> = {
  pio: { color: "teal", shape: "circle" },
  ada: { color: "pink", shape: "square" },
  leo: { color: "violet", shape: "hexagon" },
  bit: { color: "blue", shape: "diamond" },
};

const BRAINS: Record<AgentId, string[]> = {
  pio: ["claude-code@local", "codex@local", "kimi@local"],
  ada: ["claude-code@local", "codex@local"],
  leo: ["codex@local", "claude-code@local"],
  bit: ["claude-code@macbook", "codex@macbook", "claude-code@local"],
};

/** A brain as GET /api/brains lists it. */
export interface BrainView {
  ref: string;
  label: string;
  host?: string;
  login?: boolean;
  connected: boolean;
  probe?: ProbeResult;
  limitedUntil?: string;
  limitDetail?: string;
}

const CLAUDE: ProbeResult = {
  available: true,
  authenticated: true,
  version: "2.4.1",
  model: "opus",
  models: ["opus", "sonnet", "haiku"],
  modelNames: { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" },
  efforts: ["low", "medium", "high"],
};
const CODEX: ProbeResult = {
  available: true,
  authenticated: true,
  version: "0.98.0",
  model: "gpt-5.5-codex",
  models: ["gpt-5.5-codex", "gpt-5.5-mini"],
  modelNames: { "gpt-5.5-codex": "GPT-5.5 Codex", "gpt-5.5-mini": "GPT-5.5 mini" },
  efforts: ["low", "medium", "high"],
};
const KIMI: ProbeResult = {
  available: true,
  authenticated: true,
  version: "2.4.1",
  model: "k3",
  models: ["k3", "kimi-for-coding"],
  modelNames: { k3: "K3", "kimi-for-coding": "Kimi for Coding" },
  efforts: ["off", "low", "high", "max"],
};

/** Integrations whose logo the demo ships (static/logos/<id>.png, copied by the demo build). */
export const LOGOS = ["notion", "gmail", "google-calendar", "linear", "telegram", "slack", "github"];

export interface World {
  locale: Locale;
  content: Content;
  agents: AgentDef[];
  defaultAgent: AgentId;
  conversations: Conversation[];
  messages: Record<string, Message[]>;
  /** Up to when the person has read each conversation (ISO). */
  readAt: Record<string, string>;
  tasks: Task[];
  feeds: Feed[];
  posts: FeedPost[];
  pages: PageView[];
  machines: MachineActivity[];
  approvals: Approval[];
  brains: BrainView[];
  integrations: IntegrationView[];
  secretRequests: SecretRequest[];
  /** Conversations with a turn in progress. */
  running: Set<string>;
}

let seq = 0;
/** Ids that sort in creation order, like the hub's. */
export function newId(prefix: string): string {
  seq++;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36).padStart(4, "0")}`;
}

export function iso(msAgo = 0): string {
  return new Date(Date.now() - msAgo).toISOString();
}

export const MIN = 60_000;
export const HOUR = 60 * MIN;

/** Each agent's long-lived dialog has a stable id, so scripts and links can name it. */
export function dialogOf(agent: AgentId): string {
  return `dlg_${agent}`;
}

export function makeWorld(content: Content): World {
  const agents: AgentDef[] = TEAM.map((id) => ({
    id,
    name: content.cast.team[id].name,
    description: content.cast.team[id].description,
    brains: BRAINS[id],
    initiative: id === "pio" ? 2 : 1,
    tools: ["*"],
    skills: ["*"],
    policyProfile: "default",
    budget: { backgroundRunsPerDay: 40 },
    prompt: "",
    source: "user",
    avatar: AVATARS[id],
  }));
  const conversations: Conversation[] = TEAM.map((id, i) => ({
    id: dialogOf(id),
    kind: "main",
    title: content.cast.team[id].name,
    agentId: id,
    createdAt: iso(30 * 24 * HOUR),
    updatedAt: iso((i + 1) * 3 * HOUR),
  }));
  const messages: Record<string, Message[]> = {};
  const readAt: Record<string, string> = {};
  for (const c of conversations) {
    messages[c.id] = [];
    readAt[c.id] = iso(0);
  }
  // Yesterday's history in each dialog, so the team looks lived in.
  for (const id of TEAM) {
    const lines = content.history[id];
    lines.forEach((line, i) => {
      const at = iso(line.hoursAgo * HOUR - i * 1000);
      messages[dialogOf(id)].push(message(dialogOf(id), line.role, [{ type: "text", text: line.text }], { agentId: id, createdAt: at }));
    });
    const last = messages[dialogOf(id)].at(-1);
    if (last) conversations.find((c) => c.id === dialogOf(id))!.updatedAt = last.createdAt;
  }
  return {
    locale: content.locale,
    content,
    agents,
    defaultAgent: "pio",
    conversations,
    messages,
    readAt,
    tasks: [],
    feeds: [],
    posts: [],
    pages: [],
    machines: [
      { id: "local", name: content.cast.machines.home, online: true, work: [] },
      { id: "macbook", name: content.cast.machines.laptop, online: true, work: [] },
    ],
    approvals: [],
    brains: [
      { ref: "claude-code@local", label: `Claude Code · ${content.cast.machines.home}`, login: true, connected: true, probe: CLAUDE },
      { ref: "codex@local", label: `Codex · ${content.cast.machines.home}`, login: true, connected: true, probe: CODEX },
      { ref: "claude-code@macbook", label: `Claude Code · ${content.cast.machines.laptop}`, host: "macbook", connected: true, probe: CLAUDE },
      { ref: "codex@macbook", label: `Codex · ${content.cast.machines.laptop}`, host: "macbook", connected: true, probe: CODEX },
      { ref: "kimi@local", label: `Kimi Code · ${content.cast.machines.home}`, login: true, connected: true, probe: KIMI },
    ],
    integrations: content.integrations.map((x) => ({ ...x, ...(LOGOS.includes(x.id) ? { logo: `/api/integrations/${x.id}/logo` } : {}) })),
    secretRequests: [],
    running: new Set(),
  };
}

export function message(conversationId: string, role: Message["role"], parts: MessagePart[], opts: Partial<Message> = {}): Message {
  return {
    id: newId("msg"),
    conversationId,
    role,
    parts,
    status: "complete",
    createdAt: iso(0),
    ...(role === "user" ? {} : { brainRef: "claude-code@local" }),
    ...opts,
    ...(role === "user" ? { agentId: undefined } : {}),
  };
}
