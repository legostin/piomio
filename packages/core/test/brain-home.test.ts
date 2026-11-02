// Where the brain CLIs keep their logins: the data dir by default, the user's own home in the desktop app.
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

describe("brain home", () => {
  it("is <data>/home/agent by default", () => {
    expect(loadConfig({}, { dataDir: "/srv/owl" }).brainHome).toBe(join("/srv/owl", "home", "agent"));
  });

  it("follows PIOMIO_BRAIN_HOME, as the desktop app sets it", () => {
    expect(loadConfig({ PIOMIO_BRAIN_HOME: "/Users/u" }, { dataDir: "/srv/owl" }).brainHome).toBe("/Users/u");
  });
});
