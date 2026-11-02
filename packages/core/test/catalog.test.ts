// The catalog and plugin widgets: catalog plugins ship turned off, the catalog groups every card by situation (old
// categories included), and a plugin tool's widgets land in the conversation as `widget` parts, checked and redacted.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessagePart } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { listCatalog, listIntegrations, situationOf } from "../src/integrations.ts";

const fixtures = join(import.meta.dirname, "fixtures");

async function until<T>(fn: () => T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("the catalog and plugin widgets", () => {
  let hub: Hub;

  beforeAll(async () => {
    const plugins = mkdtempSync(join(tmpdir(), "owl-catalog-plugins-"));
    for (const id of ["cardy", "legacy", "plain"]) cpSync(join(fixtures, "catalog-plugins", id), join(plugins, id), { recursive: true });
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-catalog-")), builtinPluginsDirs: [plugins], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("maps old categories to situations", () => {
    expect(situationOf("calendar")).toBe("work");
    expect(situationOf("messaging")).toBe("communication");
    expect(situationOf("money")).toBe("money");
    expect(situationOf("whatever")).toBe("other");
  });

  it("ships catalog plugins turned off, and lists everything by situation", async () => {
    expect(hub.plugins.get("cardy")!.enabled).toBe(false);
    expect(hub.plugins.get("legacy")!.enabled).toBe(true);
    expect(hub.tools.get("cardy_show")).toBeUndefined();

    const en = await listCatalog(hub, "en");
    expect(en.sections.map((s) => [s.id, s.title, s.items.map((i) => i.id)])).toEqual([
      ["everyday", "Everyday", ["cardy"]],
      ["work", "Work & productivity", ["legacy"]],
      ["communication", "Communication", ["remote-access"]],
    ]);
    expect(en.sections[0].items[0]).toMatchObject({ name: "Cardy", status: "off", connect: "none", category: "everyday", example: "Show me a card" });
    const ru = await listCatalog(hub, "ru");
    expect(ru.sections[0]).toMatchObject({ title: "На каждый день", items: [{ example: "Покажи карточку" }] });
    // The library has the same cards, with the situation as their category.
    expect((await listIntegrations(hub, "en")).find((i) => i.id === "legacy")).toMatchObject({ category: "work", status: "connected" });
  });

  it("has every plugin in the Plugins panel's catalog, those without a card under More", async () => {
    const all = await listCatalog(hub, "en", { all: true });
    expect(all.sections.map((s) => s.id)).toEqual(["everyday", "work", "communication", "other"]);
    expect(all.sections.at(-1)).toMatchObject({ title: "More", items: [{ id: "plain", name: "Plain", summary: "A plugin without a catalog card", icon: "puzzle", connect: "none", status: "connected" }] });
    expect((await listCatalog(hub, "en")).sections.flatMap((s) => s.items).map((i) => i.id)).not.toContain("plain");
  });

  it("puts the hub's picks first among the popular, then what the agents use most", async () => {
    // Nothing used yet: the built-in pick (cardy, even while off).
    expect((await listCatalog(hub, "en", { all: true })).popular).toEqual(["cardy"]);
    // Calls of a plugin's tools, by its prefix (legacy has no tools registered), rank it above the picks.
    for (let i = 0; i < 3; i++) hub.audit.append("agent:assistant", "policy.decision", "legacy_lookup", { decision: "allow" });
    expect((await listCatalog(hub, "en", { all: true })).popular).toEqual(["legacy", "cardy"]);
  });

  it("puts a tool's declared widgets into the reply, redacted, and keeps them from the model", async () => {
    hub.vault.init("catalog-test-passphrase");
    hub.vault.upsert({ id: "cardy_token", type: "secret", name: "Cardy token", fields: { value: "vault-secret-value" } });
    await hub.plugins.setEnabled("cardy", true);
    const tool = await until(() => hub.tools.get("cardy_show"), "the cardy tool");
    const conv = hub.store.agentConversation("assistant");
    const r = await tool.invoke({ n: 7 }, { conversationId: conv.id, agentId: "assistant", sessionId: "s", callId: "call-1", machineId: "local", workspace: tmpdir(), tainted: false, background: false });
    expect(r).toEqual({ content: [{ type: "text", text: "A card is shown." }] });

    const widgets = hub.store
      .listMessages(conv.id)
      .flatMap((m) => m.parts)
      .filter((p): p is Extract<MessagePart, { type: "widget" }> => p.type === "widget");
    // The undeclared kind and the oversized card are dropped; the secret's value never reaches the conversation.
    expect(widgets).toHaveLength(1);
    expect(widgets[0]).toMatchObject({ type: "widget", plugin: "cardy", kind: "card", data: { n: 7 } });
    expect(JSON.stringify(widgets[0].data)).not.toContain("vault-secret-value");
    expect(hub.plugins.get("cardy")!.logs.map((l) => l.msg).join("\n")).toContain('widget "sneaky" is not declared');
  });

  it("survives a switch turned off and on again at once", async () => {
    await hub.plugins.setEnabled("cardy", false);
    expect(hub.tools.get("cardy_show")).toBeUndefined();
    await hub.plugins.setEnabled("cardy", true);
    // The old process exits after the new one started: that must not take the new one down.
    await new Promise((r) => setTimeout(r, 600));
    expect(hub.plugins.get("cardy")!.status).toBe("running");
    expect(hub.tools.get("cardy_show")).toBeDefined();
  });
});
