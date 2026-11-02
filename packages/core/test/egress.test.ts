import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { connect } from "node:net";
import { freePort } from "@piomio/testkit";
import { EgressProxy, isPrivateAddress } from "../src/egress.ts";

function viaProxy(proxyPort: number, token: string | undefined, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token) headers["proxy-authorization"] = `Basic ${Buffer.from(`${token}:x`).toString("base64")}`;
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: url, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("isPrivateAddress", () => {
  it("covers v4, v6 and v4-in-v6 forms", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.10", "172.20.0.1", "169.254.169.254", "100.64.1.1", "::1", "fe80::1", "fd00::5", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2002:c0a8:1::1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("egress proxy", () => {
  const proxy = new EgressProxy();
  let proxyPort = 0;
  let upstreamPort = 0;
  const upstream = http.createServer((_req, res) => res.end("hello from lan"));
  let token = "";

  beforeAll(async () => {
    proxyPort = await freePort();
    await proxy.listen(proxyPort);
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    upstreamPort = (upstream.address() as { port: number }).port;
    token = proxy.issueToken("plugin:web", ["*"]);
  });
  afterAll(async () => {
    await proxy.close();
    upstream.close();
  });

  it("needs a token and an allowlisted host", async () => {
    expect((await viaProxy(proxyPort, undefined, `http://localhost:${upstreamPort}/`)).status).toBe(407);
    const narrow = proxy.issueToken("plugin:x", ["example.com"]);
    expect((await viaProxy(proxyPort, narrow, `http://localhost:${upstreamPort}/`)).status).toBe(403);
  });

  it("refuses private destinations even for wildcard grants unless allowed in settings", async () => {
    const denied = await viaProxy(proxyPort, token, `http://localhost:${upstreamPort}/`);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatch(/private address/);
    proxy.privateAllow = () => ["localhost"];
    const ok = await viaProxy(proxyPort, token, `http://localhost:${upstreamPort}/`);
    expect(ok).toEqual({ status: 200, body: "hello from lan" });
    proxy.privateAllow = () => [];
  });

  it("survives a client that resets a refused CONNECT", async () => {
    // A brain or plugin refused a tunnel and dropped the connection hard: the hub must not crash on the reset.
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((resolve) => {
        const s = connect(proxyPort, "127.0.0.1", () => {
          s.write("CONNECT blocked.example:443 HTTP/1.1\r\nHost: blocked.example:443\r\n\r\n");
          setTimeout(() => {
            s.resetAndDestroy();
            resolve();
          }, i % 4);
        });
        s.on("error", () => resolve());
      });
    }
    await new Promise((r) => setTimeout(r, 50));
    expect((await viaProxy(proxyPort, undefined, `http://localhost:${upstreamPort}/`)).status).toBe(407);
  });
});
