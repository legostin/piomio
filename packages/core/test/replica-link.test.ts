// A link between replicas stays up while its peer is busy sending: on a slow uplink a file's piece holds the pong (and
// every answer) back for seconds, so bytes arriving count as alive too; a peer that sends nothing at all is dropped.
import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { linkPeer } from "../src/replica-link.ts";

const open: { wss: WebSocketServer; client: WebSocket; timer?: NodeJS.Timeout }[] = [];

afterEach(async () => {
  for (const o of open.splice(0)) {
    clearInterval(o.timer);
    o.client.terminate();
    for (const c of o.wss.clients) c.terminate();
    await new Promise((r) => o.wss.close(r));
  }
});

/** A peer that never answers pings, as one whose pongs wait behind a big frame. */
async function deafPeer(): Promise<{ client: WebSocket; server: WebSocket; o: (typeof open)[number] }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, autoPong: false });
  await once(wss, "listening");
  const client = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`);
  const [[server]] = await Promise.all([once(wss, "connection"), once(client, "open")]);
  const o = { wss, client };
  open.push(o);
  return { client, server: server as WebSocket, o };
}

describe("a replica link", () => {
  it("stays up while the peer's bytes keep coming, though no pong does", async () => {
    const { client, server, o } = await deafPeer();
    let heard = 0;
    linkPeer(client, { pingMs: 100, onBytes: () => heard++ });
    o.timer = setInterval(() => server.send(Buffer.alloc(64 * 1024)), 30);
    await new Promise((r) => setTimeout(r, 600));
    expect(client.readyState).toBe(WebSocket.OPEN);
    expect(heard).toBeGreaterThan(0);
  });

  it("drops a peer that sends nothing and answers no ping", async () => {
    const { client } = await deafPeer();
    linkPeer(client, { pingMs: 100 });
    await once(client, "close");
    expect(client.readyState).toBe(WebSocket.CLOSED);
  });
});
