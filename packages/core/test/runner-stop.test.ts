// A look at the tasks that was queued for the next tick (after a turn, at a task's end) can come after the hub has
// stopped and closed its database: it must do nothing, not throw from a timer nobody can catch.
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";

const fixtures = join(import.meta.dirname, "fixtures");

describe("the runner after the hub stopped", () => {
  it("does not look at the tasks in a closed database", async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-runner-stop-")), builtinPluginsDirs: [], builtinAgentsDir: join(fixtures, "agents") },
    );
    const hub = new Hub(config);
    await hub.start();
    expect(() => hub.runner.scheduleTasks()).not.toThrow();
    await hub.stop();
    // What a turn that ended just before the stop left on the next tick.
    expect(() => hub.runner.scheduleTasks()).not.toThrow();
    expect(() => hub.store.listTasks({ status: ["queued"], limit: 1 })).toThrow(/not open/);
  });
});
