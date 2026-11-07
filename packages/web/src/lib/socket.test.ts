import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubSocket } from "./socket";

/** A WebSocket the test drives: what the page sends, and the hub's side by hand. */
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.readyState = FakeSocket.CLOSING;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  hub(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  pings() {
    return this.sent.filter((s) => JSON.parse(s).type === "ping").length;
  }
}

const listeners = new Map<string, () => void>();
const page = { visibilityState: "visible", addEventListener: (t: string, f: () => void) => listeners.set(t, f), removeEventListener: () => {} };

function socket(h: Partial<ConstructorParameters<typeof HubSocket>[0]> = {}) {
  const events: unknown[] = [];
  const handlers = { onEvent: (e: unknown) => events.push(e), onState: () => {}, onReconnect: vi.fn(), onFirstOpen: vi.fn(), ...h };
  const s = new HubSocket(handlers, { WebSocket: FakeSocket as unknown as typeof WebSocket, url: () => "ws://hub/api/ws", pingMs: 1_000, probeMs: 200 });
  s.start();
  return { s, events, handlers, last: () => FakeSocket.all[FakeSocket.all.length - 1] };
}

describe("the hub's realtime socket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    listeners.clear();
    vi.stubGlobal("window", page);
    vi.stubGlobal("document", page);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("drops a socket that stops answering and opens another, which refetches", () => {
    const { s, events, handlers, last } = socket();
    const first = last();
    first.open();
    expect(handlers.onFirstOpen).toHaveBeenCalledOnce();
    expect(first.pings()).toBe(1);
    first.hub({ type: "pong" });
    first.hub({ type: "inbox.changed", data: { unread: 1 } });
    expect(events).toEqual([{ type: "inbox.changed", data: { unread: 1 } }]);

    // Answered: the heartbeat goes on.
    vi.advanceTimersByTime(1_000);
    expect(first.pings()).toBe(2);
    first.hub({ type: "pong" });
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.all).toHaveLength(1);

    // Silent since the last ping: gone, without waiting for its close.
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.all).toHaveLength(2);
    last().open();
    expect(handlers.onReconnect).toHaveBeenCalledOnce();
    s.stop();
  });

  it("checks at once when the page comes back, and keeps a socket that answers", () => {
    const { s, last } = socket();
    const ws = last();
    ws.open();
    ws.hub({ type: "pong" });
    listeners.get("visibilitychange")!();
    expect(ws.pings()).toBe(2);
    ws.hub({ type: "pong" });
    vi.advanceTimersByTime(300);
    expect(FakeSocket.all).toHaveLength(1);

    // Back again, and this time nothing answers.
    listeners.get("visibilitychange")!();
    vi.advanceTimersByTime(300);
    expect(FakeSocket.all).toHaveLength(2);
    s.stop();
  });

  it("never drops the socket of a hub that does not answer pings", () => {
    const { s, last } = socket();
    last().open();
    listeners.get("visibilitychange")!();
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.all).toHaveLength(1);
    s.stop();
  });
});
