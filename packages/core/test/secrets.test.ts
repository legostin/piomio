// Secrets in the chat: typed into cards or pasted into messages, they land in the vault and never reach the model,
// the stored conversation or the plugin hooks. Uses the scripted fake brain (test/fixtures/plugins/fakebrain).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const FAKE = "fk_abcdefghij0123456789";
const GITHUB = `ghp_${"a1B2".repeat(9)}`;
const CLAUDE_TOKEN = `sk-ant-oat01-${"Ab9_".repeat(20)}`;

async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("secrets in the chat", () => {
  let hub: Hub;
  let base = "";
  let cookie = "";
  let csrf = "";
  let conv = "";

  const req = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const r = await fetch(base + path, {
      method,
      headers: { origin: base, ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf": csrf } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await r.text();
    try {
      return { status: r.status, json: JSON.parse(text) };
    } catch {
      return { status: r.status, json: text };
    }
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await req(method, path, body);
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  const messages = async (): Promise<any[]> => ok("GET", `/api/conversations/${conv}/messages`);
  const allText = async () => JSON.stringify(await messages());
  /** Send a message and wait for the fake brain's reply to it. */
  const say = async (text: string, reply: RegExp) => {
    const sent = await ok("POST", `/api/conversations/${conv}/messages`, { text });
    return until(async () => {
      const msgs = await messages();
      const after = msgs.slice(msgs.findIndex((m) => m.id === sent.id) + 1);
      return after.find((m) => m.role === "assistant" && m.status !== "streaming" && m.parts.some((p: any) => p.type === "text" && reply.test(p.text)));
    }, `reply matching ${reply}`);
  };

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-secrets-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    base = config.publicUrl;
    await until(() => hub.brains.has("fake@local"), "fake brain");
    await ok("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    const boot = await ok("GET", "/api/bootstrap");
    csrf = boot.csrf;
    conv = boot.mainConversationId;
    await ok("PATCH", "/api/settings", { approvalInlineWaitSec: 1 });
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("drops a pasted secret while the vault does not exist yet, and says so", async () => {
    const reply = await say(`token ${FAKE} please`, /fake heard/);
    const text = await allText();
    expect(text).not.toContain(FAKE);
    expect(JSON.stringify(reply)).toMatch(/vault is locked/);
    expect((await messages()).some((m) => m.role === "system" && m.parts.some((p: any) => p.type === "error" && /vault is locked/.test(p.message)))).toBe(true);
  });

  it("creates the vault from the chat and can remember the passphrase", async () => {
    expect((await req("POST", "/api/vault/init", { passphrase: "short" })).status).toBe(400);
    expect(await ok("POST", "/api/vault/init", { passphrase: "chat-vault-pass", remember: true })).toEqual({ state: "unlocked" });
    expect(existsSync(hub.rememberedPassphraseFile())).toBe(true);
    hub.vault.seal();
    expect((await req("POST", "/api/vault/unlock", { passphrase: "wrong-pass-123" })).status).toBeGreaterThanOrEqual(400);
    expect(await ok("POST", "/api/vault/unlock", { passphrase: "chat-vault-pass", remember: false })).toEqual({ state: "unlocked" });
    expect(existsSync(hub.rememberedPassphraseFile())).toBe(false);
  });

  it("takes a pasted token out of the message, stores it and configures the plugin that declared it", async () => {
    const reply = await say(`here it is: ${FAKE}.`, /fake heard/);
    const user = (await messages()).filter((m) => m.role === "user").at(-1);
    expect(user.parts[0].text).toBe("here it is: vault://fake_token.");
    expect(JSON.stringify(reply)).toContain("vault://fake_token");
    expect(await allText()).not.toContain(FAKE);
    expect(hub.vault.read("fake_token").fields.value).toBe(FAKE);
    expect(hub.plugins.get("fakesetup")!.settings.tokenRef).toBe("vault://fake_token");

    await say(`gh: ${GITHUB}`, /fake heard/);
    expect(hub.vault.read("github_token").fields.value).toBe(GITHUB);
    expect(await allText()).not.toContain(GITHUB);
  });

  it("asks for a secret with a card; the value goes to the vault and the agent carries on", async () => {
    await say('CALL hub_secret_request {"vault":"svc_key","title":"Service key","hint":"From the dashboard"}', /tool said: A secure input card/);
    const card = (await messages()).flatMap((m) => m.parts).find((p: any) => p.type === "secret_request" && p.vaultId === "svc_key");
    expect(card).toMatchObject({ title: "Service key", status: "pending" });
    const before = await ok("GET", `/api/secret-requests/${card.requestId}`);
    expect(before).toMatchObject({ status: "pending", hint: "From the dashboard", vaultState: "unlocked" });

    const saved = await ok("POST", `/api/secret-requests/${card.requestId}`, { value: "s3cr3t-value-123" });
    expect(saved.status).toBe("saved");
    expect(JSON.stringify(saved)).not.toContain("s3cr3t-value-123");
    expect(hub.vault.read("svc_key").fields.value).toBe("s3cr3t-value-123");
    // The agent is told (by reference only) and continues.
    await until(async () => (await messages()).some((m) => m.role === "assistant" && JSON.stringify(m.parts).includes("The user stored Service key")), "continuation turn");
    expect(await allText()).not.toContain("s3cr3t-value-123");
    // The card shows the new state.
    expect((await messages()).flatMap((m) => m.parts).find((p: any) => p.type === "secret_request" && p.requestId === card.requestId).status).toBe("saved");
    expect((await req("POST", `/api/secret-requests/${card.requestId}`, { value: "again" })).status).toBe(409);
  });

  it("asks for a website's login with a card: kept as a login item for that site, which the browser may type", async () => {
    await say('CALL hub_secret_request {"title":"X","login":{"domain":"https://www.x.com/i/flow/login","username":"legostin"}}', /tool said: A secure input card/);
    const card = (await messages()).flatMap((m) => m.parts).find((p: any) => p.type === "secret_request" && p.vaultId === "login-x.com");
    expect(card).toMatchObject({ title: "X", status: "pending" });
    expect(await ok("GET", `/api/secret-requests/${card.requestId}`)).toMatchObject({ login: { domain: "x.com", username: "legostin" } });
    const saved = await ok("POST", `/api/secret-requests/${card.requestId}`, { username: "legostin", password: "pw-x-123456" });
    expect(saved.status).toBe("saved");
    const item = hub.vault.read("login-x.com");
    expect(item).toMatchObject({ type: "login", fields: { username: "legostin", password: "pw-x-123456" } });
    expect(item.scope.domains).toEqual(["x.com"]);
    expect(item.scope.plugins).toContain("browser");
    expect(await allText()).not.toContain("pw-x-123456");
    await say('CALL hub_secret_request {"title":"Nope","login":{"domain":"not a site"}}', /tool said: "not a site" is not a website's domain/);
  });

  it("takes a bare reply as the answer to the open card", async () => {
    await say('CALL hub_secret_request {"vault":"other_key","title":"Other key"}', /tool said: A secure input card/);
    await say("plain-token-value-xyz", /fake heard/);
    expect(hub.vault.read("other_key").fields.value).toBe("plain-token-value-xyz");
    expect(await allText()).not.toContain("plain-token-value-xyz");
    const user = (await messages()).filter((m) => m.role === "user").at(-1);
    expect(user.parts[0].text).toBe("vault://other_key");
  });

  it("never keeps a Claude subscription token: it leaves the message and cards unstored, and the agent offers the sign-in", async () => {
    const reply = await say(`my token ${CLAUDE_TOKEN}`, /fake heard/);
    expect(await allText()).not.toContain(CLAUDE_TOKEN);
    expect(JSON.stringify(reply)).toMatch(/hub_brain_login/);
    expect((await messages()).some((m) => m.role === "system" && m.parts.some((p: any) => p.type === "error" && /does not keep these/.test(p.message)))).toBe(true);
    expect(hub.vault.getMeta("claude_code_token")).toBeUndefined();

    // Nor as the answer to a card, bare in the chat or typed into it.
    await say('CALL hub_secret_request {"vault":"another_key","title":"Another key"}', /tool said: A secure input card/);
    await say(CLAUDE_TOKEN, /fake heard/);
    const card = (await messages()).flatMap((m) => m.parts).find((p: any) => p.type === "secret_request" && p.vaultId === "another_key");
    expect((await req("POST", `/api/secret-requests/${card.requestId}`, { value: CLAUDE_TOKEN })).status).toBe(400);
    expect(hub.vault.getMeta("another_key")).toBeUndefined();
    expect(await allText()).not.toContain(CLAUDE_TOKEN);
    await ok("POST", `/api/secret-requests/${card.requestId}/cancel`);
  });

  it("deletes a Claude subscription token an earlier version kept, once", () => {
    hub.vault.upsert({ id: "claude_code_token", type: "secret", name: "Claude Code token", fields: { value: CLAUDE_TOKEN } });
    expect(hub.forgetClaudeToken()).toBe(true);
    expect(hub.vault.getMeta("claude_code_token")).toBeUndefined();
    expect(hub.forgetClaudeToken()).toBe(false);
  });

  it("shows a plugin's setup card and stores its secrets write-only", async () => {
    const reply = await say('CALL hub_plugin_setup {"id":"fakesetup"}', /tool said: Setup card/);
    expect(JSON.stringify(reply)).toMatch(/Fake token \(vault:\/\/fake_token\) present/);
    expect((await messages()).flatMap((m) => m.parts).some((p: any) => p.type === "plugin_setup" && p.pluginId === "fakesetup")).toBe(true);

    const view = await ok("POST", "/api/plugins/fakesetup/secrets/fake_token", { value: "fk_zzzzzzzzzz0123456789" });
    expect(view.secrets).toEqual([expect.objectContaining({ vaultId: "fake_token", title: "Fake token", present: true, required: true })]);
    expect(hub.vault.read("fake_token").fields.value).toBe("fk_zzzzzzzzzz0123456789");
    expect((await req("POST", "/api/plugins/fakesetup/secrets/not_declared", { value: "x" })).status).toBe(404);
    expect((await req("POST", "/api/plugins/fakesetup/secrets/fake_token", { value: "   " })).status).toBe(400);
  });

  it("refuses a card for a plugin that cannot read the item", async () => {
    await say('CALL hub_secret_request {"vault":"svc_key","title":"x","plugin":"fakebrain"}', /tool said: .*not allowed to read/);
  });

  it("announces every vault change to plugins, the security console's too", async () => {
    const seen: string[][] = [];
    const off = hub.bus.on("vault.updated", (p) => seen.push(p.ids));
    try {
      // The chat stores once and the event comes once (from the vault itself).
      await say(`another: fk_yyyyyyyyyy0123456789`, /fake heard/);
      expect(seen).toEqual([["fake_token"]]);
      // The security console writes through the same vault (console-app.ts): storing, scoping and removing.
      hub.vault.upsert({ id: "console_key", type: "secret", name: "Console key", fields: { value: "c0ns0le-value-1" } });
      hub.vault.updateScope("console_key", { plugins: ["fakesetup"] });
      hub.vault.remove("console_key");
      hub.vault.remove("console_key");
      expect(seen).toEqual([["fake_token"], ["console_key"], ["console_key"], ["console_key"]]);
    } finally {
      off();
    }
  });

  it("logs a missing item once per plugin and hour, a refused existing one every time", () => {
    const denied = (target: string) => hub.audit.list({ action: "vault.denied", limit: 1000 }).filter((e) => e.target === target);
    const ask = (ref: string, plugin: string) => {
      try {
        hub.vault.access(ref, { actor: `plugin:${plugin}`, pluginId: plugin });
      } catch {
        /* denied */
      }
    };
    for (let i = 0; i < 20; i++) ask("vault://telegram_bot_token", "telegram");
    expect(denied("telegram_bot_token")).toEqual([expect.objectContaining({ actor: "plugin:telegram", data: { reason: "not_found" } })]);
    ask("vault://telegram_bot_token", "web");
    expect(denied("telegram_bot_token")).toHaveLength(2);
    // svc_key exists, and fakebrain is outside its scope: a real refusal, never folded.
    hub.vault.updateScope("svc_key", { plugins: ["fakesetup"] });
    for (let i = 0; i < 3; i++) ask("vault://svc_key", "fakebrain");
    expect(denied("svc_key")).toHaveLength(3);
    expect(denied("svc_key")[0].data).toMatchObject({ reason: expect.stringContaining("plugin fakebrain is outside the item's scope") });
  });
});
