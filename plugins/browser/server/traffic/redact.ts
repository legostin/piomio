// What of the browser's traffic the model never sees: cookies, tokens, passwords, card numbers. Everything an agent
// reads of a request (browser_requests, a saved HAR) passes through here first. Three nets, each catching what the
// others miss: the field's name, the value's shape, and values already known to be secret (they travelled in a cookie
// or an Authorization header, or sat in a field hidden by name), which are hidden wherever they show up again.
// Pure: no Playwright, no I/O.

export const HIDDEN = "«hidden»";

export type Header = { name: string; value: string };

/** Where a name stands: plain «code» is an OAuth code in an address or a form, and a status in most JSON. */
type Where = "header" | "query" | "form" | "json";

/** camelCase, kebab-case, snake_case and dotted names as lowercase words: «X-CSRF-Token» → x, csrf, token. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const SECRET_WORDS = new Set([
  "token", "tokens", "secret", "secrets", "password", "passwd", "pwd", "pass", "passphrase", "passcode", "pincode", "session", "sessionid", "sid",
  "csrf", "xsrf", "signature", "sig", "otp", "totp", "pin", "cvv", "cvc", "cvv2", "cvc2", "credential", "credentials", "cookie", "cookies", "jwt", "bearer",
  "apikey", "authorization", "ccnum", "cardnumber",
]); // prettier-ignore
/** Inside one word («accesstoken», «xauthtoken»). */
const SECRET_PART = /token|secret|passw|session|csrf|xsrf|apikey|cardnum/;
/** auth, oauth, authenticate… and not author. */
const AUTH_WORD = /^o?auth(?!or)/;
/** Words that make «code» or «key» next to them a secret: verification code, api key. */
const CODE_KIND = new Set(["verification", "verify", "confirm", "confirmation", "sms", "security", "otp", "access", "auth", "login", "reset", "recovery", "invite", "one", "2fa", "mfa"]);
const KEY_KIND = new Set(["api", "access", "secret", "private", "auth", "client", "app", "license", "encryption", "signing", "master"]);

/**
 * Is a field of this name a secret? "always": whatever its value; "weak": only a value that looks random (plain
 * «key», «code», «id» of a session in JSON are far more often ordinary data).
 */
export function secretName(name: string, where: Where): "always" | "weak" | undefined {
  const w = nameWords(name);
  if (!w.length) return undefined;
  if (w.some((x) => SECRET_WORDS.has(x) || SECRET_PART.test(x) || AUTH_WORD.test(x))) return "always";
  if (w.includes("card") && w.some((x) => x === "number" || x === "num" || x === "no")) return "always";
  if (w.includes("code")) {
    if (w.some((x) => CODE_KIND.has(x))) return "always";
    if (w.length === 1) return where === "query" || where === "form" ? "always" : "weak";
  }
  if (w.includes("key")) {
    if (w.some((x) => KEY_KIND.has(x))) return "always";
    if (w.length === 1 || where === "header") return "weak";
  }
  return undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hasBoth = (v: string) => /[A-Za-z]/.test(v) && /\d/.test(v);

/**
 * A value that reads as machine-made: one run of token characters in which lowercase, uppercase and digits keep
 * alternating (base64, hex). A slug («how-to-reset-a-router-2024»), a path, a file name and a UUID are not.
 */
export function looksRandom(v: string, min: number): boolean {
  if (v.length < min || v.length > 4096 || v.startsWith("/") || UUID.test(v) || !/^[A-Za-z0-9_\-+/=]+$/.test(v)) return false;
  let changes = 0;
  let prev = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    const kind = c >= 48 && c <= 57 ? 1 : c >= 97 && c <= 122 ? 2 : c >= 65 && c <= 90 ? 3 : prev;
    if (prev && kind !== prev) changes++;
    prev = kind;
  }
  return changes >= v.length / 5;
}

/** Luhn's check: what tells a card number from another long number. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = digits.length - 1, double = false; i >= 0; i--, double = !double) {
    let d = digits.charCodeAt(i) - 48;
    if (double && (d *= 2) > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}

const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const SCHEME = /\b(Bearer|Basic|Token|Digest)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const CARD = /(?<![\d.])\d(?:[ -]?\d){12,18}(?![\d.])/g;

/** Secrets by their shape anywhere in a text: JSON Web Tokens, «Bearer …», card numbers. */
function hideShapes(text: string): string {
  return text
    .replace(JWT, HIDDEN)
    .replace(SCHEME, `$1 ${HIDDEN}`)
    .replace(CARD, (m) => (luhn(m.replace(/\D/g, "")) ? HIDDEN : m));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Values known to be secret in this browser. Kept while the plugin runs; the oldest go once there are too many.
 * Short and plain values are not kept: hiding every «accepted» or «12» in every body would hide nothing useful.
 */
export class Secrets {
  private values = new Set<string>();
  private re: RegExp | null | undefined;
  private max: number;

  constructor(max = 5000) {
    this.max = max;
  }

  /** `sure`: the value is a secret for certain (the vault typed it), so a short or plain one is kept too. */
  add(value: unknown, sure = false): void {
    if (typeof value !== "string") return;
    const v = value.trim();
    const worth = sure ? v.length >= 4 : v.length >= 16 || (v.length >= 8 && hasBoth(v));
    if (v.length > 4096 || !worth || this.values.has(v)) return;
    this.values.add(v);
    if (this.values.size > this.max) this.values.delete(this.values.values().next().value!);
    this.re = undefined;
  }

  get size(): number {
    return this.values.size;
  }

  /** `text` with every known value, as it is and percent-encoded, hidden. */
  scrub(text: string): string {
    if (!text || !this.values.size) return text;
    if (this.re === undefined) {
      const all = new Set<string>();
      for (const v of this.values) {
        all.add(v);
        const enc = encodeURIComponent(v);
        if (enc !== v) all.add(enc);
      }
      // Longest first: a value that contains another is hidden whole.
      this.re = new RegExp([...all].sort((a, b) => b.length - a.length).map(escapeRe).join("|"), "g");
    }
    return text.replace(this.re!, HIDDEN);
  }
}

/** `name: "value"` and `name = 'value'` in a script or a page (an inline config, a token a page keeps in a variable). */
const ASSIGNED = /(["']?)([A-Za-z_$][\w$.-]{1,60})\1(\s*[:=]\s*)(["'`])((?:\\.|(?!\4)[^\\\n]){1,4096})\4/g;
const INPUT_TAG = /<input\b[^>]*>/gi;
const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
const attrValue = (m: RegExpExecArray | null) => m?.[1] ?? m?.[2] ?? m?.[3];

/** Is the value assigned to `name` in a text a secret: by the name, or by how it looks? */
function secretAssigned(name: string, value: string): boolean {
  const kind = secretName(name.split(".").pop() ?? name, "json");
  return kind === "always" || (kind === "weak" && looksRandom(value, 16)) || looksRandom(value, 32);
}

/** The secrets a page's HTML or a script spells out: fields of a form filled in ahead, values assigned to secret names. */
function secretsInText(text: string, found: (value: string, start: number, end: number) => void): void {
  for (const m of text.matchAll(INPUT_TAG)) {
    const tag = m[0];
    const value = attr(tag, "value");
    const v = attrValue(value);
    if (!value || !v) continue;
    const type = attrValue(attr(tag, "type"))?.toLowerCase();
    const name = attrValue(attr(tag, "name")) ?? attrValue(attr(tag, "id")) ?? "";
    if (type !== "password" && secretName(name, "form") !== "always") continue;
    const at = m.index + value.index + value[0].lastIndexOf(v);
    found(v, at, at + v.length);
  }
  for (const m of text.matchAll(ASSIGNED)) {
    if (!secretAssigned(m[2], m[5])) continue;
    const at = m.index + m[0].length - 1 - m[5].length;
    found(m[5], at, at + m[5].length);
  }
}

/** A text that is neither JSON nor a form (HTML, a script, plain text) as the model may see it. */
function hideText(text: string, s: Secrets): string {
  const spans: Array<[number, number]> = [];
  secretsInText(text, (_v, start, end) => spans.push([start, end]));
  let out = text;
  // From the end, so earlier positions stay right; spans inside one another collapse into the outer one.
  spans.sort((a, b) => b[0] - a[0]);
  let before = Infinity;
  for (const [start, end] of spans) {
    if (end > before) continue;
    out = out.slice(0, start) + HIDDEN + out.slice(end);
    before = start;
  }
  return s.scrub(hideShapes(out));
}

/** One value as the model may see it: hidden by its name, else by shape and by what is known. */
function hideValue(name: string, value: string, where: Where, s: Secrets): string {
  const kind = secretName(name, where);
  if (kind === "always" || (kind === "weak" && looksRandom(value, 16))) return value ? HIDDEN : value;
  if (looksRandom(value, 32)) return HIDDEN;
  return s.scrub(hideShapes(value));
}

/** `name=value; name=value` of a Cookie header with the values hidden. */
const hideCookiePairs = (v: string) =>
  v
    .split(";")
    .map((p) => {
      const i = p.indexOf("=");
      return i < 0 ? p.trim() : `${p.slice(0, i).trim()}=${HIDDEN}`;
    })
    .join("; ");

/** Set-Cookie: the cookie's name and attributes stay, its value does not. */
function hideSetCookie(v: string): string {
  return v
    .split("\n")
    .map((line) => {
      const [first, ...attrs] = line.split(";");
      const i = first.indexOf("=");
      return [i < 0 ? first.trim() : `${first.slice(0, i).trim()}=${HIDDEN}`, ...attrs.map((a) => a.trim())].join("; ");
    })
    .join("\n");
}

export function hideHeaders(headers: Header[], s: Secrets): Header[] {
  return headers.map(({ name, value }) => {
    const n = name.toLowerCase();
    if (n === "cookie") return { name, value: hideCookiePairs(value) };
    if (n === "set-cookie") return { name, value: hideSetCookie(value) };
    if (n === "authorization" || n === "proxy-authorization") {
      const scheme = /^(\w+)\s+\S/.exec(value)?.[1];
      return { name, value: scheme ? `${scheme} ${HIDDEN}` : HIDDEN };
    }
    if (n === "referer" || n === "location" || n === "origin") return { name, value: hideUrl(value, s) };
    return { name, value: hideValue(name, value, "header", s) };
  });
}

/** An address with its secret query parameters, user:password and known values hidden. */
export function hideUrl(url: string, s: Secrets): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return s.scrub(hideShapes(url));
  }
  if (u.username || u.password) {
    u.username = "";
    u.password = "";
  }
  const query = [...u.searchParams].map(([k, v]) => `${encodeURIComponent(k)}=${v === "" ? "" : encodeQuery(hideValue(k, v, "query", s))}`).join("&");
  // A token in a fragment (OAuth's implicit flow) is a query of its own.
  const hash = /^#.*=/.test(u.hash) ? `#${hideForm(u.hash.slice(1), s)}` : u.hash;
  return s.scrub(hideShapes(`${u.origin}${u.pathname}`)) + (query ? `?${query}` : "") + hash;
}

/** Percent-encoding that leaves the hidden mark readable. */
const encodeQuery = (v: string) => v.split(HIDDEN).map(encodeURIComponent).join(HIDDEN);

/** `a=1&password=…` with secret fields hidden (shown decoded). */
export function hideForm(body: string, s: Secrets): string {
  return [...new URLSearchParams(body)].map(([k, v]) => `${k}=${hideValue(k, v, "form", s)}`).join("&");
}

/** A parsed JSON value with secrets hidden: a secret name hides everything under it. */
export function hideJson(value: unknown, s: Secrets, name = "", depth = 0): unknown {
  if (typeof value === "string") {
    // JSON inside a string (a body field that carries another document).
    if (depth < 4 && value.length < 200_000 && /^\s*[[{]/.test(value)) {
      try {
        return JSON.stringify(hideJson(JSON.parse(value), s, name, depth + 1));
      } catch {
        /* not JSON: a plain string */
      }
    }
    return hideValue(name, value, "json", s);
  }
  if (typeof value === "number") {
    const kind = secretName(name, "json");
    if (kind === "always") return HIDDEN;
    const digits = String(value);
    return /^\d{13,19}$/.test(digits) && luhn(digits) ? HIDDEN : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (name && secretName(name, "json") === "always") return HIDDEN;
  if (Array.isArray(value)) return value.map((v) => hideJson(v, s, name, depth));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hideJson(v, s, k, depth)]));
}

const isJson = (type: string) => /\bjson\b/i.test(type);
const isForm = (type: string) => /x-www-form-urlencoded/i.test(type);
const isMultipart = (type: string) => /multipart\/form-data/i.test(type);

/** multipart/form-data as «name: value» lines: text fields hidden by name, files by their name and size only. */
function hideMultipart(body: string, type: string, s: Secrets): string {
  const boundary = /boundary=("?)([^";]+)\1/i.exec(type)?.[2];
  if (!boundary) return s.scrub(hideShapes(body));
  const out: string[] = [];
  for (const part of body.split(`--${boundary}`)) {
    const cut = part.search(/\r?\n\r?\n/);
    if (cut < 0) continue;
    const head = part.slice(0, cut);
    const name = /name="([^"]*)"/i.exec(head)?.[1];
    if (name === undefined) continue;
    const content = part.slice(cut).replace(/^\r?\n\r?\n/, "").replace(/\r?\n$/, "");
    const file = /filename="([^"]*)"/i.exec(head)?.[1];
    out.push(file !== undefined ? `${name}: file "${file}" (${content.length} bytes)` : `${name}: ${hideValue(name, content, "form", s)}`);
  }
  return out.join("\n");
}

/** A body as the model may see it, by its content type. */
export function hideBody(body: string, contentType: string, s: Secrets): string {
  if (!body) return body;
  if (isJson(contentType) || /^\s*[[{]/.test(body)) {
    try {
      return JSON.stringify(hideJson(JSON.parse(body), s));
    } catch {
      /* not JSON after all */
    }
  }
  if (isForm(contentType)) return hideForm(body, s);
  if (isMultipart(contentType)) return hideMultipart(body, contentType, s);
  return hideText(body, s);
}

/** The same for a body kept as a value (a skill's script reads JSON bodies as objects). */
export function hideBodyValue(body: string, contentType: string, s: Secrets): unknown {
  if (isJson(contentType) || /^\s*[[{]/.test(body)) {
    try {
      return hideJson(JSON.parse(body), s);
    } catch {
      /* text */
    }
  }
  return hideBody(body, contentType, s);
}

// ---------- learning what is secret ----------

function learnJson(value: unknown, s: Secrets, name = "", depth = 0): void {
  if (depth > 12) return;
  if (typeof value === "string") {
    const kind = secretName(name, "json");
    if (kind === "always" || (kind === "weak" && looksRandom(value, 16))) s.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) learnJson(v, s, name, depth + 1);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) learnJson(v, s, k, depth + 1);
  }
}

/** Remember the secrets a request or a response carries, so they are hidden wherever they show up later. */
export function learn(s: Secrets, part: { url?: string; headers?: Header[]; body?: string; contentType?: string }): void {
  for (const { name, value } of part.headers ?? []) {
    const n = name.toLowerCase();
    if (n === "cookie") {
      for (const p of value.split(";")) s.add(p.slice(p.indexOf("=") + 1));
    } else if (n === "set-cookie") {
      for (const line of value.split("\n")) {
        const first = line.split(";")[0];
        s.add(first.slice(first.indexOf("=") + 1));
      }
    } else if (n === "authorization" || n === "proxy-authorization") {
      s.add(value.replace(/^\w+\s+/, ""));
    } else if (secretName(name, "header") === "always") {
      s.add(value);
    }
  }
  if (part.url) {
    try {
      const u = new URL(part.url);
      for (const [k, v] of u.searchParams) if (secretName(k, "query") === "always") s.add(v);
      if (u.password) s.add(u.password);
    } catch {
      /* not an address */
    }
  }
  const body = part.body;
  if (!body || body.length > 1_000_000) return;
  const type = part.contentType ?? "";
  if (isForm(type)) {
    for (const [k, v] of new URLSearchParams(body)) if (secretName(k, "form") === "always") s.add(v);
    return;
  }
  if (isJson(type) || /^\s*[[{]/.test(body)) {
    try {
      learnJson(JSON.parse(body), s);
      return;
    } catch {
      /* not JSON */
    }
  }
  if (!isMultipart(type)) secretsInText(body, (value) => s.add(value));
}

/** Does a text an agent wrote carry the hidden mark (a body copied from the log instead of patched)? */
export const hasHidden = (text: string) => text.includes(HIDDEN);
