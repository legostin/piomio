// Ports for test servers that listen later (a hub booted after it joins a cluster, a fixture started on demand).
// A port the OS hands out (listen(0)) is from its ephemeral range, which every outgoing connection of every process
// draws from too: one made meanwhile by a parallel test or a browser could take it before the server listens
// (EADDRINUSE on a busy CI runner). These come from below that range (Linux 32768+, macOS and Windows 49152+), where
// only another test's explicit pick could land, and are checked free first.
//
// A port is handed out once in a run. Test files run in parallel processes, and each picks its ports a moment before
// its hubs listen on them: "free when checked" does not stop two of them from picking the same one, and the hub that
// lost it fails far from the cause (no device port: "incomplete replica link"; TLS answered by a plain server). So a
// pick is claimed first: in this process, and for the whole run with a file in the run's temp folder
// (temp-dir.ts), which every test process and what it spawns share and which goes when the run ends.
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const FIRST = 20_000;
const LAST = 32_000;

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

/** Ports this process handed out. */
const mine = new Set<number>();

/** Where the run's processes claim ports; undefined outside a test run (nothing would ever clear the claims). */
function claimsDir(): string | undefined {
  const run = tmpdir();
  if (!basename(run).startsWith("owl-test-")) return undefined;
  const dir = join(run, ".ports");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Take the port for this run: false when this process or another one of the run already has it. */
function claim(port: number): boolean {
  if (mine.has(port)) return false;
  const dir = claimsDir();
  if (dir) {
    try {
      // "wx": made only if it is not there, in one step, so two processes cannot both make it.
      writeFileSync(join(dir, String(port)), "", { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  }
  mine.add(port);
  return true;
}

/** A free port on 127.0.0.1 that nothing but an explicit listen will take, and no other test of the run was given. */
export async function freePort(): Promise<number> {
  for (let tries = 0; tries < 200; tries++) {
    const port = FIRST + Math.floor(Math.random() * (LAST - FIRST));
    if (claim(port) && (await canListen(port))) return port;
  }
  throw new Error(`no free port between ${FIRST} and ${LAST}`);
}
