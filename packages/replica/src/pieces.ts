// A file over a machine's WebSocket RPC (`files.read`, files.ts's FilePeer.read) goes in pieces: the hub takes frames
// up to 4 MB and the node up to 16 MB, so a whole file in one answer closed the socket, and the sync asked for the same
// file again on every reconnect. A peer from before pieces answers with the whole file in base64, which still works.

/** Under the hub's 4 MB frame once in base64 and JSON. */
export const RPC_PIECE = 2 * 1024 * 1024;

export interface PieceRequest {
  root?: string;
  path?: string;
  sha?: string;
  offset?: number;
  length?: number;
}

/** One piece and the whole file's size; a bare string is a whole file from an older peer. */
export type PieceAnswer = { data: string; total: number } | string | null;

type Read = (root: string, path: string, sha: string) => Promise<Uint8Array | undefined>;

/**
 * The `files.read` handler: a piece when asked for `length`, else the whole file in base64 as before. The file being
 * sent stays in memory until its last piece is out, so a big one is read once.
 */
export function pieceServer(read: Read): (p: PieceRequest) => Promise<PieceAnswer> {
  let last: { key: string; bytes: Uint8Array } | undefined;
  return async (p) => {
    const [root, path, sha] = [String(p?.root ?? ""), String(p?.path ?? ""), String(p?.sha ?? "")];
    const key = `${root}\n${path}\n${sha}`;
    const bytes = last?.key === key ? last.bytes : await read(root, path, sha);
    if (!bytes) return null;
    if (p?.length === undefined) return Buffer.from(bytes).toString("base64");
    const offset = Math.max(0, Number(p.offset) || 0);
    const end = Math.min(bytes.length, offset + Math.max(1, Number(p.length) || RPC_PIECE));
    last = end < bytes.length ? { key, bytes } : undefined;
    return { data: Buffer.from(bytes.subarray(offset, end)).toString("base64"), total: bytes.length };
  };
}

/** Reads a file through `files.read` piece by piece. */
export async function readInPieces(request: (p: PieceRequest) => Promise<PieceAnswer>, root: string, path: string, sha: string): Promise<Uint8Array | undefined> {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const a = await request({ root, path, sha, offset, length: RPC_PIECE });
    if (a === null || a === undefined) return undefined;
    if (typeof a === "string") return new Uint8Array(Buffer.from(a, "base64"));
    const piece = Buffer.from(a.data, "base64");
    parts.push(piece);
    offset += piece.length;
    if (!piece.length || offset >= a.total) break;
  }
  return new Uint8Array(Buffer.concat(parts));
}
