// The hub's local speech engine: open-source text to speech (Piper voices) and speech to text (GigaAM, Parakeet) on
// sherpa-onnx, downloaded on demand into <data>/voice and run in the voice worker (worker.ts). Downloads go one at a time
// in the background; status() says what is there and what is coming, and every change is emitted (≤ 4 a second while
// downloading). Errors for people are LocalizedError (hub language over HTTP, English in logs).

import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SpeechStatus, TranscriptionProvider } from "@piomio/shared";
import { hubLocale, LocalizedError, tFor, type Locale } from "../i18n.ts";
import { scrubEnv } from "../plugins/host.ts";
import { SherpaBackend, type SttModel, type VoiceModel, type VoiceModules } from "./backend.ts";
import { defaultSources, defaultSttModel, defaultVoice, type ModelSpec, type SpeechSources, type SttSpec, type VoiceSpec } from "./catalog.ts";
import { installModel, installRuntime, InstallError, modelInstalled, runtimeInstalled, sweepPartial } from "./install.ts";
import { MAX_SPEED, MIN_SPEED, type VoiceSettings } from "./settings.ts";
import { speakable } from "./text.ts";
import { encodeWav } from "./wav.ts";
import type { WorkerReply, WorkerRequest } from "./worker.ts";

export interface SpeechEngineDeps {
  dataDir: string;
  /** The hub language: the default voice and speech-to-text model follow it. */
  language: () => string;
  voice: () => VoiceSettings | undefined;
  sttProvider: () => TranscriptionProvider;
  /** Every change of status() (the hub sends it to the apps as the UiEvent speech.status). */
  emit?: (status: SpeechStatus) => void;
  log?: (line: string) => void;
}

/** What the Transcriber needs of the engine (provider "local"). */
export interface LocalSpeechToText {
  /** The local model that hears the hub language, when it and the runtime are installed. */
  sttReady(): string | undefined;
  /** The words in 16-bit-or-float mono samples (any rate; the overlay sends 16 kHz). */
  recognize(samples: Float32Array, sampleRate: number): Promise<string>;
}

interface Backend {
  say(voice: VoiceModel, text: string, speed: number): Promise<Buffer>;
  recognize(model: SttModel, samples: Float32Array, sampleRate: number): Promise<string>;
  stop(): void;
}

type Item = { id: string; spec?: ModelSpec };

/** How often a download's progress reaches the apps. */
const PROGRESS_MS = 250;
/** The worker ends after this long unused, freeing the models' memory. */
const IDLE_MS = 10 * 60_000;

export class SpeechEngine implements LocalSpeechToText {
  /** Where the pieces come from; tests swap in their own servers and archives. */
  sources: SpeechSources = defaultSources();
  /** Tests: these modules run in this process instead of the voice worker. */
  modules?: () => VoiceModules;
  private d: SpeechEngineDeps;
  private root: string;
  private queue: Item[] = [];
  private running?: Promise<void>;
  private current?: { item: string; received: number; total: number };
  private failure?: { key: string; item: string; reason: string };
  private lastEmit = 0;
  private emitTimer?: NodeJS.Timeout;
  private backend?: Backend;
  /** The modules the backend was made with (none: the worker). */
  private backendFor?: () => VoiceModules;
  private stopped = new AbortController();

  constructor(d: SpeechEngineDeps) {
    this.d = d;
    this.root = join(d.dataDir, "voice");
    sweepPartial(this.root);
    sweepPartial(join(this.root, "models"));
  }

  // ---------- what is there ----------

  private get runtimeDir(): string {
    return join(this.root, "runtime");
  }

  private modelDir(m: ModelSpec): string {
    return join(this.root, "models", m.id);
  }

  runtimeReady(): boolean {
    return runtimeInstalled(this.runtimeDir, this.sources.runtime);
  }

  private modelReady(m: ModelSpec): boolean {
    return modelInstalled(this.modelDir(m), m);
  }

  private findVoice(id: string): VoiceSpec | undefined {
    return this.sources.voices.find((v) => v.id === id);
  }

  /** The voice speech is spoken with: the setting, else the hub language's default. */
  voiceId(): string {
    const set = this.d.voice()?.voice;
    return set && this.findVoice(set) ? set : defaultVoice(this.d.language(), this.sources.voices).id;
  }

  private speed(): number {
    const s = Number(this.d.voice()?.speed);
    return Number.isFinite(s) && s >= MIN_SPEED && s <= MAX_SPEED ? s : 1;
  }

  /**
   * The local speech-to-text model: the hub language's when it is installed, else one that is (the person may speak
   * another language than the hub's: Pio installs the model for theirs), else the hub language's to install.
   */
  sttModel(): SttSpec {
    const own = defaultSttModel(this.d.language(), this.sources.stt);
    return this.modelReady(own) ? own : (this.sources.stt.find((m) => this.modelReady(m)) ?? own);
  }

  /** What `install`'s `stt` names: true (the current model), a model id or a language code. */
  private sttFor(v: unknown): SttSpec | undefined {
    if (v === true) return this.sttModel();
    if (typeof v !== "string" || !v) return undefined;
    return this.sources.stt.find((m) => m.id === v) ?? defaultSttModel(v, this.sources.stt);
  }

  sttReady(): string | undefined {
    const m = this.sttModel();
    return this.runtimeReady() && this.modelReady(m) ? m.id : undefined;
  }

  status(locale: Locale = hubLocale()): SpeechStatus {
    const tr = tFor(locale);
    const ready = this.runtimeReady();
    const runtimeQueued = this.queue.some((q) => q.id === "runtime");
    const stt = this.sttModel();
    return {
      runtime: ready ? "ready" : runtimeQueued ? "downloading" : this.failure ? "failed" : "missing",
      ...(this.failure ? { error: tr(this.failure.key, { item: this.itemName(this.failure.item, locale), reason: this.failure.reason }) } : {}),
      voice: this.voiceId(),
      speed: this.speed(),
      voices: this.sources.voices.map((v) => ({
        id: v.id,
        lang: v.lang,
        gender: v.gender,
        name: tr(`speech.voice.${v.id}`),
        size: v.size,
        license: v.license,
        installed: this.modelReady(v),
      })),
      stt: {
        provider: this.d.sttProvider(),
        local: { model: stt.id, installed: this.modelReady(stt), size: stt.size },
        models: this.sources.stt.map((m) => ({ id: m.id, langs: m.langs, size: m.size, installed: this.modelReady(m) })),
      },
      ...(this.current ? { downloading: { ...this.current } } : {}),
    };
  }

  private itemName(id: string, locale: Locale): string {
    const tr = tFor(locale);
    if (id === "runtime") return tr("speech.item.runtime");
    if (this.findVoice(id)) return tr("speech.item.voice", { name: tr(`speech.voice.${id}`) });
    return tr("speech.item.stt");
  }

  /** Settings changed (voice, language, provider): the apps re-read. */
  changed(now = true): void {
    if (!this.d.emit) return;
    const left = PROGRESS_MS - (Date.now() - this.lastEmit);
    if (now || left <= 0) {
      clearTimeout(this.emitTimer);
      this.emitTimer = undefined;
      this.lastEmit = Date.now();
      try {
        this.d.emit(this.status());
      } catch (e: any) {
        // The hub is stopping (its database is closed): nobody is listening.
        this.d.log?.(`[speech] status not sent: ${e?.message ?? e}`);
      }
    } else {
      this.emitTimer ??= setTimeout(() => this.changed(true), left);
    }
  }

  // ---------- installing ----------

  /**
   * Starts the downloads in the background: the runtime when missing, then the voice (`voice`, else the current one)
   * and, with `stt`, a speech-to-text model (true: the current one; a model id; a language code: the model for it), `stt`
   * alone installing no voice. Returns the status at once.
   */
  install(opts: { voice?: unknown; stt?: unknown } = {}, locale?: Locale): SpeechStatus {
    const voiceId = opts.voice === undefined || opts.voice === null || opts.voice === "" ? undefined : String(opts.voice);
    if (voiceId !== undefined && !this.findVoice(voiceId)) throw new LocalizedError("speech.unknownVoice", { id: voiceId }, 400);
    if (!this.sources.runtime) {
      this.failure = { key: "speech.error.unsupported", item: "runtime", reason: `${process.platform}-${process.arch}` };
      this.changed();
      return this.status(locale);
    }
    const specs: ModelSpec[] = [];
    const stt = this.sttFor(opts.stt);
    if (!(stt && voiceId === undefined)) specs.push(this.findVoice(voiceId ?? this.voiceId())!);
    if (stt) specs.push(stt);
    const items: Item[] = [...(this.runtimeReady() ? [] : [{ id: "runtime" }]), ...specs.filter((s) => !this.modelReady(s)).map((s) => ({ id: s.id, spec: s }))];
    const fresh = items.filter((i) => !this.queue.some((q) => q.id === i.id));
    if (fresh.length) {
      if (!this.running) {
        this.failure = undefined;
        // The answer already shows the first download, at 0.
        this.current = { item: fresh[0].id, received: 0, total: this.itemSize(fresh[0]) };
      }
      this.queue.push(...fresh);
      this.running ??= this.run().catch((e) => this.d.log?.(`[speech] install stopped: ${e?.message ?? e}`));
      this.changed();
    }
    return this.status(locale);
  }

  private itemSize(item: Item): number {
    return item.spec?.size ?? (this.sources.runtime ?? []).reduce((n, p) => n + p.size, 0);
  }

  /** Waits for the downloads in progress (tests, shutdown). */
  async settled(): Promise<void> {
    await this.running;
  }

  private async run(): Promise<void> {
    // Everything below happens after install() has noted that a run is going.
    await Promise.resolve();
    try {
      mkdirSync(join(this.root, "models"), { recursive: true });
      while (this.queue.length) {
        const item = this.queue[0];
        this.current = { item: item.id, received: 0, total: this.itemSize(item) };
        this.changed();
        const progress = (p: { received: number; total: number }) => {
          this.current = { item: item.id, ...p };
          this.changed(false);
        };
        try {
          if (item.spec) await installModel(this.modelDir(item.spec), item.spec, this.sources.releases, progress, this.stopped.signal);
          else {
            await installRuntime(this.runtimeDir, this.sources.runtime!, this.sources.registry, progress, this.stopped.signal);
            // A new runtime: a new worker loads it.
            this.backend?.stop();
            this.backend = undefined;
          }
          this.d.log?.(`[speech] installed ${item.id}`);
          this.queue.shift();
        } catch (e: any) {
          const reason = String(e?.message ?? e);
          this.d.log?.(`[speech] ${item.id} was not installed: ${reason}`);
          const kind = e instanceof InstallError ? e.reason : "download";
          this.failure = { key: `speech.error.${kind}`, item: item.id, reason };
          this.queue = [];
        }
      }
    } finally {
      this.current = undefined;
      this.running = undefined;
      this.changed();
    }
  }

  // ---------- speaking and hearing ----------

  /** A WAV (16-bit PCM at the voice's rate) of the text's words; Markdown is dropped, the text cut at 1000 characters. */
  async say(text: string, opts: { voice?: unknown; speed?: unknown } = {}): Promise<Buffer> {
    const id = opts.voice === undefined || opts.voice === null || opts.voice === "" ? this.voiceId() : String(opts.voice);
    const v = this.findVoice(id);
    if (!v) throw new LocalizedError("speech.unknownVoice", { id }, 400);
    if (!this.runtimeReady() || !this.modelReady(v)) throw new LocalizedError("speech.notInstalled", { voice: tFor(hubLocale())(`speech.voice.${v.id}`) }, 409);
    const words = speakable(String(text ?? ""));
    if (!words) throw new LocalizedError("speech.nothingToSay", undefined, 400);
    const n = opts.speed === undefined || opts.speed === null ? this.speed() : Number(opts.speed);
    const speed = Number.isFinite(n) ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, n)) : this.speed();
    return this.engine().say({ dir: this.modelDir(v), model: v.model, espeak: v.espeak }, words, speed);
  }

  /** The words in mono samples, with the hub language's local model; throws when it is not installed. */
  async recognize(samples: Float32Array, sampleRate: number): Promise<string> {
    const m = this.sttModel();
    if (!this.runtimeReady() || !this.modelReady(m)) throw new LocalizedError("speech.sttNotInstalled", undefined, 409);
    if (!samples.length) return "";
    return this.engine().recognize({ dir: this.modelDir(m), kind: m.kind, files: m.files }, samples, sampleRate);
  }

  private engine(): Backend {
    if (this.backend && this.backendFor === this.modules) return this.backend;
    this.backend?.stop();
    this.backendFor = this.modules;
    if (this.modules) {
      const b = new SherpaBackend(this.modules);
      this.backend = {
        say: async (voice, text, speed) => {
          const w = await b.say(voice, text, speed);
          return encodeWav(w.samples, w.sampleRate);
        },
        recognize: (model, samples, rate) => b.recognize(model, samples, rate),
        stop: () => {},
      };
    } else {
      this.backend = new WorkerBackend(this.runtimeDir, (l) => this.d.log?.(l));
    }
    return this.backend;
  }

  /** The hub stops: downloads end (nothing half-done stays) and the worker goes. */
  stop(): void {
    this.queue = this.queue.slice(0, 1);
    this.stopped.abort();
    this.stopped = new AbortController();
    clearTimeout(this.emitTimer);
    this.emitTimer = undefined;
    this.backend?.stop();
    this.backend = undefined;
  }
}

/** The voice worker process, started on first use and ended after IDLE_MS unused. */
class WorkerBackend implements Backend {
  private runtime: string;
  private log: (line: string) => void;
  private child?: ChildProcess;
  private pending = new Map<number, { resolve: (r: WorkerReply) => void; reject: (e: Error) => void }>();
  private seq = 0;
  private idle?: NodeJS.Timeout;

  constructor(runtime: string, log: (line: string) => void) {
    this.runtime = runtime;
    this.log = log;
  }

  private start(): ChildProcess {
    const script = join(import.meta.dirname, "worker.ts");
    if (!existsSync(script)) throw new Error(`the voice worker is missing (${script})`);
    const child = fork(script, [this.runtime], {
      execArgv: ["--disable-warning=ExperimentalWarning"],
      serialization: "advanced",
      env: scrubEnv(process.env),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      for (const line of d.split("\n")) if (line.trim()) this.log(`[speech worker] ${line.slice(0, 500)}`);
    });
    child.on("message", (r: WorkerReply) => {
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      if (r.error) p.reject(new Error(r.error));
      else p.resolve(r);
    });
    const gone = (why: string) => {
      if (this.child === child) this.child = undefined;
      for (const p of this.pending.values()) p.reject(new Error(`the voice engine stopped (${why})`));
      this.pending.clear();
    };
    child.on("exit", (code, signal) => gone(signal ?? `exit ${code}`));
    child.on("error", (e) => gone(e.message));
    return child;
  }

  /** Sends `req` under a new id (the one given is replaced). */
  private call(req: WorkerRequest): Promise<WorkerReply> {
    const child = (this.child ??= this.start());
    const id = ++this.seq;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), IDLE_MS);
    this.idle.unref();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.send({ ...req, id }, (e) => {
        if (!e) return;
        this.pending.delete(id);
        reject(new Error(`the voice engine cannot be reached (${e.message})`));
      });
    });
  }

  async say(voice: VoiceModel, text: string, speed: number): Promise<Buffer> {
    const r = await this.call({ id: 0, op: "say", voice, text, speed });
    return Buffer.from(r.wav ?? new Uint8Array());
  }

  async recognize(model: SttModel, samples: Float32Array, sampleRate: number): Promise<string> {
    const r = await this.call({ id: 0, op: "recognize", model, samples, sampleRate });
    return r.text ?? "";
  }

  stop(): void {
    clearTimeout(this.idle);
    this.child?.kill();
    this.child = undefined;
  }
}
