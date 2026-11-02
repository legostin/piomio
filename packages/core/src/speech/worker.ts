// The voice worker: its own process that loads the downloaded runtime (sherpa-onnx and the espeak-ng phonemizer, native
// code) and speaks and listens for the hub over IPC. A crash here costs the voice, not the hub; ending the process frees
// the models' memory. Started by engine.ts with the runtime's folder as its argument.

import { createRequire } from "node:module";
import { join } from "node:path";
import { SherpaBackend, type SttModel, type VoiceModel, type VoiceModules } from "./backend.ts";
import { encodeWav } from "./wav.ts";

export type WorkerRequest =
  | { id: number; op: "say"; voice: VoiceModel; text: string; speed: number }
  | { id: number; op: "recognize"; model: SttModel; samples: Float32Array; sampleRate: number };
export type WorkerReply = { id: number; wav?: Uint8Array; text?: string; error?: string };

const runtime = process.argv[2];
if (runtime && process.send) {
  const load = (): VoiceModules => {
    const req = createRequire(join(runtime, "noop.js"));
    return { sherpa: req("sherpa-onnx-node"), phonemize: req("piper-phonemize-node") };
  };
  const backend = new SherpaBackend(load);
  process.on("message", async (m: WorkerRequest) => {
    let reply: WorkerReply;
    try {
      if (m.op === "say") {
        const w = await backend.say(m.voice, m.text, m.speed);
        reply = { id: m.id, wav: encodeWav(w.samples, w.sampleRate) };
      } else {
        reply = { id: m.id, text: await backend.recognize(m.model, m.samples, m.sampleRate) };
      }
    } catch (e: any) {
      reply = { id: m.id, error: String(e?.message ?? e).slice(0, 2000) };
    }
    process.send?.(reply);
  });
  // The hub went away: so does the worker.
  process.on("disconnect", () => process.exit(0));
}
