import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { proxiedGet } from "../../src/signals/net.ts";
import { fetchPage } from "../../src/signals/watch.ts";

describe("watch page loads", () => {
  let proxy: Server;
  let site: Server;
  let proxyPort = 0;
  let sitePort = 0;
  const seen: Array<{ url: string; auth?: string }> = [];
  let siteHits = 0;

  beforeAll(async () => {
    // A stand-in for the egress proxy: plain HTTP requests arrive with the absolute URL.
    proxy = createServer((req, res) => {
      seen.push({ url: req.url ?? "", auth: req.headers["proxy-authorization"] as string | undefined });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-from": "proxy" });
      res.end("<p>через прокси</p>");
    });
    site = createServer((_req, res) => {
      siteHits++;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("direct");
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    proxyPort = (proxy.address() as AddressInfo).port;
    sitePort = (site.address() as AddressInfo).port;
  });

  afterAll(() => {
    proxy?.close();
    site?.close();
  });

  it("sends outside addresses through the proxy, with its token", async () => {
    const get = proxiedGet(`http://tok123:x@127.0.0.1:${proxyPort}`);
    const res = await get("http://example.test/page?a=1", { headers: { accept: "text/html" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-from")).toBe("proxy");
    expect(await res.text()).toBe("<p>через прокси</p>");
    expect(seen.at(-1)).toEqual({ url: "http://example.test/page?a=1", auth: `Basic ${Buffer.from("tok123:x").toString("base64")}` });
  });

  it("loads loopback addresses directly, as the plugin's NO_PROXY did", async () => {
    const before = seen.length;
    const res = await proxiedGet(`http://tok123:x@127.0.0.1:${proxyPort}`)(`http://127.0.0.1:${sitePort}/`, {});
    expect(await res.text()).toBe("direct");
    expect(siteHits).toBe(1);
    expect(seen.length).toBe(before);
  });

  it("fetchPage uses the given fetch and reports its timeout as a timeout", async () => {
    const page = await fetchPage("https://example.com/x", {
      allowPrivate: true,
      timeoutMs: 1000,
      fetch: async () => new Response("<b>ok</b>", { status: 200, headers: { "content-type": "text/html" } }),
    });
    expect(page).toEqual({ body: "<b>ok</b>", contentType: "text/html", url: "https://example.com/x" });

    const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError", cause: new DOMException("timed out", "TimeoutError") });
    await expect(
      fetchPage("https://example.com/x", { allowPrivate: true, timeoutMs: 1000, fetch: async () => Promise.reject(abort) }),
    ).rejects.toMatchObject({ code: "fetchTimeout" });
  });
});
