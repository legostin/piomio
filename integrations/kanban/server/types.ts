// The board's data. No Node imports here: the UI bundles this file for its constants.

/** What a column means to the engine, whatever it is called. */
export const COLUMN_TYPES = ["backlog", "queue", "active", "review", "done", "cancelled"] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

/** Most urgent first. */
export const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** The person, as a card's assignee or as who did something; anything else is an agent's id. */
export const ME = "me";

export interface Column {
  id: string;
  name: string;
  type: ColumnType;
  /** How many cards it should hold (work in progress): the engine respects it in `active` columns, the board shows it. */
  limit?: number;
}

export interface Project {
  id: string;
  /** Short and unique: the start of its cards' names (SITE-12). */
  key: string;
  name: string;
  /** Notes for whoever works here: every run's goal includes them. */
  description: string;
  columns: Column[];
  nextNumber: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The same work in another tracker: importing it again finds this card. */
export interface External {
  source: string;
  id: string;
  url?: string;
}

export interface CardComment {
  id: string;
  author: string;
  text: string;
  createdAt: string;
}

export interface CardAttachment {
  id: string;
  name: string;
  mimeType?: string;
  size: number;
  addedBy: string;
  createdAt: string;
}

/** One go at the card: a task of the hub. `status` follows the task's. */
export interface Run {
  taskId: string;
  agentId: string;
  status: string;
  /** The engine took the card by itself: nobody asked, so the board tells the person how it went. */
  auto: boolean;
  startedAt: string;
  endedAt?: string;
  result?: string;
  error?: string;
  question?: string;
}

export type ActivityKind = "created" | "moved" | "assigned" | "started" | "finished" | "failed" | "cancelled" | "returned" | "accepted" | "allowed";

export interface Activity {
  at: string;
  by: string;
  kind: ActivityKind;
  params?: Record<string, string>;
}

export interface Card {
  id: string;
  projectId: string;
  number: number;
  title: string;
  description: string;
  columnId: string;
  priority: Priority;
  position: number;
  /** An agent's id, or ME; unset: anyone with a rule may take it. */
  assignee?: string;
  labels: string[];
  /** YYYY-MM-DD. */
  due?: string;
  /** Cards that have to close before this one. */
  blockedBy: string[];
  external?: External;
  /** Written by a session that had read outside content: treat its text as outside content too. */
  outside: boolean;
  /** The person let an outside card run. Any later outside write takes it back. */
  allowed: boolean;
  comments: CardComment[];
  attachments: CardAttachment[];
  runs: Run[];
  activity: Activity[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** An agent takes cards by itself: which ones, and how many at once. */
export interface PickupRule {
  agentId: string;
  enabled: boolean;
  /** Project ids; empty: every project. */
  projects: string[];
  /** A card needs one of these; empty: any card. */
  labels: string[];
  /** Only cards at least this urgent. */
  minPriority?: Priority;
  parallel: number;
  createdAt: string;
  updatedAt: string;
}

/** Why a rule is not taking cards right now; "ready" when it is. */
export type RuleState = "ready" | "off" | "paused" | "initiative" | "agentGone" | "asleep" | "budget" | "cooldown";

// ---------- what the board's page reads ----------

export interface ProjectView extends Project {
  cardCount: number;
}

/** A card on the board. */
export interface Tile {
  id: string;
  key: string;
  projectId: string;
  title: string;
  columnId: string;
  columnType: ColumnType;
  priority: Priority;
  position: number;
  assignee?: string;
  labels: string[];
  due?: string;
  /** Names of the cards it still waits for. */
  waitsFor: string[];
  external?: External;
  outside: boolean;
  allowed: boolean;
  attachmentCount: number;
  commentCount: number;
  /** The last run. */
  run?: Pick<Run, "taskId" | "agentId" | "status" | "error" | "question">;
  updatedAt: string;
}

/** A card with everything in it. */
export interface CardView extends Card {
  key: string;
  columnType: ColumnType;
  project: { id: string; key: string; name: string; columns: Column[] };
  blockers: Array<{ id: string; key: string; title: string; closed: boolean }>;
}

export interface AgentInfo {
  id: string;
  name: string;
  initiative: number;
}

export interface RuleView extends PickupRule {
  state: RuleState;
  until?: string;
  running: number;
}

export interface BoardState {
  projects: ProjectView[];
  agents: AgentInfo[];
  defaultAgent?: string;
  pickup: { on: boolean; rules: RuleView[] };
}
