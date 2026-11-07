// Who sent a webhook: the shared secret, or the signature GitHub, Stripe and plain HMAC senders put on the exact bytes
// they posted. All comparisons are timing-safe.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Trigger } from "./types.ts";

export type WebhookVerdict = { ok: true } | { ok: false; why: string };

export interface VerifiableRequest {
  headers: Record<string, string>;
  /** The body exactly as it came in (UTF-8 text). */
  rawBody: string;
  query: Record<string, string>;
}

/** Stripe's tolerance for the timestamp in its signature header. */
const STRIPE_TOLERANCE_SEC = 300;

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return Array.isArray(v) ? v[0] : v;
  return undefined;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const sign = (secret: string, text: string): string => createHmac("sha256", secret).update(text).digest("hex");

/** A hex digest is compared as text, lower-cased: a wrong length or a non-hex string simply does not match. */
const sameDigest = (given: string, secret: string, text: string): boolean => /^[0-9a-fA-F]{64}$/.test(given) && safeEqual(given.toLowerCase(), sign(secret, text));

const bad = (why: string): WebhookVerdict => ({ ok: false, why });

/**
 * `secret` is the trigger's stored shared secret for `{ kind: "secret" }` (or no `verify`), the signing secret from the
 * vault for the HMAC kinds. `now` is in milliseconds.
 */
export function verifyWebhook(v: Trigger["verify"], req: VerifiableRequest, secret: string, now: number = Date.now()): WebhookVerdict {
  if (!v || v.kind === "secret") {
    const given = header(req.headers, "x-piomio-secret") ?? req.query?.secret ?? "";
    return secret && safeEqual(String(given), secret) ? { ok: true } : bad("invalid secret");
  }
  if (!secret) return bad("no signing secret");
  if (v.kind === "github") {
    const given = header(req.headers, "x-hub-signature-256") ?? "";
    return given.startsWith("sha256=") && sameDigest(given.slice(7), secret, req.rawBody) ? { ok: true } : bad("invalid signature");
  }
  if (v.kind === "stripe") {
    const given = header(req.headers, "stripe-signature") ?? "";
    let t = "";
    const sigs: string[] = [];
    for (const part of given.split(",")) {
      const i = part.indexOf("=");
      if (i < 0) continue;
      const k = part.slice(0, i).trim();
      const val = part.slice(i + 1).trim();
      if (k === "t") t = val;
      else if (k === "v1") sigs.push(val);
    }
    if (!/^\d{1,12}$/.test(t) || sigs.length === 0) return bad("invalid signature");
    if (Math.abs(now / 1000 - Number(t)) > STRIPE_TOLERANCE_SEC) return bad("signature too old");
    const text = `${t}.${req.rawBody}`;
    // Every candidate is checked (no early exit on the first) so timing does not tell which one was close.
    let ok = false;
    for (const s of sigs) if (sameDigest(s, secret, text)) ok = true;
    return ok ? { ok: true } : bad("invalid signature");
  }
  const given = (header(req.headers, v.header ?? "x-signature") ?? "").trim();
  const hex = given.startsWith("sha256=") ? given.slice(7) : given;
  return sameDigest(hex, secret, req.rawBody) ? { ok: true } : bad("invalid signature");
}
