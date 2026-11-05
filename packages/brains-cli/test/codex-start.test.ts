// A Codex that fails to start is started again and, failing again, says why: it never drops the session to
// `codex exec` (whose commands have no network) unless that Codex really has no app-server. Agent sessions see only
// the hub's tools: the person's own Codex MCP servers, plugins and ChatGPT apps are off there.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BrainEvent, BrainSessionOptions } from "@piomio/shared";
import { createCodexProvider } from "../src/index.ts";
import { isolationConfig } from "../src/codex-isolation.ts";

const fakeCodex = join(import.meta.dirname, "fixtures", "fake-codex.mjs");
const proxy = "http://test-credential:x@127.0.0.1:41789";

async function collect(gen: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const text = (ev: BrainEvent[]) => ev.filter((e) => e.type === "text").map((e: any) => e.delta).join("");

function harness(fails: number, extraEnv: Record<string, string> = {}, over: Partial<BrainSessionOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "owl-cxs-"));
  const failFile = join(dir, "fails");
  writeFileSync(failFile, String(fails));
  const argsFile = join(dir, "args");
  const spawnsFile = join(dir, "spawns");
  const errors: string[] = [];
  const provider = createCodexProvider({ command: () => fakeCodex, stateDir: join(dir, "state"), error: (m) => errors.push(m) });
  const env = { FAKE_CODEX_APP_FAIL_FILE: failFile, FAKE_ARGS_FILE: argsFile, FAKE_CODEX_SPAWNS: spawnsFile, HOME: dir, ...extraEnv };
  const session = () =>
    provider.createSession({
      sessionId: `s_${Math.random().toString(36).slice(2)}`,
      agent: { id: "a", name: "A", brains: ["codex"] } as any,
      workspace: mkdtempSync(join(tmpdir(), "owl-cxs-work-")),
      mcp: { url: "http://x", token: "t", bridgeCommand: ["bridge"] },
      systemPrompt: "SYSTEM",
      env,
      background: false,
      ...over,
    } as BrainSessionOptions);
  const lines = () => (existsSync(argsFile) ? readFileSync(argsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const spawns = () => (existsSync(spawnsFile) ? readFileSync(spawnsFile, "utf8").trim().split("\n").filter(Boolean).length : 0);
  return { dir, session, lines, spawns, errors };
}

const confined = (): Partial<BrainSessionOptions> => ({
  confine: { denyRead: ["/private-hub"], allowRead: [], permissionTool: "native_permission", network: { allowedDomains: ["*"] } },
});

describe("a Codex that fails to start", () => {
  it("is started once more and answers, with no codex exec", async () => {
    const h = harness(1);
    const s = await h.session();
    const ev = await collect(s.send({ text: "hi" }));
    expect(text(ev)).toContain("echo:hi");
    expect(h.spawns()).toBe(2);
    expect(h.lines().some((l) => l.args?.[0] === "exec")).toBe(false);
    s.close?.();
  });

  it("failing again ends the turn with Codex's own error, never in codex exec", async () => {
    const h = harness(9);
    const s = await h.session();
    const ev = await collect(s.send({ text: "hi" }));
    const err = ev.find((e) => e.type === "error") as Extract<BrainEvent, { type: "error" }> | undefined;
    expect(err?.fatal).toBe(true);
    expect(err?.message).toContain("boom: state db locked");
    expect(h.lines().some((l) => l.args?.[0] === "exec")).toBe(false);
    expect(h.errors.join("\n")).toContain("boom");
    // The next turn tries the app-server again instead of staying broken.
    writeFileSync(join(h.dir, "fails"), "0");
    expect(text(await collect(s.send({ text: "again" })))).toContain("echo:again");
    s.close?.();
  });

  it("a Codex without an app-server runs codex exec and says its commands have no network", async () => {
    // A confined session with networking, as the runner makes for local tasks.
    const h = harness(0, { FAKE_CODEX_NO_APP: "1", HTTPS_PROXY: proxy }, confined());
    const s = await h.session();
    const ev = await collect(s.send({ text: "hi" }));
    expect(h.lines()[0].args[0]).toBe("exec");
    const warning = ev.find((e) => e.type === "warning") as Extract<BrainEvent, { type: "warning" }> | undefined;
    expect(warning?.message).toMatch(/no internet/);
    expect(text(ev)).toContain("exec:[System] Your shell has no network in this session");
    // Said once a session.
    const again = await collect(s.send({ text: "two" }));
    expect(again.some((e) => e.type === "warning")).toBe(false);
    expect(text(again)).toBe("exec:two\n");
  });
});

describe("agent sessions see only the hub's tools", () => {
  const toml = [
    "model = \"gpt-6\"",
    "[mcp_servers.jev-browser]",
    "command = \"node\"",
    "[mcp_servers.node_repl]",
    "command = \"x\"",
    "[mcp_servers.node_repl.env]",
    "A = \"1\"",
    "[mcp_servers.\"computer-use\"]",
    "url = \"http://127.0.0.1:1\"",
    "[mcp_servers.\"odd.name\"]",
    "command = \"y\"",
    "[mcp_servers.piomio]",
    "command = \"z\"",
    "[profiles.work.mcp_servers.inner]",
    "command = \"w\"",
  ].join("\n");

  it("reads the person's servers from CODEX_HOME or HOME/.codex", () => {
    const home = mkdtempSync(join(tmpdir(), "owl-cxi-"));
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), toml);
    const cfg = isolationConfig({ HOME: home });
    expect(cfg).toEqual(expect.arrayContaining(["features.plugins=false", "features.apps=false", "mcp_servers.jev-browser.enabled=false", "mcp_servers.node_repl.enabled=false", "mcp_servers.computer-use.enabled=false"]));
    expect(cfg.join(" ")).not.toContain("piomio");
    expect(cfg.join(" ")).not.toContain("odd.name");
    expect(cfg.join(" ")).not.toContain("inner");
    expect(cfg.filter((c) => c.startsWith("mcp_servers.node_repl"))).toHaveLength(1);
    const other = mkdtempSync(join(tmpdir(), "owl-cxi-home-"));
    writeFileSync(join(other, "config.toml"), "[mcp_servers.only_here]\ncommand = \"q\"\n");
    expect(isolationConfig({ HOME: home, CODEX_HOME: other })).toContain("mcp_servers.only_here.enabled=false");
    expect(isolationConfig({ HOME: join(home, "missing") })).toEqual(["features.plugins=false", "features.apps=false"]);
  });

  it("every session and the bare reviewer start with them off", async () => {
    for (const bare of [false, true]) {
      const h = harness(0, { FAKE_CODEX_LOG_APP_ARGS: "1" }, bare ? { bare: true } : {});
      mkdirSync(join(h.dir, ".codex"));
      writeFileSync(join(h.dir, ".codex", "config.toml"), toml);
      const s = await h.session();
      await collect(s.send({ text: "hi" }));
      const args: string[] = h.lines().find((l) => l.app)!.args;
      for (const c of ["features.plugins=false", "features.apps=false", "mcp_servers.jev-browser.enabled=false", "mcp_servers.computer-use.enabled=false"]) expect(args, `${c} bare=${bare}`).toContain(c);
      expect(args.filter((a) => a === "features.plugins=false")).toHaveLength(1);
      s.close?.();
    }
  });
});
