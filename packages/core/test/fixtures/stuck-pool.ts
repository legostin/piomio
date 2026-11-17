// A process whose thread pool takes no new work: four long key derivations hold its four threads (self-check.test.ts).
import { pbkdf2 } from "node:crypto";
import { writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { watchThreadPool } from "../../src/self-check.ts";

for (let i = 0; i < 4; i++) pbkdf2("a", "b", 50_000_000, 64, "sha512", () => {});
watchThreadPool({
  dir: tmpdir(),
  misses: 3,
  log: (m) => writeSync(1, `${m}\n`),
  kill: () => process.kill(process.pid, "SIGKILL"),
}).start(50);
