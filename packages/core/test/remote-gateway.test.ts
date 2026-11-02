// The link's gateways end to end, with a fake node (fixtures/tailnet): what the link opens and what it never does,
// the client's real address, the shared sign-in budget, phones through the link, the library's card, and a new hub's
// first-run setup through the link.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { Hub, loadConfig } from "../src/index.ts";
import { parsePairingLink } from "../src/pairing.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const FAKE = join(fixtures, "tailnet/fake-tailnet.mjs");
chmodSync(FAKE, 0o755);
const LINK = "piomio-test.tail1234.ts.net";
const PASSWORD = "remote-test-pass";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function until<T>(fn: () => Promise<T | undefined> | T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const v = await fn();
      if (v) return resolve(v);
      if (Date.now() > end) return reject(new Error("timed out"));
      setTimeout(poll, 20);
    };
    void poll();
  });
}

interface Res {
  status: number;
  json: any;
  headers: Record<string, any>;
}

/** What the node's proxy sends: the link's Host, the client's address in X-Forwarded-For. */
function viaLink(port: number, method: string, path: string, o: { host?: string; ip?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = o.body === undefined ? undefined : JSON.stringify(o.body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          host: o.host ?? LINK,
          "x-forwarded-for": o.ip ?? "203.0.113.50",
          "x-forwarded-proto": "https",
          origin: `https://${o.host ?? LINK}`,
          ...(data ? { "content-type": "application/json" } : {}),
          ...o.headers,
        },
      },
      (res) => {
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

describe("the link's gateways", () => {
  let hub: Hub;
  let web: Web;
  let dataDir: string;
  let ports: { web: number; device: number };

  beforeAll(async () => {
    const [port, consolePort, egressPort, devicePort] = [await freePort(), await freePort(), await freePort(), await freePort()];
    dataDir = mkdtempSync(join(tmpdir(), "owl-remote-gw-"));
    mkdirSync(join(dataDir, "tailnet"), { recursive: true });
    writeFileSync(
      join(dataDir, "tailnet", "fake.json"),
      JSON.stringify({ states: [{ state: "running", url: `https://${LINK}`, deviceUrl: `https://${LINK}:8443`, account: "anna@example.com" }] }),
    );
    const config = loadConfig(
      {
        PIOMIO_PORT: String(port),
        PIOMIO_DEVICES: "0",
        PIOMIO_CONSOLE_PORT: String(consolePort),
        PIOMIO_EGRESS_PORT: String(egressPort),
        PIOMIO_DEVICE_PORT: String(devicePort),
        PIOMIO_DEVICE_HOST: "127.0.0.1",
        PIOMIO_TAILNET_BIN: FAKE,
        TZ: "UTC",
      },
      { dataDir, builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents"), plugins: "none", tailnetLinkCheck: false },
    );
    hub = new Hub(config);
    await hub.start();
    web = new Web(config.publicUrl);
    await web.req("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: PASSWORD });
    web.csrf = (await web.req("GET", "/api/bootstrap")).json.csrf;

    const lib = await web.req("GET", "/api/integrations");
    expect(lib.json[0]).toMatchObject({ id: "remote-access", connect: "remote", category: "communication", status: "off" });

    const on = await web.req("POST", "/api/remote/enable");
    expect(on.status).toBe(200);
    await until(async () => (await web.req("GET", "/api/remote")).json.state === "running");
    const start = JSON.parse(readFileSync(join(dataDir, "tailnet", "start.json"), "utf8"));
    ports = { web: Number(start.web.split(":")[1]), device: Number(start.device.split(":")[1]) };
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("opens the web UI's sign-in for the link's host only", async () => {
    const state = await viaLink(ports.web, "GET", "/api/auth/state");
    expect(state.status).toBe(200);
    expect(state.json).toMatchObject({ hasPassword: true, authenticated: false, passkeys: 0 });
    expect((await viaLink(ports.web, "GET", "/api/auth/state", { host: "evil.example.com" })).status).toBe(421);
    expect((await viaLink(ports.web, "GET", "/api/bootstrap")).status).toBe(401);
  });

  it("never has the desktop sign-in, passkeys, Google's return page or webhooks; setup only before the first password", async () => {
    expect((await viaLink(ports.web, "POST", "/api/auth/setup", { body: { token: "x", password: "something-long" } })).status).toBe(409);
    for (const [method, path] of [
      ["POST", "/api/auth/desktop"],
      ["POST", "/api/auth/passkey/options"],
      ["POST", "/api/auth/passkey/verify"],
      ["GET", "/oauth/callback?state=x&code=y"],
      ["POST", "/hooks/telegram/update"],
    ]) {
      expect((await viaLink(ports.web, method, path, { body: method === "POST" ? {} : undefined })).status, `${method} ${path}`).toBe(404);
    }
    // MCP stays: brains on machines paired through the link reach the hub's tools there, with their session's token.
    const mcp = await viaLink(ports.web, "POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(mcp.status).toBe(401);
  });

  it("signs in with the password, with a secure cookie, and counts failures by the client's real address", async () => {
    for (let i = 0; i < 10; i++) expect((await viaLink(ports.web, "POST", "/api/auth/login", { ip: "203.0.113.1", body: { password: "wrong" } })).status).toBe(401);
    const locked = await viaLink(ports.web, "POST", "/api/auth/login", { ip: "203.0.113.1", body: { password: PASSWORD } });
    expect(locked.status).toBe(429);
    // Another address is not locked out by the first one's failures.
    const ok = await viaLink(ports.web, "POST", "/api/auth/login", { ip: "203.0.113.2", body: { password: PASSWORD } });
    expect(ok.status).toBe(200);
    const cookie = String(ok.headers["set-cookie"]);
    expect(cookie).toMatch(/Secure/);
    const session = cookie.split(";")[0];
    const boot = await viaLink(ports.web, "GET", "/api/bootstrap", { headers: { cookie: session } });
    expect(boot.status).toBe(200);
    // State-changing requests need the link's own origin.
    const foreign = await viaLink(ports.web, "POST", "/api/remote/disable", { headers: { cookie: session, "x-csrf": boot.json.csrf, origin: "https://evil.example.com" }, body: {} });
    expect(foreign.status).toBe(403);
  });

  it("serves phones through the link: pairing, the bearer token and the current addresses", async () => {
    const hello = await viaLink(ports.device, "GET", "/api/device/hello", { host: `${LINK}:8443` });
    expect(hello.json).toMatchObject({ piomio: true });
    // The device port itself is off; the link alone is enough to pair.
    const pairing = await web.req("POST", "/api/devices/pairing");
    expect(pairing.status).toBe(200);
    expect(parsePairingLink(pairing.json.link)!.urls).toEqual([`https://${LINK}:8443`]);
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const key = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64");
    const paired = await viaLink(ports.device, "POST", "/api/devices/pair", { host: `${LINK}:8443`, body: { code: pairing.json.code, name: "Phone", platform: "ios", model: "iPhone", publicKey: key } });
    expect(paired.status).toBe(200);
    const addresses = await viaLink(ports.device, "GET", "/api/devices/addresses", { host: `${LINK}:8443`, headers: { authorization: `Bearer ${paired.json.token}` } });
    expect(addresses.json).toEqual({ urls: [`https://${LINK}:8443`] });
    expect((await viaLink(ports.device, "GET", "/api/devices/addresses", { host: `${LINK}:8443` })).status).toBe(401);
  });

  it("shows the link in the library, as a QR, and offers it to other machines", async () => {
    const lib = await web.req("GET", "/api/integrations");
    expect(lib.json[0]).toMatchObject({ id: "remote-access", status: "connected", account: `https://${LINK}` });
    const remote = await web.req("GET", "/api/remote");
    expect(remote.json).toMatchObject({ state: "running", url: `https://${LINK}`, account: "anna@example.com" });
    expect(remote.json.qrSvg).toMatch(/^<svg/);
    const machine = await web.req("POST", "/api/machines/pairing-code", {});
    expect(machine.json.hubUrl).toBe(`https://${LINK}`);
    // One invite for any device: its link is on the web gateway, never the phones' port; the phone's QR uses that.
    const invite = await web.req("POST", "/api/invites", {});
    expect(invite.json.url).toBe(`https://${LINK}/join/${invite.json.code}`);
    expect(invite.json.serverCommand).toBe(`curl -fsSL https://piomio.io/install.sh | sh -s -- https://${LINK}/join/${invite.json.code}`);
    expect(parsePairingLink(invite.json.phoneLink)!.urls).toEqual([`https://${LINK}:8443`]);
    const page = await viaLink(ports.web, "GET", `/join/${invite.json.code}`, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
    expect(page.status).toBe(200);
    expect(page.json).toContain(`piomio://pair?hub=${encodeURIComponent(`https://${LINK}`)}&amp;code=${invite.json.code}`);
    // The chat's card tells the model the hub is reachable but never gives it a code.
    const conversationId = hub.store.agentConversation("assistant").id;
    const r = await hub.tools.get("hub_connect_device")!.invoke({}, { conversationId, agentId: "assistant", sessionId: "s", machineId: "local", workspace: tmpdir(), tainted: false, background: false } as any);
    const said = r.content.map((c: any) => c.text).join("");
    expect(said).toContain("Other devices reach the hub");
    expect(said).not.toContain(invite.json.code);
  });

  it("pauses sign-in through the link after 30 failures from anywhere, while the computer's own works", async () => {
    // 10 failures so far (from .1; its locked attempt did not count), 20 more from as many addresses.
    for (let i = 0; i < 20; i++) await viaLink(ports.web, "POST", "/api/auth/login", { ip: `198.51.100.${i + 1}`, body: { password: "wrong" } });
    const paused = await viaLink(ports.web, "POST", "/api/auth/login", { ip: "198.51.100.200", body: { password: PASSWORD } });
    expect(paused.status).toBe(429);
    expect(paused.json.error).toMatch(/paused for an hour/);
    const local = new Web(hub.config.publicUrl);
    expect((await local.req("POST", "/api/auth/login", { password: PASSWORD })).status).toBe(200);
    await until(() => hub.notifier.list().find((n) => n.title === "Someone is guessing your password"));
  }, 20_000);

  it("closes the gateways when turned off", async () => {
    await web.req("POST", "/api/remote/disable");
    await expect(viaLink(ports.web, "GET", "/api/auth/state")).rejects.toThrow();
    const lib = await web.req("GET", "/api/integrations");
    expect(lib.json[0]).toMatchObject({ id: "remote-access", status: "off" });
  });
});

describe("a new hub through its link", () => {
  let hub: Hub;
  let web: number;

  beforeAll(async () => {
    const [port, consolePort, egressPort, devicePort] = [await freePort(), await freePort(), await freePort(), await freePort()];
    const dataDir = mkdtempSync(join(tmpdir(), "owl-remote-new-"));
    mkdirSync(join(dataDir, "tailnet"), { recursive: true });
    writeFileSync(join(dataDir, "tailnet", "fake.json"), JSON.stringify({ states: [{ state: "running", url: `https://${LINK}`, deviceUrl: `https://${LINK}:8443` }] }));
    const config = loadConfig(
      {
        PIOMIO_PORT: String(port),
        PIOMIO_DEVICES: "0",
        PIOMIO_CONSOLE_PORT: String(consolePort),
        PIOMIO_EGRESS_PORT: String(egressPort),
        PIOMIO_DEVICE_PORT: String(devicePort),
        PIOMIO_DEVICE_HOST: "127.0.0.1",
        PIOMIO_TAILNET_BIN: FAKE,
        TZ: "UTC",
      },
      { dataDir, builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents"), plugins: "none", tailnetLinkCheck: false },
    );
    hub = new Hub(config);
    // What a server's hub starts with (install.sh): the switch on, no password yet.
    hub.settings.update({ remoteAccess: true });
    await hub.start();
    await until(() => hub.remote.link());
    web = Number(JSON.parse(readFileSync(join(dataDir, "tailnet", "start.json"), "utf8")).web.split(":")[1]);
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("is set up through the link with the setup code, whose wrong guesses count toward the link's budget", async () => {
    expect((await viaLink(web, "GET", "/api/auth/state")).json).toMatchObject({ hasPassword: false });
    const wrong = await viaLink(web, "POST", "/api/auth/setup", { ip: "203.0.113.9", body: { token: "guess", password: PASSWORD } });
    expect(wrong.status).toBe(401);
    expect(hub.audit.list({ action: "auth.failure" })[0]).toMatchObject({ target: "setup", data: { ip: "203.0.113.9", remote: true } });
    const ok = await viaLink(web, "POST", "/api/auth/setup", { ip: "203.0.113.10", body: { token: hub.auth.setupToken, password: PASSWORD } });
    expect(ok.status).toBe(200);
    expect(String(ok.headers["set-cookie"])).toMatch(/Secure/);
    expect(hub.auth.hasPassword()).toBe(true);
    expect((await viaLink(web, "POST", "/api/auth/setup", { body: { token: "x", password: PASSWORD } })).status).toBe(409);
  });
});
