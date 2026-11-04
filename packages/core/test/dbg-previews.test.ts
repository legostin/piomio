import { it } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { PicturePreviews } from "../src/picture-previews.ts";

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
  console.log("DBGSIZE", statSync(photo).size);
  const p = new PicturePreviews(join(dir, "cache"));
  const r = await p.preview(photo);
  const files = readdirSync(join(dir, "cache")).map((f) => f + " => " + (f.endsWith(".none") ? readFileSync(join(dir, "cache", f), "utf8") : ""));
  p.stop();
  console.log("DBGRESULT", r, JSON.stringify(files));
}, 60000);
