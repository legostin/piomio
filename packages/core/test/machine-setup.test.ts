// A machine's setup: brains on a subscription or a key, allowed models with prices, a spend limit; the keys reach the
// machine from the vault only while it is unlocked; past the limit its key-mode brains rest until the period ends.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { EventBus } from "../src/bus.ts";
import { AuditLog } from "../src/audit.ts";
import { VaultService } from "../src/vault/service.ts";
import { MachineSetups, normalizeSettings, periodOf, SetupError } from "../src/machine-setup.ts";

const dir = mkdtempSync(join(tmpdir(), "obt-setup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const usage = (usd: number, at = "2026-10-30T10:00:00.000Z") =>
  ({ brainId: "codex", provider: "openai", model: "gpt-6-luna", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, usd, at }) as const;

describe("machine setup", () => {
  const db = openDb(join(dir, "piomio.db"));
  const bus = new EventBus();
  const vault = new VaultService(join(dir, "vault.db"));
  vault.init("correct horse battery staple");
  vault.upsert({ id: "openai_api_key", type: "secret", name: "OpenAI API key", fields: { value: "sk-test-123" } });
  let now = new Date("2026-10-30T12:00:00Z");
  let apiKeys = true;
  const setups = new MachineSetups({ db, bus, audit: new AuditLog(db), vault: () => vault, apiKeys: () => apiKeys, now: () => now });

  it("refuses what cannot work and says why", () => {
    expect(() => normalizeSettings({ brains: { gemini: { auth: "key" } } })).toThrow(SetupError);
    expect(() => normalizeSettings({ brains: { codex: { auth: "key", providers: ["anthropic"], models: [{ id: "x", price: { input: 1, output: 1 } }] } } })).toThrow(/Codex takes OpenAI/);
    expect(() => normalizeSettings({ brains: { codex: { auth: "key", providers: ["openai"], models: [{ id: "gpt-6-luna" }] } } })).toThrow(/needs a price/);
    expect(() => normalizeSettings({ brains: { codex: { auth: "key", providers: ["openai"], models: [{ id: "--danger", price: { input: 1, output: 1 } }] } } })).toThrow(/not a model id/);
    expect(() => normalizeSettings({ brains: {}, limit: { usd: 0 } })).toThrow(/limit/);
    expect(normalizeSettings({ brains: { "claude-code": { auth: "subscription", models: ["claude-haiku-5-5"] } } })).toEqual({
      brains: { "claude-code": { auth: "subscription", models: [{ id: "claude-haiku-5-5" }] } },
    });
  });

  it("gives the machine its keys only while the vault is unlocked", () => {
    setups.set("mach_vps", {
      brains: { codex: { auth: "key", providers: ["openai"], models: [{ id: "gpt-6-luna", price: { input: 0.2, output: 1.6 } }] }, "claude-code": { auth: "subscription" } },
      limit: { usd: 5, period: "month" },
    });
    const open = setups.nodeSetup("mach_vps");
    expect(open.sealed).toBeUndefined();
    expect(open.brains.codex).toEqual({ auth: "key", models: [{ id: "gpt-6-luna", provider: "openai", price: { input: 0.2, output: 1.6 } }], providers: [{ id: "openai", key: "sk-test-123" }] });
    expect(open.brains["claude-code"]).toEqual({ auth: "subscription", models: [] });
    expect(open.limit).toMatchObject({ usd: 5, period: "month", spent: 0, resetsAt: "2026-11-01T00:00:00.000Z" });
    vault.seal();
    const sealed = setups.nodeSetup("mach_vps");
    expect(sealed.sealed).toBe(true);
    expect(sealed.brains.codex?.providers).toEqual([]);
    expect(setups.view("mach_vps").keys).toEqual(["openai"]);
  });

  it("counts spend and rests the key-mode brains past the limit until the period ends", () => {
    expect(setups.record("mach_vps", usage(3))).toBe(false);
    expect(setups.record("mach_vps", usage(2.5))).toBe(true);
    expect(setups.spent("mach_vps")).toBe(5.5);
    const limits = db.prepare("select brain_ref, until from brain_limits order by brain_ref").all();
    expect(limits).toEqual([{ brain_ref: "codex@mach_vps", until: "2026-11-01T00:00:00.000Z" }]);
    // A higher limit lets them work again.
    setups.set("mach_vps", { ...setups.get("mach_vps"), limit: { usd: 50, period: "month" } });
    expect(db.prepare("select count(*) as n from brain_limits").get()).toEqual({ n: 0 });
    // A new month starts from zero.
    now = new Date("2026-11-02T09:00:00Z");
    expect(setups.spent("mach_vps")).toBe(0);
    expect(periodOf("day", now)).toEqual({ since: "2026-11-02", resetsAt: "2026-11-03T00:00:00.000Z" });
  });

  it("without PIOMIO_API_KEYS: no key mode, stored key mode runs on the machine's own sign-in", () => {
    apiKeys = false;
    try {
      const key = { brains: { codex: { auth: "key", providers: ["openai"], models: [{ id: "gpt-6-luna", price: { input: 0.2, output: 1.6 } }] } } };
      expect(() => normalizeSettings(key, false)).toThrow(/PIOMIO_API_KEYS/);
      expect(() => setups.set("mach_other", key)).toThrow(SetupError);
      // mach_vps still has key mode stored from before: the machine gets a subscription and no keys.
      vault.unlock("correct horse battery staple");
      expect(setups.get("mach_vps").brains.codex?.auth).toBe("key");
      expect(setups.nodeSetup("mach_vps").brains.codex).toEqual({ auth: "subscription", models: [] });
      const view = setups.view("mach_vps");
      expect(view.keys).toEqual([]);
      expect(view.settings.brains.codex).toEqual({ auth: "subscription" });
    } finally {
      apiKeys = true;
    }
  });
});
