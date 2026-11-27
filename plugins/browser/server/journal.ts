// The browser's journal: what the person did in the agents' browser (recorder.ts), one JSON file per session plus the
// pictures of the places they pointed at. Kept 30 days and at most 500 sessions, on the hub only. It is what the agents
// learn from: a demonstration becomes a skill, and the same routine seen again becomes an offer to take it over.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Recording, Step } from "./recorder.ts";

const DAY = 86_400_000;
const META = "meta.json";

export interface RecordingSummary {
  id: string;
  kind: Recording["kind"];
  goal?: string;
  origin: string;
  startedAt: number;
  endedAt: number;
  steps: number;
}

/** A routine the person said no to, or one offered lately: not offered again. */
interface Routine {
  origin: string;
  keys: string[];
  at: number;
}

interface Meta {
  dismissed: Routine[];
  offered: Routine[];
}

/** How a step reads as part of a routine: the control and what kind of action, numbers left out (prices, counts). */
export function stepKey(s: Step): string | null {
  const name = (n: string) => n.toLowerCase().replace(/\d+(?:[\s.,]\d+)*/g, "#").replace(/\s+/g, " ").trim().slice(0, 60);
  switch (s.kind) {
    case "click":
      return `c:${s.target.role}:${name(s.target.name)}`;
    case "type":
      return `t:${s.target.role}:${name(s.target.name)}`;
    case "key":
      return s.key === "Enter" ? `k:${s.key}` : null;
    case "file":
      return `f:${s.target ? `${s.target.role}:${name(s.target.name)}` : ""}`;
    case "page": {
      try {
        const u = new URL(s.url);
        return `p:${u.host}/${u.pathname.split("/")[1] ?? ""}`;
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

export function routineKeys(r: Pick<Recording, "steps">): string[] {
  const out: string[] = [];
  for (const s of r.steps) {
    const k = stepKey(s);
    if (k && out[out.length - 1] !== k) out.push(k);
  }
  return out;
}

/** The longest common subsequence's length. */
function lcs(a: string[], b: string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = x === b[j - 1] ? prev + 1 : Math.max(row[j], row[j - 1]);
      prev = cur;
    }
  }
  return row[b.length];
}

/** Two sessions do the same thing: mostly the same controls (Jaccard ≥ 0.6), in the same order. */
export function similar(a: string[], b: string[]): boolean {
  const actions = (k: string[]) => k.filter((x) => !x.startsWith("p:"));
  if (actions(a).length < 3 || actions(b).length < 3) return false;
  const sa = new Set(a);
  const sb = new Set(b);
  const shared = [...sa].filter((x) => sb.has(x));
  const jaccard = shared.length / (sa.size + sb.size - shared.length);
  if (jaccard < 0.6) return false;
  const keep = new Set(shared);
  return lcs(a.filter((x) => keep.has(x)), b.filter((x) => keep.has(x))) >= 0.8 * shared.length;
}

const dayOf = (at: number) => new Date(at).toDateString();

/**
 * Earlier sessions of the routine `rec` is part of, when it looks like a routine worth taking over: seen three times in
 * all, or twice on different days. Null otherwise, and for a routine the person said no to or was offered this week.
 */
export function findRepeats(all: Recording[], rec: Recording, routines: { dismissed: Routine[]; offered: Routine[] }, now: number): Recording[] | null {
  if (!rec.origin || rec.kind !== "takeover") return null;
  const keys = routineKeys(rec);
  const known = (list: Routine[]) => list.some((x) => x.origin === rec.origin && similar(x.keys, keys));
  if (known(routines.dismissed) || known(routines.offered.filter((x) => now - x.at < 7 * DAY))) return null;
  const same = all.filter((r) => r.id !== rec.id && r.origin === rec.origin && r.kind === "takeover" && similar(routineKeys(r), keys));
  const otherDay = same.some((r) => dayOf(r.startedAt) !== dayOf(rec.startedAt));
  return same.length >= 2 || (same.length === 1 && otherDay) ? same.sort((a, b) => a.startedAt - b.startedAt) : null;
}

export class Journal {
  readonly dir: string;
  private now: () => number;
  private maxAgeMs: number;
  private max: number;
  private seq = 0;

  constructor(o: { dir: string; now?: () => number; maxAgeDays?: number; max?: number }) {
    this.dir = o.dir;
    this.now = o.now ?? Date.now;
    this.maxAgeMs = (o.maxAgeDays ?? 30) * DAY;
    this.max = o.max ?? 500;
  }

  newId(): string {
    return `rec-${this.now().toString(36)}${(++this.seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  private file(id: string): string {
    if (!/^rec-[a-z0-9]+$/.test(id)) throw new Error(`bad recording id ${id}`);
    return join(this.dir, `${id}.json`);
  }

  save(r: Recording): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file(r.id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(r), { mode: 0o600 });
    renameSync(tmp, this.file(r.id));
    this.prune();
  }

  /** A picture that goes with recording `id` (a highlight): its file name, next to the recording. */
  writeImage(id: string, n: number, data: Buffer): string {
    mkdirSync(this.dir, { recursive: true });
    this.file(id);
    const name = `${id}-${n}.jpg`;
    writeFileSync(join(this.dir, name), data, { mode: 0o600 });
    return name;
  }

  /** Drop one picture of recording `id` (the person took its frame out of the lesson). */
  dropImage(id: string, name: string): void {
    this.file(id);
    if (name.startsWith(`${id}-`) && /^[\w-]+\.jpg$/.test(name)) rmSync(join(this.dir, name), { force: true });
  }

  get(id: string): Recording | undefined {
    try {
      return JSON.parse(readFileSync(this.file(id), "utf8")) as Recording;
    } catch {
      return undefined;
    }
  }

  /** The pictures of recording `id`: absolute paths. */
  images(id: string): string[] {
    this.file(id);
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.startsWith(`${id}-`) && f.endsWith(".jpg"))
      .sort((a, b) => Number(a.slice(id.length + 1, -4)) - Number(b.slice(id.length + 1, -4)))
      .map((f) => join(this.dir, f));
  }

  all(): Recording[] {
    if (!existsSync(this.dir)) return [];
    const out: Recording[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!/^rec-[a-z0-9]+\.json$/.test(f)) continue;
      const r = this.get(f.slice(0, -5));
      if (r) out.push(r);
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }

  list(limit = 30): RecordingSummary[] {
    return this.all()
      .slice(0, limit)
      .map((r) => ({ id: r.id, kind: r.kind, ...(r.goal ? { goal: r.goal } : {}), origin: r.origin, startedAt: r.startedAt, endedAt: r.endedAt, steps: r.steps.length }));
  }

  private remove(id: string): void {
    rmSync(this.file(id), { force: true });
    for (const img of this.images(id)) rmSync(img, { force: true });
  }

  /** Forget one session, today's, or all of them. Returns how many went. */
  forget(what: { id: string } | { day: "today" | "all" }): number {
    if ("id" in what) {
      const had = !!this.get(what.id);
      // Pictures of a session never saved (a cancelled demonstration) go too.
      this.remove(what.id);
      return had ? 1 : 0;
    }
    const today = dayOf(this.now());
    const gone = this.all().filter((r) => what.day === "all" || dayOf(r.startedAt) === today);
    for (const r of gone) this.remove(r.id);
    return gone.length;
  }

  /** Older than 30 days, or beyond the newest 500, goes (pictures included). */
  prune(): void {
    const list = this.all();
    const cutoff = this.now() - this.maxAgeMs;
    list.forEach((r, i) => {
      if (i >= this.max || r.endedAt < cutoff) this.remove(r.id);
    });
    // A picture whose recording never got saved (the session was cancelled) goes after a day.
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir)) {
      const m = /^(rec-[a-z0-9]+)-\d+\.jpg$/.exec(f);
      if (m && !existsSync(this.file(m[1])) && statSync(join(this.dir, f)).mtimeMs < this.now() - DAY) rmSync(join(this.dir, f), { force: true });
    }
  }

  private meta(): Meta {
    try {
      const m = JSON.parse(readFileSync(join(this.dir, META), "utf8")) as Partial<Meta>;
      return { dismissed: m.dismissed ?? [], offered: m.offered ?? [] };
    } catch {
      return { dismissed: [], offered: [] };
    }
  }

  private writeMeta(m: Meta): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, META), JSON.stringify(m), { mode: 0o600 });
  }

  /** Earlier sessions of the same routine as `rec` worth offering to take over (see findRepeats); marks it offered. */
  repeatsOf(rec: Recording): Recording[] | null {
    const m = this.meta();
    const found = findRepeats(this.all(), rec, m, this.now());
    if (found) {
      m.offered = [...m.offered.filter((x) => this.now() - x.at < 7 * DAY), { origin: rec.origin, keys: routineKeys(rec), at: this.now() }];
      this.writeMeta(m);
    }
    return found;
  }

  /** The person does not want the routine of recording `id` taken over: it is not offered again. */
  dismiss(id: string): boolean {
    const r = this.get(id);
    if (!r?.origin) return false;
    const m = this.meta();
    m.dismissed = [...m.dismissed, { origin: r.origin, keys: routineKeys(r), at: this.now() }].slice(-200);
    this.writeMeta(m);
    return true;
  }
}
