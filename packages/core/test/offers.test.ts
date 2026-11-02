// A built-in plugin that ships off with an offer: the default agent puts it to the person once, after the intro, and
// never again (a restart, another replica), nor when the plugin is on already.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";
import { agentFromMarkdown } from "../src/agents.ts";
import { OFFERS_KEY, pendingOffers } from "../src/plugins/offers.ts";
import type { PluginRecord } from "../src/plugins/host.ts";

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

const record = (id: string, o: { source?: "builtin" | "installed"; enabled?: boolean; offer?: string }): PluginRecord =>
  ({ id, source: o.source ?? "builtin", enabled: !!o.enabled, layout: { manifest: { offer: o.offer } } }) as unknown as PluginRecord;

describe("pendingOffers", () => {
  it("offers built-in plugins that are off, carry an offer and were not offered", () => {
    const records = [
      record("pio", { offer: "An owl on the screen." }),
      record("on", { enabled: true, offer: "Already on." }),
      record("plain", {}),
      record("theirs", { source: "installed", offer: "Not ours to offer." }),
      record("told", { offer: "Offered before." }),
    ];
    expect(pendingOffers(records, ["told"])).toEqual([{ id: "pio", offer: "An owl on the screen." }]);
  });
});

describe("the offer in the chat", () => {
  let hub: Hub;
  let conv = "";
  const offers = () =>
    hub.store.listMessages(conv, { limit: 500 }).filter((m) => m.role === "system" && (m.parts[0] as { text?: string })?.text?.startsWith("[System] New in Piomio"));

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      {
        dataDir: mkdtempSync(join(tmpdir(), "owl-offers-")),
        builtinPluginsDirs: [join(fixtures, "plugins"), join(fixtures, "offer-plugins")],
        builtinAgentsDir: join(fixtures, "agents"),
      },
    );
    hub = new Hub(config);
    await hub.start();
    hub.saveAgent(agentFromMarkdown("desk", "---\nname: Desk\ndescription: Front desk\nbrains: [fake@local]\n---\nYou are Desk.", "user"), "user");
    hub.settings.update({ defaultAgent: "desk" });
    conv = hub.store.agentConversation("desk").id;
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("waits for the person and the hub to meet", () => {
    expect(hub.setup.firstRun()).toBe(true);
    expect(hub.offerPlugins()).toEqual([]);
    expect(offers()).toHaveLength(0);
  });

  it("offers once the hub has started talking, and only once", () => {
    hub.settings.setKey("setup", { kickoffDone: true });
    expect(hub.offerPlugins()).toEqual(["fakeoffer"]);
    expect(hub.offerPlugins()).toEqual([]);
    const notes = offers();
    expect(notes).toHaveLength(1);
    const text = (notes[0].parts[0] as { text: string }).text;
    expect(text).toContain("- fakeoffer: It shows a friendly owl over every window.");
    expect(text).toContain("show_choices");
    expect(text).toContain("hub_plugin_enable");
    expect(hub.settings.getKey<string[]>(OFFERS_KEY, [])).toEqual(["fakeoffer"]);
  });

  it("lists the plugin as waiting for the sidebar while it is off", () => {
    expect(hub.plugins.waiting("en")).toEqual([{ id: "fakeoffer", name: "Fake offer" }]);
  });

  it("does not offer a plugin the person turned on", async () => {
    hub.settings.setKey(OFFERS_KEY, []);
    await hub.plugins.setEnabled("fakeoffer", true);
    expect(hub.offerPlugins()).toEqual([]);
    expect(offers()).toHaveLength(1);
    expect(hub.plugins.waiting("en")).toEqual([]);
  });
});
