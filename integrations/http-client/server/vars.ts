// What is filled into a request when it leaves: `{{variables}}` from the call and the environment, then secrets from the
// vault for `vault://<id>` (or `vault://<id>#<field>`) references. The request as written is what the history keeps.

import { ClientError } from "./errors.ts";
import type { Pair, RequestSpec } from "./types.ts";
import type { Prepared } from "./send.ts";

const VAR = /\{\{\s*([\w.-]+)\s*\}\}/g;
const VAULT = /vault:\/\/([A-Za-z0-9][\w.-]{0,127}?)(?:#([\w.-]+))?(?![\w.-])/g;
/** The field of a vault item that is the secret, when the reference names none. */
const SECRET_FIELDS = ["value", "token", "key", "apiKey", "api_key", "secret", "password"];

export const hasTemplate = (s: string): boolean => s.includes("{{") || /vault:\/\//i.test(s);

/** Every string of a request, mapped. */
function mapSpec(spec: RequestSpec, fn: (s: string) => string): RequestSpec {
  const pairs = (list: Pair[] | undefined) => list?.map((p) => ({ ...p, name: fn(p.name), value: fn(p.value) }));
  return {
    ...spec,
    url: fn(spec.url),
    ...(spec.query ? { query: pairs(spec.query) } : {}),
    ...(spec.headers ? { headers: pairs(spec.headers) } : {}),
    ...(spec.body !== undefined ? { body: fn(spec.body) } : {}),
  };
}

/** `{{name}}` filled from `vars`; a name that has no value throws, naming every one missing. */
export function fillVars(spec: RequestSpec, vars: Record<string, string>): RequestSpec {
  const missing = new Set<string>();
  const filled = mapSpec(spec, (s) =>
    s.replace(VAR, (whole, name: string) => {
      if (Object.hasOwn(vars, name)) return vars[name];
      missing.add(name);
      return whole;
    }),
  );
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

  const put = (s: string, encode = false): string => s.replace(VAULT, (whole) => (values.has(whole) ? (encode ? encodeURIComponent(values.get(whole)!) : values.get(whole)!) : whole));
  const secretHeaders = new Set<string>();
  const headers = p.headers.map(([name, value]): [string, string] => {
    const filled = put(value);
    if (filled !== value) secretHeaders.add(name.toLowerCase());
    return [name, filled];
  });
  return {
    prepared: { ...p, url: put(href, true), headers, ...(p.body !== undefined ? { body: put(p.body) } : {}) },
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

/** Secrets cut from a text: a server may echo what it was sent. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    out = out.split(s).join("***");
    const enc = encodeURIComponent(s);
    if (enc !== s) out = out.split(enc).join("***");
  }
  return out;
}
