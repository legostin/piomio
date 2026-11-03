// The mic of Pio's window: echo-cancelled sound cut into phrases (vad.ts), each handed over as a 16 kHz WAV. It also
// looks after itself: a capture WebKit ended or muted (the computer slept, a headset came or went) or an audio context
// it suspended is noticed within seconds, woken or opened again, and told to the window (onHealth), so the face never
// claims to listen while nothing is heard.

import { Vad, type VadEvent } from "./vad.ts";
import { downsample, encodeWav } from "./wav.ts";

/** Why the mic hears nothing: no sound comes, the system muted the track, or the mic cannot be opened. */
export type MicTrouble = "silent" | "muted" | "noMic";

/** An open microphone: frames until `stop`. */
export interface Capture {
  sampleRate: number;
  /** Muted by the system as it was opened. */
  muted?: boolean;
  /** A context the browser suspended runs again. */
  wake(): void;
  stop(): void;
}

export interface CaptureHandlers {
  /** Mono samples at the capture's rate, silence included. */
  onFrame(frame: Float32Array): void;
  /** The sound stopped for good (the track ended). */
  onLost(why: string): void;
  /** The system muted (or unmuted) the track. */
  onMuted(on: boolean): void;
}

/** What opens the microphone: the browser's (webMic), or a fake in tests. */
export interface MicPort {
  /** Rejects with Error("insecure") where there is no getUserMedia (a plain http page that is not localhost). */
  open(h: CaptureHandlers): Promise<Capture>;
}

export interface MicClock {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(timer: unknown): void;
}

export interface MicOptions {
  onPhrase(wav: Uint8Array, held: boolean, duringReply: boolean): void;
  onHearing(on: boolean): void;
  /** Sustained, sufficiently loud speech, including while Pio talks. */
  onInterrupt?(): void;
  /** Known output audio still reaching the mic after browser echo cancellation. */
  isEcho?(frame: Float32Array, rate: number): boolean;
  /** The mic hears again (ok), or stopped hearing and why. Called on each change. */
  onHealth?(ok: boolean, why?: MicTrouble): void;
  port?: MicPort;
  clock?: MicClock;
}

/** How often the mic checks that sound still comes. */
export const CHECK_MS = 1_000;
/** No frames this long: the mic is deaf, and its context is woken. */
export const SILENT_MS = 5_000;
/** Deaf (no frames, muted, or not to be opened) this long: the mic is opened again. */
export const REOPEN_MS = 10_000;

const AUDIO: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };

/** The browser's microphone, through one AudioContext for the window's life. */
export function webMic(): MicPort {
  let ctx: AudioContext | undefined;
  return {
    async open(h) {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("insecure");
      // Made (or woken) before the wait for the mic, while the tap that turned the voice on still counts: WebKit keeps a
      // context made later suspended, and a suspended context hears nothing.
      const c = (ctx ??= new AudioContext());
      void c.resume().catch(() => {});
      const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO });
      const track = stream.getAudioTracks()[0];
      const source = c.createMediaStreamSource(stream);
      const node = c.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (e) => h.onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
      source.connect(node);
      node.connect(c.destination);
      const wake = () => {
        if (c.state !== "running") void c.resume().catch(() => {});
      };
      // Suspended (interrupted) by the system: asked to run again at once.
      c.onstatechange = wake;
      await c.resume().catch(() => {});
      if (track) {
        track.onended = () => h.onLost("ended");
        track.onmute = () => h.onMuted(true);
        track.onunmute = () => h.onMuted(false);
      }
      return {
        sampleRate: c.sampleRate,
        muted: track?.muted ?? false,
        wake,
        stop() {
          source.disconnect();
          node.disconnect();
          node.onaudioprocess = null;
          if (track) track.onended = track.onmute = track.onunmute = null;
          for (const t of stream.getTracks()) t.stop();
        },
      };
    },
  };
}

export class Mic {
  private o: MicOptions;
  private port: MicPort;
  private clock: MicClock;
  private capture?: Capture;
  private vad?: Vad;
  /** Voice is on: the mic is open, or being opened again. */
  private wanted = false;
  private opening = false;
  /** Each open and stop: an open that waited for the mic past a stop gives its capture back. */
  private turn = 0;
  private timer?: unknown;
  /** Playback is phrase metadata, never a reason to stop VAD or the capture watchdog. */
  private playback = false;
  private duringReply = false;
  private held = false;
  private phraseHeld = false;
  private lastFrameAt = 0;
  private lastCheckAt = 0;
  private trackMuted = false;
  /** When the mic was noticed deaf (no frames, muted, not to be opened): opened again REOPEN_MS later. */
  private deafSince?: number;
  private trouble?: MicTrouble;

  constructor(o: MicOptions) {
    this.o = o;
    this.port = o.port ?? webMic();
    this.clock = o.clock ?? { now: Date.now, setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>) };
  }

  get on(): boolean {
    return this.wanted;
  }

  /** Opens the mic; rejects when it cannot be opened at all (voice then stays off). Once open, it looks after itself. */
  async start(): Promise<void> {
    if (this.wanted) return;
    this.wanted = true;
    try {
      await this.open();
    } catch (e) {
      this.wanted = false;
      throw e;
    }
    if (!this.wanted) return;
    this.lastCheckAt = this.clock.now();
    this.timer ??= this.clock.setInterval(() => this.check(), CHECK_MS);
  }

  /** A tap in the window: a context WebKit suspended hears again. */
  wake(): void {
    this.capture?.wake();
  }

  /** Opens the mic again now (the card's "Try again"). */
  restart(): void {
    if (this.wanted) void this.reopen();
  }

  /** Push to talk (⌥Space). */
  hold(on: boolean): void {
    this.held = on;
    if (on) this.phraseHeld = true;
    if (this.vad) this.handle(this.vad.hold(on));
  }

  /** Keep hearing the person while Pio speaks; AEC and the output reference reject echo. */
  setPlayback(on: boolean): void {
    this.playback = on;
  }

  stop(): void {
    this.wanted = false;
    this.turn++;
    if (this.timer !== undefined) this.clock.clearInterval(this.timer);
    this.timer = undefined;
    this.close();
    this.held = false;
    this.playback = false;
    this.report(undefined);
    this.deafSince = undefined;
    this.o.onHearing(false);
  }

  private close(): void {
    this.capture?.stop();
    this.capture = undefined;
    this.vad = undefined;
    this.trackMuted = false;
    this.phraseHeld = false;
    this.duringReply = false;
    this.o.onHearing(false);
  }

  private async open(): Promise<void> {
    const turn = ++this.turn;
    this.opening = true;
    let cap: Capture | undefined;
    try {
      cap = await this.port.open({
        onFrame: (f) => this.frame(cap, f),
        onLost: () => this.lost(cap),
        onMuted: (on) => this.mutedBySystem(cap, on),
      });
    } finally {
      this.opening = false;
    }
    if (turn !== this.turn || !this.wanted) {
      cap.stop();
      return;
    }
    this.close();
    this.capture = cap;
    this.vad = new Vad({ sampleRate: cap.sampleRate, confidenceMs: 300 });
    if (this.held) this.handle(this.vad.hold(true));
    this.lastFrameAt = this.clock.now();
    this.deafSince = undefined;
    if (cap.muted) this.mutedBySystem(cap, true);
  }

  /** Opens the mic again (the old capture goes once the new one is there); a failure is said and tried again later. */
  private async reopen(): Promise<void> {
    if (this.opening || !this.wanted) return;
    this.deafSince = this.clock.now();
    try {
      await this.open();
    } catch {
      if (this.wanted) this.report("noMic");
    }
  }

  private frame(cap: Capture | undefined, f: Float32Array): void {
    if (!cap || cap !== this.capture) return;
    this.lastFrameAt = this.clock.now();
    if (!this.trackMuted) {
      this.deafSince = undefined;
      this.report(undefined);
    }
    // Health is based on capture frames, before echo rejection: a quiet room or Pio's own audio is not a dead mic.
    if (this.trackMuted) return;
    if (!this.held && this.o.isEcho?.(f, cap.sampleRate)) f = new Float32Array(f.length);
    if (this.vad) this.handle(this.vad.feed(f));
  }

  private lost(cap: Capture | undefined): void {
    if (!cap || cap !== this.capture) return;
    this.report("silent");
    void this.reopen();
  }

  private mutedBySystem(cap: Capture | undefined, on: boolean): void {
    if (!cap || cap !== this.capture) return;
    this.trackMuted = on;
    if (on) {
      this.deafSince ??= this.clock.now();
      this.report("muted");
    } else {
      this.deafSince = undefined;
      this.report(undefined);
    }
  }

  /** Every second: does sound still come? Woken when it stopped; opened again when that did not help. */
  private check(): void {
    const now = this.clock.now();
    const gap = now - this.lastCheckAt;
    this.lastCheckAt = now;
    if (!this.wanted || this.opening) return;
    if (!this.capture) {
      if (this.deafSince === undefined || now - this.deafSince >= REOPEN_MS) void this.reopen();
      return;
    }
    if (gap > 3 * CHECK_MS) {
      // The computer slept (its timers stood still, and so did the sound): the mic gets a fresh chance, woken.
      this.lastFrameAt = now;
      this.capture.wake();
      return;
    }
    const silent = now - this.lastFrameAt >= SILENT_MS;
    if (!silent && !this.trackMuted) return;
    this.deafSince ??= now;
    if (silent) {
      if (this.trouble !== "noMic") this.report("silent");
      this.capture.wake();
    }
    if (now - this.deafSince >= REOPEN_MS) void this.reopen();
  }

  private report(why: MicTrouble | undefined): void {
    if (why === this.trouble) return;
    this.trouble = why;
    if (why) {
      // A phrase cut off by sleep/mute must not leave the face stuck on "hearing" or join unrelated audio later.
      this.vad = undefined;
      this.phraseHeld = false;
      this.duringReply = false;
      this.o.onHearing(false);
    } else if (this.capture && !this.vad) {
      this.vad = new Vad({ sampleRate: this.capture.sampleRate, confidenceMs: 300 });
      if (this.held) this.handle(this.vad.hold(true));
    }
    this.o.onHealth?.(why === undefined, why);
  }

  private handle(e: VadEvent | undefined): void {
    if (!e) return;
    if (e.type === "start") {
      this.duringReply = this.playback;
      this.phraseHeld = this.held;
      return this.o.onHearing(true);
    }
    if (e.type === "confident") {
      // The reply may be between sentences or still synthesizing. Its controller knows whether it is active.
      this.o.onInterrupt?.();
      return;
    }
    this.o.onHearing(false);
    if (e.type === "end" && this.capture) this.o.onPhrase(encodeWav(downsample(e.samples, this.capture.sampleRate)), this.phraseHeld, this.duringReply);
    this.phraseHeld = false;
  }
}
