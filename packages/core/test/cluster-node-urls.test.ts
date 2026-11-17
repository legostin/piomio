import { describe, expect, it } from "vitest";
import { nodeUrlsToPublish } from "../src/cluster.ts";

describe("the address a replica publishes for machines", () => {
  it("is its own address when other computers can reach it", () => {
    expect(nodeUrlsToPublish(["https://vps.example.ts.net"], ["http://localhost:8080"])).toEqual(["https://vps.example.ts.net"]);
    expect(nodeUrlsToPublish(["http://10.0.0.5:8080"], [])).toEqual(["http://10.0.0.5:8080"]);
  });

  it("stays the one already published while the link is not up yet", () => {
    // A hub on localhost that just started: its link takes a moment, and its own address works only on its computer.
    expect(nodeUrlsToPublish(["http://localhost:8080"], ["https://vps.example.ts.net"])).toEqual(["https://vps.example.ts.net"]);
    expect(nodeUrlsToPublish(["http://127.0.0.1:41780"], ["http://localhost:41780", "https://mac.example.ts.net"])).toEqual(["https://mac.example.ts.net"]);
    expect(nodeUrlsToPublish(["http://[::1]:8080"], ["https://vps.example.ts.net"])).toEqual(["https://vps.example.ts.net"]);
  });

  it("is the local address when nothing better was ever published", () => {
    expect(nodeUrlsToPublish(["http://127.0.0.1:8080"], [])).toEqual(["http://127.0.0.1:8080"]);
    expect(nodeUrlsToPublish(["http://localhost:8080"], ["http://localhost:9090"])).toEqual(["http://localhost:8080"]);
  });
});
