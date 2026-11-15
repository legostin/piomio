// A hub replica's computer thinks while another replica leads (own-node.ts): the standby pairs its computer as a
// machine of its own and runs that daemon, so the leader lists the replica's computer as online, under the replica's
// id, and an agent bound to it works there. The standby runs in a process of its own with a host identity of its own,
// as on another computer; the leader's own daemon folds into the leader's computer (same host).
import { afterAll, describe, expect, it, onTestFailed } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";
import { joinCluster } from "../src/cluster.ts";
import { agentFromMarkdown } from "../src/agents.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 60_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function machine(name: string) {
  const [port, consolePort, egressPort, devicePort] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const deviceUrl = `https://127.0.0.1:${devicePort}`;
  return {
    dir: mkdtempSync(join(tmpdir(), `owl-own-node-${name}-`)),
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
    } as NodeJS.ProcessEnv,
  };
}

/** A hub in a child process (fixtures/replica-process.ts), on "another computer": a host identity of its own. */
function processHub(hostIdentityDir: string): { child: ChildProcess; ask: <T>(op: string, args?: unknown) => Promise<T>; output: string[] } {
  const child = fork(join(fixtures, "replica-process.ts"), [], {
    execArgv: ["--disable-warning=ExperimentalWarning"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, PIOMIO_HOST_IDENTITY_DIR: hostIdentityDir },
  });
  const output: string[] = [];
  child.stdout!.on("data", (d) => output.push(String(d)));
  child.stderr!.on("data", (d) => output.push(String(d)));
  const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  child.on("message", (m: any) => {
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    if (m.error) w?.reject(new Error(m.error));
    else w?.resolve(m.result);
  });
  let next = 0;
  const ask = <T>(op: string, args?: unknown) =>
    new Promise<T>((resolve, reject) => {
      const id = ++next;
      waiting.set(id, { resolve, reject });
      child.send({ id, op, args });
    });
  return { child, ask, output };
}

describe.skipIf(process.platform === "win32")("a replica's computer while another replica leads", () => {
  let leader: Hub | undefined;
  let standby: ReturnType<typeof processHub> | undefined;
  afterAll(async () => {
    if (standby) {
      await Promise.race([standby.ask("stop"), sleep(20_000)]).catch(() => {});
      standby.child.kill("SIGKILL");
    }
    await leader?.stop().catch(() => {});
  }, 60_000);

  it("serves as a machine of the leader, under the replica's id, while the replica is up", { timeout: 180_000 }, async () => {
    const mac = await machine("mac");
    const vps = await machine("vps");
    leader = new Hub(loadConfig(mac.env, { dataDir: mac.dir, builtinPluginsDir: join(fixtures, "plugins"), builtinAgentsDir: join(fixtures, "agents") } as any));
    await leader.start();
    const a = leader;
    const { link } = a.cluster.invite();
    await joinCluster({ dataDir: vps.dir, link, name: "vps", urls: [vps.deviceUrl], nodeUrls: [] });
    standby = processHub(mkdtempSync(join(tmpdir(), "owl-own-node-vps-host-")));
    onTestFailed(() => console.log(`--- the standby's output ---\n${standby?.output.join("")}`));
    await standby.ask("start", { env: vps.env, dataDir: vps.dir, ownNode: true });

    // The standby pairs its computer as a machine, publishes it on its replica row, and that machine reaches the leader.
    const vpsRow = () => a.db.prepare("select id, machine_id from replicas where name = 'vps' and revoked = 0").get() as { id: string; machine_id: string | null } | undefined;
    const served = await until(() => {
      const r = vpsRow();
      return r?.machine_id && a.machines.get(r.machine_id)?.status === "online" && r;
    }, "the standby's machine online at the leader");
    const vpsId = served.id;
    const vpsMachine = served.machine_id!;
    expect(a.cluster.leads()).toBe(true);

    // The computers list shows the standby's computer once, online, under the replica's id; its machine is an alias.
    const vpsComputer = a.computers().find((c) => c.id === vpsId);
    expect(vpsComputer).toMatchObject({ aliases: [vpsMachine], online: true });
    expect(vpsComputer!.standby).toBeUndefined();
    expect(a.computers().some((c) => c.id === vpsMachine)).toBe(false);
    expect(a.machines.canonical(vpsMachine)).toBe(vpsId);
    expect(a.resolveComputer(vpsMachine)).toBe(vpsId);
    // It said hello to the leader as a machine (its brains are what that computer has signed in: none on a CI runner).
    await until(() => a.machines.get(vpsMachine)?.info?.hostname, "the standby computer's hello at the leader");

    // The leader's own daemon is on the leader's computer: folded into it, not a computer of its own.
    const macMachine = await until(() => a.ownNode.ownId(), "the leader's own pairing");
    await until(() => a.computers()[0]!.aliases?.includes(macMachine), "the leader's own machine folded into its computer");
    expect(a.computers().some((c) => c.id === macMachine)).toBe(false);
    expect(a.machines.canonical(macMachine)).toBe(a.here());

    // An agent bound to the standby's computer: kept by the replica's id, and that computer counts as online.
    const coder = a.saveAgent({ ...agentFromMarkdown("coder", "", "user"), name: "Coder", brains: ["claude-code@local"], machines: [vpsMachine] }, "user");
    expect(coder.machines).toEqual([vpsId]);
    expect((a.runner as any).machinesOff(coder)).toBeUndefined();

    // The standby's computer goes away: its machine with it, and the agent's chat says that computer is off.
    await standby.ask("stop");
    standby.child.kill("SIGKILL");
    standby = undefined;
    await until(() => a.machines.get(vpsMachine)?.status === "offline", "the standby's machine offline");
    expect(a.computers().find((c) => c.id === vpsId)).toMatchObject({ online: false });
    expect((a.runner as any).machinesOff(coder)).toMatch(/^Coder works only on /);
  });
});
