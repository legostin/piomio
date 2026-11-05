// Shared HTTP helpers for the main app and the security console.

import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlib, gzip } from "node:zlib";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Params } from "@piomio/shared";
import { LocalizedError } from "../i18n.ts";

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** Resolve `rel` inside `root`; undefined if it escapes the root or does not exist as a file. */
export function safeFile(root: string, rel: string): string | undefined {
  const base = resolve(root);
  const full = resolve(join(base, rel));
  if (full !== base && !full.startsWith(base + sep)) return undefined;
  if (!existsSync(full) || !statSync(full).isFile()) return undefined;
  return full;
}

/** `attachment` with the file's name (RFC 6266: an ASCII fallback, then the UTF-8 name). */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** The single byte range a `Range` header asks for: undefined to send the whole file (none, malformed, several). */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!m || (!m[1] && !m[2])) return undefined;
  if (!m[1]) {
    // The last N bytes.
    const n = Number(m[2]);
    if (!n) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

// ---------- compression ----------
//
// Over Tailscale a megabyte is what the person waits for: the web UI's files shrink to a quarter, the API's JSON more.
// Session cookies are SameSite=Strict, so no other site can have the browser fetch an authenticated answer and measure
// its compressed size (BREACH).

export type Encoding = "br" | "gzip";

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|manifest\+json)\b|image\/svg\+xml\b)/i;
/** Below this, compressing saves about nothing. */
const MIN_COMPRESS = 1024;
/** Brotli quality for what is compressed per answer, and for files (compressed once, then kept). */
const QUALITY_LIVE = 4;
const QUALITY_FILE = 9;
/** Compressed files kept in memory; the oldest goes first. */
const MAX_ZIPPED = 128;

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

function compress(data: string | Buffer, encoding: Encoding, quality: number): Promise<Buffer> {
  return encoding === "br" ? brotli(data, { params: { [zlib.BROTLI_PARAM_QUALITY]: quality, [zlib.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(data) } }) : gz(data);
}

/** What the client takes: brotli if it can, else gzip. */
export function acceptedEncoding(header: string | undefined): Encoding | undefined {
  const accepted = new Set<string>();
  for (const item of (header ?? "").split(",")) {
    const [name, ...params] = item.trim().toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    if (name && (!q || Number(q.slice(2)) > 0)) accepted.add(name);
  }
  return accepted.has("br") ? "br" : accepted.has("gzip") ? "gzip" : undefined;
}

/** A browser on the hub's own computer has no network to save: compressing would only cost it time. */
function encodingFor(req: FastifyRequest): Encoding | undefined {
  if (/^(127\.|::1$|::ffff:127\.)/.test(clientIp(req))) return undefined;
  return acceptedEncoding(req.headers["accept-encoding"]);
}

function varyOnEncoding(reply: FastifyReply): void {
  const vary = reply.getHeader("vary");
  if (!/\baccept-encoding\b/i.test(String(vary ?? ""))) reply.header("vary", vary ? `${String(vary)}, accept-encoding` : "accept-encoding");
}

/** Answers made in memory (the API's JSON, pages) go out compressed. Register it before the routes. */
export function registerCompression(app: FastifyInstance): void {
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.method === "HEAD" || reply.hasHeader("content-encoding")) return payload;
    if (typeof payload !== "string" && !Buffer.isBuffer(payload)) return payload;
    if (Buffer.byteLength(payload) < MIN_COMPRESS || !COMPRESSIBLE.test(String(reply.getHeader("content-type") ?? ""))) return payload;
    const encoding = encodingFor(req);
    if (!encoding) return payload;
    varyOnEncoding(reply);
    reply.header("content-encoding", encoding);
    reply.removeHeader("content-length");
    return compress(payload, encoding, QUALITY_LIVE);
  });
}

const zipped = new Map<string, Promise<Buffer>>();

/** A file's compressed copy, made once per version of the file (`tag`). */
function zippedFile(file: string, tag: string, encoding: Encoding): Promise<Buffer> {
  const key = `${file}|${tag}`;
  let copy = zipped.get(key);
  if (!copy) {
    copy = readFile(file).then((data) => compress(data, encoding, QUALITY_FILE));
    copy.catch(() => zipped.delete(key));
    zipped.set(key, copy);
    if (zipped.size > MAX_ZIPPED) zipped.delete(zipped.keys().next().value!);
  }
  return copy;
}

/**
 * A file with its length (a download shows progress), a validator (opened again, it comes back as 304) and byte
 * ranges (Safari plays a video only from a server that answers them). `compress`: the web UI's own files, which go
 * over the network compressed, unless a byte range is asked for.
 */
export function sendFile(reply: FastifyReply, file: string, opts: { cache?: boolean; download?: boolean; compress?: boolean } = {}): FastifyReply | Promise<FastifyReply> {
  const st = statSync(file);
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const headers = reply.request.headers;
  const worthIt = !!opts.compress && st.size >= MIN_COMPRESS && COMPRESSIBLE.test(type);
  const encoding = worthIt && !headers.range ? encodingFor(reply.request) : undefined;
  const version = `${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}`;
  const etag = `"${version}${encoding ? `-${encoding}` : ""}"`;
  reply.header("content-type", type);
  reply.header("cache-control", opts.cache ? "public, max-age=31536000, immutable" : "no-cache");
  reply.header("etag", etag);
  reply.header("last-modified", st.mtime.toUTCString());
  if (worthIt) varyOnEncoding(reply);
  if (opts.download) reply.header("content-disposition", attachmentDisposition(file.split(/[\\/]/).pop()!));
  if (headers["if-none-match"]?.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) return reply.code(304).send();
  if (encoding) {
    return zippedFile(file, etag, encoding).then((data) => reply.header("content-encoding", encoding).header("content-length", data.length).send(data));
  }
  reply.header("accept-ranges", "bytes");
  const ifRange = headers["if-range"];
  const range = ifRange === undefined || ifRange === etag ? byteRange(headers.range, st.size) : undefined;
  if (range === "unsatisfiable") return reply.code(416).header("content-range", `bytes */${st.size}`).send();
  if (range) {
    reply.code(206).header("content-range", `bytes ${range.start}-${range.end}/${st.size}`).header("content-length", range.end - range.start + 1);
    return reply.send(createReadStream(file, range));
  }
  reply.header("content-length", st.size);
  return reply.send(createReadStream(file));
}

export function hostAllowed(req: FastifyRequest, allowed: string[]): boolean {
  const host = (req.headers.host ?? "").toLowerCase();
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return allowed.includes(name);
}

export function originOf(url: string): string {
  return new URL(url).origin;
}

/**
 * Same-origin check for state-changing requests: Origin (or Referer) must be one of `origins`. The page's
 * `Referrer-Policy: no-referrer` makes a browser send `Origin: null` on its own same-origin XMLHttpRequests (an upload
 * that reports progress); the browser's `Sec-Fetch-Site: same-origin`, which no page can set, vouches for those.
 */
export function originAllowed(req: FastifyRequest, origins: string[]): boolean {
  const o = req.headers.origin ?? (req.headers.referer ? safeOrigin(req.headers.referer) : undefined);
  if ((!o || o === "null") && req.headers["sec-fetch-site"] === "same-origin") return true;
  if (!o) return false;
  return origins.includes(o);
}

function safeOrigin(u: string): string | undefined {
  try {
    return new URL(u).origin;
  } catch {
    return undefined;
  }
}

/** Origins the browser may use to reach a service on `port` via any allowed host name. */
export function originsFor(base: string, allowedHosts: string[], port: number): string[] {
  const out = new Set<string>([originOf(base)]);
  for (const h of allowedHosts) {
    out.add(`http://${h}:${port}`);
    out.add(`https://${h}:${port}`);
  }
  return [...out];
}

export function clientIp(req: FastifyRequest): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

/** Failed attempts per client address in a sliding window: pairing and the invite page share one. */
export class FailureBudget {
  private limit: number;
  private windowMs: number;
  private seen = new Map<string, number[]>();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  private recent(ip: string, now = Date.now()): number[] {
    const list = (this.seen.get(ip) ?? []).filter((at) => now - at < this.windowMs);
    if (list.length) this.seen.set(ip, list);
    else this.seen.delete(ip);
    return list;
  }

  exhausted(req: FastifyRequest): boolean {
    return this.recent(clientIp(req)).length >= this.limit;
  }

  fail(req: FastifyRequest): void {
    const ip = clientIp(req);
    this.seen.set(ip, [...this.recent(ip), Date.now()]);
  }
}

/** `microphone`: the document may record the person's voice (the hub's own UI); nothing else may. */
export function securityHeaders(reply: FastifyReply, csp: string, opts: { microphone?: boolean } = {}): void {
  reply.header("content-security-policy", csp);
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-frame-options", "DENY");
  reply.header("cross-origin-opener-policy", "same-origin");
  reply.header("permissions-policy", `camera=(), microphone=${opts.microphone ? "(self)" : "()"}, geolocation=()`);
}

/** HTTP error with a core message key (locales/en.ts); text that is not a key is shown as is. */
export class HttpError extends LocalizedError {
  declare status: number;
  constructor(status: number, key: string, params?: Params) {
    super(key, params, status);
  }
}
