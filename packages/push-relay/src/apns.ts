// Apple's push service over HTTP/2, with a token (.p8) key: one connection per environment, a JWT renewed well
// before Apple's hour runs out.

import { connect, constants, type ClientHttp2Session } from "node:http2";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import type { ApnsEnvironment } from "./handle.ts";

export const APNS_ORIGINS: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

/** Apple refuses a provider token older than an hour and one renewed more often than every 20 minutes. */
const JWT_TTL_MS = 40 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface ApnsConfig {
  /** The .p8 key's PEM text. */
  key: string;
  keyId: string;
  teamId: string;
  /** The app's bundle id (apns-topic). */
  topic: string;
  /** Other servers to talk to (tests: a local h2c server). */
  origins?: Partial<Record<ApnsEnvironment, string>>;
}

export interface ApnsRequest {
  environment: ApnsEnvironment;
  token: string;
  payload: unknown;
  /** apns-push-type, apns-priority, apns-collapse-id, apns-expiration. */
  headers: Record<string, string>;
}

export interface ApnsResult {
  status: number;
  /** Apple's reason, e.g. "BadDeviceToken", "Unregistered". */
  reason?: string;
}

export type ApnsSend = (r: ApnsRequest) => Promise<ApnsResult>;

/** A JWT for APNs: ES256, signed by the .p8 key. */
export function providerToken(key: KeyObject, keyId: string, teamId: string, nowMs: number): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const head = `${part({ alg: "ES256", kid: keyId })}.${part({ iss: teamId, iat: Math.floor(nowMs / 1000) })}`;
  const sig = sign("sha256", Buffer.from(head), { key, dsaEncoding: "ieee-p1363" });
  return `${head}.${sig.toString("base64url")}`;
}

/** Whether Apple says the phone is gone for good: the app was deleted, or the token was never its own. */
export function isGone(r: ApnsResult): boolean {
  return r.status === 410 || (r.status === 400 && (r.reason === "BadDeviceToken" || r.reason === "DeviceTokenNotForTopic"));
}

export class ApnsClient {
  private key: KeyObject;
  private cfg: ApnsConfig;
  private jwt?: { value: string; at: number };
  private sessions = new Map<ApnsEnvironment, ClientHttp2Session>();
  private now: () => number;

  constructor(cfg: ApnsConfig, now: () => number = Date.now) {
    this.cfg = cfg;
    this.key = createPrivateKey(cfg.key);
    this.now = now;
  }

  private bearer(renew = false): string {
    const now = this.now();
    if (renew || !this.jwt || now - this.jwt.at > JWT_TTL_MS) this.jwt = { value: providerToken(this.key, this.cfg.keyId, this.cfg.teamId, now), at: now };
    return this.jwt.value;
  }

  private session(env: ApnsEnvironment): ClientHttp2Session {
    const open = this.sessions.get(env);
    if (open && !open.closed && !open.destroyed) return open;
    const s = connect(this.cfg.origins?.[env] ?? APNS_ORIGINS[env]);
    const drop = () => {
      if (this.sessions.get(env) === s) this.sessions.delete(env);
    };
    s.on("error", drop);
    s.on("close", drop);
    s.on("goaway", drop);
    // An idle connection does not keep the process up.
    s.unref();
    this.sessions.set(env, s);
    return s;
  }

  send: ApnsSend = async (r) => {
    let out = await this.once(r, false);
    // A token Apple stopped taking: a new one, once.
    if (out.status === 403 && (out.reason === "ExpiredProviderToken" || out.reason === "InvalidProviderToken")) out = await this.once(r, true);
    return out;
  };

  private once(r: ApnsRequest, renew: boolean): Promise<ApnsResult> {
    return new Promise((resolve) => {
      let req;
      try {
        req = this.session(r.environment).request({
          [constants.HTTP2_HEADER_METHOD]: "POST",
          [constants.HTTP2_HEADER_PATH]: `/3/device/${r.token}`,
          authorization: `bearer ${this.bearer(renew)}`,
          "apns-topic": this.cfg.topic,
          "content-type": "application/json",
          ...r.headers,
        });
      } catch (e) {
        resolve({ status: 0, reason: (e as Error).message });
        return;
      }
      let status = 0;
      let body = "";
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.close(constants.NGHTTP2_CANCEL));
      req.on("response", (h) => (status = Number(h[constants.HTTP2_HEADER_STATUS]) || 0));
      req.setEncoding("utf8");
      req.on("data", (c: string) => (body += c));
      req.on("error", (e) => resolve({ status: 0, reason: e.message }));
      req.on("close", () => {
        let reason: string | undefined;
        try {
          reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined;
        } catch {
          reason = undefined;
        }
        resolve({ status, ...(reason ? { reason } : {}) });
      });
      req.end(JSON.stringify(r.payload));
    });
  }

  close(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}
