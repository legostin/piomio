// Brain CLIs the desktop hub installs on demand (<data>/tools) with its own npm.
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { CliTools, bundledNpmCli, cliToolSpecs, npmEnv, npmInvocation, withPath } from "../src/cli-tools.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "owl-clitools-"));

/** A stand-in for npm: records its arguments, then succeeds or fails the way FAKE_NPM in its cwd says. */
function fakeNpm(dir: string): (args: string[]) => { file: string; args: string[]; shell: boolean } {
  const script = join(dir, "fake-npm.mjs");
  writeFileSync(
    script,
    `import { appendFileSync, readFileSync } from "node:fs";
appendFileSync("calls.log", JSON.stringify(process.argv.slice(2)) + "\\n");
let mode = "ok";
try { mode = readFileSync("FAKE_NPM", "utf8").trim(); } catch {}
if (mode === "fail") { console.error("npm error code E404"); console.error("npm error 404 Not Found - GET https://registry.npmjs.org/x"); process.exit(1); }
if (mode === "hang") setInterval(() => {}, 1000);
`,
  );
  return (args) => ({ file: process.execPath, args: [script, ...args], shell: false });
}

describe("brain CLI installs", () => {
  it("knows where each official package puts its binary", () => {
    const mac = cliToolSpecs("darwin", "arm64", false);
    expect(mac.map((t) => t.brainId)).toEqual(["claude-code", "codex", "kimi"]);
    // Kimi Code is a Node script: its npm link, which the brain runs with the hub's Node.
    expect(mac[2]).toMatchObject({ pkg: "@moonshot-ai/kimi-code", dirs: [".bin"] });
    expect(mac[0].dirs).toEqual(["@anthropic-ai/claude-code-darwin-arm64"]);
    expect(mac[1].dirs[0]).toBe("@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin");
    expect(cliToolSpecs("linux", "x64", true)[0].dirs).toEqual(["@anthropic-ai/claude-code-linux-x64-musl"]);
    expect(cliToolSpecs("win32", "x64", false)[1].dirs[0]).toBe("@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin");
    // No Codex build for this platform: Claude Code and Kimi Code are offered.
    expect(cliToolSpecs("freebsd", "x64", false).map((t) => t.brainId)).toEqual(["claude-code", "kimi"]);
  });

  it("offers nothing when installs are off (Docker, user isolation)", () => {
    const off = new CliTools(tmp(), false);
    expect(off.forBrain("codex")).toBeUndefined();
    expect(off.binDirs()).toEqual([]);
    const on = new CliTools("/data", true, cliToolSpecs("darwin", "x64", false));
    expect(on.forBrain("codex")?.pkg).toBe("@openai/codex");
    expect(on.binDirs()).toContain(join("/data", "tools", "node_modules", "@anthropic-ai/claude-code-darwin-x64"));
  });

  it("runs the bundled npm through this Node, and puts tool dirs on the PATH", () => {
    const node = tmp();
    mkdirSync(join(node, "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(join(node, "node_modules", "npm", "bin", "npm-cli.js"), "");
    const exe = join(node, "node.exe");
    expect(bundledNpmCli(exe)).toBe(join(node, "node_modules", "npm", "bin", "npm-cli.js"));
    expect(npmInvocation(["ci"], exe)).toEqual({ file: exe, args: [join(node, "node_modules", "npm", "bin", "npm-cli.js"), "ci"], shell: false });
    // macOS/Linux layout: bin/node next to lib/node_modules/npm.
    const unix = tmp();
    mkdirSync(join(unix, "bin"));
    mkdirSync(join(unix, "lib", "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(join(unix, "lib", "node_modules", "npm", "bin", "npm-cli.js"), "");
    expect(bundledNpmCli(join(unix, "bin", "node"))).toBe(join(unix, "bin", "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));

    expect(withPath({ Path: "a", X: undefined }, ["b"], ["c"])).toEqual({ Path: ["b", "a", "c"].join(delimiter) });
    const env = npmEnv({ PATH: "p", PIOMIO_DATA_DIR: "/secret", HOME: "/h" }, exe);
    expect(env.PIOMIO_DATA_DIR).toBeUndefined();
    expect(env.PATH).toBe([node, "p"].join(delimiter));
    expect(env.HOME).toBe("/h");
  });

  it("installs into <data>/tools, keeping a package.json so a second CLI does not prune the first", async () => {
    const data = tmp();
    const tools = new CliTools(data, true, cliToolSpecs("linux", "x64", false));
    const npm = fakeNpm(data);
    await tools.install(tools.forBrain("claude-code")!, { npm });
    await tools.install(tools.forBrain("codex")!, { npm });
    expect(JSON.parse(readFileSync(join(data, "tools", "package.json"), "utf8")).name).toBe("piomio-tools");
    const calls = readFileSync(join(data, "tools", "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(calls.map((c: string[]) => c.at(-1))).toEqual(["@anthropic-ai/claude-code@latest", "@openai/codex@latest"]);
    expect(calls[0]).toContain("--ignore-scripts");
  });

  it("reports npm's last lines when the install fails, and stops on cancel", async () => {
    const data = tmp();
    const tools = new CliTools(data, true, cliToolSpecs("linux", "x64", false));
    const npm = fakeNpm(data);
    mkdirSync(join(data, "tools"), { recursive: true });
    writeFileSync(join(data, "tools", "FAKE_NPM"), "fail");
    await expect(tools.install(tools.forBrain("codex")!, { npm })).rejects.toThrow(/E404.*404 Not Found/);

    writeFileSync(join(data, "tools", "FAKE_NPM"), "hang");
    const ac = new AbortController();
    const pending = tools.install(tools.forBrain("codex")!, { npm, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(existsSync(join(data, "tools", "calls.log"))).toBe(true);
  });
});
