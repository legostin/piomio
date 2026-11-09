import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDef, BrainEvent } from "@piomio/shared";
import { PolicyStore } from "../src/policy.ts";
import { BrainHost } from "../src/brains.ts";

const ENV_CLAUDE = fileURLToPath(new URL("./fixtures/env-claude.mjs", import.meta.url));
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "obn-brains-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const agent = { id: "a", name: "a", description: "", brains: [], initiative: 0, tools: [], skills: [], policyProfile: "default", budget: { backgroundRunsPerDay: 0 }, prompt: "", source: "builtin" } as AgentDef;

describe("BrainHost", () => {
  const home = join(root, "home");
  const userHome = join(root, "user");
  const policy = new PolicyStore(home, { userHome });
  const raw = JSON.parse(readFileSync(policy.file, "utf8"));
  raw.brains["claude-code"].command = ENV_CLAUDE;
  raw.brains["claude-code"].allowedTools = ["Read", "mcp__piomio"];
  raw.brains.codex.enabled = false;
  writeFileSync(policy.file, JSON.stringify(raw));
  const host = new BrainHost({ home, policy, hubUrl: "http://hub.test:8080", bridgeCommand: ["bridge-cmd"] });

  it("probes enabled brains and reports disabled ones as unavailable", async () => {
    const clis = await host.probeAll();
    expect(clis.find((c) => c.brainId === "claude-code")).toMatchObject({ available: true, authenticated: true, version: "1.0.0" });
    expect(clis.find((c) => c.brainId === "codex")).toMatchObject({ available: false, detail: "disabled in policy.json" });
    expect(host.available().map((b) => b.id)).toEqual(["claude-code"]);
    await expect(host.probe({ brainId: "codex" })).rejects.toThrow(/disabled/);
    await expect(host.probe({ brainId: "gemini" })).rejects.toThrow(/Unknown brain/);
  });

  it("runs sessions in the workspace with the owner's tools and only harmless hub env", async () => {
    await host.create({
      brainId: "claude-code",
      opts: {
        sessionId: "s1",
        agent,
        workspace: "a/c1",
        mcp: { url: "http://elsewhere/mcp", token: "t", bridgeCommand: [] },
        systemPrompt: "sys",
        env: { TZ: "Europe/Moscow", NODE_OPTIONS: "--require /tmp/evil.js", ANTHROPIC_BASE_URL: "http://evil.test" },
        background: false,
      },
    });
    const events: BrainEvent[] = [];
    process.env.PIOMIO_NODE_HOME = home; // daemon env must not leak into the brain
    try {
      await host.send({ sessionId: "s1", turn: { text: "hi" } }, (e) => events.push(e));
    } finally {
      delete process.env.PIOMIO_NODE_HOME;
    }
    expect(events.at(-1)).toMatchObject({ type: "done" });
    const ws = join(userHome, "piomio-workspace", "a", "c1");
    const seen = JSON.parse(readFileSync(join(ws, "env.json"), "utf8"));
    expect(seen.cwd.toLowerCase()).toBe(ws.toLowerCase());
    expect(seen.TZ).toBe("Europe/Moscow");
    expect(seen.NODE_OPTIONS).not.toBe("--require /tmp/evil.js");
    expect(seen.ANTHROPIC_BASE_URL).not.toBe("http://evil.test");
    expect(seen.PIOMIO_NODE_HOME).toBeNull();
    expect(seen.args[seen.args.indexOf("--allowedTools") + 1]).toBe("Read,mcp__piomio");
    const mcp = JSON.parse(readFileSync(join(home, "brains", "claude-code", "sessions", "s1", "mcp.json"), "utf8")).mcpServers.piomio;
    expect(mcp.command).toBe("bridge-cmd");
    expect(mcp.env.PIOMIO_URL).toBe("http://hub.test:8080/mcp");
    await host.closeAll();
    expect(host.sessionCount).toBe(0);
  });

  it("keeps a session in this computer's sandbox with nobody to ask, when the daemon confines its sessions (a hub replica's own)", async () => {
    const asked: Array<[string, string]> = [];
    const confined = new BrainHost({
      home,
      policy,
      hubUrl: "http://hub.test:8080",
      bridgeCommand: ["bridge-cmd"],
      confine: (workspace, brainId) => (asked.push([workspace, brainId]), { denyRead: [join(root, "hub-data")], allowRead: [workspace] }),
    });
    await confined.create({
      brainId: "claude-code",
      // The hub never asks a paired computer to confine; whatever it sends, the daemon's own sandbox applies.
      opts: { sessionId: "s-confined", agent, workspace: "a/c2", mcp: { url: "", token: "t", bridgeCommand: [] }, systemPrompt: "sys", env: {}, background: false, confine: { denyRead: [], allowRead: ["/"], permissionTool: "native_permission" } },
    });
    const events: BrainEvent[] = [];
    await confined.send({ sessionId: "s-confined", turn: { text: "hi" } }, (e) => events.push(e));
    expect(events.at(-1)).toMatchObject({ type: "done" });
    const ws = join(userHome, "piomio-workspace", "a", "c2");
    expect(asked).toEqual([[ws, "claude-code"]]);
    const seen = JSON.parse(readFileSync(join(ws, "env.json"), "utf8"));
    // The file tools leave the allow list and no permission tool asks the hub: past the sandbox, the answer is no.
    expect(seen.args[seen.args.indexOf("--allowedTools") + 1]).toBe("mcp__piomio");
    expect(seen.args).not.toContain("--permission-prompt-tool");
    const settings = JSON.parse(readFileSync(seen.args[seen.args.indexOf("--settings") + 1], "utf8"));
    expect(settings.sandbox.filesystem).toEqual({ denyRead: [join(root, "hub-data")], allowRead: [ws] });
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
    await confined.closeAll();
  });

  it("waits for the person's files to come over from the hub before the turn, and goes on if one never does", async () => {
    const ws = join(userHome, "piomio-workspace", "a", "c2");
    const opts = { sessionId: "s2", agent, workspace: "a/c2", mcp: { url: "http://hub.test/mcp", token: "t", bridgeCommand: [] }, systemPrompt: "sys", env: {}, background: false };
    await host.create({ brainId: "claude-code", opts });
    // File sync brings it a moment later.
    setTimeout(() => { mkdirSync(join(ws, "attachments"), { recursive: true }); writeFileSync(join(ws, "attachments", "shot.jpeg"), "jpeg"); }, 300);
    const events: BrainEvent[] = [];
    await host.send({ sessionId: "s2", turn: { text: "what is this", attachments: ["attachments/shot.jpeg"] } }, (e) => events.push(e));
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(statSync(join(ws, "env.json")).mtimeMs).toBeGreaterThanOrEqual(statSync(join(ws, "attachments", "shot.jpeg")).mtimeMs);
    const late = new BrainHost({ home, policy, hubUrl: "http://hub.test:8080", bridgeCommand: ["bridge-cmd"], filesWaitMs: 100 });
    await late.create({ brainId: "claude-code", opts: { ...opts, sessionId: "s3" } });
    const done: BrainEvent[] = [];
    await late.send({ sessionId: "s3", turn: { text: "and this", attachments: ["attachments/never.jpeg"] } }, (e) => done.push(e));
    expect(done.at(-1)).toMatchObject({ type: "done" });
    await late.closeAll();
    await host.closeAll();
  });

  it("fetches the person's files from the hub before the turn, only into its folder and only the bytes it was told", async () => {
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const asked: string[] = [];
    const fetching = new BrainHost({
      home, policy, hubUrl: "http://hub.test:8080", bridgeCommand: ["bridge-cmd"], filesWaitMs: 100,
      fetchFile: async (path) => (asked.push(path), path.endsWith("bad.jpeg") ? Buffer.from("other bytes") : Buffer.from("jpeg")),
    });
    const ws = join(userHome, "piomio-workspace", "a", "c4");
    await fetching.create({ brainId: "claude-code", opts: { sessionId: "s4", agent, workspace: "a/c4", mcp: { url: "http://hub.test/mcp", token: "t", bridgeCommand: [] }, systemPrompt: "sys", env: {}, background: false } });
    const files = [
      { path: "attachments/shot.jpeg", source: "a/c4/attachments/shot.jpeg", sha: sha("jpeg") },
      { path: "attachments/bad.jpeg", source: "a/c4/attachments/bad.jpeg", sha: sha("jpeg") },
      { path: "../escape.jpeg", source: "a/escape.jpeg", sha: sha("jpeg") },
    ];
    await fetching.send({ sessionId: "s4", turn: { text: "look", attachments: ["attachments/shot.jpeg"], files } }, () => {});
    expect(readFileSync(join(ws, "attachments", "shot.jpeg"), "utf8")).toBe("jpeg");
    expect(statSync(join(ws, "env.json")).mtimeMs).toBeGreaterThanOrEqual(statSync(join(ws, "attachments", "shot.jpeg")).mtimeMs);
    expect(existsSync(join(ws, "attachments", "bad.jpeg"))).toBe(false);
    expect(existsSync(join(ws, "..", "escape.jpeg"))).toBe(false);
    expect(asked).toEqual(["a/c4/attachments/shot.jpeg", "a/c4/attachments/bad.jpeg"]);
    // Already there with the same bytes: nothing is fetched again.
    await fetching.send({ sessionId: "s4", turn: { text: "again", attachments: ["attachments/shot.jpeg"], files: files.slice(0, 1) } }, () => {});
    expect(asked).toHaveLength(2);
    await fetching.closeAll();
  });

  it("refuses hub values that would turn into CLI flags", async () => {
    const base = { sessionId: "s3", agent, workspace: "a/c3", mcp: { url: "", token: "t", bridgeCommand: [] }, systemPrompt: "", env: {}, background: false };
    await expect(host.create({ brainId: "claude-code", opts: { ...base, resume: "--dangerously-skip-permissions" } })).rejects.toThrow(/resume/);
    await expect(host.create({ brainId: "claude-code", opts: { ...base, model: "-x" } })).rejects.toThrow(/model/);
    await host.create({ brainId: "claude-code", opts: { ...base, model: "sonnet[1m]", resume: "0f8e1c2a-1b2c-4d5e-8f90-123456789abc" } });
    await host.closeAll();
  });

  it("refuses unknown sessions and disabled brains", async () => {
    await expect(host.send({ sessionId: "nope", turn: { text: "x" } }, () => {})).rejects.toThrow(/Unknown brain session/);
    // Nothing to join: the hub sends the input as the next turn.
    expect(await host.steer({ sessionId: "nope", turn: { text: "x" } })).toBe(false);
    await expect(host.create({ brainId: "codex", opts: { sessionId: "s2", workspace: "a/b" } as any })).rejects.toThrow(/disabled/);
  });
});

describe("BrainHost with the hub's setup", () => {
  const home = join(root, "home-key");
  const userHome = join(root, "user-key");
  const policy = new PolicyStore(home, { userHome });
  const raw = JSON.parse(readFileSync(policy.file, "utf8"));
  raw.brains["claude-code"].command = ENV_CLAUDE;
  raw.brains.codex.enabled = false;
  writeFileSync(policy.file, JSON.stringify(raw));
  const opened: string[] = [];
  const gateway = {
    port: 45123,
    configured: undefined as any,
    configure(s: any) {
      this.configured = s;
    },
    open(sessionId: string) {
      opened.push(sessionId);
      return `owlgw-${sessionId}`;
    },
    close() {},
  };
  const host = new BrainHost({ home, policy, gateway: gateway as any, hubUrl: "http://hub.test:8080", bridgeCommand: ["bridge-cmd"] });
  const models = [
    { id: "claude-sonnet-5-5", provider: "anthropic", price: { input: 3, output: 15 } },
    { id: "claude-haiku-5-5", provider: "anthropic", price: { input: 1, output: 5 } },
  ];

  it("lists only the allowed models, signed in once the hub sent a key", async () => {
    host.applySetup({ brains: { "claude-code": { auth: "key", models, providers: [] } } });
    expect(gateway.configured.wires.anthropic.models).toEqual(models);
    const waiting = await host.probe({ brainId: "claude-code" });
    expect(waiting).toMatchObject({ available: true, authenticated: false, models: ["claude-sonnet-5-5", "claude-haiku-5-5"], model: "claude-haiku-5-5" });
    host.applySetup({ brains: { "claude-code": { auth: "key", models, providers: [{ id: "anthropic", key: "sk-ant-x" }] } }, limit: { usd: 5, period: "month", spent: 1, resetsAt: "2026-11-01T00:00:00.000Z" } });
    expect(gateway.configured.limit).toEqual({ usd: 5, spent: 1 });
    const ready = await host.probe({ brainId: "claude-code" });
    expect(ready).toMatchObject({ authenticated: true, detail: "API key from the hub (Anthropic)" });
    expect(ready.catalog?.map((c) => c.id)).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5"]);
    host.applySetup({ sealed: true, brains: { "claude-code": { auth: "key", models, providers: [] } } });
    expect(await host.probe({ brainId: "claude-code" })).toMatchObject({ authenticated: false, detail: "API key mode: waiting for the hub's vault to be unlocked" });
  });

  it("points a key-mode session at the gateway with its own token and keeps it on the allowed models", async () => {
    host.applySetup({ brains: { "claude-code": { auth: "key", models, providers: [{ id: "anthropic", key: "sk-ant-x" }] } } });
    await host.create({
      brainId: "claude-code",
      opts: { sessionId: "k1", agent, workspace: "a/k1", mcp: { url: "", token: "t", bridgeCommand: [] }, systemPrompt: "", env: {}, background: false, model: "claude-opus-5-5" },
    });
    await host.send({ sessionId: "k1", turn: { text: "hi" } }, () => {});
    const seen = JSON.parse(readFileSync(join(userHome, "piomio-workspace", "a", "k1", "env.json"), "utf8"));
    expect(seen.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:45123");
    expect(seen.ANTHROPIC_AUTH_TOKEN).toBe("owlgw-k1");
    expect(seen.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-haiku-5-5");
    // The opus it asked for is not allowed: the cheapest allowed one runs.
    expect(seen.args[seen.args.indexOf("--model") + 1]).toBe("claude-haiku-5-5");
    expect(seen.CLAUDE_CODE_SUBAGENT_MODEL).toBe("claude-haiku-5-5");
    expect(opened).toEqual(["k1"]);
    await host.closeAll();
  });
});
