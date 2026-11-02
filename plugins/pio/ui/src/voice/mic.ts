// The mic of Pio's window: echo-cancelled sound cut into phrases (vad.ts), each handed over as a 16 kHz WAV.

import { Vad, type VadEvent } from "./vad.ts";
import { downsample, encodeWav } from "./wav.ts";

export class Mic {
  private stream?: MediaStream;
  private ctx?: AudioContext;
  private node?: ScriptProcessorNode;
  private vad?: Vad;
  private muted = false;
  private held = false;
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
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const ctx = new AudioContext();
    this.ctx = ctx;
    const vad = new Vad({ sampleRate: ctx.sampleRate });
    this.vad = vad;
    const src = ctx.createMediaStreamSource(this.stream);
    const node = ctx.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (e) => {
      if (this.muted && !this.held) return;
      this.handle(vad.feed(new Float32Array(e.inputBuffer.getChannelData(0))));
    };
    src.connect(node);
    node.connect(ctx.destination);
    this.node = node;
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
    this.node?.disconnect();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    void this.ctx?.close().catch(() => {});
    this.stream = undefined;
    this.ctx = undefined;
    this.node = undefined;
    this.vad = undefined;
    this.onHearing(false);
  }

  private handle(e: VadEvent | undefined): void {
    if (!e) return;
    if (e.type === "start") return this.onHearing(true);
    this.onHearing(false);
    if (e.type === "end" && this.ctx) this.onPhrase(encodeWav(downsample(e.samples, this.ctx.sampleRate)), this.held);
  }
}
