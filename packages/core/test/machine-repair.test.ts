// A computer paired again gets a new machine id (a new key, a new invite): what named its old record — the agents'
// brains, chat brain and computers, unfinished tasks, the team's rules — moves to the new one once the old record is
// removed, in either order, and when the hub starts (references left from before this existed).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineInfo } from "@piomio/shared";
import { openDb } from "../src/db.ts";
import { EventBus } from "../src/bus.ts";
import { AuditLog } from "../src/audit.ts";
import { BrainRegistry } from "../src/brains.ts";
import { MachineHub } from "../src/machines.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { Hub, loadConfig } from "../src/index.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const machineKey = () => Buffer.alloc(32, 7).toString("base64url");
const info = (hostname: string): MachineInfo => ({ os: "Windows 11 Pro", hostname, arch: "x64", nodeVersion: "v24.16.0", clis: [], allowedDirs: [] });

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

describe("a computer paired again (machines)", () => {
  function setup() {
    const db = openDb(":memory:");
    const bus = new EventBus();
    const audit = new AuditLog(db);
    const machines = new MachineHub({ db, bus, brains: new BrainRegistry(), audit });
    const replaced: Array<{ from: string; to: string }> = [];
    bus.on("machine.replaced", (e) => replaced.push(e));
    const old = (id: string, hostname: string, at = "2026-11-01T10:00:00.000Z") =>
      db.prepare("insert into machines(id, name, public_key, info, created_at) values (?,?,?,?,?)").run(id, hostname.toUpperCase(), machineKey(), JSON.stringify(info(hostname)), at);
    const pair = (hostname: string) => machines.pair({ code: machines.createPairingCode().code, publicKey: machineKey(), name: hostname, info: info(hostname) }).id;
    return { machines, replaced, old, pair };
  }

  it("takes over a removed record of the same computer when it pairs", () => {
    const { machines, replaced, old, pair } = setup();
    old("mach_first", "legostin-pc");
    machines.revoke("mach_first");
    expect(replaced).toEqual([]);
    const id = pair("LEGOSTIN-PC");
    expect(replaced).toEqual([{ from: "mach_first", to: id }]);
    expect(machines.successor("mach_first")).toBe(id);
  });

  it("takes over when the old record is removed after it paired", () => {
    const { machines, replaced, old, pair } = setup();
    old("mach_first", "legostin-pc");
    const id = pair("legostin-pc");
    expect(replaced).toEqual([]);
    machines.revoke("mach_first");
    expect(replaced).toEqual([{ from: "mach_first", to: id }]);
  });

  it("leaves another computer's records and a live one alone", () => {
    const { machines, replaced, old, pair } = setup();
    old("mach_vps", "ubuntu-4gb-fsn1-1");
    old("mach_pc", "legostin-pc");
    machines.revoke("mach_vps");
    pair("legostin-pc");
    expect(replaced).toEqual([]);
    expect(machines.successor("mach_vps")).toBeUndefined();
    // The old PC record is still paired: nothing takes it over until it is removed.
    expect(machines.successor("mach_pc")).toBeUndefined();
  });

  it("lists every removed record with the computer that took its place", () => {
    const { machines, old, pair } = setup();
    old("mach_first", "legostin-pc", "2026-10-28T10:00:00.000Z");
    old("mach_second", "legostin-pc", "2026-11-01T10:00:00.000Z");
    machines.revoke("mach_first");
    machines.revoke("mach_second");
    const id = pair("legostin-pc");
    expect(machines.replaced()).toEqual([
      { from: "mach_first", to: id },
      { from: "mach_second", to: id },
    ]);
  });
});

describe("machine_list", () => {
  it("says which Piomio each computer runs and when it is older than the hub", async () => {
    const db = openDb(":memory:");
    const audit = new AuditLog(db);
    const machines = new MachineHub({ db, bus: new EventBus(), brains: new BrainRegistry(), audit });
    machines.version = "0.2.18";
    const row = (id: string, name: string, version?: string) =>
      db.prepare("insert into machines(id, name, public_key, info, created_at) values (?,?,?,?,?)").run(id, name, machineKey(), JSON.stringify({ ...info(name.toLowerCase()), ...(version ? { version } : {}) }), "2026-11-02T10:00:00.000Z");
    row("mach_pc", "LEGOSTIN-PC");
    row("mach_vps", "vps", "0.2.12");
    row("mach_mac", "studio", "0.2.18");
    const registry = new ToolRegistry();
    machines.registerTools(registry);
    const r = await registry.get("machine_list")!.invoke({}, {} as never);
    const lines = r.content.map((c) => (c as { text: string }).text).join("").split("\n");
    expect(lines[0]).toMatch(/LEGOSTIN-PC .+Piomio from before 0\.2\.5 \(older than this hub's 0\.2\.18: ask the user to install the current Piomio on that computer\)/);
    expect(lines[1]).toMatch(/vps .+Piomio 0\.2\.12 \(older than this hub's 0\.2\.18/);
    expect(lines[2]).toMatch(/studio .+Piomio 0\.2\.18$/);
  });
});

describe("a computer paired again (the hub)", () => {
  let hub: Hub;
  let config: ReturnType<typeof loadConfig>;
  const row = (id: string, hostname: string) =>
    hub.db.prepare("insert into machines(id, name, public_key, info, created_at) values (?,?,?,?,?)").run(id, hostname, machineKey(), JSON.stringify(info(hostname)), "2026-10-28T10:00:00.000Z");
  const pair = (hostname: string) => hub.machines.pair({ code: hub.machines.createPairingCode().code, publicKey: machineKey(), name: hostname, info: info(hostname) }).id;
  const onPc = (pc: string) => {
    hub.saveAgent({ ...hub.agents.get("assistant")!, id: "blender", name: "Blender", brains: [`fake@${pc}`, "fake@local"], thinking: { chat: { brain: `fake@${pc}`, preset: "balanced" } }, machines: [pc], prompt: "Blender." }, "user");
    const rule = hub.runner.rules.set({ when: "renders", machine: pc, brain: `fake@${pc}` })!;
    const task = hub.store.createTask({ agentId: "blender", title: "Donut", goal: "Make a donut", brainRef: `fake@${pc}`, background: true, createdBy: "agent", resumeAt: "2099-01-01T00:00:00.000Z", status: "queued" });
    return { rule: rule.id, task: task.id };
  };

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-repair-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("moves the agents' brains and computers, unfinished tasks and the team's rules to the new record", () => {
    row("mach_old", "legostin-pc");
    const { rule, task } = onPc("mach_old");
    hub.machines.revoke("mach_old");
    const pc = pair("LEGOSTIN-PC");
    const a = hub.agents.get("blender")!;
    expect(a.brains).toEqual([`fake@${pc}`, "fake@local"]);
    expect(a.thinking?.chat).toEqual({ brain: `fake@${pc}`, preset: "balanced" });
    expect(a.machines).toEqual([pc]);
    expect(hub.runner.rules.list().find((r) => r.id === rule)).toMatchObject({ machine: pc, brain: `fake@${pc}` });
    expect(hub.store.getTask(task)!.brainRef).toBe(`fake@${pc}`);
  });

  it("keeps a brain once when the agent already had it on the new record", () => {
    row("mach_dup", "studio");
    const pc = pair("studio");
    hub.saveAgent({ ...hub.agents.get("blender")!, brains: ["fake@mach_dup", `fake@${pc}`, "fake@local"], machines: [] }, "user");
    hub.machines.revoke("mach_dup");
    expect(hub.agents.get("blender")!.brains).toEqual([`fake@${pc}`, "fake@local"]);
  });

  it("moves what was left on removed records when the hub starts", async () => {
    row("mach_gone", "laptop");
    hub.machines.revoke("mach_gone");
    const pc = pair("laptop");
    // References from before the hub moved them (written straight to the agent's file).
    hub.agents.save({ ...hub.agents.get("blender")!, brains: ["fake@mach_gone", "fake@local"], thinking: { chat: { brain: "fake@mach_gone" } }, machines: ["mach_gone"] });
    await hub.stop();
    hub = new Hub(config);
    await hub.start();
    const a = hub.agents.get("blender")!;
    expect(a.brains).toEqual([`fake@${pc}`, "fake@local"]);
    expect(a.thinking?.chat?.brain).toBe(`fake@${pc}`);
    expect(a.machines).toEqual([pc]);
  });
});
