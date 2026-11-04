import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createStore, Emitter } from "../lib/store";
import { pluginLoad, syncUiPlugins, unloadAllUiPlugins } from "./host";
import { registry } from "./registry";

vi.mock("../state/app", () => ({
  hubEvents: new Emitter(),
  sendToHub: vi.fn(),
  session: createStore(null),
}));
vi.mock("../state/toast", () => ({ toast: vi.fn() }));

afterEach(() => unloadAllUiPlugins());

describe("UI plugin updates", () => {
  it("replaces the loaded screen and translations when its revision changes without reloading the app", async () => {
    const dir = mkdtempSync(join(tmpdir(), "piomio-ui-update-"));
    const file = join(dir, "index.mjs");
    const source = (version: string) => `
      export function activate(ui) {
        return ui.routes.add({ path: "/office", title: "${version}: " + ui.i18n.t("title"), component: () => null });
      }
    `;
    writeFileSync(file, source("old"));
    const entry = { id: "office", name: "Office", url: `${pathToFileURL(file).href}?revision=1`, messages: { en: { title: "Old office" } } };
    await syncUiPlugins([entry]);
    expect(pluginLoad.get().office.status).toBe("active");
    expect(registry.get().routes.map((r) => r.title)).toEqual(["old: Old office"]);
    const originalKey = registry.get().routes[0].key;

    // Unrelated bootstrap updates leave the plugin mounted.
    await syncUiPlugins([entry]);
    expect(registry.get().routes[0].key).toBe(originalKey);

    writeFileSync(file, source("new"));
    await syncUiPlugins([{ ...entry, url: `${pathToFileURL(file).href}?revision=2`, messages: { en: { title: "New office" } } }]);
    expect(pluginLoad.get().office.status).toBe("active");
    expect(registry.get().routes.map((r) => r.title)).toEqual(["new: New office"]);
    expect(registry.get().routes[0].key).not.toBe(originalKey);

    await syncUiPlugins([]);
    expect(registry.get().routes).toEqual([]);
    expect(pluginLoad.get()).toEqual({});
  });
});
