// The hub's own events as signals (hub.*): broadcast sources mapped from the event bus, listed beside core's own and
// the plugins' (trigger_sources). They carry what the hub already keeps and no more: a task's result is cut to 2 KB,
// an approval brings its summary but never the tool input. SignalSources starts the listeners with the engine and
// stops them with it.
//
// Left out because the hub emits nothing for them: a changed place (the phone's report is only stored, user-location.ts)
// and a file added to an agent's library (the library is read from the conversations, library.ts).

import type { BusEvents } from "../bus.ts";
import type { Signal } from "./types.ts";

/** A task's result or error in a signal, at most, in bytes. */
export const TASK_TEXT_MAX = 2048;
const TITLE_MAX = 200;
const SUMMARY_MAX = 500;
/** A hub signal's subject (a task's title, a computer's name, a post's title, an approval's summary), at most. */
const SUBJECT_MAX = 200;
/** Tasks whose last status is remembered (to bring one signal per finish); the oldest are forgotten past it. */
const STATUSES_KEPT = 10_000;
/** How far up a subtask's parents the self-loop guard looks for the trigger whose wake task it came from. */
const PARENTS_MAX = 20;

export interface HubSource {
  type: string;
  /** English, for the model. */
  description: string;
  data: unknown;
  sample: unknown;
  /** Always outside content. The others are marked so per signal, when the task or approval read outside content. */
  external: boolean;
}

const str = { type: "string" };

export const HUB_SOURCES: HubSource[] = [
  {
    type: "hub.task.finished",
    external: false,
    description:
      "A task finished successfully (status done). Data: the task, the agent that ran it, its title and its result (cut to 2 KB); the subject is its title. One each time it finishes (again after another turn). A task a trigger started itself, its subtasks among them, never brings a signal to that same trigger. Outside content when the task was started with outside content or read some (its conversation is tainted): then the signal is external.",
    data: { type: "object", properties: { taskId: str, agentId: str, title: str, result: str }, required: ["taskId", "agentId", "title"] },
    sample: { taskId: "task_ab12", agentId: "assistant", title: "Weekly report", result: "The report is in the library." },
  },
  {
    type: "hub.task.failed",
    external: false,
    description:
      "A task failed (status failed). Data: the task, the agent, its title and the error (cut to 2 KB); the subject is its title. One each time it fails. A task a trigger started itself, its subtasks among them, never brings a signal to that same trigger. Outside content when the task was started with outside content or read some (its conversation is tainted): then the signal is external.",
    data: { type: "object", properties: { taskId: str, agentId: str, title: str, error: str }, required: ["taskId", "agentId", "title"] },
    sample: { taskId: "task_ab12", agentId: "assistant", title: "Weekly report", error: "The brain was not signed in." },
  },
  {
    type: "hub.machine.online",
    external: false,
    description: "A computer connected to the hub (it was offline or new). Data: the machine's id and name; the subject is its name. At most one per machine and minute.",
    data: { type: "object", properties: { machineId: str, name: str }, required: ["machineId", "name"] },
    sample: { machineId: "mach_ab12", name: "Studio Mac" },
  },
  {
    type: "hub.machine.offline",
    external: false,
    description: "A computer disconnected from the hub (or was removed). Data: the machine's id and name; the subject is its name. At most one per machine and minute.",
    data: { type: "object", properties: { machineId: str, name: str }, required: ["machineId", "name"] },
    sample: { machineId: "mach_ab12", name: "Studio Mac" },
  },
  {
    type: "hub.feed.post",
    external: true,
    description: "A channel (news feed) got a new post. Data: the channel's id, the post's title and its address when it has one; the subject is its title. Not the post's text. Always outside content: channel posts are gathered from the web.",
    data: { type: "object", properties: { feedId: str, title: str, url: str }, required: ["feedId", "title"] },
    sample: { feedId: "feed_ab12", title: "A new release", url: "https://example.com/release" },
  },
  {
    type: "hub.approval.waiting",
    external: false,
    description:
      "An agent asked the person to approve an action and it waits. Data: the approval's id, the agent and the one-line summary the person sees (also the subject); not the tool's input. An approval asked for in a trigger's own wake task, or in its subtasks, never brings a signal to that same trigger. Outside content when the approval is tainted (its summary is built from tool input that came from outside content): then the signal is external.",
    data: { type: "object", properties: { approvalId: str, agentId: str, summary: str }, required: ["approvalId", "agentId", "summary"] },
    sample: { approvalId: "a_ab12", agentId: "assistant", summary: "Send a message to Ana" },
  },
];

/** What a source needs from SignalSources. */
export interface HubEmit {
  /** Routes a signal of `type` to the enabled triggers listening (the ones `skip` leaves out are not given it). */
  (type: string, s: Pick<Signal, "data" | "key" | "external" | "subject">, skip?: (triggerId: string) => boolean): void;
}

export interface MachineView {
  id: string;
  name: string;
  status: "online" | "offline";
}

/** A task as the hub's sources look it up: whose wake task it is, and the task it was started from. */
export interface TaskLink {
  triggerId?: string;
  parentTaskId?: string;
}

/** What the hub's own sources read beyond the bus. */
export interface HubListenDeps {
  /** The computers and whether they are online now (the baseline for hub.machine.*). */
  machines: () => MachineView[];
  now: () => number;
  /**
   * Whether a task carries outside content: it was started or messaged with some, or a session of its conversation read
   * some (a research task that browsed). Unset: the task's own mark only.
   */
  taskTainted?: (t: { id: string; conversationId?: string; tainted?: boolean }) => boolean;
  /** A task by its id, to follow a subtask or an approval up to the trigger whose wake task it came from; unset: none. */
  task?: (id: string) => TaskLink | undefined;
}

/** `s` as text of at most `max` bytes (cut at a character, not in the middle of one). */
export function cutBytes(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  let end = max;
  const b = Buffer.from(s);
  // Step back off a continuation byte so a character is not split.
  while (end > 0 && (b[end]! & 0xc0) === 0x80) end--;
  return b.subarray(0, end).toString("utf8");
}

/** One line of at most `max` characters, cut first so a huge value costs no more than a few times that. */
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max * 4).replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Starts the bus listeners; returns what stops them. `d.machines` seeds which computers are online now. */
export function listenToHub(bus: { on<K extends keyof BusEvents>(name: K, cb: (p: BusEvents[K]) => void): () => void }, emit: HubEmit, d: HubListenDeps): () => void {
  // Who is online and how they are called, as far as the hub has said: a change of status is the signal.
  const known = new Map<string, { name: string; online: boolean }>();
  for (const m of d.machines()) known.set(m.id, { name: m.name, online: m.status === "online" });
  // Each task's last status: a finish is a change to done or failed, not every update while it stays so.
  const statuses = new Map<string, string>();
  const tainted = d.taskTainted ?? ((t: { tainted?: boolean }) => t.tainted === true);

  /** The triggers whose wake task this is, or whose wake task it came from by its parents (a wake task's subtasks). */
  const ownersOf = (first: TaskLink | undefined, firstId?: string): Set<string> => {
    const out = new Set<string>();
    const seen = new Set<string>(firstId ? [firstId] : []);
    let cur = first;
    for (let i = 0; cur && i <= PARENTS_MAX; i++) {
      if (typeof cur.triggerId === "string" && cur.triggerId) out.add(cur.triggerId);
      const parent = typeof cur.parentTaskId === "string" ? cur.parentTaskId : undefined;
      if (!parent || seen.has(parent)) break;
      seen.add(parent);
      cur = d.task?.(parent);
    }
    return out;
  };
  const skipping = (owners: Set<string>) => (owners.size ? (id: string) => owners.has(id) : undefined);

  const off = [
    bus.on("task.updated", (t) => {
      if (!t || typeof t !== "object" || typeof t.id !== "string") return;
      const status = String(t.status ?? "");
      const before = statuses.get(t.id);
      statuses.delete(t.id);
      statuses.set(t.id, status);
      if (statuses.size > STATUSES_KEPT) statuses.delete(statuses.keys().next().value!);
      if ((status !== "done" && status !== "failed") || before === status) return;
      const done = status === "done";
      const body = done ? { result: cutBytes(typeof t.result === "string" ? t.result : "", TASK_TEXT_MAX) } : { error: cutBytes(typeof t.error === "string" ? t.error : "", TASK_TEXT_MAX) };
      const title = text(t.title, TITLE_MAX);
      emit(
        done ? "hub.task.finished" : "hub.task.failed",
        {
          // A task that finishes again after another turn is a new finish: its time tells them apart.
          key: `${t.id}:${status}:${typeof t.updatedAt === "string" ? t.updatedAt : new Date(d.now()).toISOString()}`,
          // A task that was given outside content, or read some itself, may carry it in its result.
          external: tainted(t),
          data: { taskId: t.id, agentId: String(t.agentId ?? ""), title, ...body },
          ...(title ? { subject: title.slice(0, SUBJECT_MAX) } : {}),
        },
        // The self-loop guard: the trigger whose wake task this is (or whose wake task it came from) is never woken by its end.
        skipping(ownersOf(t, t.id)),
      );
    }),
    bus.on("machine.updated", (m) => {
      if (!m || typeof m.id !== "string" || (m.status !== "online" && m.status !== "offline")) return;
      const before = known.get(m.id);
      const name = text(m.name, 100) || before?.name || m.id;
      const online = m.status === "online";
      known.set(m.id, { name, online });
      if ((before?.online ?? false) === online) return;
      const minute = new Date(d.now()).toISOString().slice(0, 16);
      emit(online ? "hub.machine.online" : "hub.machine.offline", { key: `${m.id}:${m.status}:${minute}`, external: false, data: { machineId: m.id, name }, subject: name.slice(0, SUBJECT_MAX) });
    }),
    bus.on("feed.post", (p) => {
      if (!p || typeof p.id !== "string") return;
      const title = text(p.title, TITLE_MAX);
      emit("hub.feed.post", { key: p.id, external: true, data: { feedId: p.feedId, title, ...(p.url ? { url: p.url } : {}) }, ...(title ? { subject: title.slice(0, SUBJECT_MAX) } : {}) });
    }),
    bus.on("approval.created", (a) => {
      if (!a || typeof a.id !== "string") return;
      const summary = text(a.summary, SUMMARY_MAX);
      const taskId = typeof a.taskId === "string" && a.taskId ? a.taskId : undefined;
      emit(
        "hub.approval.waiting",
        { key: a.id, external: a.tainted === true, data: { approvalId: a.id, agentId: String(a.agentId ?? ""), summary }, ...(summary ? { subject: summary.slice(0, SUBJECT_MAX) } : {}) },
        // An approval asked for in a trigger's own wake task (or its subtasks) does not wake that trigger.
        taskId ? skipping(ownersOf(d.task?.(taskId), taskId)) : undefined,
      );
    }),
  ];
  return () => {
    for (const f of off) f();
  };
}
