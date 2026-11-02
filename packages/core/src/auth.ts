// Single-user authentication: password (Argon2id), passkeys (WebAuthn), cookie sessions with CSRF tokens.
// Two session kinds: "main" (web UI, 30 days) and "console" (security console, 30 minutes idle).

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { nowIso } from "@piomio/shared";
import type { Db } from "./db.ts";
import { hashToken } from "./store.ts";
import { hashPassword, verifyPassword } from "./vault/crypto.ts";
import type { AuditLog } from "./audit.ts";
import { LocalizedError } from "./i18n.ts";

export type SessionKind = "main" | "console";

export interface AuthSession {
  id: string;
  kind: SessionKind;
  csrf: string;
  expiresAt: string;
}

const TTL: Record<SessionKind, number> = { main: 30 * 24 * 3600_000, console: 30 * 60_000 };
const MAX_FAILURES = 10;
const FAILURE_WINDOW = 15 * 60_000;
/** Sign-in through the link (remote.ts): failures from every address share this budget, then it pauses. */
const REMOTE_MAX_FAILURES = 30;
const REMOTE_WINDOW = 3600_000;

export class AuthError extends LocalizedError {
  declare status: number;
  constructor(status: number, key: string) {
    super(key, undefined, status);
  }
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class AuthService {
  db: Db;
  audit: AuditLog;
  /** Printed to the log on first start; required to set the initial password. */
  setupToken: string | undefined;
  private failures = new Map<string, number[]>();
  private remoteFailures: number[] = [];
  private remotePausedUntil = 0;
  /** Called when sign-in through the link pauses (the hub tells the user). */
  onRemotePause?: () => void;
  private challenges = new Map<string, { challenge: string; expires: number }>();
  rpId: string;
  origins: string[];

  constructor(db: Db, audit: AuditLog, opts: { rpId: string; origins: string[]; setupToken?: string }) {
    this.db = db;
    this.audit = audit;
    this.rpId = opts.rpId;
    this.origins = opts.origins;
    if (!this.hasPassword()) this.setupToken = opts.setupToken || randomBytes(9).toString("base64url");
  }

  private get(key: string): string | undefined {
    return (this.db.prepare("select value from auth where key = ?").get(key) as { value: string } | undefined)?.value;
  }

  private set(key: string, value: string): void {
    this.db.prepare("insert into auth(key, value) values (?,?) on conflict(key) do update set value = excluded.value").run(key, value);
  }

  hasPassword(): boolean {
    return !!this.get("password");
  }

  // ---------- rate limiting ----------

  private checkRate(ip: string, remote = false): void {
    const now = Date.now();
    if (remote && now < this.remotePausedUntil) throw new AuthError(429, "auth.remotePaused");
    const list = (this.failures.get(ip) ?? []).filter((t) => now - t < FAILURE_WINDOW);
    this.failures.set(ip, list);
    if (list.length >= MAX_FAILURES) throw new AuthError(429, "auth.tooManyFailures");
  }

  private fail(ip: string, what: string, remote = false): never {
    const now = Date.now();
    const list = this.failures.get(ip) ?? [];
    list.push(now);
    this.failures.set(ip, list);
    this.audit.append("user", "auth.failure", what, { ip, ...(remote ? { remote: true } : {}) });
    if (remote) {
      // Many addresses guessing together: pause the link's sign-in for an hour; the computer's own keeps working.
      this.remoteFailures = this.remoteFailures.filter((t) => now - t < REMOTE_WINDOW);
      this.remoteFailures.push(now);
      if (this.remoteFailures.length >= REMOTE_MAX_FAILURES) {
        this.remoteFailures = [];
        this.remotePausedUntil = now + REMOTE_WINDOW;
        this.audit.append("user", "auth.remotePaused", undefined, { until: new Date(this.remotePausedUntil).toISOString() });
        this.onRemotePause?.();
      }
    }
    throw new AuthError(401, what === "setup" ? "auth.badSetupToken" : "auth.badPassword");
  }

  // ---------- password ----------

  /** `remote`: through the link (a server's hub is set up there), counted toward its shared budget. */
  setup(token: string, password: string, ip: string, opts: { remote?: boolean } = {}): void {
    this.checkRate(ip, opts.remote);
    if (this.hasPassword()) throw new AuthError(409, "auth.passwordExists");
    if (!this.setupToken || !sameSecret(token.trim(), this.setupToken)) this.fail(ip, "setup", opts.remote);
    if (password.length < 8) throw new AuthError(400, "auth.passwordTooShort");
    this.set("password", hashPassword(password));
    this.setupToken = undefined;
    this.audit.append("user", "auth.setup");
  }

  /** `remote`: the request came through the link (remote.ts) and counts toward its shared budget. */
  verifyPassword(password: string, ip: string, opts: { remote?: boolean } = {}): void {
    this.checkRate(ip, opts.remote);
    const h = this.get("password");
    if (!h) throw new AuthError(409, "auth.noPassword");
    if (!verifyPassword(password, h)) this.fail(ip, "password", opts.remote);
    this.failures.delete(ip);
  }

  changePassword(oldPass: string, newPass: string, ip: string): void {
    this.verifyPassword(oldPass, ip);
    if (newPass.length < 8) throw new AuthError(400, "auth.passwordTooShort");
    this.set("password", hashPassword(newPass));
    this.db.prepare("delete from auth_sessions").run();
    this.audit.append("user", "auth.password-change");
  }

  /** CLI recovery: set a new password directly (requires shell access to the container). */
  resetPassword(newPass: string): void {
    this.set("password", hashPassword(newPass));
    this.db.prepare("delete from auth_sessions").run();
    this.audit.append("user", "auth.password-reset");
  }

  // ---------- sessions ----------

  createSession(kind: SessionKind): { token: string; session: AuthSession } {
    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(18).toString("base64url");
    const now = Date.now();
    const expiresAt = new Date(now + TTL[kind]).toISOString();
    this.db.prepare("insert into auth_sessions(id, kind, csrf, created_at, expires_at) values (?,?,?,?,?)").run(hashToken(token), kind, csrf, nowIso(), expiresAt);
    this.audit.append("user", "auth.login", kind);
    return { token, session: { id: hashToken(token), kind, csrf, expiresAt } };
  }

  /** Validate a session cookie; console sessions slide their idle expiry. */
  session(token: string | undefined, kind: SessionKind): AuthSession | undefined {
    if (!token) return undefined;
    const r = this.db.prepare("select * from auth_sessions where id = ? and kind = ?").get(hashToken(token), kind) as any;
    if (!r) return undefined;
    if (Date.parse(r.expires_at) < Date.now()) {
      this.db.prepare("delete from auth_sessions where id = ?").run(r.id);
      return undefined;
    }
    if (kind === "console") {
      const expiresAt = new Date(Date.now() + TTL.console).toISOString();
      this.db.prepare("update auth_sessions set expires_at = ? where id = ?").run(expiresAt, r.id);
      r.expires_at = expiresAt;
    }
    return { id: r.id, kind: r.kind, csrf: r.csrf, expiresAt: r.expires_at };
  }

  logout(token: string | undefined): void {
    if (token) this.db.prepare("delete from auth_sessions where id = ?").run(hashToken(token));
  }

  sweep(): void {
    this.db.prepare("delete from auth_sessions where expires_at < ?").run(nowIso());
  }

  // ---------- passkeys ----------

  listPasskeys(): Array<{ id: string; name: string; createdAt: string }> {
    return (this.db.prepare("select id, name, created_at from passkeys order by created_at").all() as any[]).map((r) => ({ id: r.id, name: r.name ?? "passkey", createdAt: r.created_at }));
  }

  removePasskey(id: string): void {
    this.db.prepare("delete from passkeys where id = ?").run(id);
    this.audit.append("user", "auth.passkey-remove", id);
  }

  private remember(key: string, challenge: string): void {
    const now = Date.now();
    for (const [k, v] of this.challenges) if (v.expires < now) this.challenges.delete(k);
    this.challenges.set(key, { challenge, expires: now + 5 * 60_000 });
  }

  private take(key: string): string {
    const c = this.challenges.get(key);
    this.challenges.delete(key);
    if (!c || c.expires < Date.now()) throw new AuthError(400, "auth.passkeyExpired");
    return c.challenge;
  }

  async passkeyRegistrationOptions(): Promise<unknown> {
    const existing = this.db.prepare("select id, transports from passkeys").all() as Array<{ id: string; transports: string | null }>;
    const opts = await generateRegistrationOptions({
      rpName: "Piomio",
      rpID: this.rpId,
      userName: "owner",
      userDisplayName: "Piomio owner",
      attestationType: "none",
      excludeCredentials: existing.map((e) => ({ id: e.id, transports: e.transports ? JSON.parse(e.transports) : undefined })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    this.remember("register", opts.challenge);
    return opts;
  }

  async passkeyRegister(response: RegistrationResponseJSON, name: string): Promise<void> {
    const challenge = this.take("register");
    const v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: this.origins, expectedRPID: this.rpId, requireUserVerification: false });
    if (!v.verified) throw new AuthError(400, "auth.passkeyNotVerified");
    const c = v.registrationInfo.credential;
    this.db
      .prepare("insert into passkeys(id, public_key, counter, transports, name, created_at) values (?,?,?,?,?,?)")
      .run(c.id, Buffer.from(c.publicKey).toString("base64"), c.counter, JSON.stringify(c.transports ?? []), name || "passkey", nowIso());
    this.audit.append("user", "auth.passkey-add", c.id, { name });
  }

  async passkeyLoginOptions(): Promise<unknown> {
    const keys = this.db.prepare("select id, transports from passkeys").all() as Array<{ id: string; transports: string | null }>;
    if (!keys.length) throw new AuthError(404, "auth.noPasskeys");
    const opts = await generateAuthenticationOptions({
      rpID: this.rpId,
      allowCredentials: keys.map((k) => ({ id: k.id, transports: k.transports ? JSON.parse(k.transports) : undefined })),
      userVerification: "preferred",
    });
    this.remember(`login:${opts.challenge}`, opts.challenge);
    return opts;
  }

  async passkeyLogin(response: AuthenticationResponseJSON, ip: string): Promise<void> {
    this.checkRate(ip);
    const clientData = JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8")) as { challenge: string };
    const challenge = this.take(`login:${clientData.challenge}`);
    const row = this.db.prepare("select * from passkeys where id = ?").get(response.id) as any;
    if (!row) this.fail(ip, "passkey-unknown");
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.origins,
      expectedRPID: this.rpId,
      credential: { id: row.id, publicKey: new Uint8Array(Buffer.from(row.public_key, "base64")), counter: row.counter, transports: JSON.parse(row.transports ?? "[]") },
      requireUserVerification: false,
    });
    if (!v.verified) this.fail(ip, "passkey");
    this.db.prepare("update passkeys set counter = ? where id = ?").run(v.authenticationInfo.newCounter, row.id);
  }
}
