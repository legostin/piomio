// The relay's HTTP side. A hub registers a phone's APNs token once and keeps the handle it gets back; later it asks
// the relay to wake that phone. A push says only that there is something new (and its opaque id): the phone fetches
// the words from its own hub. Nothing is stored and nothing about a push is logged.

import type { IncomingMessage, ServerResponse } from "node:http";
import { deviceToken, openHandle, sealHandle, type ApnsEnvironment } from "./handle.ts";
import { isGone, type ApnsSend } from "./apns.ts";

export type PushKind = "message" | "approval";

export interface PushInput {
  /** The hub's opaque id for what is new; the phone asks its hub for it. */
  id?: string;
  kind?: PushKind;
  /** Unread count for the app's badge. */
  badge?: number;
  /** Quiet hours: no sound. */
  silent?: boolean;
}

/**
 * The text the phone shows when it cannot reach its hub: a key from the app's string catalog, looked up on the phone
 * in its own language (shown as is when missing).
 */
export const ALERT_KEYS: Record<PushKind, string> = { message: "New message", approval: "Waiting for your answer" };

const ID = /^[\w-]{1,64}$/;
const BODY_MAX = 4096;
const PUSH_TTL_S = 24 * 3600;

export function apnsPayload(p: PushInput): unknown {
  const aps: Record<string, unknown> = { alert: { "loc-key": ALERT_KEYS[p.kind ?? "message"] }, "mutable-content": 1 };
  if (!p.silent) aps.sound = "default";
  if (p.badge !== undefined) aps.badge = p.badge;
  return { aps, ...(p.id ? { n: p.id } : {}) };
}

export function apnsHeaders(p: PushInput, nowMs: number): Record<string, string> {
  return {
    "apns-push-type": "alert",
    "apns-priority": p.silent ? "5" : "10",
    "apns-expiration": String(Math.floor(nowMs / 1000) + PUSH_TTL_S),
    ...(p.id ? { "apns-collapse-id": p.id } : {}),
  };
}

/** Fixed windows per key: at most `max` hits in `windowMs`. */
export class RateLimit {
  private hits = new Map<string, { n: number; until: number }>();
  private max: number;
  private windowMs: number;
  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  take(key: string, now: number): boolean {
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.until <= now) this.hits.delete(k);
    const h = this.hits.get(key);
    if (!h || h.until <= now) {
      this.hits.set(key, { n: 1, until: now + this.windowMs });
      return true;
    }
    h.n++;
    return h.n <= this.max;
  }
}

export interface RelayOptions {
  secret: string;
  send: ApnsSend;
  /** Read the client's address from X-Forwarded-For (the relay behind a reverse proxy on the same machine). */
  trustProxy?: boolean;
  now?: () => number;
}

class Reply extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(String(status));
    this.status = status;
    this.body = body;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > BODY_MAX) throw new Reply(413, { error: "too large" });
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {}
  throw new Reply(400, { error: "expected a JSON object" });
}

export function relayHandler(o: RelayOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const now = o.now ?? Date.now;
  // Registering happens once per phone install; pushing is what a hub does all day.
  const registers = new RateLimit(30, 3600_000);
  const perAddress = new RateLimit(1200, 3600_000);
  const perHandle = new RateLimit(300, 3600_000);

  const address = (req: IncomingMessage): string => {
    const fwd = o.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
    return fwd || req.socket.remoteAddress || "?";
  };

  async function route(req: IncomingMessage): Promise<[number, unknown]> {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/health") return [200, { ok: true }];
    if (req.method !== "POST") throw new Reply(404, { error: "not found" });

    if (path === "/v1/register") {
      if (!registers.take(address(req), now())) throw new Reply(429, { error: "too many requests" });
      const body = await readJson(req);
      const token = deviceToken(body.token);
      if (!token) throw new Reply(400, { error: "token: an APNs device token in hex" });
      const environment: ApnsEnvironment = body.environment === "sandbox" ? "sandbox" : "production";
      return [200, { handle: sealHandle(o.secret, { token, environment }) }];
    }

    if (path === "/v1/push") {
      if (!perAddress.take(address(req), now())) throw new Reply(429, { error: "too many requests" });
      const body = await readJson(req);
      const target = openHandle(o.secret, body.handle);
      if (!target) throw new Reply(400, { error: "handle: not one this relay made" });
      if (!perHandle.take(target.token, now())) throw new Reply(429, { error: "too many requests" });
      const p: PushInput = {};
      if (body.id !== undefined) {
        if (typeof body.id !== "string" || !ID.test(body.id)) throw new Reply(400, { error: "id: up to 64 of [A-Za-z0-9_-]" });
        p.id = body.id;
      }
      if (body.kind === "approval") p.kind = "approval";
      if (Number.isInteger(body.badge) && (body.badge as number) >= 0) p.badge = Math.min(body.badge as number, 9999);
      if (body.silent === true) p.silent = true;
      const r = await o.send({ environment: target.environment, token: target.token, payload: apnsPayload(p), headers: apnsHeaders(p, now()) });
      if (r.status === 200) return [200, { ok: true }];
      if (isGone(r)) return [410, { gone: true }];
      if (r.status === 429) throw new Reply(429, { error: "Apple: too many pushes to this phone" });
      // Apple's reason names no person or content.
      console.log(`[relay] apns ${r.status} ${r.reason ?? ""}`);
      return [502, { error: "push service", reason: r.reason ?? null }];
    }
    throw new Reply(404, { error: "not found" });
  }

  return (req, res) => {
    route(req)
      .catch((e): [number, unknown] => (e instanceof Reply ? [e.status, e.body] : (console.log(`[relay] ${(e as Error).message}`), [500, { error: "relay" }])))
      .then(([status, body]) => {
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(body));
      });
  };
}
