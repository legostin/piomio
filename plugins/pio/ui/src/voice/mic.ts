// The mic of Pio's window: echo-cancelled sound cut into phrases (vad.ts), each handed over as a 16 kHz WAV.

import { Vad, type VadEvent } from "./vad.ts";
import { downsample, encodeWav } from "./wav.ts";

export class Mic {
  private stream?: MediaStream;
  private ctx?: AudioContext;
  private node?: ScriptProcessorNode;
  private source?: MediaStreamAudioSourceNode;
  private vad?: Vad;
  private muted = false;
  private held = false;
  /** Each start and stop: a start that waited for the mic past a stop gives its stream back. */
  private turn = 0;
  private onPhrase: (wav: Uint8Array, held: boolean) => void;
  private onHearing: (on: boolean) => void;

  constructor(onPhrase: (wav: Uint8Array, held: boolean) => void, onHearing: (on: boolean) => void) {
    this.onPhrase = onPhrase;
    this.onHearing = onHearing;
  }

  get on(): boolean {
    return !!this.stream;
  }

  async start(): Promise<void> {
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("insecure");
    // Made (or woken) before the wait for the mic, while the tap that turned the voice on still counts: WebKit keeps a
    // context made later suspended, and a suspended context hears nothing. One context for the window's life.
    const ctx = (this.ctx ??= new AudioContext());
    void ctx.resume().catch(() => {});
    const turn = ++this.turn;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    if (turn !== this.turn || this.stream) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.stream = stream;
    const vad = new Vad({ sampleRate: ctx.sampleRate });
    this.vad = vad;
    this.source = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (e) => {
      if (this.muted && !this.held) return;
      this.handle(vad.feed(new Float32Array(e.inputBuffer.getChannelData(0))));
    };
    this.source.connect(node);
    node.connect(ctx.destination);
    this.node = node;
    await ctx.resume().catch(() => {});
  }

  /** A tap in the window: a context WebKit suspended hears again. */
  wake(): void {
    if (this.stream && this.ctx?.state !== "running") void this.ctx?.resume().catch(() => {});
  }

  /** Push to talk (⌥Space). */
  hold(on: boolean): void {
    this.held = on;
    if (this.vad) this.handle(this.vad.hold(on));
  }

  /** While Pio speaks its own voice is not a phrase (unless the key is held). */
  mute(on: boolean): void {
    this.muted = on;
  }

  stop(): void {
    this.turn++;
    this.source?.disconnect();
    this.node?.disconnect();
    if (this.node) this.node.onaudioprocess = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = undefined;
    this.source = undefined;
    this.node = undefined;
    this.vad = undefined;
    this.held = false;
    this.muted = false;
    this.onHearing(false);
  }

  private handle(e: VadEvent | undefined): void {
    if (!e) return;
    if (e.type === "start") return this.onHearing(true);
    this.onHearing(false);
    if (e.type === "end" && this.ctx) this.onPhrase(encodeWav(downsample(e.samples, this.ctx.sampleRate)), this.held);
  }
}
