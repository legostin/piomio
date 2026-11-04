// A picture's small copy for the chat (picture-previews.ts): JPEG and PNG decoded in plain JavaScript, box-scaled to fit
// PREVIEW_SIDE, turned upright by the photo's EXIF orientation and encoded again. No native code, so it runs on every
// machine the hub ships to. Runs inside the preview worker (preview-worker.ts): decoding a big photo takes a while.

import jpeg from "jpeg-js";
import { PNG } from "pngjs";

/** The longest side of a preview, in pixels: a chat thumbnail is at most 18rem high, drawn at up to 3x. */
export const PREVIEW_SIDE = 720;
/** Larger pictures stay as they are (decoding one would take too much memory). */
export const MAX_PREVIEW_MEGAPIXELS = 64;
const JPEG_QUALITY = 78;

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, 4 bytes a pixel. */
  data: Uint8Array;
}

export interface Preview {
  data: Buffer;
  type: "image/jpeg" | "image/png";
  width: number;
  height: number;
}

/** The EXIF orientation of a JPEG (1–8), 1 when it has none or it cannot be read. */
export function jpegOrientation(buf: Uint8Array): number {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return 1;
  let p = 2;
  while (p + 4 <= buf.length && buf[p] === 0xff) {
    const marker = buf[p + 1];
    // Start of scan: the metadata is behind us.
    if (marker === 0xda) return 1;
    const len = (buf[p + 2] << 8) | buf[p + 3];
    if (len < 2) return 1;
    if (marker === 0xe1 && len >= 16 && String.fromCharCode(...buf.subarray(p + 4, p + 8)) === "Exif" && buf[p + 8] === 0 && buf[p + 9] === 0) {
      return tiffOrientation(buf.subarray(p + 10, p + 2 + len));
    }
    p += 2 + len;
  }
  return 1;
}

function tiffOrientation(t: Uint8Array): number {
  if (t.length < 8) return 1;
  const little = t[0] === 0x49 && t[1] === 0x49;
  if (!little && !(t[0] === 0x4d && t[1] === 0x4d)) return 1;
  const u16 = (o: number) => (o + 2 > t.length ? 0 : little ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]);
  const u32 = (o: number) => (o + 4 > t.length ? 0 : little ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)) >>> 0 : ((t[o] << 24) | (t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3]) >>> 0);
  const ifd = u32(4);
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) break;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

/** The size a picture of w×h scales to so its longest side is at most `side` (never larger than it is). */
export function fitSize(w: number, h: number, side = PREVIEW_SIDE): { width: number; height: number } {
  const k = Math.min(1, side / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** Each target pixel the average of the source pixels it covers (sharp and alias-free for downscaling). */
export function boxScale(src: Pixels, width: number, height: number): Pixels {
  if (width === src.width && height === src.height) return src;
  const out = new Uint8Array(width * height * 4);
  const sx = src.width / width;
  const sy = src.height / height;
  const acc = new Float64Array(width * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((y + 1) * sy)));
    acc.fill(0);
    for (let yy = y0; yy < y1; yy++) {
      const row = yy * src.width * 4;
      for (let x = 0; x < width; x++) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((x + 1) * sx)));
        let r = 0, g = 0, b = 0, a = 0;
        for (let xx = x0; xx < x1; xx++) {
          const i = row + xx * 4;
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          a += src.data[i + 3];
        }
        const o = x * 4;
        acc[o] += r;
        acc[o + 1] += g;
        acc[o + 2] += b;
        acc[o + 3] += a;
      }
    }
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((x + 1) * sx)));
      const n = (x1 - x0) * (y1 - y0);
      const o = x * 4;
      const d = (y * width + x) * 4;
      out[d] = Math.round(acc[o] / n);
      out[d + 1] = Math.round(acc[o + 1] / n);
      out[d + 2] = Math.round(acc[o + 2] / n);
      out[d + 3] = Math.round(acc[o + 3] / n);
    }
  }
  return { width, height, data: out };
}

/** The picture turned the way EXIF orientation `o` says it is meant to be seen. */
export function orient(src: Pixels, o: number): Pixels {
  if (o <= 1 || o > 8) return src;
  const { width: w, height: h } = src;
  const swap = o >= 5;
  const W = swap ? h : w;
  const H = swap ? w : h;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let X: number, Y: number;
      switch (o) {
        case 2: X = w - 1 - x; Y = y; break;
        case 3: X = w - 1 - x; Y = h - 1 - y; break;
        case 4: X = x; Y = h - 1 - y; break;
        case 5: X = y; Y = x; break;
        case 6: X = h - 1 - y; Y = x; break;
        case 7: X = h - 1 - y; Y = w - 1 - x; break;
        default: X = y; Y = w - 1 - x; break;
      }
      const s = (y * w + x) * 4;
      const d = (Y * W + X) * 4;
      out[d] = src.data[s];
      out[d + 1] = src.data[s + 1];
      out[d + 2] = src.data[s + 2];
      out[d + 3] = src.data[s + 3];
    }
  }
  return { width: W, height: H, data: out };
}

const opaque = (p: Pixels) => {
  for (let i = 3; i < p.data.length; i += 4) if (p.data[i] !== 255) return false;
  return true;
};

/** The preview of a JPEG or PNG file's bytes, or undefined when the picture is already small or cannot be read. */
export function makePreview(buf: Buffer, type: string): Preview | undefined {
  let pixels: Pixels;
  let orientation = 1;
  if (type === "image/jpeg") {
    orientation = jpegOrientation(buf);
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_PREVIEW_MEGAPIXELS, maxMemoryUsageInMB: 1024 });
    pixels = { width: img.width, height: img.height, data: img.data };
  } else if (type === "image/png") {
    const img = PNG.sync.read(buf);
    if (img.width * img.height > MAX_PREVIEW_MEGAPIXELS * 1e6) return undefined;
    pixels = { width: img.width, height: img.height, data: img.data };
  } else return undefined;
  const size = fitSize(pixels.width, pixels.height);
  if (size.width === pixels.width && orientation === 1) return undefined;
  const small = orient(boxScale(pixels, size.width, size.height), orientation);
  if (opaque(small)) {
    const data = jpeg.encode({ width: small.width, height: small.height, data: small.data }, JPEG_QUALITY).data;
    return { data: Buffer.from(data), type: "image/jpeg", width: small.width, height: small.height };
  }
  const png = new PNG({ width: small.width, height: small.height });
  png.data = Buffer.from(small.data);
  return { data: PNG.sync.write(png), type: "image/png", width: small.width, height: small.height };
}
