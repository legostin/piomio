import { parse as parseYaml } from "yaml";
import { randomBytes } from "node:crypto";
import type { BrainRef } from "./types.ts";

/** Split "---\nyaml\n---\nbody" into data + body. Missing frontmatter → empty data. */
export function parseFrontmatter(text: string): { data: Record<string, any>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = (parseYaml(m[1]) as Record<string, any>) ?? {};
  return { data, body: m[2] };
}

/** "claude-code@laptop", "api:anthropic", "api:openai@local" → BrainRef. */
export function parseBrainRef(ref: string): BrainRef {
  const [left, machine] = ref.split("@");
  const [brainId, variant] = left.split(":");
  return { brainId, variant: variant || undefined, machineId: machine || "local" };
}

export function formatBrainRef(r: BrainRef): string {
  return `${r.brainId}${r.variant ? ":" + r.variant : ""}@${r.machineId}`;
}

/** Glob with * (any chars) and ? (one char). */
export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

export function matchesAny(name: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(name));
}

/** Host pattern match: "*.github.com" matches "api.github.com" and "github.com"; "*" matches all. */
export function hostMatches(host: string, pattern: string): boolean {
  host = host.toLowerCase().replace(/\.$/, "");
  pattern = pattern.toLowerCase();
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return host === base || host.endsWith("." + base);
  }
  return host === pattern;
}

export function newId(prefix = ""): string {
  const t = Date.now().toString(36);
  const r = randomBytes(6).toString("base64url");
  return `${prefix}${t}${r}`.replace(/[^a-zA-Z0-9_]/g, "x");
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Fill "{field}" placeholders from an object; nested via dots. "{field|host}" shows only the host of a URL field
 * (the site an approval card is about), or the value itself when it is not a URL.
 */
export function renderTemplate(tpl: string, input: unknown): string {
  return tpl.replace(/\{([a-zA-Z0-9_.]+)(?:\|(host))?\}/g, (_, path: string, filter?: string) => {
    let v: any = input;
    for (const k of path.split(".")) v = v?.[k];
    if (v === undefined || v === null) return "";
    let s = typeof v === "string" ? v : JSON.stringify(v);
    if (filter === "host") s = hostOf(s) || s;
    return s.length > 200 ? s.slice(0, 197) + "…" : s;
  });
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Extract hostname from a URL-ish string, or "" if not parseable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** An IPv4 address on this computer, the home network, a link-local range or a CGNAT overlay such as the tailnet (100.64/10). */
function privateV4(h: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * A link a person can open from anywhere: http(s) (https only with `httpsOnly`) to a named host on the internet. Not this
 * computer, a bare name, the home network (.local, .lan, private addresses) or the tailnet's own addresses. Telegram
 * rejects text links and buttons it cannot open, and a digest's "From:" line links only on such a hub.
 */
export function isPublicHttpUrl(url: string, opts: { httpsOnly?: boolean } = {}): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && (opts.httpsOnly || u.protocol !== "http:")) return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1);
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (mapped) return !privateV4(mapped[1]);
    // The URL parser writes a mapped IPv4 address in hex: ::ffff:c0a8:102.
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return !privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return !(v6 === "::1" || v6 === "::" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6));
  }
  if (privateV4(host)) return false;
  if (host === "localhost" || /\.(localhost|local|lan|internal|home\.arpa)$/.test(host)) return false;
  return host.includes(".");
}
