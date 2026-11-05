// External MCP servers (user's mcp.json and plugins' .mcp.json). Their tools are registered in the ToolRegistry
// as `<server>_<tool>` and therefore go through the same policy/approval/audit path as everything else.
// A remote server that asks the person to sign in (OAuth, as Granola's does) waits in "signin" until they do
// (signIn → their browser → completeSignIn); its tokens live in the vault (oauth.ts).
// A server that could not be reached, or whose connection dropped, is "reconnecting": the hub tries again by itself
// (5 s, 15 s, 1 min, 5 min, then every 10 min), its tools stay registered meanwhile, and a call waits for it a moment
// instead of the tools vanishing (an agent once took that for a lost sign-in and asked the person to sign in again).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolResult } from "@piomio/shared";
import type { Config } from "../config.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { sanitizeToolName } from "../tools/registry.ts";
import type { VaultService } from "../vault/service.ts";
import type { AuditLog } from "../audit.ts";
import type { EgressProxy } from "../egress.ts";
import { scrubEnv } from "../plugins/host.ts";
import { LocalizedError, t } from "../i18n.ts";
import { McpOAuth } from "./oauth.ts";

export interface McpServerConfig {
  type?: "stdio" | "http" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  /** Hosts the server may reach (stdio servers). Default for user servers: any. */
  network?: string[];
  /**
   * Tools that only read, for a server that does not annotate them (they need no approval). Honoured for built-in
   * plugins only: an installed plugin cannot vouch for its own server.
   */
  readTools?: string[];
}

export interface McpServerStatus {
  name: string;
  source: string; // "user" or plugin id
  /** signin: the server wants the person to sign in (signIn). reconnecting: it failed and is tried again at `retryAt`. */
  status: "connecting" | "connected" | "reconnecting" | "signin" | "error" | "disabled";
  error?: string;
  /** When the next try starts (ISO), while reconnecting. */
  retryAt?: string;
  tools: string[];
  config: McpServerConfig;
}

interface Conn {
  name: string;
  source: string;
  config: McpServerConfig;
  /** Built-in plugin's server: its readTools count. */
  trusted: boolean;
  client?: Client;
  transport?: StreamableHTTPClientTransport;
  oauth?: McpOAuth;
  /** The chat whose card started the sign-in in progress. */
  conversationId?: string;
  status: McpServerStatus["status"];
  error?: string;
  tools: string[];
  /** Tries since the last good connection. */
  attempt: number;
  /** The next try, while reconnecting. */
  timer?: NodeJS.Timeout;
  retryAt?: number;
  /** Replaced or taken down: its client closing is not a drop. */
  retired?: boolean;
  /** When it connected: a connection that held a while counts its next failure as the first. */
  connectedAt?: number;
}

const TOOL_TIMEOUT = 10 * 60_000;
/** A local server that keeps failing to start is started again this many times, then waits for hub_access or the person. */
const STDIO_TRIES = 5;
/** A connection that held this long was good: its drop starts the backoff afresh (a crash loop does not). */
const HELD_MS = 60_000;
/** Errors of a request that never reached the server: sending it again cannot do anything twice. */
const UNDELIVERED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EADDRNOTAVAIL"]);

/** What the configuration itself lacks: trying again cannot help. */
class McpConfigError extends Error {}

/**
 * Worth trying again by itself: the network (the server unreachable, the connection dropped) or the server's own
 * trouble (5xx). A refusal (4xx) or a protocol it does not speak stays an error until the person or hub_access acts.
 */
function passing(e: any, stdio: boolean): boolean {
  if (e instanceof McpConfigError) return false;
  if (stdio) return true;
  // 5xx, a timeout (408) or "too many requests" (429) clears by itself.
  if (e instanceof StreamableHTTPError) return typeof e.code === "number" && (e.code >= 500 || e.code === 408 || e.code === 429);
  // The server did not answer in time (a slow network): MCP's RequestTimeout.
  if (e?.code === -32001) return true;
  return connectionFailed(e);
}

function undelivered(e: any): boolean {
  return UNDELIVERED.has(e?.cause?.code ?? e?.code ?? "");
}

/** The connection itself failed (not the tool): fetch could not talk to the server, or the stdio pipe closed. */
function connectionFailed(e: any): boolean {
  if (undelivered(e)) return true;
  const code = String(e?.cause?.code ?? e?.code ?? "");
  return (e instanceof TypeError && /fetch failed/i.test(e.message)) || /^(?:ECONNRESET|EPIPE|ETIMEDOUT|UND_ERR_)/.test(code) || /connection closed/i.test(String(e?.message ?? ""));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class McpClientManager {
  private conns = new Map<string, Conn>();
  private oauths = new Map<string, McpOAuth>();
  config: Config;
  registry: ToolRegistry;
  vault: VaultService;
  audit: AuditLog;
  egress: EgressProxy;
  onChange?: () => void;
  /** After a failure: the delays before each next try, the last repeating (tests shorten them). */
  retryDelays = [5_000, 15_000, 60_000, 300_000, 600_000];
  /** How long a tool call waits for its server to come back. */
  callWaitMs = 20_000;

  constructor(d: { config: Config; registry: ToolRegistry; vault: VaultService; audit: AuditLog; egress: EgressProxy }) {
    this.config = d.config;
    this.registry = d.registry;
    this.vault = d.vault;
    this.audit = d.audit;
    this.egress = d.egress;
  }

  get userFile(): string {
    return join(this.config.dataDir, "mcp.json");
  }

  readUserServers(): Record<string, McpServerConfig> {
    if (!existsSync(this.userFile)) return {};
    try {
      const j = JSON.parse(readFileSync(this.userFile, "utf8"));
      return (j.mcpServers ?? j) as Record<string, McpServerConfig>;
    } catch (e) {
      console.error("[mcp] cannot parse mcp.json:", (e as Error).message);
      return {};
    }
  }

  writeUserServers(servers: Record<string, McpServerConfig>): void {
    writeFileSync(this.userFile, JSON.stringify({ mcpServers: servers }, null, 2));
  }

  /** Reconcile running connections with the desired set. */
  async sync(pluginMcpFiles: Array<{ pluginId: string; file: string; dir: string; data?: string; network: string[]; builtin?: boolean }>): Promise<void> {
    const desired = new Map<string, { source: string; config: McpServerConfig; trusted: boolean }>();
    for (const [name, cfg] of Object.entries(this.readUserServers())) desired.set(sanitizeToolName(name), { source: "user", config: cfg, trusted: false });
    for (const p of pluginMcpFiles) {
      try {
        const j = JSON.parse(readFileSync(p.file, "utf8"));
        for (const [name, cfg] of Object.entries((j.mcpServers ?? j) as Record<string, McpServerConfig>)) {
          const expanded = expandPluginRoot(cfg, p.dir, p.data);
          expanded.network = expanded.network ?? p.network;
          // A server named like its plugin is the plugin itself (integrations/granola: granola_<tool>).
          desired.set(sanitizeToolName(name === p.pluginId ? name : `${p.pluginId}-${name}`), { source: p.pluginId, config: expanded, trusted: !!p.builtin });
        }
      } catch (e) {
        console.error(`[mcp] cannot read ${p.file}:`, (e as Error).message);
      }
    }
    for (const [name, c] of this.conns) {
      const want = desired.get(name);
      if (!want || JSON.stringify(want.config) !== JSON.stringify(c.config)) await this.disconnect(name);
    }
    await Promise.all(
      [...desired].filter(([name]) => !this.conns.has(name)).map(([name, d]) => this.connect(name, d.source, d.config, d.trusted)),
    );
    this.onChange?.();
  }

  /**
   * The address the person's browser opens to sign in to `name`; a new sign-in each time. `conversationId`: the chat
   * whose card started it, told when it is done.
   */
  async signIn(name: string, conversationId?: string): Promise<string> {
    const c = this.conns.get(name);
    if (!c?.oauth) throw new LocalizedError("mcp.noSignin", { name }, 404);
    if (this.vault.state() !== "unlocked") throw new LocalizedError("connections.vaultLocked", undefined, 409);
    await this.reconnect(name);
    const now = this.conns.get(name)!;
    if (now.status === "connected") throw new LocalizedError("mcp.signedIn", { name }, 409);
    if (!now.oauth?.authUrl) throw new LocalizedError("mcp.signinFailed", { name, error: now.error ?? "no sign-in address" }, 502);
    now.conversationId = conversationId;
    return now.oauth.authUrl.toString();
  }

  /** The browser came back (or the person pasted the address): finish the sign-in and connect. */
  async completeSignIn(input: URLSearchParams): Promise<{ name: string; source: string; conversationId?: string }> {
    const error = input.get("error");
    const c = [...this.conns.values()].find((x) => x.oauth && x.oauth.stateValue === input.get("state"));
    if (!c?.transport) throw new LocalizedError("mcp.signinExpired", undefined, 400);
    if (error) throw new LocalizedError(error === "access_denied" ? "connections.denied" : "connections.failed", { error }, 400);
    const code = input.get("code");
    if (!code) throw new LocalizedError("mcp.signinExpired", undefined, 400);
    await c.transport.finishAuth(code);
    this.audit.append("user", "mcp.signin", c.name, { source: c.source });
    await this.reconnect(c.name);
    return { name: c.name, source: c.source, conversationId: c.conversationId };
  }

  /** Forget the sign-in: the tokens leave the vault and the server waits for a new one. */
  async signOut(name: string): Promise<void> {
    const c = this.conns.get(name);
    if (!c?.oauth) throw new LocalizedError("mcp.noSignin", { name }, 404);
    c.oauth.invalidateCredentials("tokens");
    this.audit.append("user", "mcp.signout", name, { source: c.source });
    await this.reconnect(name);
  }

  list(): McpServerStatus[] {
    return [...this.conns.values()].map((c) => ({
      name: c.name,
      source: c.source,
      status: c.status,
      error: c.error,
      ...(c.status === "reconnecting" && c.retryAt ? { retryAt: new Date(c.retryAt).toISOString() } : {}),
      tools: c.tools,
      config: redactConfig(c.config),
    }));
  }

  /** Replace vault://id references in env/headers with secret values (scoped to tool owner mcp:<name>). */
  private resolveSecrets(name: string, values: Record<string, string> | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(values ?? {})) {
      const m = /^vault:\/\/([\w.-]+)(?:#(\w+))?$/.exec(v);
      if (!m) {
        out[k] = v;
        continue;
      }
      const fields = this.vault.access(m[1], { actor: `mcp:${name}`, tool: `mcp:${name}` });
      out[k] = fields[m[2] ?? "value"] ?? fields.password ?? Object.values(fields)[0] ?? "";
    }
    return out;
  }

  /** A server's sign-in, kept across reconnects (the client it registered stays while the vault is locked). */
  private oauthFor(name: string): McpOAuth {
    let o = this.oauths.get(name);
    if (!o) this.oauths.set(name, (o = new McpOAuth({ server: name, vault: this.vault, redirectUri: this.redirectUri() })));
    return o;
  }

  /** Where a sign-in comes back to: the hub on this computer (localhost, the address OAuth servers allow for apps). */
  private redirectUri(): string {
    const u = new URL("/oauth/mcp", this.config.internalUrl);
    u.hostname = "localhost";
    return u.toString();
  }

  /** `prev`: the connection this try replaces (a reconnect): its tools stay until this one has its own. */
  private async connect(name: string, source: string, config: McpServerConfig, trusted = false, prev?: Conn): Promise<void> {
    const conn: Conn = { name, source, config, trusted, status: config.disabled ? "disabled" : "connecting", tools: prev?.tools ?? [], attempt: prev ? prev.attempt + 1 : 0 };
    this.conns.set(name, conn);
    if (config.disabled) return;
    let stderrTail = "";
    let client: Client | undefined;
    // Replaced or taken down while this try was waiting (sync, a sign-in, closeAll, another try): it must touch nothing.
    const stale = () => this.conns.get(name) !== conn || !!conn.retired;
    const drop = () => void client?.close().catch(() => {});
    const type = config.type ?? (config.url ? "http" : "stdio");
    try {
      client = new Client({ name: "piomio-hub", version: this.config.version });
      if (type === "stdio") {
        if (!config.command) throw new McpConfigError("command is required");
        this.egress.revokeOwner(`mcp:${name}`);
        const proxyToken = this.egress.issueToken(`mcp:${name}`, config.network ?? (source === "user" ? ["*"] : []));
        const proxy = `http://${proxyToken}:x@127.0.0.1:${this.config.egressPort}`;
        const env = {
          ...this.resolveSecrets(name, config.env),
          HTTP_PROXY: proxy,
          HTTPS_PROXY: proxy,
          http_proxy: proxy,
          https_proxy: proxy,
          NO_PROXY: "127.0.0.1,localhost,::1",
          NODE_USE_ENV_PROXY: "1",
        };
        const childEnv = { ...scrubEnv(process.env), ...env };
        const transport = new StdioClientTransport({ command: config.command, args: config.args ?? [], env: childEnv, cwd: config.cwd, stderr: "pipe" });
        // A server that quits while starting says why on stderr: its last line becomes the error the person sees.
        transport.stderr?.on("data", (d: Buffer) => (stderrTail = (stderrTail + d.toString()).slice(-2000)));
        await client.connect(transport);
        if (stale()) return drop();
      } else {
        if (!config.url) throw new McpConfigError("url is required");
        const headers = this.resolveSecrets(name, config.headers);
        // A server with its own Authorization header needs no sign-in; any other may ask for one.
        const oauth = Object.keys(headers).some((h) => h.toLowerCase() === "authorization") ? undefined : this.oauthFor(name);
        oauth?.begin();
        const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers }, ...(oauth ? { authProvider: oauth } : {}) });
        Object.assign(conn, { transport, oauth });
        try {
          await client.connect(transport);
        } catch (e) {
          if (!(e instanceof UnauthorizedError) || !oauth) throw e;
          if (stale()) return drop();
          this.registry.unregisterOwner(`mcp:${name}`);
          Object.assign(conn, { status: "signin", error: t("mcp.needsSignin"), tools: [] });
          return;
        }
        if (stale()) return drop();
      }
      conn.client = client;
      const { tools } = await client.listTools();
      if (stale()) return drop();
      const live = client;
      // Replaced as a whole: a tool the server no longer has goes, the others get this connection.
      this.registry.unregisterOwner(`mcp:${name}`);
      conn.tools = [];
      for (const tool of tools) {
        // A tool already named after its server (Notion's notion-search) is not prefixed twice: notion_search.
        const own = tool.name.startsWith(`${name}-`) || tool.name.startsWith(`${name}_`) ? tool.name.slice(name.length + 1) : tool.name;
        const full = sanitizeToolName(`${name}_${own}`).slice(0, 64);
        const readOnly = !!tool.annotations?.readOnlyHint || (trusted && !!config.readTools?.includes(tool.name));
        this.registry.register(
          {
            name: full,
            description: `[MCP ${name}] ${tool.description ?? ""}`.trim(),
            inputSchema: (tool.inputSchema as any) ?? { type: "object" },
            effect: readOnly ? "read" : "external",
            source: true,
            owner: `mcp:${name}`,
          },
          (input) => this.callTool(name, tool.name, input, readOnly),
        );
        conn.tools.push(full);
      }
      Object.assign(conn, { status: "connected", error: undefined, retryAt: undefined, connectedAt: Date.now() });
      // A dropped connection (the server's process ended, its stream closed) is tried again, its tools kept meanwhile.
      live.onclose = () => {
        if (this.conns.get(name) === conn && !conn.retired) this.retryLater(conn, t("mcp.connectionClosed"));
      };
      this.audit.append("core", "mcp.connect", name, { source, tools: conn.tools.length, ...(prev ? { attempt: prev.attempt + 1 } : {}) });
    } catch (e: any) {
      if (stale()) return drop();
      // Refused after it connected (its tools listed with a token it no longer takes): the person signs in again.
      if (e instanceof UnauthorizedError && conn.oauth) {
        drop();
        this.registry.unregisterOwner(`mcp:${name}`);
        Object.assign(conn, { status: "signin", error: t("mcp.needsSignin"), tools: [], retryAt: undefined });
        return;
      }
      const error = stderrTail.trim().split("\n").at(-1)?.trim() || (e?.message ?? String(e));
      console.error(`[mcp] ${name}: ${error}`);
      if (passing(e, type === "stdio")) this.retryLater(conn, error);
      else {
        drop();
        this.registry.unregisterOwner(`mcp:${name}`);
        Object.assign(conn, { status: "error", error, tools: [], retryAt: undefined });
      }
    }
  }

  /**
   * A server's tool, on its live connection: waits for a reconnect, and sends a call again once (after the server came
   * back) when that cannot do anything twice: it never reached the server, or the tool only reads.
   */
  private async callTool(name: string, tool: string, input: unknown, readOnly: boolean): Promise<ToolResult> {
    let c = await this.live(name);
    if (!c?.client) return this.notLive(name);
    for (let sent = 0; ; sent++) {
      try {
        return normalizeResult(await c.client!.callTool({ name: tool, arguments: (input ?? {}) as Record<string, unknown> }, undefined, { timeout: TOOL_TIMEOUT }));
      } catch (e: any) {
        if (e instanceof UnauthorizedError) {
          // The sign-in ran out and could not be renewed: the server waits for the person again.
          this.registry.unregisterOwner(`mcp:${name}`);
          Object.assign(c, { status: "signin", error: t("mcp.needsSignin"), tools: [] });
          this.onChange?.();
          return { content: [{ type: "text", text: `The sign-in to ${name} expired. Ask the user to sign in again (hub_integration_connect shows the button).` }], isError: true };
        }
        if (connectionFailed(e)) {
          // The connection is gone: the hub reconnects; the call goes again once the server is back, if that is safe.
          this.retryLater(c, String(e?.cause?.code ?? e?.message ?? e));
          if (sent === 0 && (readOnly || undelivered(e))) {
            c = await this.live(name);
            if (!c?.client) return this.notLive(name);
            continue;
          }
          if (sent > 0) return this.notLive(name);
        }
        if (this.conns.get(name) !== c || c.status !== "connected") {
          return {
            content: [{ type: "text", text: `The connection to ${name} dropped during this call (${e?.message ?? e}); it is reconnecting. Check whether the action happened before you repeat it.` }],
            isError: true,
          };
        }
        throw e;
      }
    }
  }

  /** The connection once it is up, waiting up to callWaitMs (a waiting retry starts at once); undefined if it is not. */
  private async live(name: string): Promise<Conn | undefined> {
    const end = Date.now() + this.callWaitMs;
    let kicked = false;
    for (;;) {
      const c = this.conns.get(name);
      if (!c || c.status === "signin" || c.status === "error" || c.status === "disabled") return undefined;
      if (c.status === "connected" && c.client) return c;
      if (c.status === "reconnecting" && !kicked) {
        kicked = true;
        void this.kick(name);
      }
      if (Date.now() >= end) return undefined;
      await sleep(Math.min(100, Math.max(10, end - Date.now())));
    }
  }

  /** What a call gets while its server is not up. English: it is for the model. */
  private notLive(name: string): ToolResult {
    const c = this.conns.get(name);
    const text =
      c?.status === "signin"
        ? `${name} needs the user to sign in again. Ask them (hub_integration_connect shows the button).`
        : c?.status === "reconnecting"
          ? `${name} is reconnecting (${c.error ?? "unreachable"}; next try ${c.retryAt ? `in ${Math.max(1, Math.round((c.retryAt - Date.now()) / 1000))} s` : "soon"}). Try again later, or call hub_access with check: true. It is the connection, not the sign-in: do not ask the user to sign in again.`
          : `${name} is not connected: ${c?.error ?? "unavailable"}.`;
    return { content: [{ type: "text", text }], isError: true };
  }

  /** After a failure: the next try later, the tools kept. A local server that failed STDIO_TRIES times waits. */
  private retryLater(conn: Conn, error: string): void {
    if (this.conns.get(conn.name) !== conn || conn.retired) return;
    clearTimeout(conn.timer);
    // It held a while before it dropped: the backoff starts afresh. One that drops at once keeps climbing.
    if (conn.connectedAt && Date.now() - conn.connectedAt >= HELD_MS) conn.attempt = 0;
    conn.connectedAt = undefined;
    const stdio = (conn.config.type ?? (conn.config.url ? "http" : "stdio")) === "stdio";
    if (stdio && conn.attempt >= STDIO_TRIES - 1) {
      this.registry.unregisterOwner(`mcp:${conn.name}`);
      Object.assign(conn, { status: "error", error, tools: [], retryAt: undefined });
      this.onChange?.();
      return;
    }
    const delay = this.retryDelays[Math.min(conn.attempt, this.retryDelays.length - 1)] ?? 600_000;
    Object.assign(conn, { status: "reconnecting", error, retryAt: Date.now() + delay });
    conn.timer = setTimeout(() => void this.kick(conn.name), delay);
    conn.timer.unref?.();
    this.onChange?.();
  }

  /**
   * Try a server again now: one that is reconnecting, or (`stale`: hub_access's check) one that stopped trying. Its
   * tools stay registered until the new connection lists its own.
   */
  async kick(name: string, opts: { stale?: boolean } = {}): Promise<void> {
    const c = this.conns.get(name);
    if (!c || !(c.status === "reconnecting" || (opts.stale && c.status === "error"))) return;
    clearTimeout(c.timer);
    c.retired = true;
    void c.client?.close().catch(() => {});
    await this.connect(name, c.source, c.config, c.trusted, c.status === "error" ? { ...c, attempt: -1 } : c);
    this.onChange?.();
  }

  private async disconnect(name: string): Promise<void> {
    const c = this.conns.get(name);
    if (c) {
      clearTimeout(c.timer);
      c.retired = true;
    }
    this.conns.delete(name);
    this.registry.unregisterOwner(`mcp:${name}`);
    this.egress.revokeOwner(`mcp:${name}`);
    await c?.client?.close().catch(() => {});
  }

  async reconnect(name: string): Promise<void> {
    const c = this.conns.get(name);
    if (!c) return;
    await this.disconnect(name);
    await this.connect(name, c.source, c.config, c.trusted);
    this.onChange?.();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.conns.keys()].map((n) => this.disconnect(n)));
  }
}

function normalizeResult(r: any): ToolResult {
  const content = Array.isArray(r?.content)
    ? r.content.map((c: any) =>
        c.type === "text"
          ? { type: "text" as const, text: String(c.text) }
          : c.type === "image"
            ? { type: "image" as const, data: c.data, mimeType: c.mimeType }
            : { type: "text" as const, text: JSON.stringify(c).slice(0, 20_000) },
      )
    : [{ type: "text" as const, text: JSON.stringify(r?.structuredContent ?? r ?? null).slice(0, 20_000) }];
  return { content, isError: !!r?.isError };
}

/** A plugin's .mcp.json may name its own folder, its data folder and the hub's Node (a launcher written in TypeScript runs on it). */
function expandPluginRoot(cfg: McpServerConfig, dir: string, data?: string): McpServerConfig {
  const sub = (s: string) => {
    const out = s.replaceAll("${CLAUDE_PLUGIN_ROOT}", dir).replaceAll("${PLUGIN_ROOT}", dir).replaceAll("${PIOMIO_PLUGIN_ROOT}", dir).replaceAll("${PIOMIO_NODE}", process.execPath);
    return data ? out.replaceAll("${PIOMIO_PLUGIN_DATA}", data) : out;
  };
  return {
    ...cfg,
    command: cfg.command ? sub(cfg.command) : undefined,
    args: cfg.args?.map(sub),
    cwd: cfg.cwd ? sub(cfg.cwd) : cfg.command ? dir : undefined,
    env: cfg.env ? Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, sub(v)])) : undefined,
  };
}

function redactConfig(c: McpServerConfig): McpServerConfig {
  const mask = (o?: Record<string, string>) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.startsWith("vault://") ? v : "•••"])) : undefined);
  return { ...c, env: mask(c.env), headers: mask(c.headers) };
}
