// The local speech engine through a running hub: GET /api/speech, POST /api/speech/{install,say,transcribe}, the voice
// settings, the core methods for plugins, the realtime event and the default agent's tools. The engine's downloads come
// from a fake registry and release server; a fake sherpa-onnx and phonemizer run in place of the native engine.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeechStatus } from "@piomio/shared";
import { freePort } from "@piomio/testkit";
import { Hub, loadConfig } from "../src/index.ts";
import { createCoreCall } from "../src/core-call.ts";
import { toUiEvent } from "../src/bus.ts";
import { encodeWav, parseWav } from "../src/speech/wav.ts";
import { fakeModules, fakeSources } from "./speech-fixtures.ts";

const fixtures = join(import.meta.dirname, "fixtures");

describe("speech API", () => {
  let hub: Hub;
  let base: string;
  let cookie = "";
  let csrf = "";
  let fake: Awaited<ReturnType<typeof fakeSources>>;
  const events: SpeechStatus[] = [];

  const call = async (method: string, path: string, body?: unknown, type = "application/json") => {
    const r = await fetch(base + path, {
      method,
      headers: { origin: base, cookie, ...(csrf ? { "x-csrf": csrf } : {}), ...(body !== undefined ? { "content-type": type } : {}) },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body),
    });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const buf = Buffer.from(await r.arrayBuffer());
    let json: any;
    try {
      json = JSON.parse(buf.toString("utf8"));
    } catch {
      json = undefined;
    }
    return { status: r.status, type: r.headers.get("content-type") ?? "", buf, json };
  };

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const dir = mkdtempSync(join(tmpdir(), "owl-speech-api-"));
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: join(dir, "data"), builtinPluginsDirs: [], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    hub.bus.on("speech.status", (s) => events.push(s));
    base = config.publicUrl;
    expect((await call("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "speech-api-pass-1" })).status).toBe(200);
    csrf = (await call("GET", "/api/bootstrap")).json.csrf;
    fake = await fakeSources(dir, ["piper-en-ryan", "piper-en-amy"], ["parakeet-v3"]);
  });

  afterAll(async () => {
    await hub?.stop();
    fake?.srv.server.close();
  });

  it("says what is there, and that nothing can speak or hear yet", async () => {
    const s = await call("GET", "/api/speech");
    expect(s.status).toBe(200);
    expect(s.json).toMatchObject({ runtime: "missing", voice: "piper-en-ryan", speed: 1, stt: { provider: "auto", local: { model: "parakeet-v3", installed: false } } });
    expect(s.json.voices.map((v: any) => v.id)).toEqual(["piper-ru-dmitri", "piper-ru-denis", "piper-ru-irina", "piper-en-ryan", "piper-en-amy"]);
    const say = await call("POST", "/api/speech/say", { text: "Hello" });
    expect(say.status).toBe(409);
    expect(say.json.error).toMatch(/^The voice Ryan is not installed yet/);
    const heard = await call("POST", "/api/speech/transcribe", encodeWav(new Float32Array(160), 16000), "audio/wav");
    expect(heard.status).toBe(503);
    expect(heard.json.error).toBe("No speech-to-text is set up");
    // State-changing calls need the CSRF token like every other.
    const saved = csrf;
    csrf = "";
    expect((await call("POST", "/api/speech/install", {})).status).toBe(403);
    csrf = saved;
  });

  it("installs in the background and speaks a WAV", async () => {
    hub.speech.sources = fake.sources;
    const f = fakeModules();
    hub.speech.modules = () => f.modules;
    const started = await call("POST", "/api/speech/install", {});
    expect(started.status).toBe(200);
    expect(started.json.runtime).toBe("downloading");
    await hub.speech.settled();
    const s = (await call("GET", "/api/speech")).json as SpeechStatus;
    expect(s.runtime).toBe("ready");
    expect(s.voices.find((v) => v.id === "piper-en-ryan")!.installed).toBe(true);
    expect(events.some((e) => e.downloading?.item === "runtime")).toBe(true);
    expect(events.at(-1)!.runtime).toBe("ready");
    // What the apps get over the socket.
    expect(toUiEvent("speech.status", s)).toEqual({ type: "speech.status", status: s, data: s });

    const said = await call("POST", "/api/speech/say", { text: "**Hello** there." });
    expect(said.status).toBe(200);
    expect(said.type).toBe("audio/wav");
    expect(parseWav(said.buf).samples.length).toBe("Hello there.".length);
    expect(f.calls.phonemize.at(-1)).toEqual({ text: "Hello there.", voice: "en-us" });
    expect((await call("POST", "/api/speech/say", { text: "Hi", voice: "robot" })).status).toBe(400);
    expect((await call("POST", "/api/speech/install", { voice: "robot" })).json.error).toBe("There is no voice robot");
  });

  it("transcribes a WAV phrase with the local engine once it is installed", async () => {
    const f = fakeModules("hello from the overlay");
    hub.speech.modules = () => f.modules;
    await call("POST", "/api/speech/install", { stt: true });
    await hub.speech.settled();
    expect((await call("GET", "/api/speech")).json.stt.local.installed).toBe(true);
    expect((await call("GET", "/api/transcription")).json.engine).toEqual({ label: "sherpa-onnx", model: "parakeet-v3" });
    const heard = await call("POST", "/api/speech/transcribe", encodeWav(new Float32Array(16000).fill(0.1), 16000), "audio/wav");
    expect(heard.status).toBe(200);
    expect(heard.json).toEqual({ text: "hello from the overlay" });
    expect(f.calls.waves[0].sampleRate).toBe(16000);
    const notWav = await call("POST", "/api/speech/transcribe", Buffer.from("OggS not a wav"), "audio/wav");
    expect(notWav.status).toBe(502);
    expect(notWav.json.error).toMatch(/^Speech recognition failed: the local engine reads WAV/);
  });

  it("keeps the voice settings, checked", async () => {
    const bad = await call("PATCH", "/api/settings", { voice: { voice: "robot" } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/^Voice settings are wrong: voice\.voice must be one of/);
    expect((await call("PATCH", "/api/settings", { voice: { speed: 9 } })).status).toBe(400);
    const ok = await call("PATCH", "/api/settings", { voice: { voice: "piper-en-amy", speed: 1.2 } });
    expect(ok.json.voice).toEqual({ voice: "piper-en-amy", speed: 1.2 });
    expect((await call("GET", "/api/speech")).json).toMatchObject({ voice: "piper-en-amy", speed: 1.2 });
    expect(events.at(-1)!.voice).toBe("piper-en-amy");
    // Amy is not installed yet.
    expect((await call("POST", "/api/speech/say", { text: "Hi" })).status).toBe(409);
    expect((await call("PATCH", "/api/settings", { transcription: { provider: "local" } })).json.transcription).toEqual({ provider: "local" });
    expect((await call("GET", "/api/speech")).json.stt.provider).toBe("local");
  });

  it("gives plugins the same through the core methods, and the default agent its tools", async () => {
    const core = createCoreCall(hub);
    expect(((await core("pio", "speech.status", {})) as SpeechStatus).voice).toBe("piper-en-amy");
    const s = (await core("pio", "speech.install", { voice: "piper-en-amy" })) as SpeechStatus;
    expect(s.downloading).toEqual({ item: "piper-en-amy", received: 0, total: fake.sources.voices.find((v) => v.id === "piper-en-amy")!.size });
    await hub.speech.settled();
    expect((await call("POST", "/api/speech/say", { text: "Hi" })).status).toBe(200);

    const agent = hub.settings.get().defaultAgent;
    const session = hub.store.createSession({ conversationId: hub.store.agentConversation(agent).id, agentId: agent, brainRef: "fake@local", background: false }).row.id;
    const text = (r: any) => r.content.map((c: any) => c.text).join("");
    const status = text(await hub.gateway.call(session, "hub_speech_status", {}));
    expect(status).toMatch(/^Engine: installed\./);
    expect(status).toContain("piper-en-amy (Amy, en, female");
    expect(status).toContain("the local model parakeet-v3");
    expect(text(await hub.gateway.call(session, "hub_settings_update", { patch: { voice: { speed: 0.8 } } }))).toMatch(/Settings updated: voice=/);
    expect(text(await hub.gateway.call(session, "hub_settings_update", { patch: { transcription: { provider: "custom", baseUrl: "http://evil.example/v1", model: "m" } } }))).toMatch(
      /^Refused: a custom speech-to-text server/,
    );
    expect(hub.settings.get().transcription).toEqual({ provider: "local" });
  });
});
