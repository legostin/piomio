// Phones paired with the hub (the Piomio app): one-time pairing codes, bearer tokens (the hub keeps only their hash)
// and each phone's P-256 key from its Secure Enclave. Approvals from a phone carry a signature by that key over a
// one-time nonce, so a stolen token cannot approve anything without the phone's Face ID.

import { createPublicKey, randomBytes, verify, type KeyObject } from "node:crypto";
import type { Device } from "@piomio/shared";
import { newId, nowIso } from "@piomio/shared";
import type { Db } from "./db.ts";
import type { EventBus } from "./bus.ts";
import type { AuditLog } from "./audit.ts";
import { hashToken } from "./store.ts";
import { LocalizedError } from "./i18n.ts";
import { InviteRegistry } from "./invites.ts";

const NONCE_TTL = 2 * 60_000;
const TICKET_TTL = 60_000;
const WEB_SESSION_TTL = 30 * 24 * 3600_000;

/** The chat page's session cookie on the device port. */
export const DEVICE_COOKIE = "piomio_device";
/** last_seen_at is written at most this often per device. */
const SEEN_EVERY = 60_000;

/** What the phone signs to approve: one line each for the purpose, the approval, the decision and the nonce. */
export function approvalPayload(approvalId: string, decision: "approve" | "deny", nonce: string): string {
  return `piomio-approval\n${approvalId}\n${decision}\n${nonce}`;
}

/** A P-256 public key as the phone sends it (the X9.63 point 0x04 ‖ X ‖ Y, base64); undefined if it is not one. */
export function deviceKey(publicKey: string): KeyObject | undefined {
  const raw = Buffer.from(publicKey, "base64");
  if (raw.length !== 65 || raw[0] !== 4) return undefined;
  try {
    return createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
  } catch {
    return undefined;
  }
}

const fromRow = (r: any): Device => ({
  id: r.id,
  name: r.name,
  platform: r.platform,
  ...(r.model ? { model: r.model } : {}),
  createdAt: r.created_at,
  ...(r.last_seen_at ? { lastSeenAt: r.last_seen_at } : {}),
  ...(r.push_handle ? { push: true } : {}),
});

const clip = (v: unknown, max: number): string => String(v ?? "").trim().slice(0, max);

export class DeviceRegistry {
  db: Db;
  bus: EventBus;
  audit: AuditLog;
  invites: InviteRegistry;
  private nonces = new Map<string, { nonce: string; expires: number }>();
  private seen = new Map<string, number>();
  private tickets = new Map<string, { deviceId: string; expires: number }>();
  /** The phone's chat page (a WebView): keyed by the cookie token's hash. Kept in memory: after a hub restart the page
   * asks the app for a new ticket. */
  private webSessions = new Map<string, { deviceId: string; csrf: string; expires: number }>();

  constructor(d: { db: Db; bus: EventBus; audit: AuditLog; invites?: InviteRegistry }) {
    this.db = d.db;
    this.bus = d.bus;
    this.audit = d.audit;
    this.invites = d.invites ?? new InviteRegistry(d);
  }

  /** An invite (invites.ts): it pairs a phone, or a computer just as well. */
  createPairingCode(): { code: string; expiresAt: string } {
    return this.invites.create();
  }

  /** Called by the phone with the code from the QR or link. The token is returned once and never stored. */
  pair(p: { code: string; name?: string; platform?: string; model?: string; publicKey: string }): { device: Device; token: string } {
    if (!deviceKey(String(p.publicKey ?? ""))) throw new LocalizedError("device.badPublicKey", undefined, 400);
    const id = newId("dev_");
    if (!this.invites.consume(p.code, `device:${id}`)) throw new LocalizedError("device.badPairingCode", undefined, 400);
    const token = randomBytes(32).toString("base64url");
    const now = nowIso();
    this.db
      .prepare("insert into devices(id, name, platform, model, token_hash, public_key, created_at, last_seen_at) values (?,?,?,?,?,?,?,?)")
      .run(id, clip(p.name, 60) || "Phone", clip(p.platform, 20) || "ios", clip(p.model, 60) || null, hashToken(token), String(p.publicKey), now, now);
    const device = this.get(id)!;
    this.audit.append("user", "device.pair", id, { name: device.name, model: device.model });
    this.bus.emit("device.updated", { id });
    this.invites.joined(p.code, "device", device.name);
    return { device, token };
  }

  /** The device behind an `Authorization: Bearer …` header, if it is paired and not revoked. */
  authenticate(header: string | undefined): Device | undefined {
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(String(header ?? "").trim());
    if (!m) return undefined;
    const r = this.db.prepare("select * from devices where token_hash = ? and revoked = 0").get(hashToken(m[1])) as any;
    return r ? this.touch(r) : undefined;
  }

  private touch(r: any): Device {
    const now = Date.now();
    if (now - (this.seen.get(r.id) ?? 0) > SEEN_EVERY) {
      this.seen.set(r.id, now);
      r.last_seen_at = nowIso();
      this.db.prepare("update devices set last_seen_at = ? where id = ?").run(r.last_seen_at, r.id);
    }
    return fromRow(r);
  }

  /** A one-time ticket the app trades for its chat page's cookie session, so the token never reaches the page. */
  webTicket(deviceId: string, now = Date.now()): { ticket: string; expiresAt: string } {
    for (const [k, v] of this.tickets) if (v.expires < now) this.tickets.delete(k);
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(ticket, { deviceId, expires: now + TICKET_TTL });
    return { ticket, expiresAt: new Date(now + TICKET_TTL).toISOString() };
  }

  /** Spends a ticket: the page's session token (for the cookie) and its CSRF token. */
  openWebSession(ticket: string, now = Date.now()): { token: string; csrf: string; device: Device } | undefined {
    const t = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    const device = t && t.expires >= now ? this.get(t.deviceId) : undefined;
    if (!device) return undefined;
    for (const [k, v] of this.webSessions) if (v.expires < now) this.webSessions.delete(k);
    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(18).toString("base64url");
    this.webSessions.set(hashToken(token), { deviceId: device.id, csrf, expires: now + WEB_SESSION_TTL });
    return { token, csrf, device };
  }

  /** The device behind the chat page's cookie, while the session and the device are both valid. */
  webSession(token: string | undefined, now = Date.now()): { device: Device; csrf: string } | undefined {
    if (!token) return undefined;
    const s = this.webSessions.get(hashToken(token));
    if (!s || s.expires < now) return undefined;
    const r = this.db.prepare("select * from devices where id = ? and revoked = 0").get(s.deviceId);
    return r ? { device: this.touch(r), csrf: s.csrf } : undefined;
  }

  list(): Device[] {
    return (this.db.prepare("select * from devices where revoked = 0 order by created_at").all() as any[]).map(fromRow);
  }

  get(id: string): Device | undefined {
    const r = this.db.prepare("select * from devices where id = ? and revoked = 0").get(id);
    return r ? fromRow(r) : undefined;
  }

  rename(id: string, name: string): Device {
    if (!this.get(id)) throw new LocalizedError("device.notFound", undefined, 404);
    this.db.prepare("update devices set name = ? where id = ?").run(clip(name, 60) || "Phone", id);
    this.audit.append("user", "device.rename", id, { name });
    this.bus.emit("device.updated", { id });
    return this.get(id)!;
  }

  /** The token stops working at once; the row stays for the audit trail. */
  revoke(id: string, actor: string): void {
    if (!this.get(id)) throw new LocalizedError("device.notFound", undefined, 404);
    this.db.prepare("update devices set revoked = 1, token_hash = '', push_handle = null where id = ?").run(id);
    for (const k of this.nonces.keys()) if (k.startsWith(`${id}:`)) this.nonces.delete(k);
    for (const [k, v] of this.tickets) if (v.deviceId === id) this.tickets.delete(k);
    for (const [k, v] of this.webSessions) if (v.deviceId === id) this.webSessions.delete(k);
    this.audit.append(actor, "device.revoke", id);
    this.bus.emit("device.updated", { id });
  }

  /** A one-time nonce the phone signs to approve `approvalId`. */
  challenge(deviceId: string, approvalId: string, now = Date.now()): { nonce: string; expiresAt: string } {
    for (const [k, v] of this.nonces) if (v.expires < now) this.nonces.delete(k);
    const nonce = randomBytes(18).toString("base64url");
    this.nonces.set(`${deviceId}:${approvalId}`, { nonce, expires: now + NONCE_TTL });
    return { nonce, expiresAt: new Date(now + NONCE_TTL).toISOString() };
  }

  /** True if `signature` (DER, base64) is the device's key over the approve payload with the nonce it was given. */
  verifyApproval(deviceId: string, approvalId: string, nonce: string, signature: string, now = Date.now()): boolean {
    const key = `${deviceId}:${approvalId}`;
    const expected = this.nonces.get(key);
    this.nonces.delete(key);
    if (!expected || expected.nonce !== nonce || expected.expires < now) return false;
    const row = this.db.prepare("select public_key from devices where id = ? and revoked = 0").get(deviceId) as { public_key: string } | undefined;
    const pub = row ? deviceKey(row.public_key) : undefined;
    if (!pub) return false;
    try {
      return verify("sha256", Buffer.from(approvalPayload(approvalId, "approve", nonce)), { key: pub, dsaEncoding: "der" }, Buffer.from(signature, "base64"));
    } catch {
      return false;
    }
  }
}
