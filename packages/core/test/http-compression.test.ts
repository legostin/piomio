// What the hub sends over a network is compressed: the API's JSON, its pages, the web UI's files. A browser on the hub's
// own computer gets them as they are.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import Fastify, { type FastifyInstance } from "fastify";
import { acceptedEncoding, registerCompression, sendFile } from "../src/server/http.ts";

const PEER = "100.70.1.2";
const body = JSON.stringify({ items: Array.from({ length: 400 }, (_, i) => ({ id: i, text: "hello from the hub" })) });

describe("acceptedEncoding", () => {
  it("prefers brotli, takes gzip, and respects a refusal", () => {
    expect(acceptedEncoding("gzip, deflate, br")).toBe("br");
    expect(acceptedEncoding("gzip")).toBe("gzip");
    expect(acceptedEncoding("br;q=0, gzip;q=0.5")).toBe("gzip");
    expect(acceptedEncoding("BR")).toBe("br");
    expect(acceptedEncoding("identity")).toBeUndefined();
    expect(acceptedEncoding(undefined)).toBeUndefined();
    expect(acceptedEncoding("")).toBeUndefined();
  });
});

describe("compression", () => {
  let app: FastifyInstance;
  let file: string;
  let png: string;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "http-compress-"));
    file = join(dir, "app.js");
    png = join(dir, "picture.png");
    writeFileSync(file, `export const x = ${JSON.stringify(body)};`);
    writeFileSync(png, Buffer.alloc(8000, 7));
    app = Fastify();
    registerCompression(app);
    app.get("/json", async () => JSON.parse(body));
    app.get("/small", async () => ({ ok: true }));
    app.get("/binary", async (_req, reply) => reply.type("application/octet-stream").send(Buffer.alloc(8000, 1)));
    app.get("/already", async (_req, reply) => reply.type("text/plain").header("content-encoding", "gzip").send(Buffer.alloc(8000, 1)));
    app.get("/asset", async (_req, reply) => sendFile(reply, file, { cache: true, compress: true }));
    app.get("/picture", async (_req, reply) => sendFile(reply, png, { compress: true }));
    app.get("/plain-file", async (_req, reply) => sendFile(reply, file));
    await app.ready();
  });
  afterAll(() => app.close());

  const get = (url: string, headers: Record<string, string> = { "accept-encoding": "br, gzip" }, remoteAddress = PEER) => app.inject({ method: "GET", url, headers, remoteAddress });

  it("sends the API's JSON compressed over a network, and it unpacks to the same", async () => {
    const r = await get("/json");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-encoding"]).toBe("br");
    expect(r.headers.vary).toMatch(/accept-encoding/i);
    expect(r.rawPayload.length).toBeLessThan(body.length / 5);
    expect(brotliDecompressSync(r.rawPayload).toString()).toBe(body);
    const g = await get("/json", { "accept-encoding": "gzip" });
    expect(g.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(g.rawPayload).toString()).toBe(body);
  });

  it("leaves alone what would not gain from it", async () => {
    expect((await get("/small")).headers["content-encoding"]).toBeUndefined();
    expect((await get("/binary")).headers["content-encoding"]).toBeUndefined();
    expect((await get("/json", {})).headers["content-encoding"]).toBeUndefined();
    const already = await get("/already");
    expect(already.headers["content-encoding"]).toBe("gzip");
    expect(already.rawPayload.length).toBe(8000);
    expect((await get("/picture")).headers["content-encoding"]).toBeUndefined();
    // Files people download or open stay as they are, with their byte ranges.
    const plain = await get("/plain-file");
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.headers["accept-ranges"]).toBe("bytes");
  });

  it("a browser on the hub's own computer gets everything as it is", async () => {
    for (const url of ["/json", "/asset"]) expect((await get(url, undefined, "127.0.0.1")).headers["content-encoding"]).toBeUndefined();
    expect((await get("/json", undefined, "::1")).headers["content-encoding"]).toBeUndefined();
    expect((await get("/json", undefined, "::ffff:127.0.0.1")).headers["content-encoding"]).toBeUndefined();
  });

  it("the web UI's files come compressed, with their own validator, and 304 when unchanged", async () => {
    const r = await get("/asset");
    expect(r.headers["content-encoding"]).toBe("br");
    expect(r.headers["cache-control"]).toContain("immutable");
    expect(r.headers["content-length"]).toBe(String(r.rawPayload.length));
    expect(r.headers["accept-ranges"]).toBeUndefined();
    expect(r.headers.vary).toMatch(/accept-encoding/i);
    expect(brotliDecompressSync(r.rawPayload).toString()).toContain("hello from the hub");

    const etag = String(r.headers.etag);
    expect(etag).toMatch(/-br"$/);
    const again = await get("/asset", { "accept-encoding": "br", "if-none-match": etag });
    expect(again.statusCode).toBe(304);
    // A browser that asks for gzip does not take the brotli copy for its own.
    const other = await get("/asset", { "accept-encoding": "gzip", "if-none-match": etag });
    expect(other.statusCode).toBe(200);
    expect(gunzipSync(other.rawPayload).toString()).toContain("hello from the hub");
  });

  it("a file that changed is compressed anew", async () => {
    const dir = mkdtempSync(join(tmpdir(), "http-compress-"));
    const f = join(dir, "changes.js");
    writeFileSync(f, `// one ${"x".repeat(5000)}`);
    const local = Fastify();
    registerCompression(local);
    local.get("/f", async (_req, reply) => sendFile(reply, f, { compress: true }));
    const fetchIt = () => local.inject({ method: "GET", url: "/f", headers: { "accept-encoding": "br" }, remoteAddress: PEER });
    expect(brotliDecompressSync((await fetchIt()).rawPayload).toString()).toContain("// one");
    writeFileSync(f, `// two ${"y".repeat(6000)}`);
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect(brotliDecompressSync((await fetchIt()).rawPayload).toString()).toContain("// two");
    await local.close();
  });

  it("a byte range of a compressible file is answered from the file itself", async () => {
    const r = await get("/asset", { "accept-encoding": "br", range: "bytes=0-9" });
    expect(r.statusCode).toBe(206);
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(r.rawPayload.toString()).toBe("export con");
  });
});
