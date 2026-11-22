// A request as a curl command, and a curl command (as browsers and API docs give it) as a request.

import { ClientError } from "./errors.ts";
import { METHODS, type BodyType, type Method, type Pair, type RequestSpec } from "./types.ts";

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The address with the parameters that are on, as written: variables and vault references stay as they are. */
function urlWithQuery(spec: RequestSpec): string {
  const on = (spec.query ?? []).filter((p) => !p.off && p.name);
  if (!on.length) return spec.url;
  const q = on.map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.value)}`.replace(/%7B%7B/gi, "{{").replace(/%7D%7D/gi, "}}")).join("&");
  const [base, hash = ""] = spec.url.split(/(?=#)/, 2);
  return `${base}${base.includes("?") ? "&" : "?"}${q}${hash}`;
}

export function toCurl(spec: RequestSpec): string {
  const parts = ["curl"];
  if (spec.method === "HEAD") parts.push("-I");
  else if (spec.method !== "GET" && !(spec.method === "POST" && spec.body)) parts.push(`-X ${spec.method}`);
  parts.push(quote(urlWithQuery(spec)));
  const headers = (spec.headers ?? []).filter((h) => !h.off && h.name.trim());
  for (const h of headers) parts.push(`-H ${quote(`${h.name.trim()}: ${h.value}`)}`);
  const carries = spec.method !== "GET" && spec.method !== "HEAD" && !!spec.body;
  if (carries) {
    if (!headers.some((h) => h.name.trim().toLowerCase() === "content-type")) {
      const type = { json: "application/json", text: "text/plain; charset=utf-8", form: "application/x-www-form-urlencoded" }[spec.bodyType ?? "json"];
      parts.push(`-H ${quote(`content-type: ${type}`)}`);
    }
    parts.push(`--data-raw ${quote(spec.body!)}`);
  }
  return parts.join(" \\\n  ");
}

const ANSI: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", v: "\v", "0": "\0" };

/** The words of a shell command line: quotes, backslashes, $'…' strings, line continuations. */
export function shellWords(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  const s = text.replace(/\\\r?\n/g, " ").replace(/\^\r?\n/g, " ");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" ) {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new ClientError("badCurl");
      cur += s.slice(i + 1, end);
      has = true;
      i = end;
    } else if (c === "$" && s[i + 1] === "'") {
      i += 2;
      for (; i < s.length && s[i] !== "'"; i++) {
        if (s[i] !== "\\") cur += s[i];
        else {
          const e = s[++i];
          if (e === "x") {
            cur += String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16));
            i += 2;
          } else if (e === "u") {
            cur += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16));
            i += 4;
          } else cur += ANSI[e] ?? e;
        }
      }
      if (i >= s.length) throw new ClientError("badCurl");
      has = true;
    } else if (c === '"') {
      i++;
      for (; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === "\\" && '"\\$`'.includes(s[i + 1] ?? "")) cur += s[++i];
        else cur += s[i];
      }
      if (i >= s.length) throw new ClientError("badCurl");
      has = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** Options that take a value and mean nothing to a saved request. */
const SKIP_WITH_VALUE = new Set(["-o", "--output", "-m", "--max-time", "--connect-timeout", "-x", "--proxy", "--retry", "-w", "--write-out", "--cacert", "--cert", "--key", "-E", "--resolve", "-c", "--cookie-jar", "--max-redirs", "--retry-delay", "-T", "--upload-file"]);

export function looksLikeCurl(text: string): boolean {
  return /^\s*curl(?:\.exe)?\s/i.test(text);
}

export function parseCurl(text: string): RequestSpec {
  const words = shellWords(text.trim());
  if (!words.length || !/^curl(?:\.exe)?$/i.test(words[0])) throw new ClientError("badCurl");
  let method: string | undefined;
  let url = "";
  const headers: Pair[] = [];
  const data: string[] = [];
  let bodyType: BodyType | undefined;
  let asQuery = false;
  let head = false;
  const header = (line: string) => {
    const i = line.indexOf(":");
    if (i > 0) headers.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
  };
  for (let i = 1; i < words.length; i++) {
    let w = words[i];
    let inline: string | undefined;
    if (w.startsWith("--") && w.includes("=")) {
      inline = w.slice(w.indexOf("=") + 1);
      w = w.slice(0, w.indexOf("="));
    } else if (/^-[A-Za-z]{2,}$/.test(w)) {
      // "-sSL" is three switches; "-XPOST" a switch with its value.
      if ("XHdubAeFo".includes(w[1])) {
        inline = w.slice(2);
        w = w.slice(0, 2);
      } else {
        if (w.includes("I")) head = true;
        if (w.includes("G")) asQuery = true;
        continue;
      }
    }
    const value = (): string => {
      if (inline !== undefined) return inline;
      if (i + 1 >= words.length) throw new ClientError("badCurl");
      return words[++i];
    };
    switch (w) {
      case "-X":
      case "--request":
        method = value().toUpperCase();
        break;
      case "-H":
      case "--header":
        header(value());
        break;
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-binary":
      case "--data-ascii":
        data.push(value());
        break;
      case "--data-urlencode": {
        const v = value();
        const eq = v.indexOf("=");
        data.push(eq > 0 ? `${v.slice(0, eq)}=${encodeURIComponent(v.slice(eq + 1))}` : encodeURIComponent(eq === 0 ? v.slice(1) : v));
        bodyType ??= "form";
        break;
      }
      case "--json":
        data.push(value());
        bodyType = "json";
        break;
      case "-u":
      case "--user":
        headers.push({ name: "Authorization", value: `Basic ${Buffer.from(value()).toString("base64")}` });
        break;
      case "-A":
      case "--user-agent":
        headers.push({ name: "User-Agent", value: value() });
        break;
      case "-e":
      case "--referer":
        headers.push({ name: "Referer", value: value() });
        break;
      case "-b":
      case "--cookie":
        headers.push({ name: "Cookie", value: value() });
        break;
      case "-F":
      case "--form":
        throw new ClientError("curlMultipart");
      case "-I":
      case "--head":
        head = true;
        break;
      case "-G":
      case "--get":
        asQuery = true;
        break;
      case "--url":
        url = value();
        break;
      default:
        if (SKIP_WITH_VALUE.has(w)) value();
        else if (!w.startsWith("-") && !url) url = w;
    }
  }
  if (!url) throw new ClientError("badCurl");
  let body = data.join("&");
  if (asQuery && body) {
    url += `${url.includes("?") ? "&" : "?"}${body}`;
    body = "";
  }
  const m = (method ?? (head ? "HEAD" : body ? "POST" : "GET")) as Method;
  if (!METHODS.includes(m)) throw new ClientError("badMethod", { method: m.slice(0, 20), methods: METHODS.join(", ") });
  if (body && !bodyType) {
    const type = headers.find((h) => h.name.toLowerCase() === "content-type")?.value.toLowerCase() ?? "";
    bodyType = type.includes("json") || /^\s*[[{]/.test(body) ? "json" : !type || type.includes("x-www-form-urlencoded") ? "form" : "text";
  }
  // The type the body's kind already says goes without saying.
  const shown = headers.filter((h) => !(h.name.toLowerCase() === "content-type" && body && ((bodyType === "json" && /^application\/json\s*$/i.test(h.value)) || (bodyType === "form" && /^application\/x-www-form-urlencoded\s*$/i.test(h.value)))));
  return { method: m, url, ...(shown.length ? { headers: shown } : {}), ...(body ? { body, bodyType } : {}) };
}
