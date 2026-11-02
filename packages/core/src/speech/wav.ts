// WAV in and out of the local speech engine: what the overlay records (16 kHz mono, 16-bit PCM) and what the voices say.
// Errors are English text for the model and the logs.

export interface Wave {
  /** Mono samples in [-1, 1]. */
  samples: Float32Array;
  sampleRate: number;
}

export class WavError extends Error {}

/** Whether the bytes are a RIFF/WAVE file. */
export function isWav(buf: Uint8Array): boolean {
  return buf.length >= 12 && ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WAVE";
}

/** Mono 16-bit PCM WAV of the samples. */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] || 0));
    out.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return out;
}

/** The samples of a PCM (8/16/24/32-bit) or 32-bit float WAV, channels mixed to mono. */
export function parseWav(input: Uint8Array): Wave {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!isWav(buf)) throw new WavError("not a WAV file");
  let fmt: { format: number; channels: number; rate: number; bits: number } | undefined;
  let data: Buffer | undefined;
  for (let at = 12; at + 8 <= buf.length; ) {
    const id = ascii(buf, at, 4);
    // A recorder that streamed the file may leave the size unset (0 or 0xFFFFFFFF): the data runs to the end.
    let size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "data" && (size === 0 || size === 0xffffffff || body + size > buf.length)) size = buf.length - body;
    if (body + size > buf.length) break;
    if (id === "fmt ") {
      if (size < 16) throw new WavError("the WAV format chunk is too short");
      let format = buf.readUInt16LE(body);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID.
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24);
      fmt = { format, channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      data = buf.subarray(body, body + size);
      break;
    }
    at = body + size + (size % 2);
  }
  if (!fmt) throw new WavError("the WAV file has no format chunk");
  if (!data) throw new WavError("the WAV file has no audio data");
  const { format, channels, rate, bits } = fmt;
  if (!channels || !rate) throw new WavError("the WAV file has no channels or sample rate");
  const pcm = format === 1 && [8, 16, 24, 32].includes(bits);
  const float = format === 3 && bits === 32;
  if (!pcm && !float) throw new WavError(`the WAV encoding is not supported (format ${format}, ${bits}-bit): use 16-bit PCM`);
  const width = bits / 8;
  const frames = Math.floor(data.length / (width * channels));
  const read = (o: number): number => {
    if (float) return data.readFloatLE(o);
    if (bits === 8) return (data[o] - 128) / 128;
    if (bits === 16) return data.readInt16LE(o) / 0x8000;
    if (bits === 24) return data.readIntLE(o, 3) / 0x800000;
    return data.readInt32LE(o) / 0x80000000;
  };
  const samples = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read((f * channels + c) * width);
    samples[f] = sum / channels;
  }
  return { samples, sampleRate: rate };
}

function ascii(buf: Uint8Array, at: number, len: number): string {
  return String.fromCharCode(...buf.subarray(at, at + len));
}
