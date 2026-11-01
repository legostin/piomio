// The hub's own commands (docs/superpowers/specs/2026-11-01-hub-commands-design.md): "/task …", "/goal …", "/brain",
// "/effort", "/archive" are answered by the hub at once, without the model, with a card or a line in the chat (and the
// same in words on the channel the command came from); "/schedule …" becomes a request the agent's turn gets.

import type { AgentDef, Conversation, Locale, MessagePart, OutboundMessage, Task, TaskStatus, ThinkingBrain, ThinkingPreset, ThinkingView } from "@piomio/shared";
import { COMMANDS_WITH_WORDS, goalControl, HUB_COMMANDS, isHubCommand, parseCommand, sameBrain, THINKING_PRESETS, truncate, type CommandView, type HubCommand } from "@piomio/shared";
import type { Store } from "./store.ts";
import type { AgentRegistry } from "./agents.ts";
import type { ChannelRegistry } from "./channels.ts";
import type { SessionRunner } from "./runner.ts";
import { agentName } from "./agents.ts";
import { applyThinking } from "./thinking.ts";
import { hubLocale, t, tFor } from "./i18n.ts";

/** A goal or a task still going: one goal per chat, a new one replaces it. */
const OPEN: TaskStatus[] = ["queued", "running", "waiting_approval", "waiting_input", "paused", "interrupted"];
/** What the web UI passes as the channel of a typed message: the answer is in the chat, nothing to send. */
const LOCAL_CHANNELS = new Set(["web", "app"]);

export interface HubCommandDeps {
  store: Store;
  agents: AgentRegistry;
  channels: ChannelRegistry;
  publicUrl: string;
  thinkingView(agent: AgentDef): Promise<ThinkingView>;
  saveAgent(agent: AgentDef, actor: string): AgentDef;
  tasks: Pick<SessionRunner, "createTask" | "cancelTask" | "pauseGoal" | "resumeGoal">;
}

type Outcome = { done: true } | { prompt: string };
const DONE: Outcome = { done: true };

export class HubCommands {
  private d: HubCommandDeps;
  constructor(deps: HubCommandDeps) {
    this.d = deps;
  }

  /** The hub's commands as the composer lists them, in the reader's language. */
  list(locale: Locale): CommandView[] {
    const tr = tFor(locale);
    return HUB_COMMANDS.map((name) => ({
      name,
      description: tr(`command.${name}.description`),
      source: "hub",
      ...(COMMANDS_WITH_WORDS.includes(name) ? { args: tr(`command.${name}.args`) } : {}),
    }));
  }

  /** A message that is one of the hub's commands: answered here (done), or the prompt its turn gets; undefined for any other. */
  async run(conv: Conversation, text: string, opts: { channel?: string } = {}): Promise<Outcome | undefined> {
    const cmd = parseCommand(text);
    if (!cmd || !isHubCommand(cmd.name)) return undefined;
    // A setup chat makes something: words there go to the agent that sets it up.
    if (conv.kind === "setup") return undefined;
    const agent = this.d.agents.get(conv.agentId);
    if (!agent) return undefined;
    const reply = new Reply(this.d, conv, opts.channel);
    // In a group the lead takes work (a task, a goal, a schedule); how one agent thinks is set in its own chat.
    if (conv.kind === "group" && !COMMANDS_WITH_WORDS.includes(cmd.name)) {
      reply.note(t("command.ownChat", { command: cmd.name }));
      return DONE;
    }
    return this.handle(cmd.name, cmd.args, agent, conv, reply);
  }

  private async handle(name: HubCommand, args: string, agent: AgentDef, conv: Conversation, reply: Reply): Promise<Outcome> {
    const who = agentName(agent, hubLocale());
    switch (name) {
      case "task": {
        if (!args) return reply.note(t("command.task.empty"));
        const task = this.d.tasks.createTask({ agentId: agent.id, goal: args, title: titleOf(args), parentConversationId: conv.id, parentTaskId: conv.taskId, background: false, createdBy: "user" });
        return reply.card({ type: "task", taskId: task.id }, t("command.task.started", { title: task.title }), task);
      }
      case "goal":
        return this.goal(args, agent, conv, reply);
      case "schedule":
        return {
          prompt: args
            ? `The person asks you to set up a schedule (the /schedule command): ${args}\n\nSet it up with your trigger tools: a recurring schedule, or a one-time reminder for a single moment, in their time zone. Then say in one line when it runs.`
            : "The person typed /schedule: show them, in short, the schedules and reminders they have with you (your trigger tools), and ask what to set up.",
        };
      case "brain":
        return this.brain(args, agent, reply, who);
      case "effort":
        return this.effort(args, agent, reply, who);
      case "archive":
        return reply.card({ type: "agent_archive", agentId: agent.id }, t("command.archive.channel", { agent: who, link: reply.link() }));
    }
  }

  private async goal(args: string, agent: AgentDef, conv: Conversation, reply: Reply): Promise<Outcome> {
    const open = this.d.store.listTasks({ status: OPEN, limit: 500 }).find((x) => x.kind === "goal" && x.parentConversationId === conv.id);
    const control = goalControl(args);
    if (!args || control) {
      if (!open) return reply.note(t("command.goal.none"));
      const line = { type: "task", taskId: open.id } as const;
      if (!control) return reply.card(line, t("command.goal.status", { title: open.title }), open);
      if (control === "clear") this.d.tasks.cancelTask(open.id);
      else if (control === "pause") this.d.tasks.pauseGoal(open.id);
      else this.d.tasks.resumeGoal(open.id);
      return reply.card(line, t(`command.goal.${control}`, { title: open.title }), open);
    }
    if (open) this.d.tasks.cancelTask(open.id);
    const goal = this.d.tasks.createTask({ agentId: agent.id, goal: args, title: titleOf(args), parentConversationId: conv.id, parentTaskId: conv.taskId, background: false, createdBy: "user", kind: "goal" });
    return reply.card({ type: "task", taskId: goal.id }, t("command.goal.set", { title: goal.title, agent: agentName(agent, hubLocale()) }), goal);
  }

  private async brain(args: string, agent: AgentDef, reply: Reply, who: string): Promise<Outcome> {
    const card = { type: "thinking", agentId: agent.id, focus: "brain" } as const;
    const view = await this.d.thinkingView(agent);
    const now = view.kinds.find((k) => k.kind === "chat")?.brain;
    const names = view.brains.map((b) => b.label).join(", ");
    const label = (ref?: string) => view.brains.find((b) => b.ref === ref)?.label ?? ref ?? t("command.brain.none");
    if (!args) return reply.card(card, t("command.brain.list", { agent: who, brain: label(now), list: names }));
    const b = findBrain(view.brains, args);
    if (!b) return reply.note(t("command.brain.unknown", { name: args, agent: who, list: names }));
    if (!b.ready) return reply.note(t("command.brain.notReady", { brain: b.label }));
    if (!now || !sameBrain(now, b.ref)) this.d.saveAgent({ ...applyThinking(agent, "chat", { brain: b.ref }, now), source: "user" }, "user");
    return reply.card(card, t("command.brain.switched", { agent: who, brain: b.label }));
  }

  private async effort(args: string, agent: AgentDef, reply: Reply, who: string): Promise<Outcome> {
    const card = { type: "thinking", agentId: agent.id, focus: "effort" } as const;
    const view = await this.d.thinkingView(agent);
    const chat = view.kinds.find((k) => k.kind === "chat");
    const brain = view.brains.find((b) => b.ref === chat?.brain);
    const efforts = brain?.efforts ?? [];
    const levels = [...THINKING_PRESETS.map((p) => t(`thinking.preset.${p}`).toLowerCase()), ...efforts];
    if (!args) return reply.card(card, t("command.effort.list", { agent: who, levels: levels.join(", ") }));
    const preset = findPreset(args);
    const effort = preset ? undefined : findEffort(efforts, args);
    if (!preset && !effort) return reply.note(t("command.effort.unknown", { level: args, levels: levels.join(", ") }));
    // From a preset to an exact effort the model stays the one the preset gave, as the header picker does.
    const patch = preset ? { preset } : { effort: effort!, ...(chat?.own?.model || !chat?.model ? {} : { model: chat.model }), ...(brain ? { brain: brain.ref } : {}) };
    this.d.saveAgent({ ...applyThinking(agent, "chat", patch, chat?.brain), source: "user" }, "user");
    const level = preset ? t(`thinking.preset.${preset}`) : effortName(effort!);
    return reply.card(card, t("command.effort.set", { agent: who, level }));
  }
}

/** Where a command's answer goes: the chat (a system message), and in words to the channel it came from. */
class Reply {
  private d: HubCommandDeps;
  private conv: Conversation;
  private channel?: string;
  constructor(d: HubCommandDeps, conv: Conversation, channel?: string) {
    this.d = d;
    this.conv = conv;
    this.channel = channel && !LOCAL_CHANNELS.has(channel) && d.channels.has(channel) ? channel : undefined;
  }

  note(text: string): Outcome {
    this.add({ type: "note", text }, text);
    return DONE;
  }

  card(part: MessagePart, text: string, task?: Task): Outcome {
    this.add(part, text, task);
    return DONE;
  }

  /** The chat in the web UI (a task's page for a task). */
  link(task?: Pick<Task, "id">): string {
    const c = this.conv;
    const path = task ? `tasks/${encodeURIComponent(task.id)}` : c.kind === "main" ? `agent/${encodeURIComponent(c.agentId)}` : c.taskId ? `tasks/${encodeURIComponent(c.taskId)}` : `chat/${encodeURIComponent(c.id)}`;
    return `${this.d.publicUrl}/${path}`;
  }

  private add(part: MessagePart, text: string, task?: Task): void {
    this.d.store.addMessage({ conversationId: this.conv.id, role: "system", parts: [part], status: "complete" });
    if (!this.channel) return;
    const out: OutboundMessage = { kind: "reply", text, conversationId: this.conv.id, link: this.link(task) };
    void this.d.channels.send(this.channel, out);
  }
}

/** A task's title from the person's words: the first line, at most 60 characters. */
function titleOf(words: string): string {
  const line = words.split("\n")[0].trim();
  return truncate(line, 60);
}

/** The brain the person named: by its name or ref, whole first, then the start of it, then anywhere in it; ready ones first. */
export function findBrain(brains: ThinkingBrain[], name: string): ThinkingBrain | undefined {
  const q = name.trim().toLowerCase();
  const keys = (b: ThinkingBrain) => [b.label.toLowerCase(), b.ref.toLowerCase(), b.ref.split(/[@:]/)[0].toLowerCase()];
  const order = [...brains].sort((a, b) => Number(b.ready) - Number(a.ready));
  for (const fits of [(k: string) => k === q, (k: string) => k.startsWith(q), (k: string) => k.includes(q)]) {
    const hit = order.find((b) => keys(b).some(fits));
    if (hit) return hit;
  }
  return undefined;
}

/** A depth preset by its id or its name in any language the hub speaks ("deep", "глубоко"). */
export function findPreset(word: string): ThinkingPreset | undefined {
  const q = word.trim().toLowerCase();
  return THINKING_PRESETS.find((p) => p === q || (["en", "ru"] as const).some((l) => tFor(l)(`thinking.preset.${p}`).toLowerCase() === q));
}

/** One of the brain's efforts by its id or its name ("high", "высокая"). */
export function findEffort(efforts: string[], word: string): string | undefined {
  const q = word.trim().toLowerCase();
  return efforts.find((e) => e === q || (["en", "ru"] as const).some((l) => tFor(l)(`thinking.effortName.${e}`).toLowerCase() === q));
}

/** An effort's name in the hub's language, or the effort itself when there is none. */
function effortName(effort: string): string {
  const key = `thinking.effortName.${effort}`;
  const name = t(key);
  return name === key ? effort : name;
}
