// Pure helpers of the browser plugin: settings, URLs, proxy, file names, TOTP. No Playwright here (unit-testable).

import { createHmac } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import { existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { addressKind, isSearchEngine, searchUrl, type SearchEngine } from "./address.ts";

/**
 * An error whose message is meant for the model as is (English). Errors that can also reach the browser pane carry
 * a `code` (and `params`) so the pane can show them in the user's language (ui.error.<code> in the plugin's locales).
 */
export class ToolError extends Error {
  code?: string;
  params?: Record<string, string>;
  constructor(message: string, code?: string, params?: Record<string, string>) {
    super(message);
    this.code = code;
    this.params = params;
  }
}

export type HeadlessSetting = "auto" | "always" | "never";

export interface BrowserSettings {
  headless: HeadlessSetting;
  idleMinutes: number;
  /** Let the agent open localhost / LAN addresses. */
  allowLocalNetwork: boolean;
  /** How long agent tools wait for the user to hand control back. */
  takeoverWaitSec: number;
  maxDownloadMb: number;
  /** Where the address bar sends words that are not an address. */
  searchEngine: SearchEngine;
  /** Keep what the person does in the browser by themselves (the journal), for agents to learn routines from. */
  rememberActions: boolean;
}

const clampNum = (v: unknown, def: number, min: number, max: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

export function readSettings(raw: Record<string, any> | undefined): BrowserSettings {
  const s = raw ?? {};
  let headless: HeadlessSetting = "auto";
  if (s.headless === true || s.headless === "always") headless = "always";
  else if (s.headless === false || s.headless === "never") headless = "never";
  return {
    headless,
    idleMinutes: clampNum(s.idleMinutes, 30, 1, 24 * 60),
    allowLocalNetwork: s.allowLocalNetwork === true,
    takeoverWaitSec: clampNum(s.takeoverWaitSec, 10, 0, 600),
    maxDownloadMb: clampNum(s.maxDownloadMb, 200, 1, 10_000),
    searchEngine: isSearchEngine(s.searchEngine) ? s.searchEngine : "duckduckgo",
    rememberActions: s.rememberActions !== false,
  };
}

/** Headed when a display exists: Linux with DISPLAY/WAYLAND_DISPLAY; on Windows/macOS only when asked ("never"). */
export function decideHeadless(setting: HeadlessSetting, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (setting === "always") return true;
  if (setting === "never") return false;
  if (platform === "linux") return !(env.DISPLAY || env.WAYLAND_DISPLAY);
  return true;
}

/**
 * Google Chrome installed on this computer. Sites take it for the person's own browser; Playwright's Chromium has no
 * Chrome brand, and its headless shell gives itself away on every check.
 */
export function findChrome(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists: (p: string) => boolean = existsSync): string | null {
  const candidates: string[] = [];
  if (platform === "darwin") {
    const app = "Google Chrome.app/Contents/MacOS/Google Chrome";
    candidates.push(join("/Applications", app));
    if (env.HOME) candidates.push(join(env.HOME, "Applications", app));
  } else if (platform === "win32") {
    const exe = join("Google", "Chrome", "Application", "chrome.exe");
    for (const root of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]) if (root) candidates.push(join(root, exe));
  } else {
    candidates.push("/opt/google/chrome/chrome", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome");
  }
  return candidates.find((p) => exists(p)) ?? null;
}

/** The browser window; the page gets what its toolbar leaves (about 1280×813). */
export const WINDOW = { width: 1280, height: 900 };

/** A screen behind a headless window, with the work area a menu bar, dock or taskbar leaves (headless has none of its own). */
function screenInfo(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "{1920x1080 workAreaTop=25 workAreaBottom=70}";
  if (platform === "win32") return "{1920x1080 workAreaBottom=48}";
  return "{1920x1080 workAreaTop=32}";
}

/** Headless Chrome calls itself "HeadlessChrome" (to pages, in headers and in workers); with a window it says "Chrome". */
export function windowedUserAgent(ua: string): string {
  return ua.replace(/HeadlessChrome\//g, "Chrome/");
}

/**
 * Flags of an ordinary browser. Playwright's `--enable-automation` (the "controlled by automated software" bar and
 * navigator.webdriver) is dropped through `ignoreDefaultArgs`; the rest keeps automation from showing to pages.
 * Headless needs its user agent (`userAgent`, from {@link windowedUserAgent}) and a screen.
 */
export function launchArgs(o: { headless: boolean; platform: NodeJS.Platform; userAgent?: string; proxy: boolean }): string[] {
  return [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    "--disable-blink-features=AutomationControlled",
    `--window-size=${WINDOW.width},${WINDOW.height}`,
    ...(o.headless ? [`--screen-info=${screenInfo(o.platform)}`, ...(o.userAgent ? [`--user-agent=${o.userAgent}`] : [])] : []),
    // WebRTC must not open UDP connections around the egress proxy.
    ...(o.proxy ? ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] : []),
  ];
}

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
  bypass?: string;
}

/** Chromium proxy from the hub's egress proxy env (the per-plugin token is in the URL userinfo). */
/**
 * Proxy for Chromium. The hub's NO_PROXY (loopback) is honoured only when `keepBypass` is set: otherwise a page could
 * reach the hub and other loopback services directly. Playwright proxies loopback too (`<-loopback>`), so it hits the
 * egress proxy, which refuses private addresses.
 */
export function proxyFromEnv(env: NodeJS.ProcessEnv, keepBypass = false): ProxyConfig | undefined {
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  const out: ProxyConfig = { server: `${u.protocol}//${u.host}` };
  if (u.username) out.username = decodeURIComponent(u.username);
  if (u.password) out.password = decodeURIComponent(u.password);
  const noProxy = env.NO_PROXY || env.no_proxy;
  if (noProxy && keepBypass) out.bypass = noProxy;
  return out;
}

/** localhost, loopback, private, link-local, CGNAT and single-label / .local / .internal names. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return true;
  if (isIPv4(h)) {
    const [a, b] = h.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIPv6(h)) {
    if (h === "::1" || h === "::") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return isPrivateHost(mapped[1]);
    return /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  }
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;
  return !h.includes(".");
}

/** Accepts "example.com", "localhost:3000", full http(s) URLs and about:blank. Throws a ToolError with a code for the pane. */
export function normalizeUrl(input: string): URL {
  const s = String(input ?? "").trim();
  if (!s) throw new ToolError("Empty URL.", "urlEmpty");
  if (s === "about:blank") return new URL(s);
  let candidate = s;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[\w.-]+:\d+(\/|$)/.test(s)) {
      const scheme = s.split(":")[0];
      throw new ToolError(`Unsupported URL scheme: ${scheme}.`, "urlScheme", { scheme });
    }
    candidate = (/^(localhost|[\d.]+|\[[\da-f:]+\])(:\d+)?(\/|$)/i.test(s) ? "http://" : "https://") + s;
  }
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    throw new ToolError(`Invalid URL: ${s}`, "urlInvalid", { url: s });
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ToolError(`Only http(s) URLs can be opened, not ${u.protocol}`, "urlProtocol", { protocol: u.protocol });
  }
  return u;
}

/** The address bar's text: an address (checked like any other) or words searched for in `engine`. */
export function resolveAddress(text: string, engine: SearchEngine): URL {
  return addressKind(text) === "search" ? new URL(searchUrl(engine, text)) : normalizeUrl(text);
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

export function sanitizeFilename(name: string | undefined | null, fallback = "download"): string {
  // Keep only the last path segment ("../../etc/passwd" → "passwd").
  let n = (String(name ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  if (!n || n === "_") n = fallback;
  const ext = extname(n).slice(0, 16);
  let stem = n.slice(0, n.length - extname(n).length) || fallback;
  if (RESERVED.test(stem)) stem = `_${stem}`;
  if (stem.length + ext.length > 120) stem = stem.slice(0, 120 - ext.length);
  return stem + ext;
}

/** "report.pdf" → "report (1).pdf" if taken. */
export function uniquePath(dir: string, name: string): string {
  let p = join(dir, name);
  if (!existsSync(p)) return p;
  const ext = extname(name);
  const stem = basename(name, ext);
  for (let i = 1; i < 10_000; i++) {
    p = join(dir, `${stem} (${i})${ext}`);
    if (!existsSync(p)) return p;
  }
  return join(dir, `${stem}-${Date.now()}${ext}`);
}

/** File name from a Content-Disposition header (RFC 6266 / 5987). */
export function filenameFromDisposition(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  if (plain) return (plain[2] ?? plain[1]).trim();
  return undefined;
}

export function filenameFromUrl(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function cut(s: string, max: number): string {
  const t = String(s ?? "");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function withTimeout<T>(p: Promise<T>, ms: number, message = "timeout"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * A page that navigates while it is read (a script's redirect, a navigation still landing) takes its document with it:
 * once the new one has loaded, read that instead. Only once: a page that keeps navigating fails as before.
 */
export async function againAfterNavigation<T>(read: () => Promise<T>, settle: () => Promise<unknown>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (!/Execution context was destroyed/i.test(String((e as Error)?.message ?? e))) throw e;
    await settle().catch(() => {});
    return read();
  }
}

// ---------- TOTP (RFC 6238) ----------

function base32Decode(s: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error("TOTP: the secret is not base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Code for a base32 secret or an otpauth:// URI. */
export function totpCode(secretOrUri: string, now = Date.now()): string {
  let secret = secretOrUri.trim();
  let digits = 6;
  let period = 30;
  let algorithm = "sha1";
  if (/^otpauth:\/\//i.test(secret)) {
    const u = new URL(secret);
    secret = u.searchParams.get("secret") ?? "";
    digits = Number(u.searchParams.get("digits") ?? 6) || 6;
    period = Number(u.searchParams.get("period") ?? 30) || 30;
    algorithm = (u.searchParams.get("algorithm") ?? "SHA1").toLowerCase();
  }
  const key = base32Decode(secret);
  const counter = Math.floor(now / 1000 / period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}
