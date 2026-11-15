// A standby replica behind the leader updates itself when the leader asks over the link (self-update.ts updateTo):
// the leader shows Update on its row, asks with its own version, hears in the hellos how it goes and tells the person
// when it failed; the replica's refusal comes back as the reason. The download and install themselves are
// self-update.test.ts's; here the standby's updateTo is a stand-in.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinnedRequest, signRequest } from "@piomio/replica";
import { freePort } from "@piomio/testkit";
import { Hub, loadConfig } from "../src/index.ts";
import { joinCluster } from "../src/cluster.ts";
import { UpdateError, type SelfUpdateState } from "../src/self-update.ts";

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
  hub?: Hub;
}

async function machine(name: string): Promise<Machine> {
  const [port, consolePort, egressPort, devicePort] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const deviceUrl = `https://127.0.0.1:${devicePort}`;
  return {
    dir: mkdtempSync(join(tmpdir(), `owl-cluster-update-${name}-`)),
    deviceUrl,
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

async function boot(m: Machine, version?: string): Promise<Hub> {
  const config = loadConfig(m.env, { dataDir: m.dir, builtinPluginsDir: join(fixtures, "plugins"), builtinAgentsDir: join(fixtures, "agents"), ownNode: false });
  if (version) config.version = version;
  m.hub = new Hub(config);
  await m.hub.start();
  return m.hub;
}

describe("a standby replica behind the leader", () => {
  const all: Machine[] = [];
  afterAll(async () => {
    for (const m of all) await m.hub?.stop().catch(() => {});
  }, 60_000);

  it("is updated on the leader's Update: asked over the link, followed in its hellos", { timeout: 180_000 }, async () => {
    // The Mac leads on the new version; the VPS joined and stayed on the one before.
    const mac = await machine("mac");
    const vps = await machine("vps");
    all.push(mac, vps);
    const a = await boot(mac, "9.1.0");
    const { link } = a.cluster.invite();
    await joinCluster({ dataDir: vps.dir, link, name: "vps", urls: [vps.deviceUrl], nodeUrls: [] });
    const b = await boot(vps, "9.0.0");
    expect(b.cluster.leads()).toBe(false);

    // The VPS was installed with install.sh: it updates itself. Its updateTo is a stand-in that records the ask.
    const asked: string[] = [];
    let state: SelfUpdateState = {};
    let refuse: UpdateError | undefined;
    Object.defineProperty(b.updates, "kind", { get: () => "server", configurable: true });
    b.updates.updateTo = async (version: string) => {
      if (refuse) throw refuse;
      asked.push(version);
      state = { installing: version };
      return { version };
    };
    b.updates.selfState = () => state;

    const id = b.cluster.identity!.id;
    // The leader sees it behind, with Update on its row (Settings → Machines, the machines block, the chat's tools).
    const row = await until(() => a.cluster.states().find((s) => s.id === id && s.update), "Update on the replica's row");
    expect(row).toMatchObject({ name: "vps", version: "9.0.0", update: "9.1.0" });
    expect(a.activity.view().find((r) => r.id === id)).toMatchObject({ name: "vps", online: true, update: "9.1.0" });

    // A refusal there comes back as its reason, and the Update stays.
    refuse = new UpdateError("noRelease", "9.1.0");
    await expect(a.updates.update(id)).rejects.toMatchObject({ reason: "noRelease", version: "9.1.0" });
    expect(a.updates.offerFor(id)).toEqual({ update: "9.1.0" });
    refuse = undefined;

    // Pressed: the replica is asked for the leader's version, and shows updating until it says otherwise.
    expect(await a.updates.update(id)).toEqual({ version: "9.1.0", replica: { name: "vps", updates: "server" } });
    expect(asked).toEqual(["9.1.0"]);
    expect(a.updates.offerFor(id)).toEqual({ update: "9.1.0", updating: true });
    await until(() => a.cluster.states().find((s) => s.id === id)?.updating, "the replica updating in the leader's view");

    // It failed there: the leader hears it in a hello and has the default agent tell the person; Update comes back.
    state = { failed: { version: "9.1.0", why: "GitHub answered 502" } };
    const dialog = a.store.agentConversation(a.settings.get().defaultAgent);
    const note = await until(
      () =>
        a.store
          .listMessages(dialog.id)
          .flatMap((m) => (m.role === "system" ? m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])) : []))
          .find((t) => t.includes("could not update")),
      "the leader's note about the failed update",
    );
    expect(note).toContain("The hub replica vps could not update to Piomio 9.1.0 (GitHub answered 502); it stays on 9.0.0");
    expect(a.updates.offerFor(id)).toEqual({ update: "9.1.0" });

    // Without the link (a replica reached over its device app), the same call is signed: an unsigned one is refused.
    const path = "/api/replica/update";
    const body = JSON.stringify({ version: "9.1.0" });
    const fingerprint = a.deviceTls().fingerprint;
    const signed = await pinnedRequest(`${vps.deviceUrl}${path}`, {
      method: "POST",
      body,
      fingerprint,
      headers: { authorization: signRequest(a.cluster.identity!, "POST", path, body), "content-type": "application/json" },
    });
    expect(signed.status).toBe(200);
    expect(JSON.parse(signed.body.toString())).toEqual({ version: "9.1.0" });
    const unsigned = await pinnedRequest(`${vps.deviceUrl}${path}`, { method: "POST", body, fingerprint, headers: { "content-type": "application/json" } });
    expect(unsigned.status).toBe(401);
    expect(asked).toEqual(["9.1.0", "9.1.0"]);

    // The replica comes back on the leader's version: nothing more to offer.
    b.config.version = "9.1.0";
    state = {};
    await until(() => a.cluster.states().find((s) => s.id === id)?.version === "9.1.0", "the replica on the new version");
    expect(a.updates.offerFor(id)).toEqual({});
    expect(a.activity.view().find((r) => r.id === id)).toBeUndefined();
  });
});
