// Runs with no model: a trigger's scriptRun starts a task whose skill's script the hub runs itself. The agent's brain
// is used only when the script stops; a step that needs the person's yes makes the task wait with no model; a
// background run that follows a taught skill may make the calls the skill's card pre-approved though its agent only
// suggests; a run cut off by a restart is never started again.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "@piomio/testkit";
import type { Message, Rule, Task, ToolDescriptor, ToolResult } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { agentFromMarkdown } from "../src/agents.ts";
import { decide, skillRunAllows } from "../src/policy/engine.ts";
import { scriptHandover, scriptInterrupted, scriptNoteIn, scriptStarted, scriptValue, scriptWaiting, scriptWords, SCRIPT_RUN_MARK } from "../src/script-runs.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

async function until<T>(fn: () => T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("what a run with no model says", () => {
  it("takes a script's words from a string or its message, and keeps the rest as the result", () => {
    expect(scriptWords("  Заказал 2 бутыли  ")).toBe("Заказал 2 бутыли");
    expect(scriptWords({ message: "Sent 3", sent: [1, 2, 3] })).toBe("Sent 3");
    for (const none of [undefined, null, "", "  ", 5, ["a"], { total: 5 }, { message: 7 }]) expect(scriptWords(none)).toBeUndefined();
    expect(scriptValue({ total: 5 })).toBe('{\n  "total": 5\n}');
    expect(scriptValue("words")).toBeUndefined();
    expect(scriptValue(undefined)).toBeUndefined();
    expect(scriptValue({ big: "x".repeat(10_000) })!.length).toBeLessThan(4100);
  });

  it("tells from the thread how far a task's script got", () => {
    const note = (text: string, role: Message["role"] = "system") => ({ role, parts: [{ type: "text", text }] }) as Message;
    expect(scriptNoteIn([note("Order water", "user")], "water")).toBeUndefined();
    // Only its start is there: the hub was stopped under it.
    expect(scriptNoteIn([note("Order water", "user"), note(scriptStarted("water"))], "water")).toBe(scriptInterrupted("water"));
    expect(scriptInterrupted("water")).toMatch(/never repeat a step that may be done/);
    const run = { ok: false as const, error: "no button", trace: [{ call: "browser.open", args: '"https://5vodi.kz"', ok: true }, { call: "browser.click", args: '{"name":"Buy"}', ok: false, error: "no button" }], stoppedAt: 1, logs: [], ms: 1200 };
    const handover = scriptHandover("water", run, "export default async () => {}");
    expect(handover.startsWith(SCRIPT_RUN_MARK)).toBe(true);
    expect(handover).toMatch(/with no model\. It did not finish: you take the task from here\.\nThe script of "water" stopped at call 2, browser\.click/);
    expect(scriptNoteIn([note("Order water", "user"), note(scriptStarted("water")), note(handover), note("[System] something else")], "water")).toBe(handover);
    // A user's or an agent's words that happen to start the same way are not the hub's notes.
    expect(scriptNoteIn([note(`${SCRIPT_RUN_MARK} hello`, "user")], "water")).toBeUndefined();
    const waiting = scriptWaiting("water", { ...run, halted: "approval" });
    expect(waiting).toMatch(/It stopped at call 2, browser\.click\(\{"name":"Buy"\}\): that step needs the person's yes on its card/);
    expect(waiting).toContain('Calls before it (done):\n1. browser.open("https://5vodi.kz") ok');
    expect(waiting).toMatch(/never repeat that step or the calls before it/);
  });
});

describe("a background run of a taught skill and what its card pre-approved", () => {
  const tool = (name: string, effect: ToolDescriptor["effect"]): ToolDescriptor => ({ name, description: name, effect, inputSchema: { type: "object" }, owner: "crm" });
  const rule = (note: string, more: Partial<Rule> = {}): Rule => ({ id: `r_${note}`, tool: "crm_mail", conditions: [{ field: "to", op: "glob", value: "*@kolesa.kz" }], decision: "allow", note, createdVia: "skill", createdAt: "", ...more });
  const rules = [rule("skill:mail-clients")];
  const run = (input: unknown, more: Record<string, unknown> = {}) =>
    decide({ tool: tool("crm_mail", "external"), input, agentId: "helper", tainted: false, background: true, initiative: 1, profile: "balanced", skillRun: true, skill: "mail-clients", ...more }, rules, () => false);

  it("makes the approved calls though its agent only suggests, and nothing else that changes things", () => {
    expect(run({ to: "anna@kolesa.kz" })).toMatchObject({ decision: "allow", ruleId: "r_skill:mail-clients" });
    expect(run({ to: "eve@evil.example" }).decision).toBe("deny");
    // Another skill's approval, a rule made elsewhere, or no skill run at all: the background run only reads.
    expect(run({ to: "anna@kolesa.kz" }, { skill: "other" }).decision).toBe("deny");
    expect(run({ to: "anna@kolesa.kz" }, { skillRun: false }).decision).toBe("deny");
    expect(decide({ tool: tool("crm_mail", "external"), input: { to: "anna@kolesa.kz" }, agentId: "helper", tainted: false, background: true, initiative: 1, profile: "balanced", skillRun: true, skill: "mail-clients" }, [rule("skill:mail-clients", { createdVia: "console" })], () => false).decision).toBe("deny");
    // The browser and the script itself stay the run's, as before.
    expect(skillRunAllows([], "mail-clients", "browser_click", "helper")).toBe(true);
    expect(skillRunAllows([], undefined, "skill_run", "helper")).toBe(true);
    // Listing asks about the tool alone; deciding asks about the call.
    expect(skillRunAllows(rules, "mail-clients", "crm_mail", "helper")).toBe(true);
    expect(skillRunAllows(rules, "mail-clients", "crm_note", "helper")).toBe(false);
    expect(skillRunAllows(rules, "mail-clients", "crm_mail", "helper", { to: "eve@evil.example" })).toBe(false);
  });

  it("after outside content still asks for a recipient nobody approved by name", () => {
    expect(run({ to: "anna@kolesa.kz" }, { tainted: true })).toMatchObject({ decision: "ask" });
    expect(decide({ tool: tool("crm_mail", "external"), input: { to: "anna@kolesa.kz" }, agentId: "helper", tainted: true, background: true, initiative: 1, profile: "balanced", skillRun: true, skill: "mail-clients" }, rules, (t) => t === "anna@kolesa.kz").decision).toBe("allow");
  });
});

describe("a trigger that runs a skill's script with no model", () => {
  let hub: Hub;
  const done: Array<{ tool: string; input: any }> = [];
  const sessions: Record<string, string> = {};

  const call = (agent: string, name: string, input: unknown) => hub.gateway.call(sessions[agent], name, input);
  const callText = (agent: string, name: string, input: unknown) => call(agent, name, input).then(textOf);
  const brainsOf = (task: Task) => (hub.store.db.prepare("select brain_ref from sessions where task_id = ? order by created_at").all(task.id) as Array<{ brain_ref: string }>).map((r) => r.brain_ref);
  const thread = (task: Task) => hub.store.listMessages(task.conversationId, { limit: 50 });
  const notes = (task: Task) => thread(task).flatMap((m) => (m.role === "system" ? m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])) : []));
  const taskOf = (triggerId: string, status: Task["status"][], nth = 0) =>
    until(() => {
      const mine = hub.store.listTasks({ limit: 100 }).filter((t) => t.triggerId === triggerId).reverse();
      return mine[nth] && status.includes(mine[nth].status) ? mine[nth] : undefined;
    }, `run ${nth + 1} of ${triggerId} to be ${status.join("/")}`);
  const pending = (toolName: string) => until(() => hub.approvals.list(["pending"]).find((a) => a.tool === toolName), `the card of ${toolName}`);

  const SCRIPT = `export default async function (input, browser, tools) {
  const { clients } = await tools.crm_find({});
  const sent = [];
  for (const c of clients.filter((c) => c.email.endsWith(input.domain))) sent.push(await tools.crm_mail({ to: c.email }));
  return { message: "Sent " + sent.length + " (" + input.trigger.reason + ")", sent };
}`;

  /** A skill saved as the agent saves one: on the person's card. */
  async function saveSkill(agent: string, input: Record<string, unknown>): Promise<string> {
    const asked = callText(agent, "hub_skill_save", input);
    const card = await pending("hub_skill_save");
    hub.approvals.resolve(card.id, "approve", { via: "web" });
    return asked;
  }

  async function createTrigger(agent: string, input: Record<string, unknown>): Promise<string> {
    const made = await callText(agent, "trigger_create", { kind: "schedule", cron: "0 9 * * 5", prompt: "Mail our clients the weekly note", ...input });
    const id = /trigger (t_[0-9a-f]+)/.exec(made)?.[1];
    if (!id) throw new Error(made);
    return id;
  }

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const dataDir = mkdtempSync(join(tmpdir(), "piomio-script-runs-"));
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir, builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    hub.settings.update({ language: "en", approvalInlineWaitSec: 0.2 });
    const agent = (id: string, initiative: number) => hub.saveAgent(agentFromMarkdown(id, `---\nname: ${id}\ndescription: An agent\nbrains: [fake@local]\ninitiative: ${initiative}\n---\nYou are ${id}.`, "user"), "user");
    agent("helper", 1);
    agent("doer", 2);
    for (const id of ["helper", "doer"]) sessions[id] = hub.store.createSession({ conversationId: hub.store.agentConversation(id).id, agentId: id, brainRef: "fake@local", background: false }).row.id;
    const tool = (name: string, effect: "read" | "local-write" | "external", answer: (input: any) => string, more: Partial<ToolDescriptor> = {}) =>
      hub.tools.register({ name, description: `${name}: a test tool.`, effect, inputSchema: { type: "object", properties: { id: { type: "number" }, to: { type: "string" } } }, owner: "crm", ...more }, async (input: any) => {
        done.push({ tool: name, input });
        return { content: [{ type: "text", text: answer(input) }] };
      });
    tool("crm_find", "read", () => JSON.stringify({ clients: [{ id: 1, name: "Анна", email: "anna@kolesa.kz" }, { id: 2, name: "Bob", email: "bob@example.org" }] }));
    tool("crm_mail", "external", (i) => `Sent to ${i.to}.`, { approvalSummary: "Mail {to}" });

    expect(await saveSkill("helper", { name: "mail-clients", description: "Mails our clients a note", instructions: "## Inputs\n- domain\n## Steps\nThe script finds the clients and mails each.", script: SCRIPT, allow: [{ tool: "crm_mail", where: { to: "*@kolesa.kz" } }] })).toMatch(/It has a script/);
    expect(await saveSkill("helper", { name: "by-hand", description: "A skill done by hand", instructions: "## Steps\nDo it by hand." })).toMatch(/Saved/i);
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("is refused without a skill that has a script, and says what each run does", async () => {
    const base = { kind: "schedule", cron: "0 9 * * 5", name: "Weekly note", prompt: "Mail our clients the weekly note" };
    expect(await callText("helper", "trigger_create", { ...base, scriptRun: { input: {} } })).toMatch(/scriptRun runs a skill's script with no model: set `skill`/);
    expect(await callText("helper", "trigger_create", { ...base, skill: "by-hand", scriptRun: { input: {} } })).toMatch(/cannot run the skill "by-hand" with no model: it has no script yet/);
    expect(await callText("helper", "trigger_create", { ...base, skill: "nope", scriptRun: true })).toMatch(/there is no skill "nope" on the hub/);
    const made = await callText("helper", "trigger_create", { ...base, skill: "mail-clients", scriptRun: { input: { domain: "@kolesa.kz" } } });
    expect(made).toMatch(/Each run is the script of mail-clients, run by the hub with no model: you get the task only when the script stops\. The string it returns/);
    const id = /trigger (t_[0-9a-f]+)/.exec(made)![1];
    const listed = JSON.parse((await callText("helper", "trigger_list", {})).replace(/^Timezone:[^\n]*\n/, ""));
    expect(listed.find((t: any) => t.id === id)).toMatchObject({ skill: "mail-clients", scriptRun: { input: { domain: "@kolesa.kz" } } });
    expect(await callText("helper", "trigger_delete", { id })).toMatch(/Deleted/i);
  });

  it("finishes with no model: the task is done with the script's words, which a report delivers", async () => {
    done.length = 0;
    const id = await createTrigger("helper", { name: "Weekly note", skill: "mail-clients", scriptRun: { input: { domain: "@kolesa.kz" } } });
    await callText("helper", "trigger_run_now", { id });
    const task = await taskOf(id, ["done", "failed"]);
    expect(task).toMatchObject({ status: "done", result: "Sent 1 (manual)", skill: "mail-clients", background: true });
    // The mail went without a card though the agent only suggests: the skill's card approved it.
    expect(done).toEqual([{ tool: "crm_find", input: {} }, { tool: "crm_mail", input: { to: "anna@kolesa.kz" } }]);
    expect(hub.approvals.list(["pending"])).toHaveLength(0);
    // No brain took part, and no background run of the day was spent.
    expect(brainsOf(task)).toEqual(["script@local"]);
    expect(hub.store.db.prepare("select count(*) as n from usage where agent_id = 'helper' and kind = 'background_run'").get()).toEqual({ n: 0 });
    expect(notes(task)[0]).toBe(scriptStarted("mail-clients"));
    expect(notes(task)[1]).toMatch(/^\[Script run\] The script of the skill "mail-clients" finished: 2 call\(s\)/);
    expect(thread(task).at(-1)).toMatchObject({ role: "assistant", agentId: "helper", parts: [{ type: "text", text: "Sent 1 (manual)" }] });
    const report = await until(() => hub.store.listMessages(hub.store.agentConversation("helper").id, { limit: 20 }).flatMap((m) => m.parts).find((p) => p.type === "notification" && p.kind === "report"), "the report");
    expect(report).toMatchObject({ title: "Weekly note", body: "Sent 1 (manual)" });
    const log = hub.audit.list({ limit: 200 });
    expect(log.find((e) => e.action === "skill.script.run" && (e.data as any)?.taskId === task.id)?.data).toMatchObject({ ok: true, calls: 2, noModel: true, triggerId: id });
    expect(log.filter((e) => e.action === "tool.call" && e.target === "crm_mail" && (e.data as any)?.taskId === task.id)).toHaveLength(1);
  });

  it("a step nobody approved is refused in the background run of an agent that only suggests: the agent takes the task", async () => {
    done.length = 0;
    const id = await createTrigger("helper", { name: "Others", skill: "mail-clients", scriptRun: { input: { domain: "@example.org" } } });
    await callText("helper", "trigger_run_now", { id });
    const task = await taskOf(id, ["done", "failed"]);
    expect(done.map((d) => d.tool)).toEqual(["crm_find"]);
    expect(hub.approvals.list(["pending"])).toHaveLength(0);
    const handover = notes(task).at(-1)!;
    expect(handover).toMatch(/^\[Script run\] The hub ran the script of the skill "mail-clients" for this task by itself, with no model\. It did not finish: you take the task from here\./);
    expect(handover).toMatch(/stopped at call 2, tools\.crm_mail\(\{"to":"bob@example\.org"\}\): it was refused/);
    // Its brain did the rest, in a session of its own after the script's.
    expect(brainsOf(task)).toEqual(["script@local", "fake@local"]);
    expect(task.status).toBe("done");
    expect(hub.store.db.prepare("select count as n from usage where agent_id = 'helper' and kind = 'background_run'").get()).toEqual({ n: 1 });
  });

  it("a step that needs the person's yes makes the task wait with no model; after the yes the agent does the rest", async () => {
    done.length = 0;
    const id = await createTrigger("doer", { name: "Ask first", skill: "mail-clients", scriptRun: { input: { domain: "@example.org" } } });
    await callText("doer", "trigger_run_now", { id });
    const card = await pending("crm_mail");
    expect(card.summary).toBe("Mail bob@example.org");
    const waiting = await taskOf(id, ["waiting_approval"]);
    await until(() => notes(waiting).some((n) => n.includes("that step needs the person's yes on its card")), "the script's note");
    expect(hub.store.getTask(waiting.id)).toMatchObject({ status: "waiting_approval", result: "The script of “mail-clients” waits for your answer on its card." });
    expect(brainsOf(waiting)).toEqual(["script@local"]);
    expect(done.map((d) => d.tool)).toEqual(["crm_find"]);

    hub.approvals.resolve(card.id, "approve", { via: "web" });
    const finished = await taskOf(id, ["done", "failed"]);
    expect(finished.status).toBe("done");
    // The hub did the approved step once, and the agent's brain took the task after it.
    expect(done.filter((d) => d.tool === "crm_mail")).toEqual([{ tool: "crm_mail", input: { to: "bob@example.org" } }]);
    expect(brainsOf(finished)).toEqual(["script@local", "fake@local"]);
    expect(notes(finished).some((n) => n.startsWith("[System] The user approved the action “Mail bob@example.org”"))).toBe(true);

    // A no ends the task: nobody is woken.
    await callText("doer", "trigger_run_now", { id, force: true });
    const second = await pending("crm_mail");
    await taskOf(id, ["waiting_approval"], 1);
    await until(() => hub.store.listTasks({ limit: 100 }).find((t) => t.triggerId === id && t.status === "waiting_approval" && t.result?.includes("waits for your answer")), "the second run to wait");
    hub.approvals.resolve(second.id, "deny", { via: "web" });
    const declined = await taskOf(id, ["done", "failed"], 1);
    expect(declined.result).toMatch(/waits for your answer on its card\.\n\n\(the user declined the action\)/);
    expect(brainsOf(declined)).toEqual(["script@local"]);
  });

  it("a run cut off under its script is never started again: the agent checks what is done", async () => {
    done.length = 0;
    const task = hub.runner.createTask({ agentId: "helper", goal: "Mail our clients the weekly note", title: "Cut off", background: true, createdBy: "trigger", skill: "mail-clients", script: { input: { domain: "@kolesa.kz" } } });
    // As a restart leaves it: the script's start is in the thread, its end is not.
    hub.store.addMessage({ conversationId: task.conversationId, role: "system", parts: [{ type: "text", text: scriptStarted("mail-clients") }], status: "complete", taskId: task.id });
    const ended = await until(() => {
      const t = hub.store.getTask(task.id);
      return t && ["done", "failed"].includes(t.status) ? t : undefined;
    }, "the cut-off task to end");
    expect(ended.status).toBe("done");
    expect(done).toEqual([]);
    expect(brainsOf(ended)).toEqual(["fake@local"]);
  });

  it("a skill that lost its script goes to the agent", async () => {
    const task = hub.runner.createTask({ agentId: "helper", goal: "Do it", title: "No script", background: true, createdBy: "trigger", skill: "by-hand", script: { input: {} } });
    const ended = await until(() => {
      const t = hub.store.getTask(task.id);
      return t && ["done", "failed"].includes(t.status) ? t : undefined;
    }, "the task to end");
    expect(notes(ended)[0]).toMatch(/the skill has no script now\. Do the task by hand/);
    expect(brainsOf(ended)).toEqual(["fake@local"]);
  });
});
