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
    for (const ip of ["168.63.129.16", "0:0:0:0:0:ffff:7f00:1", "127.0.0.1", "10.1.2.3", "192.168.0.10", "172.20.0.1", "169.254.169.254", "100.64.1.1", "::1", "fe80::1", "fd00::5", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2002:c0a8:1::1"]) {
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

/** A CONNECT through the proxy: its status line. */
function tunnel(proxyPort: number, token: string | undefined, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(proxyPort, "127.0.0.1", () => {
      const auth = token ? `Proxy-Authorization: Basic ${Buffer.from(`${token}:x`).toString("base64")}\r\n` : "";
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
    });
    let got = "";
    s.on("data", (c) => {
      got += c;
      if (got.includes("\r\n")) {
        resolve(got.split("\r\n")[0]!);
        s.destroy();
      }
    });
    s.on("error", reject);
  });
}

describe("the proxy tells no internet from not allowed", () => {
  const proxy = new EgressProxy();
  const audit: Array<{ actor: string; action: string; target?: string; data?: any }> = [];
  let proxyPort = 0;
  let closedPort = 0;
  let token = "";

  beforeAll(async () => {
    proxyPort = await freePort();
    closedPort = await freePort();
    proxy.audit = { append: (actor: string, action: string, target?: string, data?: unknown) => audit.push({ actor, action, target, data }) } as any;
    await proxy.listen(proxyPort);
    token = proxy.issueToken("brain:s1", ["*"]);
  });
  afterAll(() => proxy.close());

  it("a host that does not resolve (the computer is offline) is unreachable, not a denial", async () => {
    proxy.lookup = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND github.com"), { code: "ENOTFOUND" });
    };
    try {
      const r = await viaProxy(proxyPort, token, "http://github.com/");
      expect(r.status).toBe(502);
      expect(r.body).toMatch(/cannot reach github\.com/);
      expect(r.body).toMatch(/may be offline/);
      expect(await tunnel(proxyPort, token, "github.com:443")).toMatch(/^HTTP\/1\.1 502 /);
    } finally {
      proxy.lookup = undefined;
    }
    expect(audit.some((a) => a.action === "egress.unreachable" && a.target === "github.com" && a.actor === "brain:s1")).toBe(true);
    expect(audit.some((a) => a.action === "egress.deny")).toBe(false);
  });

  it("a host that refuses the connection is unreachable too", async () => {
    proxy.privateAllow = () => ["localhost"];
    try {
      const line = await tunnel(proxyPort, token, `localhost:${closedPort}`);
      expect(line).toMatch(/^HTTP\/1\.1 502 .*ECONNREFUSED/);
    } finally {
      proxy.privateAllow = () => [];
    }
  });

  it("the proxy-auth challenge every client gets first is not audited; a real denial is, with its reason", async () => {
    audit.length = 0;
    expect((await viaProxy(proxyPort, undefined, "http://example.org/")).status).toBe(407);
    expect(audit).toEqual([]);
    const narrow = proxy.issueToken("plugin:narrow", ["example.com"]);
    expect((await viaProxy(proxyPort, narrow, "http://example.org/")).status).toBe(403);
    const deny = audit.find((a) => a.action === "egress.deny");
    expect(deny).toMatchObject({ actor: "plugin:narrow", target: "example.org" });
    expect(deny?.data?.reason).toMatch(/not allowed/);
  });

  it("knows which sessions have a live proxy token", () => {
    const t = proxy.issueToken("brain:s2", ["*"], { sessionId: "s2", conversationId: "c", agentId: "a" });
    expect(proxy.hasSession("s2")).toBe(true);
    proxy.revoke(t);
    expect(proxy.hasSession("s2")).toBe(false);
  });
});
