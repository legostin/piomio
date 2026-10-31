// Skills of their own (docs/superpowers/specs/2026-10-31-skill-holders-design.md): a skill with no holders is the
// whole team's, one given to agents only theirs; a taught skill goes to the agent who learned it; any agent gives a
// skill to teammates in the chat; the dialog's team list says which teammate has which skill.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDef, ToolResult } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { agentFromMarkdown } from "../src/agents.ts";
import { openDb } from "../src/db.ts";
import { hasSkill, SkillHolders, SkillIndex } from "../src/skills.ts";
import { buildSystemPrompt } from "../src/prompt.ts";

const agent = (id: string, skills: string[] = ["*"]) => ({ id, skills });

function index(names: string[]): SkillIndex {
  const dir = mkdtempSync(join(tmpdir(), "owl-holders-"));
  for (const n of names) {
    mkdirSync(join(dir, n));
    writeFileSync(join(dir, n, "SKILL.md"), `---\nname: ${n}\ndescription: ${n} things\n---\nDo ${n}.`);
  }
  const skills = new SkillIndex();
  skills.holders = new SkillHolders(openDb(":memory:"));
  skills.setRoots([{ source: "user", skillsDir: dir }]);
  return skills;
}

describe("who has a skill", () => {
  it("no holders: the whole team; holders: only them; an empty list gives it back to the team", () => {
    const h = new SkillHolders(openDb(":memory:"));
    expect(h.get("insta-post")).toEqual([]);
    h.set("insta-post", ["smm", "smm", "researcher"]);
    expect(h.get("insta-post")).toEqual(["smm", "researcher"]);
    expect([...h.all()]).toEqual([["insta-post", ["smm", "researcher"]]]);
    h.set("insta-post", []);
    expect(h.all().size).toBe(0);
  });

  it("an agent who leaves takes nobody's skill away: one only it had goes back to the team", () => {
    const h = new SkillHolders(openDb(":memory:"));
    h.set("insta-post", ["smm"]);
    h.set("web-search", ["smm", "researcher"]);
    h.dropAgent("smm");
    expect(h.get("insta-post")).toEqual([]);
    expect(h.get("web-search")).toEqual(["researcher"]);
  });

  it("an agent has a skill its patterns fit when it is the team's or was given to it", () => {
    expect(hasSkill(agent("smm"), "insta-post", [])).toBe(true);
    expect(hasSkill(agent("smm"), "insta-post", ["smm"])).toBe(true);
    expect(hasSkill(agent("researcher"), "insta-post", ["smm"])).toBe(false);
    expect(hasSkill(agent("smm", ["web-*"]), "insta-post", ["smm"])).toBe(false);
    expect(hasSkill(agent("smm", []), "insta-post", [])).toBe(true);
  });

  it("the index lists an agent's skills, its own ones, and a skill a run follows anyway", () => {
    const skills = index(["insta-post", "web-search", "notes"]);
    skills.holders!.set("insta-post", ["smm"]);
    skills.holders!.set("web-search", ["researcher", "smm"]);
    const names = (a: Pick<AgentDef, "id" | "skills">, also?: string) => skills.forAgent(a, also).map((s) => s.name);
    expect(names(agent("smm"))).toEqual(["insta-post", "notes", "web-search"]);
    expect(names(agent("researcher"))).toEqual(["notes", "web-search"]);
    expect(names(agent("researcher"), "insta-post")).toEqual(["insta-post", "notes", "web-search"]);
    expect(skills.has(agent("researcher"), "insta-post")).toBe(false);
    expect(skills.has(agent("researcher"), "insta-post", "insta-post")).toBe(true);
    expect(skills.ownOf("smm")).toEqual(["insta-post", "web-search"]);
    expect(skills.ownOf("assistant")).toEqual([]);
    // A row for a skill that is gone (its plugin removed) is not someone's skill.
    skills.holders!.set("gone", ["smm"]);
    expect(skills.ownOf("smm")).toEqual(["insta-post", "web-search"]);
  });
});

describe("what an agent is told", () => {
  const assistant = { id: "assistant", name: "Owl", description: "", brains: [], initiative: 1, tools: ["*"], skills: ["*"], policyProfile: "default", budget: { backgroundRunsPerDay: 5 }, prompt: "", source: "builtin" } as AgentDef;
  const base = { agent: assistant, timezone: "UTC", language: "en", consoleUrl: "http://x", background: false, nativeSkills: false, appended: [] };

  it("the dialog's team list says which teammate has which skill of its own, and to hand such work to them", () => {
    const skills = index(["insta-post", "notes"]);
    skills.holders!.set("insta-post", ["smm"]);
    const p = buildSystemPrompt({
      ...base,
      skills: skills.forAgent(assistant),
      dispatch: {
        team: [
          { id: "assistant", name: "Owl", description: "Helps", where: ["MacBook"], skills: [] },
          { id: "smm", name: "SMM", description: "Runs pages", where: ["MacBook"], skills: skills.ownOf("smm") },
        ],
        computers: [{ id: "local", name: "MacBook", online: true }],
      },
    });
    expect(p).toContain("- smm: SMM — Runs pages (skills: insta-post; on: MacBook)");
    expect(p).toContain("- assistant: Owl (you) — Helps (on: MacBook)");
    expect(p).toContain("work that needs one goes to them");
    // Its own Skills section lists only what it has.
    const section = p.slice(p.indexOf("## Skills"));
    expect(section).toContain("- notes: notes things");
    expect(section).not.toContain("insta-post");
  });
});

const fixtures = join(import.meta.dirname, "fixtures");

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

const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("skills of their own on the hub", () => {
  let hub: Hub;
  let base = "";
  let cookie = "";
  const sessions: Record<string, string> = {};
  const call = (agentId: string, tool: string, input: unknown) => hub.gateway.call(sessions[agentId], tool, input);
  const member = (id: string, name: string) =>
    hub.saveAgent(agentFromMarkdown(id, `---\nname: ${name}\ndescription: ${name} work\nbrains: [fake@local]\ninitiative: 1\n---\nYou are ${name}.`, "user"), "user");
  const sessionOf = (agentId: string, skill?: string) => {
    if (!skill) return hub.store.createSession({ conversationId: hub.store.agentConversation(agentId).id, agentId, brainRef: "fake@local", background: false }).row.id;
    const task = hub.store.createTask({ agentId, title: "Post", goal: "Post", background: true, createdBy: "trigger", status: "running", skill });
    return hub.store.createSession({ conversationId: task.conversationId, taskId: task.id, agentId, brainRef: "fake@local", background: true }).row.id;
  };

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const dataDir = mkdtempSync(join(tmpdir(), "owl-holders-hub-"));
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir, builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    base = config.publicUrl;
    hub.settings.update({ language: "en" });
    member("smm", "SMM");
    member("researcher", "Researcher");
    for (const n of ["insta-post", "web-search"]) {
      mkdirSync(join(dataDir, "skills", n), { recursive: true });
      writeFileSync(join(dataDir, "skills", n, "SKILL.md"), `---\nname: ${n}\ndescription: ${n} things\n---\nDo ${n}.`);
    }
    hub.reindex();
    for (const id of ["assistant", "smm", "researcher"]) sessions[id] = sessionOf(id);
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("every agent may see and give skills; who has one is set as a whole list, [] is the whole team", async () => {
    const names = hub.gateway.listFor(hub.store.getSession(sessions.smm)!).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["hub_skills_list", "hub_skill_assign"]));
    expect(textOf(await call("smm", "hub_skill_assign", { name: "insta-post", agents: ["SMM"] }))).toBe('Only SMM now has the skill "insta-post". Tell the person in a sentence.');
    expect(hub.skills.holders!.get("insta-post")).toEqual(["smm"]);
    const list = JSON.parse(textOf(await call("assistant", "hub_skills_list", {})));
    expect(list.find((s: any) => s.name === "insta-post").has).toEqual(["smm"]);
    expect(list.find((s: any) => s.name === "web-search").has).toBe("team");
    const agents = JSON.parse(textOf(await call("assistant", "hub_agents_list", {})));
    expect(agents.find((a: any) => a.id === "smm").skills).toEqual(["insta-post"]);
    expect(agents.find((a: any) => a.id === "researcher").skills).toEqual([]);
    expect(hub.audit.list({ action: "skill.assign", limit: 1 })[0]).toMatchObject({ actor: "agent:smm", target: "insta-post", data: { agents: ["smm"] } });

    expect(textOf(await call("smm", "hub_skill_assign", { name: "nope", agents: [] }))).toMatch(/^No skill "nope"\. Skills: .*insta-post/);
    expect(textOf(await call("smm", "hub_skill_assign", { name: "web-search", agents: ["ghost"] }))).toMatch(/^No agent ghost\. The team: .*researcher \(Researcher\)/);
    expect(textOf(await call("smm", "hub_skill_assign", { name: "web-search", agents: [] }))).toMatch(/whole team's now/);
  });

  it("a teammate's skill is not loaded by another agent, who is told whose it is; a run that follows it has it", async () => {
    const refused = await call("researcher", "skill_load", { name: "insta-post" });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe("insta-post is not one of your skills: smm (SMM) has it. Ask them with team_message or hand them the work with task_delegate.");
    expect(textOf(await call("smm", "skill_load", { name: "insta-post" }))).toContain("Do insta-post.");
    expect(textOf(await call("researcher", "skill_load", { name: "web-search" }))).toContain("Do web-search.");
    sessions.run = sessionOf("researcher", "insta-post");
    expect(textOf(await hub.gateway.call(sessions.run, "skill_load", { name: "insta-post" }))).toContain("Do insta-post.");
  });

  it("the web's list says who has each skill", async () => {
    await fetch(base + "/api/auth/setup", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ token: hub.auth.setupToken, password: "integration-pass-1" }) }).then((r) => {
      cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
    });
    const skills = await (await fetch(base + "/api/skills", { headers: { origin: base, cookie } })).json();
    expect(skills.find((s: any) => s.name === "insta-post").agents).toEqual(["smm"]);
    expect(skills.find((s: any) => s.name === "web-search").agents).toEqual([]);
  });

  it("an agent who leaves the team gives its only skill back to everyone", () => {
    hub.skills.holders!.set("web-search", ["smm", "researcher"]);
    hub.removeAgent("smm", "user");
    expect(hub.skills.holders!.get("insta-post")).toEqual([]);
    expect(hub.skills.holders!.get("web-search")).toEqual(["researcher"]);
  });
});
