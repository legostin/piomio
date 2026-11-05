// Reading on another computer is free, as it is on this one; a change there goes to auto mode's reviewer. And the
// hub's own computer is a known computer: machine_list names it, and machine_exec there says what to do instead of
// "not found". (On 2026-11-05 auto mode stopped `pwd; git rev-parse HEAD` on vps as "a system not mentioned", and a
// Developer on the Mac was told "Machine local not found".)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "@piomio/testkit";
import { createRpcPeer, type RpcPeer, type RpcTransport } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { agentFromMarkdown } from "../src/agents.ts";
import { readOnlyRemoteCommand } from "../src/machines.ts";
import { hubName } from "../src/pairing.ts";

function peerPair(): [RpcPeer, RpcPeer] {
  const ends = [0, 1].map(() => ({ cb: (_m: string) => {}, closed: [] as Array<() => void> }));
  const transport = (me: number): RpcTransport => ({
    send: (m) => setImmediate(() => ends[1 - me].cb(m)),
    onMessage: (cb) => (ends[me].cb = cb),
    onClose: (cb) => ends[me].closed.push(cb),
    close: () => ends.forEach((e) => e.closed.forEach((c) => c())),
  });
  return [createRpcPeer(transport(0)), createRpcPeer(transport(1))];
}

const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");

describe("which commands on another computer only read", () => {
  it("reads: listing, git's reads, file views", () => {
    for (const c of ["pwd; ls -a; git rev-parse --show-toplevel; git rev-parse HEAD", "git log -5 --oneline", "cat README.md | head -20", "df -h", "uname -a"])
      expect(readOnlyRemoteCommand(c), c).toBe(true);
  });
  it("not reads: changes, credentials, addresses, anything the shell reader does not know", () => {
    for (const c of ["rm -rf build", "git push origin feature", "cat ~/.ssh/id_ed25519", "cat .env", "cat /home/piomio/.aws/credentials", "git ls-remote https://x.test/repo", "curl https://x.test", "npm test", "echo x > file"])
      expect(readOnlyRemoteCommand(c), c).toBe(false);
  });
});

describe("machine_exec and this computer (integration)", () => {
  let hub: Hub;
  let session = "";
  const prompts: string[] = [];
  const ran: string[] = [];

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const dataDir = mkdtempSync(join(tmpdir(), "owl-machine-access-"));
    const fixtures = join(import.meta.dirname, "fixtures");
    hub = new Hub(
      loadConfig(
        { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
        { dataDir, builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
      ),
    );
    await hub.start();
    hub.settings.update({ language: "en" });
    hub.saveAgent(agentFromMarkdown("dev", "---\nname: Dev\ndescription: Developer\nbrains: [fake@local]\ninitiative: 1\n---\nYou are Dev.", "user"), "user");
    const conv = hub.store.agentConversation("dev").id;
    hub.store.addMessage({ conversationId: conv, role: "user", parts: [{ type: "text", text: "Fix the panel header on the Mac" }], status: "complete" });
    session = hub.store.createSession({ conversationId: conv, agentId: "dev", brainRef: "fake@local", background: false }).row.id;
    mkdirSync(join(dataDir, "workspaces", "dev", conv), { recursive: true });
    hub.db
      .prepare("insert into machines(id, name, public_key, info, created_at) values (?,?,?,?,?)")
      .run("mach_vps", "vps", "x", JSON.stringify({ os: "Linux", arch: "x64", clis: [], allowedDirs: ["/home/piomio"], commands: true }), new Date().toISOString());
    const [hubEnd, daemon] = peerPair();
    daemon.handle("exec.run", (p: { command: string }) => (ran.push(p.command), { code: 0, stdout: "ok", stderr: "" }));
    (hub.machines as any).peers.set("mach_vps", hubEnd);
    hub.auto.useReviewer(() => async (prompt) => {
      prompts.push(prompt);
      return "ALLOW";
    });
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("runs a read-only command on another computer without a review", async () => {
    prompts.length = 0;
    const r = await hub.gateway.call(session, "machine_exec", { machine: "vps", command: "pwd; ls -a; git rev-parse --show-toplevel; git rev-parse HEAD" });
    expect(r.isError).toBeFalsy();
    expect(ran.at(-1)).toContain("git rev-parse HEAD");
    expect(prompts).toHaveLength(0);
    expect(hub.audit.list({ action: "policy.decision", limit: 1 })[0]).toMatchObject({ target: "machine_exec", data: { decision: "allow" } });
  });

  it("sends a change there to the reviewer", async () => {
    prompts.length = 0;
    const r = await hub.gateway.call(session, "machine_exec", { machine: "vps", command: "npm ci && npm test" });
    expect(r.isError).toBeFalsy();
    expect(prompts.length).toBeGreaterThan(0);
  });

  it("lists this hub's computer first and explains machine_exec on it", async () => {
    const list = text(await hub.gateway.call(session, "machine_list", {}));
    expect(list.split("\n")[0]).toContain(hubName());
    expect(list.split("\n")[0]).toMatch(/this hub's own computer/);
    for (const name of ["local", "this", hubName()]) {
      const r = await hub.gateway.call(session, "machine_exec", { machine: name, command: "git fetch https://github.com/legostin/piomio.git main" });
      expect(r.isError, name).toBe(true);
      expect(text(r), name).toMatch(/the hub's own computer/);
      expect(text(r), name).not.toMatch(/not found/);
    }
  });
});
