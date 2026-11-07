// Vitest global setup: the whole run keeps its temp files in one folder of its own, deleted when the run ends.
// Tests use tmpdir()/mkdtempSync freely; the hubs, brains and browsers they spawn inherit the same TMPDIR.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "owl-test-";

export default function setup(): () => void {
  const base = tmpdir();
  sweep(base);
  const dir = mkdtempSync(join(base, PREFIX));
  writeFileSync(join(dir, ".pid"), String(process.pid));
  for (const key of ["TMPDIR", "TMP", "TEMP"]) process.env[key] = dir;
  process.env.PIOMIO_HOST_IDENTITY_DIR = join(dir, "host-identity");
  return () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

/** Folders left by runs that were killed before their teardown; a run still going (another checkout's) keeps its own. */
function sweep(base: string): void {
  for (const name of readdirSync(base)) {
    if (!name.startsWith(PREFIX)) continue;
    const dir = join(base, name);
    let pid = 0;
    try {
      pid = Number(readFileSync(join(dir, ".pid"), "utf8"));
    } catch {
      // Just made by a run that hasn't written its pid yet.
      if (Date.now() - (statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? 0) < 60_000) continue;
    }
    if (pid && alive(pid)) continue;
    rmSync(dir, { recursive: true, force: true });
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
