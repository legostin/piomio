// A phone's handle: its APNs device token sealed with the relay's secret. The hub keeps only the handle, so it never
// holds a raw token, and the relay keeps nothing at all: whoever holds a handle may wake that one phone, nothing more.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type ApnsEnvironment = "production" | "sandbox";

export interface Target {
  /** The APNs device token, lowercase hex. */
  token: string;
  environment: ApnsEnvironment;
}

const VERSION = 1;

function keyOf(secret: string): Buffer {
  return createHash("sha256").update(`piomio-relay-handle\n${secret}`).digest();
}

/** An APNs device token as the phone sends it: hex, 32 to 200 bytes. Lowercase, or undefined when it is not one. */
export function deviceToken(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().toLowerCase();
  return /^[0-9a-f]{64,400}$/.test(t) && t.length % 2 === 0 ? t : undefined;
}

export function sealHandle(secret: string, target: Target): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(secret), iv);
  const body = Buffer.concat([c.update(JSON.stringify({ t: target.token, e: target.environment === "sandbox" ? "s" : "p" }), "utf8"), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, body, c.getAuthTag()]).toString("base64url");
}

/** The target a handle seals, or undefined for anything this relay did not make. */
export function openHandle(secret: string, handle: unknown): Target | undefined {
  if (typeof handle !== "string" || handle.length > 1024) return undefined;
  const raw = Buffer.from(handle, "base64url");
  if (raw.length < 1 + 12 + 16 + 1 || raw[0] !== VERSION) return undefined;
  try {
    const d = createDecipheriv("aes-256-gcm", keyOf(secret), raw.subarray(1, 13));
    d.setAuthTag(raw.subarray(raw.length - 16));
    const plain = Buffer.concat([d.update(raw.subarray(13, raw.length - 16)), d.final()]).toString("utf8");
    const { t, e } = JSON.parse(plain) as { t?: unknown; e?: unknown };
    const token = deviceToken(t);
    return token ? { token, environment: e === "s" ? "sandbox" : "production" } : undefined;
  } catch {
    return undefined;
  }
}
