// Quiet looks (runner.tellQuietly, core method conversations.tell with quiet): the companion looks on its own; a reply
// with nothing to say leaves no trace, one with something to say shows, and the person's own turn comes first. Also the
// companion agent (AgentDef.companion) and its live state on the team list (core method agents.presence).
// Runs the scripted fake brain (test/fixtures/plugins/fakebrain): "QUIET?" answers "[quiet]", "SLOW" keeps a turn going.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { agentFromMarkdown } from "../src/agents.ts";
import { createCoreCall } from "../src/core-call.ts";
import { quietSaid } from "../src/runner.ts";

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
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const textOf = (m: Message) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");

describe("quietSaid", () => {
  it("tells a remark from nothing to say", () => {
    expect(quietSaid("")).toBe(false);
    expect(quietSaid("  [quiet]  ")).toBe(false);
    expect(quietSaid("[QUIET] nothing")).toBe(false);
    expect(quietSaid("Сохрани файл — ты его не сохранял 20 минут.")).toBe(true);
  });
});

describe("quiet looks and the companion", () => {
  let hub: Hub;
  let conv = "";
  const deleted: string[] = [];
  const shown: Message[] = [];
  let call: ReturnType<typeof createCoreCall>;

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    // A plugin that ships the companion: its agents dir has pio.md.
    const plugins = mkdtempSync(join(tmpdir(), "owl-quiet-plugins-"));
    mkdirSync(join(plugins, "owl", ".piomio-plugin"), { recursive: true });
    mkdirSync(join(plugins, "owl", "agents"), { recursive: true });
    writeFileSync(join(plugins, "owl", ".piomio-plugin", "plugin.json"), JSON.stringify({ id: "owl", name: "Owl", permissions: { core: ["conversations.tell", "agents.presence"] } }));
    writeFileSync(join(plugins, "owl", "agents", "pio.md"), "---\nname: Pio\ndescription: Always next to you\ncompanion: true\nbrains: [fake@local]\n---\nYou are Pio.");
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-quiet-")), builtinPluginsDirs: [join(fixtures, "plugins"), plugins], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    hub.saveAgent(agentFromMarkdown("desk", "---\nname: Desk\ndescription: Front desk\nbrains: [fake@local]\n---\nYou are Desk.", "user"), "user");
    hub.settings.update({ defaultAgent: "desk" });
    conv = hub.store.agentConversation("pio").id;
    hub.bus.on("message.deleted", (m) => deleted.push(m.id));
    hub.bus.on("message.updated", (m: Message) => {
      if (m.conversationId === conv && !m.quiet && m.status === "complete") shown.push(m);
    });
    call = createCoreCall(hub);
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("knows the plugin's companion and keeps it from being the default agent", () => {
    expect(hub.agents.get("pio")?.companion).toBe(true);
    expect(() => hub.updateSettings({ defaultAgent: "pio" }, "test")).toThrow();
  });

  it("leaves no trace when the companion has nothing to say", async () => {
    const before = hub.store.listMessages(conv).length;
    const r = (await call("owl", "conversations.tell", { agentId: "pio", quiet: true, text: "[Watch] The person is in Figma.\nQUIET?" })) as { delivered?: string };
    expect(r.delivered).toBe("dialog");
    await until(() => deleted.length > 0 && !hub.runner.isRunning(conv), "the quiet reply to go");
    expect(hub.store.listMessages(conv)).toHaveLength(before);
    expect(hub.team.member("pio").unread).toBe(0);
  });

  it("shows what it has to say, with no note of the look in the dialog", async () => {
    const r = (await call("owl", "conversations.tell", { agentId: "pio", quiet: true, text: "[Watch] The person is in Figma.\nsay something" })) as { delivered?: string };
    expect(r.delivered).toBe("dialog");
    const kept = await until(() => shown.find((m) => textOf(m).includes("heard: say something")), "the remark");
    expect(hub.store.getMessage(kept.id)?.quiet).toBeUndefined();
    expect(hub.store.listMessages(conv).filter((m) => m.role === "system")).toHaveLength(0);
  });

  it("lets the person's own turn come first", async () => {
    void hub.runner.userMessage(conv, "wait for me SLOW", {});
    await until(() => hub.runner.isRunning(conv), "the person's turn");
    const r = (await call("owl", "conversations.tell", { agentId: "pio", quiet: true, text: "[Watch] still in Figma" })) as { skipped?: string };
    expect(r.skipped).toBe("busy");
    hub.runner.interrupt(conv);
    await until(() => !hub.runner.isRunning(conv), "the turn to end");
  });

  it("shows the companion's live state on the team list, for its own plugin only", async () => {
    await call("owl", "agents.presence", { agentId: "pio", presence: "listening" });
    expect(hub.team.member("pio").presence).toBe("listening");
    await call("owl", "agents.presence", { agentId: "pio", presence: null });
    expect(hub.team.member("pio").presence).toBeUndefined();
    await expect(call("owl", "agents.presence", { agentId: "desk", presence: "watching" })).rejects.toThrow(/not an agent of this plugin/);
    await expect(call("owl", "agents.presence", { agentId: "pio", presence: "dancing" })).rejects.toThrow(/presence must be/);
  });

  it("forgets the companion's state when its plugin stops saying it", async () => {
    hub.team.setPresence("pio", "driving", 100);
    expect(hub.team.member("pio").presence).toBe("driving");
    await until(() => hub.team.member("pio").presence === undefined, "the state to lapse");
  });
});
