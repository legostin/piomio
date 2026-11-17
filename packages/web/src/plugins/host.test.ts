import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createStore, Emitter } from "../lib/store";
import { refreshBootstrap, session } from "../state/app";
import { toast } from "../state/toast";
import { pluginLoad, syncUiPlugins, unloadAllUiPlugins } from "./host";
import { registry } from "./registry";

vi.mock("../state/app", () => ({
  hubEvents: new Emitter(),
  sendToHub: vi.fn(),
  session: createStore(null),
  refreshBootstrap: vi.fn(async () => {}),
}));
vi.mock("../state/toast", () => ({ toast: vi.fn() }));

afterEach(() => {
  unloadAllUiPlugins();
  vi.mocked(toast).mockClear();
  vi.mocked(refreshBootstrap).mockReset();
  session.set(null);
});

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

describe("a UI plugin whose module does not load", () => {
  // A module that is not there: the hub listed it, then no longer has it.
  const missing = () => ({ id: "triggers", name: "Triggers", url: pathToFileURL(join(mkdtempSync(join(tmpdir(), "piomio-ui-gone-")), "index.mjs")).href, messages: {} });

  it("is dropped without a word when the hub no longer lists it (another replica took the lead between the list and the import)", async () => {
    const entry = missing();
    vi.mocked(refreshBootstrap).mockImplementation(async () => session.set({ uiPlugins: [] } as any));
    await syncUiPlugins([entry]);
    expect(refreshBootstrap).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
    expect(pluginLoad.get().triggers?.status).not.toBe("error");
  });

  it("is reported when the hub still lists it", async () => {
    const entry = missing();
    vi.mocked(refreshBootstrap).mockImplementation(async () => session.set({ uiPlugins: [entry] } as any));
    await syncUiPlugins([entry]);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast).mock.calls[0][1]).toBe("error");
    expect(pluginLoad.get().triggers?.status).toBe("error");
  });
});
