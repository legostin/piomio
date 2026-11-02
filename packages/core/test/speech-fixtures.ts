// Test helpers for the local speech engine: small archives made with the system's tar, a file server on 127.0.0.1, and a
// fake sherpa-onnx + phonemizer pair (plain JS; the real native engine never runs in tests).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { VoiceModules } from "../src/speech/backend.ts";
import { STT_MODELS, VOICES, type ModelSpec, type RuntimePackage, type SpeechSources } from "../src/speech/catalog.ts";

export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
export const sri = (b: Buffer) => `sha512-${createHash("sha512").update(b).digest("base64")}`;

/** An npm tarball: package/ with a package.json and an index.js. */
export function npmTarball(dir: string, name: string, version: string): Buffer {
  const src = mkdtempSync(join(dir, "pkg-"));
  mkdirSync(join(src, "package"));
  writeFileSync(join(src, "package", "package.json"), JSON.stringify({ name, version, main: "index.js" }));
  writeFileSync(join(src, "package", "index.js"), `module.exports = { name: ${JSON.stringify(name)} };`);
  const out = join(dir, `${name}-${version}.tgz`);
  execFileSync("tar", ["czf", out, "-C", src, "package"]);
  return readFileSync(out);
}

/** A model archive like the sherpa-onnx releases': one top folder with the files. */
export function modelArchive(dir: string, top: string, files: string[]): Buffer {
  const src = mkdtempSync(join(dir, "model-"));
  mkdirSync(join(src, top));
  for (const f of files) writeFileSync(join(src, top, f), `fake ${f}`);
  writeFileSync(join(src, top, "MODEL_CARD"), "card");
  const out = join(dir, `${top}.tar.bz2`);
  execFileSync("tar", ["cjf", out, "-C", src, top]);
  return readFileSync(out);
}

/** Serves `files` by path (in two writes, so progress has something to count); records the paths asked for. */
export function fileServer(files: Map<string, Buffer>): Promise<{ url: string; server: Server; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const body = files.get(req.url ?? "");
    if (!body) return res.writeHead(404).end("nope");
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length });
    res.write(body.subarray(0, Math.floor(body.length / 2)));
    setTimeout(() => res.end(body.subarray(Math.floor(body.length / 2))), 5);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${(server.address() as any).port}`, server, hits })));
}

/**
 * The catalog with small archives on a fake server: two runtime packages, the voices and speech-to-text models named
 * (the others keep their real pins and are not served).
 */
export async function fakeSources(dir: string, voiceIds: string[] = ["piper-ru-dmitri", "piper-en-ryan"], sttIds: string[] = ["giga-am-v3-ru", "parakeet-v3"]) {
  const files = new Map<string, Buffer>();
  const runtime: RuntimePackage[] = (["sherpa-onnx-node", "piper-phonemize-node"] as const).map((name) => {
    const tgz = npmTarball(dir, name, "9.9.9");
    files.set(`/${name}/-/${name}-9.9.9.tgz`, tgz);
    return { name, version: "9.9.9", size: tgz.length, integrity: sri(tgz) };
  });
  const model = <T extends ModelSpec>(m: T): T => {
    const a = modelArchive(dir, m.asset.replace(/\.tar\.bz2$/, ""), m.files);
    files.set(`/${m.tag}/${m.asset}`, a);
    return { ...m, size: a.length, sha256: sha256(a) };
  };
  const voices = VOICES.map((v) => (voiceIds.includes(v.id) ? model(v) : v));
  const stt = STT_MODELS.map((m) => (sttIds.includes(m.id) ? model(m) : m));
  const srv = await fileServer(files);
  const sources: SpeechSources = { registry: srv.url, releases: srv.url, runtime, voices, stt };
  return { srv, sources, files };
}

export interface FakeCalls {
  tts: any[];
  generate: any[];
  phonemize: Array<{ text: string; voice: string }>;
  recognizer: any[];
  waves: Array<{ samples: Float32Array; sampleRate: number }>;
}

/** sherpa-onnx and piper-phonemize as the engine uses them: speech is a ramp of samples, hearing returns `heard`. */
export function fakeModules(heard = "привет, это тест"): { modules: VoiceModules; calls: FakeCalls } {
  const calls: FakeCalls = { tts: [], generate: [], phonemize: [], recognizer: [], waves: [] };
  const modules: VoiceModules = {
    sherpa: {
      OfflineTts: {
        createAsync: async (config: any) => {
          calls.tts.push(config);
          return {
            sampleRate: 22050,
            generateAsync: async (req: any) => {
              calls.generate.push(req);
              const n = req.generationConfig.phonemeCodepoints.flat().length;
              return { samples: Float32Array.from({ length: n }, (_, i) => (i % 2 ? 0.5 : -0.5)), sampleRate: 22050 };
            },
          };
        },
      },
      OfflineRecognizer: {
        createAsync: async (config: any) => {
          calls.recognizer.push(config);
          return {
            createStream: () => {
              const wave = { samples: new Float32Array(), sampleRate: 0 };
              return {
                acceptWaveform: (w: { samples: Float32Array; sampleRate: number }) => {
                  wave.samples = w.samples;
                  wave.sampleRate = w.sampleRate;
                  calls.waves.push(wave);
                },
              };
            },
            decodeAsync: async () => ({ text: ` ${heard} ` }),
          };
        },
      },
    },
    phonemize: {
      phonemize: (text: string, voice: string) => {
        calls.phonemize.push({ text, voice });
        return text.split(/(?<=[.!?])\s+/).map((s) => Array.from(s).map((c) => c.codePointAt(0)!));
      },
    },
  };
  return { modules, calls };
}
