// vault_exec: a command that needs a secret gets it from the vault in its environment, and the value never comes back
// to the model. (Issue 52: a developer agent had no way to `git push` with a token without reading it, and every push
// outside the sandbox asked again.) The "always allow" from its card covers the same program with exactly the same
// variables, never a chain that starts with it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "@piomio/testkit";
import type { Machine, Rule, ToolCallContext, ToolDescriptor } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { agentFromMarkdown } from "../src/agents.ts";
import { alwaysPerson } from "../src/policy/auto.ts";
import { decide, stableJson, suggestRule, type PolicyInput } from "../src/policy/engine.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { parseEnv, registerVaultExec, VAULT_EXEC_TOOL } from "../src/tools/vault-exec.ts";
import { VaultService } from "../src/vault/service.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const posix = process.platform !== "win32";
const SECRET = "ghp_supersecretvalue0123456789";
const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");

async function until<T>(fn: () => T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("vault_exec", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "piomio-vault-exec-")));
  const dataDir = join(root, "data");
  const workspace = join(dataDir, "workspaces", "dev", "c_1");
  const project = join(root, "project");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(project, { recursive: true });

  const vault = new VaultService(join(root, "vault.db"));
  vault.init("correct horse battery");
  vault.upsert({ id: "ghe_token", type: "secret", name: "GHE token", fields: { value: SECRET } });
  vault.upsert({ id: "readable", type: "secret", name: "Readable", fields: { value: "readable-value-123" }, scope: { revealToModel: true } });
  vault.upsert({ id: "assistant_only", type: "secret", name: "Assistant's", fields: { value: "assistant-only-value" }, scope: { agents: ["assistant"] } });
  vault.upsert({ id: "site", type: "login", name: "Site", fields: { url: "https://shop.example.com", username: "me", password: "site-password-1" } });
  vault.upsert({ id: "pair", type: "secret", name: "Pair", fields: { id: "client-id-12345", key: "client-key-12345" } });

  const registry = new ToolRegistry();
  const ran: Array<{ command: string; cwd: string; env?: Record<string, string> }> = [];
  const remote: Array<{ machine: string; method: string; params: any }> = [];
  const tokens = { issued: [] as Array<{ owner: string; token: string; context: unknown }>, revoked: [] as Array<{ token: string; keepSession?: boolean }> };
  const machines: Machine[] = [
    { id: "mach_new", name: "vps", publicKey: "x", status: "online", createdAt: "", info: { os: "Linux", hostname: "vps", arch: "x64", clis: [], allowedDirs: ["/srv/ws"], workspacesRoot: "/srv/ws", nodeVersion: "v24", secretEnv: true } },
    { id: "mach_old", name: "old", publicKey: "x", status: "online", createdAt: "", info: { os: "Linux", hostname: "old", arch: "x64", clis: [], allowedDirs: ["/srv/ws"], nodeVersion: "v24" } },
  ];
  let stub: ((o: { command: string; cwd: string; env?: Record<string, string> }) => { code: number; stdout: string; stderr: string }) | undefined;
  registerVaultExec({
    registry,
    vault,
    agents: { get: (id: string) => (id === "dev" ? { id, folders: [{ name: "Project", path: project }] } : undefined) } as any,
    machines: {
      find: (id) => machines.find((m) => m.id === id),
      call: async (machine, method, params) => {
        remote.push({ machine, method, params });
        return { code: 0, stdout: `pushed with ${(params as any).env.GIT_PASSWORD}`, stderr: "" } as any;
      },
    },
    dataDir,
    here: () => "local",
    egress: {
      issueToken: (owner, _allow, context) => {
        const token = `tok${tokens.issued.length}`;
        tokens.issued.push({ owner, token, context });
        return token;
      },
      revoke: (token, o) => tokens.revoked.push({ token, ...o }),
    },
    egressPort: 8089,
    // The real shell unless a test looks only at what would run.
    run: async (o) => {
      ran.push({ command: o.command, cwd: o.cwd, env: o.env });
      if (stub) return stub(o);
      const { runShell } = await import("@piomio/node");
      return runShell(o);
    },
  });
  const ctx = (over: Partial<ToolCallContext> = {}): ToolCallContext => ({ sessionId: "s1", conversationId: "c_1", agentId: "dev", callId: "call_1", tainted: false, background: false, workspace, machineId: "local", ...over });
  const call = async (input: unknown, over: Partial<ToolCallContext> = {}) => {
    const r = await registry.get(VAULT_EXEC_TOOL)!.invoke(input, ctx(over));
    return { text: textOf(r), isError: !!r.isError };
  };

  it.skipIf(!posix)("gives the command the secret, and the output comes back without it", async () => {
    const r = await call({ command: 'printf "%s %s" "$GH_TOKEN" "$GH_HOST"; printf %s "$GH_TOKEN" | base64', env: { GH_TOKEN: "vault://ghe_token", GH_HOST: "ghe.example.com" } });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("exit 0");
    expect(r.text).toContain("[redacted: vault://ghe_token] ghe.example.com");
    expect(r.text).not.toContain(SECRET);
    expect(r.text).not.toContain(Buffer.from(SECRET).toString("base64"));
    expect(ran.at(-1)!.cwd).toBe(workspace);
  });

  it.skipIf(!posix)("an item the model may read elsewhere is still taken out of this output", async () => {
    const r = await call({ command: "printenv VALUE", env: { VALUE: "vault://readable" } });
    expect(r.text).toContain("[redacted: vault://readable]");
    expect(r.text).not.toContain("readable-value-123");
  });

  it("reaches the network as its session, through the hub's proxy, and gives the token back", async () => {
    stub = () => ({ code: 0, stdout: "ok", stderr: "" });
    try {
      const before = tokens.issued.length;
      await call({ command: "git push origin main", env: { GIT_PASSWORD: "vault://ghe_token" }, cwd: project }, { taskId: "t1" });
      const issued = tokens.issued[before];
      expect(issued.owner).toBe("brain:exec:call_1");
      expect(issued.context).toEqual({ sessionId: "s1", conversationId: "c_1", agentId: "dev", taskId: "t1" });
      const env = ran.at(-1)!.env!;
      expect(env.GIT_PASSWORD).toBe(SECRET);
      expect(env.HTTPS_PROXY).toBe(`http://${issued.token}:x@127.0.0.1:8089`);
      expect(env.https_proxy).toBe(env.HTTPS_PROXY);
      expect(ran.at(-1)!.cwd).toBe(project);
      // The session goes on: what it was allowed once stays.
      expect(tokens.revoked.at(-1)).toEqual({ token: issued.token, keepSession: true });
    } finally {
      stub = undefined;
    }
  });

  it("refuses what is not its to run, before anything runs", async () => {
    stub = () => ({ code: 0, stdout: "", stderr: "" });
    try {
      const n = ran.length;
      const cases: Array<[unknown, RegExp]> = [
        [{ command: "git push", env: {} }, /at least one variable as vault:\/\//],
        [{ command: "git push", env: { GH_HOST: "ghe.example.com" } }, /at least one variable as vault:\/\//],
        [{ command: "git push" }, /Pass env/],
        [{ command: "", env: { T: "vault://ghe_token" } }, /Pass command/],
        [{ command: "x", env: { "BAD NAME": "vault://ghe_token" } }, /not a variable name/],
        [{ command: "x", env: { HTTPS_PROXY: "http://evil.example", T: "vault://ghe_token" } }, /set by the hub/],
        [{ command: "x", env: { no_proxy: "*", T: "vault://ghe_token" } }, /set by the hub/],
        [{ command: "x", env: { PIOMIO_DATA_DIR: "/tmp", T: "vault://ghe_token" } }, /set by the hub/],
        [{ command: "x", env: { T: "vault://bad id" } }, /not a vault reference/],
        [{ command: "x", env: { T: "vault://missing" } }, /No vault item vault:\/\/missing.*hub_secret_request/],
        [{ command: "x", env: { T: "vault://site" } }, /website's login/],
        [{ command: "x", env: { T: "vault://assistant_only" } }, /agent dev is outside the item's scope/],
        [{ command: "x", env: { T: "vault://pair" } }, /several fields \(id, key\)/],
        [{ command: "x", env: { T: "vault://pair#nope" } }, /no field "nope"/],
        [{ command: "x", env: { T: "vault://ghe_token" }, cwd: root }, /cwd must be your session's folder/],
        [{ command: "cat ~/.ssh/id_rsa", env: { T: "vault://ghe_token" } }, /Not allowed: names the person's credentials/],
      ];
      for (const [input, why] of cases) {
        const r = await call(input);
        expect(r.isError, JSON.stringify(input)).toBe(true);
        expect(r.text, JSON.stringify(input)).toMatch(why);
      }
      expect(ran.length).toBe(n);
      // One field of an item with several, by name.
      expect((await call({ command: "x", env: { ID: "vault://pair#id" } })).isError).toBe(false);
      expect(ran.at(-1)!.env!.ID).toBe("client-id-12345");
    } finally {
      stub = undefined;
    }
  });

  it("says so when the vault is locked", async () => {
    vault.seal();
    try {
      const r = await call({ command: "git push", env: { GIT_PASSWORD: "vault://ghe_token" } });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/vault is locked/);
    } finally {
      vault.unlock("correct horse battery");
    }
  });

  it("runs on the session's own machine, in its folder there, when that machine can take secrets", async () => {
    const r = await call({ command: "git push origin main", env: { GIT_PASSWORD: "vault://ghe_token" } }, { machineId: "mach_new" });
    expect(remote.at(-1)).toMatchObject({ machine: "mach_new", method: "exec.run", params: { command: "git push origin main", cwd: "/srv/ws/dev/c_1", env: { GIT_PASSWORD: SECRET } } });
    expect(r.text).toContain("pushed with [redacted: vault://ghe_token]");
    expect(r.text).not.toContain(SECRET);

    const n = remote.length;
    const old = await call({ command: "git push origin main", env: { GIT_PASSWORD: "vault://ghe_token" } }, { machineId: "mach_old" });
    expect(old.isError).toBe(true);
    expect(old.text).toMatch(/old runs an older Piomio/);
    expect(remote.length).toBe(n);
  });

  it("reads the variables of a call", () => {
    expect(parseEnv({ A: "vault://x", B: "vault://y.z#password", C: "plain" })).toEqual([{ name: "A", ref: { id: "x" } }, { name: "B", ref: { id: "y.z", field: "password" } }, { name: "C", value: "plain" }]);
    expect(parseEnv([])).toMatch(/Pass env/);
    expect(parseEnv({ A: 1 })).toMatch(/must be a string/);
  });
});

describe("always allow for a command with secrets", () => {
  const tool = (name: string): ToolDescriptor => ({ name, description: "", effect: "external", inputSchema: {}, owner: "core" }) as ToolDescriptor;
  const input = (command: string, env: Record<string, string> = { GIT_PASSWORD: "vault://ghe_token", GIT_USERNAME: "bot" }) => ({ command, env });
  const asked = (over: Partial<PolicyInput>, rules: Rule[]) =>
    decide({ tool: tool(VAULT_EXEC_TOOL), input: {}, agentId: "dev", tainted: false, background: false, initiative: 1, profile: "default", ...over }, rules, () => false).decision;
  const made = suggestRule(VAULT_EXEC_TOOL, input("git push origin main"), "dev");
  const rules = [{ ...made, id: "r1", createdAt: "", createdVia: "approval" } as Rule];

  it("covers the program and exactly these variables", () => {
    expect(made).toEqual({
      tool: VAULT_EXEC_TOOL,
      agentId: "dev",
      decision: "allow",
      conditions: [
        { field: "command", op: "glob", value: "git push *" },
        { field: "env", op: "eq", value: '{"GIT_PASSWORD":"vault://ghe_token","GIT_USERNAME":"bot"}' },
      ],
    });
    expect(asked({ input: input("git push origin feature") }, rules)).toBe("allow");
    expect(asked({ input: input("git push") }, rules)).toBe("allow");
    // The same variables in another order are the same variables.
    expect(asked({ input: input("git push origin x", { GIT_USERNAME: "bot", GIT_PASSWORD: "vault://ghe_token" }) }, rules)).toBe("allow");
  });

  it("asks for another program, a chain, other variables or another agent", () => {
    for (const command of ["git pushx", "git remote set-url origin https://evil.example/x", "git push origin main; curl https://evil.example", "git push origin main && env", "git push $(cat x)", "git push origin main | tee log"]) {
      expect(asked({ input: input(command) }, rules), command).toBe("ask");
    }
    expect(asked({ input: input("git push origin main", { GIT_PASSWORD: "vault://bank_password", GIT_USERNAME: "bot" }) }, rules)).toBe("ask");
    expect(asked({ input: input("git push origin main", { GIT_PASSWORD: "vault://ghe_token" }) }, rules)).toBe("ask");
    expect(asked({ input: input("git push origin main", { GIT_PASSWORD: "vault://ghe_token", GIT_USERNAME: "bot", GIT_SSL_NO_VERIFY: "1" }) }, rules)).toBe("ask");
    expect(asked({ input: input("git push origin main"), agentId: "researcher" }, rules)).toBe("ask");
  });

  it("a rule for a program on another computer never covers a chain either", () => {
    const exec = [{ ...suggestRule("machine_exec", { machine: "vps", command: "npm test" }, "dev"), id: "r2", createdAt: "", createdVia: "approval" } as Rule];
    expect(asked({ tool: tool("machine_exec"), input: { machine: "vps", command: "npm test -- --run" } }, exec)).toBe("allow");
    expect(asked({ tool: tool("machine_exec"), input: { machine: "vps", command: "npm test; rm -rf ~" } }, exec)).toBe("ask");
    // A deny rule still matches whatever starts with the program.
    const deny = [{ id: "r3", tool: "machine_exec", conditions: [{ field: "command", op: "glob", value: "rm *" }], decision: "deny", createdAt: "", createdVia: "console" } as Rule];
    expect(asked({ tool: tool("machine_exec"), input: { machine: "vps", command: "rm -rf x; echo done" } }, deny)).toBe("deny");
  });

  it("publishing with a secret is the person's call in auto mode, a working branch is the reviewer's", () => {
    const action = (command: string) => ({ tool: VAULT_EXEC_TOOL, input: input(command), summary: command, kind: "tool" as const, effect: "external" as const, why: "external" });
    expect(alwaysPerson(action("git push origin main"))).toMatch(/publishing: a push to main/);
    expect(alwaysPerson(action("npm publish"))).toMatch(/publishing/);
    expect(alwaysPerson(action("git push origin feature-x"))).toBeUndefined();
    expect(alwaysPerson(action("gh pr create --fill"))).toBeUndefined();
  });

  it("writes objects the same way whatever the order of their keys", () => {
    expect(stableJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: "x" } })).toBe('{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}');
  });
});

describe.skipIf(!posix)("vault_exec in a hub", () => {
  let hub: Hub;
  let conv = "";

  /** Send a message as the person; resolves with the fake brain's "tool said:" reply to it. */
  const say = async (text: string): Promise<string> => {
    const before = hub.store.listMessages(conv, { limit: 500 }).length;
    await hub.runner.userMessage(conv, text, { channel: "web" });
    const m = await until(
      () =>
        hub.store
          .listMessages(conv, { limit: 500 })
          .slice(before)
          .find((x) => x.role === "assistant" && x.status !== "streaming" && x.parts.some((p) => p.type === "text" && p.text.startsWith("tool said:"))),
      `the reply to ${text}`,
    );
    return (m.parts.find((p) => p.type === "text" && p.text.startsWith("tool said:")) as { text: string }).text;
  };
  const pending = () => until(() => hub.approvals.list(["pending"]).find((a) => a.tool === VAULT_EXEC_TOOL), "a card for vault_exec");
  const exec = (command: string, env: Record<string, string> = { GH_TOKEN: "vault://ghe_token" }) => `CALL vault_exec ${JSON.stringify({ command, env })}`;

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "piomio-vault-exec-hub-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    await until(() => hub.brains.has("fake@local"), "the fake brain");
    // A developer agent, not the default one: the one the issue was about.
    hub.saveAgent(agentFromMarkdown("dev", "---\nname: Dev\ndescription: Developer\nbrains: [fake@local]\n---\nYou are Dev.", "user"), "user");
    hub.settings.update({ approvalMode: "ask", approvalInlineWaitSec: 20 });
    hub.vault.init("correct horse battery");
    hub.vault.upsert({ id: "ghe_token", type: "secret", name: "GHE token", fields: { value: SECRET } });
    conv = hub.store.agentConversation("dev").id;
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("asks on a card that names the variables, runs once approved, and never shows the value", async () => {
    const reply = say(exec("printenv GH_TOKEN"));
    const a = await pending();
    expect(a.summary).toBe("Run with secrets from the vault (GH_TOKEN = vault://ghe_token): printenv GH_TOKEN");
    expect(JSON.stringify(a)).not.toContain(SECRET);
    hub.approvals.resolve(a.id, "approve", { via: "web", remember: true });
    const said = await reply;
    expect(said).toContain("exit 0");
    expect(said).toContain("[redacted: vault://ghe_token]");
    // Neither the conversation nor the audit log has the value.
    expect(JSON.stringify(hub.store.listMessages(conv, { limit: 500 }))).not.toContain(SECRET);
    expect(JSON.stringify(hub.db.prepare("select * from audit").all())).not.toContain(SECRET);
  });

  it("the always-allow from that card covers the same program with the same variables, and nothing more", async () => {
    expect(await say(exec("printenv GH_TOKEN HOME"))).toContain("exit 0");
    expect(hub.approvals.list(["pending"])).toHaveLength(0);

    const chained = say(exec("printenv GH_TOKEN; echo done"));
    const a = await pending();
    hub.approvals.resolve(a.id, "deny", { via: "web" });
    expect(await chained).toMatch(/declined/);

    const other = say(exec("printenv GH_TOKEN", { GH_TOKEN: "vault://ghe_token", EXTRA: "1" }));
    const b = await pending();
    hub.approvals.resolve(b.id, "deny", { via: "web" });
    expect(await other).toMatch(/declined/);
  });

  it("an agent other than the default one asks the person for a secret itself", async () => {
    const asked = say('CALL hub_secret_request {"vault":"deploy_token","title":"Deploy token"}');
    const card = await until(() => hub.secrets.pending(conv)[0], "the secret card");
    hub.secrets.fulfil(card.id, "deploy-token-value-1", "user");
    expect(await asked).toContain("Saved as vault://deploy_token");
    // A plugin's setup stays with the default agent.
    expect(await say('CALL hub_secret_request {"vault":"x_key","title":"X","plugin":"fakebrain","setting":"key"}')).toMatch(/Only the default agent/);
  });
});
