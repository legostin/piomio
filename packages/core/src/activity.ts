// What every machine is doing now: the turns in progress, grouped by the machine their brain runs on, for the
// machines block of the web UI and the phone app. The runner reports turns and their steps; this keeps the view and
// announces it as "machines.activity", at most a few times a second.

import type { Approval, MachineActivity, MachineInfo, MachineWork, WorkStep } from "@piomio/shared";
import { nowIso, parseBrainRef } from "@piomio/shared";
import type { EventBus } from "./bus.ts";
import type { MachineHub } from "./machines.ts";
import { hubName } from "./pairing.ts";

interface Turn extends MachineWork {
  machineId: string;
  /** While a call waits for the user's approval: the step to return to. */
  held?: WorkStep;
  heldDetail?: string;
}

const COMMAND = /^(Bash|BashOutput|KillShell|shell|exec_command|local_shell)$/;
const READING = /^(Read|Glob|Grep|LS|NotebookRead|read_file|list_dir|view)$/;
const EDITING = /^(Edit|MultiEdit|Write|NotebookEdit|apply_patch|write_file)$/;
const WEB = /^(WebFetch|WebSearch|fetch|web_(search|fetch|rss))$/i;

/** What a tool call does, by the tool's name (Claude Code's, Codex's, the hub's own). */
export function stepOfTool(name: string): WorkStep {
  if (COMMAND.test(name)) return "command";
  if (READING.test(name)) return "reading";
  if (EDITING.test(name)) return "editing";
  if (WEB.test(name)) return "web";
  return "tool";
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const short = (v: string, max = 60) => (v.length > max ? `${v.slice(0, max - 1)}…` : v);

/**
 * What a tool call is about, in a few words for the chat's "now" line: a file's name, a search or a site, a command's
 * first words, or the tool's own name (the hub's tools; the web turns the known ones into words).
 */
export function detailOfTool(name: string, input: unknown): string | undefined {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  switch (stepOfTool(name)) {
    case "command": {
      const cmd = str(i.command) ?? (Array.isArray(i.command) ? i.command.filter((x) => typeof x === "string").join(" ") : undefined);
      return cmd ? short(cmd.split("\n")[0]) : undefined;
    }
    case "reading":
    case "editing": {
      const files = Array.isArray(i.files) ? i.files.filter((x) => typeof x === "string") : [];
      const path = str(i.file_path) ?? str(i.notebook_path) ?? str(i.path) ?? files[0];
      if (path) return short(path.split(/[\\/]/).filter(Boolean).pop() ?? path);
      return str(i.pattern) ? short(str(i.pattern)!) : undefined;
    }
    case "web": {
      const url = str(i.url);
      if (url) {
        try {
          return new URL(url).host;
        } catch {
          return short(url);
        }
      }
      return str(i.query) ? short(str(i.query)!) : undefined;
    }
    case "tool":
      return name.replace(/^mcp__piomio__/, "");
    default:
      return undefined;
  }
}

/** How long changes collect before one "machines.activity" goes out. */
const EMIT_DELAY_MS = 250;

export class MachineActivityFeed {
  bus: EventBus;
  machines: MachineHub;
  /** The "Update" each row offers (self-update.ts). */
  updates?: { offerFor(id: string, info?: MachineInfo): { update?: string; updating?: boolean } };
  /** By the streaming message's id: one per turn. */
  private turns = new Map<string, Turn>();
  private timer?: NodeJS.Timeout;

  constructor(bus: EventBus, machines: MachineHub) {
    this.bus = bus;
    this.machines = machines;
    // Online and offline, renames and revoked machines.
    bus.on("machine.updated", () => this.changed());
    bus.on("updates.changed", () => this.changed());
    bus.on("approval.created", (a: Approval) => this.hold(a, true));
    bus.on("approval.resolved", (a: Approval | undefined) => a && this.hold(a, false));
  }

  /** A turn started streaming into message `id` on the brain `brainRef`. */
  start(id: string, t: { brainRef: string; agentId: string; conversationId: string; taskId?: string; title?: string }): void {
    const ref = parseBrainRef(t.brainRef);
    this.turns.set(id, {
      machineId: ref.machineId,
      agentId: t.agentId,
      conversationId: t.conversationId,
      ...(t.taskId ? { taskId: t.taskId } : {}),
      ...(t.title ? { title: t.title } : {}),
      brainId: ref.brainId,
      step: "thinking",
      startedAt: nowIso(),
    });
    this.changed();
  }

  step(id: string, step: WorkStep, detail?: string): void {
    const turn = this.turns.get(id);
    if (!turn) return;
    if (turn.held) {
      turn.held = step;
      turn.heldDetail = detail;
      return;
    }
    if (turn.step === step && turn.detail === detail) return;
    turn.step = step;
    if (detail) turn.detail = detail;
    else delete turn.detail;
    this.changed();
  }

  /** The agent's turn in that conversation waits for the user's approval, or goes on. */
  private hold(a: Approval, waiting: boolean): void {
    for (const turn of this.turns.values()) {
      if (turn.conversationId !== a.conversationId || turn.agentId !== a.agentId) continue;
      if (waiting && !turn.held) {
        turn.held = turn.step;
        turn.heldDetail = turn.detail;
        turn.step = "approval";
        delete turn.detail;
      } else if (!waiting && turn.held) {
        turn.step = turn.held;
        if (turn.heldDetail) turn.detail = turn.heldDetail;
        turn.held = undefined;
        turn.heldDetail = undefined;
      } else continue;
      this.changed();
    }
  }

  end(id: string): void {
    if (this.turns.delete(id)) this.changed();
  }

  /** The hub's computer first, then the paired machines; each with its turns, the oldest first. */
  view(): MachineActivity[] {
    const work = (machineId: string): MachineWork[] =>
      [...this.turns.values()]
        .filter((t) => t.machineId === machineId)
        .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0))
        .map(({ machineId: _, held: __, heldDetail: ___, ...w }) => w);
    const offer = (id: string, info?: MachineInfo) => this.updates?.offerFor(id, info) ?? {};
    return [
      { id: "local", name: hubName(), online: true, work: work("local"), ...offer("local") },
      ...this.machines.list().map((m) => ({ id: m.id, name: m.name, online: m.status === "online", work: work(m.id), ...(m.status === "online" ? offer(m.id, m.info) : {}) })),
    ];
  }

  close(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private changed(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.bus.emit("machines.activity", this.view());
    }, EMIT_DELAY_MS);
    this.timer.unref?.();
  }
}
