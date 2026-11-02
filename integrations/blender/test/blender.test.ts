// The Blender integration's launcher against a fake Blender and a fake of the official server: it finds Blender 5.1+,
// relays MCP, answers documentation tools without Blender, and on the first scene tool installs the official add-on
// from the release's source and opens Blender until the add-on listens.
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { candidates, findBlender, parseVersion } from "../mcp/blender.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const launch = join(import.meta.dirname, "..", "mcp", "launch.ts");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** A `blender` executable that runs the fake, and the file where it keeps what it was asked. */
function fakeBlender() {
  const dir = mkdtempSync(join(tmpdir(), "owl-blender-"));
  const bin = join(dir, "blender");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(fixtures, "fake-blender.mjs")}" "$@"\n`);
  chmodSync(bin, 0o755);
  const src = join(dir, "src");
  mkdirSync(join(src, "mcp"), { recursive: true });
  mkdirSync(join(src, "addon", "blender_mcp_addon"), { recursive: true });
  writeFileSync(join(src, "mcp", "pyproject.toml"), '[project]\nname = "blender-mcp"\n');
  writeFileSync(join(src, "addon", "blender_mcp_addon", "blender_manifest.toml"), 'id = "mcp"\nmaintainer = "Blender Lab"\n');
  const state = join(dir, "state.json");
  return { dir, bin, src, state, read: () => (existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : { calls: [] }) };
}

const windows: number[] = [];
afterAll(() => {
  for (const pid of windows) {
    try {
      process.kill(pid);
    } catch {}
  }
});

describe("finding Blender", () => {
  it("reads its version and wants 5.1 or newer", async () => {
    expect(parseVersion("Blender 5.3.0 Beta\n\tbuild date: 2026-10-09")).toEqual([5, 3, 0]);
    expect(parseVersion("Blender 4.2")).toEqual([4, 2, 0]);
    const b = fakeBlender();
    process.env.FAKE_BLENDER_STATE = b.state;
    expect(await findBlender({ BLENDER_PATH: b.bin })).toEqual({ bin: b.bin, version: "5.3.0" });
    process.env.FAKE_BLENDER_VERSION = "4.2.1";
    try {
      expect(await findBlender({ BLENDER_PATH: b.bin })).toMatchObject({ missing: expect.stringContaining("Blender 4.2.1 is too old") });
    } finally {
      delete process.env.FAKE_BLENDER_VERSION;
    }
    expect(await findBlender({ BLENDER_PATH: join(b.dir, "nowhere") })).toMatchObject({ missing: expect.stringContaining("was not found") });
  });

  it("looks on PATH as well as where installers put it", () => {
    const b = fakeBlender();
    expect(candidates({ PATH: `/nonexistent:${b.dir}` }, "linux")).toContain(b.bin);
  });
});

describe("the launcher", () => {
  it("says why it cannot start: no Blender here", () => {
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", launch], {
      env: { ...process.env, BLENDER_PATH: join(tmpdir(), "no-blender-here"), BLENDER_MCP_DATA: mkdtempSync(join(tmpdir(), "owl-blender-data-")) },
      input: "",
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr.trim().split("\n").at(-1)).toMatch(/^Blender 5\.1 or newer was not found on this computer/);
  });

  it("relays the official server, installs the add-on and opens Blender when a scene tool needs it", { timeout: 60_000 }, async () => {
    const b = fakeBlender();
    const port = await freePort();
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--disable-warning=ExperimentalWarning", launch],
        env: {
          ...(process.env as Record<string, string>),
          BLENDER_PATH: b.bin,
          BLENDER_MCP_SOURCE: b.src,
          BLENDER_MCP_SERVER: JSON.stringify([process.execPath, join(fixtures, "fake-server.mjs")]),
          BLENDER_MCP_PORT: String(port),
          BLENDER_MCP_DATA: join(b.dir, "data"),
          FAKE_BLENDER_STATE: b.state,
        },
      }),
    );
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["get_objects_summary", "search_api_docs"]);

      // The documentation needs no Blender: nothing is installed or opened for it.
      const docs = await client.callTool({ name: "search_api_docs", arguments: {} });
      expect(docs.content).toEqual([{ type: "text", text: "bpy.ops.mesh.primitive_cube_add" }]);
      expect(b.read().addon).toBeUndefined();

      const scene = await client.callTool({ name: "get_objects_summary", arguments: {} });
      const s = b.read();
      if (s.window) windows.push(s.window);
      expect(scene.content).toEqual([{ type: "text", text: `Cube, Camera, Light | ${b.bin}` }]);
      // The add-on came from the release's own source, enabled in the user repository; Blender opened with online access,
      // as a window, or in the background on a Linux machine without a screen (a CI runner).
      const calls: string[][] = s.calls;
      expect(calls.find((c) => c.includes("build"))).toEqual(expect.arrayContaining(["--source-dir", join(b.src, "addon", "blender_mcp_addon")]));
      expect(calls.find((c) => c.includes("install-file"))).toEqual(expect.arrayContaining(["--repo", "user_default", "--enable"]));
      const screen = platform() !== "linux" || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
      expect(calls.at(-1)).toEqual(screen ? ["--online-mode"] : ["--background", "--online-mode", "--command", "blender_mcp", "--port", String(port)]);

      // Blender is open now: the next call goes straight through.
      const before = b.read().calls.length;
      expect((await client.callTool({ name: "get_objects_summary", arguments: {} })).isError).toBeFalsy();
      expect(b.read().calls.length).toBe(before);
    } finally {
      await client.close();
    }
  });
});
