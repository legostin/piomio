// Builds the app's own screens into ui/dist (Tauri's frontendDist): the bundled script, the page and its styles, and
// the frame shown while Pio drives.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const out = join(here, "dist");
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(here, "src", "main.ts")],
  outfile: join(out, "main.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  legalComments: "none",
  logLevel: "warning",
});
for (const f of ["index.html", "style.css", "frame.html"]) copyFileSync(join(here, f), join(out, f));
