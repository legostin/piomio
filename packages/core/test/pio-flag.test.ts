// PIOMIO_PIO: Pio, the always-on companion, is not ready for everyone yet. Without the flag the hub does not load the
// plugin at all: no catalog entry, no offer after the intro, no "Turn on Pio" line, no companion agent, no overlay page,
// and an install under its id is refused. Discovery only: no plugin process is started.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";
import { pendingOffers } from "../src/plugins/offers.ts";

const repoPlugins = join(import.meta.dirname, "..", "..", "..", "plugins");
const hubs: Hub[] = [];

function hubWith(env: Record<string, string>): Hub {
  const config = loadConfig({ TZ: "UTC", PIOMIO_DEVICES: "0", ...env }, { dataDir: mkdtempSync(join(tmpdir(), "piomio-pio-flag-")), builtinPluginsDirs: [repoPlugins], plugins: "none" });
  const hub = new Hub(config);
  hubs.push(hub);
  hub.plugins.discover();
  return hub;
}

afterAll(() => {
  for (const h of hubs) h.db.close();
});

describe("PIOMIO_PIO", () => {
  it("is off unless set to 1", () => {
    expect(loadConfig({}).pio).toBe(false);
    expect(loadConfig({ PIOMIO_PIO: "true" }).pio).toBe(false);
    expect(loadConfig({ PIOMIO_PIO: "1" }).pio).toBe(true);
  });

  it("off: Pio is not loaded, offered or waiting under the default agent", () => {
    const hub = hubWith({});
    expect(hub.plugins.get("pio")).toBeUndefined();
    expect(pendingOffers(hub.plugins.list(), []).map((o) => o.id)).not.toContain("pio");
    expect(hub.plugins.waiting("en").map((w) => w.id)).not.toContain("pio");
    expect(hub.plugins.get("memory")?.source).toBe("builtin");
  });

  it("off: an install under Pio's id is refused", async () => {
    const hub = hubWith({});
    await expect(hub.plugins.prepareInstall(join(repoPlugins, "pio"))).rejects.toThrow(/built-in/);
  });

  it("on: Pio ships off with its offer, as before", () => {
    const hub = hubWith({ PIOMIO_PIO: "1" });
    expect(hub.plugins.get("pio")?.source).toBe("builtin");
    expect(hub.plugins.get("pio")?.enabled).toBe(false);
    expect(pendingOffers(hub.plugins.list(), []).map((o) => o.id)).toContain("pio");
    expect(hub.plugins.waiting("en").map((w) => w.id)).toContain("pio");
  });
});
