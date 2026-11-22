// One request on the wire: redirects followed by hand (each hop checked like the first address), a timeout, a cap on
// what is read, text decoded by its charset, binary bodies only measured.

import { checkAddress, ClosedAddress, type Guard } from "./net.ts";
import type { Method, Pair, ResponseData, SendFailure } from "./types.ts";

export const MAX_REDIRECTS = 5;
export const MAX_BYTES = 5 * 1024 * 1024;
export const TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;
export const USER_AGENT = "Piomio-HTTP-Client/0.1 (+https://piomio.io)";

const REDIRECT = new Set([301, 302, 303, 307, 308]);
/** Headers the connection sets itself: a value written by hand would break the request. */
const HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer"]);
/** Never carried to another origin on a redirect. */
const CREDENTIALS = new Set(["authorization", "cookie", "proxy-authorization"]);

/** A request ready to leave: variables and secrets are in. */
export interface Prepared {
  method: Method;
  url: string;
  headers: Array<[string, string]>;
  body?: string;
}

export interface SendOptions {
  guard?: Guard;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  /** Lower-case names of headers that hold a secret: dropped when a redirect leaves the origin. */
  secretHeaders?: Set<string>;
}

export class SendError extends Error {
  code: SendFailure["code"];
  constructor(code: SendFailure["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const TEXT_TYPES = /^(?:text\/|application\/(?:json|xml|javascript|ecmascript|x-www-form-urlencoded|x-ndjson|graphql|yaml|x-yaml|toml|sql|xhtml\+xml)|image\/svg\+xml|[\w.-]+\/[\w.-]+\+(?:json|xml|yaml))/i;

/** Text by its type, or, without a telling type, by its bytes: no NUL and valid UTF-8. */
export function isText(contentType: string, head: Buffer): boolean {
  const ct = contentType.split(";")[0].trim().toLowerCase();
  if (TEXT_TYPES.test(ct)) return true;
  if (ct && ct !== "application/octet-stream") return false;
  if (!head.length) return true;
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, 4096), { stream: true });
    return true;
  } catch {
    return false;
  }
}

export function decode(buf: Buffer, contentType: string): string {
  let label: string | undefined;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) label = "utf-8";
  else if (buf[0] === 0xff && buf[1] === 0xfe) label = "utf-16le";
  else if (buf[0] === 0xfe && buf[1] === 0xff) label = "utf-16be";
  label ??= /charset=["']?([\w.:-]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(label ?? "utf-8").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

async function readBody(res: Response, maxBytes: number): Promise<{ buf: Buffer; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  }
  return { buf: Buffer.concat(chunks, total), truncated };
}

/** Sends it and reads the answer. Throws SendError when there is none. */
export async function send(p: Prepared, o: SendOptions = {}): Promise<ResponseData> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, o.timeoutMs ?? TIMEOUT_MS));
  const signal = AbortSignal.timeout(timeoutMs);
  let url: URL;
  try {
    url = new URL(p.url);
  } catch {
    throw new SendError("invalid", `Invalid address: ${p.url}`);
  }
  let method: string = p.method;
  let body = method === "GET" || method === "HEAD" ? undefined : p.body;
  let headers = p.headers.filter(([name]) => !HOP.has(name.toLowerCase()));
  if (!headers.some(([name]) => name.toLowerCase() === "user-agent")) headers.push(["user-agent", USER_AGENT]);
  const redirects: string[] = [];

  try {
    for (let hop = 0; ; hop++) {
      let lanAddrs: string[] | undefined;
      try {
        lanAddrs = await checkAddress(url, o.guard);
      } catch (e: any) {
        throw e instanceof ClosedAddress ? new SendError(e.kind === "scheme" ? "invalid" : e.kind, closedMessage(url, e)) : new SendError("network", e?.message ?? String(e));
      }
      let res: Response;
      try {
        res = await fetchImpl(url, { method, redirect: "manual", signal, headers, ...(body !== undefined && body !== "" ? { body } : {}) });
      } catch (e: any) {
        if (signal.aborted) throw e;
        if (lanAddrs) {
          throw new SendError(
            "lan",
            `Could not open ${url.origin}: ${url.hostname} resolves to a private address (${lanAddrs.join(", ")}) inside the person's network, and the hub did not let the connection through. ` +
              "If they have not allowed this host, call hub_network_request with it: the person answers on its card. If they have, the host is down or out of reach from the hub's computer.",
          );
        }
        // A bad header name or value is the caller's mistake, not the network's.
        if (e instanceof TypeError && !e.cause) throw new SendError("invalid", e.message);
        throw new SendError("network", `Request to ${url.origin} failed: ${(e?.cause as any)?.code ?? (e?.cause as any)?.message ?? e?.message ?? e}`);
      }
      if (REDIRECT.has(res.status) && res.headers.get("location")) {
        const location = res.headers.get("location")!;
        await res.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) throw new SendError("network", `Too many redirects (more than ${MAX_REDIRECTS}), last: ${url.href}`);
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new SendError("network", `HTTP ${res.status} redirect to an address that cannot be read: ${location}`);
        }
        redirects.push(url.href);
        // As browsers do: 303 always, 301 and 302 for anything but GET and HEAD, turn into a GET without the body.
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")) {
          method = res.status === 303 && method === "HEAD" ? "HEAD" : "GET";
          body = undefined;
          headers = headers.filter(([name]) => !/^content-/i.test(name));
        }
        if (next.origin !== url.origin) headers = headers.filter(([name]) => !CREDENTIALS.has(name.toLowerCase()) && !o.secretHeaders?.has(name.toLowerCase()));
        url = next;
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "";
      const { buf, truncated } = method === "HEAD" ? { buf: Buffer.alloc(0), truncated: false } : await readBody(res, o.maxBytes ?? MAX_BYTES);
      const text = isText(contentType, buf);
      const resHeaders: Pair[] = [];
      res.headers.forEach((value, name) => {
        if (name !== "set-cookie") resHeaders.push({ name, value });
      });
      for (const value of res.headers.getSetCookie?.() ?? []) resHeaders.push({ name: "set-cookie", value });
      return {
        status: res.status,
        statusText: res.statusText,
        headers: resHeaders,
        contentType,
        ...(text ? { body: decode(buf, contentType) } : { binary: true }),
        bytes: buf.length,
        ...(truncated ? { truncated: true } : {}),
        url: url.href,
        ...(redirects.length ? { redirects } : {}),
      };
    }
  } catch (e: any) {
    if (e instanceof SendError) throw e;
    if (e?.name === "TimeoutError" || signal.aborted) throw new SendError("timeout", `No answer in ${Math.round(timeoutMs / 1000)} s: ${url.origin}`);
    throw new SendError("network", e?.message ?? String(e));
  }
}

function closedMessage(url: URL, e: ClosedAddress): string {
  return e.kind === "lan"
    ? `Refusing to open ${url.origin}: ${e.message} The person can allow the host: hub_network_request asks them on a card.`
    : `Refusing to open ${url.origin}: ${e.message}`;
}
