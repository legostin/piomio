// Ports for test servers that listen later (a hub booted after it joins a cluster, a fixture started on demand).
// A port the OS hands out (listen(0)) is from its ephemeral range, which every outgoing connection of every process
// draws from too: one made meanwhile by a parallel test or a browser could take it before the server listens
// (EADDRINUSE on a busy CI runner). These come from below that range (Linux 32768+, macOS and Windows 49152+), where
// only another test's explicit pick could land, and are checked free first.
import { createServer } from "node:net";

const FIRST = 20_000;
const LAST = 32_000;

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

/** A free port on 127.0.0.1 that nothing but an explicit listen will take. */
export async function freePort(): Promise<number> {
  for (let tries = 0; tries < 100; tries++) {
    const port = FIRST + Math.floor(Math.random() * (LAST - FIRST));
    if (await canListen(port)) return port;
  }
  throw new Error(`no free port between ${FIRST} and ${LAST}`);
}
