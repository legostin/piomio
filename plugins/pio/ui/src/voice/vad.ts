// Cuts the mic's sound into phrases: loud enough above the room's own noise starts one, 700 ms of quiet (or 20 s)
// ends it. Energy only, no model: Pio sends each phrase to the hub's speech-to-text. A held key (push to talk) makes
// everything a phrase until it is let go.

export interface VadOptions {
  sampleRate: number;
  /** Quiet that ends a phrase. */
  silenceMs?: number;
  /** The longest phrase. */
  maxMs?: number;
  /** Shorter sounds (a click, a cough) are dropped. */
  minSpeechMs?: number;
  /** How far above the noise floor speech must be. */
  ratio?: number;
  /** Speech is never quieter than this (RMS). */
  floorMin?: number;
}

export type VadEvent = { type: "start" } | { type: "end"; samples: Float32Array } | { type: "drop" };

export function rms(frame: Float32Array): number {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
  return Math.sqrt(s / Math.max(1, frame.length));
}

export class Vad {
  private o: Required<VadOptions>;
  private floor = 0.01;
  private speaking = false;
  private held = false;
  private chunks: Float32Array[] = [];
  private length = 0;
  private quietFor = 0;
  private loudFor = 0;
  /** Sound just before a phrase starts (its first syllable). */
  private before: Float32Array[] = [];

  constructor(o: VadOptions) {
    this.o = { silenceMs: 700, maxMs: 20_000, minSpeechMs: 250, ratio: 3, floorMin: 0.012, ...o };
  }

  /** Push to talk: held, everything is a phrase; let go, it ends now. */
  hold(on: boolean): VadEvent | undefined {
    if (on === this.held) return undefined;
    this.held = on;
    if (on && !this.speaking) {
      this.begin();
      return { type: "start" };
    }
    if (!on && this.speaking) return this.finish(true);
    return undefined;
  }

  feed(frame: Float32Array): VadEvent | undefined {
    const ms = (frame.length / this.o.sampleRate) * 1000;
    const level = rms(frame);
    const threshold = Math.max(this.o.floorMin, this.floor * this.o.ratio);
    const loud = level > threshold;
    if (!this.speaking) {
      // The room's noise, learnt while nobody speaks.
      this.floor = this.floor * 0.95 + Math.min(level, threshold) * 0.05;
      this.before.push(frame);
      while (this.before.length > 8) this.before.shift();
      this.loudFor = loud ? this.loudFor + ms : 0;
      if (this.loudFor >= 60) {
        this.begin();
        for (const f of this.before) this.push(f);
        this.before = [];
        return { type: "start" };
      }
      return undefined;
    }
    this.push(frame);
    this.quietFor = loud ? 0 : this.quietFor + ms;
    if (loud) this.loudFor += ms;
    const lengthMs = (this.length / this.o.sampleRate) * 1000;
    if ((!this.held && this.quietFor >= this.o.silenceMs) || lengthMs >= this.o.maxMs) return this.finish(this.held);
    return undefined;
  }

  private begin(): void {
    this.speaking = true;
    this.chunks = [];
    this.length = 0;
    this.quietFor = 0;
    this.loudFor = 0;
  }

  private push(f: Float32Array): void {
    this.chunks.push(f);
    this.length += f.length;
  }

  private finish(forced: boolean): VadEvent {
    this.speaking = false;
    const speechMs = this.loudFor;
    const out = new Float32Array(this.length);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    this.chunks = [];
    this.length = 0;
    this.loudFor = 0;
    if (!forced && speechMs < this.o.minSpeechMs) return { type: "drop" };
    return { type: "end", samples: out };
  }
}
