// Projects and cards: in memory, written through to the plugin's storage (which replicas of the hub share). One process
// owns them, so a change here is atomic. Who may do what is decided by the callers; this file keeps the data sound.

import { randomUUID } from "node:crypto";
import { KanbanError } from "./errors.ts";
import {
  COLUMN_TYPES,
  ME,
  PRIORITIES,
  type Activity,
  type ActivityKind,
  type Card,
  type CardComment,
  type CardView,
  type Column,
  type ColumnType,
  type External,
  type Priority,
  type Project,
  type ProjectView,
  type Tile,
} from "./types.ts";

export const MAX_TITLE = 300;
export const MAX_TEXT = 50_000;
const MAX_COLUMNS = 12;
const MAX_LABELS = 20;
const MAX_ACTIVITY = 100;
const STEP = 1024;

export interface Storage {
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
}

/** Who is acting. `person`: their own hand on the board. `tainted`: a session that read outside content. */
export interface By {
  actor: string;
  person?: boolean;
  tainted?: boolean;
}

export const PERSON: By = { actor: ME, person: true };

export interface ColumnInput {
  id?: string;
  name?: string;
  type?: string;
  limit?: number | null;
}

export interface ProjectInput {
  name?: string;
  key?: string;
  description?: string;
  columns?: ColumnInput[];
  /** Where the cards of a removed column go: a column's id, name or type. */
  moveCardsTo?: string;
  archived?: boolean;
}

export interface CardInput {
  project?: string;
  title?: string;
  description?: string;
  /** A column's id, name or type. */
  status?: string;
  priority?: string;
  assignee?: string | null;
  labels?: string[];
  due?: string | null;
  blockedBy?: string[];
  external?: { source?: string; id?: string; url?: string } | null;
  /** The card it goes before in its column (id or name); unset: the end. */
  before?: string | null;
}

export interface CardFilter {
  project?: string;
  status?: string;
  assignee?: string;
  label?: string;
  priority?: string;
  query?: string;
  external?: string;
  limit?: number;
}

const id = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const now = (): string => new Date().toISOString();
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p",
  р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** A short key from a project's name: "Новый сайт" → NS, "Website" → WEBS. */
export function keyFrom(name: string): string {
  const latin = [...name.toLowerCase()].map((c) => TRANSLIT[c] ?? c).join("").replace(/[^a-z0-9]+/g, " ").trim();
  const words = latin.split(" ").filter(Boolean);
  const raw = words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] ?? "");
  const key = raw.toUpperCase().replace(/^[0-9]+/, "").slice(0, 4);
  return key.length >= 2 ? key : "PRJ";
}

export function rankOf(p: Priority): number {
  return PRIORITIES.indexOf(p);
}

export class Board {
  projects = new Map<string, Project>();
  cards = new Map<string, Card>();
  /** Something changed. `projectId` unset: the set of projects itself. */
  onChange: (change: { projectId?: string; cardId?: string }) => void = () => {};
  private storage: Storage;
  private columnNames: (type: ColumnType) => string;
  private defaultProjectName: () => string;
  private log: (message: string) => void;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(d: { storage: Storage; columnName: (type: ColumnType) => string; defaultProjectName: () => string; log: (message: string) => void }) {
    this.storage = d.storage;
    this.columnNames = d.columnName;
    this.defaultProjectName = d.defaultProjectName;
    this.log = d.log;
  }

  async load(): Promise<void> {
    for (const { value } of await this.storage.list("project:")) {
      const p = value as Project;
      this.projects.set(p.id, p);
    }
    for (const { value } of await this.storage.list("card:")) {
      const c = value as Card;
      this.cards.set(c.id, c);
    }
  }

  /** Everything written so far has reached the storage. */
  flushed(): Promise<unknown> {
    return this.writes;
  }

  private write(op: () => Promise<void>): void {
    this.writes = this.writes.then(op).catch((e) => this.log(`could not save: ${e?.message ?? e}`));
  }

  saveProject(p: Project): void {
    p.updatedAt = now();
    const copy = structuredClone(p);
    this.write(() => this.storage.set(`project:${p.id}`, copy));
    this.onChange({});
  }

  saveCard(c: Card): void {
    c.updatedAt = now();
    const copy = structuredClone(c);
    this.write(() => this.storage.set(`card:${c.id}`, copy));
    this.onChange({ projectId: c.projectId, cardId: c.id });
  }

  // ---------- projects ----------

  projectList(includeArchived = false): Project[] {
    return [...this.projects.values()].filter((p) => includeArchived || !p.archived).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** By id, key or name. */
  project(ref: string): Project {
    const r = str(ref);
    const low = r.toLowerCase();
    const list = [...this.projects.values()];
    const found = this.projects.get(r) ?? list.find((p) => p.key.toLowerCase() === low) ?? list.find((p) => p.name.toLowerCase() === low);
    if (!found) throw new KanbanError("projectNotFound", { project: r, known: this.projectList().map((p) => p.name).join(", ") || "-" });
    return found;
  }

  /** The named project; without a name the only one there is, a first one when there is none, or a question which one. */
  projectFor(ref: string | undefined): Project {
    if (str(ref)) return this.project(ref!);
    const open = this.projectList();
    if (open.length === 1) return open[0];
    if (!open.length) return this.createProject({ name: this.defaultProjectName() });
    throw new KanbanError("projectAmbiguous", { known: open.map((p) => p.name).join(", ") });
  }

  private standardColumns(): Column[] {
    return (["backlog", "queue", "active", "review", "done"] as const).map((type) => ({ id: id("col"), name: this.columnNames(type), type }));
  }

  private uniqueKey(wanted: string, except?: string): string {
    const taken = new Set([...this.projects.values()].filter((p) => p.id !== except).map((p) => p.key));
    if (!taken.has(wanted)) return wanted;
    for (let i = 2; ; i++) {
      const k = `${wanted.slice(0, 6)}${i}`;
      if (!taken.has(k)) return k;
    }
  }

  createProject(input: ProjectInput): Project {
    const name = str(input.name);
    if (!name) throw new KanbanError("nameRequired");
    if (name.length > 80) throw new KanbanError("nameTooLong");
    const key = this.checkKey(input.key) ?? this.uniqueKey(keyFrom(name));
    const at = now();
    const p: Project = {
      id: id("prj"),
      key,
      name,
      description: this.checkNotes(input.description) ?? "",
      columns: input.columns ? this.checkColumns(input.columns, []) : this.standardColumns(),
      nextNumber: 1,
      archived: false,
      createdAt: at,
      updatedAt: at,
    };
    this.projects.set(p.id, p);
    this.saveProject(p);
    return p;
  }

  updateProject(p: Project, input: ProjectInput): Project {
    const name = input.name === undefined ? undefined : str(input.name);
    if (name !== undefined) {
      if (!name) throw new KanbanError("nameRequired");
      if (name.length > 80) throw new KanbanError("nameTooLong");
    }
    const key = input.key === undefined ? undefined : this.checkKey(input.key, p.id);
    const notes = this.checkNotes(input.description);
    if (input.columns) this.replaceColumns(p, input.columns, input.moveCardsTo);
    if (name) p.name = name;
    if (key) p.key = key;
    if (notes !== undefined) p.description = notes;
    if (typeof input.archived === "boolean") p.archived = input.archived;
    this.saveProject(p);
    return p;
  }

  private checkKey(raw: string | undefined, except?: string): string | undefined {
    const k = str(raw).toUpperCase();
    if (!k) return undefined;
    if (!/^[A-Z][A-Z0-9]{1,7}$/.test(k)) throw new KanbanError("keyInvalid", { key: k });
    if ([...this.projects.values()].some((p) => p.key === k && p.id !== except)) throw new KanbanError("keyTaken", { key: k });
    return k;
  }

  private checkNotes(raw: unknown): string | undefined {
    if (raw === undefined) return undefined;
    const notes = String(raw ?? "");
    if (notes.length > MAX_TEXT) throw new KanbanError("textTooLong", { max: MAX_TEXT });
    return notes;
  }

  private checkColumns(list: ColumnInput[], existing: Column[]): Column[] {
    if (!Array.isArray(list) || !list.length) throw new KanbanError("columnsRequired");
    if (list.length > MAX_COLUMNS) throw new KanbanError("columnsTooMany", { max: MAX_COLUMNS });
    const seen = new Set<string>();
    return list.map((c) => {
      const name = str(c?.name);
      if (!name || name.length > 40) throw new KanbanError("columnNameInvalid", { name });
      const low = name.toLowerCase();
      if (seen.has(low)) throw new KanbanError("columnNameTaken", { name });
      seen.add(low);
      const old = existing.find((x) => x.id === c.id) ?? existing.find((x) => x.name.toLowerCase() === low);
      const type = str(c.type) || old?.type;
      if (!COLUMN_TYPES.includes(type as ColumnType)) throw new KanbanError("columnTypeInvalid", { type: type ?? "", types: COLUMN_TYPES.join(", ") });
      const limit = c.limit === null ? undefined : (c.limit ?? old?.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new KanbanError("columnLimitInvalid", { name });
      return { id: old?.id ?? id("col"), name, type: type as ColumnType, ...(limit ? { limit } : {}) };
    });
  }

  private replaceColumns(p: Project, input: ColumnInput[], moveCardsTo: string | undefined): void {
    const next = this.checkColumns(input, p.columns);
    const kept = new Set(next.map((c) => c.id));
    const moves: Array<[Card, Column]> = [];
    for (const gone of p.columns.filter((c) => !kept.has(c.id))) {
      const cards = this.columnCards(gone.id);
      if (!cards.length) continue;
      const target = moveCardsTo ? this.findColumn(next, moveCardsTo) : next.find((c) => c.type === gone.type);
      if (!target) throw new KanbanError("columnHasCards", { name: gone.name, count: cards.length });
      for (const card of cards) moves.push([card, target]);
    }
    p.columns = next;
    for (const [card, target] of moves) {
      card.columnId = target.id;
      card.position = this.endOf(target.id);
      this.saveCard(card);
    }
  }

  removeProject(p: Project): void {
    for (const c of this.cardsOf(p.id)) this.removeCard(c);
    this.projects.delete(p.id);
    this.write(() => this.storage.delete(`project:${p.id}`));
    this.onChange({});
  }

  // ---------- columns ----------

  private findColumn(columns: Column[], ref: string): Column | undefined {
    const low = str(ref).toLowerCase();
    return columns.find((c) => c.id === ref) ?? columns.find((c) => c.name.toLowerCase() === low) ?? columns.find((c) => c.type === low);
  }

  /** By id, name or type (the first column of that type). */
  column(p: Project, ref: string): Column {
    const found = this.findColumn(p.columns, ref);
    if (!found) throw new KanbanError("columnNotFound", { column: ref, project: p.name, known: p.columns.map((c) => `${c.name} (${c.type})`).join(", ") });
    return found;
  }

  firstOfType(p: Project, type: ColumnType): Column | undefined {
    return p.columns.find((c) => c.type === type);
  }

  columnOf(card: Card): Column {
    const p = this.projects.get(card.projectId);
    return p?.columns.find((c) => c.id === card.columnId) ?? p?.columns[0] ?? { id: card.columnId, name: "?", type: "backlog" };
  }

  columnCards(columnId: string): Card[] {
    return [...this.cards.values()].filter((c) => c.columnId === columnId).sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
  }

  private endOf(columnId: string): number {
    return (this.columnCards(columnId).at(-1)?.position ?? 0) + STEP;
  }

  // ---------- cards ----------

  cardsOf(projectId: string): Card[] {
    return [...this.cards.values()].filter((c) => c.projectId === projectId);
  }

  keyOf(card: Card): string {
    return `${this.projects.get(card.projectId)?.key ?? "?"}-${card.number}`;
  }

  /** By id or name (SITE-12). */
  card(ref: string): Card {
    const r = str(ref);
    const byId = this.cards.get(r);
    if (byId) return byId;
    const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(r);
    if (m) {
      const key = m[1].toUpperCase();
      const number = Number(m[2]);
      const p = [...this.projects.values()].find((x) => x.key === key);
      const found = p && this.cardsOf(p.id).find((c) => c.number === number);
      if (found) return found;
    }
    throw new KanbanError("cardNotFound", { card: r });
  }

  findExternal(source: string, externalId: string): Card | undefined {
    return [...this.cards.values()].find((c) => c.external?.source === source && c.external.id === externalId);
  }

  private checkTitle(raw: unknown): string {
    const title = str(raw).replace(/\s+/g, " ");
    if (!title) throw new KanbanError("titleRequired");
    if (title.length > MAX_TITLE) throw new KanbanError("titleTooLong", { max: MAX_TITLE });
    return title;
  }

  private checkDescription(raw: unknown): string {
    const text = String(raw ?? "");
    if (text.length > MAX_TEXT) throw new KanbanError("textTooLong", { max: MAX_TEXT });
    return text;
  }

  private checkPriority(raw: unknown): Priority {
    const p = str(raw).toLowerCase();
    if (!PRIORITIES.includes(p as Priority)) throw new KanbanError("priorityInvalid", { priority: p, known: PRIORITIES.join(", ") });
    return p as Priority;
  }

  private checkLabels(raw: unknown): string[] {
    if (!Array.isArray(raw)) throw new KanbanError("labelsInvalid");
    const out = [...new Set(raw.map((l) => str(l).toLowerCase()).filter(Boolean))];
    if (out.length > MAX_LABELS || out.some((l) => l.length > 40)) throw new KanbanError("labelsInvalid");
    return out;
  }

  private checkDue(raw: unknown): string | undefined {
    const due = str(raw);
    if (!due) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(`${due}T00:00:00Z`))) throw new KanbanError("dueInvalid", { due });
    return due;
  }

  checkExternal(raw: CardInput["external"]): External | undefined {
    if (!raw) return undefined;
    const source = str(raw.source).toLowerCase();
    const externalId = str(raw.id);
    if (!/^[a-z0-9_-]{1,40}$/.test(source) || !externalId || externalId.length > 200) throw new KanbanError("externalInvalid");
    const url = str(raw.url);
    if (url && !/^https?:\/\//i.test(url)) throw new KanbanError("externalInvalid");
    return { source, id: externalId, ...(url ? { url } : {}) };
  }

  /** The cards a card would wait for, by reference. A card cannot end up waiting for itself, however long the chain. */
  private checkBlockers(card: { id: string }, refs: unknown): string[] {
    if (!Array.isArray(refs)) throw new KanbanError("blockedByInvalid");
    const ids = [...new Set(refs.map((r) => this.card(String(r)).id))];
    if (ids.includes(card.id)) throw new KanbanError("blockedByCycle", { card: card.id });
    const seen = new Set<string>();
    const walk = (cid: string): boolean => {
      if (cid === card.id) return true;
      if (seen.has(cid)) return false;
      seen.add(cid);
      return (this.cards.get(cid)?.blockedBy ?? []).some(walk);
    };
    const looped = ids.find(walk);
    if (looped) throw new KanbanError("blockedByCycle", { card: this.keyOf(this.cards.get(looped)!) });
    return ids;
  }

  createCard(input: CardInput, by: By): Card {
    const p = this.projectFor(input.project);
    if (p.archived) throw new KanbanError("projectArchived", { project: p.name });
    const title = this.checkTitle(input.title);
    const column = input.status ? this.column(p, input.status) : p.columns[0];
    const at = now();
    const card: Card = {
      id: id("card"),
      projectId: p.id,
      number: p.nextNumber,
      title,
      description: input.description === undefined ? "" : this.checkDescription(input.description),
      columnId: column.id,
      priority: input.priority ? this.checkPriority(input.priority) : "none",
      position: this.endOf(column.id),
      labels: input.labels ? this.checkLabels(input.labels) : [],
      blockedBy: [],
      outside: !!by.tainted,
      allowed: false,
      comments: [],
      attachments: [],
      runs: [],
      activity: [],
      createdBy: by.actor,
      createdAt: at,
      updatedAt: at,
    };
    const due = this.checkDue(input.due);
    if (due) card.due = due;
    if (input.assignee) card.assignee = input.assignee;
    const external = this.checkExternal(input.external);
    if (external) card.external = external;
    if (input.blockedBy) card.blockedBy = this.checkBlockers(card, input.blockedBy);
    p.nextNumber++;
    this.cards.set(card.id, card);
    this.note(card, by, "created");
    this.saveProject(p);
    this.saveCard(card);
    if (input.before) this.move(card, column, { before: input.before, by });
    return card;
  }

  /** A change to what the card says, from a session that read outside content, makes the card outside content. */
  written(card: Card, by: By): void {
    if (by.tainted) {
      card.outside = true;
      card.allowed = false;
    }
  }

  updateCard(card: Card, input: CardInput, by: By): Card {
    const p = this.projects.get(card.projectId)!;
    // Everything is checked first: a bad field changes nothing.
    const title = input.title === undefined ? undefined : this.checkTitle(input.title);
    const description = input.description === undefined ? undefined : this.checkDescription(input.description);
    const priority = input.priority === undefined ? undefined : this.checkPriority(input.priority);
    const labels = input.labels === undefined ? undefined : this.checkLabels(input.labels);
    const due = input.due === undefined ? undefined : (this.checkDue(input.due) ?? null);
    const external = input.external === undefined ? undefined : (this.checkExternal(input.external) ?? null);
    const blockedBy = input.blockedBy === undefined ? undefined : this.checkBlockers(card, input.blockedBy);
    const column = input.status ? this.column(p, input.status) : undefined;

    if (title !== undefined || description !== undefined || labels !== undefined || external !== undefined) this.written(card, by);
    if (title !== undefined) card.title = title;
    if (description !== undefined) card.description = description;
    if (priority !== undefined) card.priority = priority;
    if (labels !== undefined) card.labels = labels;
    if (due !== undefined) {
      if (due) card.due = due;
      else delete card.due;
    }
    if (external !== undefined) {
      if (external) card.external = external;
      else delete card.external;
    }
    if (blockedBy !== undefined) card.blockedBy = blockedBy;
    if (input.assignee !== undefined && (input.assignee || undefined) !== card.assignee) {
      if (input.assignee) card.assignee = input.assignee;
      else delete card.assignee;
      this.note(card, by, "assigned", input.assignee ? { to: input.assignee } : {});
    }
    if (column && (column.id !== card.columnId || input.before)) return this.move(card, column, { before: input.before, by });
    this.saveCard(card);
    return card;
  }

  /** Puts the card in the column, before another card or at the end. The person's hand on an outside card lets it run. */
  move(card: Card, column: Column, o: { before?: string | null; by: By }): Card {
    const from = this.columnOf(card);
    card.position = this.positionFor(column.id, card.id, o.before);
    card.columnId = column.id;
    if (from.id !== column.id) this.note(card, o.by, "moved", { from: from.name, to: column.name });
    if (o.by.person && card.outside && !card.allowed && (column.type === "queue" || column.type === "active")) {
      card.allowed = true;
      this.note(card, o.by, "allowed");
    }
    this.saveCard(card);
    return card;
  }

  private positionFor(columnId: string, moving: string, before: string | null | undefined): number {
    const list = this.columnCards(columnId).filter((c) => c.id !== moving);
    const end = (list.at(-1)?.position ?? 0) + STEP;
    if (!before) return end;
    const target = this.cards.get(before) ?? this.card(before);
    const at = list.findIndex((c) => c.id === target.id);
    if (at < 0) return end;
    const next = list[at].position;
    const prev = at > 0 ? list[at - 1].position : next - 2 * STEP;
    if (next - prev > 1e-6) return (prev + next) / 2;
    // Moved to the same spot too many times: space the column out again.
    list.forEach((c, i) => {
      c.position = (i + 1) * STEP;
      this.saveCard(c);
    });
    return list[at].position - STEP / 2;
  }

  comment(card: Card, text: string, by: By): CardComment {
    const t = String(text ?? "").trim();
    if (!t) throw new KanbanError("commentRequired");
    if (t.length > MAX_TEXT) throw new KanbanError("textTooLong", { max: MAX_TEXT });
    this.written(card, by);
    const c: CardComment = { id: id("cmt"), author: by.actor, text: t, createdAt: now() };
    card.comments.push(c);
    this.saveCard(card);
    return c;
  }

  note(card: Card, by: By, kind: ActivityKind, params?: Record<string, string>): void {
    const item: Activity = { at: now(), by: by.actor, kind, ...(params && Object.keys(params).length ? { params } : {}) };
    card.activity.push(item);
    if (card.activity.length > MAX_ACTIVITY) card.activity.splice(0, card.activity.length - MAX_ACTIVITY);
  }

  removeCard(card: Card): void {
    this.cards.delete(card.id);
    this.write(() => this.storage.delete(`card:${card.id}`));
    for (const other of this.cards.values()) {
      if (other.blockedBy.includes(card.id)) {
        other.blockedBy = other.blockedBy.filter((x) => x !== card.id);
        this.saveCard(other);
      }
    }
    this.onChange({ projectId: card.projectId, cardId: card.id });
  }

  /** The person let an outside card run. */
  allow(card: Card, by: By): void {
    if (!card.outside || card.allowed) return;
    card.allowed = true;
    this.note(card, by, "allowed");
    this.saveCard(card);
  }

  isClosed(card: Card): boolean {
    const type = this.columnOf(card).type;
    return type === "done" || type === "cancelled";
  }

  openBlockers(card: Card): Card[] {
    return card.blockedBy.flatMap((b) => {
      const c = this.cards.get(b);
      return c && !this.isClosed(c) ? [c] : [];
    });
  }

  filter(f: CardFilter): Card[] {
    const projects = f.project ? [this.project(f.project)] : this.projectList();
    const query = str(f.query).toLowerCase();
    const label = str(f.label).toLowerCase();
    const status = str(f.status).toLowerCase();
    const out: Card[] = [];
    for (const p of projects) {
      const columns = status ? p.columns.filter((c) => c.id === f.status || c.name.toLowerCase() === status || c.type === status) : p.columns;
      for (const column of columns) {
        for (const c of this.columnCards(column.id)) {
          if (f.assignee && (c.assignee ?? "") !== f.assignee) continue;
          if (label && !c.labels.includes(label)) continue;
          if (f.priority && c.priority !== f.priority) continue;
          if (f.external && `${c.external?.source}:${c.external?.id}` !== f.external) continue;
          if (query && !`${this.keyOf(c)} ${c.title} ${c.description} ${c.labels.join(" ")} ${c.external?.id ?? ""}`.toLowerCase().includes(query)) continue;
          out.push(c);
        }
      }
    }
    return out.slice(0, f.limit && f.limit > 0 ? f.limit : 100);
  }

  // ---------- views ----------

  projectView(p: Project): ProjectView {
    return { ...p, cardCount: this.cardsOf(p.id).length };
  }

  tile(c: Card): Tile {
    const last = c.runs.at(-1);
    const column = this.columnOf(c);
    return {
      id: c.id,
      key: this.keyOf(c),
      projectId: c.projectId,
      title: c.title,
      columnId: c.columnId,
      columnType: column.type,
      priority: c.priority,
      position: c.position,
      ...(c.assignee ? { assignee: c.assignee } : {}),
      labels: c.labels,
      ...(c.due ? { due: c.due } : {}),
      waitsFor: this.openBlockers(c).map((b) => this.keyOf(b)),
      ...(c.external ? { external: c.external } : {}),
      outside: c.outside,
      allowed: c.allowed,
      attachmentCount: c.attachments.length,
      commentCount: c.comments.length,
      ...(last ? { run: { taskId: last.taskId, agentId: last.agentId, status: last.status, ...(last.error ? { error: last.error } : {}), ...(last.question ? { question: last.question } : {}) } } : {}),
      updatedAt: c.updatedAt,
    };
  }

  view(c: Card): CardView {
    const p = this.projects.get(c.projectId)!;
    return {
      ...c,
      key: this.keyOf(c),
      columnType: this.columnOf(c).type,
      project: { id: p.id, key: p.key, name: p.name, columns: p.columns },
      blockers: c.blockedBy.flatMap((b) => {
        const x = this.cards.get(b);
        return x ? [{ id: x.id, key: this.keyOf(x), title: x.title, closed: this.isClosed(x) }] : [];
      }),
    };
  }
}
