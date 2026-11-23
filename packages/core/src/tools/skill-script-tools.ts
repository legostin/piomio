// skill_run and skill_script_save: the script of a skill the person taught by showing (skill-scripts.ts). The agent
// runs it with one call instead of a call per click, and fixes it by itself when a run stops: a new version needs no
// card, since a script reaches nothing new (its opens are held to the skill's sites, each of its calls is decided by the
// policy when it runs, and the sites and pre-approvals change only on hub_skill_save's card).

import type { AgentDef, ToolCallContext, ToolResult } from "@piomio/shared";
import type { AuditLog } from "../audit.ts";
import { checkSkillScript, describeRun, runSkillScript, SKILL_SCRIPT_FILE, type SkillScriptDeps } from "../skill-scripts.ts";
import type { Skill, SkillIndex } from "../skills.ts";
import type { Store } from "../store.ts";
import { readSkillScript, restoreSkillScript, saveSkillScript, scriptText } from "../taught-skills.ts";
import type { ToolRegistry } from "./registry.ts";

export interface SkillScriptToolDeps {
  registry: ToolRegistry;
  skills: SkillIndex;
  agents: { get(id: string): AgentDef | undefined };
  store: Pick<Store, "getTask">;
  audit: Pick<AuditLog, "append">;
  /** ToolGateway.call: one of the agent's tools, called as the agent in that session. */
  call: (sessionId: string, tool: string, input: unknown) => Promise<ToolResult>;
  /** The skills changed (the panel lists them). */
  changed?: () => void;
  /** Tests run scripts in a sandbox of their own. */
  run?: Pick<SkillScriptDeps, "sandbox" | "limits">;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

export function registerSkillScriptTools(d: SkillScriptToolDeps): void {
  /** A taught skill the calling agent has (a task following a skill has that one), or why not. */
  const skillOf = (input: any, ctx: ToolCallContext): Skill | string => {
    const name = String(input?.name ?? "").trim();
    if (!name) return "name is required: the skill's name.";
    const skill = d.skills.get(name);
    if (!skill) return `There is no skill "${name}".`;
    if (!skill.taught) return `"${name}" was not taught by showing: only a taught skill has a script.`;
    const agent = d.agents.get(ctx.agentId);
    const follows = ctx.taskId ? d.store.getTask(ctx.taskId)?.skill : undefined;
    if (agent && !d.skills.has(agent, name, follows)) return `${name} is not one of your skills: ask the teammate who has it, or hand them the work with task_delegate.`;
    return skill;
  };

  d.registry.register(
    {
      name: "skill_run",
      owner: "core",
      effect: "local-write",
      // What comes back was read from pages.
      source: true,
      description:
        "Run the script of a taught skill (skill_load says when it has one): the hub does the skill's browser steps itself, as you would with " +
        "browser_click and the rest, in one call. `input` is what changes this time, as the skill's Inputs name it. It returns what the script " +
        "returned, or where it stopped and why: then finish the task by hand from that point and fix the script with skill_script_save. " +
        "Every step is checked like your own: consequential ones still need the skill's approved limit or the person's tap.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The taught skill's name" },
          input: { type: "object", description: "The script's input, e.g. {\"quantity\": 2}" },
        },
        required: ["name"],
      },
    },
    async (input, ctx) => {
      const skill = skillOf(input, ctx);
      if (typeof skill === "string") return text(skill, true);
      const code = readSkillScript(skill);
      if (code === undefined) {
        return text(`"${skill.name}" has no script: do its steps by hand as its instructions say. When they are the same every time, write one (skill_script_save).`, true);
      }
      if (input?.input !== undefined && (typeof input.input !== "object" || input.input === null || Array.isArray(input.input))) return text("input must be an object, e.g. {\"quantity\": 2}.", true);
      const run = await runSkillScript(code, input?.input ?? {}, { call: (tool, toolInput) => d.call(ctx.sessionId, tool, toolInput), sites: skill.sites, ...d.run });
      d.audit.append(`agent:${ctx.agentId}`, "skill.script.run", skill.name, {
        ok: run.ok,
        calls: run.trace.length,
        ms: run.ms,
        ...(run.halted ? { halted: run.halted } : {}),
        ...(run.error ? { error: run.error.slice(0, 300) } : {}),
      });
      return { ...text(describeRun(skill.name, run, code), !run.ok), _meta: { taint: true } };
    },
  );

  d.registry.register(
    {
      name: "skill_script_save",
      owner: "core",
      effect: "local-write",
      description:
        "Write or fix the script of a taught skill you have: JavaScript that does the skill's mechanical browser steps, so later runs take one " +
        "call (skill_run). Write one when the steps are the same every time and a run by hand has proven them; fix it after a run stopped and " +
        "you finished by hand. `script` is the whole script; `note` one line on what changed and why. The version before stays: {name, restore: true} " +
        "brings it back. Needs no card: the skill's sites and the clicks it may do without asking stay as the person approved them " +
        "(those change with hub_skill_save). How to write a script is in the teach-by-demo skill.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The taught skill's name" },
          script: { type: "string", description: "The whole script: export default async function (input, browser) { … }" },
          note: { type: "string", description: "One line: what changed and why" },
          restore: { type: "boolean", description: "Bring the previous version back instead of saving a new one" },
        },
        required: ["name"],
      },
    },
    async (input, ctx) => {
      const skill = skillOf(input, ctx);
      if (typeof skill === "string") return text(skill, true);
      try {
        if (input?.restore === true) {
          restoreSkillScript(skill);
          d.audit.append(`agent:${ctx.agentId}`, "skill.script.restore", skill.name, {});
          d.changed?.();
          return text(`The previous version of the script of "${skill.name}" is back. Tell the person in one line.`);
        }
        const code = scriptText(input?.script);
        const wrong = await checkSkillScript(code, d.run?.sandbox);
        if (wrong !== undefined) return text(`Not saved, the script does not compile: ${wrong}`, true);
        const { replaced } = saveSkillScript(skill, code);
        const note = typeof input?.note === "string" ? input.note.trim().slice(0, 300) : "";
        d.audit.append(`agent:${ctx.agentId}`, "skill.script.save", skill.name, { bytes: Buffer.byteLength(code), replaced, tainted: ctx.tainted, ...(note ? { note } : {}) });
        d.changed?.();
        return text(
          `Saved the script of "${skill.name}" (${SKILL_SCRIPT_FILE})${replaced ? "; the version before it is kept (restore: true brings it back)" : ""}. ` +
            `skill_run runs it. Tell the person in one line what ${replaced ? "you changed" : "it does now"}.`,
        );
      } catch (e: any) {
        return text(e?.message ?? String(e), true);
      }
    },
  );
}
