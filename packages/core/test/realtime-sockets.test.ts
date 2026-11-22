// A socket a standby passes on to the leader hears only the replica it was passed to. When that replica no longer
// leads (this one took the lead, or another did), the socket must reconnect, or the window stays silent: the answer
// is stored, and nothing shows it. Seen on 2026-11-20: a window opened in the second a starting replica still took
// the other one for the leader stayed attached to it for an hour.
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { RealtimeSockets } from "../src/server/realtime.ts";

class FakeSocket extends EventEmitter {
  readyState = 1;
  closed?: { code: number; reason: string };
  terminated = false;
  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit("close");
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit("close");
  }
}

const socket = () => new FakeSocket();
const ws = (s: FakeSocket) => s as unknown as WebSocket;

describe("realtime sockets passed on to the leader", () => {
  it("stay while the replica they go to leads", () => {
    const sockets = new RealtimeSockets();
    const s = socket();
    sockets.relay(ws(s), () => false);
    sockets.closeMoved();
    expect(s.closed).toBeUndefined();
    expect(sockets.relayedSize).toBe(1);
  });

  it("reconnect once that replica no longer leads", () => {
    const sockets = new RealtimeSockets();
    const s = socket();
    let leads = true;
    sockets.relay(ws(s), () => !leads);
    sockets.closeMoved();
    expect(s.closed).toBeUndefined();
    leads = false;
    sockets.closeMoved();
    expect(s.closed).toEqual({ code: 1012, reason: "hub moved" });
    expect(sockets.relayedSize).toBe(0);
  });

  it("are forgotten when the client leaves", () => {
    const sockets = new RealtimeSockets();
    const s = socket();
    sockets.relay(ws(s), () => false);
    s.emit("close");
    expect(sockets.relayedSize).toBe(0);
  });

  it("leave the sockets this replica serves itself alone", () => {
    const sockets = new RealtimeSockets();
    const served = socket();
    const relayed = socket();
    sockets.add(ws(served), () => false);
    sockets.relay(ws(relayed), () => true);
    sockets.closeMoved();
    expect(served.closed).toBeUndefined();
    expect(relayed.closed?.code).toBe(1012);
    expect(sockets.size).toBe(1);
  });
});
