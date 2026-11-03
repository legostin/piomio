// HTTP client for the hub API. Every request names the interface language (x-piomio-locale) so the hub answers
// in it; non-GET requests carry the CSRF token and a JSON body ({} when empty), or raw bytes for a file upload.

import type { HubApi } from "@piomio/ui";
import { locale, t } from "../i18n";

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let csrfToken = "";
let unauthorizedHandler: (() => void) | undefined;

export function setCsrf(token: string): void {
  csrfToken = token;
}

/** Called on 401 from an authenticated endpoint (session expired → back to login). */
export function onUnauthorized(cb: () => void): void {
  unauthorizedHandler = cb;
}

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export async function request<T = any>(method: Method, path: string, body?: unknown): Promise<T> {
  return send<T>(method, path, method === "GET" ? undefined : { type: "application/json", body: JSON.stringify(body ?? {}) });
}

export interface UploadOptions {
  /** How much has gone, 0…1 (XMLHttpRequest: fetch cannot tell). */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** Raw bytes to the hub (a file for the next message). Aborted, it rejects with an AbortError. */
export function upload<T = any>(path: string, data: Blob, opts: UploadOptions = {}): Promise<T> {
  if (!opts.onProgress) return send<T>("POST", path, { type: "application/octet-stream", body: data }, opts.signal);
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const aborted = () => reject(new DOMException("aborted", "AbortError"));
    if (opts.signal?.aborted) return aborted();
    xhr.open("POST", path);
    xhr.withCredentials = true;
    xhr.setRequestHeader("accept", "application/json");
    xhr.setRequestHeader("x-piomio-locale", locale);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-csrf", csrfToken);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) opts.onProgress?.(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      try {
        resolve(settle<T>(xhr.status, xhr.statusText, xhr.responseText, path));
      } catch (e) {
        reject(e);
      }
    };
    xhr.onerror = () => reject(new ApiError(0, t("app.offline")));
    xhr.onabort = aborted;
    opts.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(data);
  });
}

async function send<T>(method: Method, path: string, payload?: { type: string; body: BodyInit }, signal?: AbortSignal, retry = true): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", "x-piomio-locale": locale };
  const init: RequestInit = {
    method,
    headers,
    signal,
    credentials: "same-origin",
    // The page is served with `Referrer-Policy: no-referrer`, which would make the browser send `Origin: null`
    // on same-origin POSTs. The hub checks Origin for state-changing requests, so opt back in per request.
    referrerPolicy: "same-origin",
  };
  if (method !== "GET") {
    headers["content-type"] = payload?.type ?? "application/json";
    headers["x-csrf"] = csrfToken;
    init.body = payload?.body ?? "{}";
  }
  let res: Response;
  try {
    res = await fetch(path, init);
    // Another window of the desktop app signed in anew (the windows share their cookies): this page's token is the old
    // session's. It takes the current one and tries once more.
    if (res.status === 403 && method !== "GET" && retry && (await res.clone().text()).includes("CSRF")) {
      const b = await fetch("/api/bootstrap", { headers: { accept: "application/json" }, credentials: "same-origin" });
      const fresh = b.ok ? ((await b.json()) as { csrf?: string }).csrf : undefined;
      if (fresh && fresh !== csrfToken) {
        csrfToken = fresh;
        return send<T>(method, path, payload, signal, false);
      }
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError(0, t("app.offline"));
  }
  return settle<T>(res.status, res.statusText, await res.text(), path);
}

/** A hub answer as data, or an ApiError with the hub's words (a 401 also sends the page back to sign-in). */
function settle<T>(status: number, statusText: string, text: string, path: string): T {
  const ok = status >= 200 && status < 300;
  let data: any = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!ok) {
    if (status === 401 && !path.startsWith("/api/auth/")) unauthorizedHandler?.();
    const msg = (data && typeof data === "object" && typeof data.error === "string" && data.error) || (typeof data === "string" && data.length < 300 ? data : "") || statusText || `HTTP ${status}`;
    throw new ApiError(status, msg, data);
  }
  return data as T;
}

export const api: HubApi = {
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body),
  put: (path, body) => request("PUT", path, body),
  patch: (path, body) => request("PATCH", path, body),
  del: (path) => request("DELETE", path),
};

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
