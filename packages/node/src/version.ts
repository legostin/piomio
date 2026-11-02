// Piomio's version of this daemon: built into piomio-node.mjs (scripts/build-node-bundle.mjs defines it), read from
// the repository's package.json when it runs from source.

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

declare const __PIOMIO_VERSION__: string | undefined;

/** True in the single-file download (piomio-node.mjs), which can replace itself (self-update.ts). */
export const BUNDLED = typeof __PIOMIO_VERSION__ === "string";

function sourceVersion(): string {
  try {
    return JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const PIOMIO_VERSION: string = BUNDLED ? __PIOMIO_VERSION__! : sourceVersion();

/** The daemon's own file when it is the single-file download, run by itself and not by the desktop app. */
export function selfFile(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): string | undefined {
  const file = argv[1];
  if (!BUNDLED || env.PIOMIO_DESKTOP === "1" || !file || !basename(file).endsWith(".mjs")) return undefined;
  return file;
}
