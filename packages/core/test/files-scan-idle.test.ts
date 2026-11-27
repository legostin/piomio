// A hub nobody syncs files with leaves its workspaces alone: scanning a big tree every few seconds burned a core and
// the battery of a desktop hub that had neither replicas nor machines. A peer reading the journal wakes the scan.
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";

const fixtures = join(import.meta.dirname, "fixtures");

describe("the hub's file scan", () => {
  it("stays off until a replica or machine reads the journal", async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const dataDir = mkdtempSync(join(tmpdir(), "owl-files-idle-"));
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir, builtinPluginsDirs: [], builtinAgentsDir: join(fixtures, "agents"), ownNode: false },
    );
    const hub = new Hub(config);
    await hub.start();
    try {
      mkdirSync(join(dataDir, "workspaces", "assistant"), { recursive: true });
      writeFileSync(join(dataDir, "workspaces", "assistant", "notes.md"), "hi");
      await new Promise((r) => setTimeout(r, 300));
      expect(hub.cluster.files.scanning).toBe(false);
      // What a machine's or a replica's round does every few seconds.
      expect(hub.cluster.files.changesSince(0).changes).toEqual([]);
      expect(hub.cluster.files.scanning).toBe(true);
      const until = Date.now() + 10_000;
      while (!hub.cluster.files.changesSince(0).changes.length && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      expect(hub.cluster.files.changesSince(0).changes.map((c) => c.path)).toEqual(["assistant/notes.md"]);
    } finally {
      await hub.stop();
    }
    expect(hub.cluster.files.scanning).toBe(false);
  });
});
