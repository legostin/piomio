// The trigger engine is part of the hub and keeps the id the Triggers plugin had ("triggers": its storage, its tools'
// owner, its webhook addresses). No plugin may take that id: not installed, and not loaded from a folder on disk, or it
// would replace the engine's tools, receive its HTTP and webhooks, and take its storage with it when uninstalled.
import { afterAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";
import { hubDbFile, openDb } from "../src/db.ts";

const hubs: Hub[] = [];

/** A plugin folder whose manifest says `id`. */
function pluginDir(parent: string, id: string): string {
  const dir = join(parent, id);
  mkdirSync(join(dir, ".piomio-plugin"), { recursive: true });
  writeFileSync(join(dir, ".piomio-plugin", "plugin.json"), JSON.stringify({ id, name: "Look-alike", permissions: {} }));
  return dir;
}

function hubWith(dataDir: string, builtinPluginsDirs: string[] = []): Hub {
  const config = loadConfig({ TZ: "UTC", PIOMIO_DEVICES: "0" }, { dataDir, builtinPluginsDirs, plugins: "none" });
  const hub = new Hub(config);
  hubs.push(hub);
  hub.plugins.discover();
  return hub;
}

afterAll(() => {
  for (const h of hubs) h.db.close();
});

describe("the id the trigger engine keeps", () => {
  it("is refused to a plugin being installed, and nothing staged is left behind", async () => {
    const hub = hubWith(mkdtempSync(join(tmpdir(), "piomio-core-ids-")));
    const src = pluginDir(mkdtempSync(join(tmpdir(), "piomio-core-ids-src-")), "triggers");
    await expect(hub.plugins.prepareInstall(src)).rejects.toThrow(/part of Piomio itself/);
    const staging = join(hub.plugins.installedDir, ".staging");
    expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([]);
    expect(hub.plugins.get("triggers")).toBeUndefined();
  });

  it("is not loaded from a plugin folder on disk, installed or built in", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "piomio-core-ids-"));
    // An install record and its folder, as an older hub could have left them.
    pluginDir(join(dataDir, "plugins"), "triggers");
    const db = openDb(hubDbFile(dataDir));
    db.prepare("insert into plugins(id, dir, source, enabled, granted, installed_at, settings) values (?, ?, ?, ?, ?, ?, ?)").run(
      "triggers",
      join(dataDir, "plugins", "triggers"),
      "installed",
      1,
      "{}",
      "2026-10-01T00:00:00Z",
      "{}",
    );
    db.close();
    // And a built-in folder under that id (an old checkout's leftover with its manifest).
    const builtin = mkdtempSync(join(tmpdir(), "piomio-core-ids-builtin-"));
    pluginDir(builtin, "triggers");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const hub = hubWith(dataDir, [builtin]);
      expect(hub.plugins.get("triggers")).toBeUndefined();
      expect(hub.plugins.list().map((p) => p.id)).not.toContain("triggers");
      expect(errors.mock.calls.filter((c) => String(c[0]).includes("part of the hub itself"))).toHaveLength(2);
    } finally {
      errors.mockRestore();
    }
  });
});
