// Guarded HTTP GET: http/https only, SSRF checks on every hop, manual redirects, timeout, size cap, charset decoding.

import { assertPublicUrl, BlockedUrlError, defaultLookup, type LookupFn } from "./ssrf.ts";

export const MAX_REDIRECTS = 5;
export const MAX_BYTES = 5 * 1024 * 1024;
export const TIMEOUT_MS = 30_000;
export const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; piomio/0.1; personal agent)";

export interface FetchOptions {
  allowPrivate?: boolean;
  /**
   * The hub's proxy stands between this fetch and the network (behindHub): a host in a network of the person's own is
   * the hub's to decide, since it knows which ones they opened. This computer and link-local addresses never are.
   */
  hubDecides?: boolean;
  userAgent?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  lookup?: LookupFn;
  fetchImpl?: typeof fetch;
}

export interface FetchedPage {
  url: string;
  status: number;
  statusText: string;
  contentType: string;
  /** Decoded body (possibly cut at maxBytes). */
  text: string;
  bytes: number;
  truncated: boolean;
  redirects: string[];
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

/** This process reaches the network through the hub's proxy: the hub starts every plugin so (core plugins/host.ts). */
export function behindHub(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.PIOMIO_PLUGIN_ID && env.NODE_USE_ENV_PROXY === "1" && !!(env.HTTPS_PROXY || env.https_proxy) && !!(env.HTTP_PROXY || env.http_proxy);
}

export async function guardedFetch(rawUrl: string, o: FetchOptions = {}): Promise<FetchedPage> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError(`Invalid URL: ${rawUrl}`);
  }
  const fetchImpl = o.fetchImpl ?? fetch;
  const lookup = o.lookup ?? defaultLookup;
  const maxRedirects = o.maxRedirects ?? MAX_REDIRECTS;
  const signal = AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS);
  const redirects: string[] = [];
  try {
    for (let hop = 0; ; hop++) {
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedUrlError(`Only http and https URLs are supported (got ${url.protocol})`);
      let inside: BlockedUrlError["lan"];
      if (!o.allowPrivate) {
        try {
          await assertPublicUrl(url, lookup);
        } catch (e) {
          if (!o.hubDecides || !(e instanceof BlockedUrlError) || !e.lan) throw e;
          inside = e.lan;
        }
      }
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "GET",
          redirect: "manual",
          signal,
          headers: {
            "user-agent": o.userAgent || DEFAULT_USER_AGENT,
            accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
            "accept-language": "ru,en;q=0.8",
          },
        });
      } catch (e) {
        if (!inside || signal.aborted) throw e;
        throw new BlockedUrlError(
          `Could not open ${url.origin}: ${inside.host} resolves to a private address (${inside.addresses.join(", ")}) inside the person's network, and the hub did not let the connection through. ` +
            "If they have not allowed this host, call hub_network_request with it: the person answers on its card. If they have, the host is down or out of reach from the hub's computer.",
        );
      }
      if (REDIRECT.has(res.status)) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!location) throw new Error(`HTTP ${res.status} redirect without a Location header at ${url.href}`);
        if (hop >= maxRedirects) throw new Error(`Too many redirects (more than ${maxRedirects}), last: ${url.href}`);
        redirects.push(url.href);
        url = new URL(location, url);
        continue;
      }
      const { text, bytes, truncated } = await readBody(res, o.maxBytes ?? MAX_BYTES);
      return {
        url: url.href,
        status: res.status,
        statusText: res.statusText,
        contentType: res.headers.get("content-type") ?? "",
        text: text(res.headers.get("content-type") ?? ""),
        bytes,
        truncated,
        redirects,
      };
    }
  } catch (e: any) {
    if (e?.name === "TimeoutError" || (e?.name === "AbortError" && signal.aborted)) throw new Error(`Timed out after ${Math.round((o.timeoutMs ?? TIMEOUT_MS) / 1000)} s: ${url.href}`);
    if (e instanceof BlockedUrlError) throw e;
    if (e instanceof TypeError && e.cause) throw new Error(`Fetch failed for ${url.href}: ${(e.cause as any)?.code ?? (e.cause as any)?.message ?? e.message}`);
    throw e;
  }
}

async function readBody(res: Response, maxBytes: number): Promise<{ text: (ct: string) => string; bytes: number; truncated: boolean }> {
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
  const buf = Buffer.concat(chunks, total);
  return { text: (ct) => decode(buf, ct), bytes: total, truncated };
}

/** Decode bytes using the charset from the BOM, Content-Type or an HTML <meta> tag; UTF-8 otherwise. */
export function decode(buf: Buffer, contentType: string): string {
  let label: string | undefined;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) label = "utf-8";
  else if (buf[0] === 0xff && buf[1] === 0xfe) label = "utf-16le";
  else if (buf[0] === 0xfe && buf[1] === 0xff) label = "utf-16be";
  label ??= /charset=["']?([\w.:-]+)/i.exec(contentType)?.[1];
  if (!label && /html|xml/i.test(contentType || "html")) {
    const head = buf.subarray(0, 4096).toString("latin1");
    label = /<meta[^>]+charset=["']?([\w.:-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(label ?? "utf-8").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}
