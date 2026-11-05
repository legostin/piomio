// One access map for an agent (docs/superpowers/specs/2026-11-05-unified-access-design.md): built from what the hub
// keeps, read by auto mode's reviewer (a system on it is not "one the person did not mention") and by hub_access,
// which every agent may call and which checks and heals what it can.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "@piomio/testkit";
import type { IntegrationView } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { agentFromMarkdown } from "../src/agents.ts";
import { accessView, buildAccessMap, serviceOf } from "../src/access/map.ts";
import { reviewPrompt } from "../src/policy/auto.ts";
import { DEFAULT_BRAIN_EGRESS } from "../src/settings.ts";

const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");

describe("the access map", () => {
  const map = buildAccessMap({
    agent: { id: "dev", name: "Developer", folders: [{ name: "Piomio", path: "~/claude-projects/open-bot" }, { name: "Site", path: "/home/piomio/site", machine: "mach_vps" }] },
    here: "local",
    computers: [
      { id: "local", name: "MacBook-Pro", online: true },
      { id: "mach_vps", name: "vps", online: true, commands: true },
      { id: "mach_pc", name: "LEGOSTIN-PC", online: false, commands: false },
      { id: "rep_2", name: "vps-hub", online: false, standby: true },
    ],
    ownFolder: "/data/workspaces/dev/t1",
    builtInHosts: DEFAULT_BRAIN_EGRESS,
    addedHosts: ["example.org"],
    services: [
      { id: "notion", name: "Notion", status: "reconnecting", detail: "fetch failed" },
      { id: "composio:github", name: "GitHub", status: "connected", via: "Composio", detail: "legostin" },
      { id: "linear", name: "Linear", status: "signin" },
    ],
  });

  it("says which computers, folders, hosts and services the agent has, in plain lines", () => {
    const v = accessView(map);
    expect(v).toMatch(/^Computers:\n- MacBook-Pro \(local\): the hub's own computer, online; project folders: Piomio ~\/claude-projects\/open-bot$/m);
    expect(v).toMatch(/^- vps \(mach_vps\): online, commands on; project folders: Site \/home\/piomio\/site$/m);
    expect(v).toMatch(/^- LEGOSTIN-PC \(mach_pc\): offline, commands off$/m);
    expect(v).not.toContain("vps-hub");
    expect(v).toContain("The agent's own folder: /data/workspaces/dev/t1");
    expect(v).toMatch(/Internet: commands go through the hub's proxy\. Open: model APIs, package registries, GitHub, the CLIs' own error reports; added by the person: example\.org\./);
    expect(v).toMatch(/- Notion: reconnecting by itself \(the sign-in is kept\) — fetch failed/);
    expect(v).toMatch(/- GitHub \(via Composio\): connected — legostin/);
    expect(v).toMatch(/Not connected \(the person can connect them\): Linear/);
  });

  it("keeps an agent bound to computers to those", () => {
    const bound = buildAccessMap({ agent: { id: "a", name: "A", machines: ["mach_vps"] }, here: "local", computers: [{ id: "local", name: "Mac", online: true }, { id: "mach_vps", name: "vps", online: true }], builtInHosts: [], addedHosts: [], services: [] });
    expect(bound.computers.map((c) => c.id)).toEqual(["mach_vps"]);
  });

  it("reads a catalog card as a service: connected, reconnecting, waiting for the person, or none at all", () => {
    const card = (over: Partial<IntegrationView>): IntegrationView => ({ id: "notion", name: "Notion", summary: "", category: "work", icon: "x", connect: "signin", status: "connected", ...over });
    expect(serviceOf(card({}), [])).toMatchObject({ status: "connected" });
    expect(serviceOf(card({ status: "broken", detail: "x" }), [{ source: "notion", status: "reconnecting", error: "fetch failed" }])).toMatchObject({ status: "reconnecting", detail: "fetch failed" });
    expect(serviceOf(card({ status: "needs-setup" }), [])).toMatchObject({ status: "signin" });
    expect(serviceOf(card({ status: "broken", detail: "boom" }), [])).toMatchObject({ status: "error", detail: "boom" });
    expect(serviceOf(card({ status: "off" }), [])).toBeUndefined();
    expect(serviceOf(card({ connect: "none" }), [])).toBeUndefined();
  });

  it("is in the reviewer's prompt, and a system on it is not one the person did not mention", () => {
    const p = reviewPrompt(
      { tool: "machine_exec", input: { machine: "vps", command: "npm ci" }, summary: "Run on vps: npm ci", kind: "tool", effect: "external", why: "external" },
      { sessionId: "s", conversationId: "c", agentId: "dev", workspace: "/w", machine: "MacBook-Pro" },
      { person: ["Fix the panel header"], calls: [], access: accessView(map) },
      2,
      { dataDir: "/data", language: "en" },
    );
    expect(p).toContain("<<<ACCESS\nComputers:");
    expect(p).toContain("- vps (mach_vps): online, commands on");
    expect(p).toContain("systems that neither the person mentioned nor the agent's access lists");
    expect(p).toContain("ordinary work on the computers, folders and services the agent's access lists");
  });
});

describe("hub_access (integration)", () => {
  let hub: Hub;
  let session = "";

  beforeAll(async () => {
    const [port, consolePort, egressPort, deadPort] = [await freePort(), await freePort(), await freePort(), await freePort()];
    const dataDir = mkdtempSync(join(tmpdir(), "owl-access-"));
    const fixtures = join(import.meta.dirname, "fixtures");
    // A service whose server is never up: hub_access's check tries it again at once.
    const builtin = mkdtempSync(join(tmpdir(), "owl-access-builtin-"));
    const dir = join(builtin, "board");
    mkdirSync(join(dir, ".piomio-plugin"), { recursive: true });
    writeFileSync(join(dir, ".piomio-plugin", "plugin.json"), JSON.stringify({ id: "board", name: "Board", builtin: true, integration: { category: "work", connect: "signin", summary: "A board" } }));
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { board: { type: "http", url: `http://127.0.0.1:${deadPort}/mcp`, headers: { Authorization: "Bearer t" } } } }));
    hub = new Hub(
      loadConfig(
        { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
        { dataDir, builtinPluginsDirs: [join(fixtures, "plugins"), builtin], builtinAgentsDir: join(fixtures, "agents") },
      ),
    );
    hub.mcpClients.retryDelays = [60_000];
    await hub.start();
    hub.settings.update({ language: "en" });
    hub.saveAgent(agentFromMarkdown("dev", "---\nname: Dev\ndescription: Developer\nbrains: [fake@local]\ninitiative: 1\n---\nYou are Dev.", "user"), "user");
    const conv = hub.store.agentConversation("dev").id;
    session = hub.store.createSession({ conversationId: conv, agentId: "dev", brainRef: "fake@local", background: false }).row.id;
    // The hub's own computer resolves nothing in a test: no network needed.
    hub.egress.lookup = async () => ["93.184.216.34"];
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("every agent sees it and gets its own map", async () => {
    const r = await hub.gateway.call(session, "hub_access", {});
    expect(r.isError).toBeFalsy();
    const t = text(r);
    expect(t).toContain("Access of dev (you):");
    expect(t).toMatch(/Computers:\n- .+ \(local\): the hub's own computer, online/);
    expect(t).toMatch(/- Board: reconnecting by itself/);
  });

  it("check: true tests the internet and tries a service that is down again at once", async () => {
    const before = hub.audit.list({ action: "mcp.connect", limit: 100 }).length;
    const t = text(await hub.gateway.call(session, "hub_access", { check: true }));
    expect(t).toContain("Check now:");
    expect(t).toContain("- This computer's internet: works");
    expect(t).toMatch(/- Service board: still reconnecting/);
    expect(t).toMatch(/- Your shell: this session has no network permission/);
    expect(hub.audit.list({ action: "mcp.connect", limit: 100 }).length).toBe(before);
    // The check started a try at once: the next one is a fresh delay away.
    const retryAt = Date.parse(hub.mcpClients.list().find((s) => s.name === "board")!.retryAt!);
    expect(retryAt - Date.now()).toBeGreaterThan(50_000);
  });
});
