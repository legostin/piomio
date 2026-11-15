// The web UI and the desktop app on a standby replica work on the leader: their calls and their realtime socket go
// there over the link once the standby has checked who asks, and nothing reaches the leader without a session the
// standby checked (cluster.test.ts covers the replicas themselves).
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
  /** Its main app (the web UI, the desktop app's window). */
  main: string;
  hub?: Hub;
}

async function machine(name: string): Promise<Machine> {
  const [port, consolePort, egressPort, devicePort] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const deviceUrl = `https://127.0.0.1:${devicePort}`;
  return {
    dir: mkdtempSync(join(tmpdir(), `owl-cluster-web-${name}-`)),
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

const texts = (h: Hub, conversationId: string) =>
  h.store.listMessages(conversationId).flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])));

describe("the web UI on a standby", () => {
  const all: Machine[] = [];
  afterAll(async () => {
    for (const m of all) await m.hub?.stop().catch(() => {});
  }, 60_000);

  it("sends its calls and its socket to the leader, and only for a session it checked", { timeout: 180_000 }, async () => {
    // The VPS leads; the Mac's replica is a standby, and the Mac's window is its main app.
    const vps = await machine("vps");
    const mac = await machine("mac");
    all.push(vps, mac);
    const v = await boot(vps);
    const { link } = v.cluster.invite();
    await joinCluster({ dataDir: mac.dir, link, name: "mac", urls: [mac.deviceUrl], nodeUrls: [] });
    const m = await boot(mac);
    expect(m.cluster.leads()).toBe(false);
    await until(() => m.cluster.leaderTarget()?.link, "the standby's link to the leader");
    const dialog = v.store.agentConversation(v.settings.get().defaultAgent);
    await until(() => m.store.getConversation(dialog.id), "the dialog on the standby");

    // Signed in at the Mac's window just now (the sign-in stays on the Mac): the leader may not have this session yet.
    const { token, session } = m.auth.createSession("main");
    const cookie = `piomio_session=${token}`;
    const origin = mac.main;
    const send = (text: string, headers: Record<string, string>) =>
      fetch(`${mac.main}/api/conversations/${dialog.id}/messages`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ text }) });

    // A message sent at the Mac's window lands on the VPS: it has it the moment the answer comes, no replication wait.
    const sent = await send("from the mac's window", { cookie, "x-csrf": session.csrf, origin });
    expect(sent.status).toBe(200);
    expect(((await sent.json()) as { conversationId: string }).conversationId).toBe(dialog.id);
    expect(texts(v, dialog.id)).toContain("from the mac's window");

    // Reads come from the leader too (it says it is the one answering), at this computer's own addresses.
    const states = (await (await fetch(`${mac.main}/api/cluster`, { headers: { cookie } })).json()) as Array<{ name: string; self: boolean; role: string }>;
    expect(states.find((s) => s.self)).toMatchObject({ name: "vps", role: "leader" });
    const boot0 = (await (await fetch(`${mac.main}/api/bootstrap`, { headers: { cookie, "accept-encoding": "gzip" } })).json()) as { csrf: string; consoleUrl: string; publicUrl: string };
    expect(boot0).toMatchObject({ csrf: session.csrf, consoleUrl: m.config.consoleUrl, publicUrl: m.config.publicUrl });

    // The window's socket is the leader's: an event only the VPS has reaches it.
    const ws = new WebSocket(`${mac.main.replace(/^http/, "ws")}/api/ws`, { headers: { cookie, origin } });
    const events: Array<{ type: string; data?: { unread?: number } }> = [];
    ws.on("message", (d) => events.push(JSON.parse(String(d))));
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    await until(() => {
      v.bus.emit("inbox.changed", { unread: 4242 });
      return events.some((e) => e.type === "inbox.changed" && e.data?.unread === 4242);
    }, "the leader's event on the standby's socket");
    ws.close();

    // A big answer comes over the link in pieces, whole.
    const big = randomBytes(9 * 1024 * 1024 + 123);
    mkdirSync(join(vps.dir, "workspaces", "assistant", "shared"), { recursive: true });
    writeFileSync(join(vps.dir, "workspaces", "assistant", "shared", "big.bin"), big);
    const file = await fetch(`${mac.main}/api/files?path=${encodeURIComponent("assistant/shared/big.bin")}`, { headers: { cookie } });
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(big)).toBe(true);

    // Nothing goes to the leader without a session the standby checked: no cookie, a forged session, a wrong CSRF
    // token or origin.
    const forged = { "x-piomio-link": "anything", "x-piomio-session": JSON.stringify(session) };
    expect((await send("no session", { "x-csrf": session.csrf, origin })).status).toBe(401);
    expect((await send("forged session", { ...forged, "x-csrf": session.csrf, origin })).status).toBe(401);
    expect((await send("wrong csrf", { cookie, "x-csrf": "nope", origin })).status).toBe(403);
    expect((await send("wrong origin", { cookie, "x-csrf": session.csrf, origin: "https://evil.example" })).status).toBe(403);
    // Straight at the leader, a forged mark is no session either.
    const direct = await fetch(`${vps.main}/api/conversations/${dialog.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...forged, "x-csrf": session.csrf, origin: vps.main },
      body: JSON.stringify({ text: "forged at the leader" }),
    });
    expect(direct.status).toBe(401);
    // Nor a socket without a session.
    const refused = await new Promise<number>((resolve) => {
      const w = new WebSocket(`${mac.main.replace(/^http/, "ws")}/api/ws`, { headers: { origin, ...forged } });
      w.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      w.once("open", () => resolve(101));
      w.once("error", () => resolve(-1));
    });
    expect(refused).toBe(401);
    expect(texts(v, dialog.id).filter((t) => /session|csrf|origin|forged/.test(t))).toEqual([]);

    // Sign-in stays on the standby's own app.
    const state = (await (await fetch(`${mac.main}/api/auth/state`, { headers: { cookie } })).json()) as { authenticated: boolean };
    expect(state.authenticated).toBe(true);

    // A leader on an older version doesn't take the web UI: changes there wait for it, as before.
    const hello = v.cluster.hello.bind(v.cluster);
    v.cluster.hello = () => ({ ...hello(), webUi: undefined });
    await until(() => !m.cluster.leaderTarget()?.webUi, "the standby hearing the older leader");
    expect((await send("to an older leader", { cookie, "x-csrf": session.csrf, origin })).status).toBe(503);
  });
});
