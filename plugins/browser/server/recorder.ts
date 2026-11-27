// What the person does in the agents' browser, as steps in words: the live view's input and the pages it lands on,
// the person's speech and the places they point at. A teach session ("let me show you") and every takeover record
// one; the agent reads it as Markdown (the steps' names are the ones browser_snapshot shows) and keeps the JSON next to
// the skill it writes. Pure: the manager feeds it what the isolated world says is under the pointer.

/** An element the person acted on, as browser_snapshot names it. `frame`: inside a frame of another site. */
export interface Target {
  role: string;
  name: string;
  href?: string;
  editable?: boolean;
  /** A password, one-time code or card field: what is typed there is never recorded. */
  secret?: boolean;
  /** Activating it looks like an action with consequences (buy, send, delete…): browser_submit's kind. */
  submit?: boolean;
  frame?: string;
}

export interface Control {
  role: string;
  name: string;
}

/** What a framed place means, when the person said so with one tap. */
export const MARKS = ["check", "varies", "avoid", "wait", "result"] as const;
export type Mark = (typeof MARKS)[number];

/** `note`: the person's comment on the step (never on a page or on their own words). */
export type Step = (
  | { kind: "page"; at: number; url: string; title: string }
  | { kind: "click"; at: number; target: Target; count: number; button?: "right" | "middle" }
  | { kind: "type"; at: number; target: Target; value?: string; secret?: boolean }
  | { kind: "key"; at: number; key: string; target?: Target; count: number }
  | { kind: "tab"; at: number; action: "new" | "switch" | "close" }
  | { kind: "scroll"; at: number; count: number }
  | { kind: "highlight"; at: number; text: string; controls: Control[]; image?: string; mark?: Mark }
  /** Files the person chose for a page's file field (their names only; the files are not kept). */
  | { kind: "file"; at: number; names: string[]; target?: Target }
  | { kind: "say"; at: number; text: string }
) & { note?: string };

/** A step while the recording goes on: `id` names it for the live view (it never leaves the recorder). */
export type LiveStep = Step & { id: number };

export interface Recording {
  id: string;
  /** "teach": the person showed a task on purpose; "takeover": they took control for anything else. */
  kind: "teach" | "takeover";
  goal?: string;
  /** Who the demonstration is for (teach), or who was working in the browser before the takeover. */
  agentId?: string;
  startedAt: number;
  endedAt: number;
  /** The site of the first page (the routine's site for the repeats). */
  origin: string;
  steps: Step[];
}

/** Two clicks on the same element this close together are one double click. */
const MULTI_CLICK_MS = 500;
const MAX_STEPS = 400;
const MAX_VALUE = 500;
const MAX_NOTE = 500;
const MAX_SAY = 2000;
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "AltGraph"]);

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const sameTarget = (a: Target | undefined, b: Target | undefined) => !!a && !!b && a.role === b.role && a.name === b.name && a.frame === b.frame;

export class Recorder {
  readonly id: string;
  readonly kind: Recording["kind"];
  goal?: string;
  agentId?: string;
  readonly startedAt: number;
  private steps: LiveStep[] = [];
  private seq = 0;
  private changes = 0;

  constructor(o: { id: string; kind: Recording["kind"]; goal?: string; agentId?: string; now: number }) {
    this.id = o.id;
    this.kind = o.kind;
    if (o.goal) this.goal = o.goal;
    if (o.agentId) this.agentId = o.agentId;
    this.startedAt = o.now;
  }

  /** Actions so far (what the live view counts): speech and pages are not actions. */
  get actions(): number {
    return this.steps.filter((s) => s.kind !== "say" && s.kind !== "page").length;
  }

  get empty(): boolean {
    return this.actions === 0 && !this.steps.some((s) => s.kind === "say");
  }

  /** Grows with every change: the live view's list of steps reloads on it. */
  get rev(): number {
    return this.changes;
  }

  private last(): LiveStep | undefined {
    return this.steps[this.steps.length - 1];
  }

  /** A step with its number, not yet in the list. */
  private numbered<S extends Step>(s: S): S & { id: number } {
    return Object.assign(s, { id: ++this.seq });
  }

  /** The new step's number; 0 when the recording is full. */
  private push(s: Step): number {
    if (this.steps.length >= MAX_STEPS) return 0;
    const live = this.numbered(s);
    this.steps.push(live);
    return live.id;
  }

  /** The steps so far for the live view (typing that has no text yet is not one). */
  list(): LiveStep[] {
    return structuredClone(this.steps.filter(kept));
  }

  /** Take a step out of the recording. A page stays: the steps after it happened there. */
  remove(id: number): boolean {
    const i = this.steps.findIndex((s) => s.id === id);
    if (i < 0 || this.steps[i].kind === "page") return false;
    this.steps.splice(i, 1);
    this.changes++;
    return true;
  }

  /**
   * The person's changes to a step: a note ("" takes it away; never on a page or on their words), what a framed place
   * means (null: only "look here"), the words of something they said ("" takes the step out). All or nothing.
   */
  annotate(id: number, c: { note?: string; mark?: Mark | null; text?: string }): boolean {
    const i = this.steps.findIndex((s) => s.id === id);
    const s = this.steps[i];
    if (!s) return false;
    if (c.note !== undefined && (s.kind === "page" || s.kind === "say")) return false;
    if (c.mark !== undefined && s.kind !== "highlight") return false;
    if (c.text !== undefined && s.kind !== "say") return false;
    if (c.note !== undefined) {
      const note = norm(c.note).slice(0, MAX_NOTE);
      if (note) s.note = note;
      else delete s.note;
    }
    if (c.mark !== undefined && s.kind === "highlight") {
      if (c.mark) s.mark = c.mark;
      else delete s.mark;
    }
    if (c.text !== undefined && s.kind === "say") {
      const text = norm(c.text).slice(0, MAX_SAY);
      if (text) s.text = text;
      else this.steps.splice(i, 1);
    }
    this.changes++;
    return true;
  }

  /** A press of the mouse (or a tap) on `target`; null: nothing the page could name was there. */
  click(target: Target | null, at: number, button: "left" | "right" | "middle" = "left"): void {
    if (!target) return;
    this.changes++;
    const last = this.last();
    if (button === "left" && last?.kind === "click" && !last.button && sameTarget(last.target, target) && at - last.at < MULTI_CLICK_MS * last.count) {
      last.count++;
      return;
    }
    this.push({ kind: "click", at, target, count: 1, ...(button !== "left" ? { button } : {}) });
  }

  /** Characters typed into `field` (the focused element). */
  text(chars: string, field: Target, at: number): void {
    if (!chars) return;
    this.changes++;
    const step = this.typing(field, at);
    if (step.secret) return;
    step.value = ((step.value ?? "") + chars).slice(0, MAX_VALUE);
  }

  /** A key that is not text. Backspace takes a character back from what is being typed. */
  key(key: string, field: Target | undefined, at: number): void {
    this.changes++;
    // Shift, Control and the like only change other keys.
    if (MODIFIER_KEYS.has(key)) return;
    const last = this.last();
    if (key === "Backspace" && last?.kind === "type" && sameTarget(last.target, field)) {
      if (!last.secret && last.value) last.value = last.value.slice(0, -1);
      return;
    }
    // Moving between fields is not a step of its own: the next field's typing says where it went.
    if (key === "Tab" || key === "Shift+Tab") return;
    if (last?.kind === "key" && last.key === key && (last.target === field || sameTarget(last.target, field)) && /^Arrow/.test(key)) {
      last.count++;
      return;
    }
    this.push({ kind: "key", at, key, ...(field ? { target: field } : {}), count: 1 });
  }

  /** What the field holds now, read from the page: the truth over the keystrokes (autocomplete, a selection replaced). */
  fieldValue(field: Target, value: string): void {
    this.changes++;
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const s = this.steps[i];
      if (s.kind !== "type") continue;
      if (!sameTarget(s.target, field)) return;
      if (!s.secret) s.value = value.slice(0, MAX_VALUE);
      return;
    }
  }

  private typing(field: Target, at: number): Extract<Step, { kind: "type" }> {
    const last = this.last();
    if (last?.kind === "type" && sameTarget(last.target, field)) return last;
    // The click that put the cursor into the field is part of typing there (with what the person noted on it).
    let note: string | undefined;
    if (last?.kind === "click" && last.count === 1 && !last.button && sameTarget(last.target, field)) {
      this.steps.pop();
      at = last.at;
      note = last.note;
    }
    const step: Extract<Step, { kind: "type" }> = field.secret ? { kind: "type", at, target: field, secret: true } : { kind: "type", at, target: field, value: "" };
    if (note) step.note = note;
    this.push(step);
    return step;
  }

  /** A tab landed on a page. The same address again (a reload, a title that came late) is not a new step. */
  page(url: string, title: string, at: number): void {
    if (!/^https?:/i.test(url)) return;
    this.changes++;
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const s = this.steps[i];
      if (s.kind !== "page") continue;
      if (s.url === url) {
        if (title) s.title = title;
        if (i === this.steps.length - 1 || this.steps.slice(i + 1).every((x) => x.kind === "say")) return;
      }
      break;
    }
    this.push({ kind: "page", at, url, title });
  }

  tab(action: "new" | "switch" | "close", at: number): void {
    this.changes++;
    this.push({ kind: "tab", at, action });
  }

  scroll(at: number): void {
    this.changes++;
    const last = this.last();
    if (last?.kind === "scroll") {
      last.count++;
      return;
    }
    this.push({ kind: "scroll", at, count: 1 });
  }

  /** The person chose files for the file field they just clicked. */
  files(names: string[], at: number): void {
    this.changes++;
    const last = this.last();
    const target = last?.kind === "click" && last.target.role === "file" ? last.target : undefined;
    // The click that opened the chooser is part of choosing.
    const note = target ? this.steps.pop()?.note : undefined;
    this.push({ kind: "file", at, names: names.slice(0, 20).map((n) => n.slice(0, 120)), ...(target ? { target } : {}), ...(note ? { note } : {}) });
  }

  /**
   * The person framed a place on the page: what is there, and the picture of it (a file next to the recording). The
   * step's number, for the note and the meaning they may add to it; 0 when the recording is full.
   */
  highlight(h: { text: string; controls: Control[]; image?: string }, at: number): number {
    this.changes++;
    return this.push({ kind: "highlight", at, text: norm(h.text).slice(0, 1500), controls: h.controls.slice(0, 15), ...(h.image ? { image: h.image } : {}) });
  }

  /** Words the person said, placed where they were said (the transcript comes in later than the steps after them). */
  say(text: string, at: number): void {
    const t = norm(text);
    if (!t) return;
    let i = this.steps.length;
    while (i > 0 && this.steps[i - 1].at > at) i--;
    if (this.steps.length >= MAX_STEPS) return;
    this.steps.splice(i, 0, this.numbered({ kind: "say", at, text: t.slice(0, MAX_SAY) }));
    this.changes++;
  }

  finish(at: number): Recording {
    const steps = this.steps.filter(kept).map(({ id: _id, ...s }) => s as Step);
    const first = steps.find((s) => s.kind === "page") as Extract<Step, { kind: "page" }> | undefined;
    return {
      id: this.id,
      kind: this.kind,
      ...(this.goal ? { goal: this.goal } : {}),
      ...(this.agentId ? { agentId: this.agentId } : {}),
      startedAt: this.startedAt,
      endedAt: at,
      origin: first ? originOf(first.url) : "",
      steps: structuredClone(steps),
    };
  }
}

/** Typing that left nothing in the field is no step. */
const kept = (s: Step) => !(s.kind === "type" && !s.secret && !s.value);

export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : "";
  } catch {
    return "";
  }
}

const q = (s: string) => `«${s}»`;

function targetText(t: Target): string {
  if (t.frame) return `something inside an embedded frame of ${t.frame}`;
  const name = t.name ? ` ${q(t.name)}` : "";
  return `${t.role}${name}`;
}

/** How a framed place reads by what the person said it means. */
const MARK_LINES: Record<Mark, string> = {
  check: "Marked a place to check every time",
  varies: "Marked what changes from time to time (an input of the task)",
  avoid: "Marked a place not to touch",
  wait: "Marked what to wait for before going on",
  result: "Marked the result to bring back",
};

/** One step in words, for the model. */
export function stepText(s: Step): string {
  const line = plainText(s);
  if (!s.note) return line;
  return s.kind === "highlight" ? `${line} The person's note: "${s.note}"` : `${line} — the person's note: "${s.note}"`;
}

function plainText(s: Step): string {
  switch (s.kind) {
    case "page":
      return `Landed on ${s.title ? `${q(s.title)} — ` : ""}${s.url}`;
    case "click": {
      const how = s.button === "right" ? "Right-clicked" : s.count === 2 ? "Double-clicked" : s.count > 2 ? `Clicked ${s.count} times on` : "Clicked";
      const href = s.target.href ? ` (→ ${s.target.href})` : "";
      const consequential = s.target.submit ? " — an action with consequences (browser_submit)" : "";
      return `${how} ${targetText(s.target)}${href}${consequential}`;
    }
    case "type":
      return s.secret ? `Typed a secret into ${targetText(s.target)} (not recorded: a password, code or card number)` : `Typed ${q(s.value ?? "")} into ${targetText(s.target)}`;
    case "key": {
      const times = s.count > 1 ? ` ×${s.count}` : "";
      return `Pressed ${s.key}${times}${s.target ? ` in ${targetText(s.target)}` : ""}${s.key === "Enter" && s.target?.submit ? " — submits (browser_submit)" : ""}`;
    }
    case "tab":
      return s.action === "new" ? "Opened a new tab" : s.action === "close" ? "Closed a tab" : "Switched to another tab";
    case "scroll":
      return s.count > 1 ? `Scrolled the page (×${s.count})` : "Scrolled the page";
    case "highlight": {
      const controls = s.controls.length ? ` Controls there: ${s.controls.map((c) => `${c.role} ${q(c.name)}`).join(", ")}.` : "";
      const image = s.image ? ` Picture: ${s.image}.` : "";
      const head = s.mark ? MARK_LINES[s.mark] : "Pointed at this place (look here)";
      return `${head}: ${s.text ? q(s.text) : "(no text)"}.${controls}${image}`;
    }
    case "say":
      return `The person said: "${s.text}"`;
    case "file":
      return `Chose ${s.names.length === 1 ? "the file" : `${s.names.length} files`} ${s.names.map(q).join(", ")}${s.target ? ` for ${targetText(s.target)}` : ""} — an upload (browser_upload with a file from your workspace)`;
  }
}

function clock(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function lines(steps: Step[]): string {
  return steps.map((s, i) => `${i + 1}. ${stepText(s)}`).join("\n");
}

/** The whole recording for the model (recording.md). */
export function toMarkdown(r: Recording): string {
  const minutes = Math.max(1, Math.round((r.endedAt - r.startedAt) / 60_000));
  const what = r.kind === "teach" ? `The person showed${r.goal ? ` how to: ${r.goal}` : " a task"}` : "The person used the browser themselves";
  return [`# Recording ${r.id}`, "", `${what}. ${clock(r.startedAt)}, ${minutes} min, ${r.steps.length} steps.`, "", lines(r.steps) || "(no steps)"].join("\n");
}

/** What the person did while an agent waited, for the agent's next browser result. */
export function hintText(r: Recording): string {
  return [
    `While you waited, the person did this in the browser (${clock(r.startedAt)}):`,
    lines(r.steps),
    "The page may have changed since your last look: take a snapshot before acting. If you follow a taught skill and this fixed a step of it, offer to update the skill when the task is done (hub_skill_save with replaces).",
  ].join("\n");
}
