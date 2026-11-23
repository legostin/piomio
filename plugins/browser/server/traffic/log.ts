// The browser's requests as agents see them (browser_requests): a log in memory of what every tab asked and got,
// kept only while the traffic ability is on, never written to disk as it is. Whatever leaves it for the model or a
// file goes through redact.ts first; the raw values stay here, so a request sent again carries them unseen.

import type { Page, Request, Response, WebSocket } from "playwright";
import { type Header, type Secrets, hideBody, hideBodyValue, hideHeaders, hideUrl, learn } from "./redact.ts";

export interface WsMessage {
  at: number;
  dir: "sent" | "received";
  text: string;
}

export interface Entry {
  id: number;
  tab: string;
  at: number;
  method: string;
  url: string;
  /** Playwright's resource type: document, xhr, fetch, script, image, websocket… */
  type: string;
  reqHeaders: Header[];
  reqBody?: string;
  reqBytes: number;
  status?: number;
  statusText?: string;
  resHeaders?: Header[];
  resBody?: string;
  /** The body was longer than is kept: its first part is here. */
  resCut?: boolean;
  resBytes?: number;
  ms?: number;
  failed?: string;
  /** What a rule or an agent did with it: "blocked by rule 3", "sent by the agent". */
  note?: string;
  ws?: WsMessage[];
}

export interface LogLimits {
  entries: number;
  requestBody: number;
  responseBody: number;
  totalBodies: number;
  wsMessages: number;
  wsText: number;
}

export const LOG_LIMITS: LogLimits = { entries: 1500, requestBody: 256 * 1024, responseBody: 512 * 1024, totalBodies: 48 * 1024 * 1024, wsMessages: 200, wsText: 4000 };

export interface LogFilter {
  match?: string;
  method?: string;
  /** 404, or a class: "4xx", "5xx", "failed". */
  status?: string;
  type?: string;
  /** Only requests after this one. */
  since?: number;
  /** A tab's number, or every tab when undefined. */
  tab?: string;
  limit?: number;
}

const header = (headers: Header[] | undefined, name: string) => headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
export const TEXT_TYPE = /json|^text\/|javascript|ecmascript|xml|x-www-form-urlencoded|graphql|event-stream|multipart\/form-data/i;

/**
 * A mask of an address as agents write it: a part of host + path + query, `*` for any run of characters, no scheme
 * («api.shop.kz/v1/cart*», «/orders», «*.png»). Case does not matter.
 */
export function maskRe(mask: string): RegExp {
  const m = mask
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*+/g, ".*");
  return new RegExp(m, "i");
}

/** What a mask is matched against: «api.shop.kz/v1/cart?x=1». */
export function maskTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

export class TrafficLog {
  /** Off: nothing is kept (pages stay tracked, so turning it on needs no reload). */
  on = false;
  private entries: Entry[] = [];
  private seq = 0;
  private bodies = 0;
  private byRequest = new WeakMap<Request, Entry>();
  private tracked = new WeakSet<Page>();
  private secrets: Secrets;
  private limits: LogLimits;

  constructor(secrets: Secrets, limits: LogLimits = LOG_LIMITS) {
    this.secrets = secrets;
    this.limits = limits;
  }

  /** Listen to a tab's requests (once per tab). `tab` gives the tab's number. */
  track(page: Page, tab: () => string): void {
    if (this.tracked.has(page)) return;
    this.tracked.add(page);
    page.on("request", (r) => this.onRequest(r, tab()));
    page.on("response", (r) => void this.onResponse(r));
    page.on("requestfinished", (r) => void this.onFinished(r));
    page.on("requestfailed", (r) => this.onFailed(r));
    page.on("websocket", (ws) => this.onWebSocket(ws, tab()));
  }

  /** Forget everything (the ability was turned off, or the person cleared the browser). */
  clear(): void {
    this.entries = [];
    this.bodies = 0;
  }

  get size(): number {
    return this.entries.length;
  }

  /** A request made outside the tabs (an agent's own), or a note on one a rule answered. */
  add(e: Omit<Entry, "id" | "at"> & { at?: number }): Entry {
    const entry: Entry = { ...e, id: ++this.seq, at: e.at ?? Date.now() };
    this.bodies += (entry.reqBody?.length ?? 0) + (entry.resBody?.length ?? 0);
    learn(this.secrets, { url: entry.url, headers: entry.reqHeaders, body: entry.reqBody, contentType: header(entry.reqHeaders, "content-type") });
    learn(this.secrets, { headers: entry.resHeaders, body: entry.resBody, contentType: header(entry.resHeaders, "content-type") });
    this.push(entry);
    return entry;
  }

  /** The request a rule is handling right now: its entry, to leave a note on. */
  entryOf(r: Request): Entry | undefined {
    return this.byRequest.get(r);
  }

  get(id: number): Entry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /** Matching requests, oldest first: the last `limit` of them, and how many matched in all. */
  list(f: LogFilter): { entries: Entry[]; total: number } {
    const re = f.match ? maskRe(f.match) : undefined;
    const method = f.method?.toUpperCase();
    const status = f.status?.toLowerCase();
    const all = this.entries.filter((e) => {
      if (f.tab !== undefined && e.tab !== f.tab) return false;
      if (f.since !== undefined && e.id <= f.since) return false;
      if (method && e.method !== method) return false;
      if (f.type && e.type !== f.type.toLowerCase()) return false;
      if (status) {
        if (status === "failed") {
          if (!e.failed) return false;
        } else if (/^\dxx$/.test(status)) {
          if (String(e.status ?? "")[0] !== status[0]) return false;
        } else if (String(e.status ?? "") !== status) return false;
      }
      return !re || re.test(maskTarget(e.url));
    });
    const limit = Math.min(200, Math.max(1, Math.round(f.limit ?? 40)));
    return { entries: all.slice(-limit), total: all.length };
  }

  private push(entry: Entry): void {
    this.entries.push(entry);
    while (this.entries.length > this.limits.entries) this.drop(this.entries.shift()!);
    // Too much kept: the oldest bodies go first, their requests stay in the list.
    for (let i = 0; this.bodies > this.limits.totalBodies && i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e === entry) break;
      this.drop(e);
      if (e.resBody !== undefined) e.resCut = true;
      e.reqBody = undefined;
      e.resBody = undefined;
    }
  }

  private drop(e: Entry): void {
    this.bodies -= (e.reqBody?.length ?? 0) + (e.resBody?.length ?? 0);
  }

  private onRequest(r: Request, tab: string): void {
    if (!this.on || !/^https?:/i.test(r.url())) return;
    const data = r.postDataBuffer();
    const type = r.headers()["content-type"] ?? "";
    const entry: Entry = { id: ++this.seq, tab, at: Date.now(), method: r.method(), url: r.url(), type: r.resourceType(), reqHeaders: [], reqBytes: data?.length ?? 0 };
    if (data && data.length <= this.limits.requestBody && (TEXT_TYPE.test(type) || !type)) {
      // Files in a form are bytes: read them as such, so their length counts right.
      entry.reqBody = data.toString(/multipart\/form-data/i.test(type) ? "latin1" : "utf8");
      this.bodies += entry.reqBody.length;
    }
    this.byRequest.set(r, entry);
    this.push(entry);
    // Every header as the browser sends it (cookies too); the event has only some.
    void r
      .headersArray()
      .then((h) => {
        entry.reqHeaders = h;
        learn(this.secrets, { url: entry.url, headers: h, body: entry.reqBody, contentType: type });
      })
      .catch(() => {});
  }

  private async onResponse(res: Response): Promise<void> {
    const entry = this.byRequest.get(res.request());
    if (!entry) return;
    entry.status = res.status();
    entry.statusText = res.statusText();
    entry.ms = Date.now() - entry.at;
    try {
      entry.resHeaders = await res.headersArray();
      learn(this.secrets, { headers: entry.resHeaders });
    } catch {
      /* the tab went away */
    }
  }

  private async onFinished(r: Request): Promise<void> {
    const entry = this.byRequest.get(r);
    if (!entry) return;
    entry.ms = Date.now() - entry.at;
    const res = await r.response().catch(() => null);
    if (!res) return;
    entry.resHeaders ??= await res.headersArray().catch(() => undefined);
    const type = header(entry.resHeaders, "content-type");
    const length = Number(header(entry.resHeaders, "content-length")) || undefined;
    entry.resBytes = length;
    // Redirects and empty answers have no body; pictures and media keep their size only.
    if (entry.status === undefined || (entry.status >= 300 && entry.status < 400) || entry.status === 204 || !TEXT_TYPE.test(type)) return;
    if (length !== undefined && length > this.limits.responseBody * 4) return;
    try {
      const buf = await res.body();
      entry.resBytes = buf.length;
      const cut = buf.length > this.limits.responseBody;
      entry.resBody = (cut ? buf.subarray(0, this.limits.responseBody) : buf).toString("utf8");
      entry.resCut = cut || undefined;
      this.bodies += entry.resBody.length;
      if (!cut) learn(this.secrets, { body: entry.resBody, contentType: type });
    } catch {
      /* the page navigated away before the body was read */
    }
  }

  private onFailed(r: Request): void {
    const entry = this.byRequest.get(r);
    if (!entry) return;
    entry.failed = r.failure()?.errorText ?? "failed";
    entry.ms = Date.now() - entry.at;
  }

  private onWebSocket(ws: WebSocket, tab: string): void {
    if (!this.on) return;
    const entry: Entry = { id: ++this.seq, tab, at: Date.now(), method: "WS", url: ws.url(), type: "websocket", reqHeaders: [], reqBytes: 0, ws: [] };
    this.push(entry);
    const message = (dir: WsMessage["dir"]) => (data: { payload: string | Buffer }) => {
      const text = typeof data.payload === "string" ? data.payload.slice(0, this.limits.wsText) : `[binary, ${data.payload.length} bytes]`;
      entry.ws!.push({ at: Date.now(), dir, text });
      if (entry.ws!.length > this.limits.wsMessages) entry.ws!.shift();
      entry.reqBytes += dir === "sent" ? data.payload.length : 0;
      entry.resBytes = (entry.resBytes ?? 0) + (dir === "received" ? data.payload.length : 0);
    };
    ws.on("framesent", message("sent"));
    ws.on("framereceived", message("received"));
    ws.on("socketerror", (error) => (entry.failed = String(error).slice(0, 200)));
    ws.on("close", () => (entry.ms = Date.now() - entry.at));
  }
}

// ---------- what agents read ----------

const size = (n: number | undefined) => (n === undefined ? "" : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const clock = (at: number) => new Date(at).toTimeString().slice(0, 8);
/** «json», «html», «javascript» of a content type. */
const kind = (type: string) => (/json/i.test(type) ? "json" : (/^[a-z0-9.-]+/i.exec(type.split("/")[1] ?? "")?.[0]?.replace(/^x-/, "") ?? ""));
const cutText = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** One line of the list: `#412 14:02:07 POST api.shop.kz/v1/cart → 200 json 1.2 KB 140 ms`. */
export function entryLine(e: Entry, s: Secrets): string {
  const shown = cutText(hideUrl(e.url, s).replace(/^[a-z]+:\/\//i, ""), 180);
  const result = e.failed ? `failed (${e.failed})` : e.status === undefined ? (e.type === "websocket" ? `open, ${e.ws?.length ?? 0} messages` : "pending") : String(e.status);
  const tail = [e.type === "websocket" ? "" : kind(header(e.resHeaders, "content-type")) || e.type, size(e.resBytes), e.ms !== undefined ? `${e.ms} ms` : "", e.note ? `[${e.note}]` : ""].filter(Boolean);
  return `#${e.id} ${clock(e.at)} ${e.method} ${shown} → ${result}${tail.length ? ` ${tail.join(" ")}` : ""}`;
}

/** Headers worth reading: HTTP/2's own lines (:authority, :path…) repeat the address. */
const shownHeaders = (h: Header[] | undefined, s: Secrets) => hideHeaders((h ?? []).filter(({ name }) => !name.startsWith(":")), s);
const headerLines = (h: Header[], s: Secrets) => shownHeaders(h, s).map(({ name, value }) => `  ${name}: ${cutText(value, 500)}`);

function bodyText(body: string | undefined, type: string, s: Secrets, max: number): string {
  if (body === undefined) return "";
  const text = hideBody(body, type, s);
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters: maxChars raises it)` : text;
}

/** One request in full, as text. */
export function entryText(e: Entry, s: Secrets, maxChars: number): string {
  const reqType = header(e.reqHeaders, "content-type");
  const resType = header(e.resHeaders, "content-type");
  const out = [`#${e.id} ${e.method} ${hideUrl(e.url, s)}`, `Tab ${e.tab}, ${clock(e.at)}, ${e.type}${e.note ? `, ${e.note}` : ""}`];
  out.push(e.failed ? `Failed: ${e.failed}` : e.status === undefined ? "No response yet." : `→ ${e.status}${e.statusText ? ` ${e.statusText}` : ""}${resType ? `, ${resType}` : ""}${e.resBytes !== undefined ? `, ${size(e.resBytes)}` : ""}${e.ms !== undefined ? `, ${e.ms} ms` : ""}`);
  if (e.reqHeaders.length) out.push("Request headers:", ...headerLines(e.reqHeaders, s));
  if (e.reqBody !== undefined) out.push(`Request body (${size(e.reqBytes)}):`, bodyText(e.reqBody, reqType, s, maxChars));
  else if (e.reqBytes && e.type !== "websocket") out.push(`Request body: ${size(e.reqBytes)}, not kept (not text, or too large).`);
  if (e.resHeaders?.length) out.push("Response headers:", ...headerLines(e.resHeaders, s));
  if (e.resBody !== undefined) out.push(`Response body${e.resCut ? " (its first part: the rest was not kept)" : ""}:`, bodyText(e.resBody, resType, s, maxChars));
  else if (e.status !== undefined && e.type !== "websocket") out.push("Response body: not kept (not text, too large, or dropped to make room).");
  if (e.ws) {
    out.push(`Messages (the last ${e.ws.length}):`, ...e.ws.map((m) => `  ${clock(m.at)} ${m.dir === "sent" ? "→" : "←"} ${cutText(s.scrub(hideBody(m.text, "", s)), maxChars)}`));
  }
  return out.join("\n");
}

const headerMap = (h: Header[] | undefined, s: Secrets) => Object.fromEntries(shownHeaders(h, s).map(({ name, value }) => [name.toLowerCase(), value]));

/** One request as an object (a skill's script reads these): JSON bodies parsed, everything hidden as in the text. */
export function entryJson(e: Entry, s: Secrets, maxChars: number, bodies: boolean): Record<string, unknown> {
  const body = (text: string | undefined, type: string) => {
    if (text === undefined) return undefined;
    if (text.length > maxChars) return `${hideBody(text, type, s).slice(0, maxChars)}…`;
    return hideBodyValue(text, type, s);
  };
  return {
    id: e.id,
    tab: e.tab,
    time: new Date(e.at).toISOString(),
    method: e.method,
    url: hideUrl(e.url, s),
    type: e.type,
    ...(e.status !== undefined ? { status: e.status } : {}),
    ...(e.failed ? { failed: e.failed } : {}),
    ...(e.ms !== undefined ? { ms: e.ms } : {}),
    ...(e.resBytes !== undefined ? { bytes: e.resBytes } : {}),
    ...(e.note ? { note: e.note } : {}),
    ...(bodies
      ? {
          requestHeaders: headerMap(e.reqHeaders, s),
          ...(e.reqBody !== undefined ? { requestBody: body(e.reqBody, header(e.reqHeaders, "content-type")) } : {}),
          responseHeaders: headerMap(e.resHeaders, s),
          ...(e.resBody !== undefined ? { responseBody: body(e.resBody, header(e.resHeaders, "content-type")) } : {}),
          ...(e.ws ? { messages: e.ws.map((m) => ({ time: new Date(m.at).toISOString(), dir: m.dir, text: hideBody(m.text, "", s) })) } : {}),
        }
      : {}),
  };
}

/** The requests as a HAR 1.2 file (what browsers' developer tools open), hidden like everything else. */
export function toHar(entries: Entry[], s: Secrets): string {
  const pairs = (h: Header[] | undefined) => shownHeaders(h, s);
  const query = (url: string) => {
    try {
      return [...new URL(hideUrl(url, s)).searchParams].map(([name, value]) => ({ name, value }));
    } catch {
      return [];
    }
  };
  return JSON.stringify(
    {
      log: {
        version: "1.2",
        creator: { name: "Piomio", version: "1" },
        entries: entries
          .filter((e) => e.type !== "websocket")
          .map((e) => {
            const reqType = header(e.reqHeaders, "content-type");
            const resType = header(e.resHeaders, "content-type");
            return {
              startedDateTime: new Date(e.at).toISOString(),
              time: e.ms ?? 0,
              request: {
                method: e.method,
                url: hideUrl(e.url, s),
                httpVersion: "HTTP/1.1",
                cookies: [],
                headers: pairs(e.reqHeaders),
                queryString: query(e.url),
                headersSize: -1,
                bodySize: e.reqBytes,
                ...(e.reqBody !== undefined ? { postData: { mimeType: reqType, text: hideBody(e.reqBody, reqType, s) } } : {}),
              },
              response: {
                status: e.status ?? 0,
                statusText: e.failed ?? e.statusText ?? "",
                httpVersion: "HTTP/1.1",
                cookies: [],
                headers: pairs(e.resHeaders),
                content: { size: e.resBytes ?? 0, mimeType: resType, ...(e.resBody !== undefined ? { text: hideBody(e.resBody, resType, s) } : {}) },
                redirectURL: hideUrl(header(e.resHeaders, "location"), s),
                headersSize: -1,
                bodySize: e.resBytes ?? -1,
              },
              cache: {},
              timings: { send: 0, wait: e.ms ?? 0, receive: 0 },
              ...(e.note ? { comment: e.note } : {}),
            };
          }),
      },
    },
    null,
    1,
  );
}
