// Dialogs with agents last, so they all read outside content sooner or later: after it, a change of the hub waits for
// the person's yes on a card that says what exactly changes, runs once approved, and an "always allow" from that card
// lets the same change through next time. Runs the scripted fake brain (test/fixtures/plugins/fakebrain): "CALL <tool> <json>".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";
import { agentFromMarkdown } from "../src/agents.ts";
import { saidAlways } from "../src/tools/hub-tools.ts";

const fixtures = join(import.meta.dirname, "fixtures");

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
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("hub changes after outside content", () => {
  let hub: Hub;
  let conv = "";
  const machineId = "mach_vps_test";

  /** Send a message as the person; resolves with the fake brain's "tool said:" reply to it. */
  const say = async (text: string): Promise<string> => {
    const before = hub.store.listMessages(conv, { limit: 500 }).length;
    await hub.runner.userMessage(conv, text, { channel: "web" });
    const m = await until(
      () =>
        hub.store
          .listMessages(conv, { limit: 500 })
          .slice(before)
          .find((x) => x.role === "assistant" && x.status !== "streaming" && x.parts.some((p) => p.type === "text" && p.text.startsWith("tool said:"))),
      `the reply to ${text}`,
    );
    return (m.parts.find((p) => p.type === "text" && p.text.startsWith("tool said:")) as { text: string }).text;
  };
  const taint = () => {
    for (const s of hub.db.prepare("select id from sessions where conversation_id = ?").all(conv) as Array<{ id: string }>) hub.store.updateSession(s.id, { tainted: true });
  };
  const pending = (tool: string) => until(() => hub.approvals.list(["pending"]).find((a) => a.tool === tool), `a card for ${tool}`);

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      // Key mode of machines is part of what is changed here: the hub starts with API keys.
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), PIOMIO_API_KEYS: "1", TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-hub-approval-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    await until(() => hub.brains.has("fake@local"), "the fake brain");
    hub.saveAgent(agentFromMarkdown("desk", "---\nname: Desk\ndescription: Front desk\nbrains: [fake@local]\n---\nYou are Desk.", "user"), "user");
    hub.settings.update({ defaultAgent: "desk" });
    conv = hub.store.agentConversation("desk").id;
    hub.db.prepare("insert into machines(id, name, public_key, created_at) values (?, 'vps', 'x', ?)").run(machineId, new Date().toISOString());
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("a clean dialog changes settings right away", async () => {
    expect(await say('CALL hub_settings_update {"patch":{"digestTimes":["10:00"]}}')).toMatch(/^tool said:/);
    expect(hub.settings.get().digestTimes).toEqual(["10:00"]);
    expect(hub.approvals.list(["pending"])).toHaveLength(0);
  });

  it("after outside content, a change waits for the person's yes and runs once approved", async () => {
    taint();
    const reply = say('CALL hub_settings_update {"patch":{"digestTimes":["11:00"]}}');
    const a = await pending("hub_settings_update");
    expect(hub.settings.get().digestTimes).toEqual(["10:00"]);
    // The card is in the dialog, where the person taps it.
    await until(() => hub.store.listMessages(conv, { limit: 500 }).some((m) => m.parts.some((p) => p.type === "approval" && p.approvalId === a.id)), "the card in the dialog");
    hub.approvals.resolve(a.id, "approve", { via: "web" });
    expect(await reply).not.toMatch(/Refused/);
    expect(hub.settings.get().digestTimes).toEqual(["11:00"]);
    expect(hub.approvals.get(a.id)?.status).toBe("executed");
  });

  it("the setup card says what exactly the machine gets, and an always-allow lets the same change through next time", async () => {
    taint();
    const call = (usd: number) =>
      `CALL hub_machine_setup_set ${JSON.stringify({
        machine: "vps",
        brains: { codex: { auth: "key", providers: ["openai"], models: [{ id: "gpt-6.1-terra", price: { input: 1, output: 5 } }, { id: "gpt-6-luna", price: { input: 0.1, output: 0.5 } }] } },
        limit: { usd, period: "month" },
      })}`;
    const first = say(call(20));
    const a = await pending("hub_machine_setup_set");
    expect(a.summary).toBe(
      "Change what the computer vps may use. Codex on the OpenAI key, only gpt-6.1-terra ($1 per million input tokens, $5 per million output); " +
        "gpt-6-luna ($0.10 per million input tokens, $0.50 per million output). Spend limit $20 a month",
    );
    hub.approvals.resolve(a.id, "approve", { via: "web", remember: true });
    expect(await first).not.toMatch(/Refused/);
    expect(hub.setups.get(machineId)).toMatchObject({ brains: { codex: { auth: "key", providers: ["openai"] } }, limit: { usd: 20, period: "month" } });
    // The remembered rule is for this machine: the next change for it runs without a card.
    expect(await say(call(25))).not.toMatch(/Refused/);
    expect(hub.setups.get(machineId).limit).toEqual({ usd: 25, period: "month" });
    expect(hub.approvals.list(["pending"])).toHaveLength(0);
  });

  it("an integration the person said to always allow runs without cards; without their words it asks first", async () => {
    hub.tools.register(
      { name: "blender_execute_blender_code", description: "[MCP blender] Run Python in Blender", inputSchema: { type: "object" }, effect: "external", owner: "mcp:blender" },
      async () => ({ content: [{ type: "text", text: "ran" }] }),
    );
    hub.tools.register(
      { name: "linear_create_issue", description: "[MCP linear] Create an issue", inputSchema: { type: "object" }, effect: "external", owner: "mcp:linear" },
      async () => ({ content: [{ type: "text", text: "created" }] }),
    );
    taint();
    // The person's own words: no card.
    await hub.runner.userMessage(conv, "разреши блендер всегда, не спрашивай", { channel: "web" });
    await until(() => hub.store.listMessages(conv, { limit: 500 }).some((m) => m.role === "assistant" && m.status === "complete" && JSON.stringify(m.parts).includes("разреши блендер")), "the reply");
    expect(await say('CALL hub_permission_always {"tool":"blender"}')).toContain("Allowed: blender_* runs without approval for every agent");
    expect(hub.approvals.list(["pending"])).toHaveLength(0);
    expect(await say('CALL blender_execute_blender_code {"code":"import bpy"}')).toBe("tool said: ran");
    expect(hub.approvals.list(["pending"])).toHaveLength(0);

    // Not in the person's words: a card first.
    const asked = say('CALL hub_permission_always {"tool":"linear"}');
    const card = await pending("hub_permission_always");
    expect(card.summary).toBe("Let every agent use linear (1) without asking");
    hub.approvals.resolve(card.id, "approve", { via: "web" });
    expect(await asked).toContain("Allowed: linear_*");
    // The hub's own tools are never allowed this way.
    expect(await say('CALL hub_permission_always {"tool":"hub_settings_update"}')).toMatch(/not allowed this way/);
  });

  it("finds \"always\" and the name in the person's words, in either alphabet", () => {
    expect(saidAlways(["разреши Блендер всегда"], ["blender"])).toBe(true);
    expect(saidAlways(["always allow linear please"], ["linear"])).toBe(true);
    expect(saidAlways(["разреши блендер"], ["blender"])).toBe(false);
    expect(saidAlways(["всегда спрашивай про linear"], ["blender"])).toBe(false);
    expect(saidAlways(["всегда спрашивай про блендер"], ["blender"])).toBe(false);
    expect(saidAlways(["always ask before blender runs code"], ["blender"])).toBe(false);
  });
});
