// PIOMIO_API_KEYS: model access through plain API keys is off unless the hub is started with it. Off, the API brain is
// not loaded (its id stays the hub's), Codex gets no OpenAI key, and a key pasted in the chat still never reaches the
// model. Discovery only: no plugin process is started.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";

const repoPlugins = join(import.meta.dirname, "..", "..", "..", "plugins");
const hubs: Hub[] = [];

function hubWith(env: Record<string, string>): Hub {
  const config = loadConfig({ TZ: "UTC", PIOMIO_DEVICES: "0", ...env }, { dataDir: mkdtempSync(join(tmpdir(), "piomio-keys-")), builtinPluginsDirs: [repoPlugins], plugins: "none" });
  const hub = new Hub(config);
  hubs.push(hub);
  hub.plugins.discover();
  return hub;
}

afterAll(() => {
  for (const h of hubs) h.db.close();
});

describe("PIOMIO_API_KEYS", () => {
  it("is off unless set to 1", () => {
    expect(loadConfig({}).apiKeys).toBe(false);
    expect(loadConfig({ PIOMIO_API_KEYS: "true" }).apiKeys).toBe(false);
    expect(loadConfig({ PIOMIO_API_KEYS: "1" }).apiKeys).toBe(true);
  });

  it("off: the API brain is not loaded and Codex has no key", () => {
    const hub = hubWith({});
    expect(hub.plugins.get("brain-api")).toBeUndefined();
    const codex = hub.plugins.get("brain-codex")!;
    expect(codex.granted.vault).not.toContain("openai_api_key");
    const props = (codex.layout!.manifest.contributes.settings as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).not.toContain("apiKeyRef");
    expect(Object.keys(props)).toContain("command");
  });

  it("off: an install under the API brain's id is refused", async () => {
    const hub = hubWith({});
    await expect(hub.plugins.prepareInstall(join(repoPlugins, "brain-api"))).rejects.toThrow(/built-in/);
  });

  it("on: everything as before", () => {
    const hub = hubWith({ PIOMIO_API_KEYS: "1" });
    expect(hub.plugins.get("brain-api")?.source).toBe("builtin");
    const codex = hub.plugins.get("brain-codex")!;
    expect(codex.granted.vault).toContain("openai_api_key");
    expect(Object.keys((codex.layout!.manifest.contributes.settings as { properties: Record<string, unknown> }).properties)).toContain("apiKeyRef");
  });

  it("off: a key pasted in the chat still goes into the vault", () => {
    const hub = hubWith({});
    hub.vault.init("keys-flag-passphrase");
    const conv = hub.store.agentConversation("assistant").id;
    const key = `sk-ant-api03-${"x1Y2".repeat(10)}`;
    const r = hub.secrets.capture(`here it is: ${key}`, conv, "user");
    expect(r.text).toBe("here it is: vault://anthropic_api_key");
    expect(hub.vault.getMeta("anthropic_api_key")).toBeTruthy();
  });
});
