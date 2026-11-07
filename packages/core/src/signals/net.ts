// The watch's page loads from core go through the hub's egress proxy, as the triggers plugin's process did
// (HTTP(S)_PROXY with its token, NO_PROXY for loopback): every connection is checked and audited there. Node's own
// proxy support in http.Agent (proxyEnv) does the proxying.

import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import type { FetchLike } from "./host.ts";

/** What the plugin process had in NO_PROXY: the hub's own machine is reached directly. */
export const LOOPBACK_NO_PROXY = "127.0.0.1,localhost,::1";

/** A GET through the proxy, and `close()`: its kept-alive connections go (the engine stopped). */
export type ProxiedGet = FetchLike & { close(): void };

export function proxiedGet(proxyUrl: string, noProxy = LOOPBACK_NO_PROXY): ProxiedGet {
  const proxyEnv = { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: noProxy };
  const agents = { http: new http.Agent({ keepAlive: true, proxyEnv }), https: new https.Agent({ keepAlive: true, proxyEnv }) };
  const get: FetchLike = (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const u = new URL(url);
      const secure = u.protocol === "https:";
      const req = (secure ? https : http).request(u, { method: "GET", headers: init.headers, agent: secure ? agents.https : agents.http, signal: init.signal }, (res) => {
        const status = res.statusCode ?? 502;
        // A Response only takes 200-599; a server answering otherwise must not crash the hub.
        if (status < 200 || status > 599) {
          res.destroy();
          req.destroy();
          reject(new Error(`the server answered with status ${status}`));
          return;
        }
        try {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) for (const x of Array.isArray(v) ? v : [v]) headers.append(k, x);
          // A Response cannot carry a body with these statuses.
          const empty = status === 204 || status === 205 || status === 304;
          if (empty) res.resume();
          resolve(new Response(empty ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), { status, headers }));
        } catch (e) {
          res.destroy();
          reject(e);
        }
      });
      req.on("error", reject);
      req.end();
    });
  return Object.assign(get, {
    close() {
      agents.http.destroy();
      agents.https.destroy();
    },
  });
}
