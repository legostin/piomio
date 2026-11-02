// The real Pio plugin in a hub: it ships off; turned on, its agent is the companion with its own small chat, its tools
// are Pio's alone, its window's reports reach it, and the team list shows what Pio does.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../../../packages/core/src/index.ts";
import { agentFromMarkdown } from "../../../packages/core/src/agents.ts";

const repo = join(import.meta.dirname, "..", "..", "..");

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

async function until<T>(fn: () => T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("the Pio plugin in a hub", () => {
  let hub: Hub;

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    // The plugin as the hub ships it (its server, agent and locales), next to the scripted fake brain.
    const plugins = mkdtempSync(join(tmpdir(), "owl-pio-plugins-"));
    cpSync(join(repo, "plugins", "pio"), join(plugins, "pio"), { recursive: true, filter: (src) => !/node_modules|[\\/]test[\\/]?|[\\/]ui[\\/]src/.test(src) });
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-pio-")), builtinPluginsDirs: [join(repo, "packages", "core", "test", "fixtures", "plugins"), plugins], builtinAgentsDir: join(repo, "packages", "core", "test", "fixtures", "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    hub.saveAgent(agentFromMarkdown("desk", "---\nname: Desk\ndescription: Front desk\nbrains: [fake@local]\n---\nYou are Desk.", "user"), "user");
    hub.settings.update({ defaultAgent: "desk" });
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("ships turned off, with an offer for the default agent", () => {
    const rec = hub.plugins.get("pio");
    expect(rec?.enabled).toBe(false);
    expect(rec?.layout?.manifest.offer).toMatch(/always next to you/);
    expect(hub.agents.get("pio")).toBeUndefined();
  });

  it("turned on, brings the companion and tools only Pio sees", async () => {
    let told = 0;
    hub.bus.on("agents.updated", () => told++);
    await hub.plugins.setEnabled("pio", true);
    // The team list hears that the team changed.
    expect(told).toBeGreaterThan(0);
    await until(() => hub.plugins.get("pio")?.status === "running", "the plugin to run");
    const pio = hub.agents.get("pio");
    expect(pio?.companion).toBe(true);
    expect(pio?.thinking?.chat?.preset).toBe("fast");
    await until(() => hub.gateway.has("pio_look") && hub.gateway.has("pio_settings"), "its tools");
    const session = (agentId: string) =>
      hub.store.createSession({ conversationId: hub.store.agentConversation(agentId).id, agentId, brainRef: "fake@local", background: false }).row;
    const seen = (agentId: string) => hub.gateway.listFor(session(agentId)).map((t) => t.name).filter((n) => n.startsWith("pio_"));
    expect(seen("pio").sort()).toEqual(["pio_click", "pio_drag", "pio_key", "pio_look", "pio_open", "pio_read", "pio_scroll", "pio_settings", "pio_type"]);
    expect(seen("desk")).toEqual([]);
  });

  it("hears its window and shows what Pio does on the team list", async () => {
    hub.plugins.uiMessage("pio", { type: "state", body: "w1", watching: true, voice: false, control: false, hearing: false, speaking: false });
    await until(() => hub.team.member("pio").presence === "watching", "watching");
    hub.plugins.uiMessage("pio", { type: "state", body: "w1", watching: true, voice: true });
    await until(() => hub.team.member("pio").presence === "listening", "listening");
    hub.plugins.uiMessage("pio", { type: "bye", body: "w1" });
    await until(() => hub.team.member("pio").presence === undefined, "gone");
  });
});
