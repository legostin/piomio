// The CLIs' own connections (docs/superpowers/plans/2026-11-16-cli-connections.md): what the person connected in
// Claude Code or Codex itself, turned on per brain and computer. The hub keeps names only.
import { describe, expect, it } from "vitest";
import type { BrainConnection } from "@piomio/shared";
import { AuditLog } from "../src/audit.ts";
import { BrainConnections } from "../src/brain-connections.ts";
import type { BrainRegistry } from "../src/brains.ts";
import { EventBus } from "../src/bus.ts";
import { openDb } from "../src/db.ts";
import { Settings } from "../src/settings.ts";
import { accessView, buildAccessMap } from "../src/access/map.ts";
import { connectionTool } from "../src/tools/native-permission.ts";

const GMAIL: BrainConnection = { name: "claude.ai Gmail", source: "account", status: "connected", tools: ["search_threads", "send_message"], readTools: ["search_threads"] };
const BLENDER: BrainConnection = { name: "blender", source: "config", status: "failed", detail: "Connection closed" };

function make(listed: BrainConnection[] = [GMAIL, BLENDER], supported = true) {
  const db = openDb(":memory:");
  const bus = new EventBus();
  const asked: Array<{ ref: string; env?: Record<string, string> }> = [];
  const brains = {
    connections: async (ref: string, env?: Record<string, string>) => (asked.push({ ref, env }), { connections: listed, supported }),
  } as unknown as BrainRegistry;
  const updates: string[] = [];
  bus.on("brains.updated", () => updates.push("brains.updated"));
  // The Mac's own node is the same computer as the hub there, whoever leads.
  const connections = new BrainConnections({ settings: new Settings(db, "UTC"), brains, audit: new AuditLog(db), bus, computer: (id) => (id === "local" || id === "mach_mac" ? "rep_mac" : id) });
  return { connections, asked, updates, db };
}

describe("the CLIs' own connections", () => {
  it("lists what the CLI has, everything off until the person turns it on", async () => {
    const { connections, asked } = make();
    const l = await connections.list("claude-code@local");
    expect(l.supported).toBe(true);
    expect(l.connections.map((c) => [c.name, c.enabled])).toEqual([["claude.ai Gmail", false], ["blender", false]]);
    expect(connections.enabled("claude-code@local")).toEqual([]);
    // The CLI starts its servers to answer: asked once, then again only on a refresh.
    await connections.list("claude-code@local");
    expect(asked).toHaveLength(1);
    await connections.list("claude-code@local", { refresh: true });
    expect(asked).toHaveLength(2);
  });

  it("turns one on for the brain on its computer, the same computer whoever leads; other brains and computers stay off", async () => {
    const { connections, updates, db } = make();
    const l = await connections.set("claude-code@local", "claude.ai Gmail", true, "user");
    expect(l.connections.find((c) => c.name === "claude.ai Gmail")?.enabled).toBe(true);
    expect(connections.enabled("claude-code@local")).toEqual(["claude.ai Gmail"]);
    expect(connections.enabled("claude-code@mach_mac")).toEqual(["claude.ai Gmail"]);
    expect(connections.enabled("claude-code@mach_vps")).toEqual([]);
    expect(connections.enabled("codex@local")).toEqual([]);
    expect(updates).toEqual(["brains.updated"]);
    expect(connections.enabledEverywhere()).toEqual({ "claude-code@rep_mac": ["claude.ai Gmail"] });
    const logged = db.prepare("select actor, action, target, data from audit where action = 'brain.connection'").get() as { actor: string; target: string; data: string };
    expect(logged).toMatchObject({ actor: "user", target: "claude-code@local" });
    expect(JSON.parse(logged.data)).toEqual({ name: "claude.ai Gmail", on: true });

    await connections.set("claude-code@local", "claude.ai Gmail", false, "user");
    expect(connections.enabled("claude-code@local")).toEqual([]);
    expect(connections.enabledEverywhere()).toEqual({});
  });

  it("turns on only what the CLI listed, and only for a CLI brain", async () => {
    const { connections } = make();
    await expect(connections.set("claude-code@local", "made-up", true, "user")).rejects.toMatchObject({ key: "brainConnections.unknown" });
    await expect(connections.set("api:anthropic@local", "claude.ai Gmail", true, "user")).rejects.toMatchObject({ key: "brainConnections.none" });
    expect(connections.offers("kimi@local")).toBe(false);
    expect((await connections.list("kimi@local")).supported).toBe(false);
  });

  it("keeps showing one that is on and gone from the CLI, so it can be turned off", async () => {
    const listed = [GMAIL];
    const { connections } = make(listed);
    await connections.set("codex@mach_vps", "claude.ai Gmail", true, "user");
    listed.length = 0;
    const l = await connections.list("codex@mach_vps", { refresh: true });
    expect(l.connections).toEqual([{ name: "claude.ai Gmail", source: "config", status: "unknown", enabled: true }]);
    expect((await connections.set("codex@mach_vps", "claude.ai Gmail", false, "user")).connections).toEqual([]);
  });
});

describe("what the rest of the hub says about them", () => {
  it("the access map lists what is on, on the agent's computers", () => {
    const map = buildAccessMap({
      agent: { id: "dev", name: "Developer" },
      here: "rep_mac",
      computers: [{ id: "rep_mac", name: "MacBook-Pro", online: true }, { id: "mach_vps", name: "vps", online: true }],
      builtInHosts: [],
      addedHosts: [],
      services: [],
      cli: [
        { brainId: "claude-code", computer: "rep_mac", names: ["claude.ai Gmail", "blender"] },
        { brainId: "codex", computer: "mach_gone", names: ["notion"] },
      ],
    });
    expect(map.cli).toEqual([{ brain: "Claude Code", computer: "MacBook-Pro", names: ["claude.ai Gmail", "blender"] }]);
    expect(accessView(map)).toMatch(/^- Claude Code on MacBook-Pro: claude\.ai Gmail, blender$/m);
    // The reviewer is told they are for every agent there, not a sign this one should act on them.
    expect(accessView(map, { reviewer: true })).toMatch(/turned on by the person for every agent thinking there/);
    expect(accessView(buildAccessMap({ agent: { id: "a", name: "A" }, here: "local", computers: [], builtInHosts: [], addedHosts: [], services: [] }))).not.toMatch(/own CLIs/);
  });

  it("a card names the connection and its tool", () => {
    expect(connectionTool("mcp__claude_ai_Gmail__send_message")).toEqual({ connection: "Gmail", tool: "send_message" });
    expect(connectionTool("mcp__jev-browser__jev_act")).toEqual({ connection: "jev-browser", tool: "jev_act" });
    expect(connectionTool("Bash")).toBeUndefined();
  });
});
