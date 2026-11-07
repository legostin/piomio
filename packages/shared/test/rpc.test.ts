import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { createRpcPeer, ndjsonTransport, NDJSON_LINE_MAX } from "../src/rpc.ts";

describe("ndjsonTransport", () => {
  it("splits lines that arrive together and lines split across chunks", () => {
    const input = new PassThrough();
    const got: string[] = [];
    ndjsonTransport(input, new PassThrough()).onMessage((m) => got.push(m));
    input.write('{"a":1}\n{"b"');
    input.write(':2}\n\n{"c":3}\n');
    expect(got).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("takes a 30 MB line in small chunks quickly (a file passed inline)", () => {
    const input = new PassThrough();
    const got: string[] = [];
    ndjsonTransport(input, new PassThrough()).onMessage((m) => got.push(m));
    const line = `{"data":"${"x".repeat(30 * 1024 * 1024)}"}`;
    const started = Date.now();
    for (let i = 0; i < line.length; i += 64 * 1024) input.write(line.slice(i, i + 64 * 1024));
    input.write("\n");
    expect(got).toHaveLength(1);
    expect(got[0].length).toBe(line.length);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("closes with an error on a line past its cap, before it grows past it", () => {
    for (const shape of ["chunks", "one write"] as const) {
      const input = new PassThrough();
      const got: string[] = [];
      const closed: Array<Error | undefined> = [];
      const t = ndjsonTransport(input, new PassThrough(), { maxLine: 1000 });
      t.onMessage((m) => got.push(m));
      t.onClose((err) => closed.push(err));
      input.write(`{"a":"${"x".repeat(990)}"}\n`);
      if (shape === "chunks") for (let i = 0; i < 20; i++) input.write("y".repeat(100));
      else input.write(`${"y".repeat(2000)}\n{"b":1}\n`);
      expect(got).toEqual([`{"a":"${"x".repeat(990)}"}`]);
      expect(closed).toHaveLength(1);
      expect(closed[0]?.message).toContain("longer than 1000");
      // What comes after is not read.
      input.write('{"c":1}\n');
      expect(got).toHaveLength(1);
    }
  });

  it("caps a line at 256 MB by default, and a peer on it fails what it waited for with the reason", async () => {
    expect(NDJSON_LINE_MAX).toBe(256 * 1024 * 1024);
    const input = new PassThrough();
    const peer = createRpcPeer(ndjsonTransport(input, new PassThrough(), { maxLine: 100 }));
    const reasons: Array<Error | undefined> = [];
    peer.onClose((err) => reasons.push(err));
    const waiting = peer.request("x");
    input.write("z".repeat(200));
    await expect(waiting).rejects.toThrow(/closed: a message is longer than 100/);
    expect(peer.closed).toBe(true);
    expect(reasons[0]?.message).toContain("longer than 100");
  });
});
