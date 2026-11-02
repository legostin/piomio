// Images and map tiles for the web UI, fetched by the hub. The page's CSP (img-src 'self') keeps every picture on
// the hub's own origin: external images come through /api/media, OpenStreetMap tiles through /api/map/tiles.
// Each fetch resolves the host once, refuses private addresses (EgressProxy.resolveTarget) and connects to exactly
// the addresses it checked, on every redirect hop. Results are cached on disk.

import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, sep } from "node:path";
import { pinnedLookup } from "./egress.ts";

/**
 * Largest image an agent can show from its workspace, or a channel gets inline: a PNG render or a full-size screenshot
 * as it is (the chat loads it from the hub; Telegram gets one over 10 MB as a document).
 */
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
/** Largest external image the proxy passes on. */
export const MAX_PROXY_BYTES = 15 * 1024 * 1024;
export const MEDIA_TTL_MS = 7 * 24 * 3600_000;
export const TILE_TTL_MS = 30 * 24 * 3600_000;
/** API answers pages fetch (a forecast) stay fresh this long. */
export const API_TTL_MS = 10 * 60_000;
const MAX_API_BYTES = 2 * 1024 * 1024;
/** tile.openstreetmap.org serves zoom levels 0–19. */
export const MAX_TILE_ZOOM = 19;
const MAX_TILE_BYTES = 1024 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 4;
/** The OSM tile usage policy allows at most two download connections per client. */
const TILE_CONNECTIONS = 2;

export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

/** The name a downloaded web image is saved under: the address's last segment, with the extension of its type. */
export function imageFileName(raw: string, type: string): string {
  let last = "";
  try {
    last = decodeURIComponent(new URL(raw).pathname.split("/").pop() ?? "");
  } catch {
    // An address that does not parse still gets a name.
  }
  const ext = Object.keys(IMAGE_TYPES).find((e) => IMAGE_TYPES[e] === type) ?? "";
  const stem = last.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[\u0000-\u001f\\/:*?"<>|]+/g, "_").trim().slice(0, 100) || "image";
  return stem + ext;
}

/** The image type of a file name by its extension, or undefined when it is not an image. */
export function imageTypeOf(file: string): string | undefined {
  return IMAGE_TYPES[extname(file).toLowerCase()];
}

/** An image file under `root` (a `file:` source without the prefix): undefined when it escapes, is missing, too large or no image. */
export async function readWorkspaceImage(root: string, rel: string): Promise<{ data: Buffer; type: string; name: string } | undefined> {
  try {
    const base = await realpath(root);
    const file = await realpath(join(base, rel));
    if (!file.startsWith(base + sep)) return undefined;
    const type = imageTypeOf(file);
    const st = await stat(file);
    if (!type || !st.isFile() || st.size > MAX_IMAGE_BYTES) return undefined;
    return { data: await readFile(file), type, name: basename(file) };
  } catch {
    return undefined;
  }
}

/** An address the proxy may fetch: http(s), a host, no credentials, at most 2048 characters. */
export function parseImageUrl(raw: unknown): URL | undefined {
  if (typeof raw !== "string" || !raw || raw.length > MAX_URL_LENGTH) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  if (!u.hostname || u.username || u.password) return undefined;
  return u;
}

/** Tile coordinates from the route (`y` may carry the .png suffix), or undefined when out of range. */
export function parseTile(z: unknown, x: unknown, y: unknown): { z: number; x: number; y: number } | undefined {
  const int = (v: unknown) => (typeof v === "string" && /^\d{1,7}$/.test(v) ? Number(v) : typeof v === "number" && Number.isInteger(v) ? v : NaN);
  const zz = int(z);
  const xx = int(x);
  const yy = int(typeof y === "string" ? y.replace(/\.png$/, "") : y);
  if (!(zz >= 0 && zz <= MAX_TILE_ZOOM)) return undefined;
  const n = 2 ** zz;
  if (!(xx >= 0 && xx < n && yy >= 0 && yy < n)) return undefined;
  return { z: zz, x: xx, y: yy };
}

/** The bare media type of an image response (`image/png; x=y` → `image/png`), or undefined for anything else. */
export function imageContentType(header: string | undefined): string | undefined {
  const t = (header ?? "").split(";")[0].trim().toLowerCase();
  return /^image\/[a-z0-9.+-]+$/.test(t) ? t : undefined;
}

/** The body types a page's API fetch passes on: JSON, plain text, CSV, XML. */
export function apiContentType(header: string | undefined): string | undefined {
  const t = (header ?? "").split(";")[0].trim().toLowerCase();
  return /^(application\/([a-z0-9.-]+\+)?(json|xml)|text\/(plain|csv|json|xml))$/.test(t) ? t : undefined;
}

/** A failure with the HTTP status and core message key the routes answer with. */
export class MediaError extends Error {
  status: number;
  key: string;
  constructor(status: number, key: string, detail?: string) {
    super(detail ?? key);
    this.status = status;
    this.key = key;
  }
}

export interface FetchOptions {
  /** Addresses that are safe to connect to for a host; throws for private ones (EgressProxy.resolveTarget). */
  resolve: (host: string) => Promise<string[]>;
  userAgent: string;
  maxBytes: number;
  timeoutMs?: number;
  accept?: string;
  /** What body types to take (the type to pass on, or undefined to refuse); images by default. */
  contentType?: (header: string | undefined) => string | undefined;
  /** Hosts the fetch may reach, checked on every redirect hop too; any by default. */
  hostAllowed?: (host: string) => boolean;
}

interface Upstream {
  status: number;
  location?: string;
  type?: string;
  body?: Buffer;
}

function requestOnce(url: URL, addrs: string[], o: FetchOptions): Promise<Upstream> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: "GET",
        lookup: pinnedLookup(addrs),
        headers: { "user-agent": o.userAgent, accept: o.accept ?? "image/avif,image/webp,image/png,image/*;q=0.8" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
        if (status !== 200) {
          res.resume();
          resolve({ status, location });
          return;
        }
        const type = (o.contentType ?? imageContentType)(res.headers["content-type"]);
        if (!type) {
          res.destroy();
          reject(new MediaError(415, o.contentType ? "media.badType" : "media.notImage"));
          return;
        }
        if (Number(res.headers["content-length"] ?? 0) > o.maxBytes) {
          res.destroy();
          reject(new MediaError(413, "media.tooLarge"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > o.maxBytes) {
            res.destroy();
            reject(new MediaError(413, "media.tooLarge"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status, type, body: Buffer.concat(chunks) }));
        res.on("error", (e) => reject(new MediaError(502, "media.unavailable", e.message)));
      },
    );
    // Idle sockets and slow drips alike: no answer within the timeout, or no whole body within three times it.
    const idle = o.timeoutMs ?? 20_000;
    const deadline = setTimeout(() => req.destroy(new Error("timeout")), idle * 3);
    req.setTimeout(idle, () => req.destroy(new Error("timeout")));
    req.on("error", (e) => reject(e instanceof MediaError ? e : new MediaError(502, "media.unavailable", e.message)));
    req.on("close", () => clearTimeout(deadline));
    req.end();
  });
}

/** GET an image: every hop is resolved and checked, at most a few redirects, only image/* bodies within the limit. */
export async function fetchImage(url: URL, o: FetchOptions): Promise<{ data: Buffer; type: string }> {
  return fetchChecked(url, o);
}

/** GET with the checks of fetchImage, for the body types and hosts `o` allows. */
export async function fetchChecked(url: URL, o: FetchOptions): Promise<{ data: Buffer; type: string }> {
  let current = url;
  for (let hop = 0; ; hop++) {
    if (o.hostAllowed && !o.hostAllowed(current.hostname)) throw new MediaError(403, "media.hostNotAllowed", current.hostname);
    let addrs: string[];
    try {
      addrs = await o.resolve(current.hostname);
    } catch (e) {
      throw new MediaError(403, "media.private", (e as Error).message);
    }
    const r = await requestOnce(current, addrs, o);
    if (r.status >= 300 && r.status < 400 && r.location) {
      const next = hop < MAX_REDIRECTS ? parseImageUrl(new URL(r.location, current).href) : undefined;
      if (!next) throw new MediaError(502, "media.unavailable", "bad redirect");
      current = next;
      continue;
    }
    if (r.status !== 200 || !r.body || !r.type) throw new MediaError(502, "media.unavailable", `upstream ${r.status}`);
    return { data: r.body, type: r.type };
  }
}

/** A small file cache: entries are fresh for `ttlMs` after they were written, stale ones can still help on errors. */
export class FileCache {
  dir: string;
  ttlMs: number;
  constructor(dir: string, ttlMs: number) {
    this.dir = dir;
    this.ttlMs = ttlMs;
  }

  get(rel: string): { data: Buffer; fresh: boolean } | undefined {
    const file = join(this.dir, rel);
    try {
      const st = statSync(file);
      return { data: readFileSync(file), fresh: Date.now() - st.mtimeMs < this.ttlMs };
    } catch {
      return undefined;
    }
  }

  put(rel: string, data: Buffer | string): void {
    const file = join(this.dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, data, { mode: 0o640 });
    renameSync(tmp, file);
  }

  /** Remove entries older than twice the TTL (nobody looked at them for a long time). */
  prune(now = Date.now()): void {
    const walk = (d: string) => {
      let names: string[];
      try {
        names = readdirSync(d);
      } catch {
        return;
      }
      for (const n of names) {
        const p = join(d, n);
        try {
          const st = statSync(p);
          if (st.isDirectory()) walk(p);
          else if (now - st.mtimeMs > 2 * this.ttlMs) rmSync(p, { force: true });
        } catch {
          /* raced with another prune or write */
        }
      }
    };
    if (existsSync(this.dir)) walk(this.dir);
  }
}

/** Runs at most `n` jobs at once. */
class Limiter {
  private active = 0;
  private waiting: Array<() => void> = [];
  private n: number;
  constructor(n: number) {
    this.n = n;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.n) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export interface MediaServiceOptions {
  dataDir: string;
  version: string;
  resolve: (host: string) => Promise<string[]>;
  /** Tile server, {z}/{x}/{y} placeholders (tests point it elsewhere). */
  tileUrl?: string;
}

/** The hub's image proxy and OpenStreetMap tile cache. */
export class MediaService {
  readonly userAgent: string;
  private media: FileCache;
  private tiles: FileCache;
  private apis: FileCache;
  private o: MediaServiceOptions;
  private inflight = new Map<string, Promise<{ data: Buffer; type: string }>>();
  private tileLimit = new Limiter(TILE_CONNECTIONS);

  constructor(o: MediaServiceOptions) {
    this.o = o;
    this.userAgent = `Piomio/${o.version} (+https://github.com/legostin/piomio)`;
    this.media = new FileCache(join(o.dataDir, "cache", "media"), MEDIA_TTL_MS);
    this.tiles = new FileCache(join(o.dataDir, "cache", "tiles"), TILE_TTL_MS);
    this.apis = new FileCache(join(o.dataDir, "cache", "api"), API_TTL_MS);
  }

  /** An external image by its address (validated here), from the cache when it is fresh. */
  image(raw: unknown): Promise<{ data: Buffer; type: string }> {
    const url = parseImageUrl(raw);
    if (!url) return Promise.reject(new MediaError(400, "media.badUrl"));
    const key = createHash("sha256").update(url.href).digest("hex");
    return this.once(`m:${key}`, async () => {
      const cached = this.media.get(key);
      const type = this.media.get(`${key}.type`)?.data.toString("utf8");
      if (cached?.fresh && type) return { data: cached.data, type };
      try {
        const got = await fetchImage(url, { resolve: this.o.resolve, userAgent: this.userAgent, maxBytes: MAX_PROXY_BYTES, timeoutMs: 20_000 });
        this.media.put(`${key}.type`, got.type);
        this.media.put(key, got.data);
        return got;
      } catch (e) {
        // The site is down for a moment: an older copy is better than a broken image. A refusal stays a refusal.
        if (cached && type && e instanceof MediaError && e.status === 502) return { data: cached.data, type };
        throw e;
      }
    });
  }

  /** An external image the proxy fetched before, fresh or not, without going out again; undefined when it has none. */
  cachedImage(raw: unknown): { data: Buffer; type: string } | undefined {
    const url = parseImageUrl(raw);
    if (!url) return undefined;
    const key = createHash("sha256").update(url.href).digest("hex");
    const cached = this.media.get(key);
    const type = this.media.get(`${key}.type`)?.data.toString("utf8");
    return cached && type ? { data: cached.data, type } : undefined;
  }

  /** One OpenStreetMap tile, fetched on demand (never in bulk), two connections at most, cached for 30 days. */
  tile(z: unknown, x: unknown, y: unknown): Promise<Buffer> {
    const t = parseTile(z, x, y);
    if (!t) return Promise.reject(new MediaError(400, "media.badTile"));
    const rel = join(String(t.z), String(t.x), `${t.y}.png`);
    return this.once(`t:${rel}`, async () => {
      const cached = this.tiles.get(rel);
      if (cached?.fresh) return { data: cached.data, type: "image/png" };
      const url = new URL((this.o.tileUrl ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png").replace("{z}", String(t.z)).replace("{x}", String(t.x)).replace("{y}", String(t.y)));
      try {
        const got = await this.tileLimit.run(() => fetchImage(url, { resolve: this.o.resolve, userAgent: this.userAgent, maxBytes: MAX_TILE_BYTES, timeoutMs: 15_000, accept: "image/png" }));
        this.tiles.put(rel, got.data);
        return got;
      } catch (e) {
        if (cached) return { data: cached.data, type: "image/png" };
        throw e instanceof MediaError && e.status === 403 ? e : new MediaError(502, "media.tileUnavailable", (e as Error).message);
      }
    }).then((r) => r.data);
  }

  /** An API's answer for a page (pages.ts says which hosts), cached for a few minutes for every open copy. */
  api(raw: unknown, hostAllowed: (host: string) => boolean): Promise<{ data: Buffer; type: string }> {
    const url = parseImageUrl(raw);
    if (!url) return Promise.reject(new MediaError(400, "media.badUrl"));
    if (!hostAllowed(url.hostname)) return Promise.reject(new MediaError(403, "media.hostNotAllowed", url.hostname));
    const key = createHash("sha256").update(url.href).digest("hex");
    return this.once(`a:${key}`, async () => {
      const cached = this.apis.get(key);
      const type = this.apis.get(`${key}.type`)?.data.toString("utf8");
      if (cached?.fresh && type) return { data: cached.data, type };
      try {
        const got = await fetchChecked(url, {
          resolve: this.o.resolve,
          userAgent: this.userAgent,
          maxBytes: MAX_API_BYTES,
          timeoutMs: 15_000,
          accept: "application/json, text/plain;q=0.8, */*;q=0.5",
          contentType: apiContentType,
          hostAllowed,
        });
        this.apis.put(`${key}.type`, got.type);
        this.apis.put(key, got.data);
        return got;
      } catch (e) {
        if (cached && type && e instanceof MediaError && e.status === 502) return { data: cached.data, type };
        throw e;
      }
    });
  }

  /** Drop cache entries nobody used for a long time. */
  prune(): void {
    this.media.prune();
    this.tiles.prune();
    this.apis.prune();
  }

  private once(key: string, fn: () => Promise<{ data: Buffer; type: string }>): Promise<{ data: Buffer; type: string }> {
    const running = this.inflight.get(key);
    if (running) return running;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}
