import { speakable } from "./speakable.ts";

export interface HeardPrefix { messageId: string; end: number }
interface Reply { text: string; queued: number; heard: number; complete: boolean }

/** A complete sentence, with its offset in the original Markdown. Never speak an unfinished code block/link. */
export function sentence(text: string, complete: boolean): { words: string; end: number } | undefined {
  const chunk = (end: number) => {
    let words = speakable(text.slice(0, end), Number.MAX_SAFE_INTEGER);
    if (words.length > 900) {
      // The hub accepts at most 1000 spoken characters. Bound each request before it can truncate it.
      let best = 0;
      for (const match of plain.matchAll(/\S+\s+/g)) {
        const at = match.index + match[0].trimEnd().length;
        if (speakable(text.slice(0, at), Number.MAX_SAFE_INTEGER).length > 800) break;
        best = at;
      }
      end = best || Math.min(end, Math.max(0, plain.search(/\S/)) + 600);
      words = speakable(text.slice(0, end), Number.MAX_SAFE_INTEGER);
    }
    return { words, end };
  };
  const mask = (s: string) => " ".repeat(s.length);
  const plain = text
    .replace(/```[\s\S]*?(?:```|$)/g, mask)
    .replace(/`[^`]*(?:`|$)/g, mask)
    .replace(/!?\[[^\]]*(?:\]\([^)]*(?:\)|$)|$)/g, mask)
    .replace(/https?:\/\/\S+/g, mask);
  const boundary = /[.!?…]+["'»”)]*(?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(plain))) {
    const end = match.index + match[0].length;
    // The final dot may be a decimal, abbreviation or URL still being streamed.
    if (end === text.length && !complete) break;
    const words = speakable(text.slice(0, end), Number.MAX_SAFE_INTEGER);
    if (words) return chunk(end);
  }
  if (!complete) return undefined;
  return text ? chunk(text.length) : undefined;
}

/** One cancellable sentence at a time; the next text may arrive while this sentence is sounding. */
export class ReplyVoice {
  private replies = new Map<string, Reply>();
  private ignored = new Set<string>();
  private queue: Array<{ id: string; words: string; end: number }> = [];
  private ctl?: AbortController;
  private epoch = 0;
  private busy = false;
  private currentId?: string;

  private say: (words: string, signal: AbortSignal) => Promise<boolean>;
  private stopPlayback: () => void;
  constructor(say: (words: string, signal: AbortSignal) => Promise<boolean>, stopPlayback: () => void) {
    this.say = say;
    this.stopPlayback = stopPlayback;
  }

  get active(): boolean { return this.busy || this.queue.length > 0 || [...this.replies.values()].some((r) => !r.complete); }

  ignore(id: string): void {
    this.ignored.add(id);
    if (this.ignored.size > 512) this.ignored.delete(this.ignored.values().next().value!);
  }

  /** Another window interrupted this message, or it was removed. Leave unrelated playback alone. */
  discard(id: string): void {
    this.ignore(id);
    this.replies.delete(id);
    this.queue = this.queue.filter((q) => q.id !== id);
    if (this.currentId === id) {
      this.epoch++;
      this.ctl?.abort();
      this.stopPlayback();
      this.currentId = undefined;
      this.busy = false;
      void this.pump();
    }
  }

  observe(id: string, text: string, complete: boolean): void {
    if (this.ignored.has(id)) return;
    const r = this.replies.get(id) ?? { text: "", queued: 0, heard: 0, complete: false };
    if (text.length >= r.text.length) r.text = text;
    r.complete ||= complete;
    this.replies.set(id, r);
    let next;
    while ((next = sentence(r.text.slice(r.queued), r.complete))) {
      r.queued += next.end;
      if (next.words) this.queue.push({ id, words: next.words, end: r.queued });
    }
    void this.pump();
  }

  delta(id: string, delta: string): void {
    const r = this.replies.get(id);
    if (r) this.observe(id, r.text + delta, false);
  }

  /** Snapshot only completed audio, invalidate every in-flight await, then stop synchronously. */
  cancel(): HeardPrefix[] {
    const heard = [...this.replies].map(([messageId, r]) => ({ messageId, end: r.heard }));
    for (const id of this.replies.keys()) this.ignore(id);
    this.replies.clear();
    this.queue = [];
    this.epoch++;
    this.ctl?.abort();
    this.ctl = undefined;
    this.busy = false;
    this.currentId = undefined;
    this.stopPlayback();
    return heard;
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    const epoch = this.epoch;
    this.busy = true;
    try {
      while (this.queue.length && epoch === this.epoch) {
        const next = this.queue.shift()!;
        this.currentId = next.id;
        const ctl = this.ctl = new AbortController();
        let complete = false;
        try { complete = await this.say(next.words, ctl.signal); } catch { /* failed/cancelled is not heard */ }
        if (epoch !== this.epoch) return;
        const r = this.replies.get(next.id);
        if (!complete) {
          // An unheard gap cannot be acknowledged as part of a later prefix.
          this.queue = this.queue.filter((q) => q.id !== next.id);
          this.ignore(next.id);
        } else if (r) r.heard = next.end;
      }
    } finally {
      if (epoch === this.epoch) { this.busy = false; this.ctl = undefined; this.currentId = undefined; }
    }
  }
}
