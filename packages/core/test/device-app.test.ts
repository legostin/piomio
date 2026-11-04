// The device port end to end: pinned HTTPS, pairing, bearer tokens, approvals signed by the phone's key, revocation
// and the web UI's switch.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { request } from "node:https";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";
import { approvalPayload } from "../src/devices.ts";
import { parsePairingLink } from "../src/pairing.ts";
import { PushRelay } from "../src/push.ts";

const fixtures = join(import.meta.dirname, "fixtures");

/** What the app does: HTTPS to the device port, trusting only the certificate whose SHA-256 the QR carried. */
function phoneRequest(port: number, fingerprint: string, method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        rejectUnauthorized: false,
        headers: { ...(data ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), "x-piomio-locale": "en" },
      },
      (res) => {
        const raw = (res.socket as any).getPeerCertificate().raw as Buffer;
        if (createHash("sha256").update(raw).digest("base64url") !== fingerprint) {
          reject(new Error("certificate does not match the pinned fingerprint"));
          res.destroy();
          return;
        }
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json: any = text;
          try {
            json = JSON.parse(text);
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

/** What the chat page in the WebView does: the same pinned HTTPS, a cookie instead of the token, headers as given. */
function pageRequest(port: number, fingerprint: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; headers: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      { host: "127.0.0.1", port, path, method, rejectUnauthorized: false, headers: { ...(data ? { "content-type": "application/json" } : {}), ...headers } },
      (res) => {
        const raw = (res.socket as any).getPeerCertificate().raw as Buffer;
        if (createHash("sha256").update(raw).digest("base64url") !== fingerprint) return reject(new Error("certificate does not match the pinned fingerprint"));
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json: any = text;
          try {
            json = JSON.parse(text);
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

function phoneKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64"),
    sign: (m: string) => sign("sha256", Buffer.from(m), { key: privateKey, dsaEncoding: "der" }).toString("base64"),
  };
}

class Web {
  cookie = "";
  csrf = "";
  constructor(private base: string) {}
  async req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const r = await fetch(this.base + path, {
      method,
      headers: { origin: this.base, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...(this.csrf ? { "x-csrf": this.csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    const text = await r.text();
    let json: any = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: r.status, json };
  }
}

describe("device port", () => {
  let hub: Hub;
  let web: Web;
  let devicePort: number;

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    devicePort = await freePort();
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), PIOMIO_DEVICE_PORT: String(devicePort), PIOMIO_DEVICE_HOST: "127.0.0.1", PIOMIO_DEVICE_URLS: `https://127.0.0.1:${devicePort}`, TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-dev-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents"), plugins: "none" },
    );
    hub = new Hub(config);
    await hub.start();
    web = new Web(config.publicUrl);
    await web.req("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "device-test-pass" });
    web.csrf = (await web.req("GET", "/api/bootstrap")).json.csrf;
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("listens from the start, with no switch to turn", async () => {
    expect(hub.deviceNetwork()).toMatchObject({ enabled: true, listening: true, port: devicePort });
    expect((await web.req("GET", "/api/devices")).json.network).toMatchObject({ enabled: true, listening: true });
    expect((await web.req("PUT", "/api/devices/network", { enabled: false })).status).toBe(404);
  });

  it("pairs a phone from the QR and serves the hub API to its token only", async () => {
    const pairing = (await web.req("POST", "/api/devices/pairing", {})).json;
    const link = parsePairingLink(pairing.link)!;
    expect(link.urls[0]).toBe(`https://127.0.0.1:${devicePort}`);
    expect(pairing.qrSvg).toMatch(/^<svg/);
    const fp = link.fingerprint;

    expect((await phoneRequest(devicePort, fp, "GET", "/api/device/hello")).json).toMatchObject({ piomio: true });
    expect((await phoneRequest(devicePort, fp, "GET", "/api/team")).status).toBe(401);

    const key = phoneKey();
    const paired = await phoneRequest(devicePort, fp, "POST", "/api/devices/pair", { code: link.code, name: "Test iPhone", platform: "ios", model: "iPhone18,1", publicKey: key.publicKey });
    expect(paired.status).toBe(200);
    const token = paired.json.token as string;
    expect((await phoneRequest(devicePort, fp, "POST", "/api/devices/pair", { code: link.code, name: "Again", platform: "ios", publicKey: key.publicKey })).status).toBe(400);

    const boot = await phoneRequest(devicePort, fp, "GET", "/api/bootstrap", undefined, token);
    expect(boot.status).toBe(200);
    expect(boot.json.device).toMatchObject({ name: "Test iPhone" });
    expect(boot.json.csrf).toBeUndefined();
    expect((await phoneRequest(devicePort, fp, "GET", "/api/team", undefined, token)).status).toBe(200);
    // The web UI's routes for pairing and the plugins' UI modules are not on this port.
    expect((await phoneRequest(devicePort, fp, "POST", "/api/devices/pairing", {}, token)).status).toBe(404);
    expect((await web.req("GET", "/api/devices")).json.devices.map((d: any) => d.name)).toEqual(["Test iPhone"]);

    // ----- approvals: approve needs the phone's signature over a fresh nonce; deny does not -----
    const conv = hub.store.agentConversation("assistant").id;
    const mk = () => hub.approvals.create({ sessionId: "s", conversationId: conv, agentId: "assistant", tool: "mail_send", input: { to: "anna@example.com" }, summary: "Send mail", effect: "external", tainted: false });
    const a1 = mk();
    const list = (await phoneRequest(devicePort, fp, "GET", "/api/approvals", undefined, token)).json;
    expect(list.map((a: any) => a.id)).toContain(a1.id);

    const forged = await phoneRequest(devicePort, fp, "POST", `/api/approvals/${a1.id}/resolve`, { decision: "approve", nonce: "x", signature: "eA==" }, token);
    expect(forged.status).toBe(403);
    const { nonce } = (await phoneRequest(devicePort, fp, "POST", `/api/approvals/${a1.id}/challenge`, {}, token)).json;
    const ok = await phoneRequest(devicePort, fp, "POST", `/api/approvals/${a1.id}/resolve`, { decision: "approve", nonce, signature: key.sign(approvalPayload(a1.id, "approve", nonce)) }, token);
    expect(ok.status).toBe(200);
    expect(hub.approvals.get(a1.id)).toMatchObject({ status: "approved", resolvedVia: "device" });

    const a2 = mk();
    expect((await phoneRequest(devicePort, fp, "POST", `/api/approvals/${a2.id}/resolve`, { decision: "deny" }, token)).status).toBe(200);
    expect(hub.approvals.get(a2.id)!.status).toBe("denied");

    // ----- revoked from the web UI: the token stops working -----
    await web.req("DELETE", `/api/devices/${paired.json.deviceId}`);
    expect((await phoneRequest(devicePort, fp, "GET", "/api/team", undefined, token)).status).toBe(401);
  });

  it("signs the phone's chat page in with a ticket: a cookie session, CSRF and same-origin checks, gone with the device", async () => {
    const pairing = (await web.req("POST", "/api/devices/pairing", {})).json;
    const fp = parsePairingLink(pairing.link)!.fingerprint;
    const key = phoneKey();
    const paired = (await phoneRequest(devicePort, fp, "POST", "/api/devices/pair", { code: pairing.code, name: "Page phone", platform: "ios", publicKey: key.publicKey })).json;
    const token = paired.token as string;

    // The page itself has no token: without the cookie its routes refuse, the desktop pages are not here at all.
    expect((await phoneRequest(devicePort, fp, "GET", "/api/team")).status).toBe(401);
    expect((await phoneRequest(devicePort, fp, "GET", "/settings")).status).toBe(404);

    const { ticket } = (await phoneRequest(devicePort, fp, "POST", "/api/devices/web-ticket", {}, token)).json;
    const signIn = await pageRequest(devicePort, fp, "GET", `/m/session?ticket=${ticket}&to=/m/chat/abc`);
    expect(signIn.status).toBe(303);
    expect(signIn.headers.location).toBe("/m/chat/abc");
    const setCookie = String(signIn.headers["set-cookie"]);
    expect(setCookie).toMatch(/piomio_device=.+HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    const cookie = setCookie.split(";")[0];
    // A ticket works once.
    expect((await pageRequest(devicePort, fp, "GET", `/m/session?ticket=${ticket}&to=/m/chat/abc`)).status).toBe(401);
    // A redirect only within the phone's pages.
    const { ticket: t2 } = (await phoneRequest(devicePort, fp, "POST", "/api/devices/web-ticket", {}, token)).json;
    expect((await pageRequest(devicePort, fp, "GET", `/m/session?ticket=${t2}&to=https://evil.example/`)).headers.location).toBe("/m/");

    const page = await pageRequest(devicePort, fp, "GET", "/m/chat/abc", undefined, { cookie });
    expect(page.status).toBe(200);
    expect(String(page.headers["content-security-policy"])).toContain("connect-src 'self'");
    // The voice of a demonstration in the browser's live view: the hub's own page may use the microphone, nothing else.
    expect(page.headers["permissions-policy"]).toBe("camera=(), microphone=(self), geolocation=()");

    const boot = await pageRequest(devicePort, fp, "GET", "/api/bootstrap", undefined, { cookie });
    expect(boot.json.device.name).toBe("Page phone");
    const csrf = boot.json.csrf as string;
    expect(csrf.length).toBeGreaterThan(10);

    const conv = boot.json.mainConversationId;
    const origin = `https://127.0.0.1:${devicePort}`;
    expect((await pageRequest(devicePort, fp, "POST", `/api/conversations/${conv}/read`, {}, { cookie })).status).toBe(403);
    expect((await pageRequest(devicePort, fp, "POST", `/api/conversations/${conv}/read`, {}, { cookie, "x-csrf": csrf, origin: "https://evil.example" })).status).toBe(403);
    expect((await pageRequest(devicePort, fp, "POST", `/api/conversations/${conv}/read`, {}, { cookie, "x-csrf": csrf, origin })).status).toBe(200);
    // The page cannot mint tickets for itself.
    expect((await pageRequest(devicePort, fp, "POST", "/api/devices/web-ticket", {}, { cookie, "x-csrf": csrf, origin })).status).toBe(403);

    await web.req("DELETE", `/api/devices/${paired.deviceId}`);
    expect((await pageRequest(devicePort, fp, "GET", "/api/bootstrap", undefined, { cookie })).status).toBe(401);
  });

  it("wakes a phone through the relay with only the notification's id, and gives the phone the words itself", async () => {
    const pairing = (await web.req("POST", "/api/devices/pairing", {})).json;
    const fp = parsePairingLink(pairing.link)!.fingerprint;
    const paired = (await phoneRequest(devicePort, fp, "POST", "/api/devices/pair", { code: pairing.code, name: "Push phone", platform: "ios", publicKey: phoneKey().publicKey })).json;
    const token = paired.token as string;

    const calls: Array<{ path: string; body: any }> = [];
    let gone = false;
    hub.pushes.relay = new PushRelay("https://relay.test", async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body));
      calls.push({ path, body });
      if (path === "/v1/register") return Response.json({ handle: `sealed-${body.token.slice(0, 4)}` });
      return gone ? Response.json({ gone: true }, { status: 410 }) : Response.json({ ok: true });
    });

    const apns = "ab12".repeat(16);
    expect((await phoneRequest(devicePort, fp, "PUT", "/api/devices/me/push", { token: "not hex" }, token)).status).toBe(400);
    expect((await phoneRequest(devicePort, fp, "PUT", "/api/devices/me/push", { token: apns, environment: "sandbox" }, token)).status).toBe(200);
    expect(calls[0]).toEqual({ path: "/v1/register", body: { token: apns, environment: "sandbox" } });
    expect((await phoneRequest(devicePort, fp, "GET", "/api/devices/me", undefined, token)).json.push).toBe(true);

    const n = await hub.notifier.notify({ level: "notify", title: "Anna wrote", body: "Lunch at one?", agentId: "assistant" });
    await new Promise((r) => setTimeout(r, 50));
    const push = calls.find((c) => c.path === "/v1/push")!;
    // The relay hears the handle and an opaque id: no title, no body, no agent.
    expect(Object.keys(push.body).sort()).toEqual(["badge", "handle", "id", "kind"]);
    expect(push.body).toMatchObject({ handle: "sealed-ab12", id: n.id, kind: "message" });
    expect(JSON.stringify(push.body)).not.toMatch(/Anna|Lunch|assistant/);

    const note = await phoneRequest(devicePort, fp, "GET", `/api/devices/notifications/${n.id}`, undefined, token);
    expect(note.json).toMatchObject({ id: n.id, title: "Anna wrote", body: "Lunch at one?", agentId: "assistant", path: "/agent/assistant" });
    expect((await phoneRequest(devicePort, fp, "GET", `/api/devices/notifications/${n.id}`)).status).toBe(401);
    expect((await phoneRequest(devicePort, fp, "GET", "/api/devices/notifications/n_missing", undefined, token)).status).toBe(404);

    // The app was deleted from the phone: Apple says so, the hub drops the handle.
    gone = true;
    await hub.notifier.notify({ level: "notify", title: "Again", body: "x" });
    await new Promise((r) => setTimeout(r, 50));
    expect((await phoneRequest(devicePort, fp, "GET", "/api/devices/me", undefined, token)).json.push).toBeUndefined();
  });

  it("takes where the user is from the phone that shares it, for the agents, and forgets it when sharing stops or the phone goes", async () => {
    const pairing = (await web.req("POST", "/api/devices/pairing", {})).json;
    const fp = parsePairingLink(pairing.link)!.fingerprint;
    const paired = (await phoneRequest(devicePort, fp, "POST", "/api/devices/pair", { code: pairing.code, name: "Walking phone", platform: "ios", publicKey: phoneKey().publicKey })).json;
    const token = paired.token as string;
    const where = () => hub.tools.get("user_location")!.invoke({}, { sessionId: "s", agentId: "assistant", callId: "c", tainted: false, background: false, workspace: "", machineId: "local", conversationId: "c" });
    const said = async () => (await where()).content.map((c) => (c.type === "text" ? c.text : "")).join("");

    expect(await said()).toMatch(/^Unknown: the user's phone does not share their location/);
    expect((await phoneRequest(devicePort, fp, "POST", "/api/devices/location", { lat: 120, lon: 0 }, token)).status).toBe(400);
    const at = new Date(Date.now() - 5 * 60_000).toISOString();
    const sent = { lat: 43.2513, lon: 76.9545, accuracy: 35.4, at, place: "Dostyk Ave 52,  Almaty" };
    expect((await phoneRequest(devicePort, fp, "POST", "/api/devices/location", sent, token)).status).toBe(200);
    expect(hub.locations.get()).toEqual({ lat: 43.2513, lon: 76.9545, accuracyM: 35, place: "Dostyk Ave 52, Almaty", at, deviceId: paired.deviceId, deviceName: "Walking phone" });
    expect(await said()).toMatch(/^lat 43\.2513, lon 76\.9545 \(within 35 m\)\nPlace: Dostyk Ave 52, Almaty\nReported 5 min ago .* by the phone “Walking phone”\.$/);
    expect(hub.locations.line(() => "23:05")).toBe("Dostyk Ave 52, Almaty (from the phone “Walking phone”, as of 23:05)");
    expect(hub.locations.line(() => "23:05", Date.parse(at) + 7 * 3600_000)).toBe("last known near Dostyk Ave 52, Almaty (from the phone “Walking phone”, as of 23:05; may be out of date)");

    // Sharing turned off on the phone, then on again and the phone unpaired: gone both times.
    expect((await phoneRequest(devicePort, fp, "DELETE", "/api/devices/location", undefined, token)).status).toBe(200);
    expect(hub.locations.get()).toBeUndefined();
    await phoneRequest(devicePort, fp, "POST", "/api/devices/location", { lat: 1, lon: 2 }, token);
    expect(hub.locations.get()).toMatchObject({ lat: 1, lon: 2 });
    await web.req("DELETE", `/api/devices/${paired.deviceId}`);
    expect(hub.locations.get()).toBeUndefined();
  });
});

describe("device port closed by PIOMIO_DEVICES=0", () => {
  it("does not listen, and pairing needs the link", async () => {
    const [port, consolePort, egressPort, devicePort] = [await freePort(), await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), PIOMIO_DEVICE_PORT: String(devicePort), PIOMIO_DEVICE_HOST: "127.0.0.1", PIOMIO_DEVICES: "0", TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-dev-off-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents"), plugins: "none" },
    );
    const hub = new Hub(config);
    await hub.start();
    try {
      expect(hub.deviceNetwork()).toMatchObject({ enabled: false, listening: false });
      await expect(phoneRequest(devicePort, "x", "GET", "/api/device/hello")).rejects.toThrow();
      const web = new Web(config.publicUrl);
      await web.req("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "device-test-pass" });
      web.csrf = (await web.req("GET", "/api/bootstrap")).json.csrf;
      expect((await web.req("POST", "/api/devices/pairing", {})).status).toBe(409);
    } finally {
      await hub.stop();
    }
  });
});
