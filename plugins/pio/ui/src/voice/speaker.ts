// Pio's voice: the hub's local voice (a WAV) when it is installed, else the system's own voice.

export class Speaker {
  private ctx?: AudioContext;
  private src?: AudioBufferSourceNode;
  private utter?: SpeechSynthesisUtterance;
  private onState: (speaking: boolean) => void;

  constructor(onState: (speaking: boolean) => void) {
    this.onState = onState;
  }

  async play(wav: ArrayBuffer): Promise<void> {
    this.stop();
    this.ctx ??= new AudioContext();
    const buf = await this.ctx.decodeAudioData(wav);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    src.onended = () => {
      if (this.src === src) this.done();
    };
    this.src = src;
    this.onState(true);
    src.start();
  }

  /** The computer's own voice, in the language of the text (a male one when there is one, like Pio's). */
  system(text: string, lang: string): void {
    this.stop();
    if (typeof speechSynthesis === "undefined") return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === "ru" ? "ru-RU" : "en-US";
    const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(lang));
    const male = voices.find((v) => /yuri|milena|dmitr|aaron|alex|daniel|fred|male/i.test(v.name) && !/female/i.test(v.name));
    if (male ?? voices[0]) u.voice = (male ?? voices[0])!;
    u.onend = u.onerror = () => {
      if (this.utter === u) this.done();
    };
    this.utter = u;
    this.onState(true);
    speechSynthesis.speak(u);
  }

  stop(): void {
    const was = !!this.src || !!this.utter;
    try {
      this.src?.stop();
    } catch {
      /* already ended */
    }
    this.src = undefined;
    if (this.utter && typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    this.utter = undefined;
    if (was) this.onState(false);
  }

  private done(): void {
    this.src = undefined;
    this.utter = undefined;
    this.onState(false);
  }
}
