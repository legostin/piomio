// Playback completion is an acknowledgement: cancelled/deferred audio never counts as heard.
export class Speaker {
  private ctx?: AudioContext;
  private src?: AudioBufferSourceNode;
  private utter?: SpeechSynthesisUtterance;
  private epoch = 0;
  private finish?: (complete: boolean) => void;
  private reference?: { samples: Float32Array; rate: number; start: number; end: number };

  private onState: (speaking: boolean) => void;
  constructor(onState: (speaking: boolean) => void) { this.onState = onState; }

  async play(wav: ArrayBuffer): Promise<boolean> {
    this.stop();
    const epoch = this.epoch;
    this.ctx ??= new AudioContext();
    await this.ctx.resume();
    if (epoch !== this.epoch) return false;
    const buf = await this.ctx.decodeAudioData(wav);
    if (epoch !== this.epoch) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    this.src = src;
    this.reference = { samples: buf.getChannelData(0), rate: buf.sampleRate, start: this.ctx.currentTime, end: this.ctx.currentTime + buf.duration };
    return new Promise<boolean>((resolve) => {
      this.finish = resolve;
      src.onended = () => { if (this.src === src) this.done(true); };
      try {
        src.start();
        this.onState(true);
      } catch {
        this.done(false);
      }
    });
  }

  system(text: string, lang: string): Promise<boolean> {
    this.stop();
    if (typeof speechSynthesis === "undefined") return Promise.resolve(false);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === "ru" ? "ru-RU" : "en-US";
    const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(lang));
    const male = voices.find((v) => /yuri|milena|dmitr|aaron|alex|daniel|fred|male/i.test(v.name) && !/female/i.test(v.name));
    if (male ?? voices[0]) u.voice = (male ?? voices[0])!;
    this.utter = u;
    return new Promise<boolean>((resolve) => {
      this.finish = resolve;
      u.onstart = () => { if (this.utter === u) this.onState(true); };
      u.onend = () => { if (this.utter === u) this.done(true); };
      u.onerror = () => { if (this.utter === u) this.done(false); };
      speechSynthesis.speak(u);
    });
  }

  /** Additional echo rejection for local WAVs. AEC handles the system voice. */
  isEcho(frame: Float32Array, rate: number): boolean {
    const ref = this.reference;
    if (!ref || !this.ctx || this.ctx.currentTime > ref.end + 0.3) return false;
    const step = Math.max(1, Math.floor(frame.length / 256));
    let energy = 0;
    for (let i = 0; i < frame.length; i += step) energy += frame[i] ** 2;
    if (energy < 1e-6) return false;
    const time = this.ctx.currentTime - ref.start - frame.length / rate;
    // The acoustic path can trail playback; compare waveforms, not merely their volumes.
    for (let delay = 0; delay <= 0.25; delay += 0.005) {
      let dot = 0, other = 0;
      for (let i = 0; i < frame.length; i += step) {
        const at = Math.round((time - delay + i / rate) * ref.rate);
        const v = ref.samples[at] ?? 0;
        dot += frame[i] * v;
        other += v * v;
      }
      if (other > 1e-6 && Math.abs(dot) / Math.sqrt(energy * other) > 0.8) return true;
    }
    return false;
  }

  stop(): void {
    this.epoch++;
    const src = this.src;
    const utter = this.utter;
    this.src = undefined;
    this.utter = undefined;
    if (this.reference && this.ctx) this.reference.end = Math.min(this.reference.end, this.ctx.currentTime);
    try { src?.stop(); } catch { /* already ended */ }
    if (utter && typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    this.done(false);
  }

  private done(complete: boolean): void {
    const finish = this.finish;
    this.finish = undefined;
    this.src = undefined;
    this.utter = undefined;
    finish?.(complete);
    if (finish) this.onState(false);
  }
}
