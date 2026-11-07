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

export interface HubSource {
  type: string;
  /** English, for the model. */
  description: string;
  data: unknown;
  sample: unknown;
}

const str = { type: "string" };

export const HUB_SOURCES: HubSource[] = [
  {
    type: "hub.task.finished",
    description:
      "A task finished successfully (status done). Data: the task, the agent that ran it, its title and its result (cut to 2 KB). One per task. A task a trigger started itself never brings a signal to that same trigger.",
    data: { type: "object", properties: { taskId: str, agentId: str, title: str, result: str }, required: ["taskId", "agentId", "title"] },
    sample: { taskId: "task_ab12", agentId: "assistant", title: "Weekly report", result: "The report is in the library." },
  },
  {
    type: "hub.task.failed",
    description:
      "A task failed (status failed). Data: the task, the agent, its title and the error (cut to 2 KB). One per task. A task a trigger started itself never brings a signal to that same trigger.",
    data: { type: "object", properties: { taskId: str, agentId: str, title: str, error: str }, required: ["taskId", "agentId", "title"] },
    sample: { taskId: "task_ab12", agentId: "assistant", title: "Weekly report", error: "The brain was not signed in." },
  },
  {
    type: "hub.machine.online",
    description: "A computer connected to the hub (it was offline or new). Data: the machine's id and name. At most one per machine and minute.",
    data: { type: "object", properties: { machineId: str, name: str }, required: ["machineId", "name"] },
    sample: { machineId: "mach_ab12", name: "Studio Mac" },
  },
  {
    type: "hub.machine.offline",
    description: "A computer disconnected from the hub (or was removed). Data: the machine's id and name. At most one per machine and minute.",
    data: { type: "object", properties: { machineId: str, name: str }, required: ["machineId", "name"] },
    sample: { machineId: "mach_ab12", name: "Studio Mac" },
  },
  {
    type: "hub.feed.post",
    description: "A channel (news feed) got a new post. Data: the channel's id, the post's title and its address when it has one. Not the post's text.",
    data: { type: "object", properties: { feedId: str, title: str, url: str }, required: ["feedId", "title"] },
    sample: { feedId: "feed_ab12", title: "A new release", url: "https://example.com/release" },
  },
  {
    type: "hub.approval.waiting",
    description: "An agent asked the person to approve an action and it waits. Data: the approval's id, the agent and the one-line summary the person sees; not the tool's input.",
    data: { type: "object", properties: { approvalId: str, agentId: str, summary: str }, required: ["approvalId", "agentId", "summary"] },
    sample: { approvalId: "a_ab12", agentId: "assistant", summary: "Send a message to Ana" },
  },
];

/** What a source needs from SignalSources. */
export interface HubEmit {
  /** Routes a signal of `type` to the enabled triggers listening (the ones `skip` leaves out are not given it). */
  (type: string, s: Pick<Signal, "data" | "key" | "external">, skip?: (triggerId: string) => boolean): void;
}

export interface MachineView {
  id: string;
  name: string;
  status: "online" | "offline";
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

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Starts the bus listeners; returns what stops them. `machines` seeds which computers are online now. */
export function listenToHub(bus: { on<K extends keyof BusEvents>(name: K, cb: (p: BusEvents[K]) => void): () => void }, emit: HubEmit, machines: () => MachineView[], now: () => number): () => void {
  // Who is online and how they are called, as far as the hub has said: a change of status is the signal.
  const known = new Map<string, { name: string; online: boolean }>();
  for (const m of machines()) known.set(m.id, { name: m.name, online: m.status === "online" });
  const off = [
    bus.on("task.updated", (t) => {
      if (!t || typeof t !== "object" || (t.status !== "done" && t.status !== "failed")) return;
      const done = t.status === "done";
      const own = typeof t.triggerId === "string" ? t.triggerId : undefined;
      const body = done ? { result: cutBytes(typeof t.result === "string" ? t.result : "", TASK_TEXT_MAX) } : { error: cutBytes(typeof t.error === "string" ? t.error : "", TASK_TEXT_MAX) };
      emit(
        done ? "hub.task.finished" : "hub.task.failed",
        {
          key: `${t.id}:${t.status}`,
          // A task that read outside content may carry it in its result.
          external: t.tainted === true,
          data: { taskId: String(t.id), agentId: String(t.agentId ?? ""), title: text(t.title, TITLE_MAX), ...body },
        },
        // The self-loop guard: the trigger whose wake task this is is never woken by its end.
        own ? (id) => id === own : undefined,
      );
    }),
    bus.on("machine.updated", (m) => {
      if (!m || typeof m.id !== "string" || (m.status !== "online" && m.status !== "offline")) return;
      const before = known.get(m.id);
      const name = text(m.name, 100) || before?.name || m.id;
      const online = m.status === "online";
      known.set(m.id, { name, online });
      if ((before?.online ?? false) === online) return;
      const minute = new Date(now()).toISOString().slice(0, 16);
      emit(online ? "hub.machine.online" : "hub.machine.offline", { key: `${m.id}:${m.status}:${minute}`, external: false, data: { machineId: m.id, name } });
    }),
    bus.on("feed.post", (p) => {
      if (!p || typeof p.id !== "string") return;
      emit("hub.feed.post", { key: p.id, external: false, data: { feedId: p.feedId, title: text(p.title, TITLE_MAX), ...(p.url ? { url: p.url } : {}) } });
    }),
    bus.on("approval.created", (a) => {
      if (!a || typeof a.id !== "string") return;
      emit("hub.approval.waiting", { key: a.id, external: false, data: { approvalId: a.id, agentId: String(a.agentId ?? ""), summary: text(a.summary, SUMMARY_MAX) } });
    }),
  ];
  return () => {
    for (const f of off) f();
  };
}
