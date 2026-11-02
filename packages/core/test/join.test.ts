// The invite's page and the desktop installers, on a real hub: which way each device gets first, the address the
// desktop app pairs with, what an expired link says, the shared budget for wrong codes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";
import { installerUrl, platformOf } from "../src/server/join-page.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

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

describe("one link to connect a device", () => {
  let hub: Hub;
  let base: string;
  let cookie = "";
  let csrf = "";

  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, {
      method,
      headers: { origin: base, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf": csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };
  const open = (path: string, ua = WINDOWS, lang = "en") => fetch(base + path, { headers: { "user-agent": ua, "accept-language": lang }, redirect: "manual" });

  beforeAll(async () => {
    const [port, consolePort, egressPort, devicePort] = [await freePort(), await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), PIOMIO_DEVICE_PORT: String(devicePort), PIOMIO_DEVICE_HOST: "127.0.0.1", PIOMIO_DEVICE_URLS: `https://192.168.1.2:${devicePort}`, TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-join-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents"), plugins: "none" },
    );
    hub = new Hub(config);
    await hub.start();
    base = config.publicUrl;
    await api("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "join-test-pass" });
    csrf = (await api("GET", "/api/bootstrap")).json.csrf;
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("tells devices apart by their browser", () => {
    expect(platformOf(WINDOWS)).toBe("windows");
    expect(platformOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15")).toBe("macos");
    expect(platformOf(IPHONE)).toBe("ios");
    expect(platformOf("Mozilla/5.0 (Linux; Android 16; Pixel 10)")).toBe("android");
    expect(platformOf("curl/8.0")).toBe("other");
  });

  it("makes an invite with the phone's QR, and no shareable link while only this computer reaches the hub", async () => {
    const r = await api("POST", "/api/invites", {});
    expect(r.status).toBe(200);
    expect(r.json.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(r.json.url).toBeUndefined();
    expect(r.json.phoneLink).toContain(`c=${r.json.code}`);
    expect(r.json.qrSvg).toMatch(/^<svg/);
    expect((await api("DELETE", `/api/invites/${r.json.code}`)).json).toEqual({ ok: true });
    expect(hub.invites.valid(r.json.code)).toBe(false);
  });

  it("opens the desktop app with the address the page was opened at, the installer next to it", async () => {
    const { code } = hub.invites.create();
    const r = await open(`/join/${code}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toMatch(/^default-src 'none'/);
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("cache-control")).toBe("no-store");
    const html = await r.text();
    expect(html).toContain(`href="piomio://pair?hub=${encodeURIComponent(base)}&amp;code=${code}"`);
    expect(html.indexOf("/download/desktop/windows")).toBeLessThan(html.indexOf("/download/desktop/macos"));
    expect(html).toContain(`curl -fsSL https://piomio.io/install.sh | sh -s -- ${base}/join/${code}`);
    expect(html).toContain(`node piomio-node.mjs pair ${base}/join/${code}`);
    expect(html).not.toMatch(/<script/i);
  });

  it("puts the phone's way first on an iPhone, in the browser's language", async () => {
    const { code } = hub.invites.create();
    const html = await (await open(`/join/${code}`, IPHONE, "ru-RU,ru;q=0.9")).text();
    expect(html).toContain("Подключение к Piomio");
    const phone = html.indexOf(`piomio://pair?v=1&amp;c=${code}`);
    expect(phone).toBeGreaterThan(0);
    expect(phone).toBeLessThan(html.indexOf("piomio://pair?hub="));
  });

  it("hands out the installer of the hub's own version", async () => {
    const r = await open("/download/desktop/windows");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(installerUrl(hub.config.releasesRepo, hub.config.version, "windows"));
    expect(installerUrl("legostin/piomio", "0.2.0", "macos")).toBe("https://github.com/legostin/piomio/releases/download/v0.2.0/piomio-0.2.0.dmg");
    expect((await open("/download/desktop/linux")).status).toBe(404);
  });

  it("pairs a computer once, says so, and the link stops working", async () => {
    const used: unknown[] = [];
    const off = hub.bus.on("invite.used", (e) => used.push(e));
    const { code } = hub.invites.create();
    const pair = (c: string) =>
      fetch(`${base}/api/node/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: c, publicKey: Buffer.alloc(32, 9).toString("base64url"), name: "pc" }) });
    expect((await pair(code)).status).toBe(200);
    off();
    expect(used).toEqual([{ code, kind: "machine", name: "pc" }]);
    const again = await pair(code);
    expect(again.status).toBe(400);
    expect(((await again.json()) as any).error).toMatch(/expired or was already used/);
    const page = await open(`/join/${code}`);
    expect(page.status).toBe(410);
    expect(await page.text()).toContain("This link no longer works");
  });

  it("stops answering after ten wrong codes from one address", async () => {
    // Two failures so far: the reused code's pairing and its page.
    for (let i = 0; i < 8; i++) expect((await open(`/join/WRONG00${i}`)).status).toBe(410);
    expect((await open("/join/WRONG999")).status).toBe(429);
  });
});
