// Bundles the machine daemon (packages/node) into one file the hub serves at /download/piomio-node.mjs,
// so another computer needs only Node.js: curl the file, then `node piomio-node.mjs pair <hub> <code>`.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
await build({
  entryPoints: [join(root, "packages/node/src/cli.ts")],
  outfile: join(root, "packages/node/dist/piomio-node.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // ws loads these optional native addons with require(); they are not needed.
  external: ["bufferutil", "utf-8-validate"],
  banner: { js: 'import { createRequire as __obCreateRequire } from "node:module"; const require = __obCreateRequire(import.meta.url);' },
  // packages/node/src/version.ts: the version this file says it is, and that it may replace itself.
  define: { __PIOMIO_VERSION__: JSON.stringify(version) },
  legalComments: "none",
  logLevel: "warning",
});
console.log("built packages/node/dist/piomio-node.mjs");
