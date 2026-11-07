import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createServer as createTcp, type AddressInfo } from "node:net";
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import { proxiedGet } from "../../src/signals/net.ts";
import { fetchPage } from "../../src/signals/watch.ts";

describe("watch page loads", () => {
  let proxy: Server;
  let site: Server;
  let proxyPort = 0;
  let sitePort = 0;
  const seen: Array<{ url: string; auth?: string }> = [];
  let siteHits = 0;
  /** The site's connections still open. */
  const sockets = new Set<import("node:net").Socket>();

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
    site.on("connection", (sock) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
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

  it("close() lets its kept-alive connections go", async () => {
    const others = new Set(sockets);
    const mine = () => [...sockets].filter((x) => !others.has(x)).length;
    const get = proxiedGet(`http://tok123:x@127.0.0.1:${proxyPort}`);
    expect(await (await get(`http://127.0.0.1:${sitePort}/`, {})).text()).toBe("direct");
    // Kept alive for the next load.
    await new Promise((r) => setTimeout(r, 20));
    expect(mine()).toBe(1);
    get.close();
    const end = Date.now() + 2000;
    while (mine() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    expect(mine()).toBe(0);
  });

  it("asks for compressed pages and unpacks them, as fetch did", async () => {
    const page = "<p>Цена: 1 200 ₽</p>".repeat(200);
    const packers: Record<string, (b: Buffer) => Buffer> = { gzip: gzipSync, deflate: deflateSync, "deflate-raw": deflateRawSync, br: brotliCompressSync };
    let asked = "";
    // A server that compresses whether asked or not.
    const packed = createServer((req, res) => {
      asked = String(req.headers["accept-encoding"] ?? "");
      const enc = new URL(req.url ?? "/", "http://x").searchParams.get("enc")!;
      const body = enc === "bad" ? Buffer.from("not gzip at all") : packers[enc](Buffer.from(page));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": enc === "bad" ? "gzip" : enc === "deflate-raw" ? "deflate" : enc, "content-length": String(body.length) });
      res.end(body);
    });
    await new Promise<void>((r) => packed.listen(0, "127.0.0.1", r));
    const get = proxiedGet(`http://tok123:x@127.0.0.1:${proxyPort}`);
    try {
      const url = (enc: string) => `http://127.0.0.1:${(packed.address() as AddressInfo).port}/?enc=${enc}`;
      for (const enc of Object.keys(packers)) {
        const res = await get(url(enc), { headers: { accept: "text/html" } });
        expect(res.headers.get("content-encoding")).toBeNull();
        expect(res.headers.get("content-length")).toBeNull();
        expect(await res.text()).toBe(page);
      }
      expect(asked.split(/,\s*/).sort()).toEqual(["br", "deflate", "gzip"]);
      expect((await fetchPage(url("gzip"), { allowPrivate: true, timeoutMs: 1000, fetch: get })).body).toBe(page);
      // A body that is not what its encoding says fails to read, rather than reading as garbage.
      await expect((await get(url("bad"), {})).text()).rejects.toThrow();
    } finally {
      get.close();
      packed.close();
    }
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

  it("rejects, rather than crashing, when a server answers with a status a Response cannot carry", async () => {
    const odd = createTcp((sock) => {
      sock.on("error", () => {});
      sock.end("HTTP/1.1 999 Weird\r\nContent-Length: 2\r\n\r\nhi");
    });
    await new Promise<void>((r) => odd.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(odd.address() as AddressInfo).port}/`;
      const get = proxiedGet(`http://tok123:x@127.0.0.1:${proxyPort}`);
      await expect(get(url, {})).rejects.toThrow(/999/);
      await expect(fetchPage(url, { allowPrivate: true, timeoutMs: 1000, fetch: get })).rejects.toMatchObject({ code: "fetchFailed" });
    } finally {
      odd.close();
    }
  });
});
