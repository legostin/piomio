// Small copies of chat pictures (src/picture-previews.ts, src/preview-image.ts): scaled to fit, upright, kept on disk.
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { PicturePreviews } from "../src/picture-previews.ts";
import { boxScale, fitSize, jpegOrientation, makePreview, orient, PREVIEW_SIDE } from "../src/preview-image.ts";

/** A w×h picture, left half red and right half blue, with random noise so it does not compress to nothing. */
function pixels(w: number, h: number, alpha = 255): Buffer {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const n = Math.floor(Math.random() * 40);
      data[i] = x < w / 2 ? 215 + n : n;
      data[i + 1] = n;
      data[i + 2] = x < w / 2 ? n : 215 + n;
      data[i + 3] = alpha;
    }
  return data;
}

const jpg = (w: number, h: number) => Buffer.from(jpeg.encode({ width: w, height: h, data: pixels(w, h) }, 92).data);

/** The JPEG with an EXIF block saying it is to be turned (orientation 6: 90° clockwise). */
function withOrientation(buf: Buffer, o: number): Buffer {
  const tiff = Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const seg = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  return Buffer.concat([buf.subarray(0, 2), seg, buf.subarray(2)]);
}

describe("a picture's preview", () => {
  it("fits the longest side and keeps the proportions", () => {
    expect(fitSize(4000, 3000)).toEqual({ width: PREVIEW_SIDE, height: 540 });
    expect(fitSize(1000, 3000)).toEqual({ width: 240, height: PREVIEW_SIDE });
    expect(fitSize(300, 200)).toEqual({ width: 300, height: 200 });
  });

  it("averages what each pixel covers", () => {
    const src = { width: 2, height: 2, data: new Uint8Array([0, 0, 0, 255, 200, 100, 50, 255, 0, 0, 0, 255, 200, 100, 50, 255]) };
    expect([...boxScale(src, 1, 1).data]).toEqual([100, 50, 25, 255]);
  });

  it("reads the EXIF orientation and turns the picture upright", () => {
    const base = jpg(64, 32);
    expect(jpegOrientation(base)).toBe(1);
    expect(jpegOrientation(withOrientation(base, 6))).toBe(6);
    // 2×1, red then blue, turned 90° clockwise: 1×2, red on top.
    const turned = orient({ width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]) }, 6);
    expect([turned.width, turned.height, ...turned.data]).toEqual([1, 2, 255, 0, 0, 255, 0, 0, 255, 255]);
  });

  it("makes a small JPEG of a big photo, upright", () => {
    const p = makePreview(withOrientation(jpg(1600, 1200), 6), "image/jpeg")!;
    expect(p.type).toBe("image/jpeg");
    expect([p.width, p.height]).toEqual([540, PREVIEW_SIDE]);
    const back = jpeg.decode(p.data, { useTArray: true });
    expect([back.width, back.height]).toEqual([540, PREVIEW_SIDE]);
    // Turned clockwise, the red left half is now on top.
    expect(back.data[(10 * back.width + 270) * 4]).toBeGreaterThan(150);
    expect(back.data[((back.height - 10) * back.width + 270) * 4 + 2]).toBeGreaterThan(150);
  });

  it("keeps a transparent PNG a PNG and turns an opaque one into a JPEG", () => {
    const png = (alpha: number) => {
      const img = new PNG({ width: 1500, height: 900 });
      img.data = pixels(1500, 900, alpha);
      return PNG.sync.write(img);
    };
    expect(makePreview(png(120), "image/png")).toMatchObject({ type: "image/png", width: PREVIEW_SIDE, height: 432 });
    expect(makePreview(png(255), "image/png")).toMatchObject({ type: "image/jpeg", width: PREVIEW_SIDE, height: 432 });
  });

  it("leaves a small picture as it is", () => {
    expect(makePreview(jpg(400, 300), "image/jpeg")).toBeUndefined();
  });
});

describe("the preview store", () => {
  it("makes a copy once, a new one when the file changes, and none of a small or broken file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "previews-"));
    const previews = new PicturePreviews(join(dir, "cache"));
    try {
      const photo = join(dir, "photo.jpg");
      writeFileSync(photo, jpg(2400, 1600));
      const first = (await previews.preview(photo))!;
      expect(first).toMatch(/\.jpg$/);
      const decoded = jpeg.decode(readFileSync(first));
      expect([decoded.width, decoded.height]).toEqual([PREVIEW_SIDE, 480]);
      expect(await previews.preview(photo)).toBe(first);

      writeFileSync(photo, jpg(2000, 2000));
      utimesSync(photo, new Date(), new Date(Date.now() + 5000));
      const second = (await previews.preview(photo))!;
      expect(second).not.toBe(first);
      expect(jpeg.decode(readFileSync(second)).width).toBe(PREVIEW_SIDE);

      const small = join(dir, "small.jpg");
      writeFileSync(small, jpg(300, 200));
      expect(await previews.preview(small)).toBeUndefined();

      const broken = join(dir, "broken.png");
      writeFileSync(broken, Buffer.alloc(300 * 1024, 7));
      expect(await previews.preview(broken)).toBeUndefined();
      expect(await previews.preview(broken)).toBeUndefined();

      expect(await previews.preview(join(dir, "missing.jpg"))).toBeUndefined();
      expect(await previews.preview(join(dir, "doc.pdf"))).toBeUndefined();
    } finally {
      previews.stop();
    }
  }, 60_000);
});

// Force the encoder's Buffer into Node's shared pool, independent of the Node version's pool size.
it("transfers a preview backed by a pooled encoder Buffer", async () => {
  const url = new URL("../src/preview-worker.ts", import.meta.url).href;
  const worker = new Worker(`Buffer.poolSize = 1024 * 1024; void import(${JSON.stringify(url)});`, { eval: true });
  try {
    const reply = once(worker, "message");
    const data = jpeg.encode({ width: 800, height: 800, data: Buffer.alloc(800 * 800 * 4, 255) }, 92).data;
    const file = join(mkdtempSync(join(tmpdir(), "pooled-preview-")), "photo.jpg");
    writeFileSync(file, data);
    worker.postMessage({ id: 1, file, type: "image/jpeg" });
    const [result] = await reply;
    expect(result.error).toBeUndefined();
    expect(result.type).toBe("image/jpeg");
    expect(jpeg.decode(result.data).width).toBe(PREVIEW_SIDE);
  } finally {
    await worker.terminate();
  }
});
