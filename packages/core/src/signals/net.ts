// The watch's page loads from core go through the hub's egress proxy, as the triggers plugin's process did
// (HTTP(S)_PROXY with its token, NO_PROXY for loopback): every connection is checked and audited there. Node's own
// proxy support in http.Agent (proxyEnv) does the proxying. Compressed pages are unpacked, as fetch did. A trigger's
// script fetches the same way (pio.ts), with a token of its own whose allowlist is the trigger's hosts.

import http from "node:http";
import https from "node:https";
import { pipeline, Readable, Transform } from "node:stream";
import zlib from "node:zlib";
import type { FetchLike } from "./host.ts";

/** What fetch asked for; pages come back packed in one of these. */
const ACCEPT_ENCODING = "gzip, deflate, br";
// As fetch (undici) does: a stream cut short still gives what arrived.
const zflush = { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH };
/** "deflate" is a zlib stream by the standard, but some servers send it raw: the first byte tells (0x78 opens a zlib header). */
function inflateEither(): Transform {
  let inner: Transform | undefined;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (!inner) {
        const i = (inner = chunk[0] === 0x78 ? zlib.createInflate(zflush) : zlib.createInflateRaw(zflush));
        i.on("data", (d) => this.push(d));
        i.on("error", (e) => this.destroy(e));
      }
      inner.write(chunk, cb);
    },
    flush(cb) {
      if (!inner) return cb();
      inner.once("end", () => cb());
      inner.end();
    },
  });
}

const DECODERS: Record<string, () => Transform> = {
  gzip: () => zlib.createGunzip(zflush),
  "x-gzip": () => zlib.createGunzip(zflush),
  deflate: inflateEither,
  br: () => zlib.createBrotliDecompress({ flush: zlib.constants.BROTLI_OPERATION_FLUSH, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH }),
};

/** The decoders for a content-encoding, last applied first; undefined when it names one we cannot undo (the body stays as it is). */
function decodersFor(encoding: string | undefined): Transform[] | undefined {
  const codings = (encoding ?? "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c && c !== "identity");
  if (!codings.every((c) => DECODERS[c])) return undefined;
  return codings.reverse().map((c) => DECODERS[c]());
}

/** What the plugin process had in NO_PROXY: the hub's own machine is reached directly. */
export const LOOPBACK_NO_PROXY = "127.0.0.1,localhost,::1";

/** A GET (or a script's POST, with its body) through the proxy, and `close()`: its kept-alive connections go (the engine stopped). */
export type ProxiedGet = FetchLike & { close(): void };

export function proxiedGet(proxyUrl: string, noProxy = LOOPBACK_NO_PROXY): ProxiedGet {
  const proxyEnv = { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: noProxy };
  const agents = { http: new http.Agent({ keepAlive: true, proxyEnv }), https: new https.Agent({ keepAlive: true, proxyEnv }) };
  const get: FetchLike = (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const u = new URL(url);
      const secure = u.protocol === "https:";
      const asked = { "accept-encoding": ACCEPT_ENCODING, ...init.headers };
      const req = (secure ? https : http).request(u, { method: init.method ?? "GET", headers: asked, agent: secure ? agents.https : agents.http, signal: init.signal }, (res) => {
        const status = res.statusCode ?? 502;
        // A Response only takes 200-599; a server answering otherwise must not crash the hub.
        if (status < 200 || status > 599) {
          res.destroy();
          req.destroy();
          reject(new Error(`the server answered with status ${status}`));
          return;
        }
        try {
          // A Response cannot carry a body with these statuses.
          const empty = status === 204 || status === 205 || status === 304;
          const decoders = empty ? undefined : decodersFor(res.headers["content-encoding"]);
          // Unpacked, the body's encoding and length are no longer what the headers say.
          const unpacked = !!decoders?.length;
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined || (unpacked && (k === "content-encoding" || k === "content-length"))) continue;
            for (const x of Array.isArray(v) ? v : [v]) headers.append(k, x);
          }
          if (empty) res.resume();
          // A broken packed body errors the last stream, so reading it fails as a cut connection does.
          const body: Readable = unpacked ? (pipeline([res, ...decoders!], () => {}) as unknown as Readable) : res;
          resolve(new Response(empty ? null : (Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>), { status, headers }));
        } catch (e) {
          res.destroy();
          reject(e);
        }
      });
      req.on("error", reject);
      req.end(init.body);
    });
  return Object.assign(get, {
    close() {
      agents.http.destroy();
      agents.https.destroy();
    },
  });
}
