// A plugin's local MCP server (as integrations/blender's launcher is): its .mcp.json names the hub's Node, the
// plugin's folder and its data folder; a server that quits while starting shows its own reason on the plugin.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";
import { listIntegrations } from "../src/integrations.ts";

const fixtures = join(import.meta.dirname, "fixtures");

// Just enough MCP over stdio; FAIL makes it quit while starting, as a launcher that finds no Blender does.
const SERVER = `
import { createInterface } from "node:readline";
if (process.env.FAIL) {
  console.error("looking for Blender");
  console.error("Blender 5.1 or newer was not found on this computer.");
  process.exit(1);
}
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "local", version: "1" } } });
  else if (m.method === "tools/list") out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "where", inputSchema: { type: "object" } }] } });
  else if (m.method === "tools/call") out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: process.env.DATA + "|" + process.execPath + "|" + process.cwd() } ] } });
  else if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, result: {} });
});
`;

describe("a plugin's local MCP server", () => {
  let hub: Hub;
  let dataDir: string;
  let builtin: string;

  beforeAll(async () => {
    builtin = mkdtempSync(join(tmpdir(), "owl-local-builtin-"));
    for (const [id, env] of [["local", {}], ["nolocal", { FAIL: "1" }]] as const) {
      const dir = join(builtin, id);
      mkdirSync(join(dir, ".piomio-plugin"), { recursive: true });
      writeFileSync(join(dir, ".piomio-plugin", "plugin.json"), JSON.stringify({ id, name: id, builtin: true, integration: { category: "work", connect: "none", summary: id } }));
      writeFileSync(join(dir, "server.mjs"), SERVER);
      writeFileSync(
        join(dir, ".mcp.json"),
        JSON.stringify({ mcpServers: { [id]: { command: "${PIOMIO_NODE}", args: ["${PIOMIO_PLUGIN_ROOT}/server.mjs"], env: { DATA: "${PIOMIO_PLUGIN_DATA}", ...env } } } }),
      );
    }
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    dataDir = mkdtempSync(join(tmpdir(), "owl-local-"));
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), PIOMIO_LANG: "en", TZ: "UTC" },
      { dataDir, builtinPluginsDirs: [builtin], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("runs on the hub's Node, in its folder, with its data folder", async () => {
    expect(hub.mcpClients.list().find((s) => s.name === "local")).toMatchObject({ status: "connected" });
    const r = await hub.tools.get("local_where")!.invoke({}, {} as any);
    // The server's cwd is the real path (macOS's temp folder is behind a symlink).
    expect(r.content).toEqual([{ type: "text", text: `${join(dataDir, "plugins-data", "local")}|${process.execPath}|${realpathSync(join(builtin, "local"))}` }]);
  });

  it("shows why a server quit while starting", async () => {
    const reason = "Blender 5.1 or newer was not found on this computer.";
    // It is started again by itself a few times (a launcher may find Blender later), its reason kept meanwhile.
    expect(hub.mcpClients.list().find((s) => s.name === "nolocal")).toMatchObject({ status: "reconnecting", error: reason });
    const card = (await listIntegrations(hub, "en")).find((i) => i.id === "nolocal")!;
    expect(card.status).toBe("broken");
    expect(card.detail).toContain(reason);
  });
});
