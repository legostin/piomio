// The local speech engine's pieces that need no engine: WAV, the catalog, and the downloads (a fake registry and release
// server on 127.0.0.1 serving small archives made here with the system's tar).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSttModel, defaultVoice, runtimePackages, STT_MODELS, VOICES, type RuntimePackage, type VoiceSpec } from "../src/speech/catalog.ts";
import { encodeWav, isWav, parseWav } from "../src/speech/wav.ts";
import { download, DOWNLOAD, installModel, installRuntime, InstallError, modelInstalled, runtimeInstalled, sweepPartial, type Progress } from "../src/speech/install.ts";
import { createServer } from "node:http";
import { fileServer, modelArchive, npmTarball, sha256, sri } from "./speech-fixtures.ts";

describe("WAV", () => {
  it("writes 16-bit mono and reads it back", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
    const wav = encodeWav(samples, 22050);
    expect(isWav(wav)).toBe(true);
    expect(wav.length).toBe(44 + samples.length * 2);
    const back = parseWav(wav);
    expect(back.sampleRate).toBe(22050);
    expect(back.samples.length).toBe(samples.length);
    for (let i = 0; i < samples.length; i++) expect(back.samples[i]).toBeCloseTo(samples[i], 3);
  });

  it("mixes stereo to mono, skips other chunks, reads float and refuses what is not WAV", () => {
    // 2 channels, 16-bit, with a LIST chunk before the data.
    const frames = [
      [0.5, -0.5],
      [1, 1],
    ];
    const data = Buffer.alloc(frames.length * 4);
    frames.forEach(([l, r], i) => {
      data.writeInt16LE(Math.round(l * 0x7fff), i * 4);
      data.writeInt16LE(Math.round(r * 0x7fff), i * 4 + 2);
    });
    const list = Buffer.from("LIST\x03\x00\x00\x00abc\x00", "latin1"); // odd size, padded
    const fmt = Buffer.alloc(24);
    fmt.write("fmt ", 0, "ascii");
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt16LE(1, 8);
    fmt.writeUInt16LE(2, 10);
    fmt.writeUInt32LE(16000, 12);
    fmt.writeUInt32LE(64000, 16);
    fmt.writeUInt16LE(4, 20);
    fmt.writeUInt16LE(16, 22);
    const head = Buffer.alloc(12);
    head.write("RIFF", 0, "ascii");
    head.writeUInt32LE(4 + fmt.length + list.length + 8 + data.length, 4);
    head.write("WAVE", 8, "ascii");
    const dataHead = Buffer.alloc(8);
    dataHead.write("data", 0, "ascii");
    dataHead.writeUInt32LE(data.length, 4);
    const w = parseWav(Buffer.concat([head, fmt, list, dataHead, data]));
    expect(w.sampleRate).toBe(16000);
    expect(Array.from(w.samples).map((x) => Math.round(x * 100) / 100)).toEqual([0, 1]);

    const f32 = Buffer.from(encodeWav(new Float32Array(2), 8000));
    f32.writeUInt16LE(3, 20);
    f32.writeUInt16LE(32, 34);
    f32.writeUInt32LE(4, 40);
    f32.writeFloatLE(0.75, 44);
    expect(parseWav(f32.subarray(0, 48)).samples[0]).toBeCloseTo(0.75);

    expect(() => parseWav(Buffer.from("OggS not a wav"))).toThrow(/not a WAV/);
    const alaw = Buffer.from(encodeWav(new Float32Array(4), 8000));
    alaw.writeUInt16LE(6, 20);
    expect(() => parseWav(alaw)).toThrow(/not supported/);
  });
});

describe("speech catalog", () => {
  it("picks voices and speech-to-text by the hub language", () => {
    expect(defaultVoice("ru").id).toBe("piper-ru-dmitri");
    expect(defaultVoice("en").id).toBe("piper-en-ryan");
    expect(defaultVoice("de").id).toBe("piper-en-ryan");
    expect(defaultSttModel("ru").id).toBe("giga-am-v3-ru");
    expect(defaultSttModel("en").id).toBe("parakeet-v3");
    expect(defaultSttModel("ja").id).toBe("parakeet-v3");
    expect(new Set(VOICES.map((v) => v.id)).size).toBe(VOICES.length);
    for (const m of [...VOICES, ...STT_MODELS]) {
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.asset).toMatch(/\.tar\.bz2$/);
    }
  });

  it("has a runtime for the computers sherpa-onnx publishes, none elsewhere", () => {
    expect(runtimePackages("darwin", "arm64")!.map((p) => p.name)).toEqual(["sherpa-onnx-node", "sherpa-onnx-darwin-arm64", "piper-phonemize-node", "piper-phonemize-darwin-arm64"]);
    expect(runtimePackages("win32", "x64")!.map((p) => p.name)).toContain("sherpa-onnx-win-x64");
    expect(runtimePackages("linux", "arm64")!.every((p) => /^sha512-/.test(p.integrity) && p.size > 0)).toBe(true);
    expect(runtimePackages("win32", "arm64")).toBeUndefined();
    expect(runtimePackages("freebsd", "x64")).toBeUndefined();
  });
});

describe("speech downloads", () => {
  let dir: string;
  let srv: Awaited<ReturnType<typeof fileServer>>;
  let pkgs: RuntimePackage[];
  let voice: VoiceSpec;
  const files = new Map<string, Buffer>();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "owl-speech-"));
    pkgs = (["sherpa-onnx-node", "piper-phonemize-node"] as const).map((name) => {
      const tgz = npmTarball(dir, name, "1.0.0");
      files.set(`/${name}/-/${name}-1.0.0.tgz`, tgz);
      return { name, version: "1.0.0", size: tgz.length, integrity: sri(tgz) };
    });
    const archive = modelArchive(dir, "vits-piper-ru_RU-dmitri-medium-int8", ["ru_RU-dmitri-medium.onnx", "tokens.txt"]);
    voice = { ...VOICES[0], size: archive.length, sha256: sha256(archive) };
    files.set(`/tts-models/${voice.asset}`, archive);
    srv = await fileServer(files);
  });
  afterAll(() => srv.server.close());

  it("installs the runtime's packages side by side, reporting progress over all of them", async () => {
    const root = join(dir, "a", "voice", "runtime");
    mkdirSync(join(dir, "a", "voice"), { recursive: true });
    expect(runtimeInstalled(root, pkgs)).toBe(false);
    const seen: Progress[] = [];
    await installRuntime(root, pkgs, srv.url, (p) => seen.push(p));
    expect(runtimeInstalled(root, pkgs)).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "node_modules", "piper-phonemize-node", "package.json"), "utf8")).name).toBe("piper-phonemize-node");
    const total = pkgs[0].size + pkgs[1].size;
    expect(seen.at(-1)).toEqual({ received: total, total });
    expect(seen.length).toBeGreaterThan(2);
    // Nothing temporary is left next to it.
    expect(readdirSync(join(dir, "a", "voice"))).toEqual(["runtime"]);
    // Another version is not this one.
    expect(runtimeInstalled(root, [{ ...pkgs[0], version: "2.0.0" }])).toBe(false);
  });

  it("refuses a package whose checksum is wrong and leaves nothing installed", async () => {
    const root = join(dir, "b", "runtime");
    mkdirSync(join(dir, "b"), { recursive: true });
    const bad = [pkgs[0], { ...pkgs[1], integrity: sri(Buffer.from("something else")) }];
    const err = await installRuntime(root, bad, srv.url).catch((e) => e);
    expect(err).toBeInstanceOf(InstallError);
    expect(err.reason).toBe("integrity");
    expect(err.message).toMatch(/does not match its pinned checksum/);
    expect(existsSync(root)).toBe(false);
    expect(readdirSync(join(dir, "b"))).toEqual([]);
    // A size that differs fails the same way; a missing file is a download error.
    expect((await installRuntime(root, [{ ...pkgs[0], size: pkgs[0].size + 10 }], srv.url).catch((e) => e)).reason).toBe("integrity");
    expect((await installRuntime(root, [{ ...pkgs[0], name: "missing-pkg" }], srv.url).catch((e) => e)).message).toMatch(/answered 404/);
    expect((await installRuntime(root, pkgs, "http://127.0.0.1:1").catch((e) => e)).message).toMatch(/127\.0\.0\.1:1 is unreachable/);
    expect(readdirSync(join(dir, "b"))).toEqual([]);
  });

  it("unpacks a model into its folder, and refuses a wrong archive", async () => {
    const models = join(dir, "c", "models");
    mkdirSync(models, { recursive: true });
    const place = join(models, voice.id);
    const seen: Progress[] = [];
    await installModel(place, voice, srv.url, (p) => seen.push(p));
    expect(modelInstalled(place, voice)).toBe(true);
    expect(readFileSync(join(place, "tokens.txt"), "utf8")).toBe("fake tokens.txt");
    expect(seen.at(-1)).toEqual({ received: voice.size, total: voice.size });
    expect(readdirSync(models)).toEqual([voice.id]);

    const other = join(models, "other");
    expect((await installModel(other, { ...voice, sha256: "0".repeat(64) }, srv.url).catch((e) => e)).reason).toBe("integrity");
    // The right archive without the files the engine needs.
    const missing = await installModel(other, { ...voice, files: ["voice.onnx"] }, srv.url).catch((e) => e);
    expect(missing.reason).toBe("extract");
    expect(missing.message).toMatch(/has no voice\.onnx/);
    expect(readdirSync(models)).toEqual([voice.id]);
  });

  it("goes on from where a dropped download stopped, and starts over when the server ignores the range", async () => {
    const body = Buffer.alloc(200_000, 7);
    for (let i = 0; i < body.length; i++) body[i] = (i * 31) % 251;
    const ranges: string[] = [];
    let honour = true;
    let drops = 0;
    const server = createServer((req, res) => {
      const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
      ranges.push(req.headers.range ?? "");
      const from = range && honour ? Number(range[1]) : 0;
      res.writeHead(from ? 206 : 200, { "content-length": body.length - from });
      // The first answer breaks off midway, as a stalled CDN does.
      if (drops < 1) {
        drops++;
        res.write(body.subarray(from, from + 80_000));
        setTimeout(() => res.destroy(), 20);
        return;
      }
      res.end(body.subarray(from));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/big`;
    const was = { ...DOWNLOAD };
    DOWNLOAD.pauseMs = 5;
    try {
      const file = join(dir, "big.bin");
      await download(url, file, { size: body.length, sha256: sha256(body) });
      expect(readFileSync(file).equals(body)).toBe(true);
      expect(ranges[0]).toBe("");
      expect(ranges[1]).toMatch(/^bytes=\d+-$/);
      // A server that sends the whole file again: the download starts over and still checks out.
      honour = false;
      drops = 0;
      ranges.length = 0;
      await download(url, file, { size: body.length, sha256: sha256(body) });
      expect(readFileSync(file).equals(body)).toBe(true);
      expect(ranges).toHaveLength(2);
    } finally {
      Object.assign(DOWNLOAD, was);
      server.close();
    }
  });

  it("sweeps what a stopped download left", () => {
    const d = join(dir, "d");
    mkdirSync(join(d, "runtime.part-0123abcd"), { recursive: true });
    mkdirSync(join(d, "models"), { recursive: true });
    sweepPartial(d);
    expect(readdirSync(d)).toEqual(["models"]);
  });
});
