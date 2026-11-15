// freePort: a port is handed out once in a run, whichever test process asks. Tests run in parallel processes and each
// boots hubs on several ports it picked a moment earlier: two that picked the same one fail in ways that look like
// anything but a port (a hub without its device port, TLS talking to a plain server).
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { freePort } from "../src/ports.ts";

const ports = pathToFileURL(join(import.meta.dirname, "..", "src", "ports.ts")).href;

describe("free ports for tests", () => {
  it("never hands out the same port twice in a process, one after another or many at once", async () => {
    const got: number[] = [];
    for (let i = 0; i < 200; i++) got.push(await freePort());
    got.push(...(await Promise.all(Array.from({ length: 100 }, () => freePort()))));
    expect(new Set(got).size).toBe(300);
    for (const p of got) expect(p >= 20_000 && p < 32_000).toBe(true);
  });

  it("never hands out the same port to two processes of one run", async () => {
    const pick = `import { freePort } from ${JSON.stringify(ports)}; const got = []; for (let i = 0; i < 150; i++) got.push(await freePort()); console.log(JSON.stringify(got));`;
    const runs = await Promise.all(
      Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", pick], { env: process.env })),
    );
    const all = runs.flatMap((r) => JSON.parse(r.stdout) as number[]);
    expect(all).toHaveLength(600);
    expect(new Set(all).size).toBe(600);
  }, 60_000);
});
