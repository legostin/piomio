// A service's MCP server that cannot be reached (the hub started before the network, the service restarted) is
// reconnected by the hub itself: its tools come back without the person, a call made while it is away waits for it,
// and nobody is told to sign in again. Before, one failed connect at the hub's start left Notion without tools until
// a restart, and the agent asked the person to sign in to Notion again.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Hub, loadConfig } from "../src/index.ts";
import { listIntegrations } from "../src/integrations.ts";

const fixtures = join(import.meta.dirname, "fixtures");

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });

/** A board service on a fixed port that the test takes down and brings back. */
function board(port: number) {
  let server: Server | undefined;
  const sockets = new Set<Socket>();
  let calls = 0;
  const up = () =>
    new Promise<void>((r) => {
      server = createHttpServer(async (req, res) => {
        const mcp = new McpServer({ name: "board", version: "1.0.0" }, { capabilities: { tools: {} } });
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [
            { name: "cards", description: "List cards", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
            { name: "move", description: "Move a card", inputSchema: { type: "object", properties: {} } },
          ],
        }));
        mcp.setRequestHandler(CallToolRequestSchema, async () => {
          calls++;
          return { content: [{ type: "text", text: "card 1" }] };
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await mcp.connect(transport);
        const raw = req.method === "POST" ? await body(req) : "";
        return transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
      });
      server.on("connection", (s) => {
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
      });
      server.listen(port, "127.0.0.1", () => r());
    });
  const down = () =>
    new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      if (!server) return r();
      server.close(() => r());
      server = undefined;
    });
  return { up, down, calls: () => calls };
}

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("a service the hub cannot reach", () => {
  let hub: Hub;
  let svc: ReturnType<typeof board>;
  const server = () => hub.mcpClients.list().find((s) => s.name === "board")!;
  const call = () => hub.tools.get("board_cards")!.invoke({}, {} as any);

  beforeAll(async () => {
    const servicePort = await freePort();
    svc = board(servicePort);
    const builtin = mkdtempSync(join(tmpdir(), "owl-reconnect-builtin-"));
    const dir = join(builtin, "board");
    mkdirSync(join(dir, ".piomio-plugin"), { recursive: true });
    writeFileSync(join(dir, ".piomio-plugin", "plugin.json"), JSON.stringify({ id: "board", name: "Board", builtin: true, integration: { category: "work", connect: "signin", summary: "A board" } }));
    // Its own Authorization header: no sign-in in the way, only the network.
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { board: { type: "http", url: `http://127.0.0.1:${servicePort}/mcp`, headers: { Authorization: "Bearer t" } } } }));
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), PIOMIO_LANG: "en", TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-reconnect-")), builtinPluginsDirs: [builtin], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    hub.mcpClients.retryDelays = [150, 300];
    hub.mcpClients.callWaitMs = 2000;
    // The hub starts while the service is unreachable.
    await hub.start();
  });

  afterAll(async () => {
    await hub?.stop();
    await svc?.down();
  });

  it("is reconnecting, not waiting for a sign-in, and its card says so", async () => {
    expect(server()).toMatchObject({ status: "reconnecting" });
    expect(server().retryAt).toBeTruthy();
    const card = (await listIntegrations(hub, "en")).find((i) => i.id === "board")!;
    expect(card.status).toBe("broken");
    expect(card.detail).toMatch(/reconnect/i);
  });

  it("comes back by itself once the service answers, tools and all", async () => {
    await svc.up();
    await until(() => server().status === "connected");
    expect(server().tools).toEqual(["board_cards", "board_move"]);
    expect((await call()).content).toEqual([{ type: "text", text: "card 1" }]);
  });

  it("a call made while the service is away waits for it, and goes through once it is back", async () => {
    await svc.down();
    const before = svc.calls();
    const pending = call();
    setTimeout(() => void svc.up(), 400);
    const r = await pending;
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: "text", text: "card 1" }]);
    expect(svc.calls()).toBe(before + 1);
    await until(() => server().status === "connected");
  });

  it("a change is never sent twice: it goes again only if it never reached the service", async () => {
    await svc.down();
    const before = svc.calls();
    const pending = hub.tools.get("board_move")!.invoke({}, {} as any);
    setTimeout(() => void svc.up(), 300);
    const r = await pending;
    if (r.isError) expect((r.content[0] as { text: string }).text).toMatch(/reconnecting|dropped/);
    else expect(r.content).toEqual([{ type: "text", text: "card 1" }]);
    expect(svc.calls() - before).toBeLessThanOrEqual(1);
    await until(() => server().status === "connected");
  });

  it("a call that waited too long says the service is reconnecting, never to sign in again", async () => {
    await svc.down();
    const r = await call();
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/board is reconnecting/);
    expect(text).toMatch(/not the sign-in: do not ask the user to sign in again/);
    // Its tools stayed: the agent still sees them while the hub reconnects.
    expect(hub.tools.get("board_cards")).toBeTruthy();
    await svc.up();
    await until(() => server().status === "connected", 8000);
  });
});

// Just enough MCP over stdio, that quits right after it listed its tools: a server in a crash loop.
const CRASHER = `
import { createInterface } from "node:readline";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "crasher", version: "1" } } });
  else if (m.method === "tools/list") { out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "x", inputSchema: { type: "object" } }] } }); setTimeout(() => process.exit(1), 30); }
  else if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, result: {} });
});
`;

describe("what the hub does not retry forever, and a try that comes too late", () => {
  let hub: Hub;
  let slowPort = 0;
  let slowDelay = 0;
  let slowServer: Server;
  let refuser: Server;
  const status = (name: string) => hub.mcpClients.list().find((s) => s.name === name);

  beforeAll(async () => {
    // Refuses everyone: a revoked key is not a passing failure.
    refuser = createHttpServer((_req, res) => res.writeHead(403, { "content-type": "application/json" }).end('{"error":"forbidden"}'));
    await new Promise<void>((r) => refuser.listen(0, "127.0.0.1", () => r()));
    slowPort = await freePort();
    slowServer = createHttpServer(async (req, res) => {
      await new Promise((r) => setTimeout(r, slowDelay));
      const mcp = new McpServer({ name: "slow", version: "1.0.0" }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "look", description: "Look", inputSchema: { type: "object", properties: {} } }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      const raw = req.method === "POST" ? await body(req) : "";
      return transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    });
    const builtin = mkdtempSync(join(tmpdir(), "owl-reconnect2-builtin-"));
    const plugin = (id: string, mcp: unknown, files: Record<string, string> = {}) => {
      const dir = join(builtin, id);
      mkdirSync(join(dir, ".piomio-plugin"), { recursive: true });
      writeFileSync(join(dir, ".piomio-plugin", "plugin.json"), JSON.stringify({ id, name: id, builtin: true, integration: { category: "work", connect: "none", summary: id } }));
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { [id]: mcp } }));
      for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
    };
    plugin("refuser", { type: "http", url: `http://127.0.0.1:${(refuser.address() as any).port}/mcp`, headers: { Authorization: "Bearer revoked" } });
    plugin("crasher", { command: "${PIOMIO_NODE}", args: ["${PIOMIO_PLUGIN_ROOT}/server.mjs"] }, { "server.mjs": CRASHER });
    plugin("slow", { type: "http", url: `http://127.0.0.1:${slowPort}/mcp`, headers: { Authorization: "Bearer t" } });
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), PIOMIO_LANG: "en", TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-reconnect2-")), builtinPluginsDirs: [builtin], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    hub.mcpClients.retryDelays = [100, 200];
    await hub.start();
  });

  afterAll(async () => {
    await hub?.stop();
    refuser?.close();
    slowServer?.close();
  });

  it("a server that refuses the hub (a revoked key) is an error, not 'reconnecting'", () => {
    expect(status("refuser")).toMatchObject({ status: "error" });
    expect(status("refuser")!.retryAt).toBeUndefined();
  });

  it("a local server that dies right after it connects is started again a few times, then waits", async () => {
    await until(() => status("crasher")?.status === "error", 10_000);
    const connects = hub.audit.list({ action: "mcp.connect", limit: 200 }).filter((e) => e.target === "crasher").length;
    expect(connects).toBeGreaterThan(1);
    expect(connects).toBeLessThanOrEqual(5);
    expect(hub.tools.get("crasher_x")).toBeUndefined();
  });

  it("a try still waiting when its server is taken away registers nothing", async () => {
    // The server was unreachable at the start; now it answers, slowly.
    expect(status("slow")?.status).toBe("reconnecting");
    slowDelay = 400;
    await new Promise<void>((r) => slowServer.listen(slowPort, "127.0.0.1", () => r()));
    const late = hub.mcpClients.kick("slow");
    await new Promise((r) => setTimeout(r, 50));
    expect(status("slow")?.status).toBe("connecting");
    // Taken away meanwhile (its plugin went, a sign-in started another try…).
    await hub.mcpClients.sync([]);
    await late;
    await new Promise((r) => setTimeout(r, 600));
    expect(status("slow")).toBeUndefined();
    expect(hub.tools.get("slow_look")).toBeUndefined();
  });
});
