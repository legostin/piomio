// The calls into sherpa-onnx (speech in both directions) and the espeak-ng phonemizer Piper voices need since sherpa-onnx
// 2.0 dropped its own. The hub runs this in the voice worker (worker.ts) with the downloaded modules; tests hand it fakes.
// Errors are English.

import { join } from "node:path";

/** What the engine uses of sherpa-onnx-node (2.0.1: non-streaming-tts.js / non-streaming-asr.js). */
export interface SherpaModule {
  OfflineTts: { createAsync(config: unknown): Promise<SherpaTts> };
  OfflineRecognizer: { createAsync(config: unknown): Promise<SherpaRecognizer> };
}
export interface SherpaTts {
  sampleRate: number;
  generateAsync(req: unknown): Promise<{ samples: Float32Array; sampleRate: number }>;
}
export interface SherpaRecognizer {
  createStream(): { acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void };
  decodeAsync(stream: unknown): Promise<{ text?: string }>;
}
/** piper-phonemize-node: text → sentences of IPA code points (null when it fails). */
export interface PhonemizeModule {
  phonemize(text: string, voice: string): number[][] | null;
}
export interface VoiceModules {
  sherpa: SherpaModule;
  phonemize: PhonemizeModule;
}

/** The voice to speak with: its folder, model file and espeak-ng voice. */
export interface VoiceModel {
  dir: string;
  model: string;
  espeak: string;
}
/** The speech-to-text model: its folder, kind and files. */
export interface SttModel {
  dir: string;
  kind: "nemo_ctc" | "nemo_transducer";
  files: string[];
}

export interface Wave {
  samples: Float32Array;
  sampleRate: number;
}

/** sherpa-onnx's work for the engine: one voice and one recognizer loaded at a time, one call at a time. */
export class SherpaBackend {
  private load: () => VoiceModules;
  private modules?: VoiceModules;
  private tts?: { key: string; tts: Promise<SherpaTts> };
  private rec?: { key: string; rec: Promise<SherpaRecognizer> };
  private queue: Promise<unknown> = Promise.resolve();
  private threads: number;

  constructor(load: () => VoiceModules, threads = 2) {
    this.load = load;
    this.threads = threads;
  }

  private mods(): VoiceModules {
    return (this.modules ??= this.load());
  }

  /** Native handles are not safe to use from two calls at once. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  say(voice: VoiceModel, text: string, speed: number): Promise<Wave> {
    return this.serial(async () => {
      const key = join(voice.dir, voice.model);
      if (this.tts?.key !== key) {
        const tts = this.mods().sherpa.OfflineTts.createAsync({
          model: { vits: { model: key, tokens: join(voice.dir, "tokens.txt") }, numThreads: this.threads, provider: "cpu", debug: false },
          maxNumSentences: 1,
        });
        this.tts = { key, tts };
        tts.catch(() => this.tts?.tts === tts && (this.tts = undefined));
      }
      const tts = await this.tts.tts;
      // sherpa-onnx wants every sentence non-empty.
      const phonemeCodepoints = (this.mods().phonemize.phonemize(text, voice.espeak) ?? []).filter((s) => s.length > 0);
      if (!phonemeCodepoints.length) return { samples: new Float32Array(0), sampleRate: tts.sampleRate };
      const audio = await tts.generateAsync({ text: "", enableExternalBuffer: false, generationConfig: { phonemeCodepoints, sid: 0, speed, silenceScale: 0.2 } });
      return { samples: audio.samples, sampleRate: audio.sampleRate };
    });
  }

  recognize(model: SttModel, samples: Float32Array, sampleRate: number): Promise<string> {
    return this.serial(async () => {
      if (this.rec?.key !== model.dir) {
        const f = (name: string) => join(model.dir, model.files.find((x) => x.startsWith(name)) ?? name);
        const modelConfig =
          model.kind === "nemo_ctc"
            ? { nemoCtc: { model: f("model") } }
            : { transducer: { encoder: f("encoder"), decoder: f("decoder"), joiner: f("joiner") }, modelType: "nemo_transducer" };
        const rec = this.mods().sherpa.OfflineRecognizer.createAsync({
          featConfig: { sampleRate: 16000, featureDim: 80 },
          modelConfig: { ...modelConfig, tokens: join(model.dir, "tokens.txt"), numThreads: this.threads, provider: "cpu", debug: false },
        });
        this.rec = { key: model.dir, rec };
        rec.catch(() => this.rec?.rec === rec && (this.rec = undefined));
      }
      const rec = await this.rec.rec;
      const words: string[] = [];
      // The models hear up to half a minute well: longer audio goes in pieces cut where it is quietest.
      for (const [from, to] of segments(samples, sampleRate)) {
        const stream = rec.createStream();
        stream.acceptWaveform({ samples: samples.subarray(from, to), sampleRate });
        const r = await rec.decodeAsync(stream);
        const text = String(r?.text ?? "").trim();
        if (text) words.push(text);
      }
      return words.join(" ");
    });
  }
}

/**
 * Pieces of about `target` seconds (never over `max`), each cut at the quietest 30 ms between `min` and `max` seconds
 * from its start, so words are rarely split. Short audio is one piece.
 */
export function segments(samples: Float32Array, rate: number, target = 20, min = 12, max = 28): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const frame = Math.max(1, Math.round(rate * 0.03));
  let start = 0;
  while (samples.length - start > max * rate) {
    let best = start + target * rate;
    let quietest = Infinity;
    for (let at = start + min * rate; at + frame <= start + max * rate; at += frame) {
      let e = 0;
      for (let i = at; i < at + frame; i++) e += samples[i] * samples[i];
      // Ties go to the cut nearest the target.
      if (e < quietest || (e === quietest && Math.abs(at - start - target * rate) < Math.abs(best - start - target * rate))) {
        quietest = e;
        best = at + Math.floor(frame / 2);
      }
    }
    out.push([start, best]);
    start = best;
  }
  if (samples.length > start || !out.length) out.push([start, samples.length]);
  return out;
}
