// Channels (Feed): news on a topic the user described, gathered at set times by an agent of the team, its editor.
// A run is a background task for the editor with the channel's brief, its sources and what it already posted; it works
// in the channel's own folder (scripts and notes stay for the next runs) and publishes with feed_post. The hub keeps the
// schedule, refuses repeats and counts what the user has not read yet. The code says feed: "channels" are where
// messages travel (Telegram).
import type { Feed, FeedPost, Task, TaskStatus } from "@piomio/shared";
import { newId, nowIso, truncate } from "@piomio/shared";
import type { Db } from "./db.ts";
import { json } from "./db.ts";
import type { EventBus } from "./bus.ts";
import type { Settings } from "./settings.ts";
import type { AgentRegistry } from "./agents.ts";
import { LocalizedError, t } from "./i18n.ts";

const OPEN: TaskStatus[] = ["queued", "running", "waiting_approval", "waiting_input", "paused", "interrupted"];
/** What a channel's run works with, whatever its editor's tool list says. */
export const FEED_RUN_TOOLS = ["feed_post", "feed_sources", "feed_update", "web_rss", "web_fetch", "web_search", "browser_search"];
/** Gathered when nothing else is said: morning and evening. */
export const DEFAULT_TIMES = ["08:00", "19:00"];
const MAX_TIMES = 12;
/** Posts one run may publish: a channel is a few strong items, not a firehose. */
const MAX_POSTS_PER_RUN = 20;
/** Posts a run is shown so it does not repeat them. */
const RECENT_FOR_RUN = 30;
const TICK_MS = 30_000;
/** The wall clock ran on this much more than the timers: the computer slept (other replicas take the lead after 8 s). */
const ASLEEP_MS = 5_000;
/** After a wake, the replica that led meanwhile may lead a little longer: it checks every 2 s, then stands down. */
const HANDOVER_MS = 15_000;
/** Ticks a time that came while the computer slept waits for what another replica wrote (its pulls are 30 s long polls). */
const SETTLE_TICKS = 2;
const LANGUAGES: Record<string, string> = { en: "English", ru: "Russian" };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A channel's settings from the UI or a tool, checked. */
export interface FeedInput {
  title?: unknown;
  brief?: unknown;
  agentId?: unknown;
  times?: unknown;
  weekdays?: unknown;
  enabled?: unknown;
}

/** A post from the editor (feed_post), checked by `post`. */
export interface PostInput {
  title?: unknown;
  text?: unknown;
  url?: unknown;
  source?: unknown;
  image?: unknown;
}

interface Row {
  id: string;
  title: string;
  brief: string;
  agent_id: string;
  times: string;
  weekdays: string;
  sources: string;
  enabled: number;
  read_at: string | null;
  chat_id: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

const postFrom = (r: any): FeedPost => ({
  id: r.id,
  feedId: r.feed_id,
  title: r.title,
  text: r.text,
  ...(r.url ? { url: r.url } : {}),
  ...(r.source ? { source: r.source } : {}),
  ...(r.image ? { image: r.image } : {}),
  createdAt: r.created_at,
});

const clean = (v: unknown, max: number): string => (typeof v === "string" ? truncate(v.replace(/\s+/g, " ").trim(), max) : "");
const webUrl = (v: unknown): string | undefined => {
  if (typeof v !== "string" || !v.trim()) return undefined;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
};

export interface FeedDeps {
  db: Db;
  bus: EventBus;
  settings: Settings;
  agents: AgentRegistry;
  /** Starts the editor's run (SessionRunner.createTask). */
  createTask: (t: { agentId: string; goal: string; title: string; background: boolean; createdBy: Task["createdBy"]; feedId: string }) => Task;
  getTask: (id: string) => Task | undefined;
}

export class Feeds {
  d: FeedDeps;
  private timer?: NodeJS.Timeout;
  /** Times that came while the computer slept (`settle`): channel id → the time, and the ticks it has waited. */
  private settling = new Map<string, { slot: string; ticks: number }>();
  /** Wall clock minus the timers' clock at the last tick: it grows by the time the computer slept. */
  private clockGap = Date.now() - performance.now();
  /** When a tick last found the computer had slept (ms). */
  private wokeAt = -Infinity;

  constructor(d: FeedDeps) {
    this.d = d;
    // A run started or ended: the channel's "gathering now" changes.
    d.bus.on("task.updated", (task: Task) => {
      if (task?.feedId && this.row(task.feedId)) this.changed(task.feedId);
    });
  }

  /** Runs due channels every half minute; one missed while the hub was off runs once now. */
  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  // ---------- channels ----------

  list(): Feed[] {
    return (this.d.db.prepare("select * from feeds order by created_at").all() as unknown as Row[]).map((r) => this.view(r));
  }

  get(id: string): Feed | undefined {
    const r = this.row(id);
    return r ? this.view(r) : undefined;
  }

  /** A channel by id, or by its name when exactly one has it. */
  find(key: string): Feed | undefined {
    const k = key.trim();
    const byId = this.get(k);
    if (byId) return byId;
    const named = this.list().filter((f) => f.title.toLowerCase() === k.toLowerCase());
    return named.length === 1 ? named[0] : undefined;
  }

  /** A new channel; its first run starts at once, so the editor finds sources and posts what is there now. `chatId`: the setup chat it came from. */
  create(input: FeedInput, opts: { run?: boolean; chatId?: string } = {}): Feed {
    const brief = clean(input.brief, 2000);
    if (!brief) throw new LocalizedError("feed.briefRequired", undefined, 400);
    const agentId = this.agent(input.agentId) ?? this.d.settings.get().defaultAgent;
    const times = input.times === undefined ? DEFAULT_TIMES : this.times(input.times);
    const weekdays = input.weekdays === undefined ? [] : this.weekdays(input.weekdays);
    const title = clean(input.title, 80) || truncate(brief.split(/[.!?\n]/)[0].trim(), 40);
    const id = newId("f_");
    const now = nowIso();
    this.d.db
      .prepare("insert into feeds(id, title, brief, agent_id, times, weekdays, sources, enabled, chat_id, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, title, brief, agentId, JSON.stringify(times), JSON.stringify(weekdays), "[]", input.enabled === false ? 0 : 1, opts.chatId ?? null, now, now);
    this.schedule(id);
    if (opts.run !== false && input.enabled !== false) this.run(id);
    else this.changed(id);
    return this.get(id)!;
  }

  update(id: string, input: FeedInput): Feed {
    const r = this.row(id);
    if (!r) throw new LocalizedError("feed.notFound", undefined, 404);
    const set: Record<string, unknown> = {};
    if (input.title !== undefined) {
      const title = clean(input.title, 80);
      if (!title) throw new LocalizedError("feed.titleRequired", undefined, 400);
      set.title = title;
    }
    if (input.brief !== undefined) {
      const brief = clean(input.brief, 2000);
      if (!brief) throw new LocalizedError("feed.briefRequired", undefined, 400);
      set.brief = brief;
    }
    if (input.agentId !== undefined) {
      const agentId = this.agent(input.agentId);
      if (!agentId) throw new LocalizedError("feed.unknownAgent", { id: String(input.agentId) }, 400);
      set.agent_id = agentId;
    }
    if (input.times !== undefined) set.times = JSON.stringify(this.times(input.times));
    if (input.weekdays !== undefined) set.weekdays = JSON.stringify(this.weekdays(input.weekdays));
    if (input.enabled !== undefined) set.enabled = input.enabled ? 1 : 0;
    const cols = Object.keys(set);
    if (cols.length) {
      this.d.db.prepare(`update feeds set ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? where id = ?`).run(...(Object.values(set) as any[]), nowIso(), id);
      if (set.times !== undefined || set.weekdays !== undefined || set.enabled !== undefined) this.schedule(id);
    }
    this.changed(id);
    return this.get(id)!;
  }

  /** A deleted agent's channels pass to `to` (the default agent). */
  handOver(from: string, to: string): void {
    const ids = (this.d.db.prepare("select id from feeds where agent_id = ?").all(from) as Array<{ id: string }>).map((r) => r.id);
    this.d.db.prepare("update feeds set agent_id = ?, updated_at = ? where agent_id = ?").run(to, nowIso(), from);
    for (const id of ids) this.changed(id);
  }

  delete(id: string): void {
    if (!this.row(id)) throw new LocalizedError("feed.notFound", undefined, 404);
    this.d.db.prepare("delete from feed_posts where feed_id = ?").run(id);
    this.d.db.prepare("delete from feeds where id = ?").run(id);
    this.d.bus.emit("feed.deleted", { id });
  }

  /** The editor's list of what it reads. */
  setSources(id: string, sources: unknown): Feed {
    if (!this.row(id)) throw new LocalizedError("feed.notFound", undefined, 404);
    const list = (Array.isArray(sources) ? sources : []).map((s) => clean(s, 300)).filter(Boolean).slice(0, 50);
    this.d.db.prepare("update feeds set sources = ?, updated_at = ? where id = ?").run(JSON.stringify(list), nowIso(), id);
    this.changed(id);
    return this.get(id)!;
  }

  /** The user saw the channel: nothing unread. */
  markRead(id: string): void {
    if (!this.row(id)) throw new LocalizedError("feed.notFound", undefined, 404);
    this.d.db.prepare("update feeds set read_at = ? where id = ?").run(nowIso(), id);
    this.changed(id);
  }

  // ---------- posts ----------

  /** Newest first; `before` is a post's id, for the ones older than it (posts are stored in the order they came). */
  posts(id: string, opts: { before?: string; limit?: number } = {}): FeedPost[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 30, 200));
    const rows = opts.before
      ? this.d.db
          .prepare("select * from feed_posts where feed_id = ? and rowid < (select rowid from feed_posts where id = ?) order by rowid desc limit ?")
          .all(id, opts.before, limit)
      : this.d.db.prepare("select * from feed_posts where feed_id = ? order by rowid desc limit ?").all(id, limit);
    return rows.map(postFrom);
  }

  /** Posts by id, in the order asked (unknown ids left out). */
  postsById(ids: string[]): FeedPost[] {
    return ids.flatMap((id) => {
      const r = this.d.db.prepare("select * from feed_posts where id = ?").get(id);
      return r ? [postFrom(r)] : [];
    });
  }

  /** A post from the editor: checked, and refused when the channel already has it or the run posted enough. */
  post(id: string, input: PostInput): { post: FeedPost } | { error: string } {
    const r = this.row(id);
    if (!r) return { error: `No channel ${id}.` };
    const title = clean(input.title, 200);
    const text = typeof input.text === "string" ? truncate(input.text.trim(), 2000) : "";
    if (!title || !text) return { error: "Give a title and a text." };
    const url = webUrl(input.url);
    if (input.url && !url) return { error: "url must be an http(s) address." };
    const image = webUrl(input.image);
    const source = clean(input.source, 100);
    if (url && this.d.db.prepare("select 1 from feed_posts where feed_id = ? and url = ?").get(id, url)) return { error: `Already posted: ${url}` };
    const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const same = this.d.db.prepare("select title from feed_posts where feed_id = ? and created_at > ?").all(id, week) as Array<{ title: string }>;
    if (same.some((p) => p.title.toLowerCase() === title.toLowerCase())) return { error: `Already posted: “${title}”` };
    if (r.last_run_at) {
      const n = (this.d.db.prepare("select count(*) as n from feed_posts where feed_id = ? and created_at >= ?").get(id, r.last_run_at) as { n: number }).n;
      if (n >= MAX_POSTS_PER_RUN) return { error: `This run posted ${n} items already: that is enough; keep only the strongest next time.` };
    }
    const post: FeedPost = { id: newId("p_"), feedId: id, title, text, ...(url ? { url } : {}), ...(source ? { source } : {}), ...(image ? { image } : {}), createdAt: nowIso() };
    this.d.db
      .prepare("insert into feed_posts(id, feed_id, title, text, url, source, image, created_at) values (?,?,?,?,?,?,?,?)")
      .run(post.id, id, post.title, post.text, post.url ?? null, post.source ?? null, post.image ?? null, post.createdAt);
    this.d.bus.emit("feed.post", post);
    this.changed(id);
    return { post };
  }

  // ---------- runs ----------

  /** Gather the channel now (its schedule, "refresh" in the UI, feed_run); a run already going is the answer. */
  run(id: string): Task {
    const r = this.row(id);
    if (!r) throw new LocalizedError("feed.notFound", undefined, 404);
    const running = this.running(id);
    if (running) return running;
    if (!this.d.agents.get(r.agent_id)) throw new LocalizedError("feed.unknownAgent", { id: r.agent_id }, 400);
    const feed = this.view(r);
    const task = this.d.createTask({ agentId: r.agent_id, goal: this.goal(feed), title: t("feed.runTitle", { title: r.title }), background: true, createdBy: "trigger", feedId: id });
    this.d.db.prepare("update feeds set last_run_at = ? where id = ?").run(task.createdAt, id);
    this.changed(id);
    return task;
  }

  /** What the editor is asked to do on a run. */
  goal(f: Feed): string {
    const s = this.d.settings.get();
    const lang = LANGUAGES[s.language] ?? s.language;
    const recent = this.posts(f.id, { limit: RECENT_FOR_RUN });
    const since = f.lastRunAt ? new Intl.DateTimeFormat("en-GB", { timeZone: s.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(f.lastRunAt)) : undefined;
    const lines = [`You edit the user's channel “${f.title}” (feed ${f.id}): news they want to get regularly. In their words:`, f.brief, ""];
    if (f.sources.length) {
      lines.push("Your sources (keep the list current with feed_sources):", ...f.sources.map((x) => `- ${x}`));
    } else {
      lines.push(
        "This is the channel's first run: find good sources for it. RSS and Atom feeds first (web_rss reads a feed and finds a site's feeds), then sites and searches (web_search, web_fetch), the browser for pages that need it, tools from plugins that bring news, and scripts you write. " +
          'Save the list with feed_sources, one line each ("rss <url>", "page <url>", "search <query>", "script <file>", "tool <name> …"). If the channel\'s name is only the start of their words, give it a short name (1–4 words) with feed_update.',
      );
    }
    if (recent.length) lines.push("", "Already posted, newest first (do not post these again):", ...recent.map((p) => `- “${p.title}”${p.url ? ` ${p.url}` : ""}`));
    lines.push(
      "",
      `Gather what is new ${since ? `since the last run (${since})` : "from about the last day"} and worth their attention by their words. ` +
        "For each item you keep, read the item itself (web_fetch its page), not only the feed's line, and publish it with feed_post: " +
        `a short title; in ${lang}, the gist itself so they need not open the link (the key facts, numbers and names, what changed and why it matters: two to five sentences or a few bullets, never a teaser); ` +
        "the link and the source's name; and its picture (the page's Picture from web_fetch, or the feed's), which every post should have when the item has one. " +
        "A few strong items beat many weak ones; when nothing new is worth it, post nothing. Files you keep in this folder (scripts, notes, what you have seen) stay for the next runs. " +
        "Finish with one line on what you did.",
    );
    return lines.join("\n");
  }

  /** Due channels start their run; a channel whose time passed while it was still gathering waits for the next one. */
  tick(now = new Date()): void {
    this.noticeWake();
    for (const r of this.d.db.prepare("select * from feeds where enabled = 1").all() as unknown as Row[]) {
      if (!r.next_run_at) {
        this.schedule(r.id, now);
        continue;
      }
      if (Date.parse(r.next_run_at) > now.getTime() || this.settle(r.id, r.next_run_at)) continue;
      try {
        // An editor in the archive sleeps: the channel waits for its next time.
        if (!this.running(r.id) && !this.d.agents.isArchived(r.agent_id)) this.run(r.id);
      } catch (e) {
        console.error(`[feeds] ${r.id}: ${(e as Error).message}`);
      }
      this.schedule(r.id, now);
    }
  }

  // ---------- inside ----------

  /** Remembers when the computer woke: its wall clock ran on while the timers stood still. */
  private noticeWake(): void {
    const now = Date.now();
    const gap = now - performance.now();
    if (gap - this.clockGap > ASLEEP_MS) this.wokeAt = now;
    this.clockGap = gap;
  }

  /**
   * A time that came while the computer slept, or right after it woke: another replica of the hub (cluster.ts) may have
   * led meanwhile and gathered the channel, and what it wrote may still be on the way. The time waits SETTLE_TICKS ticks
   * once, then runs unless the channel's row shows it ran. True while it waits.
   */
  private settle(id: string, slot: string): boolean {
    const cur = this.settling.get(id);
    if (cur?.slot === slot) return ++cur.ticks < SETTLE_TICKS;
    if (Date.parse(slot) > this.wokeAt + HANDOVER_MS) return false;
    this.settling.set(id, { slot, ticks: 0 });
    return true;
  }

  private row(id: string): Row | undefined {
    return this.d.db.prepare("select * from feeds where id = ?").get(id) as unknown as Row | undefined;
  }

  private running(id: string): Task | undefined {
    const r = this.d.db.prepare(`select id from tasks where feed_id = ? and status in (${OPEN.map(() => "?").join(",")}) order by created_at desc limit 1`).get(id, ...OPEN) as
      | { id: string }
      | undefined;
    return r ? this.d.getTask(r.id) : undefined;
  }

  private view(r: Row): Feed {
    const unread = (
      this.d.db.prepare(`select count(*) as n from feed_posts where feed_id = ?${r.read_at ? " and created_at > ?" : ""}`).get(...(r.read_at ? [r.id, r.read_at] : [r.id])) as { n: number }
    ).n;
    const last = this.d.db.prepare("select title, created_at from feed_posts where feed_id = ? order by rowid desc limit 1").get(r.id) as
      | { title: string; created_at: string }
      | undefined;
    const running = this.running(r.id);
    return {
      id: r.id,
      title: r.title,
      brief: r.brief,
      agentId: r.agent_id,
      times: json<string[]>(r.times, []),
      weekdays: json<number[]>(r.weekdays, []),
      sources: json<string[]>(r.sources, []),
      enabled: !!r.enabled,
      ...(running ? { runningTaskId: running.id } : {}),
      ...(r.chat_id ? { chatId: r.chat_id } : {}),
      ...(r.last_run_at ? { lastRunAt: r.last_run_at } : {}),
      ...(r.next_run_at && r.enabled ? { nextRunAt: r.next_run_at } : {}),
      unread,
      ...(last ? { lastPost: { title: last.title, createdAt: last.created_at } } : {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private changed(id: string): void {
    const f = this.get(id);
    if (f) this.d.bus.emit("feed.updated", f);
  }

  private schedule(id: string, now = new Date()): void {
    const r = this.row(id);
    if (!r) return;
    const next = r.enabled ? nextRun(json<string[]>(r.times, []), json<number[]>(r.weekdays, []), this.d.settings.get().timezone, now) : undefined;
    this.d.db.prepare("update feeds set next_run_at = ? where id = ?").run(next?.toISOString() ?? null, id);
  }

  private agent(v: unknown): string | undefined {
    if (typeof v !== "string" || !v.trim()) return undefined;
    const key = v.trim();
    const a = this.d.agents.get(key) ?? this.d.agents.list().find((x) => x.name.toLowerCase() === key.toLowerCase());
    return a?.id;
  }

  private times(v: unknown): string[] {
    const list = Array.isArray(v) ? v.map((x) => String(x).trim()) : [];
    if (!list.length || list.length > MAX_TIMES || list.some((x) => !HHMM.test(x))) throw new LocalizedError("feed.badTimes", undefined, 400);
    return [...new Set(list)].sort();
  }

  private weekdays(v: unknown): number[] {
    const list = Array.isArray(v) ? v.map(Number) : [];
    if (list.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new LocalizedError("feed.badWeekdays", undefined, 400);
    return [...new Set(list)].sort();
  }
}

// ---------- the schedule ----------

interface Local {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
}

function local(at: number, tz: string): Local {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: n("year"), m: n("month"), d: n("day"), hh: n("hour"), mm: n("minute") };
}

/** The instant a wall-clock time has in a time zone (the zone's offset at that moment, so summer time is right). */
function instant(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const offset = (at: number) => {
    const l = local(at, tz);
    return Date.UTC(l.y, l.m - 1, l.d, l.hh, l.mm) - at;
  };
  const first = wall - offset(wall);
  return wall - offset(first);
}

/** The next gathering after `after`: the first of the local times on an allowed day (every day when none are set). */
export function nextRun(times: string[], weekdays: number[], tz: string, after: Date): Date | undefined {
  if (!times.length) return undefined;
  const today = local(after.getTime(), tz);
  for (let i = 0; i <= 7; i++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    if (weekdays.length && !weekdays.includes(day.getUTCDay())) continue;
    for (const hm of [...times].sort()) {
      const [hh, mm] = hm.split(":").map(Number);
      const at = instant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, tz);
      if (at > after.getTime()) return new Date(at);
    }
  }
  return undefined;
}
