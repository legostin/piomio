// Pio's bodies: the desktop app's Pio windows that are open (one per computer, a new id each time one loads), what each
// reports (its switches, the mic hearing someone, Pio speaking) and the windows the person worked in there, newest
// last. Kept in memory only: what the person did on their screen is never stored.

import type { AgentPresence } from "@piomio/shared";

export interface WindowSeen {
  app: string;
  title?: string;
  /** When it became the active window (ms). */
  since: number;
}

export interface Body {
  id: string;
  /** When it last said anything (ms): a window that stopped talking for a minute is gone. */
  seenAt: number;
  /** "Work together": Pio sees which window is active. */
  watching: boolean;
  voice: boolean;
  /** The person handed Pio the mouse and keyboard (the app's own confirmation). */
  control: boolean;
  /** The mic hears someone speaking now. */
  hearing: boolean;
  /** Pio is speaking out loud. */
  speaking: boolean;
  timeline: WindowSeen[];
}

export type BodyState = Partial<Pick<Body, "watching" | "voice" | "control" | "hearing" | "speaking">>;

const GONE_MS = 60_000;
const TIMELINE = 8;

export class Bodies {
  private all = new Map<string, Body>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** A window said something: it is alive (made on its first word). */
  touch(id: string): Body {
    let b = this.all.get(id);
    if (!b) {
      b = { id, seenAt: this.now(), watching: false, voice: false, control: false, hearing: false, speaking: false, timeline: [] };
      this.all.set(id, b);
    }
    b.seenAt = this.now();
    return b;
  }

  state(id: string, s: BodyState): Body {
    const b = this.touch(id);
    for (const k of ["watching", "voice", "control", "hearing", "speaking"] as const) if (typeof s[k] === "boolean") b[k] = s[k];
    // Nothing is seen while "Work together" is off.
    if (!b.watching) b.timeline = [];
    return b;
  }

  /** The active window changed (or was reported again): true when it is a new one. */
  window(id: string, app: string, title?: string): boolean {
    const b = this.touch(id);
    if (!b.watching || !app) return false;
    const last = b.timeline.at(-1);
    if (last && last.app === app && (last.title ?? "") === (title ?? "")) return false;
    b.timeline.push({ app, ...(title ? { title } : {}), since: this.now() });
    if (b.timeline.length > TIMELINE) b.timeline.splice(0, b.timeline.length - TIMELINE);
    return true;
  }

  gone(id: string): void {
    this.all.delete(id);
  }

  get(id: string): Body | undefined {
    return this.live().find((b) => b.id === id);
  }

  /** The window Pio acts through: the one with control, else the one watching, else the latest heard from. */
  active(): Body | undefined {
    const live = this.live().sort((a, b) => b.seenAt - a.seenAt);
    return live.find((b) => b.control) ?? live.find((b) => b.watching) ?? live[0];
  }

  /** What Pio is doing on the person's computer now, for the team list. */
  presence(): AgentPresence | undefined {
    const b = this.active();
    if (!b) return undefined;
    if (b.control) return "driving";
    if (b.speaking) return "speaking";
    if (b.voice) return "listening";
    if (b.watching) return "watching";
    return undefined;
  }

  private live(): Body[] {
    const now = this.now();
    for (const [id, b] of this.all) if (now - b.seenAt > GONE_MS) this.all.delete(id);
    return [...this.all.values()];
  }
}
