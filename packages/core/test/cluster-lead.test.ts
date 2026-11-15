// Who leads (cluster.ts leadStep): the primary replica leads whenever it is up and caught up; the others lead only while
// it is away and give the lead back when it asks. The person's case: the VPS is the primary, the MacBook sleeps, wakes
// and drops off all day, and the lead stays on the VPS.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "@piomio/testkit";
import { ahead, leadStep, type LeadPeer, type LeadView } from "../src/cluster.ts";
import { Hub, loadConfig } from "../src/index.ts";

const MIN = 60_000;
const vps = { id: "rep_vps", priority: 0 };
const mac = { id: "rep_mac", priority: 1 };

const peer = (p: { id: string; priority: number }, o: Partial<LeadPeer> = {}): LeadPeer => ({ ...p, role: "standby", wantLead: false, caughtUp: true, ...o });
const view = (me: { id: string; priority: number }, o: Partial<LeadView> = {}): LeadView => ({
  me,
  role: "standby",
  stale: false,
  handingOver: false,
  upMs: 60 * MIN,
  awakeMs: 60 * MIN,
  awakeBeforeLead: 5 * MIN,
  peers: [],
  ...o,
});

describe("the order", () => {
  it("puts the lower priority first, then the lower id", () => {
    expect(ahead(vps, mac)).toBe(true);
    expect(ahead(mac, vps)).toBe(false);
    expect(ahead({ id: "a", priority: 1 }, { id: "b", priority: 1 })).toBe(true);
    expect(ahead({ id: "b", priority: 1 }, { id: "a", priority: 1 })).toBe(false);
  });
});

describe("with the VPS as the primary, the MacBook", () => {
  it("does not ask for the lead when it wakes, however long it stays awake", () => {
    const leading = [peer(vps, { role: "leader" })];
    expect(leadStep(view(mac, { awakeMs: 1_000, peers: leading }))).toEqual({ do: "stay", wantLead: false });
    expect(leadStep(view(mac, { awakeMs: 10 * 60 * MIN, peers: leading }))).toEqual({ do: "stay", wantLead: false });
    // Nor while the VPS is up between two leads (a restart in progress, the lead not taken yet).
    expect(leadStep(view(mac, { peers: [peer(vps)] }))).toEqual({ do: "stay", wantLead: false });
  });

  it("leads only while the VPS is away", () => {
    // Just started, the VPS not heard yet: it listens a moment first.
    expect(leadStep(view(mac, { upMs: 1_000 }))).toEqual({ do: "stay" });
    expect(leadStep(view(mac))).toEqual({ do: "lead", why: "no other replica answers" });
  });

  it("gives the lead back once the VPS is back, caught up and asks", () => {
    // Back, still catching up: it does not ask yet, and the MacBook keeps leading.
    expect(leadStep(view(mac, { role: "leader", peers: [peer(vps)] }))).toEqual({ do: "stay" });
    expect(leadStep(view(mac, { role: "leader", peers: [peer(vps, { wantLead: true })] }))).toEqual({ do: "handOver" });
    // A hand-over in progress (its turns finishing) is not started twice.
    expect(leadStep(view(mac, { role: "leader", handingOver: true, peers: [peer(vps, { wantLead: true })] }))).toEqual({ do: "stay" });
  });

  it("stands down at once when it led through a split and finds the VPS leading", () => {
    expect(leadStep(view(mac, { role: "leader", peers: [peer(vps, { role: "leader" })] }))).toEqual({ do: "standby", why: "a replica ahead of this one leads" });
  });

  it("stands down after a sleep it led into, when the VPS led meanwhile", () => {
    expect(leadStep(view(mac, { role: "leader", stale: true, peers: [peer(vps, { role: "leader" })] }))).toEqual({
      do: "standby",
      why: "another replica led while this one slept",
      stale: true,
    });
  });
});

describe("the VPS as the primary", () => {
  it("keeps the lead while the MacBook leads too after a split", () => {
    expect(leadStep(view(vps, { role: "leader", peers: [peer(mac, { role: "leader" })] }))).toEqual({ do: "stay" });
    expect(leadStep(view(vps, { role: "leader", peers: [peer(mac, { wantLead: true })] }))).toEqual({ do: "stay" });
  });

  it("asks for the lead back once it is caught up with the replica that led while it was away", () => {
    const macLeads = (o: Partial<LeadPeer> = {}) => [peer(mac, { role: "leader", ...o })];
    expect(leadStep(view(vps, { peers: macLeads({ caughtUp: false }) }))).toEqual({ do: "stay", wantLead: false });
    expect(leadStep(view(vps, { peers: macLeads() }))).toEqual({ do: "stay", wantLead: true });
  });

  it("asks only after it has stayed awake a while when it was the one that slept", () => {
    const macLeads = [peer(mac, { role: "leader" })];
    expect(leadStep(view(vps, { awakeMs: 2 * MIN, peers: macLeads }))).toEqual({ do: "stay", wantLead: false });
    expect(leadStep(view(vps, { awakeMs: 5 * MIN, peers: macLeads }))).toEqual({ do: "stay", wantLead: true });
  });

  it("leads when nobody does", () => {
    expect(leadStep(view(vps, { peers: [peer(mac)] }))).toEqual({ do: "lead", why: "no replica leads" });
  });
});

describe("setting the primary", () => {
  let hub: Hub | undefined;
  afterAll(async () => {
    await hub?.stop();
  }, 30_000);

  it("puts that replica first, marks it in the states and its addresses right after the leader's", { timeout: 60_000 }, async () => {
    const [port, consolePort, egressPort, devicePort] = [await freePort(), await freePort(), await freePort(), await freePort()];
    const own = `https://127.0.0.1:${devicePort}`;
    const env = {
      PIOMIO_PORT: String(port),
      PIOMIO_CONSOLE_PORT: String(consolePort),
      PIOMIO_EGRESS_PORT: String(egressPort),
      PIOMIO_DEVICE_PORT: String(devicePort),
      PIOMIO_DEVICE_HOST: "127.0.0.1",
      PIOMIO_DEVICE_URLS: own,
      PIOMIO_REPLICA_NAME: "mac",
      TZ: "UTC",
    };
    const fixtures = join(import.meta.dirname, "fixtures");
    hub = new Hub(loadConfig(env, { dataDir: mkdtempSync(join(tmpdir(), "piomio-primary-")), builtinPluginsDir: join(fixtures, "plugins"), builtinAgentsDir: join(fixtures, "agents"), ownNode: false }));
    await hub.start();
    expect(() => hub!.cluster.setPrimary("vps")).toThrow(/runs on one machine/);

    // A cluster of the Mac (it started it: first) and two replicas that never answer.
    hub.cluster.invite();
    const add = (id: string, name: string, priority: number, url: string) =>
      hub!.db
        .prepare("insert into replicas(id, name, public_key, urls, node_urls, priority, created_at) values (?,?,?,?,?,?,?)")
        .run(id, name, "x", JSON.stringify([url]), "[]", priority, new Date().toISOString());
    add("rep_vps", "vps", 2, "https://vps.example:8082");
    add("rep_pc", "pc", 3, "https://pc.example:8082");
    expect(hub.cluster.setPrimary("mac")).toMatchObject({ name: "mac", changed: false });
    expect(hub.cluster.states().find((s) => s.primary)?.name).toBe("mac");

    expect(hub.cluster.setPrimary("VPS")).toMatchObject({ id: "rep_vps", name: "vps", changed: true });
    const states = hub.cluster.states();
    expect(states.map((s) => [s.name, !!s.primary])).toEqual([
      ["vps", true],
      ["mac", false],
      ["pc", false],
    ]);
    expect(hub.audit.list({ action: "replica.primary" })[0]).toMatchObject({ target: "rep_vps" });
    expect(hub.cluster.setPrimary("rep_vps").changed).toBe(false);
    expect(() => hub!.cluster.setPrimary("nas")).toThrow("No replica nas");

    // Phones: the leader (this hub, the others never answered) first, then the primary, then the rest in order.
    expect(hub.cluster.phoneUrls([own])).toEqual([own, "https://vps.example:8082", "https://pc.example:8082"]);
  });
});
