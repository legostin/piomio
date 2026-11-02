// files.read over a machine's RPC in pieces, and with peers from before pieces.
import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { pieceServer, readInPieces, RPC_PIECE, type PieceAnswer, type PieceRequest } from "../src/pieces.ts";

const frame = (a: PieceAnswer) => JSON.stringify(a).length;

describe("files.read in pieces", () => {
  it("moves a big file in pieces that fit the hub's 4 MB frame, reading it once", async () => {
    const file = new Uint8Array(randomBytes(RPC_PIECE * 5 + 123));
    const read = vi.fn(async () => file);
    const serve = pieceServer(read);
    const frames: number[] = [];
    const got = await readInPieces(
      async (q) => {
        const a = await serve(q);
        frames.push(frame(a));
        return a;
      },
      "workspaces",
      "a/big.pdf",
      "sha",
    );
    expect(Buffer.from(got!).equals(Buffer.from(file))).toBe(true);
    expect(frames).toHaveLength(6);
    expect(Math.max(...frames)).toBeLessThan(4 * 1024 * 1024);
    expect(read).toHaveBeenCalledOnce();
  });

  it("reads small and empty files, and a file that is gone", async () => {
    for (const size of [0, 10]) {
      const file = new Uint8Array(randomBytes(size));
      const serve = pieceServer(async () => file);
      expect(Buffer.from((await readInPieces(serve, "workspaces", "f", "sha"))!).equals(Buffer.from(file))).toBe(true);
    }
    expect(await readInPieces(pieceServer(async () => undefined), "workspaces", "f", "sha")).toBeUndefined();
  });

  it("works with a peer from before pieces either way", async () => {
    const file = new Uint8Array(randomBytes(1000));
    // An older peer answers the whole file in base64, whatever it was asked.
    const old = async (_q: PieceRequest) => Buffer.from(file).toString("base64");
    expect(Buffer.from((await readInPieces(old, "workspaces", "f", "sha"))!).equals(Buffer.from(file))).toBe(true);
    // An older peer asks without a length and gets the whole file as before.
    expect(await pieceServer(async () => file)({ root: "workspaces", path: "f", sha: "sha" })).toBe(Buffer.from(file).toString("base64"));
  });
});
