// A plugin's own catalog entries (the Composio plugin's Slack, GitHub…): shown with the outside service's badge even
// while the plugin is off, their state as the plugin reports it (bad reports dropped), sign-in and sign-out through
// the plugin with the chat that started it hearing the result, entries added at runtime, and popularity by entry.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cpSync, mkdtempSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallContext } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { cleanCatalogReport } from "../src/plugins/host.ts";
import { entryRef, listCatalog, listIntegrations, logoFile } from "../src/integrations.ts";

const fixtures = join(import.meta.dirname, "fixtures");

async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("a plugin's catalog entries", () => {
  let hub: Hub;
  const entry = async (id: string, locale: "en" | "ru" = "en") => (await listIntegrations(hub, locale)).find((i) => i.id === id);
  const call = (conversationId: string): ToolCallContext => ({ conversationId, agentId: "assistant", sessionId: "s", callId: "c", machineId: "local", workspace: tmpdir(), tainted: false, background: false });

  beforeAll(async () => {
    const plugins = mkdtempSync(join(tmpdir(), "owl-entries-plugins-"));
    cpSync(join(fixtures, "entry-plugins", "outside"), join(plugins, "outside"), { recursive: true });
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-entries-")), builtinPluginsDirs: [plugins], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("reads entry ids and drops what a report cannot show", () => {
    expect(entryRef("composio:slack")).toEqual({ pluginId: "composio", entryId: "slack" });
    expect(entryRef("weather")).toBeUndefined();
    expect(entryRef("composio:Slack")).toBeUndefined();
    expect(
      cleanCatalogReport([
        { id: "ok", status: "connected", connect: "signin", account: "  a@b  ", extra: 1 },
        { id: "ok", status: "broken", connect: "signin" },
        { id: "bad id", status: "connected", connect: "signin" },
        { id: "odd", status: "weird", connect: "signin" },
        { id: "odd2", status: "connected", connect: "google" },
        "junk",
      ]),
    ).toEqual([{ id: "ok", status: "connected", connect: "signin", account: "a@b" }]);
    expect(cleanCatalogReport(Array.from({ length: 300 }, (_, i) => ({ id: `e${i}`, status: "needs-setup", connect: "setup" })))).toHaveLength(200);
  });

  it("lists the manifest's entries while the plugin is off, with the outside service's badge", async () => {
    expect(await entry("outside")).toMatchObject({ name: "Outside", connect: "setup", status: "off" });
    // The service's own card is the service itself: no badge of its own.
    expect((await entry("outside"))!.via).toBeUndefined();
    expect(await entry("outside:chat")).toEqual({
      id: "outside:chat",
      name: "Chat",
      summary: "Messages in Chat",
      category: "communication",
      icon: "message-square",
      connect: "signin",
      status: "off",
      plugin: "outside",
      signinReturn: false,
      via: { name: "Outside", about: "Chat goes through Outside, an outside service.", link: "https://outside.example" },
      logo: expect.stringMatching(/^\/api\/integrations\/outside%3Achat\/logo\?v=[0-9a-z]+$/),
      example: "What is new in Chat?",
    });
    expect((await entry("outside:chat", "ru"))!.via!.about).toBe("Chat работает через Outside, внешний сервис.");
    const c = await listCatalog(hub, "en");
    expect(c.sections.find((s) => s.id === "communication")!.items.map((i) => i.id)).toContain("outside:chat");
    // The built-in pick of an entry counts among the popular ones.
    expect(c.popular).toEqual(["outside:chat"]);
  });

  it("serves a card's logo only when it is a small PNG inside its plugin", async () => {
    expect(logoFile(hub, "outside:chat")).toMatch(/outside[\\/]logos[\\/]chat\.png$/);
    // The plugin's own "logo" is text named .png: no logo, the icon stays.
    expect(logoFile(hub, "outside")).toBeUndefined();
    expect((await entry("outside"))!.logo).toBeUndefined();
    expect(logoFile(hub, "outside:nothing")).toBeUndefined();
    expect(logoFile(hub, "weather")).toBeUndefined();
  });

  it("turns on with its plugin and waits for its key", async () => {
    await hub.plugins.setEnabled("outside", true);
    await until(() => hub.plugins.catalogOf("outside"), "the plugin's report");
    // The report's junk (a bad id, a duplicate, an unknown status) is dropped.
    expect(hub.plugins.catalogOf("outside")!.map((e) => e.id)).toEqual(["chat"]);
    expect(await entry("outside:chat")).toMatchObject({ status: "needs-setup", connect: "setup", plugin: "outside" });
    const list = await hub.tools.get("hub_integrations_list")!.invoke({}, call(hub.store.agentConversation("assistant").id));
    expect((list.content[0] as { text: string }).text).toContain("outside:chat — Chat [communication] (through Outside, an outside service): needs-setup");
  });

  it("signs in through the plugin once the key is in, and the chat that asked hears it", async () => {
    hub.vault.init("entries-test-passphrase");
    hub.vault.upsert({ id: "outside_key", type: "secret", name: "Outside key", fields: { value: "k" } });
    await until(async () => (await entry("outside:chat"))?.connect === "signin", "the Sign in step");
    const conv = hub.store.agentConversation("assistant");
    const told = vi.spyOn(hub.runner, "tellAgent").mockImplementation(() => {});
    const card = await hub.tools.get("hub_integration_connect")!.invoke({ id: "outside:chat" }, call(conv.id));
    expect((card.content[0] as { text: string }).text).toContain("It goes through Outside, an outside service");
    expect((card.content[0] as { text: string }).text).toContain("allow everything the service's page asks for (tick every box");

    expect(await hub.entrySignIn("outside:chat", conv.id)).toBe("https://outside.example/link/chat");
    await until(async () => (await entry("outside:chat"))?.status === "connected", "the entry connected");
    expect(await entry("outside:chat")).toMatchObject({ status: "connected", account: "chat@outside" });
    expect(hub.tools.get("outside_chat_read")).toBeDefined();
    await until(() => told.mock.calls.length > 0, "the agent told");
    expect(told).toHaveBeenCalledWith(conv.id, expect.stringContaining("The user signed in to Chat (outside:chat); it works now and its tools are available: outside_chat_read"));
    told.mockRestore();
  });

  it("shows entries the plugin adds and breaks, signs out, and counts an entry's tool uses for it", async () => {
    const conv = hub.store.agentConversation("assistant");
    await hub.tools.get("outside_add_notes")!.invoke({}, call(conv.id));
    await until(() => entry("outside:notes"), "the added entry");
    expect(await entry("outside:notes")).toMatchObject({ name: "Notes", summary: "An app through Outside", category: "work", icon: "notebook", plugin: "outside", connect: "signin" });
    expect((await entry("outside:notes", "ru"))!.summary).toBe("Приложение через Outside");
    expect((await entry("outside:notes"))!.via!.about).toBe("Notes goes through Outside, an outside service.");

    await hub.tools.get("outside_break")!.invoke({ id: "chat" }, call(conv.id));
    await until(async () => (await entry("outside:chat"))?.status === "broken", "the broken entry");
    expect((await entry("outside:chat", "ru"))!.detail).toBe("Вход отозван");

    for (let i = 0; i < 3; i++) hub.audit.append("agent:assistant", "policy.decision", "outside_chat_read", { decision: "allow" });
    expect((await listCatalog(hub, "en")).popular[0]).toBe("outside:chat");

    await hub.entrySignOut("outside:chat");
    await until(async () => (await entry("outside:chat"))?.status === "needs-setup", "the signed-out entry");
    expect(hub.tools.get("outside_chat_read")).toBeUndefined();
  });

  it("keeps only the manifest's entries once the plugin is off, and cannot sign one in then", async () => {
    await hub.plugins.setEnabled("outside", false);
    expect(hub.plugins.catalogOf("outside")).toBeUndefined();
    expect(await entry("outside:notes")).toBeUndefined();
    expect(await entry("outside:chat")).toMatchObject({ status: "off" });
    await expect(hub.entrySignIn("outside:chat")).rejects.toThrow(/not running/);
    await expect(hub.entrySignIn("weather")).rejects.toThrow(/No such integration/);
  });
});
