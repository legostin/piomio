// Memory service: every read/write path of the plugin (tools, hooks, HTTP) goes through here.
// Mutations are serialized; each one updates the search index, regenerates MEMORY.md and commits to git.
//
// Capture (remember): secrets refused, duplicates confirmed, facts with the same subject + slot (or named in
// `replaces`) superseded with history, sensitive ones marked. Recall: a core block at session start
// and the facts relevant to each turn. Consolidation (tidy): expire, merge near-duplicates, archive stale facts.

import { renameSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { GitRepo } from "./git.ts";
import { openIndex, SubstringIndex, type SearchHit, type SearchIndex } from "./search.ts";
import {
  MemoryStore,
  INDEX_FILE,
  PROFILE_FILE,
  DEFAULT_FOLDERS,
  KINDS,
  KIND_FOLDER,
  clampImportance,
  entitiesFromTitle,
  isCurrent,
  isKind,
  kindOfPath,
  newFact,
  normalizeEntities,
  normalizeTags,
  parseFact,
  serializeFact,
  stripFrontmatter,
  visibleTo,
  type Fact,
  type FactKind,
  type ReviewItem,
  type Source,
} from "./store.ts";
import { dirOf, MemoryError, normalizePath, NotFoundError, PathError, slugify } from "./paths.ts";
import { containment, headline, looksSensitive, negated, overlap, sameEntity, secretReason, stem, stems, words } from "./text.ts";
import { factLine, rank, strongest, within, type Scored } from "./recall.ts";
import { MemoryState, type Storage } from "./state.ts";
import { conflictOriginal, keepLocal, removeLocalCopies } from "./replicas.ts";

export interface MemoryOptions {
  dataDir: string;
  /** The hub's plugin storage (ctx.storage): the working state, shared by hub replicas. */
  storage: Storage;
  git?: boolean;
  promptMaxChars?: number;
  recallMaxChars?: number;
  forceSubstringSearch?: boolean;
  warn: (msg: string) => void;
  /** Notify web clients (ctx.ui.emit). */
  changed: (path: string, action: string) => void;
}

export interface WriteInput {
  path?: string;
  title: string;
  content: string;
  tags?: string[] | string;
}

/** Who is saving a fact, from where. */
export interface Actor {
  agentId: string;
  conversationId?: string;
  sessionId?: string;
  /** The user's words the fact came from. */
  quote?: string;
}

export interface RememberInput {
  fact: string;
  title?: string;
  kind?: string;
  about?: string[] | string;
  slot?: string;
  importance?: number;
  when?: string;
  until?: string;
  scope?: string;
  sensitive?: boolean;
  replaces?: string[] | string;
  tags?: string[] | string;
}

export interface RememberResult {
  status: "created" | "known";
  path: string;
  title: string;
  replaced: string[];
  related: Fact[];
  /** Named in `replaces` but longer notes: left as they are (memory_write updates them). */
  kept?: string[];
}

export interface FactEdit {
  text?: string;
  title?: string;
  kind?: string;
  importance?: number;
  about?: string[] | string;
  validUntil?: string;
  scope?: string;
}

const MAX_CONTENT = 100_000;
const MAX_FACT = 2_000;
const MAX_TITLE = 200;
/** A session sees a recalled fact again only after this many turns. */
const RESHOW_AFTER = 8;
const DAY = 86_400_000;

const tooLong = () => new PathError("contentTooLong", `Text is too long (max ${MAX_CONTENT} characters)`, { max: MAX_CONTENT });
const indexReadOnly = () => new PathError("indexReadOnly", `${INDEX_FILE} is generated automatically and cannot be edited`, { file: INDEX_FILE });
/** Exported for the HTTP handler. */
export const factNotFound = (path: string) => new NotFoundError("factNotFound", `Fact not found: ${path}`, { path });
const notInReview = (path: string) => new NotFoundError("notInReview", `No fact pending review at ${path}`, { path });
const notInTrash = (path: string) => new NotFoundError("notInTrash", `Nothing to restore at ${path}`, { path });
/** A secret in a fact: refused with a pointer to the vault. */
export class SecretError extends MemoryError {}

function isoDate(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
}

const today = () => new Date().toISOString().slice(0, 10);

/** Normalized words of a slot or subject: "Home city" = "home  cities". */
const key = (s: string) => words(s).map(stem).join(" ");

/** Who or what a fact is about: the user for facts about them and their preferences, else its first entity. */
function subject(f: Pick<Fact, "about" | "kind">): string {
  if (f.kind === "self" || f.kind === "preference" || f.kind === "howto") return "user";
  return f.about.length ? key(f.about[0]) : "";
}

function factStems(f: Pick<Fact, "title" | "body">, max = 64): string[] {
  return stems(`${f.body || f.title}`, max);
}

/** A single fact a newer one can replace (or merge with); longer notes such as the profile hold many facts. */
const SHORT = 600;
function replaceable(f: Fact): boolean {
  return f.path !== PROFILE_FILE && f.body.length <= SHORT;
}

function sameSource(a: Source, b: Source): boolean {
  return a.agent === b.agent && (a.session ?? "") === (b.session ?? "") && (a.conversation ?? "") === (b.conversation ?? "");
}

function mergeSources(a: Source[], b: Source[]): Source[] {
  const out = [...a];
  for (const s of b) if (!out.some((x) => sameSource(x, s) && x.at === s.at)) out.push(s);
  return out.sort((x, y) => x.at.localeCompare(y.at)).slice(-20);
}

function union(a: string[], b: string[], max = 20): string[] {
  const out = [...a];
  for (const x of b) if (!out.some((y) => y.toLowerCase() === x.toLowerCase())) out.push(x);
  return out.slice(0, max);
}

const DEFAULT_IMPORTANCE: Record<FactKind, number> = { self: 4, preference: 4, person: 3, place: 3, project: 3, event: 3, howto: 3, note: 2 };

export class Memory {
  store: MemoryStore;
  index!: SearchIndex;
  state!: MemoryState;
  git: GitRepo;
  o: MemoryOptions;
  private queue: Promise<unknown> = Promise.resolve();
  private watcher?: FSWatcher;
  private poll?: NodeJS.Timeout;
  private soonTimer?: NodeJS.Timeout;
  private stopped = false;
  /** By session: its turn count and when it last saw each fact (core facts: forever). */
  private sessions = new Map<string, { turn: number; shown: Map<string, number> }>();

  constructor(o: MemoryOptions) {
    this.o = o;
    this.store = new MemoryStore(join(o.dataDir, "memory"));
    this.git = new GitRepo(this.store.root, o.warn);
  }

  async start(): Promise<void> {
    keepLocal(this.o.dataDir);
    const copies = removeLocalCopies(this.o.dataDir);
    if (copies) this.o.warn(`memory: removed ${copies} conflict copies of files each hub builds itself`);
    this.store.init();
    this.state = await MemoryState.open(this.o.storage, this.o.dataDir, this.o.warn);
    this.index = this.openIndex();
    if (this.o.git !== false) await this.git.init();
    await this.foldConflicts();
    this.reindex();
    this.store.writeIndex();
    await this.git.commit("memory: sync");
    this.watch();
  }

  /** Let pending writes (and their git commits) finish, then close the index. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.watcher?.close();
    clearInterval(this.poll);
    clearTimeout(this.soonTimer);
    await this.queue;
    await this.state?.flush();
    this.index?.close();
  }

  /** Serialize mutations (tools and HTTP may run concurrently). */
  private lock<T>(fn: () => Promise<T> | T): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  private openIndex(): SearchIndex {
    return openIndex(join(this.o.dataDir, "index.db"), {
      forceSubstring: this.o.forceSubstringSearch,
      onFallback: (r) => this.o.warn(`FTS5 is unavailable, using substring search: ${r}`),
    });
  }

  private current(): Fact[] {
    return [...this.store.facts.values()].filter((f) => isCurrent(f));
  }

  private reindex(): void {
    this.indexed((i) => i.rebuild(this.current()));
  }

  /** Keep the search index in step with one fact. */
  private sync(f: Fact | undefined, path: string): void {
    this.indexed((i) => (f && isCurrent(f) ? i.upsert(f) : i.remove(path)));
  }

  /** The search index is built from the files, so a failure there never fails a save: it is built again instead. */
  private indexed(fn: (index: SearchIndex) => void): void {
    try {
      fn(this.index);
    } catch (e) {
      this.reopenIndex(e);
    }
  }

  /** A fresh index from the facts (SQLite turns read-only when its file is replaced underneath, say). */
  private reopenIndex(e: unknown): void {
    this.o.warn(`memory: the search index failed (${(e as Error)?.message ?? e}); building it again`);
    this.index.close();
    this.index = this.openIndex();
    try {
      this.index.rebuild(this.current());
    } catch (again) {
      this.o.warn(`memory: the search index cannot be built (${(again as Error)?.message ?? again}); searching without it`);
      this.index.close();
      this.index = new SubstringIndex();
      this.index.rebuild(this.current());
    }
  }

  // ---------- other hubs ----------

  /**
   * Facts that change on disk while the plugin runs: another hub's copies arriving (after a handover, or when both
   * led for a while; replicas.ts), or a hand edit. They are taken in a second later.
   */
  private watch(): void {
    const poll = () => {
      this.poll ??= setInterval(() => this.soon(), 30_000);
      this.poll.unref?.();
    };
    try {
      this.watcher = watch(this.store.root, { recursive: true }, (_event, name) => {
        const rel = name ? String(name).replace(/\\/g, "/") : "";
        if (rel && (!rel.endsWith(".md") || rel === INDEX_FILE || rel.split("/").some((s) => s.startsWith(".")))) return;
        this.soon();
      });
      this.watcher.on("error", (e) => {
        this.o.warn(`memory: cannot watch its folder (${e.message}); looking every 30 s`);
        this.watcher?.close();
        this.watcher = undefined;
        poll();
      });
      this.watcher.unref();
    } catch (e) {
      this.o.warn(`memory: cannot watch its folder (${(e as Error).message}); looking every 30 s`);
      poll();
    }
  }

  private soon(): void {
    if (this.stopped) return;
    clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => void this.refresh().catch((e) => this.o.warn(`memory: could not take in changed facts: ${e?.message ?? e}`)), 1000);
    this.soonTimer.unref?.();
  }

  /** Take in facts changed on disk without this plugin; true when there were any. */
  refresh(): Promise<boolean> {
    return this.lock(async () => {
      const before = this.signature();
      this.store.scan();
      const folded = await this.foldConflicts();
      if (!folded && this.signature() === before) return false;
      this.reindex();
      await this.commit("sync", "");
      return true;
    });
  }

  /** What the facts say, to tell whether a scan found anything new. */
  private signature(): string {
    return [...this.store.facts.values(), ...this.store.review.values()]
      .map((f) => `${f.path}\n${serializeFact(f)}`)
      .sort()
      .join("\n\0");
  }

  /**
   * Copies the file sync kept of a fact both hubs changed: the newer version stays in place, the copy's sources join
   * it, and the copy goes (committed first, so its text stays in the history). A copy of a fact gone here takes its
   * place; a copy of MEMORY.md just goes. Returns how many were folded.
   */
  private async foldConflicts(): Promise<number> {
    const copies = [...this.store.facts.keys(), ...[...this.store.review.values()].filter((r) => r.inPlace).map((r) => r.path)].flatMap((path) => {
      const original = conflictOriginal(path);
      return original ? [{ path, original }] : [];
    });
    if (!copies.length) return 0;
    await this.git.commit("memory: sync");
    for (const { path, original } of copies) {
      const copy = this.store.facts.get(path) ?? this.store.review.get(path);
      const kept = this.store.facts.get(original);
      if (copy && original !== INDEX_FILE) {
        if (kept) {
          const sources = mergeSources(kept.sources, copy.sources);
          if (sources.length !== kept.sources.length) this.store.put({ ...kept, sources });
        } else if (!this.store.review.has(original)) {
          renameSync(this.store.abs(path), this.store.abs(original));
          continue;
        }
      }
      this.store.removeActive(path);
    }
    this.store.scan();
    return copies.length;
  }

  private async commit(action: string, path: string): Promise<void> {
    this.store.writeIndex();
    await this.git.commit(`memory: ${action} ${path}`.trim());
    this.o.changed(path, action);
  }

  private taken(path: string): boolean {
    return this.store.facts.has(path) || this.store.review.has(path) || this.store.inTrash(path);
  }

  private uniquePath(folder: string, title: string, sameTitle = true): string {
    const slug = slugify(title);
    for (let i = 1; ; i++) {
      const path = `${folder}/${slug}${i > 1 ? `-${i}` : ""}.md`;
      const existing = this.store.facts.get(path) ?? this.store.review.get(path);
      if (!this.taken(path) || (sameTitle && existing && existing.title.toLowerCase() === title.toLowerCase())) return path;
    }
  }

  private source(actor: Actor): Source {
    const quote = actor.quote?.replace(/\s+/g, " ").trim();
    return {
      agent: actor.agentId || "assistant",
      ...(actor.conversationId ? { conversation: actor.conversationId } : {}),
      ...(actor.sessionId ? { session: actor.sessionId } : {}),
      at: new Date().toISOString(),
      ...(quote && !secretReason(quote) ? { quote: quote.length > 200 ? `${quote.slice(0, 199)}…` : quote } : {}),
    };
  }

  // ---------- capture ----------

  /** Save one fact from a conversation: dedupe and supersede. Sensitive ones are saved too, marked as such. */
  remember(input: RememberInput, actor: Actor): Promise<RememberResult> {
    return this.lock(async () => {
      const text = stripFrontmatter(String(input.fact ?? "")).replace(/[ \t]+/g, " ").trim();
      if (!text) throw new PathError("factRequired", "The fact text (fact) is required");
      if (text.length > MAX_FACT) throw new PathError("factTooLong", `A fact is at most ${MAX_FACT} characters: save one fact per call`, { max: MAX_FACT });
      const title = String(input.title ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) || headline(text);
      const secret = secretReason(`${title}\n${text}\n${String(input.about ?? "")}`);
      if (secret) {
        throw new SecretError(
          "secret",
          "Not saved: this looks like a secret (a password, token, key or card number). Secrets never go into memory: they belong in the vault. Remember only a reference such as vault://<id> if needed.",
        );
      }
      const scope = input.scope === "me" || input.scope === `agent:${actor.agentId}` ? `agent:${actor.agentId}` : "team";
      const about = normalizeEntities(input.about ?? []);
      const kind: FactKind = isKind(input.kind) ? input.kind : about.length ? "person" : /(?<!\p{L})(user|пользовател)/iu.test(text) ? "self" : "note";
      const slot = String(input.slot ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      const draft = { title, body: text, about, kind };
      const mine = stems(text);
      const pool = [...this.store.facts.values()].filter((f) => isCurrent(f) && f.scope === scope);
      const now = new Date().toISOString();
      const src = this.source(actor);

      // What it replaces: named by the agent, or the same subject and slot (newest wins, the old one keeps its history).
      // Longer notes (the profile, a person's page) hold many facts: they are updated with memory_write, never archived whole.
      const named = (Array.isArray(input.replaces) ? input.replaces : input.replaces ? [input.replaces] : []).map((p) => {
        try {
          return normalizePath(String(p));
        } catch {
          return "";
        }
      });
      const replaced = new Set<string>();
      const kept: string[] = [];
      for (const p of named) {
        const f = this.store.facts.get(p);
        if (!f || !isCurrent(f) || !visibleTo(f, actor.agentId)) continue;
        if (replaceable(f)) replaced.add(p);
        else kept.push(p);
      }
      const subj = subject(draft);
      if (slot && subj) {
        for (const f of pool) if (f.slot && key(f.slot) === key(slot) && subject(f) === subj && replaceable(f)) replaced.add(f.path);
      }

      // Already known: the same claim, maybe in other words. It gains a source and confidence.
      const candidates = (list: Fact[]) => list.filter((f) => !replaced.has(f.path) && !(slot && f.slot && key(f.slot) === key(slot)));
      const dup = this.duplicateOf(text, mine, candidates(pool)) ?? this.duplicateOf(text, mine, candidates([...this.store.review.values()].filter((f) => f.scope === scope)));
      if (dup) {
        if (dup.status === "review") return { status: "known", path: dup.path, title: dup.title, replaced: [], related: [], kept };
        const fact: Fact = {
          ...dup,
          sources: mergeSources(dup.sources, [src]),
          confidence: Math.min(1, Math.round((dup.confidence + 0.1) * 100) / 100),
          importance: input.importance !== undefined ? Math.max(dup.importance, clampImportance(input.importance)) : dup.importance,
          about: union(dup.about, about, 12),
          updated: now,
        };
        this.store.put(fact);
        this.sync(fact, fact.path);
        await this.commit("confirm", fact.path);
        return { status: "known", path: fact.path, title: fact.title, replaced: [], related: [], kept };
      }

      const sensitive = input.sensitive === true || looksSensitive(`${title}\n${text}`);
      const path = this.uniquePath(KIND_FOLDER[kind], title, false);
      const fact = newFact({
        path,
        title,
        kind,
        about,
        slot,
        tags: normalizeTags(input.tags ?? []),
        importance: clampImportance(input.importance, DEFAULT_IMPORTANCE[kind]),
        confidence: 0.9,
        validFrom: isoDate(input.when),
        validUntil: isoDate(input.until),
        supersedes: [...replaced],
        scope,
        sensitive,
        created: now,
        updated: now,
        source: `${actor.agentId}/${actor.sessionId ?? ""}`.replace(/\/$/, ""),
        sources: [src],
        body: text,
      });
      const related = this.relatedTo(fact, mine, pool, replaced);
      this.store.put(fact);
      this.sync(fact, path);
      this.supersede([...replaced], fact);
      await this.commit("remember", path);
      return { status: "created", path, title, replaced: [...replaced], related, kept };
    });
  }

  /** The same claim already known: near-identical words, and both say yes or both say no. */
  private duplicateOf(text: string, mine: string[], pool: Fact[]): Fact | undefined {
    let best: { f: Fact; s: number } | undefined;
    const no = negated(text);
    for (const f of pool) {
      if (negated(f.body || f.title) !== no) continue;
      const theirs = factStems(f);
      const o = overlap(mine, theirs);
      const c = containment(mine, theirs);
      const same = o >= 0.8 || (c >= 0.9 && Math.min(mine.length, theirs.length) >= 4 && o >= 0.6);
      if (same && (!best || o > best.s)) best = { f, s: o };
    }
    return best?.f;
  }

  private relatedTo(fact: Fact, mine: string[], pool: Fact[], skip: Set<string>): Fact[] {
    return pool
      .filter((f) => !skip.has(f.path) && f.path !== fact.path)
      .map((f) => ({ f, s: overlap(mine, factStems(f)) + (f.about.some((a) => fact.about.some((b) => sameEntity(a, b))) ? 0.3 : 0) + (fact.slot && f.slot && key(f.slot) === key(fact.slot) ? 0.3 : 0) }))
      .filter((x) => x.s >= 0.3)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3)
      .map((x) => x.f);
  }

  /** Archive facts a newer one replaces: they stay, with when they stopped being true and what replaced them. */
  private supersede(paths: string[], by: Fact): void {
    for (const p of paths) {
      const old = this.store.facts.get(p);
      if (!old) continue;
      const ended: Fact = { ...old, status: "archived", validUntil: old.validUntil && old.validUntil < (by.validFrom || today()) ? old.validUntil : by.validFrom || today(), supersededBy: by.path };
      this.store.put(ended);
      this.sync(ended, p);
    }
  }

  /** Bring back facts that `fact` had replaced (its undo). */
  private unsupersede(fact: Fact): string[] {
    const back: string[] = [];
    for (const p of fact.supersedes) {
      const old = this.store.facts.get(p);
      if (!old || old.supersededBy !== fact.path) continue;
      // The end it got from `fact` goes; an earlier end of its own stays.
      const setBy = fact.validFrom || fact.created.slice(0, 10);
      const restored: Fact = { ...old, status: "active", validUntil: old.validUntil && old.validUntil < setBy ? old.validUntil : "", supersededBy: "" };
      this.store.put(restored);
      this.sync(restored, p);
      back.push(p);
    }
    return back;
  }

  /** v1 tool: create or update a fact by path (a longer note); kind and other fields are kept or derived. */
  write(input: WriteInput, meta: { source: string; actor?: Actor }): Promise<{ path: string; status: "created" | "updated" }> {
    return this.lock(async () => {
      const title = String(input.title ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!title) throw new PathError("titleRequired", "A fact title (title) is required");
      if (title.length > MAX_TITLE) throw new PathError("titleTooLong", `Title is too long (max ${MAX_TITLE} characters)`, { max: MAX_TITLE });
      const content = stripFrontmatter(String(input.content ?? "")).trim();
      if (content.length > MAX_CONTENT) throw tooLong();
      if (secretReason(`${title}\n${content}`)) {
        throw new SecretError("secret", "Not saved: this looks like a secret (a password, token, key or card number). Secrets belong in the vault; remember only a reference such as vault://<id>.");
      }
      const path = input.path ? normalizePath(input.path) : this.uniquePath("notes", title);
      if (path === INDEX_FILE) throw indexReadOnly();
      const existing = this.store.facts.get(path);
      const now = new Date().toISOString();
      const src = meta.actor ? this.source(meta.actor) : undefined;
      const fact: Fact = {
        ...(existing ?? newFact({ path, title, body: content, kind: kindOfPath(path), about: entitiesFromTitle(kindOfPath(path), title), importance: path === PROFILE_FILE ? 5 : 3 })),
        path,
        title,
        tags: input.tags !== undefined ? normalizeTags(input.tags) : (existing?.tags ?? []),
        created: existing?.created || now,
        updated: now,
        source: meta.source,
        sources: src ? mergeSources(existing?.sources ?? [], [src]) : (existing?.sources ?? []),
        status: "active",
        body: content,
      };
      this.store.put(fact);
      this.sync(fact, path);
      await this.commit(existing ? "update" : "create", path);
      return { path, status: existing ? ("updated" as const) : ("created" as const) };
    });
  }

  // ---------- control ----------

  /** Forget: the fact goes to the trash (Undo brings it back; git keeps every version). */
  forget(rawPath: string): Promise<{ path: string; title: string }> {
    return this.lock(async () => {
      const path = normalizePath(rawPath);
      if (path === INDEX_FILE) throw new PathError("indexGenerated", `${INDEX_FILE} is generated automatically`, { file: INDEX_FILE });
      const had = this.store.facts.get(path) ?? this.store.review.get(path);
      const legacyReview = this.store.review.get(path);
      const trashed = this.store.trash(path);
      // A v1 .review/ copy has nothing to restore: it is dropped (its file stays in git).
      const dropped = legacyReview && !legacyReview.inPlace ? this.store.removeReview(path) : false;
      if (!trashed && !dropped && !had) throw factNotFound(path);
      this.indexed((i) => i.remove(path));
      await this.commit("forget", path);
      return { path, title: (trashed ?? had)?.title ?? path };
    });
  }

  /** Undo a forget: the fact comes back from the trash, and replaces again what it had replaced. */
  restore(rawPath: string): Promise<Fact> {
    return this.lock(async () => {
      const path = normalizePath(rawPath);
      const f = this.store.untrash(path);
      if (!f) throw notInTrash(path);
      this.sync(f, path);
      if (f.status === "active") {
        this.supersede(
          f.supersedes.filter((p) => {
            const o = this.store.facts.get(p);
            return !!o && (o.supersededBy === f.path || isCurrent(o));
          }),
          f,
        );
      }
      await this.commit("restore", path);
      return this.store.facts.get(path) ?? f;
    });
  }

  /** Undo a remember: the fact goes to the trash and what it replaced is true again. */
  undo(rawPath: string): Promise<{ path: string; restored: string[] }> {
    return this.lock(async () => {
      const path = normalizePath(rawPath);
      const f = this.store.facts.get(path) ?? this.store.review.get(path);
      if (!f) throw factNotFound(path);
      // A fact replaced meanwhile by a newer one: undoing it must not bring back what it had replaced.
      const restored = f.status === "active" && !f.supersededBy && isCurrent(f) ? this.unsupersede(f) : [];
      this.store.trash(path);
      const r = this.store.review.get(path);
      if (r && !r.inPlace) this.store.removeReview(path);
      this.indexed((i) => i.remove(path));
      await this.commit("undo", path);
      return { path, restored };
    });
  }

  /** The person edits a fact in place: their word is final (confidence 1, source "user"). */
  edit(rawPath: string, e: FactEdit): Promise<Fact> {
    return this.lock(async () => {
      const path = normalizePath(rawPath);
      if (path === INDEX_FILE) throw indexReadOnly();
      const f = this.store.facts.get(path) ?? this.store.review.get(path);
      if (!f) throw factNotFound(path);
      const text = e.text !== undefined ? String(e.text).trim() : f.body;
      if (!text && !f.title) throw new PathError("factRequired", "The fact text (fact) is required");
      if (text.length > MAX_CONTENT) throw tooLong();
      const title = e.title !== undefined ? String(e.title).replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) || f.title : e.text !== undefined && f.title === headline(f.body) ? headline(text) : f.title;
      if (secretReason(`${title}\n${text}`)) throw new SecretError("secret", "Not saved: this looks like a secret. Secrets belong in the vault.");
      const now = new Date().toISOString();
      const fact: Fact = {
        ...f,
        title,
        body: text,
        kind: isKind(e.kind) ? e.kind : f.kind,
        importance: e.importance !== undefined ? clampImportance(e.importance, f.importance) : f.importance,
        about: e.about !== undefined ? normalizeEntities(e.about) : f.about,
        validUntil: e.validUntil !== undefined ? isoDate(e.validUntil) : f.validUntil,
        scope: e.scope === "team" || /^agent:[\w.-]+$/.test(String(e.scope ?? "")) ? String(e.scope) : f.scope,
        confidence: 1,
        updated: now,
        source: "user",
        sources: mergeSources(f.sources, [{ agent: "user", at: now }]),
        status: f.status === "review" ? "active" : f.status,
      };
      if (f.status === "review" && !(f as ReviewItem).inPlace) this.store.removeReview(path);
      this.store.put(fact);
      this.sync(fact, path);
      // Editing a fact that waited for review is the user's yes: it replaces what it was meant to replace.
      if (f.status === "review") {
        this.supersede(
          fact.supersedes.filter((p) => {
            const o = this.store.facts.get(p);
            return !!o && isCurrent(o);
          }),
          fact,
        );
      }
      await this.commit("edit", path);
      return fact;
    });
  }

  /** Save a file edited by the user in the UI (raw markdown, frontmatter optional). Always active. */
  putRaw(rawPath: string, raw: string): Promise<Fact> {
    return this.lock(async () => {
      const path = normalizePath(rawPath);
      if (path === INDEX_FILE) throw indexReadOnly();
      if (raw.length > MAX_CONTENT) throw tooLong();
      const existing = this.store.facts.get(path);
      const parsed = parseFact(path, raw);
      const now = new Date().toISOString();
      const fact: Fact = {
        ...parsed,
        created: existing?.created || parsed.created || now,
        updated: now,
        source: "user",
        sources: mergeSources(parsed.sources, [{ agent: "user", at: now }]),
        status: parsed.status === "archived" ? "archived" : "active",
      };
      this.store.put(fact);
      this.sync(fact, path);
      await this.commit(existing ? "edit" : "create", path);
      return fact;
    });
  }

  /** Bring back an earlier version of a fact from git. */
  revert(rawPath: string, rev: string): Promise<Fact> {
    return this.lock(async () => {
      const path = normalizePath(rawPath);
      const raw = await this.git.show(rev, path);
      if (raw === undefined) throw new NotFoundError("versionNotFound", `No version ${rev} of ${path}`, { path, rev });
      const parsed = parseFact(path, raw);
      const fact: Fact = { ...parsed, status: parsed.status === "review" ? "active" : parsed.status, updated: new Date().toISOString() };
      this.store.put(fact);
      this.sync(fact, path);
      await this.commit(`revert ${rev}`, path);
      return fact;
    });
  }

  approve(rawPath: string): Promise<Fact> {
    return this.lock(async () => {
      const path = normalizePath(rawPath);
      const item = this.store.review.get(path);
      if (!item) throw notInReview(path);
      const existing = this.store.facts.get(path);
      const { inPlace: _inPlace, ...rest } = item;
      const fact: Fact = { ...rest, status: "active", created: existing?.created || item.created, updated: new Date().toISOString() };
      if (!item.inPlace) this.store.removeReview(path);
      this.store.put(fact);
      this.sync(fact, path);
      this.supersede(fact.supersedes.filter((p) => { const o = this.store.facts.get(p); return !!o && isCurrent(o); }), fact);
      await this.commit("approve", path);
      return fact;
    });
  }

  reject(rawPath: string): Promise<{ path: string }> {
    return this.lock(async () => {
      const path = normalizePath(rawPath);
      if (!this.store.removeReview(path)) throw notInReview(path);
      await this.commit("reject", path);
      return { path };
    });
  }

  // ---------- consolidation ----------

  /** The "sleep" pass: expire, merge near-duplicates, archive stale low-value facts. One commit. */
  tidy(nowMs = Date.now()): Promise<{ expired: number; merged: number; archived: number }> {
    return this.lock(async () => {
      let expired = 0;
      let merged = 0;
      let archived = 0;
      for (const f of [...this.store.facts.values()]) {
        if (f.status === "active" && f.validUntil && !isCurrent(f, nowMs)) {
          this.store.put({ ...f, status: "archived" });
          this.indexed((i) => i.remove(f.path));
          expired++;
        }
      }
      // Near-duplicates (the same claim saved twice): the newer one keeps everything.
      const current = [...this.store.facts.values()].filter((f) => isCurrent(f, nowMs));
      if (current.length <= 3000) {
        const st = new Map(current.map((f) => [f.path, factStems(f, 1000)]));
        const gone = new Set<string>();
        for (let i = 0; i < current.length; i++) {
          for (let j = i + 1; j < current.length; j++) {
            const a = current[i];
            const b = current[j];
            if (gone.has(a.path) || gone.has(b.path) || a.scope !== b.scope || a.kind !== b.kind || subject(a) !== subject(b)) continue;
            if (!replaceable(a) || !replaceable(b) || negated(a.body || a.title) !== negated(b.body || b.title)) continue;
            if (overlap(st.get(a.path)!, st.get(b.path)!) < 0.85) continue;
            const [keep, drop] = (b.updated || b.created) >= (a.updated || a.created) ? [b, a] : [a, b];
            const k = this.store.facts.get(keep.path)!;
            const d = this.store.facts.get(drop.path)!;
            const kept: Fact = {
              ...k,
              sources: mergeSources(k.sources, d.sources),
              tags: union(k.tags, d.tags),
              about: union(k.about, d.about, 12),
              importance: Math.max(k.importance, d.importance),
              confidence: Math.max(k.confidence, d.confidence),
              supersedes: union(k.supersedes, [d.path]),
            };
            this.store.put(kept);
            this.sync(kept, kept.path);
            this.store.put({ ...d, status: "archived", supersededBy: keep.path });
            this.indexed((i) => i.remove(drop.path));
            this.state.moveUsage(drop.path, keep.path);
            gone.add(drop.path);
            merged++;
          }
        }
      }
      // Stale: unimportant, untouched for half a year and not recalled for three months.
      for (const f of [...this.store.facts.values()]) {
        if (!isCurrent(f, nowMs) || f.importance > 2 || f.path === PROFILE_FILE) continue;
        const age = nowMs - (Date.parse(f.updated || f.created) || nowMs);
        const used = Date.parse(this.state.usage(f.path)?.lastRecalled ?? "") || 0;
        if (age > 180 * DAY && nowMs - used > 90 * DAY) {
          this.store.put({ ...f, status: "archived" });
          this.indexed((i) => i.remove(f.path));
          archived++;
        }
      }
      // Forgotten facts leave the trash after a month, but only while git still keeps every version.
      const purged = this.git.enabled ? this.store.purgeTrash(30 * DAY, nowMs) : 0;
      if (purged) this.o.warn(`memory: ${purged} forgotten fact(s) left the trash (still in the git history)`);
      this.state.set("lastTidy", new Date(nowMs).toISOString());
      if (expired + merged + archived) await this.commit(`tidy: ${expired} expired, ${merged} merged, ${archived} archived`, "");
      return { expired, merged, archived };
    });
  }

  // ---------- reads ----------

  /** v1 full-text search (FTS5) over facts true now. */
  search(query: string, limit = 10): SearchHit[] {
    const q = String(query ?? "");
    const n = Math.max(1, Math.min(50, Math.floor(limit) || 10));
    try {
      return this.index.search(q, n);
    } catch (e) {
      this.reopenIndex(e);
      return this.index.search(q, n);
    }
  }

  /** Hybrid ranking (memory_search, the UI's search). */
  find(query: string, o: { agentId?: string; limit?: number; includeArchived?: boolean; kinds?: FactKind[] } = {}): Scored[] {
    return rank(this.store.facts.values(), query, { ...o, gate: 0.2, usage: (p) => this.state.usage(p) });
  }

  get(rawPath: string): { fact?: Fact; review?: ReviewItem; path: string } {
    const path = normalizePath(rawPath);
    return { path, fact: this.store.facts.get(path), review: this.store.review.get(path) };
  }

  reviewItems(): ReviewItem[] {
    return [...this.store.review.values()].sort((a, b) => b.updated.localeCompare(a.updated));
  }

  list(rawDir?: string): { dir: string; groups: Array<{ dir: string; facts: Fact[] }>; review: number } {
    const dir = rawDir ? normalizePath(rawDir, { dir: true }) : "";
    const review = [...this.store.review.keys()].filter((p) => !dir || p.startsWith(dir + "/")).length;
    return { dir, groups: this.store.grouped(dir), review };
  }

  tree(): { facts: Array<Omit<Fact, "body">>; folders: string[]; review: number } {
    const folders = new Set<string>(DEFAULT_FOLDERS);
    const facts = [...this.store.facts.values()].filter((f) => isCurrent(f)).map(({ body: _b, ...meta }) => meta);
    for (const f of facts) for (let d = dirOf(f.path); d; d = dirOf(d)) folders.add(d);
    return { facts: facts.sort((a, b) => a.path.localeCompare(b.path)), folders: [...folders].sort(), review: this.store.review.size };
  }

  /** Facts that replaced each other before this one (newest first). */
  before(f: Fact): Fact[] {
    const out: Fact[] = [];
    const seen = new Set<string>([f.path]);
    const walk = (paths: string[]) => {
      for (const p of paths) {
        if (seen.has(p)) continue;
        seen.add(p);
        const old = this.store.facts.get(p);
        if (!old) continue;
        out.push(old);
        walk(old.supersedes);
      }
    };
    walk(f.supersedes);
    for (const o of this.store.facts.values()) if (o.supersededBy === f.path && !seen.has(o.path)) out.push(o);
    return out.sort((a, b) => (b.validUntil || b.updated).localeCompare(a.validUntil || a.updated));
  }

  serialize(f: Fact): string {
    return serializeFact(f);
  }

  counts(): Record<FactKind, number> {
    const c = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<FactKind, number>;
    for (const f of this.store.facts.values()) if (isCurrent(f)) c[f.kind]++;
    return c;
  }

  // ---------- recall ----------

  private session(id: string) {
    let s = this.sessions.get(id);
    if (!s) {
      s = { turn: 0, shown: new Map() };
      this.sessions.set(id, s);
      if (this.sessions.size > 500) this.sessions.delete(this.sessions.keys().next().value!);
    }
    return s;
  }

  /** Text appended to the system prompt at session start: how to use memory and the core facts about the user. */
  sessionPrompt(sessionId?: string, agentId?: string): string {
    const max = Math.max(500, this.o.promptMaxChars ?? 4000);
    const out = [
      "## Memory",
      ...(max >= 2500
        ? [
            "You and your teammates share a long-term memory about the user. Facts relevant to a message appear before it as a `[Memory]` block; `memory_search` finds more — search before asking the user something they may have told you already.",
            "- Save a durable fact the moment you learn it with `memory_remember`, without announcing it (the chat shows a small \"Remembered\" line the user can undo): who the user is, the people, places and projects in their life, their preferences, plans and dates, how they like things done. One self-contained fact per call, in the third person (\"The user's sister Anna lives in Perm\"); name the people and places in `about`; give a `slot` for a changeable attribute (home city, job, coffee order) so a newer value replaces the old one. Skip small talk and one-off requests.",
            "- When the user corrects something you remember, save the new fact with `replaces` (the old fact's path). When they ask you to forget something, use `memory_forget`.",
            "- Never store passwords, tokens, card numbers or other secrets: they live in the vault (`vault://<id>`). Health, money, beliefs and other sensitive facts are saved like any other, marked `sensitive`.",
          ]
        : [
            "Shared long-term memory about the user: relevant facts come before a message as a `[Memory]` block; `memory_search` finds more. Save durable facts as you learn them with `memory_remember` (one per call, third person; `slot` for changeable attributes, `replaces` for corrections). Never store secrets (vault://).",
          ]),
    ];
    let used = out.join("\n").length;
    const shown = sessionId ? this.session(sessionId).shown : undefined;
    const profile = this.store.facts.get(PROFILE_FILE);
    const profileText = profile && isCurrent(profile) ? profile.body.trim() : "";
    const core: string[] = [];
    if (profileText) {
      const budget = Math.max(80, Math.min(Math.floor(max * 0.35), Math.floor((max - used - 160) * 0.6)));
      core.push(`- (profile) ${(profileText.length > budget ? profileText.slice(0, budget - 1) + "…" : profileText).replace(/\n+/g, " ")} [${PROFILE_FILE}]`);
      shown?.set(PROFILE_FILE, Number.MAX_SAFE_INTEGER);
    }
    const strong = strongest(this.store.facts.values(), { agentId, kinds: ["self", "preference"], minImportance: 4 }).filter((f) => f.path !== PROFILE_FILE);
    const lines = within(
      strong.map((f) => factLine(f, 240)),
      Math.max(0, max - used - (core[0]?.length ?? 0) - 180),
    );
    for (const l of lines) {
      const p = /\[([^\]]+)\]$/.exec(l)?.[1];
      if (p) shown?.set(p, Number.MAX_SAFE_INTEGER);
    }
    core.push(...lines);
    if (core.length) {
      out.push("", "### What you know about the user", ...core);
      used += core.join("\n").length + 40;
    }
    const counts = this.counts();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (!total) out.push("", "Memory is empty so far.");
    else {
      const parts = KINDS.filter((k) => counts[k]).map((k) => `${counts[k]} ${KIND_NAMES[k]}`);
      out.push("", `Memory holds ${total} facts: ${parts.join(", ")}.`);
    }
    const text = out.join("\n");
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  }

  /** Facts relevant to a turn, not shown to this session lately, within the recall budget; or undefined. */
  turnContext(sessionId: string, agentId: string, text: string): string | undefined {
    const s = this.session(sessionId);
    s.turn++;
    const budget = Math.max(300, this.o.recallMaxChars ?? 1500);
    const ranked = rank(this.store.facts.values(), String(text ?? "").slice(0, 4000), { agentId, limit: 12, usage: (p) => this.state.usage(p) }).filter((r) => {
      const last = s.shown.get(r.fact.path);
      return last === undefined || (last !== Number.MAX_SAFE_INTEGER && s.turn - last >= RESHOW_AFTER);
    });
    if (!ranked.length) return undefined;
    const picked = within(
      ranked.slice(0, 6).map((r) => factLine(r.fact, 300)),
      budget - 120,
    );
    if (!picked.length) return undefined;
    const paths = picked.map((l) => /\[([^\]]+)\]$/.exec(l)?.[1]).filter((p): p is string => !!p);
    for (const p of paths) s.shown.set(p, s.turn);
    this.state.recalled(paths);
    return ["[Memory] What you remember that may matter here (if the user now says otherwise, save the new fact with `replaces`):", ...picked].join("\n");
  }
}

const KIND_NAMES: Record<FactKind, string> = {
  self: "about the user",
  preference: "preferences",
  person: "about people",
  place: "about places",
  project: "about projects",
  event: "events",
  howto: "how-tos",
  note: "notes",
};
