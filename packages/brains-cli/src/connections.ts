// The CLIs' own connections (shared BrainConnection): what the person connected in Claude Code or Codex itself. A
// session gets the hub's tools alone unless the person turned some of these on for agents; then it gets exactly those.
// Their commands and addresses may carry keys, so they stay on this computer (a private file in the provider's state
// folder): the hub knows the names only.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrainConnection } from "@piomio/shared";
import { connectionToolPrefix } from "@piomio/shared";
import { capture, runLines } from "./proc.ts";

/** The hub's own MCP server in every session: never one of the person's connections. */
export const HUB_SERVER = "piomio";

/** What this computer keeps about a connection to let it into a session. */
export interface KnownConnection {
  name: string;
  /** A local server: its exact command line. */
  command?: string[];
  /** A remote one: its address. */
  url?: string;
  /** Its tools that only read. */
  readTools: string[];
}

export function readKnown(file: string): KnownConnection[] {
  if (!existsSync(file)) return [];
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(j) ? j.filter((k) => k && typeof k.name === "string" && Array.isArray(k.readTools)) : [];
  } catch {
    return [];
  }
}

export function writeKnown(file: string, known: KnownConnection[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(known), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
}

// ---------- Claude Code ----------

const CLAUDE_STATUS: Record<string, BrainConnection["status"]> = { connected: "connected", "needs-auth": "signin", failed: "failed", disabled: "off" };

/** Claude Code's answer to `mcp_status`, as connections and what it takes to let each into a session. */
export function parseClaudeStatus(servers: unknown): { connections: BrainConnection[]; known: KnownConnection[] } {
  const connections: BrainConnection[] = [];
  const known: KnownConnection[] = [];
  for (const s of Array.isArray(servers) ? servers : []) {
    if (!s || typeof s.name !== "string" || !s.name || s.name === HUB_SERVER) continue;
    const c = s.config && typeof s.config === "object" ? s.config : {};
    const command = typeof c.command === "string" && c.command ? [c.command, ...(Array.isArray(c.args) ? c.args.map(String) : [])] : undefined;
    const url = typeof c.url === "string" && c.url ? c.url : undefined;
    // Neither a command nor an address (a server inside another program): nothing could let it in by itself.
    if (!command && !url) continue;
    const tools: Array<{ name: string; read: boolean }> = (Array.isArray(s.tools) ? s.tools : [])
      .filter((t: any) => t && typeof t.name === "string")
      .map((t: any) => ({ name: t.name, read: t.annotations?.readOnly === true }));
    const status = CLAUDE_STATUS[String(s.status)] ?? "unknown";
    connections.push({
      name: s.name,
      source: s.scope === "claudeai" ? "account" : s.source === "plugin" || s.scope === "dynamic" ? "plugin" : "config",
      status,
      ...(typeof s.error === "string" && s.error ? { detail: s.error.slice(0, 300) } : {}),
      ...(status === "connected" ? { tools: tools.map((t) => t.name), readTools: tools.filter((t) => t.read).map((t) => t.name) } : {}),
    });
    known.push({ name: s.name, ...(command ? { command } : { url }), readTools: tools.filter((t) => t.read).map((t) => t.name) });
  }
  return { connections, known };
}

export interface ClaudeStatusTiming {
  /** Between two looks at the servers. */
  pollMs?: number;
  /** The least time to give them (the account's connectors arrive after the rest). */
  settleMs?: number;
  /** When to take what is there, some still starting. */
  timeoutMs?: number;
}

/**
 * Ask Claude Code what it is connected to: a run with no prompt (so no model is called), in an empty folder, answering
 * the `mcp_status` control request until its servers have settled. Throws when the CLI does not answer (an old one).
 */
export async function claudeStatus(command: string, env: Record<string, string>, cwd: string, timing: ClaudeStatusTiming = {}): Promise<unknown[]> {
  const pollMs = timing.pollMs ?? 1000;
  const settleMs = timing.settleMs ?? 6000;
  const timeoutMs = timing.timeoutMs ?? 30_000;
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk", "--tools", "", "--no-session-persistence"];
  const proc = runLines(command, args, { cwd, env, keepInput: true });
  const started = Date.now();
  let last: unknown[] | undefined;
  let steady = 0;
  let asked = 0;
  const ask = () => proc.write(`${JSON.stringify({ type: "control_request", request_id: `connections-${++asked}`, request: { subtype: "mcp_status" } })}\n`);
  const timer = setInterval(() => {
    if (Date.now() - started > timeoutMs) proc.child.kill("SIGTERM");
    else ask();
  }, pollMs);
  try {
    ask();
    for await (const line of proc.lines) {
      if (!line.trim().startsWith("{")) continue;
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.type !== "control_response") continue;
      if (m.response?.subtype === "error") throw new Error(String(m.response.error ?? "mcp_status failed"));
      const servers = m.response?.response?.mcpServers;
      if (!Array.isArray(servers)) continue;
      const settled = !servers.some((s: any) => s?.status === "pending");
      steady = settled && last && last.length === servers.length ? steady + 1 : 0;
      last = servers;
      if (settled && steady >= 2 && Date.now() - started >= settleMs) break;
    }
  } finally {
    clearInterval(timer);
    proc.endInput();
    proc.child.kill("SIGTERM");
  }
  if (!last) throw new Error(proc.stderr().trim().split("\n").pop() || "Claude Code did not report its connections");
  return last;
}

/** What a Claude Code session with these connections on is started with. */
export interface ClaudeConnectionArgs {
  /** Session settings: exactly these servers load, whatever else the CLI has (a new one included). */
  settings: { allowedMcpServers: Array<{ serverCommand: string[] } | { serverUrl: string }>; deniedMcpServers: Array<{ serverName: string }> };
  /** Their read-only tools, by full name: allowed without asking. */
  tools: string[];
}

/**
 * The session settings for the connections turned on (`on`, by name) out of the `known` ones, beside the hub's bridge
 * (`bridge`, its command line). Undefined when none of them is known here: the session keeps to the hub's tools.
 */
export function claudeConnectionArgs(on: readonly string[], known: readonly KnownConnection[], bridge: string[]): ClaudeConnectionArgs | undefined {
  const allowed = known.filter((k) => on.includes(k.name));
  if (!allowed.length) return undefined;
  return {
    settings: {
      allowedMcpServers: [{ serverCommand: bridge }, ...allowed.map((k) => (k.command ? { serverCommand: k.command } : { serverUrl: k.url! }))],
      // By name too: another connection may share an allowed one's address (the same service connected twice).
      deniedMcpServers: known.filter((k) => !on.includes(k.name)).map((k) => ({ serverName: k.name })),
    },
    tools: allowed.flatMap((k) => k.readTools.map((t) => `${connectionToolPrefix(k.name)}__${t}`)),
  };
}

/** Where a provider keeps what it knows of this computer's connections. */
export function knownFile(stateDir: string): string {
  return join(stateDir, "connections.json");
}

// ---------- Codex ----------

/** A name Codex's `-c` reads as one key. Another (a dotted, quoted one) cannot be switched from outside. */
export const CODEX_PLAIN_NAME = /^[A-Za-z0-9_-]+$/;

/** `codex mcp list --json`, as connections. Codex says what is configured, not whether it works. */
export function parseCodexList(json: string): BrainConnection[] {
  let list: unknown;
  try {
    list = JSON.parse(json);
  } catch {
    return [];
  }
  const out: BrainConnection[] = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || typeof s.name !== "string" || s.name === HUB_SERVER || !CODEX_PLAIN_NAME.test(s.name)) continue;
    const auth = String(s.auth_status ?? s.authStatus ?? "");
    out.push({ name: s.name, source: "config", status: s.enabled === false ? "off" : /^not_?logged_?in$/i.test(auth) ? "signin" : "unknown" });
  }
  return out;
}

/** A Codex MCP call's name for the hub: its own tools by their name, a connection's as Claude Code would name it. */
export function codexToolName(server: unknown, tool: unknown): string {
  const name = typeof tool === "string" && tool ? tool : "tool";
  return typeof server === "string" && server && server !== HUB_SERVER ? `${connectionToolPrefix(server)}__${name}` : name;
}

export async function codexConnections(command: string, env: Record<string, string>): Promise<BrainConnection[]> {
  const r = await capture(command, ["mcp", "list", "--json"], env, 20_000);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || "Codex did not list its MCP servers");
  return parseCodexList(r.stdout);
}
