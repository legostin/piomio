import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainSessionOptions } from "@piomio/shared";
import { createClaudeCodeProvider, createCodexProvider } from "../src/index.ts";
import { confinedNetwork, confinedProxyEnv } from "../src/network.ts";

const proxy = "http://test-credential:x@127.0.0.1:41789";
// The authenticated hub decides destinations live; the sandbox must forward unknown hosts to it.
const domains = ["*"];
function options(): BrainSessionOptions {
  return {
    sessionId: "network-test", agent: {} as any, workspace: mkdtempSync(join(tmpdir(), "brain-network-ws-")),
    mcp: { url: "http://127.0.0.1:1/mcp", token: "test", bridgeCommand: ["node", "bridge.ts"] },
    systemPrompt: "SYSTEM", background: false,
    env: { HTTPS_PROXY: proxy, ALL_PROXY: "socks5://stale.example:1", no_proxy: "*" },
    confine: { denyRead: ["/private-hub", "/Users/test/.ssh"], allowRead: [], permissionTool: "native_permission", network: { allowedDomains: domains } },
  };
}

describe("confined brain networking", () => {
  it("uses only an explicit hub grant and an authenticated loopback upstream; secrets never enter errors", () => {
    const o = options();
    expect(confinedNetwork(o)?.allowedDomains).toEqual(domains);
    for (const bad of ["", "http://127.0.0.1:41789", "https://test-secret:x@evil.example:443", "http://test-secret:x@127.0.0.1:41789/path"]) {
      o.env.HTTPS_PROXY = bad;
      expect(() => confinedNetwork(o)).toThrow("requires the hub's authenticated loopback");
      try { confinedNetwork(o); } catch (e) { expect(String(e)).not.toContain("test-secret"); }
    }
    delete o.confine!.network;
    expect(confinedNetwork(o)).toBeUndefined();
  });

  it("replaces stale proxy aliases and proxy bypass lists without opening front desks or bare reviewers", () => {
    const o = options();
    const env = { ...o.env, ...confinedProxyEnv(o) };
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) expect(env[k]).toBe(proxy);
    expect(env.no_proxy).toBe("127.0.0.1,localhost,::1");
    expect(confinedNetwork({ ...o, frontDesk: true })).toBeUndefined();
    expect(confinedNetwork({ ...o, bare: true })).toBeUndefined();
    expect(confinedProxyEnv({ ...o, confine: undefined })).toEqual({});
  });

  it("Claude keeps its sandbox proxy, chains upstream and reviews networked Bash through the hub", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "claude-network-"));
    const o = options();
    const file = join(stateDir, "args.jsonl");
    o.env.FAKE_ARGS_FILE = file;
    const provider = createClaudeCodeProvider({ command: () => join(import.meta.dirname, "fixtures/fake-claude.mjs"), stateDir });
    const session = await provider.createSession(o);
    for await (const _ of session.send({ text: "hi" })) { /* collect until the fake CLI exits */ }
    const args = JSON.parse(readFileSync(file, "utf8").trim().split("\n")[0]) as string[];
    const settings = JSON.parse(readFileSync(args[args.indexOf("--settings") + 1], "utf8"));
    expect(settings.sandbox.network).toEqual({ allowedDomains: domains, strictAllowlist: true });
    expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false });
    expect(settings.sandbox.filesystem.denyRead).toContain("/Users/test/.ssh");
    expect(args[args.indexOf("--permission-prompt-tool") + 1]).toBe("mcp__piomio__native_permission");
    expect(JSON.stringify(settings)).not.toContain("test-credential");
  });

  it("Codex tasks keep command networking off: a networked command asks the hub to leave the sandbox", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-network-"));
    const o = options();
    const file = join(stateDir, "args.jsonl");
    o.env.FAKE_ARGS_FILE = file;
    const provider = createCodexProvider({ command: () => join(import.meta.dirname, "fixtures/fake-codex.mjs"), stateDir });
    const session = await provider.createSession(o);
    for await (const _ of session.send({ text: "hi" })) { /* collect */ }
    const started = JSON.parse(readFileSync(file, "utf8").trim().split("\n")[0]);
    expect(started.sandbox).toBeUndefined(); // a thread sandbox would override the permission profile
    // Codex rejects "untrusted" at start-up ("no longer supported"), so no session may name it.
    expect(started.approvalPolicy).toBe("on-request");
    expect(started.args).toContain('approval_policy="on-request"');
    expect(started.args).toContain("permissions.piomio.network.enabled=false");
    expect(started.args).not.toContain("features.network_proxy=true");
    expect(JSON.stringify(started)).not.toContain("untrusted");
    expect(JSON.stringify(started)).not.toContain("test-credential");
  });

  it("Codex front desks keep networking off even if the hub supplied the same allowlist", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-offline-"));
    const o = options();
    o.frontDesk = true;
    const file = join(stateDir, "args.jsonl");
    o.env.FAKE_ARGS_FILE = file;
    const provider = createCodexProvider({ command: () => join(import.meta.dirname, "fixtures/fake-codex.mjs"), stateDir });
    for await (const _ of (await provider.createSession(o)).send({ text: "hi" })) { /* collect */ }
    const started = JSON.parse(readFileSync(file, "utf8").trim().split("\n")[0]);
    expect(started.approvalPolicy).toBe("never");
    expect(started.args).toContain("permissions.piomio.network.enabled=false");
    expect(started.args).not.toContain("features.network_proxy=true");
  });

  it("legacy codex exec stays offline instead of granting unrestricted network_access", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-legacy-network-"));
    const o = options();
    const file = join(stateDir, "args.jsonl");
    Object.assign(o.env, { FAKE_ARGS_FILE: file, FAKE_CODEX_NO_APP: "1" });
    const provider = createCodexProvider({ command: () => join(import.meta.dirname, "fixtures/fake-codex.mjs"), stateDir });
    for await (const _ of (await provider.createSession(o)).send({ text: "hi" })) { /* collect */ }
    const started = JSON.parse(readFileSync(file, "utf8").trim().split("\n")[0]);
    expect(started.args[0]).toBe("exec");
    expect(started.args).toContain("sandbox_workspace_write.network_access=false");
    expect(started.args).not.toContain("features.network_proxy=true");
  });
});
