// The local speech engine with a fake sherpa-onnx and phonemizer (in this process, and through the real voice worker
// process with plain-JS stand-ins), downloads from a fake registry and release server, and the Transcriber's provider
// "local". The real native engine never runs here.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeechStatus, TranscriptionProvider } from "@piomio/shared";
import { segments } from "../src/speech/backend.ts";
import { STT_MODELS, VOICES, type RuntimePackage, type SpeechSources } from "../src/speech/catalog.ts";
import { SpeechEngine } from "../src/speech/engine.ts";
import { cleanVoice } from "../src/speech/settings.ts";
import { speakable } from "../src/speech/text.ts";
import { encodeWav, parseWav } from "../src/speech/wav.ts";
import { pickEngine, Transcriber } from "../src/transcribe.ts";
import { fakeModules, fileServer, modelArchive, npmTarball, sha256, sri } from "./speech-fixtures.ts";

describe("text for speaking", () => {
  it("keeps the words of Markdown and drops the rest", () => {
    expect(speakable("**Привет**, _мир_!")).toBe("Привет, мир!");
    expect(speakable("# Plan\n\n- buy *milk*\n- call [Anna](https://x.example/anna)\n\n```js\nconsole.log(1)\n```\nDone")).toBe("Plan. buy milk. call Anna. Done.");
    expect(speakable("Use `npm test` now. See https://example.com/a?b=c for more.")).toBe("Use npm test now. See for more.");
    expect(speakable("| name | age |\n|---|---|\n| Ann | 3 |")).toBe("name, age. Ann, 3.");
    expect(speakable("> quoted ~~old~~ text 🎉\n\n---\n![a cat](cat.png)")).toBe("quoted old text. a cat.");
    expect(speakable("snake_case_name stays")).toBe("snake_case_name stays.");
    expect(speakable("```\nonly code\n```")).toBe("");
    expect(speakable("unclosed\n```\ncode")).toBe("unclosed.");
  });

  it("cuts long text at a sentence end", () => {
    const long = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const s = speakable(long);
    expect(s.length).toBeLessThanOrEqual(1000);
    expect(s.endsWith(".")).toBe(true);
    expect(speakable("word ".repeat(400), 100).length).toBeLessThanOrEqual(100);
  });
});

describe("voice settings", () => {
  it("takes a known voice and a speed from 0.5 to 2", () => {
    expect(cleanVoice({ voice: "piper-ru-denis", speed: 1.25 })).toEqual({ voice: "piper-ru-denis", speed: 1.25 });
    expect(cleanVoice({})).toEqual({});
    expect(cleanVoice({ voice: "", speed: null })).toEqual({});
    expect(cleanVoice({ voice: "robot" })).toMatch(/voice\.voice must be one of piper-ru-dmitri/);
    expect(cleanVoice({ speed: 3 })).toMatch(/from 0\.5 to 2/);
    expect(cleanVoice({ speed: true })).toMatch(/from 0\.5 to 2/);
    expect(cleanVoice("fast")).toMatch(/must be an object/);
  });
});

describe("long audio in pieces", () => {
  it("cuts at the quietest place near every 20 seconds", () => {
    const rate = 100;
    const loud = new Float32Array(60 * rate).fill(0.5);
    // Quiet at 17 s and at 40 s.
    loud.fill(0, 17 * rate, 17 * rate + 10);
    loud.fill(0, 40 * rate, 40 * rate + 10);
    const parts = segments(loud, rate);
    expect(parts[0][0]).toBe(0);
    expect(parts.at(-1)![1]).toBe(loud.length);
    expect(Math.round(parts[0][1] / rate)).toBe(17);
    expect(Math.round(parts[1][1] / rate)).toBe(40);
    for (let i = 1; i < parts.length; i++) expect(parts[i][0]).toBe(parts[i - 1][1]);
    expect(segments(new Float32Array(5 * rate), rate)).toEqual([[0, 5 * rate]]);
    expect(segments(new Float32Array(0), rate)).toEqual([[0, 0]]);
  });
});

/** Sources made of small archives on a fake server: two runtime packages, Dmitri, Ryan and GigaAM. */
async function fakeSources(dir: string) {
  const files = new Map<string, Buffer>();
  const runtime: RuntimePackage[] = (["sherpa-onnx-node", "piper-phonemize-node"] as const).map((name) => {
    const tgz = npmTarball(dir, name, "9.9.9");
    files.set(`/${name}/-/${name}-9.9.9.tgz`, tgz);
    return { name, version: "9.9.9", size: tgz.length, integrity: sri(tgz) };
  });
  const model = <T extends { asset: string; files: string[]; tag: string }>(m: T): T & { size: number; sha256: string } => {
    const a = modelArchive(dir, m.asset.replace(/\.tar\.bz2$/, ""), m.files);
    files.set(`/${m.tag}/${m.asset}`, a);
    return { ...m, size: a.length, sha256: sha256(a) };
  };
  const voices = VOICES.map((v) => (v.id === "piper-ru-dmitri" || v.id === "piper-en-ryan" ? model(v) : v));
  const stt = STT_MODELS.map((m) => (m.id === "giga-am-v3-ru" ? model(m) : m));
  const srv = await fileServer(files);
  const sources: SpeechSources = { registry: srv.url, releases: srv.url, runtime, voices, stt };
  return { srv, sources, files };
}

describe("the local speech engine", () => {
  let dir: string;
  let fake: Awaited<ReturnType<typeof fakeSources>>;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "owl-speech-engine-"));
    fake = await fakeSources(dir);
  });
  afterAll(() => fake.srv.server.close());

  const engine = (over: { language?: string; voice?: object; provider?: TranscriptionProvider } = {}) => {
    const emitted: SpeechStatus[] = [];
    const e = new SpeechEngine({
      dataDir: mkdtempSync(join(dir, "data-")),
      language: () => over.language ?? "ru",
      voice: () => over.voice ?? {},
      sttProvider: () => over.provider ?? "auto",
      emit: (s) => emitted.push(s),
    });
    e.sources = fake.sources;
    const f = fakeModules();
    e.modules = () => f.modules;
    return { e, emitted, calls: f.calls };
  };

  it("says what it has before anything is installed, and refuses to speak", async () => {
    const { e } = engine();
    const s = e.status("en");
    expect(s).toMatchObject({ runtime: "missing", voice: "piper-ru-dmitri", speed: 1, stt: { provider: "auto", local: { model: "giga-am-v3-ru", installed: false } } });
    expect(s.voices.find((v) => v.id === "piper-ru-irina")).toMatchObject({ lang: "ru", gender: "female", name: "Irina", license: "unknown", installed: false });
    expect(e.status("ru").voices[0].name).toBe("Дмитрий");
    expect(engine({ language: "en" }).e.status().voice).toBe("piper-en-ryan");
    expect(engine({ voice: { voice: "piper-ru-denis", speed: 1.5 } }).e.status()).toMatchObject({ voice: "piper-ru-denis", speed: 1.5 });
    await expect(e.say("Привет")).rejects.toMatchObject({ status: 409, key: "speech.notInstalled" });
    await expect(e.say("Привет", { voice: "robot" })).rejects.toMatchObject({ status: 400, key: "speech.unknownVoice" });
    await expect(e.recognize(new Float32Array(10), 16000)).rejects.toMatchObject({ status: 409 });
    expect(e.sttReady()).toBeUndefined();
    expect(() => e.install({ voice: "robot" })).toThrow(/no voice robot/);
  });

  it("downloads the runtime and the voice in the background, then speaks Markdown as a WAV", async () => {
    const { e, emitted, calls } = engine();
    const first = e.install({});
    expect(first.runtime).toBe("downloading");
    // Asked again while it runs: nothing twice.
    e.install({});
    await e.settled();
    const s = e.status();
    expect(s.runtime).toBe("ready");
    expect(s.error).toBeUndefined();
    expect(s.downloading).toBeUndefined();
    expect(s.voices.find((v) => v.id === "piper-ru-dmitri")!.installed).toBe(true);
    expect(s.voices.find((v) => v.id === "piper-ru-denis")!.installed).toBe(false);
    expect(emitted.some((x) => x.downloading?.item === "runtime")).toBe(true);
    expect(emitted.some((x) => x.downloading?.item === "piper-ru-dmitri" && x.downloading.total === fake.sources.voices[0].size)).toBe(true);
    // Progress is held to 4 a second: these small downloads send little more than their starts and the end.
    expect(emitted.length).toBeLessThan(10);
    expect(emitted.at(-1)!.runtime).toBe("ready");
    expect(fake.srv.hits.filter((h) => h.endsWith("vits-piper-ru_RU-dmitri-medium-int8.tar.bz2")).length).toBeGreaterThanOrEqual(1);

    const wav = await e.say("**Привет**, мир.\n\n```\ncode\n```", { speed: 5 });
    const w = parseWav(wav);
    expect(w.sampleRate).toBe(22050);
    expect(w.samples.length).toBe(Array.from("Привет, мир.").length);
    expect(w.samples[0]).toBeCloseTo(-0.5, 3);
    expect(calls.phonemize).toEqual([{ text: "Привет, мир.", voice: "ru" }]);
    expect(calls.tts[0].model.vits.model).toMatch(/voice[\\/]models[\\/]piper-ru-dmitri[\\/]ru_RU-dmitri-medium\.onnx$/);
    expect(calls.tts[0].model.vits.tokens).toMatch(/piper-ru-dmitri[\\/]tokens\.txt$/);
    // The speed is held to 0.5–2.
    expect(calls.generate[0].generationConfig).toMatchObject({ sid: 0, speed: 2 });
    await e.say("Ещё раз.");
    expect(calls.tts).toHaveLength(1);
    await expect(e.say("```\nonly code\n```")).rejects.toMatchObject({ status: 400, key: "speech.nothingToSay" });
    // Another voice is not installed.
    await expect(e.say("Привет", { voice: "piper-ru-denis" })).rejects.toMatchObject({ status: 409 });
  });

  it("installs speech-to-text alone and hears 16 kHz samples", async () => {
    const { e, calls } = engine();
    e.install({ stt: true });
    await e.settled();
    const s = e.status();
    expect(s.stt.local).toMatchObject({ model: "giga-am-v3-ru", installed: true });
    expect(s.voices.every((v) => !v.installed)).toBe(true);
    expect(e.sttReady()).toBe("giga-am-v3-ru");
    const samples = new Float32Array(16000).fill(0.1);
    expect(await e.recognize(samples, 16000)).toBe("привет, это тест");
    expect(calls.waves[0].sampleRate).toBe(16000);
    expect(calls.waves[0].samples).toBeInstanceOf(Float32Array);
    expect(calls.waves[0].samples.length).toBe(16000);
    expect(calls.recognizer[0].modelConfig.nemoCtc.model).toMatch(/giga-am-v3-ru[\\/]model\.int8\.onnx$/);
    expect(calls.recognizer[0].featConfig).toEqual({ sampleRate: 16000, featureDim: 80 });
  });

  it("keeps the reason when a download fails, and nothing is installed", async () => {
    const { e } = engine();
    e.sources = { ...fake.sources, runtime: [fake.sources.runtime![0], { ...fake.sources.runtime![1], integrity: sri(Buffer.from("other")) }] };
    e.install({});
    await e.settled();
    const s = e.status("en");
    expect(s.runtime).toBe("failed");
    expect(s.error).toMatch(/^the speech engine did not match its checksum and was not installed: .*does not match its pinned checksum/);
    expect(s.voices.every((v) => !v.installed)).toBe(true);
    expect(e.status("ru").error).toMatch(/^движок речи: контрольная сумма не совпала/);

    // A voice that fails after the runtime is in: the runtime stays ready.
    const second = engine();
    second.e.sources = { ...fake.sources, voices: fake.sources.voices.map((v) => (v.id === "piper-ru-dmitri" ? { ...v, asset: "missing.tar.bz2" } : v)) };
    second.e.install({});
    await second.e.settled();
    expect(second.e.status("en")).toMatchObject({ runtime: "ready", error: expect.stringMatching(/^Could not download the voice Dmitri: 127\.0\.0\.1:\d+ answered 404/) });

    // No runtime for this computer.
    const none = engine();
    none.e.sources = { ...fake.sources, runtime: undefined };
    expect(none.e.install({}).error).toMatch(/no local speech engine for this computer/);
  });

  it("serves the Transcriber: provider local, and auto after the keys", async () => {
    const has = (ids: string[]) => (id: string) => ids.includes(id);
    expect(pickEngine({ provider: "local" }, has([]))).toBeUndefined();
    expect(pickEngine({ provider: "local" }, has(["openai_api_key"]), "giga-am-v3-ru")).toEqual({ label: "sherpa-onnx", model: "giga-am-v3-ru", local: true });
    expect(pickEngine({ provider: "auto" }, has([]), "giga-am-v3-ru")?.local).toBe(true);
    expect(pickEngine({ provider: "auto" }, has(["groq_api_key"]), "giga-am-v3-ru")?.label).toBe("Groq");
    expect(pickEngine({ provider: "off" }, has([]), "giga-am-v3-ru")).toBeUndefined();

    const { e } = engine();
    const t = new Transcriber({ settings: () => ({ provider: "auto" }), hasSecret: () => false, secret: () => "" });
    t.local = e;
    expect(t.engine()).toBeUndefined();
    e.install({ stt: true });
    await e.settled();
    expect(t.engine()).toMatchObject({ local: true, model: "giga-am-v3-ru" });
    expect(await t.transcribeBuffer(encodeWav(new Float32Array(1600).fill(0.2), 16000), "audio/wav")).toBe("привет, это тест");
    await expect(t.transcribeBuffer(Buffer.from("OggS voice"), "audio/ogg")).rejects.toThrow(/the local engine reads WAV; this recording is audio\/ogg/);
    const file = join(dir, "note.wav");
    writeFileSync(file, encodeWav(new Float32Array(800), 16000));
    expect(await t.transcribe(file, "audio/wav")).toBe("привет, это тест");
  });
});

describe("the voice worker", () => {
  it("speaks and hears in its own process with the runtime it is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owl-speech-worker-"));
    const data = join(dir, "data");
    const runtime = join(data, "voice", "runtime");
    // Plain-JS stand-ins for the downloaded native modules.
    const mod = (name: string, body: string) => {
      mkdirSync(join(runtime, "node_modules", name), { recursive: true });
      writeFileSync(join(runtime, "node_modules", name, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
      writeFileSync(join(runtime, "node_modules", name, "index.js"), body);
    };
    mod(
      "sherpa-onnx-node",
      `module.exports = {
        OfflineTts: { createAsync: async () => ({ sampleRate: 16000, generateAsync: async (r) => ({ samples: Float32Array.from(r.generationConfig.phonemeCodepoints.flat(), (_, i) => (i % 2 ? 0.25 : -0.25)), sampleRate: 16000 }) }) },
        OfflineRecognizer: { createAsync: async (c) => ({
          createStream: () => { const s = { acceptWaveform(w) { s.n = w.samples.length; s.rate = w.sampleRate; s.float = w.samples instanceof Float32Array; } }; return s; },
          decodeAsync: async (s) => ({ text: "heard " + s.n + " at " + s.rate + (s.float ? " float" : "") + (c.modelConfig.nemoCtc ? " ctc" : "") }),
        }) },
      };`,
    );
    mod("piper-phonemize-node", `module.exports = { phonemize: (t, v) => [Array.from(t + "|" + v).map((c) => c.codePointAt(0))] };`);
    writeFileSync(join(runtime, "installed.json"), JSON.stringify({ packages: ["sherpa-onnx-node@1.0.0", "piper-phonemize-node@1.0.0"] }));
    const voice = VOICES[0];
    const stt = STT_MODELS[0];
    for (const m of [voice, stt]) {
      mkdirSync(join(data, "voice", "models", m.id), { recursive: true });
      for (const f of m.files) writeFileSync(join(data, "voice", "models", m.id, f), "x");
    }
    const e = new SpeechEngine({ dataDir: data, language: () => "ru", voice: () => ({}), sttProvider: () => "local" });
    e.sources = {
      ...e.sources,
      runtime: [
        { name: "sherpa-onnx-node", version: "1.0.0", size: 1, integrity: "" },
        { name: "piper-phonemize-node", version: "1.0.0", size: 1, integrity: "" },
      ],
    };
    try {
      const w = parseWav(await e.say("Да."));
      expect(w.sampleRate).toBe(16000);
      expect(w.samples.length).toBe(Array.from("Да.|ru").length);
      expect(await e.recognize(new Float32Array(3200), 16000)).toBe("heard 3200 at 16000 float ctc");
    } finally {
      e.stop();
    }
  });
});
