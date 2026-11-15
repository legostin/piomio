// A plugin that signs in to an account itself: it keeps the session's key in the vault (ctx.vault.put / remove), only
// under an id its manifest names and only as its own item, and says how its own catalog card stands with an entry
// under its own id.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallContext } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { cleanVaultFields } from "../src/plugins/host.ts";
import { listIntegrations } from "../src/integrations.ts";

const fixtures = join(import.meta.dirname, "fixtures");

describe("a plugin's own secret and its own card", () => {
  let hub: Hub;
  const ctx = (): ToolCallContext => ({ conversationId: hub.store.agentConversation("assistant").id, agentId: "assistant", sessionId: "s", callId: "c", machineId: "local", workspace: tmpdir(), tainted: false, background: false });
  const call = async (name: string, input: unknown) => {
    const r = await hub.tools.get(`keeper_${name}`)!.invoke(input, ctx());
    return { text: (r.content[0] as { text: string }).text, isError: !!r.isError };
  };
  const card = async () => (await listIntegrations(hub, "en")).find((i) => i.id === "keeper");

  beforeAll(async () => {
    const plugins = mkdtempSync(join(tmpdir(), "owl-own-secret-plugins-"));
    cpSync(join(fixtures, "own-secret-plugins", "keeper"), join(plugins, "keeper"), { recursive: true });
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-own-secret-")), builtinPluginsDirs: [plugins], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    hub.vault.init("own-secret-test-passphrase");
    await hub.plugins.setEnabled("keeper", true);
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("takes a few named strings as a secret's fields, nothing else", () => {
    expect(cleanVaultFields({ value: "k", "dc.id": "2" })).toEqual({ value: "k", "dc.id": "2" });
    for (const bad of [undefined, null, "k", ["k"], {}, { value: 1 }, { value: "" }, { "bad key": "k" }, { value: "x".repeat(64 * 1024 + 1) }, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]))]) {
      expect(cleanVaultFields(bad)).toBeUndefined();
    }
  });

  it("stores its own secret in the vault: readable by this plugin alone, and kept out of what it is told", async () => {
    expect(await call("put", { ref: "vault://keeper_session", fields: { value: "session-key-1" }, name: "Keeper session" })).toEqual({ text: "stored", isError: false });
    const meta = hub.vault.getMeta("keeper_session")!;
    expect(meta).toMatchObject({ type: "secret", name: "Keeper session" });
    expect(meta.scope.plugins).toEqual(["keeper"]);
    expect(hub.vault.read("keeper_session").fields).toEqual({ value: "session-key-1" });
    expect((await call("get", { ref: "keeper_session" })).isError).toBe(false);
    // Storing it again replaces it and keeps the name.
    await call("put", { ref: "keeper_session", fields: { value: "session-key-2" } });
    expect(hub.vault.read("keeper_session").fields).toEqual({ value: "session-key-2" });
    expect(hub.vault.getMeta("keeper_session")!.name).toBe("Keeper session");
    expect(hub.audit.list({ limit: 50 }).some((e) => e.actor === "plugin:keeper" && e.action === "vault.upsert" && e.target === "keeper_session")).toBe(true);
  });

  it("refuses an id its manifest does not name, an item that is not its own, and fields that are not strings", async () => {
    expect((await call("put", { ref: "someone_elses", fields: { value: "x" } })).isError).toBe(true);
    expect(hub.vault.getMeta("someone_elses")).toBeUndefined();
    // Named in its permissions, but the person's: any plugin may read it, so this one may not overwrite or remove it.
    hub.vault.upsert({ id: "shared_key", type: "secret", name: "Shared key", fields: { value: "theirs" } });
    expect((await call("put", { ref: "shared_key", fields: { value: "mine" } })).isError).toBe(true);
    expect((await call("remove", { ref: "shared_key" })).isError).toBe(true);
    expect(hub.vault.read("shared_key").fields).toEqual({ value: "theirs" });
    expect((await call("put", { ref: "keeper_session", fields: { value: 5 } })).isError).toBe(true);
    expect(hub.vault.read("keeper_session").fields).toEqual({ value: "session-key-2" });
  });

  it("removes its own secret, and asking for it afterwards says it is not there", async () => {
    expect(await call("remove", { ref: "keeper_session" })).toEqual({ text: "removed", isError: false });
    expect(hub.vault.getMeta("keeper_session")).toBeUndefined();
    expect(await call("remove", { ref: "keeper_session" })).toEqual({ text: "removed", isError: false });
    expect((await call("get", { ref: "keeper_session" })).isError).toBe(true);
    // Stored again after that: the plugin reads it at once, not the remembered "not there".
    await call("put", { ref: "keeper_session", fields: { value: "session-key-3" } });
    expect((await call("get", { ref: "keeper_session" })).text).toContain("session-key-3");
  });

  it("says how its own card stands with an entry under its own id, which is not a card of its own", async () => {
    expect(await card()).toMatchObject({ status: "connected", connect: "setup" });
    await call("report", { entries: [{ id: "keeper", status: "needs-setup", connect: "setup" }] });
    expect(await card()).toMatchObject({ status: "needs-setup" });
    await call("report", { entries: [{ id: "keeper", status: "connected", connect: "setup", account: "@lena" }] });
    expect(await card()).toMatchObject({ status: "connected", account: "@lena" });
    await call("report", { entries: [{ id: "keeper", status: "broken", connect: "setup", detail: "Signed out elsewhere" }] });
    expect(await card()).toMatchObject({ status: "broken", detail: "Signed out elsewhere" });
    expect((await listIntegrations(hub, "en")).some((i) => i.id === "keeper:keeper")).toBe(false);
    // Off: the report no longer counts.
    await hub.plugins.setEnabled("keeper", false);
    expect(await card()).toMatchObject({ status: "off" });
  });
});
