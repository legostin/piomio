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
    expect(text).toMatch(/Do not ask the user to sign in/);
    // Its tools stayed: the agent still sees them while the hub reconnects.
    expect(hub.tools.get("board_cards")).toBeTruthy();
    await svc.up();
    await until(() => server().status === "connected", 8000);
  });
});
