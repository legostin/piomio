// Memory on hubs with replicas: the hub's file sync shares the plugin's data folder between them (core cluster.ts,
// FILE_ROOTS), and only one hub runs the plugin at a time, the one that leads. The facts (memory/*.md) travel; what is
// built from them stays with each hub, which builds it again: the search index, MEMORY.md and the git history (a
// fact that arrives is committed by the hub it arrives at). The working state is in the hub's plugin storage
// (state.ts). A .gitignore in the data folder tells the file sync what to leave out.
//
// When both hubs changed one file, the sync keeps the newer version in place and the other one beside it as
// `name (conflict <machine> YYYY-MM-DD HHmm[ n]).ext` (packages/replica conflictName); conflictOriginal() reads that.

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What the file sync leaves out (patterns relative to the plugin's data folder). */
const LOCAL = ["/*.db", "/memory/MEMORY.md", "/memory/.git/"];

const CONFLICT = /^(.*) \(conflict [^()]* \d{4}-\d{2}-\d{2} \d{4}(?: \d+)?\)(\.[^./]*)?$/;

/** The name a conflict copy was made of ("a (conflict vps 2026-10-31 0300).md" → "a.md"), or undefined. */
export function conflictOriginal(name: string): string | undefined {
  const slash = name.lastIndexOf("/");
  const m = CONFLICT.exec(name.slice(slash + 1));
  return m ? `${name.slice(0, slash + 1)}${m[1]}${m[2] ?? ""}` : undefined;
}

/** Keep the index, MEMORY.md and the git history out of the file sync between hubs. */
export function keepLocal(dataDir: string): void {
  const file = join(dataDir, ".gitignore");
  const had = existsSync(file) ? readFileSync(file, "utf8") : "";
  const missing = LOCAL.filter((l) => !had.split(/\r?\n/).includes(l));
  if (!missing.length) return;
  const head = had ? "" : "# Piomio memory: each hub builds these from the facts itself; the hubs' file sync leaves them out.\n";
  writeFileSync(file, `${head}${had}${had && !had.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`, "utf8");
}

/**
 * Conflict copies of what each hub builds for itself, from before it stayed local: the search index's (the state's
 * are taken in by state.ts) and the ones inside the git folder, which git would read as refs and files of its own.
 */
export function removeLocalCopies(dataDir: string): number {
  let n = 0;
  const rm = (abs: string) => {
    rmSync(abs, { force: true });
    n++;
  };
  for (const name of list(dataDir)) if (name.isFile() && conflictOriginal(name.name) === "index.db") rm(join(dataDir, name.name));
  const walk = (dir: string) => {
    for (const e of list(dir)) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (conflictOriginal(e.name)) rm(join(dir, e.name));
    }
  };
  walk(join(dataDir, "memory", ".git"));
  return n;
}

function list(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
