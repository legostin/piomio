import { it } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { PicturePreviews } from "../src/picture-previews.ts";
import { makePreview, fitSize, jpegOrientation } from "../src/preview-image.ts";
import { imageTypeOf } from "../src/media.ts";

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
  const buf = jpg(2400, 1600);
  writeFileSync(photo, buf);
  console.log("DBG1 type", imageTypeOf(photo), "orientation", jpegOrientation(buf), "fit", JSON.stringify(fitSize(2400, 1600)));
  try {
    const m = makePreview(readFileSync(photo), "image/jpeg");
    console.log("DBG2 direct", m ? `${m.type} ${m.width}x${m.height} ${m.data.length}` : "undefined");
  } catch (e) {
    console.log("DBG2 direct threw", String(e));
  }
  const p = new PicturePreviews(join(dir, "cache"));
  const r = await p.preview(photo);
  const files = readdirSync(join(dir, "cache")).map((f) => f + " => " + (f.endsWith(".none") ? readFileSync(join(dir, "cache", f), "utf8") : statSync(join(dir, "cache", f)).size));
  console.log("DBG3 store", r, JSON.stringify(files));
  // the same again with a second, fresh file
  const photo2 = join(dir, "photo2.jpg");
  writeFileSync(photo2, jpg(2400, 1600));
  const r2 = await p.preview(photo2);
  console.log("DBG4 second", r2);
  p.stop();
}, 60000);
