import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainEvent, BrainSessionOptions } from "@piomio/shared";
import { connectionToolPrefix } from "@piomio/shared";
import { claudeConnectionArgs, codexToolName, createClaudeCodeProvider, createCodexProvider, CodexStreamParser, knownFile, parseClaudeStatus, parseCodexList, readKnown } from "../src/index.ts";
import { approvalAnswer, CodexAppParser } from "../src/codex-app.ts";
import { isolationConfig } from "../src/codex-isolation.ts";

const fakeClaude = join(import.meta.dirname, "fixtures", "fake-claude.mjs");
const fakeCodex = join(import.meta.dirname, "fixtures", "fake-codex.mjs");

function opts(over: Partial<BrainSessionOptions> = {}): BrainSessionOptions {
  return {
    sessionId: "s_" + Math.random().toString(36).slice(2),
    agent: {} as any,
    workspace: mkdtempSync(join(tmpdir(), "owl-conn-ws-")),
    mcp: { url: "http://127.0.0.1:1/mcp", token: "tok-secret", bridgeCommand: ["node", "bridge.ts"] },
    systemPrompt: "SYSTEM",
    env: {},
    background: false,
    ...over,
  };
}

async function collect(it: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

/** What Claude Code answers to `mcp_status` (v2.1.323), trimmed. */
const STATUS = [
  { name: "piomio", status: "connected", scope: "dynamic", config: { type: "stdio", command: "node", args: ["bridge.ts"] } },
  { name: "blender", status: "connected", scope: "user", source: "user", config: { type: "stdio", command: "uvx", args: ["blender-mcp", "--key", "s3cret"] }, tools: [{ name: "get_scene_info", annotations: { readOnly: true } }, { name: "execute_blender_code", annotations: {} }] },
  { name: "claude.ai Gmail", status: "connected", scope: "claudeai", source: "claudeai", config: { type: "claudeai-proxy", url: "https://gmailmcp.googleapis.com/mcp/v1", id: "x" }, tools: [{ name: "search_threads", annotations: { readOnly: true } }, { name: "send_message", annotations: {} }] },
  { name: "claude.ai Linear", status: "connected", scope: "claudeai", source: "claudeai", config: { type: "claudeai-proxy", url: "https://mcp.linear.app/mcp", id: "y" }, tools: [] },
  { name: "linear-server", status: "needs-auth", scope: "user", source: "user", config: { type: "http", url: "https://mcp.linear.app/mcp" } },
  { name: "plugin:runpod:runpod", status: "failed", error: "ECONNREFUSED", scope: "dynamic", source: "plugin", config: { type: "http", url: "https://mcp.getrunpod.io/" } },
  { name: "ide", status: "connected", scope: "dynamic", config: { type: "sdk" } },
];

describe("Claude Code's own connections", () => {
  it("reads what the CLI is connected to: names, where from, state, tools that only read", () => {
    const { connections, known } = parseClaudeStatus(STATUS);
    // The hub's own server is not one of them, nor a server with no command or address to let in.
    expect(connections.map((c) => c.name)).toEqual(["blender", "claude.ai Gmail", "claude.ai Linear", "linear-server", "plugin:runpod:runpod"]);
    expect(connections[0]).toEqual({ name: "blender", source: "config", status: "connected", tools: ["get_scene_info", "execute_blender_code"], readTools: ["get_scene_info"] });
    expect(connections[1]).toMatchObject({ source: "account", status: "connected", readTools: ["search_threads"] });
    expect(connections[3]).toEqual({ name: "linear-server", source: "config", status: "signin" });
    expect(connections[4]).toEqual({ name: "plugin:runpod:runpod", source: "plugin", status: "failed", detail: "ECONNREFUSED" });
    expect(known[0]).toEqual({ name: "blender", command: ["uvx", "blender-mcp", "--key", "s3cret"], readTools: ["get_scene_info"] });
    expect(known[1]).toEqual({ name: "claude.ai Gmail", url: "https://gmailmcp.googleapis.com/mcp/v1", readTools: ["search_threads"] });
  });

  it("names a connection's tools as the CLI does", () => {
    expect(connectionToolPrefix("claude.ai Gmail")).toBe("mcp__claude_ai_Gmail");
    expect(connectionToolPrefix("plugin:runpod:runpod")).toBe("mcp__plugin_runpod_runpod");
  });

  it("lets in exactly what is on: by command or address, the rest refused by name", () => {
    const { known } = parseClaudeStatus(STATUS);
    const a = claudeConnectionArgs(["claude.ai Linear", "blender", "never-seen"], known, ["node", "bridge.ts"])!;
    expect(a.settings.allowedMcpServers).toEqual([{ serverCommand: ["node", "bridge.ts"] }, { serverCommand: ["uvx", "blender-mcp", "--key", "s3cret"] }, { serverUrl: "https://mcp.linear.app/mcp" }]);
    // linear-server has the allowed connector's address: its name keeps it out.
    expect(a.settings.deniedMcpServers).toEqual([{ serverName: "claude.ai Gmail" }, { serverName: "linear-server" }, { serverName: "plugin:runpod:runpod" }]);
    expect(a.tools).toEqual(["mcp__blender__get_scene_info"]);
    // Nothing known of what is on: the hub's tools alone.
    expect(claudeConnectionArgs(["never-seen"], known, ["node", "bridge.ts"])).toBeUndefined();
  });

  it("asks the CLI without a turn, keeps commands and addresses on this computer, and starts sessions with what is on", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "owl-conn-state-"));
    const provider = createClaudeCodeProvider({ command: () => fakeClaude, stateDir, connectionsTiming: { pollMs: 20, settleMs: 0, timeoutMs: 5000 } });
    const listed = await provider.connections!({ env: { FAKE_MCP_STATUS: JSON.stringify(STATUS) } });
    expect(listed.map((c) => c.name)).toContain("claude.ai Gmail");
    // The hub gets no command line (it may carry a key); this computer keeps it in a private file.
    expect(JSON.stringify(listed)).not.toContain("s3cret");
    expect(readKnown(knownFile(stateDir)).find((k) => k.name === "blender")?.command).toContain("s3cret");
    if (process.platform !== "win32") expect(statSync(knownFile(stateDir)).mode & 0o777).toBe(0o600);

    const run = async (over: Partial<BrainSessionOptions>): Promise<string[]> => {
      const file = join(mkdtempSync(join(tmpdir(), "owl-conn-args-")), "args.jsonl");
      await collect((await provider.createSession(opts({ ...over, env: { FAKE_ARGS_FILE: file } }))).send({ text: "hi" }));
      return JSON.parse(readFileSync(file, "utf8").trim().split("\n")[0]) as string[];
    };
    const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

    // Nothing on: the hub's server alone, as before.
    expect(await run({})).toContain("--strict-mcp-config");
    expect(await run({ connections: ["never-seen"] })).toContain("--strict-mcp-config");

    const on = await run({ connections: ["claude.ai Gmail"] });
    expect(on).not.toContain("--strict-mcp-config");
    const settings = JSON.parse(readFileSync(after(on, "--settings"), "utf8"));
    expect(settings.allowedMcpServers).toEqual([{ serverCommand: ["node", "bridge.ts"] }, { serverUrl: "https://gmailmcp.googleapis.com/mcp/v1" }]);
    expect(settings.deniedMcpServers).toContainEqual({ serverName: "blender" });
    // Reading is free; sending is not on the list, so it asks (or is refused with nobody to ask).
    expect(after(on, "--allowedTools").split(",")).toContain("mcp__claude_ai_Gmail__search_threads");
    expect(after(on, "--allowedTools")).not.toContain("send_message");

    // Confined: one settings file holds the sandbox and the connections; the read tools stay free.
    const confined = await run({ connections: ["blender"], confine: { denyRead: ["/x"], allowRead: [], permissionTool: "native_permission" } });
    expect(confined.filter((a) => a === "--settings")).toHaveLength(1);
    const both = JSON.parse(readFileSync(after(confined, "--settings"), "utf8"));
    expect(both.sandbox.enabled).toBe(true);
    expect(both.allowedMcpServers).toContainEqual({ serverCommand: ["uvx", "blender-mcp", "--key", "s3cret"] });
    expect(after(confined, "--allowedTools").split(",")).toEqual(["WebSearch", "TodoWrite", "Task", "Skill", "mcp__piomio", "mcp__blender__get_scene_info"]);

    // The reviewer's bare session never gets them.
    expect(await run({ bare: true, connections: ["claude.ai Gmail"] })).toContain("--strict-mcp-config");
  });
});

describe("Codex's own MCP servers", () => {
  const LIST = JSON.stringify([
    { name: "piomio", enabled: true, auth_status: "unsupported" },
    { name: "jev-browser", enabled: true, auth_status: "unsupported" },
    { name: "computer-use", enabled: false, auth_status: "unsupported" },
    { name: "notion", enabled: true, auth_status: "not_logged_in" },
    { name: "odd.name", enabled: true },
  ]);

  it("lists what Codex has set up", async () => {
    expect(parseCodexList(LIST)).toEqual([
      { name: "jev-browser", source: "config", status: "unknown" },
      { name: "computer-use", source: "config", status: "off" },
      { name: "notion", source: "config", status: "signin" },
    ]);
    expect(parseCodexList("not json")).toEqual([]);
    const codex = createCodexProvider({ command: () => fakeCodex, stateDir: mkdtempSync(join(tmpdir(), "owl-conn-cx-")) });
    expect((await codex.connections!({ env: { FAKE_CODEX_MCP: LIST } })).map((c) => c.name)).toEqual(["jev-browser", "computer-use", "notion"]);
  });

  it("keeps the servers turned on, asking before they change something; the rest stay off", () => {
    const home = mkdtempSync(join(tmpdir(), "owl-conn-codex-home-"));
    writeFileSync(join(home, "config.toml"), '[mcp_servers.jev-browser]\ncommand = "node"\n\n[mcp_servers.unityMCP]\nurl = "http://127.0.0.1:1"\n');
    expect(isolationConfig({ CODEX_HOME: home })).toEqual(["features.plugins=false", "features.apps=false", "mcp_servers.jev-browser.enabled=false", "mcp_servers.unityMCP.enabled=false"]);
    expect(isolationConfig({ CODEX_HOME: home }, ["jev-browser", "not-there"])).toEqual([
      "features.plugins=false",
      "features.apps=false",
      'mcp_servers.jev-browser.default_tools_approval_mode="writes"',
      "mcp_servers.unityMCP.enabled=false",
    ]);
  });

  it("names a connection's calls so the hub can tell them from its own tools", () => {
    expect(codexToolName("piomio", "notify")).toBe("notify");
    expect(codexToolName("jev-browser", "jev_act")).toBe("mcp__jev-browser__jev_act");
    expect(new CodexStreamParser().push({ type: "item.started", item: { type: "mcp_tool_call", id: "m", server: "notion", tool: "search", arguments: {} } })).toEqual([{ type: "tool_call", id: "m", name: "mcp__notion__search", input: {} }]);
    expect(new CodexAppParser().push("item/started", { item: { type: "mcpToolCall", id: "m", server: "piomio", tool: "notify", arguments: {} } })).toEqual([{ type: "tool_call", id: "m", name: "notify", input: {} }]);
  });

  it("sends a connection's approval request to the hub and answers Codex in kind", async () => {
    const asked: Array<{ tool: string; input: unknown }> = [];
    const connection = (allow: boolean) => ({
      ask: async (tool: string, input: Record<string, unknown>) => (asked.push({ tool, input }), { allow, ...(allow ? {} : { message: "The person said no." }) }),
      call: (server: string) => (server === "notion" ? { tool: "create_page", input: { title: "from the item" } } : undefined),
    });
    const params = { threadId: "t", turnId: "u", serverName: "notion", mode: "form", message: "Allow?", requestedSchema: {}, _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { title: "Plan" } } };
    expect(await approvalAnswer("mcpServer/elicitation/request", params, undefined, undefined, connection(true))).toEqual({ action: "accept", content: {}, _meta: null });
    expect(asked).toEqual([{ tool: "mcp__notion__create_page", input: { title: "Plan" } }]);
    let why = "";
    expect(await approvalAnswer("mcpServer/elicitation/request", params, undefined, (w) => (why = w), connection(false))).toEqual({ action: "decline", content: null, _meta: null });
    expect(why).toBe("The person said no.");
    // Nobody to ask, or a form nobody here can fill in: declined.
    expect(await approvalAnswer("mcpServer/elicitation/request", params)).toEqual({ action: "decline", content: null, _meta: null });
    expect(await approvalAnswer("mcpServer/elicitation/request", { ...params, _meta: null }, undefined, undefined, connection(true))).toEqual({ action: "decline", content: null, _meta: null });
    expect(asked).toHaveLength(2);
  });
});
