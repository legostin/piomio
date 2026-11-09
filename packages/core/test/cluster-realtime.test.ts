// Realtime sockets follow the lead: a replica that stops leading closes the sockets it served itself (a phone, the
// web UI, a socket another replica piped to it), so they reconnect and get the new leader's events instead of
// listening to a hub that no longer runs anything. Each socket also answers the page's {"type":"ping"} with a pong.
import { afterAll, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { freePort } from "@piomio/testkit";
import { Hub, loadConfig } from "../src/index.ts";
import { joinCluster } from "../src/cluster.ts";

const fixtures = join(import.meta.dirname, "fixtures");

async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 30_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Machine {
  dir: string;
  env: NodeJS.ProcessEnv;
  deviceUrl: string;
  main: string;
  hub?: Hub;
}

async function machine(name: string): Promise<Machine> {
  const [port, consolePort, egressPort, devicePort] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const deviceUrl = `https://127.0.0.1:${devicePort}`;
  return {
    dir: mkdtempSync(join(tmpdir(), `owl-cluster-rt-${name}-`)),
    deviceUrl,
    main: `http://127.0.0.1:${port}`,
    env: {
      PIOMIO_PORT: String(port),
      PIOMIO_CONSOLE_PORT: String(consolePort),
      PIOMIO_EGRESS_PORT: String(egressPort),
      PIOMIO_DEVICE_PORT: String(devicePort),
      PIOMIO_DEVICE_HOST: "127.0.0.1",
      PIOMIO_DEVICE_URLS: deviceUrl,
      PIOMIO_REPLICA_NAME: name,
      TZ: "UTC",
    },
  };
}

async function boot(m: Machine): Promise<Hub> {
  const config = loadConfig(m.env, { dataDir: m.dir, builtinPluginsDir: join(fixtures, "plugins"), builtinAgentsDir: join(fixtures, "agents"), ownNode: false });
  m.hub = new Hub(config);
  await m.hub.start();
  return m.hub;
}

function phoneKey(): string {
  const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64");
}

interface Live {
  ws: WebSocket;
  events: Array<{ type: string; data?: any }>;
  closed?: number;
}

async function live(url: string, headers: Record<string, string>, query = ""): Promise<Live> {
  const ws = new WebSocket(url.replace(/^http/, "ws") + "/api/ws" + query, { headers, rejectUnauthorized: false });
  const l: Live = { ws, events: [] };
  ws.on("message", (d) => l.events.push(JSON.parse(String(d))));
  ws.on("close", (code) => (l.closed = code));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return l;
}

/** An event only `hub` emits reaches the socket. */
async function hears(hub: Hub, l: Live, unread: number, what: string): Promise<void> {
  await until(() => {
    hub.bus.emit("inbox.changed", { unread });
    return l.events.some((e) => e.type === "inbox.changed" && e.data?.unread === unread);
  }, what);
}

async function pongs(l: Live, what: string): Promise<void> {
  const before = l.events.filter((e) => e.type === "pong").length;
  l.ws.send(JSON.stringify({ type: "ping" }));
  await until(() => l.events.filter((e) => e.type === "pong").length > before, what, 10_000);
}

describe("realtime sockets when the lead moves", () => {
  const all: Machine[] = [];
  afterAll(async () => {
    for (const m of all) await m.hub?.stop().catch(() => {});
  }, 60_000);

  it("closes what the old leader served, and the sockets land on the new one", { timeout: 180_000 }, async () => {
    const mac = await machine("mac");
    const vps = await machine("vps");
    all.push(mac, vps);
    const a = await boot(mac);
    const { link } = a.cluster.invite();
    await joinCluster({ dataDir: vps.dir, link, name: "vps", urls: [vps.deviceUrl], nodeUrls: [] });
    const b = await boot(vps);
    await until(() => b.cluster.states().find((s) => s.name === "mac")?.role === "leader", "the vps seeing the mac lead");
    await until(() => b.cluster.leaderTarget()?.link, "the vps's link to the mac");

    const { code } = a.devices.createPairingCode();
    const { token } = a.devices.pair({ code, name: "phone", platform: "ios", publicKey: phoneKey() });
    await until(() => b.devices.authenticate(`Bearer ${token}`), "the phone on the vps");
    const phone = { authorization: `Bearer ${token}` };
    const { token: cookieToken } = a.auth.createSession("main");
    const window = { cookie: `piomio_session=${cookieToken}`, origin: mac.main };

    // The Mac leads: its phone socket, its window's socket and a phone at the VPS's address (piped to the Mac).
    // The app's own socket asks without streamed text (its chat page has its own).
    const phoneAtMac = await live(mac.deviceUrl, phone, "?deltas=0");
    const windowAtMac = await live(mac.main, window);
    const phoneAtVps = await live(vps.deviceUrl, phone, "?deltas=0");
    a.bus.emit("message.delta", { id: "m_1", conversationId: "c_1", delta: "tok" });
    for (const [l, what] of [
      [phoneAtMac, "the phone at the mac"],
      [windowAtMac, "the mac's window"],
      [phoneAtVps, "the phone at the vps"],
    ] as const) {
      await hears(a, l, 1, `${what} hearing the mac`);
      await pongs(l, `${what} answering a ping`);
    }
    expect(windowAtMac.events.some((e) => e.type === "message.delta")).toBe(true);
    expect(phoneAtMac.events.some((e) => e.type === "message.delta")).toBe(false);
    expect(phoneAtVps.events.some((e) => e.type === "message.delta")).toBe(false);

    // "Keep the hub on the VPS": the Mac hands the lead over.
    a.cluster.setPrimary("vps");
    await until(() => b.cluster.leads() && !a.cluster.leads(), "the lead on the vps", 90_000);
    await until(() => phoneAtMac.closed && windowAtMac.closed && phoneAtVps.closed, "the sockets the mac served closing");

    // A socket the Mac serves while it cannot reach its leader yet closes once it can.
    await until(() => a.cluster.leaderTarget()?.link && a.cluster.leaderTarget()?.webUi, "the mac's link to the vps");
    const leaderTarget = a.cluster.leaderTarget.bind(a.cluster);
    a.cluster.leaderTarget = () => undefined;
    const meanwhile = await live(mac.deviceUrl, phone);
    a.cluster.leaderTarget = leaderTarget;
    await until(() => meanwhile.closed === 1012, "the socket served without a leader closing", 15_000);

    // Opened again, each one hears the VPS.
    const phoneAgain = await live(mac.deviceUrl, phone);
    const windowAgain = await live(mac.main, window);
    const vpsAgain = await live(vps.deviceUrl, phone);
    for (const [l, what] of [
      [phoneAgain, "the phone at the mac"],
      [windowAgain, "the mac's window"],
      [vpsAgain, "the phone at the vps"],
    ] as const) {
      await hears(b, l, 2, `${what} hearing the vps`);
      await pongs(l, `${what} answering a ping on the vps`);
    }
    for (const l of [phoneAgain, windowAgain, vpsAgain]) l.ws.close();
  });
});
