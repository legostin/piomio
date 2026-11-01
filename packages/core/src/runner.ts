// Session runner: turns user messages, delegated tasks and trigger runs into brain sessions.
// Handles brain selection and fallback, streaming into messages, tasks, deferred approvals and recovery.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentDef, Approval, BrainEvent, BrainTurn, Conversation, Machine, Message, MessagePart, OutboundMedia, OutboundMessage, SecretRequest, Task, TaskStatus, ThinkingChoice, ToolResult, WorkKind } from "@piomio/shared";
import { bound, brainSpeed, brainsFor, expandBrains, formatBrainRef, newId, nowIso, onMachine, onMachines, parseBrainRef, resolveThinking, sameBrain, taskThinking, thinkingFor, truncate, workKind } from "@piomio/shared";
import { confinement } from "./native-permissions.ts";
import { NATIVE_PERMISSION_TOOL } from "./tools/native-permission.ts";
import type { Config } from "./config.ts";
import type { Store, SessionRow } from "./store.ts";
import type { Settings } from "./settings.ts";
import type { AgentRegistry } from "./agents.ts";
import type { BrainRegistry, BrainHandle } from "./brains.ts";
import type { SkillIndex } from "./skills.ts";
import type { HookRegistry } from "./hooks.ts";
import type { Notifier } from "./notifier.ts";
import type { ChannelRegistry } from "./channels.ts";
import type { AuditLog } from "./audit.ts";
import type { EventBus } from "./bus.ts";
import type { Redactor } from "./vault/redact.ts";
import type { ToolGateway } from "./tools/gateway.ts";
import type { ApprovalService } from "./approvals.ts";
import { detailOfTool, stepOfTool, type MachineActivityFeed } from "./activity.ts";
import { needOf, route, skillOfGoal, type Route } from "./model-router.ts";
import type { EgressProxy } from "./egress.ts";
import { DEFAULT_BRAIN_EGRESS } from "./settings.ts";
import { buildSystemPrompt, taskEnding } from "./prompt.ts";
import { humanFailure } from "./notifier.ts";
import { agentName } from "./agents.ts";
import { hubLocale, LocalizedError, t } from "./i18n.ts";
import { captureNote, type CaptureResult, type SecretIntake } from "./secrets.ts";
import { readWorkspaceImage } from "./media.ts";
import { clockTime, TurnClock } from "./clock.ts";
import { busy, situation, TASK_STATE } from "./situation.ts";
import type { UserLocations } from "./user-location.ts";
import { attachmentNote, forSession, isSpeech, SPEECH_NOT_SET_UP, type AttachmentPart, type SessionFile } from "./attachments.ts";
import { MAX_AUTO_TRANSCRIBE_SEC, type Transcriber } from "./transcribe.ts";
import { firstSpeakers, groupTurn, groupTurnText, handOff, MAX_HANDOFFS, USER_LABEL } from "./group-chat.ts";
import { hubName } from "./pairing.ts";
import { cardKind, delivered, deliveredNote, recap, type NotificationPart } from "./continuity.ts";

export interface RunnerDeps {
  config: Config;
  store: Store;
  settings: Settings;
  agents: AgentRegistry;
  brains: BrainRegistry;
  skills: SkillIndex;
  hooks: HookRegistry;
  notifier: Notifier;
  channels: ChannelRegistry;
  audit: AuditLog;
  bus: EventBus;
  redactor: Redactor;
  gateway: ToolGateway;
  approvals: ApprovalService;
  egress: EgressProxy;
  /** Claude Code-format plugin dirs to pass to Claude Code sessions. */
  claudePluginDirs: () => string[];
  machineName: (machineId: string) => string | undefined;
  /** The paired computers (task_delegate's `machine`). */
  machines?: () => Machine[];
  /** The id an agent's binding (AgentDef.machines) names the hub's own computer by: its replica id in a cluster, else "local". */
  here?: () => string;
  /** Turns in progress by machine, for the machines block (set by the hub). */
  activity?: MachineActivityFeed;
  /** Where the user is, when their phone shares it. */
  locations?: UserLocations;
  secrets: SecretIntake;
  /** First-run setup (set by the hub): keeps messages written while no brain works and adds the prompt section. */
  setup?: {
    hold(conversationId: string, agentId: string, prompt: string, opts: { replyChannel?: string; quote?: string; attachments?: AttachmentPart[]; speech?: Record<string, string> }): void;
    promptBlock(agentId: string): Promise<string | undefined>;
  };
  /** Speech to text for voice messages (set by the hub). */
  transcriber?: Transcriber;
  /**
   * The names of every tool there is now (set by the hub). A plugin turned on or off changes them, and the session's
   * next turn reopens it, resuming the same conversation: a CLI brain reads the tool list only when it starts.
   */
  toolNames?: () => string;
}

/** What the web UI passes as the channel of a typed message (not a registered channel). */
const WEB_CHANNEL = "web";

interface TurnOpts {
  task?: Task;
  /** The channel the user's message came from: the reply goes back there. */
  replyChannel?: string;
  /** The user's words typed in the web UI, quoted when the reply is mirrored to the channels. */
  quote?: string;
  /** The member who answers (group chats; default: the conversation's agent). */
  agentId?: string;
  /** Files that came with the user's message: the brain gets their paths and a note. */
  attachments?: AttachmentPart[];
  /** Voice notes without a transcript, by path: why (the note tells the agent). */
  speech?: Record<string, string>;
  /** Group chats: the user message this round answers, and why the member has the floor if not addressed by it. */
  group?: { triggerId?: string; floorNote?: string };
  /** The input carries outside content (a tainted task's result, a tainted teammate's message): mark the session first. */
  taint?: boolean;
  /** The user's message the reply answers (shown above it): a task's report when the dialog moved on since the request. */
  replyTo?: { messageId: string; text: string };
  /** The input is the user's own words (not a system note): plugins may learn from it (turn.context). */
  fromUser?: boolean;
}

/** User messages waiting for the conversation's next turn. */
interface Pending {
  messageId: string;
  prompt: string;
  attachments: AttachmentPart[];
  replyChannel?: string;
  quote?: string;
}

/** Who writes to a teammate (team_message): the agent, where it writes from, and whether it may start a nested thread. */
export interface TeamSender {
  agentId: string;
  conversationId: string;
  taskId?: string;
  background: boolean;
  tainted: boolean;
  /** False when tasks are nested too deep here to start one more thread (continuing one is fine). */
  nest: boolean;
}

interface Live {
  handle: BrainHandle;
  brainRef: string;
  /** The agent definition the session was opened with: an edited agent gets a fresh session on its next turn. */
  stamp: string;
  /** The model and effort it thinks with now (the router's choice for its last turn). */
  model?: string;
  effort?: string;
}

/** Before a message in a live session that the hub moved to another model (model-router.ts). */
const MODEL_SWITCH_NOTE = "(The hub chose another model for this message; that is internal: do not mention it.)";

export interface TurnResult {
  text: string;
  /** Just the final answer, without the narration around tool calls: what the channels get. */
  answer?: string;
  error?: string;
  /** Why it could not start, when the hub knows: "no-brain", none of the agent's brains is set up. */
  errorCode?: "no-brain";
  limited?: { resetAt?: string };
  awaitingApproval: boolean;
  /** The assistant message the turn wrote (its last one, when messages joined the turn). */
  messageId?: string;
  /** Channels whose messages joined the turn: they get the reply too. */
  channels?: string[];
}

/** A turn streaming in a conversation: more input can join it. */
interface ActiveTurn {
  sessionId: string;
  handle: BrainHandle;
  row: SessionRow;
  /** Close the reply so far and go on in a new message (after the message that just joined). */
  split(): void;
  channels: Set<string>;
}

/** Tasks still going: what the starter's turns list as open. */
const OPEN_TASK: TaskStatus[] = ["queued", "running", "waiting_approval", "waiting_input", "paused", "interrupted"];

/** Harness built-in tools whose results come from the outside world. */
const NATIVE_SOURCE_TOOLS = /^(WebFetch|WebSearch|web_search|fetch)$/i;
const MAX_TASK_CONCURRENCY = 4;
/** Messages to teammates from one conversation since the user last wrote there: more is agents talking among themselves. */
const MAX_TEAM_MESSAGES = 6;
/** A thread answered this recently still continues when the agent writes to the same teammate again. */
const THREAD_FRESH_MS = 60 * 60_000;
/** Settings key: agent id → when the user last changed that agent's brains. */
const BRAINS_CHANGED_KEY = "brainsChangedAt";
/** What plugins may add before one turn's input (turn.context), in characters. */
const MAX_TURN_CONTEXT = 12_000;
/** Workspace images a channel gets inline with one reply, in all. */
const MAX_INLINE_MEDIA_BYTES = 40 * 1024 * 1024;

export class SessionRunner {
  d: RunnerDeps;
  private live = new Map<string, Live>();
  private queues = new Map<string, Promise<unknown>>();
  private activeTurns = new Map<string, ActiveTurn>();
  private runningTasks = new Set<string>();
  private brainLoad = new Map<string, number>();
  /** Turns waiting for a busy brain: woken when any brain's turn ends. */
  private freed = new Set<() => void>();
  /** By conversation: user messages written while a turn runs, which reach the agent together as its next turn. */
  private pending = new Map<string, Pending[]>();
  /** When each live session last got the current time (clock.ts). */
  private clock = new TurnClock();
  /** The `[You now]` block each live session saw last (situation.ts). */
  private seen = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private kickoff?: NodeJS.Timeout;
  private streamingMessage = new Map<string, string>(); // conversationId -> messageId
  private turning = new Map<string, number>(); // conversationId -> turns in progress
  /** Dialogs whose session is being opened ahead of the person's message (warm()). */
  private warming = new Map<string, Promise<unknown>>();
  /** Sessions opened ahead that start without the history: their first turn gets the recap. */
  private freshAhead = new Set<string>();
  /** Group chats: the member answering now, then the ones waiting (while a round runs). */
  private floors = new Map<string, string[]>();
  /** Group chats: bumped by Stop, so rounds started or queued before it end. */
  private groupEpoch = new Map<string, number>();
  /** Group chats: `${conversationId}|${agentId}` -> user messages up to this moment were shown to the member. */
  private groupSeen = new Map<string, string>();

  constructor(deps: RunnerDeps) {
    this.d = deps;
    deps.approvals.onDeferredApproved = (a) => this.onDeferredApproved(a);
    deps.approvals.onDeferredDenied = (a) => this.onDeferredDenied(a);
    deps.bus.on("approval.created", (a: Approval) => this.attachApprovalPart(a));
    deps.bus.on("approval.asked", (a: Approval) => this.attachApprovalPart(a));
    deps.bus.on("approval.resolved", (a: Approval) => this.updateApprovalPart(a));
    deps.secrets.onResolved = (r, how) => this.onSecretResolved(r, how);
  }

  // ---------- lifecycle ----------

  start(): void {
    this.d.store.failStreamingMessages();
    // A card that never got into a chat (asked outside a turn by an older hub, or on another replica) gets one now.
    for (const a of this.d.approvals.list(["pending"], 200)) if (!this.hasApprovalPart(a)) this.attachApprovalPart(a);
    for (const t of this.d.store.listTasks({ status: ["running", "waiting_approval", "interrupted"] })) {
      this.d.store.updateTask(t.id, { status: "queued" });
    }
    this.timer = setInterval(() => {
      this.scheduleTasks();
      const s = this.d.settings.get();
      const { remind } = this.d.approvals.sweep(s.approvalExpireHours);
      for (const a of remind) {
        void this.d.notifier.notify({ level: "notify", kind: "approval", title: t("notify.awaitingApproval"), body: a.summary, agentId: a.agentId, taskId: a.taskId });
      }
    }, 15_000);
    this.timer.unref();
    this.kickoff = setTimeout(() => this.scheduleTasks(), 1000).unref();
  }

  /** Turns running now (a replica hands the lead over once they are done). */
  busyTurns(): number {
    return this.activeTurns.size;
  }

  async stop(): Promise<void> {
    // Both timers go before the hub closes the database: a hub stopped within a second of starting would otherwise query a closed db.
    clearInterval(this.timer);
    clearTimeout(this.kickoff);
    await Promise.all([...this.live.keys()].map((id) => this.closeLive(id)));
  }

  /** Close a live brain session and revoke its egress grant. */
  private async closeLive(id: string): Promise<void> {
    const l = this.live.get(id);
    this.live.delete(id);
    this.d.egress.revokeOwner(`brain:${id}`);
    this.clock.forget(id);
    this.seen.delete(id);
    await l?.handle.close().catch(() => {});
  }

  // ---------- public entry points ----------

  /** A user message arrived (web, Telegram, ...). Returns the stored user message. */
  /** `context`: lines for the model only, before the user's words (a channel's "forwarded from…", "in reply to…"). */
  async userMessage(
    conversationId: string,
    text: string,
    opts: { channel?: string; attachments?: AttachmentPart[]; context?: string; onCapture?: (c: CaptureResult) => void } = {},
  ): Promise<Message> {
    const conv = this.d.store.getConversation(conversationId);
    if (!conv) throw new LocalizedError("conversation.notFound");
    // An agent in the archive sleeps: its dialog takes nothing until it comes back.
    if (conv.kind !== "group" && this.d.agents.isArchived(conv.agentId)) {
      throw new LocalizedError("agent.archivedChat", { name: this.agentLabel(conv.agentId) }, 409);
    }
    // Secrets come out first: message hooks, the stored message and the model only see vault:// references.
    const cap = this.d.secrets.capture(text, conversationId, "user");
    if (cap.stored.length || cap.withheld) opts.onCapture?.(cap);
    text = cap.text;
    const hooked = await this.d.hooks.run("message.in", { conversationId, text, channel: opts.channel }, (p, r) =>
      r.block ? { blocked: r.block } : r.text !== undefined ? { ...p, text: r.text } : p,
    );
    const attachments = opts.attachments ?? [];
    const parts: MessagePart[] = [...(text || !attachments.length ? [{ type: "text" as const, text }] : []), ...attachments];
    const msg = this.d.store.addMessage({ conversationId, role: "user", parts, status: "complete", channel: opts.channel });
    if (cap.withheld) this.d.store.addMessage({ conversationId, role: "system", parts: [{ type: "error", message: t("secrets.withheld") }], status: "complete" });
    if (hooked.blocked) {
      this.d.store.addMessage({ conversationId, role: "system", parts: [{ type: "error", message: t("message.blocked", { reason: hooked.blocked }) }], status: "complete" });
      return msg;
    }
    // Just the answer to a secret card whose tool call is still waiting: that call carries on, no new turn.
    if (cap.answered?.waited && text.trim() === `vault://${cap.answered.request.vaultId}`) return msg;
    const note = captureNote(cap);
    const expanded = this.d.skills.expandCommand(hooked.payload.text) ?? hooked.payload.text;
    const prompt = [opts.context?.trim(), note ? `${expanded}\n\n${note}` : expanded].filter(Boolean).join("\n");
    // From the web UI: the user's words travel with a mirrored reply, so the phone shows the exchange.
    const fromWeb = !opts.channel || opts.channel === WEB_CHANNEL;
    const files = attachments.length ? { attachments } : {};
    if (conv.kind === "group") {
      this.startGroupRound(conv, hooked.payload.text, prompt, msg.id, { replyChannel: opts.channel, ...files });
      return msg;
    }
    const quote = [text, ...attachments.map((a) => `📎 ${a.name}`)].filter(Boolean).join("\n");
    const reply = { replyChannel: opts.channel, ...(fromWeb ? { quote } : {}) };
    const task = conv.taskId ? this.d.store.getTask(conv.taskId) : undefined;
    // A turn is running here: the message joins it and the brain takes it at its next step (voice notes become words
    // first). A brain that cannot take it, or a turn that ended meanwhile, gets it as the next turn.
    if (this.activeTurns.has(conversationId)) {
      void (async () => {
        const files: Pick<TurnOpts, "attachments" | "speech"> = attachments.length ? await this.transcribeParts(msg.id, attachments) : {};
        if (await this.steerInto(conversationId, prompt, { ...reply, ...files, fromUser: true })) return;
        if (task) await this.wakeTask(task, prompt, { ...reply, ...files, fromUser: true });
        else this.queueUserTurn(conv, { messageId: msg.id, prompt, attachments: files.attachments ?? [], ...reply });
      })();
      return msg;
    }
    // Written on a task's page: the task carries on with it (its status, result and report follow).
    if (task) {
      void (async () => this.wakeTask(task, prompt, { ...reply, fromUser: true, ...(attachments.length ? await this.transcribeParts(msg.id, attachments) : {}) }))();
      return msg;
    }
    this.queueUserTurn(conv, { messageId: msg.id, prompt, attachments, ...reply });
    return msg;
  }

  /**
   * A user message for the conversation's next turn. Messages written in a row while a turn runs (or before the next
   * one starts) reach the agent together, as one turn: people clarify in several short messages. Voice notes become
   * words first, in the queue: the turn waits for them, later messages wait for the turn.
   */
  private queueUserTurn(conv: Conversation, item: Pending): void {
    const waiting = this.pending.get(conv.id);
    if (waiting) {
      waiting.push(item);
      return;
    }
    const batch = [item];
    this.pending.set(conv.id, batch);
    void this.enqueue(conv.id, async () => {
      if (this.pending.get(conv.id) === batch) this.pending.delete(conv.id);
      const attachments: AttachmentPart[] = [];
      const speech: Record<string, string> = {};
      for (const b of batch) {
        if (!b.attachments.length) continue;
        const files = await this.transcribeParts(b.messageId, b.attachments);
        attachments.push(...files.attachments);
        Object.assign(speech, files.speech);
      }
      const quote = batch.flatMap((b) => (b.quote ? [b.quote] : [])).join("\n");
      return this.runTurn(conv, batch.map((b) => b.prompt).join("\n\n"), {
        fromUser: true,
        replyChannel: batch[0].replyChannel,
        ...(quote ? { quote } : {}),
        ...(attachments.length ? { attachments, speech } : {}),
      });
    });
  }

  /** More input for the turn running in the conversation: true when its brain took it (the reply goes on there). */
  private async steerInto(conversationId: string, text: string, opts: Pick<TurnOpts, "replyChannel" | "attachments" | "speech" | "taint" | "fromUser"> = {}): Promise<boolean> {
    const a = this.activeTurns.get(conversationId);
    if (!a) return false;
    // Outside content joining the turn marks its session before the brain can read it.
    if (opts.taint) this.markTainted(a.row);
    // What plugins add for this input (the memories that matter now), as for a turn of its own.
    const conv = this.d.store.getConversation(conversationId);
    const agent = this.d.agents.get(a.row.agentId);
    if (conv && agent) {
      const extra = await this.turnContext(a.row, conv, agent, a.row.taskId ? this.d.store.getTask(a.row.taskId) : undefined, text, opts);
      if (this.activeTurns.get(conversationId) !== a) return false;
      if (extra) text = `${extra}\n\n${text}`;
    }
    if (!(await a.handle.steer(this.turnInput(a.row, text, opts)))) return false;
    if (this.activeTurns.get(conversationId) === a) {
      a.split();
      if (opts.replyChannel && opts.replyChannel !== WEB_CHANNEL) a.channels.add(opts.replyChannel);
    }
    return true;
  }

  /** Voice notes and audio files in a user message become words: stored on the parts (the chat shows them), and why not when they cannot. */
  private async transcribeParts(messageId: string, parts: AttachmentPart[]): Promise<{ attachments: AttachmentPart[]; speech: Record<string, string> }> {
    const speech: Record<string, string> = {};
    const todo = parts.filter((p) => isSpeech(p) && p.transcript === undefined);
    if (!todo.length) return { attachments: parts, speech };
    const t = this.d.transcriber;
    if (!t?.engine()) {
      for (const p of todo) speech[p.path] = SPEECH_NOT_SET_UP;
      return { attachments: parts, speech };
    }
    const root = join(this.d.config.dataDir, "workspaces");
    const out: AttachmentPart[] = [];
    for (const p of parts) {
      if (!todo.includes(p)) out.push(p);
      else if (p.durationSec !== undefined && p.durationSec > MAX_AUTO_TRANSCRIBE_SEC) {
        speech[p.path] = "not transcribed: longer than 10 minutes (transcribe_audio can do it if the user wants)";
        out.push(p);
      } else {
        try {
          out.push({ ...p, transcript: await t.transcribe(join(root, p.path), p.mimeType) });
        } catch (e: any) {
          speech[p.path] = `could not transcribe it: ${e?.message ?? e}`;
          out.push(p);
        }
      }
    }
    const done = new Map(out.filter((p) => p.transcript !== undefined).map((p) => [p.path, p.transcript!]));
    const m = done.size ? this.d.store.getMessage(messageId) : undefined;
    if (m) this.d.store.updateMessage(m.id, { parts: m.parts.map((p) => (p.type === "attachment" && done.has(p.path) ? { ...p, transcript: done.get(p.path) } : p)) });
    return { attachments: out, speech };
  }

  // ---------- group chats ----------

  /** A group's members that are still on the team (not deleted, not asleep in the archive), in order (the lead first), with their names. */
  private groupMembers(conv: Conversation): Array<{ id: string; name: string }> {
    const out: Array<{ id: string; name: string }> = [];
    for (const id of conv.members ?? [conv.agentId]) {
      const a = this.d.agents.get(id);
      if (a && !this.d.agents.isArchived(id)) out.push({ id, name: agentName(a, hubLocale()) });
    }
    return out;
  }

  /** The member answering in a group chat right now, then the ones waiting for their turn. */
  floor(conversationId: string): string[] {
    return this.floors.get(conversationId) ?? [];
  }

  private setFloor(conversationId: string, queue: string[] | undefined): void {
    if (queue?.length) this.floors.set(conversationId, queue);
    else this.floors.delete(conversationId);
    this.d.bus.emit("conversation.activity", { conversationId, running: this.isRunning(conversationId) });
  }

  /** The user wrote in a group: the members it mentions answer one after another (or the lead), in the conversation queue. */
  private startGroupRound(conv: Conversation, text: string, prompt: string, triggerId: string, opts: { replyChannel?: string; attachments?: AttachmentPart[] }): void {
    const epoch = this.groupEpoch.get(conv.id) ?? 0;
    const speakers = firstSpeakers(text, this.groupMembers(conv));
    void this.enqueue(conv.id, () => this.runGroupRound(conv.id, epoch, speakers, prompt, triggerId, opts));
  }

  private async runGroupRound(
    conversationId: string,
    epoch: number,
    speakers: string[],
    prompt: string,
    triggerId: string,
    opts: { replyChannel?: string; attachments?: AttachmentPart[]; speech?: Record<string, string> },
  ): Promise<void> {
    const stopped = () => (this.groupEpoch.get(conversationId) ?? 0) !== epoch;
    if (stopped()) return;
    if (opts.attachments?.length) opts = { ...opts, ...(await this.transcribeParts(triggerId, opts.attachments)) };
    const queue = [...speakers];
    const handedBy = new Map<string, string>();
    let handoffs = 0;
    let prev: string | undefined;
    // One "running" for the whole round: the sidebar and the composer do not flicker between members.
    this.setTurning(conversationId, 1);
    try {
      while (queue.length && !stopped()) {
        const conv = this.d.store.getConversation(conversationId);
        if (!conv) break;
        const members = this.groupMembers(conv);
        const agentId = queue.shift()!;
        // Left the group (or the team) meanwhile; and nobody speaks twice in a row unless the user named them.
        if (!members.some((m) => m.id === agentId) || (agentId === prev && !speakers.includes(agentId))) continue;
        this.setFloor(conversationId, [agentId, ...queue]);
        const from = handedBy.get(agentId);
        const fromName = from ? (members.find((m) => m.id === from)?.name ?? from) : undefined;
        const r = await this.runTurn(conv, prompt, {
          ...opts,
          agentId,
          fromUser: !fromName,
          group: { triggerId, floorNote: fromName ? `[System] ${fromName} handed the floor to you. It is your turn to reply in the group.` : undefined },
        });
        prev = agentId;
        if (stopped() || (r.error && !r.text)) continue;
        const next = handOff(queue, agentId, r.answer ?? r.text, members, MAX_HANDOFFS - handoffs);
        handoffs += next.added.length;
        for (const id of next.added) handedBy.set(id, agentId);
        queue.splice(0, queue.length, ...next.queue);
      }
    } finally {
      this.setFloor(conversationId, undefined);
      this.setTurning(conversationId, -1);
    }
  }

  /** A member's turn text: what it has not seen in the group yet, then the user's message or why it is its turn. */
  private groupText(conv: Conversation, agent: AgentDef, prompt: string, opts: TurnOpts, newBrain: boolean): string {
    const key = `${conv.id}|${agent.id}`;
    const names = new Map(this.groupMembers(conv).map((m) => [m.id, m.name]));
    const name = (id: string | undefined) => (id ? (names.get(id) ?? (this.d.agents.get(id) ? agentName(this.d.agents.get(id)!, hubLocale()) : id)) : USER_LABEL);
    const turn = groupTurn({
      messages: this.d.store.listMessages(conv.id, { limit: 60 }),
      agentId: agent.id,
      name,
      prompt,
      triggerId: opts.group?.triggerId,
      floorNote: opts.group?.floorNote,
      seenUserUpTo: this.groupSeen.get(key),
    });
    if (turn.seenUserUpTo) this.groupSeen.set(key, turn.seenUserUpTo);
    // A fresh session of a member who spoke here before has none of that: the recap instead of just the unseen part.
    const spoke = newBrain && this.d.store.listMessages(conv.id, { limit: 160 }).some((m) => m.role === "assistant" && m.agentId === agent.id);
    const seed = spoke ? this.recapOf(conv.id, agent) : undefined;
    if (seed) return `${seed}\n\n---\n${turn.tail}`;
    return groupTurnText({ ...turn, lines: turn.lines.map((l) => this.d.redactor.text(l)) });
  }

  /** A card (secret request, plugin setup, images, a map) for the message the agent is writing right now in this conversation. */
  attachPart(conversationId: string, part: MessagePart): void {
    const msgId = this.streamingMessage.get(conversationId);
    const m = msgId ? this.d.store.getMessage(msgId) : undefined;
    // The same card twice in one reply (the agent called the tool again) shows once.
    const key = attachedKey(part);
    if (m && key && m.parts.some((p) => attachedKey(p) === key)) return;
    if (m) this.d.store.updateMessage(m.id, { parts: [...m.parts, part] });
    else this.d.store.addMessage({ conversationId, role: "system", parts: [part], status: "complete" });
  }

  /**
   * Something for the person to see (pictures): in the conversation it was made in, and when that is a task, also in
   * the dialog that started it, under the task's line, as its questions are: the person reads the dialog.
   */
  showToPerson(conversationId: string, part: MessagePart, taskId?: string): void {
    this.attachPart(conversationId, part);
    const dialog = this.starterDialog(taskId);
    if (dialog && taskId) this.d.store.addMessage({ conversationId: dialog.id, role: "assistant", agentId: dialog.agentId, parts: [{ type: "task", taskId }, part], status: "complete" });
  }

  /** The folders of the tasks a conversation started (and theirs, in turn): what it may show the person from. */
  startedWorkspaces(conversationId: string): string[] {
    return this.d.store
      .listTasks({ limit: 500 })
      .filter((t) => t.parentConversationId === conversationId || this.starterDialog(t.id)?.id === conversationId)
      .map((t) => this.workspacePath({ agentId: t.agentId, taskId: t.id, conversationId: t.conversationId }));
  }

  /**
   * The person tapped a quick reply: the buttons rest on that option, and its text is their next message (the same
   * way as typed). A second tap does nothing.
   */
  async choose(messageId: string, index: number, channel: string): Promise<Message | undefined> {
    const m = this.d.store.getMessage(messageId);
    const at = m?.parts.findIndex((p) => p.type === "choices") ?? -1;
    const part = at >= 0 ? (m!.parts[at] as Extract<MessagePart, { type: "choices" }>) : undefined;
    if (!m || !part || part.chosen !== undefined || !Number.isInteger(index) || !part.options[index]) return undefined;
    const parts = m.parts.slice();
    parts[at] = { ...part, chosen: index };
    this.d.store.updateMessage(m.id, { parts });
    return this.userMessage(m.conversationId, part.options[index], { channel });
  }

  /** The user saved (or dismissed) a secret card after its tool call stopped waiting: tell the agent and let it go on. */
  private onSecretResolved(r: SecretRequest, how: { waited: boolean; viaMessage: boolean }): void {
    this.updateSecretPart(r);
    // Answered by a chat message: that message starts the next turn itself.
    if (how.waited || how.viaMessage || r.status === "pending" || !r.conversationId) return;
    const conv = this.d.store.getConversation(r.conversationId);
    if (!conv) return;
    if (r.status === "cancelled") {
      const note = `[System] The user dismissed the request for ${r.title} (vault://${r.vaultId}).`;
      this.d.store.addMessage({ conversationId: conv.id, role: "system", parts: [{ type: "text", text: note }], status: "complete" });
      return;
    }
    this.tellAgent(conv.id, `[System] The user stored ${r.title} in the vault as vault://${r.vaultId}${r.pluginId ? ` and plugin ${r.pluginId} now uses it` : ""}. Carry on with what it was needed for.`);
  }

  /**
   * Something the user did outside the conversation (a card) that the agent should hear about: a note and a turn.
   * `taint`: the note carries outside content (a plugin's, e.g. what a web page showed): its session is marked first.
   */
  tellAgent(conversationId: string, note: string, opts: { taint?: boolean } = {}): void {
    const conv = this.d.store.getConversation(conversationId);
    if (!conv) return;
    this.d.store.addMessage({ conversationId: conv.id, role: "system", parts: [{ type: "text", text: note }], status: "complete" });
    void this.enqueue(conv.id, () => this.runTurn(conv, note, opts.taint ? { taint: true } : {}));
  }

  /** The user did something in a card, outside any turn: note it for the agent and let it answer. */
  noteAndContinue(conversationId: string, note: string): void {
    const conv = this.d.store.getConversation(conversationId);
    if (!conv) return;
    this.d.store.addMessage({ conversationId: conv.id, role: "system", parts: [{ type: "text", text: note }], status: "complete" });
    void this.enqueue(conv.id, () => this.runTurn(conv, note, {}));
  }

  /** Messages kept while no brain worked: the agent answers them now. */
  resume(conversationId: string, prompt: string, opts: { replyChannel?: string; quote?: string; attachments?: AttachmentPart[]; speech?: Record<string, string> }): void {
    const conv = this.d.store.getConversation(conversationId);
    if (!conv) return;
    void this.enqueue(conv.id, () => this.runTurn(conv, prompt, opts));
  }

  private updateSecretPart(r: SecretRequest): void {
    if (!r.conversationId) return;
    for (const m of this.d.store.listMessages(r.conversationId, { limit: 50 })) {
      if (m.parts.some((p) => p.type === "secret_request" && p.requestId === r.id && p.status !== r.status)) {
        this.d.store.updateMessage(m.id, { parts: m.parts.map((p) => (p.type === "secret_request" && p.requestId === r.id ? { ...p, status: r.status } : p)) });
      }
    }
  }

  /** Stop the turn in progress. In a group chat the members still waiting (this round and queued ones) do not answer either. */
  interrupt(conversationId: string): boolean {
    const round = this.floors.has(conversationId);
    if (round || this.d.store.getConversation(conversationId)?.kind === "group") {
      this.groupEpoch.set(conversationId, (this.groupEpoch.get(conversationId) ?? 0) + 1);
    }
    const a = this.activeTurns.get(conversationId);
    if (a) void a.handle.interrupt();
    return !!a || round;
  }

  /** A turn (brain selection included) is in progress in the conversation. */
  isRunning(conversationId: string): boolean {
    return (this.turning.get(conversationId) ?? 0) > 0;
  }

  private setTurning(conversationId: string, delta: 1 | -1): void {
    const was = this.isRunning(conversationId);
    const n = Math.max(0, (this.turning.get(conversationId) ?? 0) + delta);
    if (n) this.turning.set(conversationId, n);
    else this.turning.delete(conversationId);
    if (was !== n > 0) this.d.bus.emit("conversation.activity", { conversationId, running: n > 0 });
  }

  createTask(t: {
    agentId: string;
    goal: string;
    title: string;
    parentConversationId?: string;
    parentTaskId?: string;
    background: boolean;
    createdBy: Task["createdBy"];
    triggerId?: string;
    /** The brain (and so the computer) the task runs on, instead of the agent's own order. */
    brainRef?: string;
    kind?: Task["kind"];
    tainted?: boolean;
    /** A thread's sender: its opening message is theirs. */
    from?: string;
    /** A channel's gathering run (feeds.ts). */
    feedId?: string;
    /** The skill the task follows (a trigger's run of a taught skill). */
    skill?: string;
    /** How the result reaches the person (a schedule's report, the digest). */
    deliver?: Task["deliver"];
    /** The brain and depth for this job (the digest: fast, writing). */
    thinking?: Task["thinking"];
  }): Task {
    const task = this.d.store.createTask({ ...t, ...(t.tainted ? { tainted: true } : {}) });
    this.d.store.addMessage({ conversationId: task.conversationId, role: "user", parts: [{ type: "text", text: t.goal }], status: "complete", ...(t.from ? { agentId: t.from } : {}) });
    this.d.audit.append(t.createdBy === "user" ? "user" : `agent:${t.agentId}`, "task.create", task.id, { title: t.title, background: t.background, triggerId: t.triggerId });
    setImmediate(() => this.scheduleTasks());
    return task;
  }

  /** The agent goes to sleep or leaves: the turn in its dialog stops and its unfinished tasks are cancelled. */
  stopAgent(agentId: string): void {
    this.interrupt(this.d.store.agentConversation(agentId).id);
    const open = this.d.store.db
      .prepare("select id from tasks where agent_id = ? and status in ('queued', 'running', 'paused', 'waiting_approval', 'waiting_input', 'interrupted')")
      .all(agentId) as Array<{ id: string }>;
    for (const t of open) this.cancelTask(t.id);
  }

  cancelTask(id: string): Task | undefined {
    const t = this.d.store.getTask(id);
    if (!t) return undefined;
    this.interrupt(t.conversationId);
    return this.d.store.updateTask(id, { status: "cancelled" });
  }

  retryTask(id: string): Task | undefined {
    const t = this.d.store.getTask(id);
    if (!t) return undefined;
    const r = this.d.store.updateTask(id, { status: "queued", error: undefined, resumeAt: undefined });
    setImmediate(() => this.scheduleTasks());
    return r;
  }

  // ---------- queueing ----------

  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }

  // ---------- tasks ----------

  scheduleTasks(): void {
    const now = Date.now();
    const candidates = this.d.store
      .listTasks({ status: ["queued", "paused"], limit: 100 })
      .filter((t) => t.status === "queued" || (t.resumeAt && Date.parse(t.resumeAt) <= now))
      .reverse();
    for (const t of candidates) {
      if (this.runningTasks.size >= MAX_TASK_CONCURRENCY) break;
      if (this.runningTasks.has(t.id)) continue;
      this.runningTasks.add(t.id);
      void this.enqueue(t.conversationId, () => this.runTask(t)).finally(() => {
        this.runningTasks.delete(t.id);
        setImmediate(() => this.scheduleTasks());
      });
    }
  }

  private budgetOk(agent: AgentDef): boolean {
    const day = new Date().toISOString().slice(0, 10);
    const r = this.d.store.db.prepare("select count from usage where day = ? and agent_id = ? and kind = 'background_run'").get(day, agent.id) as { count: number } | undefined;
    return (r?.count ?? 0) < agent.budget.backgroundRunsPerDay;
  }

  private countUsage(agentId: string, kind: string, tokens = 0): void {
    const day = new Date().toISOString().slice(0, 10);
    this.d.store.db
      .prepare("insert into usage(day, agent_id, kind, count, tokens) values (?,?,?,1,?) on conflict(day, agent_id, kind) do update set count = count + 1, tokens = tokens + excluded.tokens")
      .run(day, agentId, kind, tokens);
  }

  private async runTask(task: Task): Promise<void> {
    const fresh = this.d.store.getTask(task.id);
    if (!fresh || !["queued", "paused"].includes(fresh.status)) return;
    const agent = this.d.agents.get(fresh.agentId);
    const conv = this.d.store.getConversation(fresh.conversationId);
    // Asleep in the archive: the task waits for nobody (archiving cancels them; this one came after).
    if (agent && this.d.agents.isArchived(agent.id)) {
      this.d.store.updateTask(fresh.id, { status: "cancelled", error: t("task.agentArchived") });
      return;
    }
    if (!agent || !conv) {
      this.d.store.updateTask(fresh.id, { status: "failed", error: t("task.missingAgent") });
      // The digest's writer cannot run: the hub sends the card now, not after the writer's time is up.
      if (fresh.deliver === "digest") await this.d.notifier.digestWritten(fresh.id, undefined);
      return;
    }
    if (fresh.background && !this.budgetOk(agent)) {
      this.d.store.updateTask(fresh.id, { status: "failed", error: t("task.budgetExhausted") });
      // The card is the answer for the digest: no notice about the budget for the next digest to carry.
      if (fresh.deliver === "digest") {
        await this.d.notifier.digestWritten(fresh.id, undefined);
        return;
      }
      await this.d.notifier.notify({
        level: "digest",
        title: t("notify.budgetTitle", { agent: agentName(agent, hubLocale()) }),
        body: t("notify.budgetBody", { title: fresh.title }),
        agentId: agent.id,
      });
      return;
    }
    if (fresh.background) this.countUsage(agent.id, "background_run");
    this.d.store.updateTask(fresh.id, { status: "running", resumeAt: undefined });

    const history = this.d.store.listMessages(conv.id, { limit: 50 });
    const resumed = fresh.status === "paused" || history.some((m) => m.role === "assistant");
    // What reached the task before it started (its starter's clarifications, the user's words on its page).
    const notes = resumed ? [] : history.slice(1).flatMap((m) => m.parts.flatMap((p) => (p.type === "text" && p.text.trim() ? [p.text.trim()] : [])));
    const sender = fresh.kind === "message" ? this.threadSender(fresh) : undefined;
    // A teammate's thread reads as their message; the reply is the answer.
    const thread = (): string =>
      resumed
        ? "Continue where you stopped; your reply goes back to your teammate."
        : [`Message from your teammate ${sender!.name} (agent "${sender!.id}"). Your reply goes back to them automatically.`, "", fresh.goal, ...notes.flatMap((n) => ["", n])].join("\n");
    const prompt = sender
      ? thread()
      : resumed
        ? "Continue working on the task from where you stopped."
        : [
            `Task: ${fresh.title}`,
            "",
            fresh.goal,
            ...(notes.length ? ["", "Messages that came after the task was created:", ...notes] : []),
            "",
            taskEnding(fresh),
          ].join("\n");

    const r = await this.runTurn(conv, prompt, { task: fresh });
    await this.afterTaskTurn(fresh.id, r);
  }

  /** Where a task stands after a turn: waiting (a limit, an approval, the answer to its question), failed, or done and reported. */
  private async afterTaskTurn(taskId: string, r: TurnResult): Promise<void> {
    const cur = this.d.store.getTask(taskId);
    if (!cur || cur.status === "cancelled") return;
    if (r.limited) {
      this.d.store.updateTask(cur.id, {
        status: "paused",
        resumeAt: r.limited.resetAt ?? new Date(Date.now() + 30 * 60_000).toISOString(),
        error: t("task.limitLater"),
      });
      return;
    }
    if (r.error && !r.text) {
      this.d.store.updateTask(cur.id, { status: "failed", error: r.error });
      // A teammate who cannot answer tells the sender, not the user.
      if (cur.kind === "message") {
        await this.tellStarter(cur, `[System] ${this.agentLabel(cur.agentId)} could not answer your message (thread ${cur.id}): ${r.error}`);
        return;
      }
      // The digest's writer failed: the hub sends the card instead.
      if (cur.deliver === "digest") {
        await this.d.notifier.digestWritten(cur.id, undefined);
        return;
      }
      // A report that did not come is news too; other trigger runs keep quiet about failing.
      if (!cur.background || cur.createdBy !== "trigger" || cur.deliver === "report") {
        const who = this.d.agents.get(cur.agentId);
        const body = humanFailure(r.error, r.errorCode, who ? agentName(who, hubLocale()) : cur.agentId);
        // From a schedule it carries the schedule: the person's feedback on that schedule (muted, less) covers its failures too.
        await this.d.notifier.notify({ level: "notify", title: t("notify.failedTitle", { title: cur.title }), body, agentId: cur.agentId, taskId: cur.id, triggerId: cur.triggerId });
      }
      return;
    }
    if (r.awaitingApproval) {
      this.d.store.updateTask(cur.id, { status: "waiting_approval", result: r.text });
      return;
    }
    if (cur.question) {
      this.d.store.updateTask(cur.id, { status: "waiting_input", result: r.text || cur.result, error: undefined });
      return;
    }
    // A thread's reply, a report and the digest are what the person reads: the final answer, without the narration.
    this.d.store.updateTask(cur.id, { status: "done", result: cur.kind === "message" || cur.deliver ? r.answer || r.text : r.text, error: undefined });
    await this.reportTaskDone(this.d.store.getTask(cur.id)!);
  }

  /**
   * Something for a task (its starter's answer or clarification, the user's words on its page): it joins the running
   * turn, waits for the first turn of a task that has not started, or gives the task another turn.
   */
  async wakeTask(task: Task, text: string, opts: Pick<TurnOpts, "replyChannel" | "quote" | "attachments" | "speech" | "taint" | "fromUser"> = {}): Promise<"steered" | "queued" | "started" | "cancelled"> {
    const cur = this.d.store.getTask(task.id) ?? task;
    if (cur.status === "cancelled") return "cancelled";
    // Outside content stays marked in every session of the task from now on.
    if (opts.taint && !cur.tainted) this.d.store.updateTask(cur.id, { tainted: true });
    if (await this.steerInto(cur.conversationId, text, opts)) return "steered";
    if (cur.status === "queued") return "queued";
    const conv = this.d.store.getConversation(cur.conversationId);
    if (!conv) return "cancelled";
    void this.enqueue(conv.id, async () => {
      const now = this.d.store.getTask(cur.id);
      if (!now || now.status === "cancelled") return;
      this.d.store.updateTask(now.id, { status: "running", resumeAt: undefined, error: undefined });
      const r = await this.runTurn(conv, text, { ...opts, task: now });
      await this.afterTaskTurn(now.id, r);
    });
    return "started";
  }

  /** Who hears from a task: the dialog or task that started it, or, for one the user started, its agent's dialog. */
  private starterOf(task: Task): Conversation | undefined {
    return task.parentConversationId ? this.d.store.getConversation(task.parentConversationId) : this.d.store.agentConversation(task.agentId);
  }

  /**
   * A task's question or result for whoever started it: joins their turn if one is running, else starts one. What a
   * task that read outside content says marks the starter's session too: relaying it does not make it clean.
   */
  private async tellStarter(task: Task, note: string): Promise<void> {
    const parent = this.starterOf(task);
    if (!parent) return;
    this.d.store.addMessage({ conversationId: parent.id, role: "system", parts: [{ type: "text", text: note }], status: "complete", taskId: task.id });
    const taint = this.carriesTaint(task) ? { taint: true } : {};
    const parentTask = parent.taskId ? this.d.store.getTask(parent.taskId) : undefined;
    if (parentTask) {
      await this.wakeTask(parentTask, note, taint);
      return;
    }
    if (parent.kind !== "group" && (await this.steerInto(parent.id, note, taint))) return;
    // In a group chat, the member who wrote to the teammate hears the reply.
    const sender = parent.kind === "group" && task.kind === "message" ? { agentId: this.threadSender(task).id } : {};
    void this.enqueue(parent.id, () => {
      const asked = parent.kind === "group" ? undefined : this.askedFor(parent.id, task);
      return this.runTurn(parent, note, { ...taint, ...sender, ...(asked ? { replyTo: asked } : {}) });
    });
  }

  /** The user's message a task (or a message to a teammate) came from, if the user wrote more since: the report replies to it. */
  private askedFor(conversationId: string, task: Task): { messageId: string; text: string } | undefined {
    const msgs = this.d.store.listMessages(conversationId, { limit: 200 });
    const at = msgs.findLastIndex((m) => m.parts.some((p) => p.type === "task" && p.taskId === task.id));
    const fromUser = (m: Message) => m.role === "user" && !m.agentId;
    const asked = at < 0 ? undefined : msgs.slice(0, at).findLast(fromUser);
    if (!asked || !msgs.slice(at).some(fromUser)) return undefined;
    const said = asked.parts.flatMap((p) => (p.type === "text" ? [p.text] : p.type === "attachment" ? [`📎 ${p.name}`] : [])).join(" ");
    return { messageId: asked.id, text: truncate(said.replace(/\s+/g, " ").trim(), 200) };
  }

  /** For whoever started a task that waits in line for its agent's busy brain: who is busy with what. */
  private queuedNote(task: Task): string {
    const doing = this.d.store
      .listTasks({ status: ["running"], limit: 200 })
      .filter((t) => t.agentId === task.agentId && t.id !== task.id)
      .map((t) => `“${t.title}”`);
    const what = doing.length ? `working on ${doing.slice(0, 3).join(", ")}` : "in another conversation";
    const who = this.agentLabel(task.agentId);
    return task.kind === "message"
      ? `[System] ${who} is busy right now (${what}): your message (thread ${task.id}) waits in line, and they will answer as soon as they are free.`
      : `[System] Task ${task.id} “${task.title}” waits in line: ${who} is busy right now (${what}) and will start it as soon as they are free.`;
  }

  /** The task (or thread) was started or messaged with outside content, or read some itself. */
  private carriesTaint(task: Task): boolean {
    return !!(this.d.store.getTask(task.id) ?? task).tainted || !!this.d.store.activeSession(task.conversationId, task.agentId)?.tainted;
  }

  private markTainted(row: SessionRow): void {
    if (row.tainted) return;
    this.d.store.updateSession(row.id, { tainted: true });
    row.tainted = true;
  }

  private agentLabel(agentId: string): string {
    const a = this.d.agents.get(agentId);
    return a ? agentName(a, hubLocale()) : agentId;
  }

  /** Who opened a teammate's thread: its `from`, else the agent of its first message or of the conversation it came from. */
  private threadSender(task: Task): { id: string; name: string } {
    const id =
      task.from ??
      this.d.store.firstMessage(task.conversationId)?.agentId ??
      (task.parentConversationId ? this.d.store.getConversation(task.parentConversationId)?.agentId : undefined) ??
      task.agentId;
    return { id, name: this.agentLabel(id) };
  }

  /** An agent of the team by id or by name (in any language), "@" or not. */
  private findAgent(ref: string): AgentDef | undefined {
    const key = ref.trim().replace(/^@/, "").toLocaleLowerCase();
    const list = this.d.agents.list();
    return (
      list.find((a) => a.id.toLocaleLowerCase() === key) ??
      list.find((a) => [a.name, ...Object.values(a.i18n ?? {}).map((x) => x?.name)].some((n) => n?.trim().toLocaleLowerCase() === key))
    );
  }

  /** Messages to teammates written from the conversation since the user last wrote there (a teammate writing in a thread is not the user). */
  private teamMessagesSinceUser(conversationId: string): number {
    const msgs = this.d.store.listMessages(conversationId, { limit: 200 });
    const from = msgs.findLastIndex((m) => m.role === "user" && !m.agentId) + 1;
    return msgs.slice(from).reduce((n, m) => n + m.parts.filter((p) => p.type === "task" && p.text !== undefined).length, 0);
  }

  /** The thread this agent has with the teammate from this conversation that a new message continues: open, or answered within the hour. */
  private openThread(conversationId: string, to: string, from: string): Task | undefined {
    return this.d.store
      .listTasks({ limit: 300 })
      .find(
        (t) =>
          t.kind === "message" &&
          t.parentConversationId === conversationId &&
          t.agentId === to &&
          !["cancelled", "failed"].includes(t.status) &&
          (OPEN_TASK.includes(t.status) || Date.now() - Date.parse(t.updatedAt) < THREAD_FRESH_MS) &&
          this.threadSender(t).id === from,
      );
  }

  /**
   * team_message: an agent writes to a teammate, the way a person writes to a colleague. Underneath it is a task of
   * kind "message" (a thread): the teammate answers there, and the reply comes back like a task's result. Writing to
   * the same teammate again continues the thread. Nothing waits for the reply, so agents cannot deadlock each other.
   */
  async messageTeammate(to: string, text: string, from: TeamSender): Promise<{ ok: boolean; text: string }> {
    const agent = this.findAgent(to);
    if (!agent) return { ok: false, text: `No teammate "${to}". The team: ${this.d.agents.list().map((a) => `${a.id} (${agentName(a, hubLocale())})`).join(", ")}.` };
    if (agent.id === from.agentId) return { ok: false, text: "That is you. Write to a teammate, or do it yourself." };
    if (!text.trim()) return { ok: false, text: "Nothing to send: write what you want to say." };
    const sent = this.teamMessagesSinceUser(from.conversationId);
    if (sent >= MAX_TEAM_MESSAGES) {
      return { ok: false, text: `You have written to teammates ${sent} times since the user last wrote here. Stop now and tell the user where things stand; go on when they answer.` };
    }
    const name = agentName(agent, hubLocale());
    const thread = this.openThread(from.conversationId, agent.id, from.agentId);
    let taskId: string;
    if (thread) {
      this.d.store.addMessage({ conversationId: thread.conversationId, role: "user", agentId: from.agentId, parts: [{ type: "text", text }], status: "complete", taskId: thread.id });
      if (thread.question) this.d.store.updateTask(thread.id, { question: undefined });
      const how = await this.wakeTask(thread, `${this.agentLabel(from.agentId)} (your teammate) writes:\n${text}`, from.tainted ? { taint: true } : {});
      if (how === "cancelled") return { ok: false, text: `Your thread with ${name} was cancelled meanwhile. Write again to start a new one.` };
      taskId = thread.id;
    } else {
      if (!from.nest) return { ok: false, text: "Tasks and threads are already nested too deep here: do this part yourself." };
      taskId = this.createTask({
        agentId: agent.id,
        goal: text,
        title: truncate(text.replace(/\s+/g, " ").trim(), 60),
        parentConversationId: from.conversationId,
        parentTaskId: from.taskId,
        background: from.background,
        createdBy: "agent",
        kind: "message",
        tainted: from.tainted,
        from: from.agentId,
      }).id;
    }
    this.attachPart(from.conversationId, { type: "task", taskId, text });
    this.d.audit.append(`agent:${from.agentId}`, "team.message", taskId, { to: agent.id, continued: !!thread });
    return {
      ok: true,
      text:
        `Sent to ${name} (thread ${taskId}${thread ? ", continued" : ""}). Their reply comes back here as a message — into this turn if you are still working. ` +
        "Do not wait for it: carry on, or tell the user in a few words that you asked and end your turn.",
    };
  }

  /** A teammate's reply fills the oldest line in the sender's conversation still waiting for one. */
  private fillReply(task: Task, reply: string): void {
    if (!task.parentConversationId) return;
    for (const m of this.d.store.listMessages(task.parentConversationId, { limit: 100 })) {
      const i = m.parts.findIndex((p) => p.type === "task" && p.taskId === task.id && p.text !== undefined && p.reply === undefined);
      if (i < 0) continue;
      this.d.store.updateMessage(m.id, { parts: m.parts.map((p, j) => (j === i ? { ...p, reply } : p)) });
      return;
    }
  }

  /** task_ask: the question goes to whoever started the task; the task waits for the answer once its turn ends. */
  async askStarter(taskId: string, question: string): Promise<{ ok: boolean; text: string }> {
    const task = this.d.store.getTask(taskId);
    if (!task) return { ok: false, text: "This task no longer exists." };
    const parent = this.starterOf(task);
    if (!parent) return { ok: false, text: "Nobody to ask: the conversation that started this task is gone. Decide yourself, or say what you need in your result." };
    this.d.store.updateTask(task.id, { question });
    const agent = this.d.agents.get(task.agentId);
    const who = agent ? agentName(agent, hubLocale()) : task.agentId;
    await this.tellStarter(
      task,
      [
        `[System] Task ${task.id} “${task.title}” (${who}${this.taskWhere(task)}) asks you: ${question}`,
        `If you know the answer (from this conversation or memory), reply with task_message (taskId "${task.id}"). If only the user can answer, ask them in one short message and pass their answer on with task_message.`,
      ].join("\n"),
    );
    const starter = parent.taskId ? "the task that started yours" : parent.agentId === task.agentId && !task.parentConversationId ? "you, in your dialog with the user" : "the agent that started this task";
    return {
      ok: true,
      text: `Asked ${starter}. Go on with anything that does not depend on the answer; if nothing is left, end your turn: the answer arrives as a message and you continue then.`,
    };
  }

  /** task_message / task_cancel are for whoever started the task (a dialog, a parent task) and for the task's own agent. */
  private mayDirect(task: Task, from: { agentId: string; conversationId: string; taskId?: string }): boolean {
    return task.parentConversationId === from.conversationId || (!!from.taskId && task.parentTaskId === from.taskId) || task.agentId === from.agentId;
  }

  /** task_message: an answer, a clarification or a change of plan for a task, delivered right away. */
  async messageTask(taskId: string, text: string, from: { agentId: string; conversationId: string; taskId?: string; tainted?: boolean }): Promise<{ ok: boolean; text: string }> {
    const task = this.d.store.getTask(taskId);
    if (!task) return { ok: false, text: `No task ${taskId}.` };
    if (!this.mayDirect(task, from)) return { ok: false, text: "You can message only the tasks you started." };
    if (task.status === "cancelled") return { ok: false, text: "That task was cancelled. Start a new one with task_delegate if the work is still needed." };
    const note = `[System] ${this.agentLabel(from.agentId)}, who started this task, writes: ${text}`;
    this.d.store.addMessage({ conversationId: task.conversationId, role: "system", parts: [{ type: "text", text: note }], status: "complete", taskId: task.id });
    if (task.question) this.d.store.updateTask(task.id, { question: undefined });
    const how = await this.wakeTask(task, note, from.tainted ? { taint: true } : {});
    const said = {
      steered: "Delivered: the task is working and takes it at its next step.",
      queued: "Delivered: the task reads it when it starts.",
      started: "Delivered: the task continues with it.",
      cancelled: "The task was cancelled meanwhile.",
    }[how];
    return { ok: how !== "cancelled", text: `${said} Its result will come here as a message.` };
  }

  /** task_cancel from whoever may direct the task. */
  cancelTaskFrom(taskId: string, from: { agentId: string; conversationId: string; taskId?: string }): { ok: boolean; text: string } {
    const task = this.d.store.getTask(taskId);
    if (!task) return { ok: false, text: `No task ${taskId}.` };
    if (!this.mayDirect(task, from)) return { ok: false, text: "You can cancel only the tasks you started." };
    if (["done", "failed", "cancelled"].includes(task.status)) return { ok: true, text: `Task ${task.id} is already ${task.status}.` };
    this.cancelTask(task.id);
    return { ok: true, text: `Task ${task.id} “${task.title}” cancelled.` };
  }

  /** The computers a task can run on: the hub's own first, then the paired ones. */
  computers(): Array<{ id: string; name: string; online: boolean }> {
    return [{ id: "local", name: hubName(), online: true }, ...(this.d.machines?.() ?? []).map((m) => ({ id: m.id, name: m.name, online: m.status === "online" }))];
  }

  /** The id an agent's binding names the hub's own computer by: its replica id in a cluster, else "local". */
  private here(): string {
    return this.d.here?.() ?? "local";
  }

  /** A computer's name for people: the hub's own, a paired machine, or another replica of the hub. */
  computerName(id: string): string {
    return id === "local" || id === this.here() ? hubName() : (this.d.machineName(id) ?? id);
  }

  /** The computers a bound agent works on, by name ("box, vps"). */
  private boundNames(agent: AgentDef): string {
    return (agent.machines ?? []).map((m) => this.computerName(m)).join(", ");
  }

  /** The agent's brains for a kind of work, in order: its own with the pool of machines (expandBrains), on its computers only. */
  private ownBrains(agent: AgentDef, kind: WorkKind, choice: ThinkingChoice): string[] {
    return onMachines(expandBrains(brainsFor(agent, kind, choice), this.d.brains.list().map((b) => b.ref)), agent.machines, this.here());
  }

  /**
   * What the chat says when none of a bound agent's computers can think now: the hub's own always can, a paired machine
   * while it is connected, another replica of the hub never (nothing runs there while this one leads). Undefined when it can.
   */
  private machinesOff(agent: AgentDef): string | undefined {
    if (!bound(agent.machines)) return undefined;
    const online = new Set((this.d.machines?.() ?? []).filter((m) => m.status === "online").map((m) => m.id));
    if (agent.machines.some((m) => m === "local" || m === this.here() || online.has(m))) return undefined;
    return t("chat.machinesOff", { agent: agentName(agent, hubLocale()), machines: this.boundNames(agent), count: agent.machines.length });
  }

  /**
   * task_delegate's `machine`: the agent's brain on that computer (its own entry, or the same kind of brain there), or
   * the agent's usual brain working there through the machine tools when the computer has none.
   */
  placeTask(agentId: string, machine: string): { brainRef?: string; machineName: string; note?: string } | { error: string } {
    const agent = this.d.agents.get(agentId);
    if (!agent) return { error: `No agent ${agentId}.` };
    const list = this.computers();
    const key = machine.trim().toLowerCase();
    const m = list.find((x) => x.id.toLowerCase() === key || x.name.toLowerCase() === key) ?? list.find((x) => x.name.toLowerCase().includes(key));
    if (!m) return { error: `No computer "${machine}". Computers: ${list.map((x) => `${x.name} (${x.id}${x.online ? "" : ", offline"})`).join(", ")}.` };
    if (!onMachine(m.id, agent.machines, this.here())) {
      const names = this.boundNames(agent);
      return { error: `${agentName(agent, hubLocale())} works only on ${names}. Place the task there, or ask the user whether to change the agent's computers.` };
    }
    if (!m.online) return { error: `"${m.name}" is offline right now. Ask the user whether to wait or use another computer.` };
    const refs = agent.brains.map(parseBrainRef);
    const own = refs.find((r) => r.machineId === m.id);
    if (own) return { brainRef: formatBrainRef(own), machineName: m.name };
    for (const r of refs) {
      const there = formatBrainRef({ brainId: r.brainId, variant: r.variant, machineId: m.id });
      if (this.d.brains.has(there)) return { brainRef: there, machineName: m.name };
    }
    return { machineName: m.name, ...(m.id === "local" ? {} : { note: `Work on the computer "${m.name}" (machine id ${m.id}) through the machine_* tools.` }) };
  }

  /** The team and the computers, for a dialog's prompt. */
  private dispatchContext(): NonNullable<Parameters<typeof buildSystemPrompt>[0]["dispatch"]> {
    const computers = this.computers();
    const name = (id: string) => computers.find((c) => c.id === id)?.name ?? this.d.machineName(id) ?? id;
    const brainIds = (refs: string[]) => [...new Set(refs.map((b) => parseBrainRef(b).brainId))];
    const team = this.d.agents.list().map((a) => ({
      id: a.id,
      name: agentName(a, hubLocale()),
      description: a.description,
      where: bound(a.machines) ? a.machines.map((m) => this.computerName(m)) : [...new Set(a.brains.map((b) => name(parseBrainRef(b).machineId)))],
      brains: brainIds(a.brains),
      skills: this.d.skills.ownOf(a.id),
    }));
    // Each kind of brain once: ready when one of them (on any computer) is signed in and answers.
    const listed = this.d.brains.list();
    const brains = brainIds(listed.map((b) => b.ref)).map((id) => {
      const of = listed.filter((b) => b.brainId === id);
      const ready = of.find((b) => b.probe?.available && b.probe.authenticated);
      const probe = (ready ?? of[0])?.probe;
      return { id, label: of[0]?.label ?? id, models: probe?.models ?? [], ready: !!ready };
    });
    return { team, computers, brains };
  }

  /** ", on <computer>" for a task placed on another computer. */
  private taskWhere(task: Task): string {
    const id = task.brainRef ? parseBrainRef(task.brainRef).machineId : "local";
    return id === "local" ? "" : `, on ${this.d.machineName(id) ?? id}`;
  }

  /** The `[Open tasks you started]` lines for a dialog's turns. */
  private openTasks(conversationId: string): string {
    const open = this.d.store.listTasks({ status: OPEN_TASK, limit: 200 }).filter((t) => t.parentConversationId === conversationId);
    if (!open.length) return "";
    const state: Partial<Record<TaskStatus, string>> = { ...TASK_STATE, waiting_input: "waiting for your answer" };
    const lines = open.slice(0, 12).map((t) => {
      const a = this.d.agents.get(t.agentId);
      const asked = t.question ? `; asked you: ${truncate(t.question, 300)}` : "";
      const who = a ? agentName(a, hubLocale()) : t.agentId;
      if (t.kind === "message") return `- ${t.id} your message to ${who} “${t.title}”: ${t.status === "running" ? "answering" : (state[t.status] ?? t.status)}${asked}`;
      return `- ${t.id} “${t.title}” — ${who}${this.taskWhere(t)}: ${state[t.status] ?? t.status}${asked}`;
    });
    return `[Open tasks you started]\n${lines.join("\n")}`;
  }

  private async reportTaskDone(task: Task): Promise<void> {
    const result = taskResult(task);
    if (task.deliver === "report") {
      await this.d.notifier.deliverReport(task);
      return;
    }
    if (task.deliver === "digest") {
      await this.d.notifier.digestWritten(task.id, task.result);
      return;
    }
    // A teammate's reply: under the sender's message line, and to the sender, who carries on with it.
    if (task.kind === "message") {
      this.fillReply(task, truncate(task.result ?? "", 4000));
      await this.tellStarter(task, `[System] ${this.agentLabel(task.agentId)} replied (thread ${task.id}):\n${result}`);
      return;
    }
    if (task.createdBy === "agent" && task.parentConversationId) {
      await this.tellStarter(task, `[System] Task ${task.id} “${task.title}” is finished.\nResult:\n${result}`);
      return;
    }
    if (task.createdBy === "user") {
      await this.d.notifier.notify({ level: "notify", title: t("notify.taskDone", { title: task.title }), body: result, agentId: task.agentId, taskId: task.id });
    }
    // Trigger tasks report through the agent's own notify() call.
  }

  // ---------- deferred approvals ----------

  private async onDeferredApproved(a: Approval): Promise<void> {
    const result = await this.d.gateway.executeApproved(a);
    const conv = this.d.store.getConversation(a.conversationId);
    if (!conv) return;
    const note = `[System] The user approved the action “${a.summary}”. It has been carried out.\nResult${result.isError ? " (error)" : ""}:\n${truncate(resultText(result), 4000)}`;
    this.d.store.addMessage({ conversationId: conv.id, role: "system", parts: [{ type: "text", text: note }], status: "complete", taskId: a.taskId });
    const task = a.taskId ? this.d.store.getTask(a.taskId) : undefined;
    if (task && task.status === "waiting_approval") {
      this.d.store.updateTask(task.id, { status: "running" });
      void this.enqueue(conv.id, async () => {
        const r = await this.runTurn(conv, note, { task });
        await this.afterTaskTurn(task.id, r);
      });
    } else {
      // In a group chat, the member whose action it was carries on.
      void this.enqueue(conv.id, () => this.runTurn(conv, note, conv.kind === "group" ? { agentId: a.agentId } : {}));
    }
  }

  private async onDeferredDenied(a: Approval): Promise<void> {
    const conv = this.d.store.getConversation(a.conversationId);
    if (!conv) return;
    const note = `[System] The user declined the action “${a.summary}”.`;
    this.d.store.addMessage({ conversationId: conv.id, role: "system", parts: [{ type: "text", text: note }], status: "complete", taskId: a.taskId });
    const task = a.taskId ? this.d.store.getTask(a.taskId) : undefined;
    if (task && task.status === "waiting_approval") this.d.store.updateTask(task.id, { status: "done", result: (task.result ?? "") + `\n\n${t("task.declinedSuffix")}` });
  }

  private attachApprovalPart(a: Approval): void {
    // One the person asked for in their own words is a quiet line of what was done, never a card to answer.
    const asked = a.resolvedVia === "request";
    const part: MessagePart = { type: "approval", approvalId: a.id, summary: a.summary, status: asked ? a.status : "pending", ...(a.ask ? { ask: a.ask } : {}), ...(asked ? { asked: true } : {}) };
    const msgId = this.streamingMessage.get(a.conversationId);
    const m = msgId ? this.d.store.getMessage(msgId) : undefined;
    if (m) this.d.store.updateMessage(m.id, { parts: [...m.parts, part] });
    // Asked outside a turn (a replica waiting for the vault key, a card left from before a restart): the card is a
    // message of its own, or the person would only get a reminder without buttons.
    else if (this.d.store.getConversation(a.conversationId)) {
      this.d.store.addMessage({ conversationId: a.conversationId, role: "assistant", agentId: a.agentId, parts: [part], status: "complete" });
    }
    // A task's question for the person also shows where the person is: in the dialog that started it, under the
    // task's line, so they answer without opening the task. A quiet line has nothing to answer: it stays in the task.
    const dialog = asked ? undefined : this.starterDialog(a.taskId);
    if (dialog) this.d.store.addMessage({ conversationId: dialog.id, role: "assistant", agentId: dialog.agentId, parts: [{ type: "task", taskId: a.taskId! }, part], status: "complete" });
  }

  /** A card for this approval is in its conversation or in the dialog that started its task. */
  private hasApprovalPart(a: Approval): boolean {
    const where = [a.conversationId, this.starterDialog(a.taskId)?.id].filter((c): c is string => !!c);
    return where.some((c) => this.d.store.listMessages(c, { limit: 200 }).some((m) => m.parts.some((p) => p.type === "approval" && p.approvalId === a.id)));
  }

  private updateApprovalPart(a: Approval): void {
    const where = [a.conversationId, this.starterDialog(a.taskId)?.id].filter((c): c is string => !!c);
    for (const conversationId of where) {
      for (const m of this.d.store.listMessages(conversationId, { limit: 50 })) {
        if (m.parts.some((p) => p.type === "approval" && p.approvalId === a.id)) {
          this.d.store.updateMessage(m.id, {
            parts: m.parts.map((p) => (p.type === "approval" && p.approvalId === a.id ? { ...p, status: a.status } : p)),
          });
        }
      }
    }
  }

  /** The conversation the person started a task from (through the tasks that started it): a dialog or a group chat. */
  private starterDialog(taskId: string | undefined): Conversation | undefined {
    let task = taskId ? this.d.store.getTask(taskId) : undefined;
    for (let depth = 0; task && depth < 6; depth++) {
      const parent = task.parentConversationId ? this.d.store.getConversation(task.parentConversationId) : undefined;
      if (parent && parent.kind !== "task" && !parent.taskId) return parent;
      task = task.parentTaskId ? this.d.store.getTask(task.parentTaskId) : undefined;
    }
    return undefined;
  }

  // ---------- turns ----------

  workspacePath(s: { agentId: string; taskId?: string; conversationId: string }): string {
    return join(this.d.config.dataDir, "workspaces", s.agentId, this.workspaceKey(s));
  }

  /** A session's folder under its agent's: the task's or the conversation's, a channel's own for every run of it. */
  private workspaceKey(s: { taskId?: string; conversationId: string }): string {
    const feedId = s.taskId ? this.d.store.getTask(s.taskId)?.feedId : undefined;
    return feedId ? `feed-${feedId}` : (s.taskId ?? s.conversationId);
  }

  private limitedUntil(ref: string): string | undefined {
    const r = this.d.store.db.prepare("select until from brain_limits where brain_ref = ?").get(formatBrainRef(parseBrainRef(ref))) as { until: string } | undefined;
    return r && Date.parse(r.until) > Date.now() ? r.until : undefined;
  }

  private setLimited(ref: string, until: string, detail: string): void {
    this.d.store.db
      .prepare("insert into brain_limits(brain_ref, until, detail) values (?,?,?) on conflict(brain_ref) do update set until = excluded.until, detail = excluded.detail")
      .run(formatBrainRef(parseBrainRef(ref)), until, detail);
    this.d.bus.emit("brains.updated", {});
  }

  /** Brains of the agent in preference order that are connected, not rate-limited and not saturated. */
  /** Brains to try, in order; `reasons` explain the skipped ones and `hard` counts skips that waiting won't fix. */
  /** The user changed the agent's brains: its open conversations take the new order from their next turn. */
  brainsChanged(agentId: string): void {
    const at = this.d.settings.getKey<Record<string, string>>(BRAINS_CHANGED_KEY, {});
    this.d.settings.setKey(BRAINS_CHANGED_KEY, { ...at, [agentId]: nowIso() });
  }

  /**
   * The brain a conversation fell back to and stays on, until the user changes the agent's brains after that; never one
   * off the agent's computers.
   */
  private stayOn(agent: AgentDef, prior: SessionRow | undefined): string | undefined {
    const changedAt = this.d.settings.getKey<Record<string, string>>(BRAINS_CHANGED_KEY, {})[agent.id];
    if (!prior || (changedAt && changedAt > prior.createdAt)) return undefined;
    return onMachines([prior.brainRef], agent.machines, this.here()).length ? prior.brainRef : undefined;
  }

  /** `queue`: a task's or thread's turn waits for a busy brain; the user's own conversations are never held up by tasks. */
  private async candidates(agent: AgentDef, preferred?: string, only?: string[], queue = false): Promise<{ usable: string[]; earliestReset?: string; reasons: string[]; hard: number; busy: number; setupOnly: boolean }> {
    const ordered = only ?? (preferred ? [preferred, ...agent.brains.filter((b) => formatBrainRef(parseBrainRef(b)) !== formatBrainRef(parseBrainRef(preferred)))] : agent.brains);
    const usable: string[] = [];
    const reasons: string[] = [];
    let hard = 0;
    let busy = 0;
    // Skips that setting up fixes (not connected, not installed, not signed in), as opposed to limits and load.
    let setup = 0;
    let earliestReset: string | undefined;
    const conc = this.d.settings.get().brainConcurrency;
    for (const ref of ordered) {
      if (!this.d.brains.has(ref)) {
        setup++;
        reasons.push(t("brain.reason.notConnected", { ref }));
        continue;
      }
      const lim = this.limitedUntil(ref);
      if (lim) {
        reasons.push(t("brain.reason.limited", { ref, until: this.formatTime(lim) }));
        if (!earliestReset || lim < earliestReset) earliestReset = lim;
        continue;
      }
      if (queue && (this.brainLoad.get(formatBrainRef(parseBrainRef(ref))) ?? 0) >= conc) {
        busy++;
        reasons.push(t("brain.reason.busy", { ref }));
        continue;
      }
      const p = await this.d.brains.probe(ref);
      if (!p.available || !p.authenticated) {
        hard++;
        setup++;
        reasons.push(p.detail ? t("brain.reason.detail", { ref, detail: p.detail }) : t(p.available ? "brain.reason.notSignedIn" : "brain.reason.unavailable", { ref }));
        continue;
      }
      usable.push(ref);
    }
    return { usable, earliestReset, reasons, hard, busy, setupOnly: ordered.length > 0 && setup === ordered.length };
  }

  /** Resolves when a brain's turn ends, or after `ms`. */
  private brainFreed(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.freed.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.freed.add(done);
    });
  }

  /** Every other brain the hub lists, quickest first: what an agent none of whose own brains is set up thinks with. */
  private otherBrains(order: readonly string[]): string[] {
    return this.d.brains
      .list()
      .map((b) => b.ref)
      .filter((r) => !order.some((o) => sameBrain(o, r)))
      .sort((a, b) => brainSpeed(a) - brainSpeed(b));
  }

  /** One setup card per wait: none while the last one still has no answer after it. */
  private addSetupCard(conversationId: string): void {
    const recent = this.d.store.listMessages(conversationId, { limit: 10 });
    const card = recent.findLastIndex((m) => m.parts.some((p) => p.type === "brain_setup"));
    if (card >= 0 && card > recent.findLastIndex((m) => m.role === "assistant")) return;
    this.d.store.addMessage({ conversationId, role: "system", parts: [{ type: "brain_setup" }], status: "complete" });
  }

  /** A moment in the hub's language and time zone, for messages people read. */
  private formatTime(iso: string): string {
    const d = new Date(iso);
    try {
      return d.toLocaleString(hubLocale(), { timeZone: this.d.settings.get().timezone, dateStyle: "short", timeStyle: "short" });
    } catch {
      return d.toLocaleString(hubLocale());
    }
  }

  /** `fresh`: the session replaces one that cannot be resumed (another brain, no token): its first turn needs the recap. */
  private async openSession(
    conv: Conversation,
    agent: AgentDef,
    brainRef: string,
    task: Task | undefined,
    prior?: SessionRow,
    pick?: Pick<Route, "model" | "effort">,
  ): Promise<{ row: SessionRow; handle: BrainHandle; fresh: boolean }> {
    const background = task?.background ?? false;
    const ref = parseBrainRef(brainRef);
    // How it thinks: what the router chose for this request, else the choice for this kind of work as a model and an
    // effort of this brain.
    const kind = workKind(task);
    const choice = task ? taskThinking(agent, kind, task.thinking) : thinkingFor(agent, kind);
    const probe = await this.d.brains.probe(formatBrainRef(ref)).catch(() => undefined);
    const thinking = pick
      ? { ...(pick.model ? { model: pick.model } : {}), ...(pick.effort ? { effort: pick.effort } : {}), ...(choice.preset ? { preset: choice.preset } : {}) }
      : resolveThinking(choice, formatBrainRef(ref), probe, agent.model);
    const sameBrain = prior && formatBrainRef(parseBrainRef(prior.brainRef)) === formatBrainRef(ref);
    let row: SessionRow;
    let token: string;
    if (sameBrain && prior) {
      row = prior;
      token = this.d.store.rotateSessionToken(prior.id);
    } else {
      if (prior) this.d.store.updateSession(prior.id, { status: "closed" });
      const created = this.d.store.createSession({ conversationId: conv.id, taskId: task?.id, agentId: agent.id, brainRef: formatBrainRef(ref), background, tainted: prior?.tainted });
      row = created.row;
      token = created.token;
    }

    const local = ref.machineId === "local";
    const workspace = local ? this.workspacePath(row) : `${agent.id}/${this.workspaceKey(row)}`;
    if (local) mkdirSync(workspace, { recursive: true });
    const skills = this.d.skills.forAgent(agent, task?.skill);
    let skillsDir: string | undefined;
    if (local && ref.brainId === "claude-code") skillsDir = join(workspace, ".claude", "skills");
    if (local && ref.brainId === "codex") skillsDir = join(workspace, ".agents", "skills");
    if (skillsDir) this.d.skills.materialize(skillsDir, skills);

    const hook = await this.d.hooks.run("session.start", { sessionId: row.id, agentId: agent.id, conversationId: conv.id, taskId: task?.id, background }, (p) => p);
    const appended = hook.results.map((r) => r?.appendSystemPrompt).filter(Boolean) as string[];
    const s = this.d.settings.get();
    const systemPrompt = buildSystemPrompt({
      agent,
      defaultAgent: agent.id === s.defaultAgent,
      timezone: s.timezone,
      language: s.language,
      consoleUrl: this.d.config.consoleUrl,
      task,
      background,
      skills,
      nativeSkills: !!skillsDir,
      appended,
      machine: { name: this.computerName(ref.machineId), local },
      setup: background || task ? undefined : await this.d.setup?.promptBlock(agent.id),
      group: conv.kind === "group" ? { title: conv.title, members: this.groupMembers(conv) } : undefined,
      dispatch: conv.kind === "main" && !task && !background ? this.dispatchContext() : undefined,
      thread: task?.kind === "message" ? this.threadSender(task) : undefined,
      making: conv.kind === "setup" && conv.purpose ? { purpose: conv.purpose, ...(conv.entity ? { entity: conv.entity } : {}) } : undefined,
      thinking: { brain: this.d.brains.list().find((b) => b.ref === formatBrainRef(ref))?.label ?? formatBrainRef(ref), kind, ...thinking },
    });

    const env: Record<string, string> = {};
    if (local) {
      this.d.egress.revokeOwner(`brain:${row.id}`);
      const proxyToken = this.d.egress.issueToken(`brain:${row.id}`, DEFAULT_BRAIN_EGRESS);
      const proxy = `http://${proxyToken}:x@127.0.0.1:${this.d.config.egressPort}`;
      Object.assign(env, { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1" });
    }

    const resume = sameBrain ? prior?.resumeToken : undefined;
    const handle = await this.d.brains.create(formatBrainRef(ref), {
      sessionId: row.id,
      agent,
      variant: ref.variant,
      ...(thinking.model ? { model: thinking.model } : {}),
      ...(thinking.effort ? { effort: thinking.effort } : {}),
      workspace,
      mcp: {
        url: `${local ? this.d.config.internalUrl : this.d.config.publicUrl}/mcp`,
        token,
        bridgeCommand: local ? [process.execPath, "--disable-warning=ExperimentalWarning", join(this.d.config.appRoot, "packages", "mcp-bridge", "src", "index.ts")] : [],
      },
      systemPrompt,
      skillsDir,
      claudePluginDirs: local && ref.brainId === "claude-code" ? this.d.claudePluginDirs() : [],
      resume,
      env,
      background,
      // A dialog the person talks in keeps its brain's process between turns (warm()), and is a front desk: its
      // brain only looks; commands and file changes go to tasks.
      ...(warmable(conv, task) ? { keepWarm: true } : {}),
      ...(!task && !conv.taskId && conv.kind !== "task" ? { frontDesk: true } : {}),
      // The brain's own shell and file tools stay in its folder; the rest it asks for (native-permissions.ts).
      ...(local && this.d.config.sandboxBrains
        ? { confine: { ...confinement(this.d.config.dataDir, workspace, local && ref.brainId === "claude-code" ? this.d.claudePluginDirs() : []), permissionTool: NATIVE_PERMISSION_TOOL } }
        : {}),
    });
    this.live.set(row.id, { handle, brainRef: formatBrainRef(ref), stamp: sessionStamp(agent, conv, kind, this.d.toolNames?.()), ...(thinking.model ? { model: thinking.model } : {}), ...(thinking.effort ? { effort: thinking.effort } : {}) });
    if (!sameBrain) this.d.audit.append("core", "session.open", row.id, { agent: agent.id, brain: formatBrainRef(ref), conversation: conv.id, task: task?.id });
    return { row, handle, fresh: !!prior && !resume };
  }

  /** The reply has a message to a teammate in it. */
  private wroteToTeammate(messageId: string | undefined): boolean {
    return !!messageId && !!this.d.store.getMessage(messageId)?.parts.some((p) => p.type === "task" && p.text !== undefined);
  }

  /**
   * The cards the hub delivered in a dialog since its agent's last reply (continuity.ts), as the note for its next turn,
   * and whether one of them came from outside content: then the session is marked before it reads them, as for a
   * tainted task's result relayed to its starter.
   */
  private deliveredSince(conversationId: string): { text: string; outside: boolean } | undefined {
    const timezone = this.d.settings.get().timezone;
    const cards = delivered(this.d.store.listMessages(conversationId, { limit: 60 }));
    const note = deliveredNote(cards, { at: (m) => clockTime(m.createdAt, timezone), outside: (m, p) => this.cardFromOutside(m, p) });
    return note && { ...note, text: this.d.redactor.text(note.text) };
  }

  /**
   * Whether a card the hub delivered came from outside content: the digest (its writer reads the channels' posts and
   * runs tainted), or one from a task or conversation that read some (a report run that browsed, a check's alert).
   */
  private cardFromOutside(m: Message, p: NotificationPart): boolean {
    if (cardKind(p) === "digest") return true;
    const n = p.notificationId ? this.d.notifier.get(p.notificationId) : undefined;
    const taskId = m.taskId ?? n?.taskId;
    const task = taskId ? this.d.store.getTask(taskId) : undefined;
    // A task that is gone cannot say it read nothing.
    if (taskId && !task) return true;
    if (task?.tainted) return true;
    const where = task?.conversationId ?? n?.conversationId;
    return !!where && this.d.store.conversationTainted(where);
  }

  /**
   * What came before in a conversation, for a fresh session of `agent` there (continuity.ts): undefined when the agent
   * has not replied there yet. A card from outside content keeps its text out of the recap of a session that has not
   * read any (`tainted`): it is only named there.
   */
  private recapOf(conversationId: string, agent: AgentDef, tainted = false): string | undefined {
    const msgs = this.d.store.listMessages(conversationId, { limit: 160 });
    // In a group chat every member speaks under its own name.
    const group = this.d.store.getConversation(conversationId)?.kind === "group";
    const speaker = (m: Message) => {
      // A teammate writing in a thread.
      if (m.role === "user" && m.agentId) return this.agentLabel(m.agentId);
      if (m.role !== "assistant") return m.role === "user" ? "User" : "System";
      if (!m.agentId || m.agentId === agent.id) return "You";
      const a = this.d.agents.get(m.agentId);
      return a ? agentName(a, hubLocale()) : group ? m.agentId : "Assistant";
    };
    const first = this.d.store.firstMessage(conversationId);
    const r = recap(msgs, {
      speaker,
      self: agentName(agent, hubLocale()),
      ...(first && first.id !== msgs[0]?.id ? { first } : {}),
      ...(tainted ? {} : { cardBody: (m: Message, p: NotificationPart) => !this.cardFromOutside(m, p) }),
    });
    return r && this.d.redactor.text(r);
  }

  /**
   * The brains in the order a request should take them, each with the model and effort that fit it (model-router.ts),
   * or none when the choice is the person's exact model and effort. What it needs comes from the choice's preset
   * ("auto": the kind of work and, in a dialog, the message); what it is about from the task (or its goal's words).
   * Work on code needs a brain with its own hands. A brain the choice names comes first.
   */
  private async routeFor(agent: AgentDef, kind: WorkKind, choice: ThinkingChoice, text: string, task: Task | undefined): Promise<Route[]> {
    // The person's exact model and effort, or an agent from before `thinking` with its one model: as they chose.
    if (choice.model || choice.effort || (!choice.preset && agent.model)) return [];
    const need = needOf(choice.preset, kind, task ? task.goal : text);
    const skill = choice.skill ?? (task && kind === "task" ? skillOfGoal(task.goal) : undefined);
    const refs = this.ownBrains(agent, kind, choice);
    const brains = await Promise.all(refs.map(async (ref) => ({ ref, probe: this.d.brains.has(ref) ? await this.d.brains.probe(ref, 10 * 60_000).catch(() => undefined) : undefined })));
    const routes = route(brains, { need, ...(skill ? { skill } : {}), hands: !!task && skill === "code" });
    if (!choice.brain) return routes;
    const named = (r: Route) => (choice.brain!.includes("@") ? sameBrain(r.ref, choice.brain!) : parseBrainRef(r.ref).brainId === choice.brain || r.ref.split("@")[0] === choice.brain);
    return [...routes.filter(named), ...routes.filter((r) => !named(r))];
  }

  /**
   * The person opened a dialog or is typing in it: the session its next turn would use is opened and its brain gets
   * ready (a CLI starts and waits), so the reply does not wait for that. Nothing happens while a turn runs there, for
   * group chats and tasks, or when no brain of the agent can take a turn now. Never fails.
   */
  async warm(conversationId: string): Promise<boolean> {
    const conv = this.d.store.getConversation(conversationId);
    if (!conv || !warmable(conv) || this.turning.get(conv.id) || this.warming.has(conv.id)) return false;
    const agent = this.d.agents.get(conv.agentId);
    if (!agent) return false;
    const job = (async () => {
      const prior = this.d.store.activeSession(conv.id, agent.id);
      const stay = this.stayOn(agent, prior);
      // The brain the person's next message would most likely take: the front desk's.
      const choice = thinkingFor(agent, "chat");
      const routes = await this.routeFor(agent, "chat", choice, "", undefined);
      const order = this.ownBrains(agent, "chat", choice);
      let { usable, setupOnly } = await this.candidates({ ...agent, brains: order }, choice.brain ? undefined : stay);
      if (!usable.length && setupOnly && !bound(agent.machines)) ({ usable } = await this.candidates({ ...agent, brains: [...order, ...this.otherBrains(order)] }));
      const ref = usable[0];
      if (!ref) return false;
      const key = formatBrainRef(parseBrainRef(ref));
      let live = prior ? this.live.get(prior.id) : undefined;
      if (!live || live.brainRef !== key || live.stamp !== sessionStamp(agent, conv, "chat", this.d.toolNames?.())) {
        if (live && prior) {
          if (live.brainRef === key) await this.closeLive(prior.id);
          else void this.closeLive(prior.id);
        }
        const opened = await this.openSession(conv, agent, ref, undefined, prior, routes.find((r) => sameBrain(r.ref, ref)));
        if (opened.fresh) this.freshAhead.add(opened.row.id);
        live = this.live.get(opened.row.id)!;
      }
      await live.handle.warm();
      return true;
    })().catch(() => false);
    this.warming.set(conv.id, job);
    try {
      return await job;
    } finally {
      this.warming.delete(conv.id);
    }
  }

  async runTurn(conv: Conversation, prompt: string, opts: TurnOpts): Promise<TurnResult> {
    this.setTurning(conv.id, 1);
    try {
      return await this.turn(conv, prompt, opts);
    } finally {
      this.setTurning(conv.id, -1);
    }
  }

  /**
   * Where a finished reply goes besides the web UI: back to the channel the message came from; or, in the default
   * agent's dialog, to every channel, so the user follows the main agent on the phone too (setting channelMirror).
   */
  /** Returns true when the reply went to every channel (the mirror). */
  private async deliver(conv: Conversation, text: string, opts: TurnOpts, messageId?: string): Promise<boolean> {
    const ch = opts.replyChannel;
    const toChannel = !!ch && ch !== WEB_CHANNEL;
    // Typed in the web UI, or a turn nobody typed (a task finished, a system note): only the default agent's dialog is mirrored.
    const s = this.d.settings.get();
    const mirror = conv.kind === "main" && conv.agentId === s.defaultAgent && s.channelMirror !== false && this.d.channels.list().length > 0;
    if (toChannel ? !this.d.channels.has(ch) : !mirror) return false;
    const media = await this.replyMedia(messageId);
    if (!text && !media.length) return !toChannel;
    const path = conv.kind === "main" ? `agent/${encodeURIComponent(conv.agentId)}` : conv.taskId ? `tasks/${encodeURIComponent(conv.taskId)}` : `chat/${encodeURIComponent(conv.id)}`;
    const reply: OutboundMessage = { kind: "reply", text, conversationId: conv.id, link: `${this.d.config.publicUrl}/${path}`, ...(media.length ? { media } : {}) };
    if (toChannel) await this.d.channels.send(ch, reply);
    else await this.d.channels.broadcast(opts.quote ? { ...reply, quote: opts.quote } : reply);
    return !toChannel;
  }

  /** Blocks plugins add before a turn's input (turn.context hook), or undefined. Never fails the turn. */
  private async turnContext(row: SessionRow, conv: Conversation, agent: AgentDef, task: Task | undefined, prompt: string, opts: Pick<TurnOpts, "fromUser">): Promise<string | undefined> {
    try {
      const r = await this.d.hooks.run(
        "turn.context",
        { sessionId: row.id, agentId: agent.id, conversationId: conv.id, taskId: task?.id, background: !!task?.background, text: prompt, fromUser: !!opts.fromUser },
        (p) => p,
      );
      const blocks = r.results.map((x) => (typeof x?.context === "string" ? x.context.trim() : "")).filter(Boolean);
      return blocks.length ? this.d.redactor.text(truncate(blocks.join("\n\n"), MAX_TURN_CONTEXT)) : undefined;
    } catch {
      return undefined;
    }
  }

  /** What the brain gets for a turn (or as input joining one): the text with its files' note and the current time. */
  private turnInput(row: SessionRow, text: string, opts: Pick<TurnOpts, "attachments" | "speech">): BrainTurn {
    let paths: string[] = [];
    if (opts.attachments?.length) {
      const local = parseBrainRef(row.brainRef).machineId === "local";
      const seen = local ? forSession(opts.attachments, join(this.d.config.dataDir, "workspaces"), this.workspacePath(row)) : opts.attachments.map((part): SessionFile => ({ part }));
      const files = seen.map((f) => (opts.speech?.[f.part.path] ? { ...f, speech: opts.speech[f.part.path] } : f));
      text = [text, attachmentNote(files, { remote: !local })].filter(Boolean).join("\n\n");
      paths = files.flatMap((f) => (f.path ? [f.path] : []));
    }
    // Where the agent is and what it and its team are doing, when that changed since this session last heard it.
    const self = this.situationOf(row);
    if (self && self !== this.seen.get(row.id)) {
      this.seen.set(row.id, self);
      text = `${self}\n\n${text}`;
    }
    const now = this.clock.line(row.id, this.d.settings.get().timezone);
    if (now) text = `${now}\n${text}`;
    return { text, ...(paths.length ? { attachments: paths } : {}) };
  }

  /** The `[You now]` block for a session's next turn (situation.ts). */
  private situationOf(row: SessionRow): string | undefined {
    const conv = this.d.store.getConversation(row.conversationId);
    if (!conv) return undefined;
    const task = row.taskId ? this.d.store.getTask(row.taskId) : undefined;
    const machineId = parseBrainRef(row.brainRef).machineId;
    const timezone = this.d.settings.get().timezone;
    const user = this.d.locations?.line((iso) => clockTime(iso, timezone));
    return situation({
      ...this.teamFacts(),
      ...(user ? { user } : {}),
      agentId: row.agentId,
      session: {
        kind: task?.kind === "message" ? "thread" : task ? "task" : conv.kind === "group" ? "group" : "dialog",
        conversationId: conv.id,
        machine: this.computerName(machineId),
        local: machineId === "local",
        ...(task ? { task } : {}),
        ...(conv.kind === "group" ? { groupTitle: conv.title } : {}),
      },
    });
  }

  /** What every agent is busy with now, for situation.ts and task_agents. */
  private teamFacts() {
    const timezone = this.d.settings.get().timezone;
    return {
      team: this.d.agents.list().map((a) => ({ id: a.id, name: agentName(a, hubLocale()) })),
      tasks: this.d.store.listTasks({ status: OPEN_TASK, limit: 200 }),
      activity: this.d.activity?.view() ?? [{ id: "local", name: hubName(), online: true, work: [] }],
      starter: (t: Task) => this.startedBy(t),
      machineOf: (t: Task) => this.computerName(this.taskMachine(t)),
      time: (iso: string) => clockTime(iso, timezone),
    };
  }

  /** "Owl: free" / "Coder: t_1 “Fix the build”: …" for each agent, as task_agents lists them. */
  teamNow(): string[] {
    const f = this.teamFacts();
    const name = (id: string) => f.team.find((a) => a.id === id)?.name ?? id;
    return f.team.map((a) => `- ${a.id} (${a.name}): ${busy(f, a.id, name)}`);
  }

  /** The agent who started a task: a thread's sender, the agent of the task or the conversation it came from. */
  private startedBy(t: Task): string | undefined {
    if (t.kind === "message") return t.from;
    if (t.parentTaskId) return this.d.store.getTask(t.parentTaskId)?.agentId;
    return t.parentConversationId ? this.d.store.getConversation(t.parentConversationId)?.agentId : undefined;
  }

  /** The computer a task runs on: where it was placed, its session's brain, or its agent's first brain. */
  private taskMachine(t: Task): string {
    const ref = t.brainRef ?? this.d.store.activeSession(t.conversationId, t.agentId)?.brainRef ?? this.d.agents.get(t.agentId)?.brains[0];
    return ref ? parseBrainRef(ref).machineId : "local";
  }

  /** The reply's images and maps for the channels: web images by address, workspace files inline (10 MB each, 40 MB in all). */
  private async replyMedia(messageId: string | undefined): Promise<OutboundMedia[]> {
    const parts = (messageId ? this.d.store.getMessage(messageId)?.parts : undefined) ?? [];
    const out: OutboundMedia[] = [];
    let inline = 0;
    for (const p of parts) {
      if (p.type === "map") out.push({ kind: "map", lat: p.lat, lon: p.lon, ...(p.title ? { title: p.title } : {}) });
      if (p.type !== "images") continue;
      for (const it of p.items) {
        const caption = it.caption ? { caption: it.caption } : {};
        if (/^https?:\/\//i.test(it.src)) {
          out.push({ kind: "image", url: it.src, ...caption });
          continue;
        }
        if (!it.src.startsWith("file:")) continue;
        const file = await readWorkspaceImage(join(this.d.config.dataDir, "workspaces"), it.src.slice("file:".length));
        if (!file || inline + file.data.length > MAX_INLINE_MEDIA_BYTES) continue;
        inline += file.data.length;
        out.push({ kind: "image", data: file.data.toString("base64"), mimeType: file.type, name: file.name, ...caption });
      }
    }
    return out;
  }

  private async turn(conv: Conversation, prompt: string, opts: TurnOpts): Promise<TurnResult> {
    const agent = this.d.agents.get(opts.agentId ?? conv.agentId) ?? this.d.agents.get(this.d.settings.get().defaultAgent)!;
    const task = opts.task ?? (conv.taskId ? this.d.store.getTask(conv.taskId) : undefined);
    // An agent bound to computers none of which is online: the chat says so, and the message stays for later.
    const off = this.machinesOff(agent);
    if (off) {
      this.d.store.addMessage({ conversationId: conv.id, role: "system", parts: [{ type: "error", message: off }], status: "complete", taskId: task?.id });
      return { text: "", error: off, awaitingApproval: false };
    }
    const prior = this.d.store.activeSession(conv.id, agent.id);
    const stay = this.stayOn(agent, prior);
    const tried = new Set<string>();
    // The session starts without the history (another brain, or none to resume): its first turn gets the recap.
    let fresh = false;
    let lastError = "";
    const kind = workKind(task);
    let earliestReset: string | undefined;

    // A task placed on a computer runs on the brain there or not at all (unless the agent was bound elsewhere since).
    const pinned = task?.brainRef && onMachines([task.brainRef], agent.machines, this.here()).length ? [task.brainRef] : undefined;
    // Under the hood: the brains in the order this request should take them, each with its model and effort
    // (model-router.ts). An exact model and effort the person chose take the agent's own order instead.
    const choice = task ? taskThinking(agent, kind, task.thinking) : thinkingFor(agent, kind);
    const routes = await this.routeFor(agent, kind, choice, prompt, task);
    // A dialog stays with the agent's own brain (its chosen one, else its first): the router picks the model and
    // effort there, and other brains only take over when that one cannot. Work on the side goes where it fits best.
    const own = this.ownBrains(agent, kind, choice);
    let order = routes.length && task ? routes.map((r) => r.ref) : own;
    let widened = false;
    // The brain the person chose for this kind comes before the one the conversation fell back to.
    const preferred = choice.brain ? undefined : stay;
    let waits = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      const { usable, earliestReset: reset, reasons, hard, busy, setupOnly } = await this.candidates({ ...agent, brains: order }, preferred, pinned, !!task);
      earliestReset = reset ?? earliestReset;
      const ref = usable.find((r) => !tried.has(formatBrainRef(parseBrainRef(r))));
      // The agent's brains are busy with other turns (a teammate wrote while it works): the turn waits in line.
      if (!ref && busy) {
        // Still waiting after a few seconds: whoever started it hears that the agent is busy and will get to it.
        if (waits === 1 && task?.createdBy === "agent") void this.tellStarter(task, this.queuedNote(task));
        await this.brainFreed(waits++ ? 30_000 : 3_000);
        if (task && this.d.store.getTask(task.id)?.status === "cancelled") return { text: "", error: t("chat.cannotStart", { agent: agentName(agent, hubLocale()), reason: reasons.join("; ") }), awaitingApproval: false };
        attempt--;
        continue;
      }
      // None of the agent's own brains is set up, but the hub has others: it thinks with those (not one bound to computers).
      if (!ref && setupOnly && !tried.size && !pinned && !widened && !bound(agent.machines)) {
        widened = true;
        const rest = this.otherBrains(order);
        if (rest.length) {
          order = [...order, ...rest];
          attempt--;
          continue;
        }
      }
      // No brain of the agent is set up yet: the setup card instead of an error, and the message waits for a brain.
      // (A group chat's round goes on with the next member instead.)
      if (!ref && setupOnly && !tried.size && !task && this.d.setup && conv.kind !== "group" && onMachine("local", agent.machines, this.here())) {
        this.d.setup.hold(conv.id, agent.id, prompt, { replyChannel: opts.replyChannel, quote: opts.quote, attachments: opts.attachments, speech: opts.speech });
        this.addSetupCard(conv.id);
        return { text: "", error: t("chat.needsBrain"), awaitingApproval: false };
      }
      if (!ref) {
        const why = reasons.length ? reasons.join("; ") : lastError || (bound(agent.machines) ? t("chat.noBrainOn", { machines: this.boundNames(agent) }) : t("chat.noSuitableBrains"));
        const allLimited = earliestReset && usable.length === 0 && hard === 0;
        const message = allLimited
          ? t("chat.allLimited", { time: this.formatTime(earliestReset!) })
          : t("chat.cannotStart", { agent: agentName(agent, hubLocale()), reason: why });
        this.d.store.addMessage({ conversationId: conv.id, role: "system", parts: [{ type: "error", message }], status: "complete", taskId: task?.id });
        return { text: "", error: message, ...(setupOnly && !allLimited ? { errorCode: "no-brain" as const } : {}), limited: allLimited ? { resetAt: earliestReset } : undefined, awaitingApproval: false };
      }
      const key = formatBrainRef(parseBrainRef(ref));
      tried.add(key);

      // A session being opened ahead of this turn (warm()) is the one to use.
      await this.warming.get(conv.id);
      const curPrior = this.d.store.activeSession(conv.id, agent.id);
      let live = curPrior ? this.live.get(curPrior.id) : undefined;
      let row = curPrior;
      // Opened ahead without the history: this first turn still gets the recap.
      if (curPrior && this.freshAhead.delete(curPrior.id)) fresh = true;
      try {
        if (!live || live.brainRef !== key || live.stamp !== sessionStamp(agent, conv, kind, this.d.toolNames?.())) {
          // The same brain resumes the same conversation with the new instructions: let the old process finish first.
          if (live && curPrior) {
            if (live.brainRef === key) await this.closeLive(curPrior.id);
            else void this.closeLive(curPrior.id);
          }
          const opened = await this.openSession(conv, agent, ref, task, curPrior, routes.find((r) => sameBrain(r.ref, ref)));
          row = opened.row;
          live = this.live.get(row.id)!;
          fresh = opened.fresh;
        }
      } catch (e: any) {
        lastError = `${ref}: ${e.message}`;
        this.d.brains.invalidate(ref);
        continue;
      }
      // What the hub said in the dialog in the agent's name since its last reply: the person may be answering it.
      const said = conv.kind === "main" && !task ? this.deliveredSince(conv.id) : undefined;
      // Outside content in this turn's input, or a task started with some: the session is marked before the brain reads it.
      if (opts.taint || task?.tainted || said?.outside) this.markTainted(row!);

      let text = said ? `${said.text}\n\n${prompt}` : prompt;
      // A session that resumes gets the recap too, for the brain to start afresh with if it cannot (BrainTurn.recap).
      const seed = fresh || row!.resumeToken ? this.recapOf(conv.id, agent, row!.tainted) : undefined;
      if (conv.kind === "group") {
        text = this.groupText(conv, agent, prompt, opts, fresh);
      } else if (fresh && seed) {
        text = `${seed}\n\n---\n${text}`;
      }
      const backup = !fresh && seed ? { recap: seed } : {};
      fresh = false;
      // The dialog's agent sees the tasks it started that are still going, whatever this turn is about.
      if (conv.kind === "main" && !task) {
        const open = this.openTasks(conv.id);
        if (open) text = `${open}\n\n${text}`;
      }

      // What plugins add for this turn only (the memories that matter now), before the input.
      const extra = await this.turnContext(row!, conv, agent, task, prompt, opts);
      if (extra) text = `${extra}\n\n${text}`;

      this.brainLoad.set(key, (this.brainLoad.get(key) ?? 0) + 1);
      try {
        // How this turn thinks: the route's model and effort on the brain that takes it (it switches if it can).
        const pick = routes.find((r) => sameBrain(r.ref, key));
        const thinks = { ...(pick?.model ? { model: pick.model } : {}), ...(pick?.effort ? { effort: pick.effort } : {}) };
        const input = this.turnInput(row!, text, opts);
        // A live session that thinks with another model now hears it was the hub's doing, not something to remark on.
        if (pick?.model && live!.model && live!.model !== pick.model) input.text = input.text.replace(/^(\[Now: [^\]]*\]\n)?/, (now) => `${now}${MODEL_SWITCH_NOTE}\n`);
        if (pick?.model) live!.model = pick.model;
        if (pick?.effort) live!.effort = pick.effort;
        const r = await this.streamTurn(conv, row!, live!, agent, { ...input, ...backup, ...thinks }, task, opts.replyChannel, opts.replyTo);
        if (r.retry) {
          lastError = r.error ?? lastError;
          if (r.limited) earliestReset = r.limited.resetAt ?? earliestReset;
          void this.closeLive(row!.id);
          continue;
        }
        // Group chats live in the web UI only. A turn nobody typed that wrote to a teammate again is agents talking
        // among themselves: the phone gets the outcome, not that.
        const chatter = !opts.replyChannel && opts.quote === undefined && this.wroteToTeammate(r.messageId);
        if (conv.kind !== "group" && !chatter) {
          const broadcast = await this.deliver(conv, r.answer ?? r.text, opts, r.messageId);
          // Messages from other channels joined the turn: those channels get the reply too (unless all of them did).
          if (!broadcast) for (const ch of r.channels ?? []) if (ch !== opts.replyChannel) await this.deliver(conv, r.answer ?? r.text, { replyChannel: ch }, r.messageId);
        }
        return r;
      } finally {
        this.brainLoad.set(key, Math.max(0, (this.brainLoad.get(key) ?? 1) - 1));
        for (const wake of [...this.freed]) wake();
      }
    }
    return { text: "", error: lastError || t("chat.turnFailed"), awaitingApproval: false };
  }

  private async streamTurn(
    conv: Conversation,
    row: SessionRow,
    live: Live,
    agent: AgentDef,
    turn: BrainTurn,
    task: Task | undefined,
    replyChannel?: string,
    replyTo?: TurnOpts["replyTo"],
  ): Promise<TurnResult & { retry?: boolean }> {
    // How it thinks for this reply: the model asked for (the one that answers replaces it when the brain says) and the effort.
    let model = turn.model ?? live.model;
    const effort = turn.effort ?? live.effort;
    const newMessage = (parts: MessagePart[] = []) =>
      this.d.store.addMessage({
        conversationId: conv.id,
        role: "assistant",
        parts,
        status: "streaming",
        agentId: agent.id,
        taskId: task?.id,
        brainRef: live.brainRef,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        channel: replyChannel,
      });
    // The reply's first message shows which of the user's messages it answers.
    const answers: MessagePart[] = replyTo ? [{ type: "reply_to", ...replyTo }] : [];
    let msg = newMessage(answers);
    const turnKey = msg.id;
    this.streamingMessage.set(conv.id, msg.id);
    const activity = this.d.activity;
    activity?.start(turnKey, {
      brainRef: live.brainRef,
      agentId: agent.id,
      conversationId: conv.id,
      taskId: task?.id,
      title: task ? task.title : conv.kind === "group" ? conv.title : undefined,
    });

    let parts: MessagePart[] = [...answers];
    let fullText = "";
    let lastFlush = 0;
    let produced = false;
    let error: string | undefined;
    let fatal = false;
    let limited: { resetAt?: string } | undefined;
    let resumeToken: string | undefined;
    let awaitingApproval = false;
    let tokens = 0;

    const current = () => this.d.store.getMessage(msg.id)?.parts ?? parts;
    const flush = (force = false) => {
      const now = Date.now();
      if (!force && now - lastFlush < 400) return;
      lastFlush = now;
      // Keep cards (approvals, secret requests, setup) that were attached or updated concurrently.
      parts = mergeAttached(parts, current());
      this.d.store.updateMessage(msg.id, { parts }, force);
    };
    const channels = new Set<string>();
    this.activeTurns.set(conv.id, {
      sessionId: row.id,
      handle: live.handle,
      row,
      channels,
      split: () => {
        parts = mergeAttached(parts, current());
        this.d.store.updateMessage(msg.id, { parts, status: "complete" });
        msg = newMessage();
        this.streamingMessage.set(conv.id, msg.id);
        parts = [];
        lastFlush = 0;
      },
    });

    const onEvent = (e: BrainEvent) => {
      switch (e.type) {
        case "text": {
          const delta = this.d.redactor.text(e.delta);
          produced = true;
          fullText += delta;
          const last = parts[parts.length - 1];
          if (last && last.type === "text") parts[parts.length - 1] = { type: "text", text: last.text + delta };
          else parts.push({ type: "text", text: delta });
          this.d.bus.emit("message.delta", { id: msg.id, conversationId: conv.id, delta });
          activity?.step(turnKey, "writing");
          flush();
          break;
        }
        case "tool_call": {
          produced = true;
          parts.push({ type: "tool_call", id: e.id, name: e.name, input: this.d.redactor.value(e.input) });
          // The brain's own tools (its shell, files, web) never pass the gateway: the security log gets them here.
          if (!this.d.gateway.has(e.name)) this.d.audit.append(`agent:${agent.id}`, "brain.tool", e.name, { sessionId: row.id, input: truncateInput(this.d.redactor.value(e.input)) });
          if (NATIVE_SOURCE_TOOLS.test(e.name) && !row.tainted) {
            this.d.store.updateSession(row.id, { tainted: true });
            row.tainted = true;
          }
          activity?.step(turnKey, stepOfTool(e.name), detailOfTool(e.name, this.d.redactor.value(e.input)));
          flush(true);
          break;
        }
        case "tool_result": {
          const out = this.d.redactor.text(e.output);
          if (/awaiting_approval/.test(out)) awaitingApproval = true;
          parts.push({ type: "tool_result", id: e.id, output: truncate(out, 4000), isError: e.isError });
          activity?.step(turnKey, "thinking");
          flush(true);
          break;
        }
        case "usage":
          tokens += (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
          break;
        case "model":
          if (e.model && e.model !== model) {
            model = e.model;
            this.d.store.updateMessage(msg.id, { model });
          }
          break;
        case "limit_hit":
          limited = { resetAt: e.resetAt };
          error = t("brain.limitDetail", { detail: e.detail ?? "" });
          break;
        case "error":
          error = e.message;
          if (e.fatal) fatal = true;
          break;
        case "done":
          resumeToken = e.resumeToken;
          break;
      }
    };

    try {
      await live.handle.send(turn, onEvent);
    } catch (e: any) {
      error = e.message;
      fatal = true;
    } finally {
      this.activeTurns.delete(conv.id);
      this.streamingMessage.delete(conv.id);
      activity?.end(turnKey);
    }

    if (resumeToken) this.d.store.updateSession(row.id, { resumeToken });
    this.countUsage(agent.id, "turn", tokens);

    // Pending approvals from this session also mean we are waiting.
    if (!awaitingApproval) {
      awaitingApproval = !!this.d.store.db.prepare("select 1 from approvals where session_id = ? and status = 'pending' limit 1").get(row.id);
    }

    if (limited) {
      this.setLimited(live.brainRef, limited.resetAt ?? new Date(Date.now() + 60 * 60_000).toISOString(), error ?? "limit");
    }

    // Nothing produced and the brain failed or is limited: let the caller try the next brain.
    if (!produced && (limited || fatal)) {
      this.d.store.updateMessage(msg.id, { parts: [{ type: "error", message: t("chat.tryingOtherBrain", { ref: live.brainRef, error: error ?? t("chat.error") }) }], status: "error" });
      if (fatal && !limited) this.d.brains.invalidate(live.brainRef);
      return { text: "", error, limited, awaitingApproval: false, retry: true };
    }

    if (error) parts.push({ type: "error", message: error });
    parts = mergeAttached(parts, current());
    this.d.store.updateMessage(msg.id, { parts, status: error && !produced ? "error" : "complete" });
    return { text: fullText.trim(), answer: finalAnswer(parts), error, limited, awaitingApproval, messageId: msg.id, ...(channels.size ? { channels: [...channels] } : {}) };
  }
}

/**
 * What a live session was opened with: a changed agent, a group's new members, or a setup chat that became its channel
 * or agent get a fresh session (resumed).
 */
/** A conversation the person talks in with one agent (not a task, not a group chat): its brain stays warm between turns. */
function warmable(conv: Conversation, task?: Task): boolean {
  return !task && !conv.taskId && (conv.kind === "main" || conv.kind === "setup" || conv.kind === "chat");
}

function sessionStamp(agent: AgentDef, conv: Conversation, kind: WorkKind, tools = ""): string {
  // Only this kind's choice: changing how tasks think leaves the dialog's session alone.
  const stamp = `${JSON.stringify({ ...agent, thinking: thinkingFor(agent, kind) })}|${tools}`;
  if (conv.kind === "setup") return `${stamp}|${conv.entity ?? ""}`;
  return conv.kind === "group" ? `${stamp}|${conv.title}|${(conv.members ?? []).join(",")}` : stamp;
}

/** Parts the hub adds to a message from outside the brain stream: cards (some with their own live status), images, maps. */
function attachedKey(p: MessagePart): string | undefined {
  if (p.type === "approval") return `approval:${p.approvalId}`;
  if (p.type === "secret_request") return `secret:${p.requestId}`;
  if (p.type === "plugin_setup") return `setup:${p.pluginId}`;
  if (p.type === "agent_draft") return `draft:${p.draftId}`;
  if (p.type === "brain_login") return `login:${p.ref}`;
  if (p.type === "device_pairing") return "device_pairing";
  if (p.type === "reply_to") return `reply_to:${p.messageId}`;
  if (p.type === "news") return `news:${JSON.stringify(p.items.map((x) => x.url ?? x.title))}`;
  if (p.type === "choices") return `choices:${JSON.stringify(p.options)}`;
  if (p.type === "feed") return `feed:${p.feedId}`;
  if (p.type === "page") return `page:${p.pageId}`;
  if (p.type === "thinking") return `thinking:${p.agentId}`;
  if (p.type === "agent_profile") return `profile:${p.agentId}`;
  if (p.type === "integration") return `integration:${p.id}`;
  // Each message to a teammate has its own line, even in the same thread.
  if (p.type === "task") return p.text === undefined ? `task:${p.taskId}` : `task:${p.taskId}|${p.text}`;
  // Pictures and maps carry no id: the same content shown twice in one reply is one card.
  if (p.type === "images") return `images:${JSON.stringify(p.items)}`;
  if (p.type === "map") return `map:${JSON.stringify([p.lat, p.lon, p.zoom, p.title, p.markers, p.route?.mode, p.route?.stops])}`;
  if (p.type === "widget") return `widget:${p.plugin}:${p.kind}:${JSON.stringify(p.data)}`;
  return undefined;
}

/** The streamed parts with the stored version of every card (newer status) and any card attached meanwhile. */
function mergeAttached(local: MessagePart[], stored: MessagePart[]): MessagePart[] {
  const cards = new Map<string, MessagePart>();
  for (const p of stored) {
    const k = attachedKey(p);
    if (k) cards.set(k, p);
  }
  const out = local.map((p) => {
    const k = attachedKey(p);
    return k && cards.has(k) ? cards.get(k)! : p;
  });
  for (const [k, p] of cards) if (!out.some((q) => attachedKey(q) === k)) out.push(p);
  return out;
}

/**
 * The reply as the channels get it: the text after the brain's last tool call. Its narration around the tools
 * ("let me look…") stays in the web UI with the tool calls.
 */
function finalAnswer(parts: MessagePart[]): string {
  const texts = (from: number) => parts.slice(from).flatMap((p) => (p.type === "text" ? [p.text] : []));
  const lastTool = parts.findLastIndex((p) => p.type === "tool_call" || p.type === "tool_result");
  const tail = texts(lastTool + 1).join("").trim();
  // Answered, then called a tool and said nothing more: the answer is the last thing it said.
  return tail || (texts(0).findLast((s) => s.trim()) ?? "").trim();
}

/** Reports this long reach their starter whole; a longer one ends with a pointer to the rest (task_status has all of it). */
const TASK_RESULT_MAX = 24_000;

/** A finished task's result for whoever started it: whole, or cut with a note saying how to read the rest. */
export function taskResult(task: Pick<Task, "id" | "result">, max = TASK_RESULT_MAX): string {
  const all = task.result ?? "";
  if (all.length <= max) return all;
  return `${all.slice(0, max)}\n…[cut at ${max} of ${all.length} characters: task_status {"taskId":"${task.id}"} has the whole result]`;
}

function resultText(r: ToolResult): string {
  return r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
}

export { newId, nowIso };

/** A tool input for the security log: long strings cut, so a written file does not fill it. */
function truncateInput(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return truncate(v, 500);
  if (Array.isArray(v)) return depth > 3 ? "[…]" : v.slice(0, 20).map((x) => truncateInput(x, depth + 1));
  if (v && typeof v === "object") return depth > 3 ? "{…}" : Object.fromEntries(Object.entries(v).slice(0, 30).map(([k, x]) => [k, truncateInput(x, depth + 1)]));
  return v;
}
