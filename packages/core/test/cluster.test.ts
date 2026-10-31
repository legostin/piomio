// Two hubs as one: a replica joins with an invite and a snapshot, follows every change, takes the lead when the
// leader goes away and gives it back when the leader returns; a sealed replica is unlocked with one approval.
import { afterAll, describe, expect, it, onTestFailed } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";
import { joinCluster } from "../src/cluster.ts";
import { agentFromMarkdown } from "../src/agents.ts";

const fixtures = join(import.meta.dirname, "fixtures");

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
    dir: mkdtempSync(join(tmpdir(), `owl-cluster-${name}-`)),
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

async function boot(m: Machine): Promise<Hub> {
  const config = loadConfig(m.env, { dataDir: m.dir, builtinPluginsDir: join(fixtures, "plugins"), builtinAgentsDir: join(fixtures, "agents") });
  m.hub = new Hub(config);
  await m.hub.start();
  return m.hub;
}

describe("a hub on two machines", () => {
  const all: Machine[] = [];
  afterAll(async () => {
    for (const m of all) await m.hub?.stop().catch(() => {});
  }, 60_000);

  it("joins, follows, takes over, gives back and gets the vault unlocked", { timeout: 180_000 }, async () => {
    const mac = await machine("mac");
    const vps = await machine("vps");
    all.push(mac, vps);
    const a = await boot(mac);
    a.vault.init("cluster-vault-pass");
    a.vault.upsert({ id: "openai_api_key", type: "secret", name: "OpenAI API key", fields: { value: "sk-cluster" } });
    const dialog = a.store.agentConversation(a.settings.get().defaultAgent);
    a.store.addMessage({ conversationId: dialog.id, role: "user", parts: [{ type: "text", text: "before the replica" }], status: "complete" });

    // The leader makes an invite; the new machine joins with a snapshot and starts as a standby.
    const { link } = a.cluster.invite();
    expect(a.cluster.leads()).toBe(true);
    await joinCluster({ dataDir: vps.dir, link, name: "vps", urls: [vps.deviceUrl], nodeUrls: [] });
    const b = await boot(vps);
    expect(b.cluster.enabled).toBe(true);
    expect(b.cluster.leads()).toBe(false);
    expect(b.store.listMessages(dialog.id).map((m) => (m.parts[0] as any).text)).toContain("before the replica");

    // Every change follows within a moment, the vault's items too (sealed: the standby has no key yet).
    a.store.addMessage({ conversationId: dialog.id, role: "user", parts: [{ type: "text", text: "after the join" }], status: "complete" });
    await until(() => b.store.listMessages(dialog.id).some((m) => (m.parts[0] as any).text === "after the join"), "the new message on the standby");
    expect(b.vault.getMeta("openai_api_key")).toBeTruthy();
    expect(b.vault.state()).toBe("sealed");
    const states = await until(() => {
      const s = a.cluster.states();
      return s.find((x) => x.name === "vps")?.online && s;
    }, "the leader seeing the standby");
    expect(states.map((s) => [s.name, s.role])).toEqual([
      ["mac", "leader"],
      ["vps", "standby"],
    ]);

    // The leader asks the person once to unlock the standby's vault; the tap hands the key over.
    const ask = await until(() => a.approvals.list(["pending"]).find((x) => x.tool === "replica_unlock"), "the unlock card");
    a.approvals.resolve(ask.id, "approve", { via: "ui" });
    await until(() => b.vault.state() === "unlocked", "the standby's vault unlocked");
    expect(b.vault.read("openai_api_key").fields.value).toBe("sk-cluster");

    // A file in a workspace reaches the other machine.
    const ws = join(mac.dir, "workspaces", "assistant", "shared");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "notes.md"), "# from the mac\n");
    const { readFileSync, existsSync } = await import("node:fs");
    await until(() => existsSync(join(vps.dir, "workspaces", "assistant", "shared", "notes.md")), "the workspace file on the standby", 40_000);
    expect(readFileSync(join(vps.dir, "workspaces", "assistant", "shared", "notes.md"), "utf8")).toBe("# from the mac\n");

    // An agent bound to the Mac: the binding names the Mac by its replica id, and its file reaches the other machine.
    const coder = a.saveAgent({ ...agentFromMarkdown("coder", "", "user"), name: "Coder", brains: ["fake@local"], machines: ["local"] }, "user");
    expect(coder.machines).toEqual([a.here()]);
    await until(() => existsSync(join(vps.dir, "agents", "coder.md")), "the bound agent on the standby", 40_000);

    // The leader goes away: the standby leads within seconds and takes changes.
    await a.stop();
    mac.hub = undefined;
    await until(() => b.cluster.leads(), "the standby taking the lead", 30_000);
    b.store.addMessage({ conversationId: dialog.id, role: "user", parts: [{ type: "text", text: "while the mac slept" }], status: "complete" });
    // A machine reaches it while it leads (stands in for a node's connection).
    let dropped = false;
    (b.machines as any).peers.set("mach_while_leading", { closed: false, close: () => (dropped = true) });
    // The agent bound to the Mac does not think on the VPS meanwhile: its chat says the Mac is off, and keeps the message.
    const coderChat = b.store.agentConversation("coder");
    b.store.addMessage({ conversationId: coderChat.id, role: "user", parts: [{ type: "text", text: "are you there?" }], status: "complete" });
    expect((await b.runner.runTurn(coderChat, "are you there?", {})).error).toMatch(/Coder works only on mac/);

    // It comes back: standby first, it catches up, then it gets the lead back.
    const a2 = await boot(mac);
    expect(a2.cluster.leads()).toBe(false);
    await until(() => a2.store.listMessages(dialog.id).some((m) => (m.parts[0] as any).text === "while the mac slept"), "the mac catching up");
    await until(() => a2.cluster.leads() && !b.cluster.leads(), "the lead back on the mac", 60_000);
    // Giving the lead back drops that connection: the machine reconnects and lands on the leader.
    expect(dropped).toBe(true);
    // The Mac has that conversation, the error too, and the agent may think there again (this hub has no brains: the
    // brain setup card instead of saying the Mac is off).
    const kept = a2.store.listMessages(coderChat.id);
    expect(kept.some((m) => m.role === "user" && (m.parts[0] as any).text === "are you there?")).toBe(true);
    expect(kept.some((m) => m.parts.some((p) => p.type === "error" && /Coder works only on mac/.test(p.message)))).toBe(true);
    const back = (await a2.runner.runTurn(coderChat, "back", {})).error;
    expect(back).toMatch(/No brain works yet/);
  });
});

describe("a leader nobody can reach", () => {
  const all: Machine[] = [];
  afterAll(async () => {
    for (const m of all) await m.hub?.stop().catch(() => {});
  }, 60_000);

  it("works over the link it dials itself", { timeout: 180_000 }, async () => {
    const mac = await machine("mac");
    const vps = await machine("vps");
    all.push(mac, vps);
    // The Mac's only published address leads nowhere (a Funnel some networks cannot reach): only it can dial.
    const real = mac.deviceUrl;
    mac.env.PIOMIO_DEVICE_URLS = "https://127.0.0.1:1";
    const a = await boot(mac);
    a.vault.init("cluster-vault-pass");
    const dialog = a.store.agentConversation(a.settings.get().defaultAgent);
    const { link } = a.cluster.invite();
    await joinCluster({ dataDir: vps.dir, link: link.replace(encodeURIComponent("https://127.0.0.1:1"), encodeURIComponent(real)), name: "vps", urls: [vps.deviceUrl], nodeUrls: [] });
    const b = await boot(vps);
    a.store.addMessage({ conversationId: dialog.id, role: "user", parts: [{ type: "text", text: "over the link" }], status: "complete" });
    await until(() => b.store.listMessages(dialog.id).some((m) => (m.parts[0] as any).text === "over the link"), "the message on the standby over the link");
    await until(() => b.cluster.states().find((s) => s.name === "mac")?.role === "leader", "the standby seeing the leader");
    expect(b.cluster.leads()).toBe(false);
    // A phone at the standby's address gets the leader's answer, through the link.
    const res = await fetch(`${vps.deviceUrl}/api/device/hello`).catch(() => undefined);
    expect(res).toBeUndefined(); // self-signed: plain fetch refuses; the forwarding is checked with the pinned client
    const { pinnedRequest } = await import("@piomio/replica");
    const r = await pinnedRequest(`${vps.deviceUrl}/api/devices/me`, { fingerprint: b.deviceTls().fingerprint });
    expect(r.status).toBe(401);
    // A machine connected to the standby talks to the leader: its challenge, and its MCP calls.
    const { default: WebSocket } = await import("ws");
    const main = `ws://127.0.0.1:${vps.env.PIOMIO_PORT}/node/ws`;
    const first = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(main);
      ws.once("message", (d) => {
        resolve(String(d));
        ws.close();
      });
      ws.once("error", reject);
    });
    expect(JSON.parse(first)).toMatchObject({ type: "challenge" });
    const mcp = await fetch(`http://127.0.0.1:${vps.env.PIOMIO_PORT}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(mcp.status).toBe(401);
  });
});

/** A hub in a child process (fixtures/replica-process.ts): SIGSTOP makes it sleep as a computer does, SIGCONT wakes it. */
function processHub(): { child: ChildProcess; ask: <T>(op: string, args?: unknown) => Promise<T>; output: string[] } {
  const child = fork(join(fixtures, "replica-process.ts"), [], { execArgv: ["--disable-warning=ExperimentalWarning"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The Mac leads and sleeps (macOS DarkWake: every few minutes, all night); after GONE_MS the VPS takes the lead. The
// Mac must not wake still leading on what it held before it slept (its plugins' memory, its stale copies of rows), and
// must not take the lead back at every short wake either.
describe.skipIf(process.platform === "win32")("a leader whose computer sleeps", () => {
  const all: Machine[] = [];
  let mac: ReturnType<typeof processHub> | undefined;
  afterAll(async () => {
    if (mac) {
      mac.child.kill("SIGCONT");
      await Promise.race([mac.ask("stop"), sleep(20_000)]).catch(() => {});
      mac.child.kill("SIGKILL");
    }
    for (const m of all) await m.hub?.stop().catch(() => {});
  }, 60_000);

  it("stands down for the replica that led meanwhile, and takes the lead back once it stays awake", { timeout: 180_000 }, async () => {
    const macM = await machine("mac");
    const vps = await machine("vps");
    all.push(vps);
    mac = processHub();
    onTestFailed(() => console.log(`--- the mac's output ---\n${mac?.output.join("")}`));
    const awakeBeforeLead = 20_000;
    await mac.ask("start", { env: macM.env, dataDir: macM.dir, cluster: { awakeBeforeLead } });
    const { link, conversationId } = await mac.ask<{ link: string; conversationId: string }>("invite");
    await joinCluster({ dataDir: vps.dir, link, name: "vps", urls: [vps.deviceUrl], nodeUrls: [] });
    const b = await boot(vps);
    const macRole = () => b.cluster.states().find((s) => s.name === "mac")?.role;
    await until(() => macRole() === "leader", "the standby seeing the mac lead");

    // The Mac sleeps past GONE_MS: the VPS takes the lead, and things change through it.
    mac.child.kill("SIGSTOP");
    await until(() => b.cluster.leads(), "the vps taking the lead", 30_000);
    b.store.addMessage({ conversationId, role: "user", parts: [{ type: "text", text: "while the mac slept" }], status: "complete" });
    await sleep(2_000);

    // It wakes: the VPS keeps the lead, the Mac stands down (its main-only work stops) and catches up.
    mac.child.kill("SIGCONT");
    await until(() => macRole() === "standby", "the mac standing down after its sleep", 20_000);
    expect(b.cluster.leads()).toBe(true);
    await until(async () => (await mac!.ask<string[]>("texts", { conversationId })).includes("while the mac slept"), "the mac catching up");

    // It naps again before it has stayed awake long enough: nothing changes hands.
    mac.child.kill("SIGSTOP");
    await sleep(10_000);
    mac.child.kill("SIGCONT");
    const woke = Date.now();
    await until(() => macRole() === "standby", "the mac answering again after its nap", 20_000);
    await sleep(4_000);
    expect(b.cluster.leads()).toBe(true);
    expect(macRole()).toBe("standby");

    // Awake for long enough: it asks for the lead, gets it back and starts its main-only work afresh.
    await until(() => macRole() === "leader" && !b.cluster.leads(), "the lead back on the mac", 60_000);
    expect(Date.now() - woke).toBeGreaterThanOrEqual(awakeBeforeLead - 2_000);
    expect(b.audit.list({ action: "cluster.*" }).map((e) => e.action).reverse()).toEqual(["cluster.leader", "cluster.standby"]);
    expect(await mac.ask("switches")).toEqual([
      { action: "cluster.standby", why: "another replica led while this one slept" },
      { action: "cluster.leader", why: "no replica leads" },
    ]);
  });

  it("leaves the tasks to the replica that led while it slept", async () => {
    const m = await machine("solo");
    all.push(m);
    const h = await boot(m);
    const task = h.store.createTask({ agentId: "assistant", title: "brief", goal: "brief", createdBy: "trigger", background: true, status: "running" });
    // That replica queued this task when it took over and may have finished it: an old copy queued again would run it twice.
    await h.standby({ stale: true });
    expect(h.store.getTask(task.id)!.status).toBe("running");
  });
});
