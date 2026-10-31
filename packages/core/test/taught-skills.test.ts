// Skills the person taught by showing (teach mode): hub_skill_save asks on its own card and saves only on the tap
// (the skill's folder, its files, a rule per pre-approved click), replaces update one, hub_skill_delete forgets one,
// and a background run of a taught skill may click and type while its consequential clicks need a pre-approval.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "@piomio/shared";
import { parseFrontmatter } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { agentFromMarkdown } from "../src/agents.ts";
import { allowRule, labelCondition, parseSkillSave, skillSaveSummary } from "../src/taught-skills.ts";
import { decide } from "../src/policy/engine.ts";

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

async function until<T>(fn: () => T | undefined | false, what: string, timeoutMs = 10_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

const WATER = {
  name: "order-water",
  description: "Orders drinking water on 5vodi.kz",
  instructions: "## Goal\nOrder two 19 l bottles.\n\n## Steps\n1. Click link «Каталог».\n2. Click button «Вода 19 л».",
  files: ["downloads/teach-1.md", "downloads/teach-1.json", "downloads/crop-1.jpg", "downloads/other/teach-1.md"],
  sites: ["https://www.5vodi.kz/catalog"],
  allow: [
    { site: "5vodi.kz", label: "Оформить заказ", maxAmount: 3000, currency: "kzt" },
    { site: "www.5vodi.kz", label: "Оплатить 2 400 ₸" },
  ],
};

describe("taught skills: what a pre-approval becomes", () => {
  it("a label with numbers is a pattern where they may change; one without is exact", () => {
    expect(labelCondition("Оформить заказ")).toEqual({ field: "label", op: "eq", value: "Оформить заказ" });
    expect(labelCondition("Оплатить 2 400,50 ₸")).toEqual({ field: "label", op: "glob", value: "Оплатить * ₸" });
    expect(labelCondition("Pay $1,234.00 now (2 items)")).toEqual({ field: "label", op: "glob", value: "Pay $* now (* items)" });
    expect(allowRule("order-water", { site: "5vodi.kz", label: "Оформить заказ", maxAmount: 3000, currency: "KZT" })).toEqual({
      tool: "browser_submit",
      conditions: [
        { field: "url", op: "domain", value: "5vodi.kz" },
        { field: "label", op: "eq", value: "Оформить заказ" },
        { field: "amount", op: "max", value: 3000 },
        { field: "currency", op: "eq", value: "KZT" },
      ],
      decision: "allow",
      note: "skill:order-water",
      createdVia: "skill",
    });
  });

  it("the card says the skill and each click it may do without asking, in the reader's language", () => {
    const s = parseSkillSave(WATER);
    expect(s.sites).toEqual(["5vodi.kz"]);
    expect(s.allow.map((a) => a.site)).toEqual(["5vodi.kz", "5vodi.kz"]);
    const plain = (x: string) => x.replace(/\s/g, " ");
    expect(plain(skillSaveSummary(s, "en"))).toBe(
      "Save the skill «order-water»: Orders drinking water on 5vodi.kz · Without asking: «Оформить заказ» on 5vodi.kz, up to ₸3,000 · Without asking: «Оплатить … ₸» on 5vodi.kz",
    );
    expect(plain(skillSaveSummary({ ...s, replaces: "order-water" }, "ru"))).toBe(
      "Обновить навык «order-water»: Orders drinking water on 5vodi.kz · Без вопросов: «Оформить заказ» на 5vodi.kz, до 3 000 ₸ · Без вопросов: «Оплатить … ₸» на 5vodi.kz",
    );
  });

  it("refuses what is not a skill", () => {
    expect(() => parseSkillSave({ ...WATER, name: "Order Water" })).toThrow(/lowercase/);
    expect(() => parseSkillSave({ ...WATER, description: "x".repeat(301) })).toThrow(/description is too long/);
    expect(() => parseSkillSave({ ...WATER, instructions: "" })).toThrow(/instructions is required/);
    expect(() => parseSkillSave({ ...WATER, files: Array.from({ length: 21 }, (_, i) => `f${i}`) })).toThrow(/at most 20/);
    expect(() => parseSkillSave({ ...WATER, allow: [{ site: "*", label: "Buy" }] })).toThrow(/not a site/);
    expect(() => parseSkillSave({ ...WATER, allow: [{ site: "shop.test", label: "Buy", maxAmount: -1 }] })).toThrow(/positive number/);
  });
});

describe("taught skills on the hub", () => {
  let hub: Hub;
  let dataDir = "";
  let session = "";
  let workspace = "";

  const save = (input: unknown) => hub.gateway.call(session, "hub_skill_save", input);
  const card = () => until(() => hub.approvals.list(["pending"]).find((a) => a.tool === "hub_skill_save"), "the skill's card");
  const skillDir = (name: string) => join(dataDir, "skills", name);
  const skillRules = () => hub.rules.list().filter((r) => r.createdVia === "skill");

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    dataDir = mkdtempSync(join(tmpdir(), "owl-taught-"));
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir, builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    hub.settings.update({ language: "en" });
    // The person showed the task to Desk, not the default agent.
    hub.saveAgent(agentFromMarkdown("desk", "---\nname: Desk\ndescription: Front desk\nbrains: [fake@local]\ninitiative: 1\n---\nYou are Desk.", "user"), "user");
    const conv = hub.store.agentConversation("desk").id;
    const { row } = hub.store.createSession({ conversationId: conv, agentId: "desk", brainRef: "fake@local", background: false });
    session = row.id;
    workspace = hub.runner.workspacePath(row);
    mkdirSync(join(workspace, "downloads", "other"), { recursive: true });
    writeFileSync(join(workspace, "downloads", "teach-1.md"), "# Recording\n1) clicked link «Каталог»");
    writeFileSync(join(workspace, "downloads", "teach-1.json"), "{}");
    writeFileSync(join(workspace, "downloads", "crop-1.jpg"), "jpg");
    writeFileSync(join(workspace, "downloads", "other", "teach-1.md"), "# Another");
    // A plugin's skill and the person's own (not taught) one: their names are not taken over.
    const pluginSkills = join(dataDir, "plugin-skills");
    mkdirSync(join(pluginSkills, "teach-by-demo"), { recursive: true });
    writeFileSync(join(pluginSkills, "teach-by-demo", "SKILL.md"), "---\nname: teach-by-demo\ndescription: How to learn\ntaught: true\n---\nx");
    mkdirSync(skillDir("my-notes"), { recursive: true });
    writeFileSync(join(skillDir("my-notes"), "SKILL.md"), "---\nname: my-notes\ndescription: Mine\n---\nx");
    hub.skills.setRoots([...hub.skills.roots, { source: "browser", skillsDir: pluginSkills }]);
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("every agent the person shows a task to can save it; the rest of the hub's tools stay with the default agent", () => {
    const names = hub.gateway.listFor(hub.store.getSession(session)!).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["hub_skill_save", "hub_skill_delete"]));
    expect(names).not.toContain("hub_settings_update");
    // A plugin's skill saying taught does not make it one.
    expect(hub.skills.get("teach-by-demo")?.taught).toBe(false);
  });

  it("nothing is saved without the person's yes on the card", async () => {
    const asked = save(WATER);
    const a = await card();
    expect(a.summary).toMatch(/^Save the skill «order-water»: Orders drinking water on 5vodi\.kz · Without asking: «Оформить заказ» on 5vodi\.kz, up to/);
    hub.approvals.resolve(a.id, "deny", { via: "web" });
    const r = await asked;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/declined: nothing was saved/);
    expect(existsSync(skillDir("order-water"))).toBe(false);
    expect(skillRules()).toHaveLength(0);
  });

  it("on yes: the folder with SKILL.md and the files, a rule per pre-approved click, its sites known", async () => {
    const asked = save(WATER);
    // "Always allow this" on the card is a single yes here: the next skill would otherwise be saved without the person.
    hub.approvals.resolve((await card()).id, "approve", { via: "web", remember: true });
    const r = await asked;
    expect(textOf(r)).toMatch(/^Saved the skill "order-water"/);
    // It is Desk's: the agent who learned it, not the whole team.
    expect(textOf(r)).toContain("It is yours: only you have it");
    expect(hub.skills.holders!.get("order-water")).toEqual(["desk"]);
    expect(hub.rules.list().some((x) => x.tool === "hub_skill_save")).toBe(false);
    expect(readdirSync(skillDir("order-water")).sort()).toEqual(["SKILL.md", "crop-1.jpg", "teach-1-2.md", "teach-1.json", "teach-1.md"]);
    expect(readFileSync(join(skillDir("order-water"), "teach-1-2.md"), "utf8")).toBe("# Another");
    const { data, body } = parseFrontmatter(readFileSync(join(skillDir("order-water"), "SKILL.md"), "utf8"));
    expect(data).toMatchObject({ name: "order-water", description: "Orders drinking water on 5vodi.kz", taught: true, sites: ["5vodi.kz"], agent: "desk" });
    expect(data.created).toBe(data.updated);
    expect(body.trim()).toBe(WATER.instructions);
    expect(hub.skills.get("order-water")).toMatchObject({ taught: true, sites: ["5vodi.kz"], source: "user" });

    const rules = skillRules();
    expect(rules).toHaveLength(2);
    expect(rules.every((x) => x.note === "skill:order-water" && x.tool === "browser_submit" && x.decision === "allow")).toBe(true);
    expect(rules.map((x) => x.conditions[1])).toEqual(expect.arrayContaining([{ field: "label", op: "glob", value: "Оплатить * ₸" }]));
    expect(hub.rules.isKnownTarget("5vodi.kz") && hub.rules.isKnownTarget("www.5vodi.kz")).toBe(true);
    expect(hub.approvals.list(["executed"]).some((a) => a.tool === "hub_skill_save")).toBe(true);
  });

  it("refuses the name of another skill, a taught one without replaces, and files outside the workspace", async () => {
    expect(textOf(await save({ ...WATER, files: [] }))).toMatch(/exists already: to update it, pass replaces "order-water"/);
    expect(textOf(await save({ ...WATER, name: "teach-by-demo", files: [] }))).toMatch(/skill of the browser plugin: pick another name/);
    expect(textOf(await save({ ...WATER, name: "my-notes", files: [] }))).toMatch(/not taught by showing: pick another name/);
    expect(textOf(await save({ ...WATER, name: "water-2", replaces: "my-notes", files: [] }))).toMatch(/no taught skill "my-notes" to replace/);
    expect(textOf(await save({ ...WATER, name: "water-2", files: ["../../../../etc/hosts"] }))).toMatch(/outside your workspace|no such file/);
    expect(textOf(await save({ ...WATER, name: "water-2", files: ["downloads/missing.md"] }))).toMatch(/no such file in your workspace/);
    expect(hub.approvals.list(["pending"])).toHaveLength(0);
  });

  it("replaces updates a taught skill: the old folder and pre-approvals give way to the new ones", async () => {
    const before = parseFrontmatter(readFileSync(join(skillDir("order-water"), "SKILL.md"), "utf8")).data;
    await new Promise((r) => setTimeout(r, 5));
    const asked = save({ ...WATER, description: "Orders water, now from the new menu", files: ["downloads/teach-1.md"], allow: [{ site: "5vodi.kz", label: "Заказать", maxAmount: 5000, currency: "KZT" }], replaces: "order-water" });
    const a = await card();
    expect(a.summary).toMatch(/^Update the skill «order-water»: Orders water, now from the new menu · Without asking: «Заказать» on 5vodi\.kz, up to/);
    hub.skills.holders!.set("order-water", ["desk", "assistant"]);
    hub.approvals.resolve(a.id, "approve", { via: "web" });
    expect(textOf(await asked)).toMatch(/^Saved the skill "order-water".*Who has it stays the same\./);
    expect(hub.skills.holders!.get("order-water")).toEqual(["desk", "assistant"]);
    expect(readdirSync(skillDir("order-water")).sort()).toEqual(["SKILL.md", "teach-1.md"]);
    const after = parseFrontmatter(readFileSync(join(skillDir("order-water"), "SKILL.md"), "utf8")).data;
    expect(after.created).toBe(before.created);
    expect(after.updated).not.toBe(before.updated);
    expect(skillRules().map((r) => r.conditions[1])).toEqual([{ field: "label", op: "eq", value: "Заказать" }]);
  });

  it("a card answered later still saves: the hub carries it out on the tap", async () => {
    hub.settings.update({ approvalInlineWaitSec: 0.2 });
    try {
      const r = await save({ ...WATER, name: "order-later", files: [], allow: [] });
      expect(textOf(r)).toMatch(/card waits for the person's tap/);
      expect(existsSync(skillDir("order-later"))).toBe(false);
      hub.approvals.resolve((await card()).id, "approve", { via: "web" });
      await until(() => hub.skills.get("order-later")?.taught, "the skill saved on the late tap");
    } finally {
      hub.settings.update({ approvalInlineWaitSec: 45 });
    }
  });

  it("a background run of a taught skill clicks and types; its consequential click runs only within what was pre-approved", async () => {
    let clicked = 0;
    let submitted = 0;
    const tool = (name: string, effect: "local-write" | "external", fn: () => void) =>
      hub.tools.register({ name, description: name, effect, inputSchema: { type: "object" }, owner: "browser" }, async () => {
        fn();
        return { content: [{ type: "text", text: "ok" }] };
      });
    tool("browser_click", "local-write", () => clicked++);
    tool("browser_submit", "external", () => submitted++);
    hub.settings.update({ approvalInlineWaitSec: 0.2 });
    try {
      const run = (skill?: string) => {
        const task = hub.store.createTask({ agentId: "desk", title: "Water", goal: "Order water", background: true, createdBy: "trigger", status: "running", ...(skill ? { skill } : {}) });
        return hub.store.createSession({ conversationId: task.conversationId, taskId: task.id, agentId: "desk", brainRef: "fake@local", background: true }).row.id;
      };
      const plain = run();
      expect((await hub.gateway.call(plain, "browser_click", { ref: "e1" })).isError).toBe(true);
      const taught = run("order-water");
      expect(hub.store.getTask(hub.store.getSession(taught)!.taskId!)!.skill).toBe("order-water");
      expect((await hub.gateway.call(taught, "browser_click", { ref: "e1" })).isError).toBeFalsy();
      expect(clicked).toBe(1);
      const order = { ref: "e9", label: "Заказать", url: "https://5vodi.kz/cart", amount: 4800, currency: "KZT", description: "Order 2 bottles" };
      expect((await hub.gateway.call(taught, "browser_submit", order)).isError).toBeFalsy();
      expect(submitted).toBe(1);
      const more = await hub.gateway.call(taught, "browser_submit", { ...order, amount: 5200 });
      expect(more._meta?.status).toBe("awaiting_approval");
      expect(submitted).toBe(1);
      // A skill that is not a taught one does not open the background up.
      const other = run("my-notes");
      expect((await hub.gateway.call(other, "browser_click", { ref: "e1" })).isError).toBe(true);
    } finally {
      hub.settings.update({ approvalInlineWaitSec: 45 });
      for (const a of hub.approvals.list(["pending"])) hub.approvals.resolve(a.id, "deny", { via: "web" });
      hub.tools.unregisterOwner("browser");
    }
    // The policy agrees: a rule from another skill or site does not count.
    const other = allowRule("other", { site: "shop.test", label: "Заказать" }) as any;
    const input = { label: "Заказать", url: "https://5vodi.kz/cart" };
    expect(decide({ tool: { name: "browser_submit", effect: "external" } as any, input, agentId: "desk", tainted: false, background: true, initiative: 1, profile: "default", skillRun: true }, [{ ...other, id: "r", createdAt: "" }], () => false).decision).toBe("ask");
  });

  it("hub_skill_delete forgets a taught skill and its pre-approvals, and only taught ones", async () => {
    expect(textOf(await hub.gateway.call(session, "hub_skill_delete", { name: "my-notes" }))).toMatch(/only taught skills can be deleted/);
    expect(existsSync(skillDir("my-notes"))).toBe(true);
    const r = await hub.gateway.call(session, "hub_skill_delete", { name: "order-water" });
    expect(textOf(r)).toMatch(/Deleted the skill "order-water" and its 1 pre-approved click/);
    expect(existsSync(skillDir("order-water"))).toBe(false);
    expect(hub.skills.get("order-water")).toBeUndefined();
    expect(hub.skills.holders!.all().has("order-water")).toBe(false);
    expect(skillRules()).toHaveLength(0);
  });
});
