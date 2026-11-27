// Agents learn from the person in the browser: a demonstration ("let me show you", browser_teach or the live view's
// Teach), and every takeover. While the person is in control their input is recorded (recorder.ts) with what is under
// the pointer, read from our isolated world before the input reaches the page. A demonstration ends with the
// recording in the agent's chat; a takeover while an agent works becomes a hint in its next browser result; a takeover
// of the person's own goes to the journal, where the same routine seen again becomes an offer to take it over.

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Page } from "playwright";
import type { PluginContext, PluginHttpRequest, PluginHttpResponse } from "@piomio/plugin-sdk";
import { Journal } from "./journal.ts";
import { pageCall } from "./page-script.ts";
import { hintText, MARKS, Recorder, stepText, toMarkdown, type Mark, type Recording, type Target } from "./recorder.ts";
import { PAGE_RULES } from "./safety.ts";
import { ToolError, withTimeout, type BrowserSettings } from "./util.ts";

/** A takeover this soon after an agent's browser call helps that agent: what the person did reaches it as a hint. */
const AGENT_RECENT_MS = 10 * 60_000;
/** A demonstration nobody watches any more ends as cancelled after this. */
const UNWATCHED_MS = 2 * 60_000;
/** How long the click waits for "what is under the pointer" before it goes to the page anyway. */
const INSPECT_MS = 300;
const MAX_SPEECH_BYTES = 8 * 1024 * 1024;
/** One of this plugin's tools as agents know it: an agent whose tools include it can use the browser. */
const OWN_TOOL = "browser_open";

export interface TeachState {
  id: string;
  goal: string;
  scope: "task" | "step";
  startedAt: number;
  steps: number;
  /** Grows with every change to the steps: the live view's list reloads on it. */
  rev: number;
  speech: boolean;
}

interface TeachSession {
  id: string;
  goal: string;
  scope: "task" | "step";
  /** Whom the recording goes to: the agent's chat (and its task), or the default agent's dialog. */
  agentId?: string;
  /** The person started it with the live view's Teach: the agent did not ask to be shown. */
  unasked?: boolean;
  conversationId?: string;
  sessionId?: string;
  taskId?: string;
  startedAt: number;
  speech: boolean;
  unwatchedSince?: number;
}

/** What the learning needs of the browser manager. */
export interface LearningHost {
  ctx: PluginContext;
  settings(): BrowserSettings;
  readonly userControl: boolean;
  setControl(on: boolean): void;
  /** Evaluate in our isolated world of the active tab. */
  inspect<T>(expression: string): Promise<T | null>;
  /** The active tab's size in CSS px (what the live view's 0..1 coordinates are relative to). */
  viewport(): { w: number; h: number };
  activePage(): Page | null;
  ensurePage(): Promise<Page>;
  titleOf(p: Page): Promise<string>;
  /** The title the tab had last (no wait). */
  titleNow(p: Page): string;
  /** A line for the next agent tool result. */
  note(text: string): void;
  watching(): boolean;
  /** The live view should hear of a change (state and activity). */
  changed(): void;
}

const clamp01 = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};

export class Learning {
  readonly journal: Journal;
  private h: LearningHost;
  private teach: TeachSession | null = null;
  private rec: Recorder | null = null;
  /** The field the person types into (from the click that focused it, or asked of the page). */
  private field: Target | null = null;
  private images = 0;
  /** The agent that used the browser last, and when. */
  private agent: { id: string; at: number } | null = null;
  /** Inputs are recorded in order: each waits for the one before it. */
  private chain: Promise<void> = Promise.resolve();

  constructor(h: LearningHost, dataDir: string) {
    this.h = h;
    this.journal = new Journal({ dir: join(dataDir, "journal") });
  }

  get teaching(): boolean {
    return !!this.teach;
  }

  /** An agent ran a browser tool. */
  agentUsed(agentId: string | undefined): void {
    if (agentId) this.agent = { id: agentId, at: Date.now() };
  }

  /** The agent being shown, when the lesson is for one by name (the live view says whose it is). */
  get learner(): string | undefined {
    return this.teach?.agentId;
  }

  state(): TeachState | null {
    const t = this.teach;
    if (!t) return null;
    return { id: t.id, goal: t.goal, scope: t.scope, startedAt: t.startedAt, steps: this.rec?.actions ?? 0, rev: this.rec?.rev ?? 0, speech: t.speech };
  }

  // ---------- a demonstration ----------

  /** Start a demonstration: the person gets control and the live view a bar (Done, Cancel, Highlight, the mic). */
  async start(o: { goal: string; scope?: "task" | "step"; agentId?: string; conversationId?: string; sessionId?: string; taskId?: string; unasked?: boolean }): Promise<TeachSession> {
    if (this.teach) throw new ToolError("The person is already showing something in the browser: wait for that recording to come.");
    const page = await this.h.ensurePage();
    // A takeover in progress ends here as one of its own; the demonstration starts clean.
    if (this.rec) this.endTakeover();
    const speech = await this.h.ctx.core
      .call<{ available?: boolean }>("speech.transcribe", { check: true })
      .then((r) => !!r?.available)
      .catch(() => false);
    const id = this.journal.newId();
    const t: TeachSession = { id, goal: o.goal.trim().slice(0, 200), scope: o.scope === "step" ? "step" : "task", startedAt: Date.now(), speech };
    for (const k of ["agentId", "conversationId", "sessionId", "taskId"] as const) if (o[k]) t[k] = o[k];
    if (o.unasked) t.unasked = true;
    this.teach = t;
    this.rec = new Recorder({ id, kind: "teach", goal: t.goal, ...(t.agentId ? { agentId: t.agentId } : {}), now: t.startedAt });
    this.rec.page(page.url(), await this.h.titleOf(page), t.startedAt);
    this.images = 0;
    this.field = null;
    this.h.ctx.log.info(`demonstration ${id} started${t.agentId ? ` for ${t.agentId}` : ""}`);
    if (!this.h.userControl) this.h.setControl(true);
    this.h.changed();
    return t;
  }

  /**
   * The live view's Teach: the lesson is for the agent whose chat is on the person's screen (`chatAgent`, as the view
   * says), so the skill it saves is its own; for the default agent when no agent's chat is open or that agent has no
   * browser tools.
   */
  async startByPerson(chatAgent: unknown): Promise<TeachSession> {
    const agentId = await this.browserAgent(chatAgent);
    return this.start({ goal: "", unasked: true, ...(agentId ? { agentId } : {}) });
  }

  /** `id` when it is an agent of the team that may use this plugin's tools. */
  private async browserAgent(id: unknown): Promise<string | undefined> {
    if (typeof id !== "string" || !id) return undefined;
    const team = await this.h.ctx.core.call<Array<{ id: string; tools?: string[] }>>("agents.list", {}).catch((e) => {
      this.h.ctx.log.warn(`the team is not known, so the lesson is the default agent's: ${e?.message ?? e}`);
      return [];
    });
    const agent = (Array.isArray(team) ? team : []).find((a) => a.id === id);
    if (!agent) return undefined;
    // An agent's tools are name globs; none listed means all (as the hub reads them).
    const globs = agent.tools?.length ? agent.tools : ["*"];
    return globs.some((g) => globMatches(g, OWN_TOOL)) ? id : undefined;
  }

  /** Done or Cancel (the bar), or the person handed control back (Done). */
  async finish(how: "done" | "cancel"): Promise<void> {
    const t = this.teach;
    const rec = this.rec;
    if (!t || !rec) return;
    await this.chain.catch(() => {});
    this.teach = null;
    this.rec = null;
    this.field = null;
    if (this.h.userControl) this.h.setControl(false);
    this.h.changed();
    const r = rec.finish(Date.now());
    if (how === "cancel") {
      this.journal.forget({ id: r.id });
      if (t.agentId && !t.unasked) await this.tell(t, `[Browser] The person cancelled the demonstration${t.goal ? ` of "${t.goal}"` : ""}: nothing was recorded. Ask in a sentence whether to try again later.`);
      return;
    }
    this.journal.save(r);
    const files = await this.deliver(t, r);
    await this.tell(t, demonstrationNote(t, r, files));
  }

  /** Every 5 s: a demonstration left without a viewer for 2 minutes ends as cancelled. */
  tick(): void {
    const t = this.teach;
    if (!t) return;
    if (this.h.watching()) {
      delete t.unwatchedSince;
      return;
    }
    t.unwatchedSince ??= Date.now();
    if (Date.now() - t.unwatchedSince > UNWATCHED_MS) void this.finish("cancel");
  }

  /** The recording and its pictures in the agent's workspace (downloads/), when its session runs on the hub. */
  private async deliver(t: TeachSession, r: Recording): Promise<string[]> {
    if (!t.sessionId) return [];
    try {
      return await exportFiles(this.h.ctx, this.journal, r, t.sessionId);
    } catch (e: any) {
      this.h.ctx.log.warn(`demonstration files not delivered: ${e?.message ?? e}`);
      return [];
    }
  }

  private async tell(t: Pick<TeachSession, "agentId" | "conversationId" | "taskId">, text: string): Promise<void> {
    // The chat the agent asked from, else its own dialog, else (no agent) the default agent's.
    const where = t.conversationId ? { conversationId: t.conversationId } : t.agentId ? { agentId: t.agentId } : {};
    try {
      await this.h.ctx.core.call("conversations.tell", { ...where, ...(t.taskId ? { taskId: t.taskId } : {}), text });
    } catch (e: any) {
      this.h.ctx.log.warn(`could not tell the agent: ${e?.message ?? e}`);
    }
  }

  // ---------- takeovers ----------

  /** The person took or handed back control. */
  onControl(on: boolean): void {
    if (on) {
      if (!this.rec) {
        const page = this.h.activePage();
        this.rec = new Recorder({ id: this.journal.newId(), kind: "takeover", ...(this.agent ? { agentId: this.agent.id } : {}), now: Date.now() });
        if (page) this.rec.page(page.url(), this.h.titleNow(page), Date.now());
        this.images = 0;
        this.field = null;
      }
      return;
    }
    // Handing control back during a demonstration means it is done.
    if (this.teach) {
      void this.finish("done");
      return;
    }
    if (this.rec) this.endTakeover();
  }

  private endTakeover(): void {
    const rec = this.rec;
    this.rec = null;
    this.field = null;
    if (!rec) return;
    const r = rec.finish(Date.now());
    if (rec.empty) return;
    const forAgent = this.agent && Date.now() - this.agent.at < AGENT_RECENT_MS ? this.agent.id : null;
    if (forAgent) this.h.note(hintText(r));
    if (!this.h.settings().rememberActions) return;
    this.journal.save(r);
    if (forAgent) return;
    const earlier = this.journal.repeatsOf(r);
    if (earlier) void this.tell({}, routineNote(r, earlier));
  }

  // ---------- what the person does ----------

  /** An input from the live view, before it reaches the page (the click needs what is under it first). */
  async beforeInput(m: any): Promise<void> {
    if (!this.rec) return;
    const job = this.chain.then(() => this.capture(m));
    this.chain = job.catch(() => {});
    await job.catch((e) => this.h.ctx.log.warn(`recorder: ${e?.message ?? e}`));
  }

  private async capture(m: any): Promise<void> {
    const rec = this.rec;
    if (!rec) return;
    const now = Date.now();
    if (m.event === "mouse" && m.action === "down") {
      await this.syncField();
      const { w, h } = this.h.viewport();
      const target = await this.inspectAt(clamp01(m.x) * w, clamp01(m.y) * h);
      rec.click(target, now, m.button === "right" ? "right" : m.button === "middle" ? "middle" : "left");
      this.field = target?.editable ? target : null;
    } else if (m.event === "wheel") {
      rec.scroll(now);
    } else if (m.event === "text") {
      const field = await this.currentField();
      if (field) rec.text(String(m.text ?? ""), field, now);
    } else if (m.event === "key" && m.action === "down") {
      const key = String(m.key ?? "");
      const shortcut = !!(m.ctrl || m.meta);
      // Shortcuts (select all, paste…) are no steps: the field's value read when the focus moves says what they did.
      if ([...key].length === 1 && !shortcut) {
        const field = await this.currentField();
        if (field) rec.text(key, field, now);
      } else if (!shortcut) {
        if (key === "Enter" || key === "Tab") await this.syncField();
        const field = this.field ?? undefined;
        rec.key(m.shift && key === "Tab" ? "Shift+Tab" : key, field, now);
        if (key === "Tab" || key === "Escape") this.field = null;
      }
    }
    this.h.changed();
  }

  /** The field the keys go to: known from the click, or asked of the page (focused by Tab or by the page itself). */
  private async currentField(): Promise<Target | null> {
    if (this.field) return this.field;
    const f = await this.h.inspect<(Target & { value?: string }) | null>(pageCall("field", { rules: PAGE_RULES })).catch(() => null);
    if (!f?.editable) return null;
    const target: Target = { ...f };
    delete (target as { value?: string }).value;
    this.field = target;
    return target;
  }

  /** What the field being typed into holds now (the page's truth), before the focus moves on. */
  private async syncField(): Promise<void> {
    const field = this.field;
    if (!field || field.secret || !this.rec) return;
    const f = await withTimeout(this.h.inspect<(Target & { value?: string }) | null>(pageCall("field", { rules: PAGE_RULES })), INSPECT_MS).catch(() => null);
    if (f && f.role === field.role && f.name === field.name && typeof f.value === "string") this.rec.fieldValue(field, f.value);
  }

  private async inspectAt(x: number, y: number): Promise<Target | null> {
    return withTimeout(this.h.inspect<Target | null>(pageCall("at", { x, y, rules: PAGE_RULES })), INSPECT_MS).catch(() => null);
  }

  /** A tab of the active page landed on a page while the person is in control. */
  page(url: string, title: string): void {
    if (!this.rec || !this.h.userControl) return;
    this.rec.page(url, title, Date.now());
  }

  /** The person chose files for the page's file chooser. */
  files(names: string[]): void {
    if (this.rec && this.h.userControl) {
      this.rec.files(names, Date.now());
      this.h.changed();
    }
  }

  tab(action: "new" | "switch" | "close"): void {
    if (this.rec && this.h.userControl) this.rec.tab(action, Date.now());
  }

  /**
   * The person framed a place on the page (0..1 of the picture). Emits "highlight" {ok, text, step}: `step` names the
   * new step, for the note and the meaning the person may add to it (POST teach/step).
   */
  async highlight(m: any): Promise<void> {
    const rec = this.rec;
    const page = this.h.activePage();
    if (!rec || !page || !this.h.userControl) {
      this.h.ctx.ui.emit("highlight", { ok: false });
      return;
    }
    const { w, h } = this.h.viewport();
    const x0 = Math.min(clamp01(m.x0), clamp01(m.x1)) * w;
    const x1 = Math.max(clamp01(m.x0), clamp01(m.x1)) * w;
    const y0 = Math.min(clamp01(m.y0), clamp01(m.y1)) * h;
    const y1 = Math.max(clamp01(m.y0), clamp01(m.y1)) * h;
    if (x1 - x0 < 4 || y1 - y0 < 4) {
      this.h.ctx.ui.emit("highlight", { ok: false });
      return;
    }
    const at = Date.now();
    const area = (await this.h.inspect<{ text: string; controls: Array<{ role: string; name: string }> }>(pageCall("area", { x0, y0, x1, y1, rules: PAGE_RULES })).catch(() => null)) ?? {
      text: "",
      controls: [],
    };
    let image: string | undefined;
    try {
      const shot = await page.screenshot({ type: "jpeg", quality: 70, clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, timeout: 5000 });
      image = this.journal.writeImage(rec.id, ++this.images, shot);
    } catch (e: any) {
      this.h.ctx.log.warn(`highlight picture: ${e?.message ?? e}`);
    }
    if (this.rec !== rec) return;
    const step = rec.highlight({ text: area.text, controls: area.controls, ...(image ? { image } : {}) }, at);
    if (!step) {
      // The recording is full: the frame is not in it, so neither is its picture.
      if (image) this.journal.dropImage(rec.id, image);
      this.h.ctx.ui.emit("highlight", { ok: false });
      return;
    }
    this.h.ctx.ui.emit("highlight", { ok: true, text: area.text.slice(0, 200), step });
    this.h.changed();
  }

  // ---------- the steps so far, for the person ----------

  /** GET teach/steps: what has been recorded so far, for the live view's list (it words the steps itself). */
  steps(): PluginHttpResponse {
    return { status: 200, body: { rev: this.rec?.rev ?? 0, steps: this.rec?.list() ?? [] } };
  }

  /**
   * POST teach/step {id, remove?, note?, mark?, text?}: the person takes a step out of the recording, puts a note on
   * it, says what a framed place means, or corrects the words written down from their speech. Changes what the agent
   * will read, never the page.
   */
  step(req: PluginHttpRequest): PluginHttpResponse {
    const rec = this.rec;
    if (!rec) return { status: 409, body: { error: "not recording" } };
    const b = (req.body ?? {}) as { id?: unknown; remove?: unknown; note?: unknown; mark?: unknown; text?: unknown };
    const id = Number(b.id);
    const before = rec.list().find((s) => s.id === id);
    if (!before) return { status: 404, body: { error: "no such step" } };
    let ok: boolean;
    if (b.remove === true) {
      ok = rec.remove(id);
      if (ok && before.kind === "highlight" && before.image) this.journal.dropImage(rec.id, before.image);
    } else {
      const change: { note?: string; mark?: Mark | null; text?: string } = {};
      if (typeof b.note === "string") change.note = b.note;
      if (typeof b.text === "string") change.text = b.text;
      if (b.mark === null) change.mark = null;
      else if (b.mark !== undefined) {
        if (!MARKS.includes(b.mark as Mark)) return { status: 400, body: { error: "no such mark" } };
        change.mark = b.mark as Mark;
      }
      if (!Object.keys(change).length) return { status: 400, body: { error: "nothing to change" } };
      ok = rec.annotate(id, change);
    }
    if (!ok) return { status: 400, body: { error: "this step cannot take that change" } };
    this.h.changed();
    return { status: 200, body: { ok: true, rev: rec.rev } };
  }

  /**
   * POST teach/speech: a segment of the person's speech while showing; its words go where they were said. With
   * `only`, the words just come back: the person is dictating into a note, which keeps them.
   */
  async speech(req: PluginHttpRequest): Promise<PluginHttpResponse> {
    const b = (req.body ?? {}) as { data?: unknown; mimeType?: unknown; durationMs?: unknown; only?: unknown };
    if (!this.teach || !this.rec) return { status: 409, body: { error: "not showing" } };
    const data = typeof b.data === "string" ? b.data : "";
    if (!data || data.length > (MAX_SPEECH_BYTES * 4) / 3) return { status: 400, body: { error: "no audio or too long" } };
    const rec = this.rec;
    const at = Date.now() - Math.min(60_000, Math.max(0, Number(b.durationMs) || 0));
    try {
      const r = await this.h.ctx.core.call<{ text?: string }>("speech.transcribe", { data, mimeType: typeof b.mimeType === "string" && b.mimeType ? b.mimeType.split(";")[0].trim() : "audio/webm" });
      const text = String(r?.text ?? "").trim();
      if (text && this.rec === rec && b.only !== true) {
        rec.say(text, at);
        this.h.changed();
      }
      return { status: 200, body: { text } };
    } catch (e: any) {
      return { status: 200, body: { error: String(e?.message ?? e).slice(0, 300) } };
    }
  }
}

/** A tool name glob of an agent's list (* any characters, ? one), as the hub matches them. */
function globMatches(glob: string, name: string): boolean {
  const pattern = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${pattern}$`, "i").test(name);
}

/** The recording and its pictures into a session's workspace (downloads/): the paths there. */
export async function exportFiles(ctx: PluginContext, journal: Journal, r: Recording, sessionId: string): Promise<string[]> {
  const put = async (name: string, data: Buffer) => (await ctx.core.call<{ path: string }>("files.deliver", { sessionId, name, data: data.toString("base64") })).path;
  const out = [await put(`${r.id}.md`, Buffer.from(toMarkdown(r))), await put(`${r.id}.json`, Buffer.from(JSON.stringify(r, null, 2)))];
  for (const img of journal.images(r.id)) out.push(await put(basename(img), readFileSync(img)));
  return out;
}

function demonstrationNote(t: TeachSession, r: Recording, files: string[]): string {
  const who = t.agentId ? "you" : "an agent (from the browser's Teach button, so you were not asked)";
  // Teach pressed with this agent's chat open: the lesson is its own, though it did not ask for one.
  const own = t.agentId && t.unasked ? " They pressed Teach in the browser with your chat open: you did not ask for it." : "";
  const asked = !!t.agentId && !t.unasked;
  const head = `[Browser] The person finished showing ${who}${t.goal ? ` how to: ${t.goal}` : " something in the browser"} (${t.scope === "step" ? "one step" : "the whole task"}).${own}`;
  const where = files.length
    ? `Files in your workspace: ${files.join(", ")}.`
    : `Recording ${r.id} (browser_journal export puts its files into your workspace).`;
  const next =
    t.scope === "step"
      ? "Carry on with your task using what the person showed; if you follow a taught skill, offer to update it at the end (hub_skill_save with replaces)."
      : `${asked ? "" : "Unless it is clear, first ask in one short question what this was for. "}Follow the teach-by-demo skill: retell the steps in a few lines, ask only what is unclear (what changes each time), ask about every step with consequences with quick replies, then save the skill with hub_skill_save and ${files.length ? "these files" : "the recording's files (browser_journal export)"}.`;
  return [head, where, "", toMarkdown(r), "", next].join("\n");
}

function routineNote(r: Recording, earlier: Recording[]): string {
  const when = [...earlier, r].map((x) => new Date(x.startedAt).toISOString().slice(0, 10)).join(", ");
  const site = r.origin.replace(/^https?:\/\//, "");
  const steps = r.steps
    .filter((s) => s.kind !== "say")
    .slice(0, 12)
    .map((s, i) => `${i + 1}. ${stepText(s)}`)
    .join("\n");
  return [
    `[Browser] The person did the same thing on ${site} ${earlier.length + 1} times (${when}) by themselves in the browser. The last time (recording ${r.id}; earlier: ${earlier.map((x) => x.id).join(", ")}):`,
    steps,
    "",
    "Offer to do it for them from now on, in one short message with quick replies (yes: learn it / no). Yes: browser_journal export these recordings and follow the teach-by-demo skill to make a skill. No: browser_journal dismiss with the last recording's id, so it is not offered again.",
  ].join("\n");
}
