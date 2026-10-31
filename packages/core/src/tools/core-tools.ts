// Tools implemented by the core itself (owner "core").

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { BehindEntry, ImageItem, InboxEntry, MapIcon, MapMarker, MapRoute, MessagePart, ModelSkill, RouteMode, ToolDescriptor, ToolResult } from "@piomio/shared";
import { brainsFor, isThinkingPreset, MAP_ICONS, sameBrain, truncate } from "@piomio/shared";
import type { ToolRegistry } from "./registry.ts";
import type { SkillIndex } from "../skills.ts";
import type { VaultService } from "../vault/service.ts";
import type { Store } from "../store.ts";
import { notifyInputError, notifyRefusal, type Notifier } from "../notifier.ts";
import type { AgentRegistry } from "../agents.ts";
import { imageTypeOf, MAX_IMAGE_BYTES, parseImageUrl } from "../media.ts";
import { mimeOf } from "../attachments.ts";
import type { Transcriber } from "../transcribe.ts";
import type { RoadRoute } from "../routing.ts";
import type { UserLocation } from "../user-location.ts";

export interface CoreToolDeps {
  registry: ToolRegistry;
  skills: SkillIndex;
  vault: VaultService;
  store: Store;
  notifier: Notifier;
  agents: AgentRegistry;
  createTask: (t: { agentId: string; goal: string; title: string; parentConversationId?: string; parentTaskId?: string; background: boolean; createdBy: "agent"; brainRef?: string; tainted?: boolean }) => { id: string; title: string };
  /** The live line between tasks and whoever started them (SessionRunner). */
  tasks: TaskLine;
  /** Add a card to the reply the agent is writing (SessionRunner.attachPart). */
  attachPart: (conversationId: string, part: MessagePart) => void;
  /** Pictures for the person: here, and from a task also in the dialog that started it (SessionRunner.showToPerson). */
  showToPerson?: (conversationId: string, part: MessagePart, taskId?: string) => void;
  /** The folders of the tasks a conversation started: a dialog shows what its tasks made (SessionRunner.startedWorkspaces). */
  startedWorkspaces?: (conversationId: string) => string[];
  /** <dataDir>/workspaces: `file:` image sources are relative to it. */
  workspacesRoot: string;
  /** Speech to text (transcribe.ts). */
  transcriber?: Transcriber;
  /** A route along roads or paths for show_map (routing.ts). */
  route?: (mode: Exclude<RouteMode, "transit">, stops: Array<[number, number]>) => Promise<RoadRoute | { error: string }>;
  /** Where the user is, when their phone shares it (user-location.ts). */
  userLocation?: () => UserLocation | undefined;
}

/** Who is writing to a task: the agent, its conversation and, inside a task, that task; tainted when it had read outside content. */
export type TaskSender = { agentId: string; conversationId: string; taskId?: string; tainted?: boolean };

export interface TaskLine {
  place(agentId: string, machine: string): { brainRef?: string; machineName: string; note?: string } | { error: string };
  ask(taskId: string, question: string): Promise<{ ok: boolean; text: string }>;
  /** What each agent is busy with now, one line each. */
  team(): string[];
  message(taskId: string, text: string, from: TaskSender): Promise<{ ok: boolean; text: string }>;
  cancel(taskId: string, from: TaskSender): { ok: boolean; text: string };
  computers(): Array<{ id: string; name: string; online: boolean }>;
  /** team_message: write to a teammate (a thread on the side; the reply comes back like a task's result). */
  teammate(to: string, text: string, from: TaskSender & { background: boolean; tainted: boolean; nest: boolean }): Promise<{ ok: boolean; text: string }>;
}

/** Tasks under tasks under tasks: deeper delegation is refused. */
const MAX_TASK_DEPTH = 3;

const MAX_IMAGES = 10;
const MAX_MARKERS = 50;

const clip = (v: unknown, max: number): string | undefined => {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return s ? (s.length > max ? `${s.slice(0, max - 1)}…` : s) : undefined;
};

/** A number within [min, max], or an error text for the model. */
function coord(v: unknown, name: string, min: number, max: number): number | string {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) return `${name} must be a number from ${min} to ${max}`;
  return n;
}

/** `path` (relative to the agent's workspace) as a real file inside it, or an error text. */
function workspaceFile(path: string, workspace: string, root: string): string | { error: string } {
  if (isAbsolute(path)) return { error: `${path}: give the path relative to your workspace` };
  let real: string;
  try {
    real = realpathSync(resolve(workspace, path));
    const inside = (dir: string) => real === dir || real.startsWith(dir + sep);
    if (!inside(realpathSync(workspace)) || !inside(realpathSync(root))) return { error: `${path}: outside your workspace` };
  } catch {
    return { error: `${path}: no such file in your workspace` };
  }
  return statSync(real).isFile() ? real : { error: `${path}: not a file` };
}

/**
 * `path` as a `file:` source under the workspaces root, or an error text: relative to the agent's workspace, or an
 * absolute path in it or in `more` (the folders of the tasks this conversation started).
 */
function workspaceImage(path: string, workspace: string, root: string, more: string[] = []): string | { error: string } {
  let real: string;
  let realRoot: string;
  const folders: string[] = [];
  try {
    realRoot = realpathSync(root);
    for (const dir of [workspace, ...more]) {
      try {
        folders.push(realpathSync(dir));
      } catch {
        /* a task's folder that was never made */
      }
    }
    real = realpathSync(resolve(workspace, path));
  } catch {
    return { error: `${path}: no such file${isAbsolute(path) ? "" : ` in your workspace (${workspace})`}` };
  }
  const inside = (dir: string) => real === dir || real.startsWith(dir + sep);
  if (!folders.some(inside) || !inside(realRoot)) return { error: `${path}: outside your workspace and your tasks' folders` };
  const st = statSync(real);
  if (!st.isFile()) return { error: `${path}: not a file` };
  if (!imageTypeOf(real)) return { error: `${path}: not an image (png, jpg, gif, webp, avif, bmp or svg)` };
  if (st.size > MAX_IMAGE_BYTES) return { error: `${path}: larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB` };
  return `file:${relative(realRoot, real).split(sep).join("/")}`;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/** How many Inbox entries and behind-the-scenes rows inbox_view reads to the agent: the newest. */
const INBOX_VIEW_ROWS = 20;

/** The Inbox as the agent reads it (English, for the model): unread questions, the next digest, what came in, what stayed behind the scenes and why. */
function inboxViewText(n: Notifier): string {
  const tz = n.settings.get().timezone;
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const when = (iso: string) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  };
  // Titles are other runs' words: one quoted line each.
  const quoted = (s: string) => JSON.stringify(truncate(s.replace(/\s+/g, " ").trim(), 120));
  const head = (e: Pick<InboxEntry, "title" | "agentId" | "createdAt">) => `${quoted(e.title)}${e.agentId ? ` from ${n.agentName(e.agentId)}` : ""}, ${when(e.createdAt)}`;
  const why = (b: BehindEntry): string => {
    const reason = b.reason ? ` (${b.reason})` : "";
    if (b.supersededBy) return "replaced by a newer one";
    if (b.kind === "approval") return `an approval push; the approval itself is in the chat${reason}`;
    if (b.digest) return `went into the digest ${quoted(b.digest.title)} (${when(b.digest.createdAt)})${reason}`;
    if (b.waiting) return `waits for the next digest${reason}`;
    if (b.level === "digest") return `went into an earlier digest${reason}`;
    return b.reason ? `silent (${b.reason})` : "silent, just for the record";
  };

  const view = n.inbox({ limit: INBOX_VIEW_ROWS });
  const behind = n.behind({ limit: INBOX_VIEW_ROWS }).slice(0, INBOX_VIEW_ROWS);
  const entries = view.entries.slice(0, INBOX_VIEW_ROWS);
  const lines = [`The user's Inbox (times are ${tz}).`];
  const questions = view.questions.slice(0, INBOX_VIEW_ROWS);
  if (questions.length) lines.push(`Unread questions (${view.questions.length}):`, ...questions.map((q) => `- ${head(q)}`));
  else lines.push("Unread questions: none.");
  const next = view.next;
  lines.push(
    !next
      ? "Next digest: nothing waits for it."
      : next.time
        ? `Next digest: at ${next.time}, ${next.count} item(s) waiting.`
        : `Next digest: ${next.count} item(s) waiting; no digest times are set, so it goes out only when asked (digest_now).`,
  );
  if (entries.length) {
    lines.push("Recent entries (newest first):", ...entries.map((e) => `- ${e.kind} ${head(e)}, ${e.unread ? "unread" : "read"}`));
    if (view.hasMore || view.entries.length > entries.length) lines.push("Older entries are not shown.");
  } else lines.push("Recent entries: none.");
  if (behind.length) {
    const more = view.behindCount > behind.length ? `; ${view.behindCount} in all, older ones not shown` : "";
    lines.push(`Behind the scenes (newest first; these did not reach the user${more}):`, ...behind.map((b) => `- ${b.kind} ${head(b)}: ${why(b)}`));
  } else lines.push("Behind the scenes: nothing.");
  return lines.join("\n");
}

/** What a task is about (task_delegate `about`) as the model skill the hub looks for. */
const ABOUT: Record<string, ModelSkill | undefined> = { code: "code", analysis: "reasoning", research: "reasoning", writing: "writing" };

export function registerCoreTools(d: CoreToolDeps): void {
  const reg = (spec: Omit<ToolDescriptor, "owner">, fn: (input: any, ctx: any) => Promise<ToolResult> | ToolResult) =>
    d.registry.register({ ...spec, owner: "core" }, async (input, ctx) => fn(input ?? {}, ctx));
  /** How many tasks (and threads) deep the caller already is. */
  const depthOf = (taskId: string | undefined): number => {
    let depth = 0;
    for (let id = taskId; id && depth <= MAX_TASK_DEPTH; id = d.store.getTask(id)?.parentTaskId) depth++;
    return depth;
  };

  reg(
    {
      name: "notify",
      description:
        "Tell the user something proactively. level: silent (log only), digest (goes into the next digest the assistant writes), notify (deliver now: interrupts the user), ask (needs the user's decision). Use sparingly. Write for the person, in their language: the title is the news itself (\"The botanical garden is closed on 2 November\"), not your process (\"Check finished\"); the body says what happened, why it matters and what you suggest. Leave out how you worked (failed sources, HTTP errors, feeds, tool names) unless it changes what they should do.",
      effect: "local-write",
      inputSchema: {
        type: "object",
        properties: {
          level: { type: "string", enum: ["silent", "digest", "notify", "ask"] },
          title: { type: "string", description: "Short headline (≤ 80 chars)" },
          body: { type: "string", description: "Concise details" },
        },
        required: ["level", "title"],
      },
    },
    async (i, ctx) => {
      const task = ctx.taskId ? d.store.getTask(ctx.taskId) : undefined;
      const refused = notifyRefusal(task);
      if (refused) return text(refused);
      const invalid = notifyInputError(i.level, i.title);
      if (invalid) return text(`Nothing was sent: ${invalid}`, true);
      const n = await d.notifier.notify({
        level: i.level,
        title: String(i.title).trim().slice(0, 200),
        body: String(i.body ?? ""),
        agentId: ctx.agentId,
        taskId: ctx.taskId,
        triggerId: task?.triggerId,
        conversationId: ctx.conversationId,
      });
      return text(`Notification recorded (level: ${n.effectiveLevel}${n.reason ? `, ${n.reason}` : ""}).`);
    },
  );

  reg(
    {
      name: "digest_now",
      description:
        "Send the user's digest now instead of waiting for the next digest time: the hub gathers what waits and the default agent writes it. Says how many items went in, or that there was nothing.",
      effect: "local-write",
      inputSchema: { type: "object", properties: {} },
    },
    async () => {
      const n = await d.notifier.flushDigest();
      return text(n ? `The digest is being written from ${n} item(s); it lands in the user's chat in a minute.` : "Nothing waits for a digest: nothing was sent.");
    },
  );

  reg(
    {
      name: "inbox_view",
      description:
        "Read the user's Inbox: unread questions waiting for their answer, when the next digest goes out and how many items wait for it, the newest entries (reports, digests, alerts, questions) with read state, and what stayed behind the scenes and why (waits for the digest, went into which digest, silent and why, replaced). Read-only.",
      effect: "read",
      inputSchema: { type: "object", properties: {} },
    },
    () => text(inboxViewText(d.notifier)),
  );

  reg(
    {
      name: "task_delegate",
      description:
        "Start a task for an agent (yourself or a teammate): it works on the side, in parallel, while you stay with the user, and its result comes back here as a message. One task per independent piece of work. Returns the task id. For a question or a small request to a teammate, write to them with team_message instead.",
      effect: "local-write",
      inputSchema: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description:
              "Complete, self-contained instructions: what to do, what done looks like, what to report. Name no folder for the results unless the user did: the task works in its own folder, and the pictures it shows reach this dialog.",
          },
          title: { type: "string", description: "Short title the user sees (≤ 60 chars), in the user's language" },
          agent: { type: "string", description: "Agent id (default: you). See task_agents." },
          machine: { type: "string", description: "Computer id or name to run on, when the work needs that computer's files, apps or hardware (default: the agent's usual brain). See task_agents." },
          depth: { type: "string", enum: ["fast", "balanced", "deep"], description: "How hard to think: fast for simple errands (a cheap quick model), balanced for everyday work, deep for hard problems (the most capable model, thinking long). The hub picks the brain and model for it." },
          about: { type: "string", enum: ["code", "analysis", "writing", "research", "errand"], description: "What the work is mostly about, so the hub picks a model good at it (code goes to a coding model)." },
          brain: { type: "string", description: "Only to insist on one brain (\"Brains here\" in your instructions); normally leave it to the hub." },
        },
        required: ["goal"],
      },
    },
    (i, ctx) => {
      const agentId = i.agent ? String(i.agent) : ctx.agentId;
      const target = d.agents.get(agentId);
      if (!target) return text(`No agent ${agentId}. See task_agents.`, true);
      // A brain that calls the tool before loading its schema guesses the names: "task" or "instructions" is the goal.
      // A call with none of them starts nothing.
      const given = [i.goal, i.task, i.instructions, i.prompt].find((v) => typeof v === "string" && v.trim());
      if (!given) return text("No task started: give it `goal` (complete, self-contained instructions) and a short `title`.", true);
      i = { ...i, goal: given };
      const brain = typeof i.brain === "string" && i.brain.trim() ? i.brain.trim() : undefined;
      // "codex" stands for the agent's Codex wherever it runs; a brain it does not have is refused with the ones it has.
      const lead = brain ? brainsFor(target, "task", { brain })[0] : undefined;
      if (brain && !target.brains.some((b) => sameBrain(b, lead!))) return text(`${agentId} has no brain ${brain}. Its brains: ${target.brains.join(", ")}.`, true);
      const depth = isThinkingPreset(i.depth) && i.depth !== "auto" ? i.depth : undefined;
      const skill = ABOUT[String(i.about ?? "")];
      const thinking = { ...(depth ? { preset: depth } : {}), ...(brain ? { brain } : {}), ...(skill ? { skill } : {}) };
      if (depthOf(ctx.taskId) >= MAX_TASK_DEPTH) return text("Tasks are already nested too deep here: do this part yourself.", true);
      let goal = String(i.goal);
      let place: { brainRef?: string; machineName: string; note?: string } | undefined;
      if (i.machine) {
        const p = d.tasks.place(agentId, String(i.machine));
        if ("error" in p) return text(p.error, true);
        place = p;
        if (p.note) goal = `${goal}\n\n${p.note}`;
      }
      const t = d.createTask({
        agentId,
        goal,
        title: String(i.title ?? String(i.goal).slice(0, 60)),
        parentConversationId: ctx.conversationId,
        parentTaskId: ctx.taskId,
        background: ctx.background,
        createdBy: "agent",
        ...(place?.brainRef ? { brainRef: place.brainRef } : {}),
        ...(depth || brain || skill ? { thinking } : {}),
        // Instructions from a session that read outside content may carry it: the task starts marked too.
        ...(ctx.tainted ? { tainted: true } : {}),
      });
      d.attachPart(ctx.conversationId, { type: "task", taskId: t.id });
      const where = place ? ` on ${place.machineName}${place.brainRef ? "" : " (through the machine tools)"}` : "";
      const how = [brain, depth, i.about].filter(Boolean).join(", ");
      return text(`Task created: ${t.id} “${t.title}”${where}${how ? ` (${how})` : ""}. It works on the side; its questions and its result will arrive here as messages.`);
    },
  );

  reg(
    {
      name: "team_message",
      description:
        "Write to a teammate (another agent on the user's team) the way you would write to a colleague: a question, a quick check, a small request. " +
        "They answer in a thread on the side that the user can follow, and their reply comes back here as a message — into your current turn if you are still working — so do not wait for it. " +
        "Writing to the same teammate again continues that thread. For work with steps, use task_delegate.",
      effect: "local-write",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "The teammate's agent id (or name). See task_agents." },
          text: { type: "string", description: "Your message, self-contained: they do not see this conversation" },
        },
        required: ["to", "text"],
      },
    },
    async (i, ctx) => {
      const r = await d.tasks.teammate(String(i.to ?? ""), String(i.text ?? "").slice(0, 8000), {
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
        taskId: ctx.taskId,
        background: ctx.background,
        tainted: ctx.tainted,
        nest: depthOf(ctx.taskId) < MAX_TASK_DEPTH,
      });
      return text(r.text, !r.ok);
    },
  );

  reg(
    {
      name: "task_agents",
      description: "List your teammates (role, where their brains run, what each is busy with now) for team_message and task_delegate, and the computers tasks can run on.",
      effect: "read",
      inputSchema: { type: "object", properties: {} },
    },
    () => {
      const computers = d.tasks.computers();
      const name = (id: string) => computers.find((c) => c.id === id)?.name ?? id;
      const agents = d.agents.list().map((a) => {
        const where = [...new Set(a.brains.map((b) => name(b.split("@")[1] ?? "local")))].join(", ");
        return `- ${a.id}: ${a.name} — ${a.description}${where ? ` (brains on: ${where})` : ""}`;
      });
      const pcs = computers.map((c) => `- ${c.id}: ${c.name}${c.id === "local" ? " (the hub's own computer)" : ""}, ${c.online ? "online" : "offline"}`);
      return text(["Agents:", ...agents, "", "Busy now:", ...d.tasks.team(), "", "Computers:", ...pcs].join("\n"));
    },
  );

  reg(
    {
      name: "task_message",
      description:
        "Send a task you started a message right away, even mid-work: the answer to its question, a clarification, a change of plan. A finished task continues with it.",
      effect: "local-write",
      inputSchema: {
        type: "object",
        properties: { taskId: { type: "string" }, text: { type: "string", description: "What the task should know or do" } },
        required: ["taskId", "text"],
      },
    },
    async (i, ctx) => {
      const r = await d.tasks.message(String(i.taskId), String(i.text), { agentId: ctx.agentId, conversationId: ctx.conversationId, taskId: ctx.taskId, tainted: ctx.tainted });
      return text(r.text, !r.ok);
    },
  );

  reg(
    {
      name: "task_cancel",
      description: "Stop a task you started (the user changed their mind, or it is no longer needed).",
      effect: "local-write",
      inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
    },
    (i, ctx) => {
      const r = d.tasks.cancel(String(i.taskId), { agentId: ctx.agentId, conversationId: ctx.conversationId, taskId: ctx.taskId });
      return text(r.text, !r.ok);
    },
  );

  reg(
    {
      name: "task_ask",
      description:
        "Inside a task: ask whoever started it something only they (or the user) can answer. Keep working on what does not depend on it; the answer arrives as a message.",
      effect: "local-write",
      inputSchema: { type: "object", properties: { question: { type: "string", description: "One clear question, with the options if there are any" } }, required: ["question"] },
    },
    async (i, ctx) => {
      if (!ctx.taskId) return text("task_ask works inside a task. In your dialog, ask the user directly.", true);
      const r = await d.tasks.ask(ctx.taskId, String(i.question).slice(0, 2000));
      return text(r.text, !r.ok);
    },
  );

  reg(
    {
      name: "task_status",
      description: "Get status and result of a task by id.",
      effect: "read",
      inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
    },
    (i) => {
      const t = d.store.getTask(String(i.taskId));
      if (!t) return text("Task not found", true);
      return text(JSON.stringify({ id: t.id, title: t.title, status: t.status, result: t.result, error: t.error }, null, 2));
    },
  );

  reg(
    {
      name: "skill_load",
      description: "Load the full instructions (SKILL.md) of a skill by name.",
      effect: "read",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    (i, ctx) => {
      const name = String(i.name);
      // A skill given to teammates is theirs: the work goes to them. A task following a skill (a trigger's run) has it.
      const agent = d.agents.get(ctx.agentId);
      const follows = ctx.taskId ? d.store.getTask(ctx.taskId)?.skill : undefined;
      if (agent && d.skills.get(name) && !d.skills.has(agent, name, follows)) {
        const who = (d.skills.holders?.get(name) ?? []).map((id) => `${id} (${d.agents.get(id)?.name ?? id})`);
        return text(
          `${name} is not one of your skills${who.length ? `: ${who.join(", ")} ${who.length === 1 ? "has" : "have"} it` : ""}. ` +
            "Ask them with team_message or hand them the work with task_delegate.",
          true,
        );
      }
      const s = d.skills.load(name);
      return s ? text(s) : text(`Skill ${name} not found`, true);
    },
  );

  reg(
    {
      name: "transcribe_audio",
      description:
        "Turn speech in an audio file from your workspace into text: a voice message the user sent (attachments/…), a recording you downloaded. " +
        "Voice messages usually arrive already transcribed; use this when a note says it could not be done, after speech-to-text was set up, or for other audio. " +
        "Formats: ogg/opus, mp3, m4a, wav, webm, flac, mp4; up to 25 MB.",
      effect: "read",
      inputSchema: { type: "object", properties: { path: { type: "string", description: "Audio file in your workspace, relative to it" } }, required: ["path"] },
    },
    async (i, ctx) => {
      if (ctx.machineId !== "local") return text(`Files on ${ctx.machineId} cannot be transcribed by the hub.`, true);
      if (typeof i.path !== "string" || !i.path.trim()) return text("Give path: the audio file, relative to your workspace.", true);
      const file = workspaceFile(i.path.trim(), ctx.workspace, d.workspacesRoot);
      if (typeof file !== "string") return text(file.error, true);
      if (!d.transcriber?.engine())
        return text(
          "No speech-to-text is set up. Offer the user a Groq API key (free tier, https://console.groq.com/keys) or an OpenAI API key, asked for with secret_request as groq_api_key or openai_api_key, then try again.",
          true,
        );
      try {
        const words = await d.transcriber.transcribe(file, mimeOf(file));
        return text(words ? `Transcript: ${words}` : "No speech in the recording.");
      } catch (e: any) {
        return text(`Could not transcribe it: ${e?.message ?? e}`, true);
      }
    },
  );

  reg(
    {
      name: "show_choices",
      description:
        "Put quick-reply buttons under your reply when the person picks among a few clear options (how often, which one, yes or no): a tap sends the option's text as their message. " +
        "Ask the question in your reply; keep options short (1–4 words), 2–6 of them, in their language. They can still type anything else.",
      effect: "read",
      availability: "interactive",
      inputSchema: {
        type: "object",
        properties: { options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 } },
        required: ["options"],
      },
    },
    (i, ctx) => {
      const options = (Array.isArray(i.options) ? i.options : []).map((o: unknown) => clip(o, 60)).filter((o: string | undefined): o is string => !!o);
      if (options.length < 2 || options.length > 6) return text("Give 2 to 6 short options.", true);
      d.attachPart(ctx.conversationId, { type: "choices", options });
      return text(`The person sees ${options.length} buttons under your reply; their tap comes back as their message. Do not list the options again as text.`);
    },
  );

  reg(
    {
      name: "show_images",
      description:
        "Show the user pictures right in the chat: one image appears as a card, 2–10 as a swipeable carousel, and they open full screen on click. " +
        "When your reply also goes to the user's phone (Telegram), the images go with it. Use it whenever a picture says more than words: photos of a place or product, " +
        "charts and screenshots you made, search results with images. Each image is either `url` (a public http(s) image address) or `path` " +
        "(an image file: relative to your workspace, or an absolute path in it or in the folder of a task you started; png, jpg, gif, webp, avif, bmp or svg, " +
        "up to 30 MB, a PNG render as it is). Shown inside a task, the images also reach the dialog that started it. Add a short `caption` in the user's language. " +
        "Do not repeat the images as markdown in your text; refer to them in words.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          images: {
            type: "array",
            minItems: 1,
            maxItems: MAX_IMAGES,
            items: {
              type: "object",
              properties: {
                url: { type: "string", description: "Public http(s) address of the image" },
                path: { type: "string", description: "Image file: relative to your workspace, or absolute in it or in a task's folder you started" },
                caption: { type: "string", description: "Shown under the image (≤ 200 chars)" },
                alt: { type: "string", description: "What the image shows, for screen readers" },
              },
            },
          },
        },
        required: ["images"],
      },
    },
    (i, ctx) => {
      const list: unknown[] = Array.isArray(i.images) ? i.images : i.url || i.path ? [i] : [];
      if (!list.length) return text("Give images: [{url} or {path}, …].", true);
      if (list.length > MAX_IMAGES) return text(`At most ${MAX_IMAGES} images at once; split them into several calls.`, true);
      const items: ImageItem[] = [];
      const problems: string[] = [];
      for (const [n, raw] of list.entries()) {
        const it = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const label = `image ${n + 1}`;
        let src: string | undefined;
        if (typeof it.path === "string" && it.path.trim()) {
          if (ctx.machineId !== "local") {
            problems.push(`${label}: files on ${ctx.machineId} cannot be shown; use a public url`);
            continue;
          }
          const r = workspaceImage(it.path.trim(), ctx.workspace, d.workspacesRoot, d.startedWorkspaces?.(ctx.conversationId));
          if (typeof r !== "string") {
            problems.push(`${label}: ${r.error}`);
            continue;
          }
          src = r;
        } else if (typeof it.url === "string" && it.url.trim()) {
          const u = parseImageUrl(it.url.trim());
          if (!u) {
            problems.push(`${label}: url must be a public http(s) address`);
            continue;
          }
          src = u.href;
        } else {
          problems.push(`${label}: give url or path`);
          continue;
        }
        items.push({ src, ...(clip(it.alt, 300) ? { alt: clip(it.alt, 300) } : {}), ...(clip(it.caption, 200) ? { caption: clip(it.caption, 200) } : {}) });
      }
      if (problems.length) return text(`Nothing shown. ${problems.join("; ")}.`, true);
      const part: MessagePart = { type: "images", items };
      if (d.showToPerson) d.showToPerson(ctx.conversationId, part, ctx.taskId);
      else d.attachPart(ctx.conversationId, part);
      return text(
        `The user now sees ${items.length === 1 ? "the image" : `a carousel of ${items.length} images`} in the chat (and in Telegram, if your reply goes there). ` +
          "Do not paste it again as markdown.",
      );
    },
  );

  reg(
    {
      name: "user_location",
      description:
        "Where the user is now, as their phone reports it (when they share their location in the Piomio app): the point, how exact it is, " +
        "the place's name and when it was reported. Use it for \"near me\", directions from where they are (show_map with an icon \"user\" marker as " +
        "the first stop), local time and weather questions. Your [You now] block already names the place when it is known.",
      effect: "read",
      inputSchema: { type: "object", properties: {} },
    },
    () => {
      const l = d.userLocation?.();
      if (!l) return text("Unknown: the user's phone does not share their location. They can turn it on in the Piomio app, on the Hub tab.");
      const ago = Math.max(0, Math.round((Date.now() - Date.parse(l.at)) / 60_000));
      return text(
        [
          `lat ${l.lat}, lon ${l.lon}${l.accuracyM !== undefined ? ` (within ${l.accuracyM} m)` : ""}`,
          l.place ? `Place: ${l.place}` : "",
          `Reported ${ago < 1 ? "just now" : ago < 120 ? `${ago} min ago` : `${Math.round(ago / 60)} h ago`} (${l.at}) by the phone “${l.deviceName}”.`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  );

  reg(
    {
      name: "show_map",
      description:
        "Show the user an interactive OpenStreetMap map right in the chat: places with symbols and short notes, and a route through them " +
        "(walking, driving and cycling routes follow real roads and paths, with length and time). The user can zoom, open it full screen, " +
        "tap a place in the list under the map, and open the place or the route in Apple Maps, Google Maps, Yandex Maps or 2GIS. When your reply " +
        "also goes to Telegram, the map goes with it as a location pin. Use it for places, addresses, \"where is…\" questions, things to see or eat " +
        "nearby, meeting points, directions and plans for a day. Coordinates are WGS84 decimal degrees. Without zoom the map fits everything; zoom 3 is " +
        "a continent, 10 a city, 15 streets, 18 buildings.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          lat: { type: "number", minimum: -90, maximum: 90, description: "Latitude of the centre (default: the middle of the markers)" },
          lon: { type: "number", minimum: -180, maximum: 180, description: "Longitude of the centre" },
          zoom: { type: "integer", minimum: 1, maximum: 19 },
          title: { type: "string", description: "Shown under the map, e.g. the place name or what the route is (≤ 120 chars)" },
          markers: {
            type: "array",
            maxItems: MAX_MARKERS,
            description: "Places to show; without markers the centre gets one",
            items: {
              type: "object",
              properties: {
                lat: { type: "number" },
                lon: { type: "number" },
                label: { type: "string", description: "The place's name (≤ 120 chars)" },
                note: { type: "string", description: "One line under the name: address, hours, why it is worth it (≤ 200 chars)" },
                icon: { type: "string", enum: [...MAP_ICONS], description: "What the place is; \"user\" marks where the user is" },
              },
              required: ["lat", "lon"],
            },
          },
          route: {
            type: "object",
            description: "A route through the markers",
            properties: {
              mode: { type: "string", enum: ["walk", "drive", "bike", "transit"], description: "transit draws straight lines; the user opens it in a maps app for times" },
              stops: { type: "array", items: { type: "integer", minimum: 0 }, description: "Marker indexes in route order (default: all markers in order)" },
            },
            required: ["mode"],
          },
        },
      },
    },
    async (i, ctx) => {
      const rawMarkers: unknown[] = Array.isArray(i.markers) ? i.markers : [];
      if (rawMarkers.length > MAX_MARKERS) return text(`At most ${MAX_MARKERS} markers.`, true);
      const markers: MapMarker[] = [];
      for (const [n, raw] of rawMarkers.entries()) {
        const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const mlat = coord(m.lat, `markers[${n}].lat`, -90, 90);
        const mlon = coord(m.lon, `markers[${n}].lon`, -180, 180);
        if (typeof mlat === "string" || typeof mlon === "string") return text([mlat, mlon].filter((x) => typeof x === "string").join("; "), true);
        if (m.icon !== undefined && !MAP_ICONS.includes(m.icon as MapIcon)) return text(`markers[${n}].icon must be one of: ${MAP_ICONS.join(", ")}`, true);
        const label = clip(m.label, 120);
        const note = clip(m.note, 200);
        markers.push({ lat: mlat, lon: mlon, ...(label ? { label } : {}), ...(note ? { note } : {}), ...(m.icon ? { icon: m.icon as MapIcon } : {}) });
      }
      // The centre: given, or the middle of the markers.
      const given = i.lat !== undefined && i.lat !== null;
      if (!given && !markers.length) return text("Give lat and lon, or markers.", true);
      const middle = (vs: number[]) => Math.round(((Math.min(...vs) + Math.max(...vs)) / 2) * 1e6) / 1e6;
      const lat = given ? coord(i.lat, "lat", -90, 90) : middle(markers.map((m) => m.lat));
      const lon = given ? coord(i.lon, "lon", -180, 180) : middle(markers.map((m) => m.lon));
      if (typeof lat === "string" || typeof lon === "string") return text([lat, lon].filter((x) => typeof x === "string").join("; "), true);
      let zoom: number | undefined;
      if (i.zoom !== undefined && i.zoom !== null) {
        const z = coord(i.zoom, "zoom", 1, 19);
        if (typeof z === "string") return text(z, true);
        zoom = Math.round(z);
      }

      let route: MapRoute | undefined;
      let routeNote = "";
      if (i.route && typeof i.route === "object") {
        const r = i.route as Record<string, unknown>;
        const mode = r.mode as RouteMode;
        if (!["walk", "drive", "bike", "transit"].includes(mode)) return text("route.mode must be walk, drive, bike or transit.", true);
        const stops = Array.isArray(r.stops) ? r.stops.map(Number) : markers.map((_, n) => n);
        if (stops.some((n) => !Number.isInteger(n) || n < 0 || n >= markers.length)) return text(`route.stops are marker indexes from 0 to ${markers.length - 1}.`, true);
        if (stops.length < 2) return text("A route needs at least two markers to go through.", true);
        const points = stops.map((n) => [markers[n].lat, markers[n].lon] as [number, number]);
        route = { mode, stops, path: points };
        if (mode === "transit") routeNote = " The transit route is drawn straight between the stops; the user can open it in a maps app for times.";
        else {
          const found = d.route ? await d.route(mode, points) : { error: "routing is off" };
          if ("error" in found) routeNote = ` No road route (${found.error}): the line is straight between the stops.`;
          else {
            route = { ...route, path: found.path, distanceM: found.distanceM, durationS: found.durationS };
            routeNote = ` Route: ${(found.distanceM / 1000).toFixed(1)} km, about ${Math.max(1, Math.round(found.durationS / 60))} min.`;
          }
        }
      }

      const title = clip(i.title, 120);
      d.attachPart(ctx.conversationId, {
        type: "map",
        lat,
        lon,
        ...(zoom !== undefined ? { zoom } : {}),
        ...(title ? { title } : {}),
        ...(markers.length ? { markers } : {}),
        ...(route ? { route } : {}),
      });
      return text(`The user now sees the map${title ? ` “${title}”` : ""} in the chat (and a location pin in Telegram, if your reply goes there).${routeNote}`);
    },
  );

  reg(
    {
      name: "vault_list",
      description: "List vault items (ids, names, types, non-secret hints). Never returns secret values. Pass `vault://<id>` to tools that accept secrets.",
      effect: "read",
      inputSchema: { type: "object", properties: {} },
    },
    () => {
      const items = d.vault.list();
      if (!items.length) return text("The vault is empty.");
      return text(
        `Vault: ${d.vault.state()}\n` +
          items.map((m) => `- vault://${m.id} (${m.type}) “${m.name}”${Object.keys(m.hints).length ? ` ${JSON.stringify(m.hints)}` : ""}${m.scope.revealToModel ? " [readable: vault_reveal]" : ""}`).join("\n"),
      );
    },
  );

  reg(
    {
      name: "vault_reveal",
      description: "Read the fields of a vault item that the user explicitly allowed to show to the model (revealToModel). Other items are refused.",
      effect: "read",
      inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
    },
    (i, ctx) => {
      const id = String(i.ref).replace(/^vault:\/\//, "");
      const meta = d.vault.getMeta(id);
      if (!meta) return text(`No vault item vault://${id}`, true);
      if (!meta.scope.revealToModel) return text("This item may not be shown to the model. Pass the vault:// reference to tools instead.", true);
      const fields = d.vault.access(id, { actor: `agent:${ctx.agentId}`, agentId: ctx.agentId, tool: "vault_reveal" });
      return text(JSON.stringify(fields, null, 2));
    },
  );
}
