// Minimal HTTP client on node:http(s): streaming bodies, AbortSignal, per-session egress proxy
// (the hub gives each brain session its own proxy token in opts.env), and error classification.

import http from "node:http";
import https from "node:https";
import type { Params } from "@piomio/shared";
import type { Part } from "./history.ts";

export type LlmErrorKind = "limit" | "auth" | "network" | "http" | "context" | "thinking" | "aborted";

export class LlmError extends Error {
  kind: LlmErrorKind;
  status?: number;
  resetAt?: string;
  /** Content streamed before the failure. */
  partial?: Part[];
  /** Catalog key (and params) of the text shown to the user; `message` is its English version (logs, fallback). */
  key?: string;
  params?: Params;
  constructor(kind: LlmErrorKind, message: string, extra: { status?: number; resetAt?: string; key?: string; params?: Params } = {}) {
    super(message);
    this.kind = kind;
    this.status = extra.status;
    this.resetAt = extra.resetAt;
    this.key = extra.key;
    this.params = extra.params;
  }
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Buffer>;
  text(): Promise<string>;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** HTTP(S)_PROXY / NO_PROXY to use for this request; undefined = process defaults. */
  proxyEnv?: Record<string, string>;
  /** Abort when the socket is idle this long (ms). 0 = never. */
  idleTimeoutMs?: number;
}

const agents = new Map<string, http.Agent>();

function agentFor(url: URL, proxyEnv: Record<string, string> | undefined): http.Agent | undefined {
  if (!proxyEnv) return undefined;
  const isHttps = url.protocol === "https:";
  const key = `${url.protocol}|${proxyEnv.HTTP_PROXY ?? ""}|${proxyEnv.HTTPS_PROXY ?? ""}|${proxyEnv.NO_PROXY ?? ""}`;
  let a = agents.get(key);
  if (!a) {
    a = isHttps ? new https.Agent({ keepAlive: true, proxyEnv }) : new http.Agent({ keepAlive: true, proxyEnv });
    agents.set(key, a);
  }
  return a;
}

/** Proxy settings from a brain session's env (opts.env), if it has any. */
export function proxyEnvFrom(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const get = (k: string) => env[k] ?? env[k.toLowerCase()];
  const httpsProxy = get("HTTPS_PROXY");
  const httpProxy = get("HTTP_PROXY");
  if (!httpsProxy && !httpProxy) return undefined;
  const out: Record<string, string> = {};
  if (httpsProxy) out.HTTPS_PROXY = httpsProxy;
  if (httpProxy) out.HTTP_PROXY = httpProxy;
  const noProxy = get("NO_PROXY");
  if (noProxy) out.NO_PROXY = noProxy;
  return out;
}

export function isAbortError(e: unknown): boolean {
  const err = e as { name?: string; code?: string } | undefined;
  return err?.name === "AbortError" || err?.code === "ABORT_ERR";
}

export function request(urlStr: string, o: RequestOptions = {}): Promise<HttpResponse> {
  const url = new URL(urlStr);
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { ...(o.headers ?? {}) };
    if (o.body !== undefined) headers["content-length"] = Buffer.byteLength(o.body);
    const req = mod.request(url, { method: o.method ?? "GET", headers, agent: agentFor(url, o.proxyEnv), signal: o.signal }, (res) => {
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
      resolve({
        status: res.statusCode ?? 0,
        headers: h,
        body: res,
        async text() {
          const chunks: Buffer[] = [];
          for await (const c of res) chunks.push(c as Buffer);
          return Buffer.concat(chunks).toString("utf8");
        },
      });
    });
    if (o.idleTimeoutMs) req.setTimeout(o.idleTimeoutMs, () => req.destroy(new Error(`no response for ${Math.round(o.idleTimeoutMs! / 1000)} s`)));
    req.on("error", reject);
    req.end(o.body);
  });
}

/** A fetch implementation over request(): lets SDK clients use the session's egress proxy and idle timeout. */
export function fetchVia(proxyEnv: Record<string, string> | undefined, idleTimeoutMs: number): typeof fetch {
  return async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body = init.body == null ? undefined : typeof init.body === "string" ? init.body : await new Response(init.body).text();
    const res = await request(url, { method: init.method ?? "GET", headers, body, signal: init.signal ?? undefined, proxyEnv, idleTimeoutMs });
    const out = new Headers();
    for (const [k, v] of Object.entries(res.headers)) out.set(k, v);
    const empty = res.status === 204 || res.status === 304 || init.method === "HEAD";
    return new Response(empty ? null : ReadableStream.from(res.body), { status: res.status, headers: out });
  };
}

// ---------- error classification ----------

function parseDuration(s: string): number | undefined {
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === "ms" ? n : m[2] === "s" ? n * 1000 : m[2] === "m" ? n * 60_000 : n * 3_600_000;
  }
  return matched ? total : undefined;
}

/** When a rate limit resets, from retry-after / anthropic-ratelimit-*-reset / x-ratelimit-reset-* headers. */
export function resetAtFromHeaders(h: Record<string, string>, now = Date.now()): string | undefined {
  const ra = h["retry-after"];
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return new Date(now + secs * 1000).toISOString();
    const d = Date.parse(ra);
    if (!Number.isNaN(d)) return new Date(d).toISOString();
  }
  const raMs = Number(h["retry-after-ms"]);
  if (h["retry-after-ms"] && Number.isFinite(raMs)) return new Date(now + raMs).toISOString();
  const candidates: number[] = [];
  for (const [k, v] of Object.entries(h)) {
    if (/^anthropic-ratelimit-.*reset$/.test(k)) {
      if (/^\d+$/.test(v)) {
        const n = Number(v);
        candidates.push(n > 1e12 ? n : n > 1e9 ? n * 1000 : now + n * 1000);
      } else {
        const d = Date.parse(v);
        if (!Number.isNaN(d)) candidates.push(d);
      }
    } else if (/^x-ratelimit-reset/.test(k)) {
      const ms = /^\d+(\.\d+)?$/.test(v) ? Number(v) * 1000 : parseDuration(v);
      if (ms !== undefined) candidates.push(now + ms);
    }
  }
  const future = candidates.filter((t) => t > now);
  return future.length ? new Date(Math.max(...future)).toISOString() : undefined;
}

const LIMIT_TYPES = /^(rate_limit_error|overloaded_error|rate_limit_exceeded|insufficient_quota|rate_limited|too_many_requests)$/i;
const CONTEXT_RE = /prompt is too long|context.{0,20}(length|window)|maximum context|too many tokens|exceeds the context|input is too long/i;

/** Turn a non-2xx response (or an in-stream error object) into an LlmError. */
export function classifyHttpError(status: number, headers: Record<string, string>, bodyText: string, provider: string): LlmError {
  let type = "";
  let message = "";
  try {
    const j = JSON.parse(bodyText);
    const err = j?.error ?? j;
    type = String(err?.type ?? err?.code ?? "");
    message = String(err?.message ?? (typeof j?.error === "string" ? j.error : "") ?? "");
  } catch {
    message = bodyText.trim().slice(0, 500);
  }
  if (!message) message = `HTTP ${status}`;
  if (status === 429 || status === 529 || LIMIT_TYPES.test(type) || (status === 503 && /overload/i.test(message))) {
    return new LlmError("limit", `${provider}: ${message}`, { status, resetAt: resetAtFromHeaders(headers) });
  }
  if (/egress to .* is not allowed/.test(message)) {
    return new LlmError("network", `The hub's network policy blocks this host (${message}). Allow it on the network card in the chat, or add it in the hub's settings.`, {
      status,
      key: "error.egressDenied",
      params: { message },
    });
  }
  if (status === 401 || status === 403) {
    return new LlmError("auth", `API key rejected (${provider}, ${status}): ${message}`, { status, key: "error.keyRejected", params: { provider, status, message } });
  }
  if ((status === 400 || status === 413) && CONTEXT_RE.test(message)) return new LlmError("context", `${provider}: ${message}`, { status });
  if (status === 400 && /signature|thinking/i.test(message)) return new LlmError("thinking", `${provider}: ${message}`, { status });
  if (status === 404) return new LlmError("http", `${provider}: model or URL not found (404): ${message}`, { status, key: "error.notFound", params: { provider, message } });
  return new LlmError("http", `${provider}: API error ${status}: ${message}`, { status, key: "error.api", params: { provider, status, message } });
}

/** Network-level failure (connection refused, DNS, TLS, reset). */
export function networkError(e: unknown, url: string): LlmError {
  const err = e as { message?: string; code?: string };
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep raw */
  }
  const detail = `${err?.code ? err.code + " " : ""}${err?.message ?? String(e)}`;
  return new LlmError("network", `Could not reach ${host}: ${detail}`, { key: "error.unreachable", params: { host, detail } });
}

export function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
