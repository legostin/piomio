// An agent's project folders (agent-folders.ts): kept in its file, opened only with the person's yes, never the home,
// the system, the person's credentials or the hub's data; its brains on that computer read and write them without
// asking (the sandbox and native_permission), and its prompt says where each project is.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Approval } from "@piomio/shared";
import { freePort } from "@piomio/testkit";
import { Hub, loadConfig } from "../src/index.ts";
import { agentFromMarkdown, agentMoved, agentToMarkdown } from "../src/agents.ts";
import { checkLocalFolder, foldersOn, parseFolders } from "../src/agent-folders.ts";
import { confinement, decideNative } from "../src/native-permissions.ts";
import { buildSystemPrompt } from "../src/prompt.ts";

const fixtures = join(import.meta.dirname, "fixtures");

describe("project folders in an agent's file", () => {
  it("are read from the frontmatter, written back, and follow a computer paired again", () => {
    const a = agentFromMarkdown(
      "dev",
      "---\nname: Dev\nfolders:\n  - { name: Site, path: /work/site, note: the shop }\n  - { name: Thesis, path: D:/Thesis, machine: pc }\n  - { path: /no-name }\n---\nHi\n",
      "user",
    );
    expect(a.folders).toEqual([
      { name: "Site", path: "/work/site", note: "the shop" },
      { name: "Thesis", path: "D:/Thesis", machine: "pc" },
    ]);
    expect(agentFromMarkdown("dev", agentToMarkdown(a), "user").folders).toEqual(a.folders);
    expect(agentMoved(a, "pc", "pc2")?.folders?.[1].machine).toBe("pc2");
    expect(parseFolders("nope")).toBeUndefined();
    expect(agentFromMarkdown("x", "---\nname: X\n---\n", "user").folders).toBeUndefined();
  });

  it("are on the computer they name, the hub's own when they name none", () => {
    const f = [{ name: "a", path: "/a" }, { name: "b", path: "/b", machine: "pc" }, { name: "c", path: "/c", machine: "mac-replica" }];
    expect(foldersOn(f, "local", "local").map((x) => x.name)).toEqual(["a"]);
    expect(foldersOn(f, "local", "mac-replica").map((x) => x.name)).toEqual(["a", "c"]);
    expect(foldersOn(f, "pc", "local").map((x) => x.name)).toEqual(["b"]);
  });
});

describe("which folders may open", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "owl-folders-")));
  const home = join(root, "home");
  const dataDir = join(home, "Library", "Piomio");
  for (const d of [join(home, "code", "site"), join(home, ".ssh"), dataDir]) mkdirSync(d, { recursive: true });
  const check = (p: string) => checkLocalFolder(p, { dataDir, home });

  it("a project's own folder, by its real path; ~ is the home", () => {
    expect(check("~/code/site")).toEqual({ path: join(home, "code", "site") });
    expect(check(join(home, "code", "site", "."))).toEqual({ path: join(home, "code", "site") });
  });

  it("never the home or above it, the hub's data, the person's credentials, the system, or a missing or relative path", () => {
    for (const p of ["~", home, root, "/", join(home, "Library"), dataDir, join(dataDir, "workspaces"), join(home, ".ssh"), "/usr/local", "/etc", "code/site", "~/nope"]) {
      expect("error" in check(p), p).toBe(true);
    }
    expect(check("~/nope")).toEqual({ error: "There is no folder ~/nope on this computer." });
  });
});

describe("a project folder for the agent's brains", () => {
  const home = homedir();
  const ws = "/data/workspaces/dev/t1";
  const site = join(home, "code", "piomio-test-site");

  it("is in the sandbox's reads and writes", () => {
    const c = confinement("/data", ws, [], home, [site]);
    expect(c.allowRead).toContain(site);
    expect(c.allowWrite).toContain(site);
  });

  it("is read and written without asking; the rest of the home still asks", () => {
    const scope = { workspace: ws, home, roots: [site], denied: confinement("/data", ws, [], home).denyRead };
    expect(decideNative({ kind: "write", tool: "Edit", path: join(site, "src", "a.ts") }, scope).decision).toBe("allow");
    expect(decideNative({ kind: "read", tool: "Read", path: join(site, "README.md") }, scope).decision).toBe("allow");
    expect(decideNative({ kind: "write", tool: "Edit", path: join(home, "code", "other", "a.ts") }, scope).decision).toBe("ask");
  });

  it("is named in the prompt, with the ones on other computers", () => {
    const agent = { id: "dev", name: "Dev", description: "", brains: [], initiative: 1 as const, tools: ["*"], skills: [], policyProfile: "default", budget: { backgroundRunsPerDay: 1 }, prompt: "", source: "user" };
    const p = buildSystemPrompt({
      agent,
      timezone: "UTC",
      language: "en",
      consoleUrl: "http://x",
      background: false,
      skills: [],
      nativeSkills: true,
      appended: [],
      folders: { here: [{ name: "Site", path: site, note: "the shop" }], elsewhere: [{ name: "Thesis", path: "D:/Thesis", machine: "pc", computer: "PC" }] },
    });
    expect(p).toContain("## Your project folders");
    expect(p).toContain(`- Site: ${site} (the shop)`);
    expect(p).toContain('- Thesis: D:/Thesis, on "PC"');
    expect(p).toContain("hub_agent_folder_add");
  });
});

describe("hub_agent_folder_add and hub_agent_folder_remove (integration)", () => {
  let hub: Hub;
  let ws = "";
  let site = "";
  const ctx = (agentId = "assistant") => ({ sessionId: "s1", agentId, callId: "c", tainted: false, background: false, workspace: ws, machineId: "local", conversationId: "c1" });
  const call = async (name: string, input: unknown, agentId?: string) => {
    const r = await hub.tools.get(name)!.invoke(input, ctx(agentId));
    return { text: r.content.map((c) => (c.type === "text" ? c.text : "")).join(""), error: !!r.isError };
  };
  /** The next approval card, answered by the person. */
  const answer = (decision: "approve" | "deny") =>
    new Promise<Approval>((resolve) => {
      const off = hub.bus.on("approval.created", (a: Approval) => {
        off?.();
        setTimeout(() => resolve(hub.approvals.resolve(a.id, decision, { via: "console" })), 10);
      });
    });

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const dataDir = mkdtempSync(join(tmpdir(), "owl-folders-hub-"));
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir, builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    ws = join(dataDir, "workspaces", "assistant", "c1");
    mkdirSync(ws, { recursive: true });
    site = realpathSync(mkdtempSync(join(tmpdir(), "owl-site-")));
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("refuses a folder that may not open before any card", async () => {
    const r = await call("hub_agent_folder_add", { name: "Home", path: "~" });
    expect(r).toMatchObject({ error: true, text: expect.stringContaining("too wide") });
    expect((await call("hub_agent_folder_add", { name: "Data", path: hub.config.dataDir })).text).toContain("hub's own data");
    expect(hub.approvals.list().length).toBe(0);
  });

  it("opens the folder only after the person's yes on its card", async () => {
    const no = answer("deny");
    expect((await Promise.all([call("hub_agent_folder_add", { name: "Site", path: site }), no]))[0]).toMatchObject({ error: true, text: expect.stringContaining("declined") });
    expect(hub.agents.get("assistant")?.folders).toBeUndefined();

    const yes = answer("approve");
    const [r, card] = await Promise.all([call("hub_agent_folder_add", { name: "Site", path: site, note: "the shop" }), yes]);
    expect(card.summary).toContain(site);
    expect(card.summary).toContain("Site");
    expect(r.error).toBe(false);
    expect(hub.agents.get("assistant")?.folders).toEqual([{ name: "Site", path: site, note: "the shop" }]);
    expect(readFileSync(join(hub.config.dataDir, "agents", "assistant.md"), "utf8")).toContain(site);
    // The same name again replaces it.
    const again = answer("approve");
    await Promise.all([call("hub_agent_folder_add", { name: "site", path: site }), again]);
    expect(hub.agents.get("assistant")?.folders).toEqual([{ name: "site", path: site }]);
  });

  it("lets other agents change only their own folders", async () => {
    hub.saveAgent({ ...hub.agents.get("assistant")!, id: "dev", name: "Dev", folders: undefined }, "test");
    expect((await call("hub_agent_folder_remove", { folder: "Site", agent: "assistant" }, "dev")).text).toContain("only your own");
  });

  it("closes a folder by its name, without a card", async () => {
    expect((await call("hub_agent_folder_remove", { folder: "nope" })).text).toContain(`site: ${site}`);
    expect((await call("hub_agent_folder_remove", { folder: "Site" })).error).toBe(false);
    expect(hub.agents.get("assistant")?.folders).toBeUndefined();
  });
});
