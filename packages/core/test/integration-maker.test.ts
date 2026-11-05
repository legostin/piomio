// Agents making integrations: the hub ships the make-integration skill (integrations/_template, which is not a
// plugin itself), and hub_plugin_install installs a folder from the agent's workspace once the person allows what it
// asks for, compiling its card; folders outside the workspace, other computers' folders and a "no" install nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { ToolCallContext, ToolResult } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const fixtures = join(import.meta.dirname, "fixtures");
const TEMPLATE = join(ROOT, "integrations", "_template");

async function until<T>(fn: () => T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("");

describe("agents making integrations", () => {
  let hub: Hub;
  let workspace: string;
  let ctx: ToolCallContext;

  /** What an agent writes following the skill: the template under its own id, as an installed (not built-in) plugin. */
  function build(id: string) {
    const dir = join(workspace, "integrations", id);
    cpSync(TEMPLATE, dir, { recursive: true, filter: (src) => !["SKILL.md", "dist", "node_modules"].includes(relative(TEMPLATE, src).split(sep).at(-1)!) });
    const file = join(dir, ".piomio-plugin", "plugin.json");
    const { builtin, defaultEnabled, ...manifest } = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...manifest, id }));
    return dir;
  }

  const install = (source: string, over: Partial<ToolCallContext> = {}) => hub.tools.get("hub_plugin_install")!.invoke({ source }, { ...ctx, ...over });
  const pending = () => hub.approvals.list(["pending"]).find((a) => a.tool === "hub_plugin_install");

  beforeAll(async () => {
    // The hub's built-in folder holds the template, as integrations/ does.
    const builtin = mkdtempSync(join(tmpdir(), "owl-maker-builtin-"));
    cpSync(TEMPLATE, join(builtin, "_template"), { recursive: true });
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), PIOMIO_LANG: "en", TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-maker-")), builtinPluginsDirs: [builtin], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    workspace = mkdtempSync(join(tmpdir(), "owl-maker-ws-"));
    const conversationId = hub.store.agentConversation("assistant").id;
    ctx = { conversationId, agentId: "assistant", sessionId: "s1", callId: "c1", machineId: "local", workspace, tainted: false, background: false };
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("ships the make-integration skill, and its template is not a plugin", () => {
    expect(hub.skills.get("make-integration")).toMatchObject({ source: "piomio" });
    expect(hub.skills.load("make-integration")).toContain("hub_plugin_install");
    expect(hub.plugins.list()).toEqual([]);
  });

  it("installs what the agent built once the person allows what it asks for, card included", async () => {
    build("sunny");
    const call = install("integrations/sunny");
    const ask = await until(pending, "the approval card");
    expect(ask.summary).toBe("Install the plugin “Sunrise and sunset” (sunny): internet: api.sunrise-sunset.org. A UI plugin gets full access to the interface (but not to the security console).");
    hub.approvals.resolve(ask.id, "approve", { via: "web" });
    const r = await call;
    expect(textOf(r)).toContain("Installed Sunrise and sunset (sunny) and turned it on");

    const rec = hub.plugins.get("sunny")!;
    expect(rec).toMatchObject({ source: "installed", enabled: true });
    // The card's one file, compiled by the hub: JSX gone, types gone, imports left to the page's import map.
    const ui = readFileSync(join(rec.dir, "ui", "dist", "index.js"), "utf8");
    expect(ui).toContain('from "react/jsx-runtime"');
    expect(ui).toContain('from "@piomio/ui"');
    expect(ui).not.toContain("import type");
    await until(() => hub.tools.get("sunny_times"), "the integration's tool");
  });

  it("installs nothing from outside the workspace, from another computer, or when the person says no", async () => {
    expect(textOf(await install("../elsewhere"))).toContain("Only a folder inside your workspace");
    expect(textOf(await install("integrations/sunny", { machineId: "laptop" }))).toContain("push the plugin to a git repository");

    build("cloudy");
    const call = install("integrations/cloudy");
    hub.approvals.resolve((await until(pending, "the approval card")).id, "deny", { via: "web" });
    expect(textOf(await call)).toBe("The user declined installing Sunrise and sunset (cloudy).");
    expect(hub.plugins.get("cloudy")).toBeUndefined();
    const staging = join(hub.config.dataDir, "plugins", ".staging");
    expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([]);
  });

  it("updates an integration it installed before", async () => {
    const previousUrl = hub.plugins.uiPlugins().find((p) => p.id === "sunny")!.url;
    hub.plugins.setSettings("sunny", { apiUrl: "http://127.0.0.1:1" });
    const dir = build("sunny");
    const uiSource = join(dir, "ui", "src", "index.tsx");
    writeFileSync(uiSource, readFileSync(uiSource, "utf8").replace('glyph="↑"', 'glyph="updated"'));
    const serverSource = join(dir, "server", "index.ts");
    writeFileSync(serverSource, readFileSync(serverSource, "utf8").replace("lat and lon must be coordinates in degrees.", "Updated coordinate validation."));
    mkdirSync(join(dir, "extra"), { recursive: true });
    const call = install(join(dir));
    hub.approvals.resolve((await until(pending, "the approval card")).id, "approve", { via: "web" });
    const result = await call;
    expect(result.isError, textOf(result)).toBeFalsy();
    const rec = hub.plugins.get("sunny")!;
    expect(rec.status).toBe("running");
    expect(rec.settings).toEqual({ apiUrl: "http://127.0.0.1:1" });
    expect(existsSync(join(rec.dir, "extra"))).toBe(true);
    expect(readFileSync(rec.layout!.uiEntry!, "utf8")).toContain('"updated"');
    const ui = hub.plugins.uiPlugins().find((p) => p.id === "sunny")!;
    expect(ui.url).not.toBe(previousUrl);
    expect(hub.plugins.uiPlugins().find((p) => p.id === "sunny")!.url).toBe(ui.url);
    const reply = await hub.tools.get("sunny_times")!.invoke({ lat: 999, lon: 0 }, ctx);
    expect(textOf(reply)).toBe("Updated coordinate validation.");
  });

  it("refreshes the UI for a translation-only update without changing the plugin version", async () => {
    const previous = hub.plugins.uiPlugins().find((p) => p.id === "sunny")!;
    const dir = join(workspace, "integrations", "sunny");
    const messagesFile = join(dir, ".piomio-plugin", "locales", "en.json");
    const messages = JSON.parse(readFileSync(messagesFile, "utf8"));
    messages["card.sunrise"] = "Updated sunrise";
    writeFileSync(messagesFile, JSON.stringify(messages));
    const call = install(dir);
    hub.approvals.resolve((await until(pending, "the approval card")).id, "approve", { via: "web" });
    const result = await call;
    expect(result.isError, textOf(result)).toBeFalsy();
    const current = hub.plugins.uiPlugins().find((p) => p.id === "sunny")!;
    expect(current.url).not.toBe(previous.url);
    expect(current.messages.en["card.sunrise"]).toBe("Updated sunrise");
  });

  it("finishes stopping the old process before returning, including concurrent stop requests", async () => {
    const dir = build("stoppable");
    writeFileSync(join(dir, "server", "index.ts"), `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      export default {
        activate(ctx) {
          process.once("exit", () => writeFileSync(join(ctx.dataDir, "exited"), "yes"));
        }
      };
    `);
    const call = install(dir);
    hub.approvals.resolve((await until(pending, "the approval card")).id, "approve", { via: "web" });
    const result = await call;
    expect(result.isError, textOf(result)).toBeFalsy();
    const exited = join(hub.plugins.dataDirOf("stoppable"), "exited");
    expect(existsSync(exited)).toBe(false);
    await Promise.all([hub.plugins.stop("stoppable"), hub.plugins.stop("stoppable")]);
    expect(readFileSync(exited, "utf8")).toBe("yes");
    expect(hub.plugins.get("stoppable")!.status).toBe("stopped");
  });

  it("terminates a plugin that never finishes deactivating before replacing it", async () => {
    const dir = build("unresponsive");
    writeFileSync(join(dir, "server", "index.ts"), `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      export default {
        activate(ctx) { writeFileSync(join(ctx.dataDir, "pid"), String(process.pid)); },
        deactivate() { return new Promise(() => {}); }
      };
    `);
    const first = install(dir);
    hub.approvals.resolve((await until(pending, "the approval card")).id, "approve", { via: "web" });
    const result = await first;
    expect(result.isError, textOf(result)).toBeFalsy();
    const pid = Number(readFileSync(join(hub.plugins.dataDirOf("unresponsive"), "pid"), "utf8"));

    build("unresponsive");
    const update = install(dir);
    hub.approvals.resolve((await until(pending, "the approval card")).id, "approve", { via: "web" });
    const updated = await update;
    expect(updated.isError, textOf(updated)).toBeFalsy();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(hub.plugins.get("unresponsive")!.status).toBe("running");
    expect(hub.tools.get("unresponsive_times")).toBeDefined();
  });
});
