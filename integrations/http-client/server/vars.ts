// What is filled into a request when it leaves: `{{variables}}` from the call and the environment, then secrets from the
// vault for `vault://<id>` (or `vault://<id>#<field>`) references. The request as written is what the history keeps.

import { ClientError } from "./errors.ts";
import type { Pair, RequestSpec } from "./types.ts";
import type { Prepared } from "./send.ts";

const VAR = /\{\{\s*([\w.-]+)\s*\}\}/g;
const VAULT = /vault:\/\/([A-Za-z0-9][\w.-]{0,127}?)(?:#([\w.-]+))?(?![\w.-])/g;
/** The field of a vault item that is the secret, when the reference names none. */
const SECRET_FIELDS = ["value", "token", "key", "apiKey", "api_key", "secret", "password"];

const TEMPLATE = new RegExp(`${VAR.source}|${VAULT.source}`, "g");

export const hasTemplate = (s: string): boolean => s.includes("{{") || /vault:\/\//i.test(s);

/**
 * Where a value is put, which says how it has to be written there: as it is (`raw`: headers, a text body, the address
 * a person typed), inside a JSON body (escaped when it lands in a string), in a form body or an address's query
 * (percent-encoded).
 */
type Place = "raw" | "json" | "form" | "url";

/** What a body is, by its Content-Type. */
export function placeOf(contentType: string): Place {
  const ct = contentType.toLowerCase();
  return ct.includes("json") ? "json" : ct.includes("x-www-form-urlencoded") ? "form" : "raw";
}

/** A value as a form body writes it ("x y" is "x+y"). */
export const formValue = (s: string): string => new URLSearchParams([["", s]]).toString().slice(1);
/** A value as it stands inside a JSON string. */
export const jsonValue = (s: string): string => JSON.stringify(s).slice(1, -1);

/** Form encoding of a text whose `{{variables}}` and vault references stay as written, to be filled in when it leaves. */
export function formEncode(s: string): string {
  let out = "";
  let last = 0;
  for (const m of s.matchAll(TEMPLATE)) {
    out += formValue(s.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + formValue(s.slice(last));
}

/** Whether a position of a JSON text is inside a string. Asked in rising order of position. */
function insideJsonString(text: string): (index: number) => boolean {
  const strings: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start < 0) {
      if (c === '"') start = i;
    } else if (c === "\\") i++;
    else if (c === '"') {
      strings.push([start, i]);
      start = -1;
    }
  }
  if (start >= 0) strings.push([start, text.length]);
  let n = 0;
  return (index) => {
    while (n < strings.length && strings[n][1] < index) n++;
    return n < strings.length && strings[n][0] < index;
  };
}

/**
 * Every match of `re` that `value` knows, replaced by its value as that place writes it: a quote in a value put into a
 * JSON string must not end the string, an "&" in a form field must not start another. `later`: the value may hold a
 * vault reference that is filled in afterwards, so in a form it stays readable.
 */
function fill(text: string, re: RegExp, place: Place, value: (m: RegExpExecArray) => string | undefined, later = false): string {
  const inString = place === "json" ? insideJsonString(text) : undefined;
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    const v = value(m as RegExpExecArray);
    if (v === undefined) continue;
    const written = place === "form" ? (later ? formEncode(v) : formValue(v)) : place === "url" ? encodeURIComponent(v) : inString?.(m.index) ? jsonValue(v) : v;
    out += text.slice(last, m.index) + written;
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

/** The Content-Type a request's body goes out with: its own header, or the one its kind implies. */
function bodyType(spec: RequestSpec): string {
  return spec.headers?.find((h) => !h.off && h.name.trim().toLowerCase() === "content-type")?.value ?? DEFAULT_TYPE[spec.bodyType ?? "json"];
}

/** `{{name}}` filled from `vars`; a name that has no value throws, naming every one missing. */
export function fillVars(spec: RequestSpec, vars: Record<string, string>): RequestSpec {
  const missing = new Set<string>();
  const value = (m: RegExpExecArray): string | undefined => {
    if (Object.hasOwn(vars, m[1])) return vars[m[1]];
    missing.add(m[1]);
    return undefined;
  };
  const raw = (s: string) => fill(s, VAR, "raw", value);
  const pairs = (list: Pair[] | undefined) => list?.map((p) => ({ ...p, name: raw(p.name), value: raw(p.value) }));
  const filled: RequestSpec = {
    ...spec,
    url: raw(spec.url),
    ...(spec.query ? { query: pairs(spec.query) } : {}),
    ...(spec.headers ? { headers: pairs(spec.headers) } : {}),
    ...(spec.body !== undefined ? { body: fill(spec.body, VAR, placeOf(bodyType(spec)), value, true) } : {}),
  };
  if (missing.size) throw new ClientError("missingVars", { names: [...missing].join(", ") });
  return filled;
}

/** The address with its query parameters. A bare "api.example.com/x" is https. */
export function buildUrl(spec: RequestSpec): URL {
  const raw = spec.url.trim();
  if (!raw) throw new ClientError("noUrl");
  let url: URL;
  const whole = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  // "https://vault://id/x" would be read as a host called "vault": a reference is never where a request goes.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*vault:\/\//i.test(whole)) throw new ClientError("vaultInHost");
  try {
    url = new URL(whole);
  } catch {
    throw new ClientError("badUrl", { url: raw.slice(0, 200) });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ClientError("badUrl", { url: raw.slice(0, 200) });
  for (const p of spec.query ?? []) if (!p.off && p.name) url.searchParams.append(p.name, p.value);
  return url;
}

const DEFAULT_TYPE = { json: "application/json", text: "text/plain; charset=utf-8", form: "application/x-www-form-urlencoded" } as const;

/** The request as it goes out, before secrets: method, address, the headers that are on, the body with its type. */
export function prepare(spec: RequestSpec): Prepared {
  const url = buildUrl(spec);
  const headers: Array<[string, string]> = [];
  for (const h of spec.headers ?? []) if (!h.off && h.name.trim()) headers.push([h.name.trim(), h.value]);
  const carries = spec.method !== "GET" && spec.method !== "HEAD" && !!spec.body;
  if (carries && !headers.some(([name]) => name.toLowerCase() === "content-type")) headers.push(["content-type", DEFAULT_TYPE[spec.bodyType ?? "json"]]);
  return { method: spec.method, url: url.href, headers, ...(carries ? { body: spec.body } : {}) };
}

export interface VaultReader {
  get(ref: string, opts?: { domain?: string; reason?: string }): Promise<Record<string, string>>;
}

export interface Resolved {
  prepared: Prepared;
  /** The secret values that went in: cut from everything that is stored or shown. */
  secrets: string[];
  /** Lower-case names of headers that hold one. */
  secretHeaders: Set<string>;
}

/** Puts the vault's secrets in. The host never holds one: it is what the vault checks an item's scope against. */
export async function resolveSecrets(p: Prepared, vault: VaultReader): Promise<Resolved> {
  const url = new URL(p.url);
  if (/vault(?::|%3a)/i.test(url.host) || /vault(?::|%3a)/i.test(url.username + url.password)) throw new ClientError("vaultInHost");
  const values = new Map<string, string>();
  const items = new Map<string, Record<string, string>>();
  const read = async (s: string): Promise<void> => {
    for (const m of s.matchAll(VAULT)) {
      const [whole, id, field] = m;
      if (values.has(whole)) continue;
      let fields = items.get(id);
      if (!fields) {
        try {
          fields = await vault.get(`vault://${id}`, { domain: url.hostname, reason: `HTTP request to ${url.hostname}` });
        } catch (e: any) {
          throw new ClientError("vaultItem", { id, reason: String(e?.message ?? e).slice(0, 300) });
        }
        items.set(id, fields);
      }
      const name = field ?? SECRET_FIELDS.find((f) => typeof fields[f] === "string") ?? (Object.keys(fields).length === 1 ? Object.keys(fields)[0] : undefined);
      if (!name || typeof fields[name] !== "string") throw new ClientError("vaultField", { id, fields: Object.keys(fields).join(", ") || "none" });
      values.set(whole, fields[name]);
    }
  };
  // The address's own text: the parser may have escaped the reference inside a query.
  const href = decodeRefs(p.url);
  await read(href);
  for (const [, value] of p.headers) await read(value);
  if (p.body) await read(p.body);
  if (!values.size) return { prepared: p, secrets: [], secretHeaders: new Set() };

  const put = (s: string, place: Place): string => fill(s, VAULT, place, (m) => values.get(m[0]));
  const secretHeaders = new Set<string>();
  const headers = p.headers.map(([name, value]): [string, string] => {
    const filled = put(value, "raw");
    if (filled !== value) secretHeaders.add(name.toLowerCase());
    return [name, filled];
  });
  // A secret is written as its place needs it: a quote in a password must not end the JSON string it is put into.
  const body = placeOf(p.headers.find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "");
  return {
    prepared: { ...p, url: put(href, "url"), headers, ...(p.body !== undefined ? { body: put(p.body, body) } : {}) },
    secrets: [...new Set(values.values())].filter((v) => v.length >= 4),
    secretHeaders,
  };
}

/** "vault%3A%2F%2Fid%23field" as the URL parser wrote it inside a query, back to "vault://id#field". */
function decodeRefs(href: string): string {
  return href.replace(/vault(?::|%3a)(?:\/|%2f){2}[\w.-]+(?:(?:#|%23)[\w.-]+)?/gi, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });
}

/**
 * How a secret may come back: as it is, percent-encoded (an address, a form), or inside JSON, where quotes,
 * backslashes and control characters are escaped, once or twice (an echo of a JSON body is a string inside JSON),
 * and where some servers also escape "/" (PHP) or everything that is not ASCII (Python).
 */
function echoes(secret: string): string[] {
  const once = jsonValue(secret);
  const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return [secret, encodeURIComponent(secret), formValue(secret), once, jsonValue(once), once.replaceAll("/", "\\/"), ascii(once), ascii(once).replaceAll("/", "\\/")];
}

/** Secrets cut from a text: a server may echo what it was sent. */
export function redact(text: string, secrets: string[]): string {
  // The longest first: an escaped form holds the plain one inside it.
  const forms = [...new Set(secrets.flatMap(echoes))].filter((f) => f.length >= 4).sort((a, b) => b.length - a.length);
  let out = text;
  for (const f of forms) out = out.split(f).join("***");
  return out;
}
