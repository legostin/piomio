import { describe, expect, it } from "vitest";
import { HubLinks } from "../src/hub-links.ts";

class FakeLink {
  url: string;
  state = "idle";
  constructor(url: string) {
    this.url = url;
  }
  start(): void {
    this.state = "connecting";
  }
  async stop(): Promise<void> {
    this.state = "stopped";
  }
}

function links(main = "http://127.0.0.1:41780") {
  const made: FakeLink[] = [];
  const l = new HubLinks(main, (url) => {
    const c = new FakeLink(url);
    made.push(c);
    return c;
  });
  return { l, made, byUrl: (u: string) => made.find((c) => c.url === u)! };
}

describe("a machine's connections to the hub's other replicas", () => {
  it("connects to each listed replica once, and never twice to its own hub", () => {
    const { l, made } = links();
    l.set(["http://127.0.0.1:41780/", "https://vps.example.ts.net", "https://vps.example.ts.net/"]);
    l.set(["https://vps.example.ts.net"]);
    expect(made.map((c) => c.url)).toEqual(["https://vps.example.ts.net"]);
    expect(made[0].state).toBe("connecting");
    expect(l.urls()).toEqual(["https://vps.example.ts.net"]);
  });

  it("stops knocking at an address the hub no longer lists", () => {
    // A replica that started before its link was up listed its own localhost for a moment (2026-11-17).
    const { l, byUrl } = links();
    l.set(["http://localhost:8080", "https://mac.example.ts.net"]);
    l.set(["https://vps.example.ts.net", "https://mac.example.ts.net"]);
    expect(byUrl("http://localhost:8080").state).toBe("stopped");
    expect(l.urls()).toEqual(["https://mac.example.ts.net", "https://vps.example.ts.net"]);
  });

  it("keeps a connection that works even when the list leaves it out", () => {
    const { l, byUrl } = links();
    l.set(["https://old.example.ts.net"]);
    byUrl("https://old.example.ts.net").state = "online";
    l.set(["https://new.example.ts.net"]);
    expect(byUrl("https://old.example.ts.net").state).toBe("online");
    expect(l.urls()).toEqual(["https://old.example.ts.net", "https://new.example.ts.net"]);
  });

  it("keeps what it has when the hub sends no list", () => {
    const { l, byUrl } = links();
    l.set(["https://vps.example.ts.net"]);
    l.set([]);
    expect(byUrl("https://vps.example.ts.net").state).toBe("connecting");
  });

  it("stops them all", async () => {
    const { l, made } = links();
    l.set(["https://a.example.ts.net", "https://b.example.ts.net"]);
    await l.stop();
    expect(made.map((c) => c.state)).toEqual(["stopped", "stopped"]);
    expect(l.urls()).toEqual([]);
  });
});
