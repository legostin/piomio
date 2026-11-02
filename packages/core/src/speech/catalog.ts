// What the local speech engine downloads, each piece pinned by its hash: the runtime's npm packages (sherpa-onnx, Apache-2.0,
// and since sherpa-onnx 2.0 the espeak-ng phonemizer Piper voices need, GPL-3.0, in their own process: worker.ts) and the
// models from the sherpa-onnx releases. Nothing here ships with the installers.

import type { Locale } from "@piomio/shared";

export const NPM_REGISTRY = "https://registry.npmjs.org";
export const MODEL_RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

/** An npm package of the runtime: its tarball's size in bytes and sha512 (the registry's `dist.integrity`). */
export interface RuntimePackage {
  name: string;
  version: string;
  size: number;
  integrity: string;
}

const SHERPA = "2.0.1";
const PHONEMIZE = "1.5.9";
/** By `<platform>-<arch>`, with win32 named "win" as the packages are: the tarball's bytes and integrity. */
const SHERPA_PLATFORM: Record<string, [number, string]> = {
  "darwin-arm64": [10013200, "sha512-agXmbbwiVPUSMViMhWhYAt59iG21ui7x6HxQFU35XzHOfQe9x6Pg9V160Pzak/66x0ePMjixsLUtMaaUrLfCwQ=="],
  "darwin-x64": [11167483, "sha512-SBnHa3LDOSI/5/rpBHGxKQDFq+yIdxowYY0InLzfojTUx+yGgqu7cYBrRxjzvHOiOKi0O4rmlFVZboyhIqpDgA=="],
  "linux-x64": [11005484, "sha512-w5mRRrIvPvcNWac7rQ8AN/t/cwElPGoRpH+ceCRBV7XfjCIQ9Rcr3Ig/kXcJLNOxgK4bGmef+Y47lIWiesDODw=="],
  "linux-arm64": [13822449, "sha512-5CJvLjFYIg23oELCsT7l07fMLT3PdquZ3tqh7KZK3Pzi+c2YiPKRe1DDUxoNdtCaw3ZiS4aQSQPBblB9JStuDA=="],
  "win-x64": [8779375, "sha512-7vwdAw9PGEb0JLSpK7UFxAdp1vabBHK9Nhw2jFRBWSFgtslUPHIB0T6syJfRgiUGyCeNW9fJvcFAk2F2u7hBEw=="],
};
const PHONEMIZE_PLATFORM: Record<string, [number, string]> = {
  "darwin-arm64": [255197, "sha512-H8ruvVPaiKOuYq/0o0fNGQyp6/YnNik1H0Zrg21b7vtH1GW30vkmEnkDLkWTvUgRSpFDMyGNdVVlubL4RhdZEw=="],
  "darwin-x64": [260333, "sha512-95gLmObT+WuNpQcyJip66s2nSOrsQkzsg1FazGmMVeV4JwZQVt8YUPpww6v4oXhqH4j4yd4/TBknvVRGC0ZiTw=="],
  "linux-x64": [323043, "sha512-e8xcuH1fOhPwd16BmZ6QBrG5C4jB9kWJPBny6EJkUb/9lZ0cgEdiQfIyV9hT2/Tow83vChJefvgRcopbOxzTfA=="],
  "linux-arm64": [314834, "sha512-Ex9kOtTPR0t0PzLAEiL6aLc8GbRbVpPk+t5oIgnE8SOZavUOI24WKvRR5C+fdpCAgOVctVMrYYIl6ppLv8C0Lg=="],
  "win-x64": [459931, "sha512-ld6F+SsxPJuzkF+pWKz/NiL/7KRNH3yCAv5CcDQTsvdGGfb9tNexPxsz3jCM1iRqHlCcFcW3CZhDSC5huANHHw=="],
};

/** The runtime's packages for this computer, or undefined where none are published (e.g. Windows on ARM). */
export function runtimePackages(platform: string = process.platform, arch: string = process.arch): RuntimePackage[] | undefined {
  const pa = `${platform === "win32" ? "win" : platform}-${arch}`;
  const sherpa = SHERPA_PLATFORM[pa];
  const phonemize = PHONEMIZE_PLATFORM[pa];
  if (!sherpa || !phonemize) return undefined;
  return [
    { name: "sherpa-onnx-node", version: SHERPA, size: 12709, integrity: "sha512-1PSACfQgPXAD7ExwCv1QW09EXTjcNlpZKBqDY+jxSdIzlyOSq0M13SILBoUQUfeJqiTTXnqp6Ha9jjMUQ6efXg==" },
    { name: `sherpa-onnx-${pa}`, version: SHERPA, size: sherpa[0], integrity: sherpa[1] },
    { name: "piper-phonemize-node", version: PHONEMIZE, size: 9089073, integrity: "sha512-IpGK1jqf3LwB47lHSjvu9jz8n9ayVGNc9OnC/gMcIH5gHS+q7Mxw46158bj36mtd4QRKMsF8f5mSEPdtoSP56w==" },
    { name: `piper-phonemize-${pa}`, version: PHONEMIZE, size: phonemize[0], integrity: phonemize[1] },
  ];
}

export function tarballUrl(registry: string, p: RuntimePackage): string {
  return `${registry.replace(/\/+$/, "")}/${p.name}/-/${p.name}-${p.version}.tgz`;
}

/** A model archive in the sherpa-onnx releases: `<releases>/<tag>/<asset>`, one top folder holding `files`. */
export interface ModelSpec {
  id: string;
  tag: "tts-models" | "asr-models";
  asset: string;
  /** Bytes of the archive and its sha256 (GitHub's asset digest). */
  size: number;
  sha256: string;
  /** The license of the model's data, as its model card gives it. */
  license: string;
  /** Files the engine needs, relative to the model's folder: all must be there after extracting. */
  files: string[];
}

/** A Piper voice (VITS, int8): the model and its tokens; espeak-ng's voice turns text into its phonemes. */
export interface VoiceSpec extends ModelSpec {
  tag: "tts-models";
  lang: string;
  gender: "male" | "female";
  model: string;
  espeak: string;
}

/** A speech-to-text model: NeMo CTC (one model file) or a NeMo transducer (encoder, decoder, joiner). */
export interface SttSpec extends ModelSpec {
  tag: "asr-models";
  /** The languages it hears. */
  langs: string[];
  kind: "nemo_ctc" | "nemo_transducer";
}

const piper = (id: string, lang: string, gender: "male" | "female", base: string, size: number, sha256: string, license: string, espeak: string): VoiceSpec => ({
  id,
  tag: "tts-models",
  asset: `vits-piper-${base}-int8.tar.bz2`,
  size,
  sha256,
  license,
  lang,
  gender,
  model: `${base}.onnx`,
  espeak,
  files: [`${base}.onnx`, "tokens.txt"],
});

export const VOICES: VoiceSpec[] = [
  piper("piper-ru-dmitri", "ru", "male", "ru_RU-dmitri-medium", 21129441, "7636793307f634ce54c6e65528a91a61683114f1a6635a08caf64ba6c54e6a63", "CC0", "ru"),
  piper("piper-ru-denis", "ru", "male", "ru_RU-denis-medium", 21058905, "d710e29eb7854c42461d16d65d3cef753cc559639ca75806edc75ba71f23af66", "CC0", "ru"),
  piper("piper-ru-irina", "ru", "female", "ru_RU-irina-medium", 21149417, "b0000a509f7551a80742eed5c43b8eb03f469cb9f0a42f6feee96ce0da0ebab8", "unknown", "ru"),
  piper("piper-en-ryan", "en", "male", "en_US-ryan-medium", 21083446, "376eb489d42e98cb49f0e13a633e8d88580bd247ed8aacc298a733210404f771", "CC BY-NC-SA 4.0", "en-us"),
  piper("piper-en-amy", "en", "female", "en_US-amy-medium", 21028122, "bd23c0aa629eb3719448582f45ede49e8fa6a679061fed5eab16a6a6fd8e7e82", "unknown", "en-us"),
];

export const STT_MODELS: SttSpec[] = [
  {
    id: "giga-am-v3-ru",
    tag: "asr-models",
    asset: "sherpa-onnx-nemo-ctc-punct-giga-am-v3-russian-2025-12-16.tar.bz2",
    size: 163282594,
    sha256: "20e41e160efa6f2460a7ef6554cdbbb9e8fffb2b92e6bc708e9406bd8b9256ea",
    license: "MIT",
    langs: ["ru"],
    kind: "nemo_ctc",
    files: ["model.int8.onnx", "tokens.txt"],
  },
  {
    id: "parakeet-v3",
    tag: "asr-models",
    asset: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
    size: 487170055,
    sha256: "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf",
    license: "CC BY 4.0",
    // 25 European languages.
    langs: ["bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "hr", "hu", "it", "lt", "lv", "mt", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "uk"],
    kind: "nemo_transducer",
    files: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
  },
];

/** The voices and models the engine offers and where they come from (tests swap in their own servers and archives). */
export interface SpeechSources {
  registry: string;
  releases: string;
  /** Undefined: no runtime for this computer. */
  runtime: RuntimePackage[] | undefined;
  voices: VoiceSpec[];
  stt: SttSpec[];
}

export function defaultSources(): SpeechSources {
  return { registry: NPM_REGISTRY, releases: MODEL_RELEASES, runtime: runtimePackages(), voices: VOICES, stt: STT_MODELS };
}

export function modelUrl(releases: string, m: ModelSpec): string {
  return `${releases.replace(/\/+$/, "")}/${m.tag}/${m.asset}`;
}

/** The voice speech starts with in a hub language: Dmitri for Russian, Ryan otherwise. */
export function defaultVoice(lang: Locale | string, voices: VoiceSpec[] = VOICES): VoiceSpec {
  return voices.find((v) => v.lang === lang) ?? voices.find((v) => v.lang === "en") ?? voices[0];
}

/** The local speech-to-text model for a hub language: GigaAM v3 for Russian, Parakeet v3 otherwise. */
export function defaultSttModel(lang: Locale | string, models: SttSpec[] = STT_MODELS): SttSpec {
  return models.find((m) => m.langs.length === 1 && m.langs[0] === lang) ?? models.find((m) => m.langs.includes(lang)) ?? models[models.length - 1];
}
