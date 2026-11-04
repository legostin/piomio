import { it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import jpeg from "jpeg-js";
import { makePreview } from "../src/preview-image.ts";

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

it("DBG hidden error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dbg-"));
  const photo = join(dir, "photo.jpg");
  writeFileSync(photo, jpg(2400, 1600));
  const m = makePreview(jpg(2400, 1600), "image/jpeg")!;
  console.log("DBG1 buffer", m.data.length, m.data.buffer.byteLength, m.data.byteOffset, Object.prototype.toString.call(m.data.buffer));
  const w = new Worker(new URL("../src/preview-worker.ts", import.meta.url));
  const out = await new Promise<string>((resolve) => {
    w.on("message", (r) => resolve("message " + JSON.stringify({ keys: Object.keys(r), id: r.id, type: r.type, dataLen: r.data?.length, ctor: r.data?.constructor?.name, error: r.error })));
    w.on("error", (e) => resolve("error " + String(e) + " | " + (e as Error).stack));
    w.on("exit", (c) => resolve("exit " + c));
    w.postMessage({ id: 1, file: photo, type: "image/jpeg" });
    setTimeout(() => resolve("timeout"), 20000);
  });
  console.log("DBG2 worker", out);
  void w.terminate();
}, 60000);
