// The security console on a standby replica works on the leader: approvals, the vault, rules and the audit log go there
// over the link once the standby has checked who asks, so a tap there wakes the call waiting on the leader and nothing
// runs on the standby. Signing in and the account (password, passkeys) stay on the standby's own console.
import { afterAll, describe, expect, it } from "vitest";
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
  /** Its security console. */
  console: string;
  hub?: Hub;
}

async function machine(name: string): Promise<Machine> {
  const [port, consolePort, egressPort, devicePort] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const deviceUrl = `https://127.0.0.1:${devicePort}`;
  return {
    dir: mkdtempSync(join(tmpdir(), `owl-cluster-console-${name}-`)),
    deviceUrl,
    console: `http://127.0.0.1:${consolePort}`,
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
  const config = loadConfig(m.env, { dataDir: m.dir, builtinPluginsDir: join(fixtures, "plugins"), builtinAgentsDir: join(fixtures, "agents") });
  m.hub = new Hub(config);
  await m.hub.start();
  return m.hub;
}

const card = (h: Hub, summary: string) => {
  const agentId = h.settings.get().defaultAgent;
  const conv = h.store.agentConversation(agentId);
  return h.approvals.create({ sessionId: "s-test", conversationId: conv.id, agentId, tool: "hub_test_action", input: { what: summary }, summary, effect: "external", tainted: false });
};

describe("the security console on a standby", () => {
  const all: Machine[] = [];
  afterAll(async () => {
    for (const m of all) await m.hub?.stop().catch(() => {});
  }, 60_000);

  it("sends approvals, the vault, rules and its socket to the leader, and only for a session it checked", { timeout: 180_000 }, async () => {
    // The VPS leads; the Mac's replica is a standby, and the person opens the console on the Mac.
    const vps = await machine("vps");
    const mac = await machine("mac");
    all.push(vps, mac);
    const v = await boot(vps);
    v.vault.init("correct horse battery");
    const { link } = v.cluster.invite();
    await joinCluster({ dataDir: mac.dir, link, name: "mac", urls: [mac.deviceUrl], nodeUrls: [] });
    const m = await boot(mac);
    expect(m.cluster.leads()).toBe(false);
    await until(() => m.cluster.leaderTarget()?.link && m.cluster.leaderTarget()?.console, "the standby's link to the leader");

    // Signed in at the Mac's console just now (the sign-in stays on the Mac): the leader may not have this session yet.
    const { token, session } = m.auth.createSession("console");
    const cookie = `piomio_console=${token}`;
    const origin = mac.console;
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie, "x-csrf": session.csrf, origin }) =>
      fetch(`${mac.console}${path}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

    // Nothing may run on the standby: a deferred action there would be a second copy of the leader's work.
    let ranOnStandby = 0;
    m.approvals.onDeferredApproved = async () => void ranOnStandby++;
    m.approvals.onDeferredDenied = async () => void ranOnStandby++;

    // An agent's call waits on the leader for a card; the Mac's console lists it at once, from the leader.
    const a = card(v, "send the report");
    const waited = v.approvals.wait(a.id, 60_000);
    const listed = (await (await call("GET", "/console-api/approvals")).json()) as Array<{ id: string; agentName?: string }>;
    expect(listed.map((x) => x.id)).toContain(a.id);
    // The tap at the Mac's console wakes the call waiting on the leader.
    const tapped = await call("POST", `/console-api/approvals/${a.id}`, { decision: "approve" });
    expect(tapped.status).toBe(200);
    expect(((await tapped.json()) as { status: string }).status).toBe("approved");
    expect(await Promise.race([waited, new Promise((r) => setTimeout(() => r("still waiting"), 5_000))])).toBe("approved");
    expect(v.approvals.get(a.id)?.resolvedVia).toBe("console");
    expect(v.audit.list({ limit: 50, action: "approval.resolve" }).some((e) => JSON.stringify(e).includes(a.id))).toBe(true);
    expect(ranOnStandby).toBe(0);

    // The vault is the leader's: its state, and an item saved at the Mac lands there the moment the answer comes.
    const vault = (await (await call("GET", "/console-api/vault")).json()) as { state: string };
    expect(vault.state).toBe("unlocked");
    const saved = await call("PUT", "/console-api/vault/items", { name: "Mail", type: "login", fields: { username: "me", password: "s3cret" } });
    expect(saved.status).toBe(200);
    const item = (await saved.json()) as { id: string };
    expect(v.vault.list().map((i) => i.id)).toContain(item.id);

    // So are the rules and the audit log.
    const rule = await call("POST", "/console-api/rules", { tool: "hub_test_action", decision: "deny", note: "from the mac" });
    expect(rule.status).toBe(200);
    expect(v.rules.list().some((r) => r.note === "from the mac")).toBe(true);
    const audit = (await (await call("GET", "/console-api/audit?action=rule.create")).json()) as unknown[];
    expect(audit.length).toBeGreaterThan(0);

    // The console's socket is the leader's: a card made on the VPS reaches it.
    const ws = new WebSocket(`${mac.console.replace(/^http/, "ws")}/console-api/ws`, { headers: { cookie, origin } });
    const events: Array<{ type: string; data?: { id?: string } }> = [];
    ws.on("message", (d) => events.push(JSON.parse(String(d))));
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const made: string[] = [];
    const live = await until(() => {
      made.push(card(v, "a live one").id);
      return v.approvals.get(made.find((id) => events.some((e) => e.type === "approval.created" && e.data?.id === id)) ?? "");
    }, "the leader's card on the standby's console socket");
    ws.close();

    // Nothing goes to the leader without a session the standby checked: no cookie, a forged session, a wrong CSRF
    // token or origin, or the web UI's session instead of the console's.
    const forged = { "x-piomio-link": "anything", "x-piomio-session": JSON.stringify(session) };
    const deny = (headers: Record<string, string>) => call("POST", `/console-api/approvals/${live.id}`, { decision: "approve" }, headers);
    expect((await deny({ "x-csrf": session.csrf, origin })).status).toBe(401);
    expect((await deny({ ...forged, "x-csrf": session.csrf, origin })).status).toBe(401);
    expect((await deny({ cookie, "x-csrf": "nope", origin })).status).toBe(403);
    expect((await deny({ cookie, "x-csrf": session.csrf, origin: "https://evil.example" })).status).toBe(403);
    const web = m.auth.createSession("main");
    expect((await deny({ cookie: `piomio_console=${web.token}`, "x-csrf": web.session.csrf, origin })).status).toBe(401);
    // Straight at the leader's console, a forged mark is no session either.
    const direct = await fetch(`${vps.console}/console-api/approvals/${live.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...forged, "x-csrf": session.csrf, origin: vps.console },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(direct.status).toBe(401);
    // Nor a socket without a session.
    const refused = await new Promise<number>((resolve) => {
      const w = new WebSocket(`${mac.console.replace(/^http/, "ws")}/console-api/ws`, { headers: { origin, ...forged } });
      w.once("close", (code) => resolve(code));
      w.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      w.once("error", () => resolve(-1));
    });
    expect(refused).toBe(4401);
    expect(v.approvals.get(live.id)?.status).toBe("pending");

    // Signing in and the account stay on the Mac's own console.
    const state = (await (await call("GET", "/console-api/auth/state")).json()) as { authenticated: boolean; publicUrl: string };
    expect(state).toMatchObject({ authenticated: true, publicUrl: m.config.publicUrl });
    expect((await call("GET", "/console-api/passkeys")).status).toBe(200);

    // A leader on an older version doesn't take the console: a tap there waits for it, and nothing runs on the standby.
    const hello = v.cluster.hello.bind(v.cluster);
    v.cluster.hello = () => ({ ...hello(), console: undefined });
    await until(() => !m.cluster.leaderTarget()?.console, "the standby hearing the older leader");
    await until(() => m.approvals.get(live.id), "the card on the standby");
    expect((await call("POST", `/console-api/approvals/${live.id}`, { decision: "approve" })).status).toBe(503);
    expect(m.approvals.get(live.id)?.status).toBe("pending");
    expect(v.approvals.get(live.id)?.status).toBe("pending");
    expect(ranOnStandby).toBe(0);
  });
});
