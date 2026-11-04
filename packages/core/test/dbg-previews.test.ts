import { it } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { PicturePreviews } from "../src/picture-previews.ts";

it("DBG hidden error", async () => {
  const w = 2400, h = 1600;
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(Math.random() * 256);
  const dir = mkdtempSync(join(tmpdir(), "dbg-"));
  const photo = join(dir, "photo.jpg");
  writeFileSync(photo, Buffer.from(jpeg.encode({ width: w, height: h, data }, 92).data));
  const p = new PicturePreviews(join(dir, "cache"));
  const r = await p.preview(photo);
  const files = readdirSync(join(dir, "cache")).map((f) => f + " => " + (f.endsWith(".none") ? readFileSync(join(dir, "cache", f), "utf8") : ""));
  p.stop();
  console.log("DBGRESULT", r, JSON.stringify(files), JSON.stringify(process.execArgv));
}, 60000);
