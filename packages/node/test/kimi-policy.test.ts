// Kimi Code on a machine has no sandbox: what it asks before running follows the owner's policy.json. Commands only
// with exec on (and in its allowlist), writes only in its workspace and the allowed folders with fs.write on.
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kimiAllowed } from "../src/brains.ts";
import { defaultPolicy, normalizePolicy, policySummary } from "../src/policy.ts";

describe("Kimi Code under a machine's policy", () => {
  const home = mkdtempSync(join(tmpdir(), "piomio-node-kimi-"));
  const ws = join(home, "piomio-workspace", "a", "c1");
  mkdirSync(ws, { recursive: true });

  it("is on by default and shows in the policy summary", () => {
    const p = normalizePolicy({}, home);
    expect(p.brains.kimi).toEqual({ enabled: true });
    expect(policySummary(p).at(-1)).toMatch(/^Kimi Code: /);
    expect(normalizePolicy({ brains: { kimi: { enabled: false, command: "~/bin/kimi" } } }, home).brains.kimi).toEqual({ enabled: false, command: join(home, "bin", "kimi") });
  });

  it("runs commands only as exec allows, writes only in its folders", () => {
    const p = defaultPolicy(home);
    expect(kimiAllowed(p, "Bash", { command: "ls" }, ws)).toBe(false);
    expect(kimiAllowed(p, "Write", { path: "notes.md" }, ws)).toBe(true);
    expect(kimiAllowed(p, "Edit", { path: join(home, ".ssh", "config") }, ws)).toBe(false);
    expect(kimiAllowed({ ...p, fs: { read: true, write: false } }, "Write", { path: "notes.md" }, ws)).toBe(false);
    const exec = { ...p, exec: { enabled: true, allowCommands: ["npm test"] } };
    expect(kimiAllowed(exec, "Bash", { command: "npm test" }, ws)).toBe(true);
    expect(kimiAllowed(exec, "Bash", { command: "rm -rf ~" }, ws)).toBe(false);
    expect(kimiAllowed(p, "CronCreate", {}, ws)).toBe(false);
  });
});
