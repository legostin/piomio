import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyStore, defaultPolicy, normalizePolicy } from "../src/policy.ts";

const root = mkdtempSync(join(tmpdir(), "obn-policy-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("policy defaults", () => {
  it("creates policy.json with safe defaults on first run", () => {
    const home = join(root, "home1");
    const userHome = join(root, "user1");
    const logs: string[] = [];
    const store = new PolicyStore(home, { userHome, log: (m) => logs.push(m) });
    expect(existsSync(store.file)).toBe(true);
    const p = store.get();
    const ws = join(userHome, "piomio-workspace");
    expect(p.allowedDirs).toEqual([ws]);
    expect(p.workspacesRoot).toBe(ws);
    expect(existsSync(ws)).toBe(true);
    expect(p.exec.enabled).toBe(false);
    expect(p.fs).toEqual({ read: true, write: true });
    expect(p.brains["claude-code"].enabled).toBe(true);
    expect(p.brains["claude-code"].allowedTools).not.toContain("Bash");
    expect(p.brains["claude-code"].allowedTools).toEqual(expect.arrayContaining(["Read", "Write", "Edit", "Glob", "Grep", "mcp__piomio"]));
    expect(p.brains.codex).toEqual({ enabled: true, sandbox: "workspace-write" });
    expect(JSON.parse(readFileSync(store.file, "utf8"))).toEqual(defaultPolicy(userHome));
    expect(logs.some((l) => l.includes("created"))).toBe(true);
  });

  it("fills missing fields and expands ~", () => {
    const userHome = join(root, "u");
    const p = normalizePolicy({ allowedDirs: ["~/code", "~"], exec: { enabled: true } }, userHome);
    expect(p.allowedDirs).toEqual([join(userHome, "code"), userHome]);
    expect(p.workspacesRoot).toBe(join(userHome, "code"));
    expect(p.exec).toEqual({ enabled: true, allowCommands: [] });
    expect(p.fs.read).toBe(true);
    expect(p.brains.codex.sandbox).toBe("workspace-write");
  });

  it("rejects relative dirs, wrong types and unknown sandboxes", () => {
    expect(() => normalizePolicy({ allowedDirs: ["relative/dir"] })).toThrow(/absolute/);
    expect(() => normalizePolicy({ exec: { enabled: "yes" } })).toThrow(/exec.enabled/);
    expect(() => normalizePolicy({ brains: { codex: { sandbox: "none" } } })).toThrow(/sandbox/);
    expect(() => normalizePolicy([])).toThrow();
  });
});

describe("policy reload", () => {
  it("re-reads the file when it changes and notifies listeners", () => {
    const home = join(root, "home2");
    const userHome = join(root, "user2");
    const store = new PolicyStore(home, { userHome });
    const seen: boolean[] = [];
    store.onChange((p) => seen.push(p.exec.enabled));
    expect(store.get().exec.enabled).toBe(false);
    const raw = JSON.parse(readFileSync(store.file, "utf8"));
    raw.exec = { enabled: true, allowCommands: ["git *"] };
    raw.allowedDirs.push(join(userHome, "projects"));
    writeFileSync(store.file, JSON.stringify(raw, null, 2));
    const p = store.get();
    expect(p.exec.enabled).toBe(true);
    expect(p.exec.allowCommands).toEqual(["git *"]);
    expect(p.allowedDirs).toContain(join(userHome, "projects"));
    expect(seen).toEqual([true]);
  });

  it("keeps the last good policy when the file is broken", () => {
    const home = join(root, "home3");
    const logs: string[] = [];
    const store = new PolicyStore(home, { userHome: join(root, "user3"), log: (m) => logs.push(m) });
    const before = store.get();
    writeFileSync(store.file, "{ this is not json");
    expect(store.get()).toEqual(before);
    expect(logs.some((l) => l.includes("previous policy"))).toBe(true);
    writeFileSync(store.file, JSON.stringify({ exec: { enabled: true } }));
    expect(store.get().exec.enabled).toBe(true);
  });

  it("refuses to start with a broken policy file", () => {
    const home = join(root, "home4");
    new PolicyStore(home, { userHome: join(root, "user4") });
    writeFileSync(join(home, "policy.json"), "[]");
    expect(() => new PolicyStore(home, { userHome: join(root, "user4") })).toThrow(/policy.json/);
  });
});

describe("commands from the hub's chat", () => {
  it("turns commands on and off in the file, keeping the person's other fields as they wrote them", () => {
    const home = join(root, "home-commands");
    const userHome = join(root, "user-commands");
    const logs: string[] = [];
    const store = new PolicyStore(home, { userHome, log: (m) => logs.push(m) });
    const mine = { ...JSON.parse(readFileSync(store.file, "utf8")), exec: { enabled: false, allowCommands: ["blender*"] }, note: "mine" };
    writeFileSync(store.file, JSON.stringify(mine));
    expect(store.setCommands(true).exec).toMatchObject({ enabled: true, allowCommands: ["blender*"] });
    const written = JSON.parse(readFileSync(store.file, "utf8"));
    expect(written.exec).toEqual({ enabled: true, allowCommands: ["blender*"] });
    expect(written.note).toBe("mine");
    expect(store.setCommands(false).exec.enabled).toBe(false);
    expect(logs.some((l) => l.includes("commands turned on"))).toBe(true);
  });

  it("leaves them alone when the owner keeps the permissions on the computer", () => {
    const home = join(root, "home-owner");
    const store = new PolicyStore(home, { userHome: join(root, "user-owner") });
    writeFileSync(store.file, JSON.stringify({ ...JSON.parse(readFileSync(store.file, "utf8")), hubChanges: false }));
    expect(store.get().hubChanges).toBe(false);
    expect(() => store.setCommands(true)).toThrow(/keeps its permissions on the computer itself/);
    expect(store.get().exec.enabled).toBe(false);
  });
});
