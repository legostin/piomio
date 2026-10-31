# Skill Holders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each teammate has the skills given to it: a taught skill goes to the agent who learned it, any agent can give a skill to teammates in the chat, and agents see who has which skill.

**Architecture:** A replicated table `skill_agents` (skill → agent ids; no row = the whole team) behind `SkillHolders` in `packages/core/src/skills.ts`. `SkillIndex.forAgent` applies the rule; sessions, prompts and tools read it; the web shows it.

**Tech Stack:** Node 24 TypeScript (type stripping), node:sqlite, vitest, React (packages/web).

Spec: `docs/superpowers/specs/2026-10-31-skill-holders-design.md`.

## Global Constraints

- Import local files with `.ts`; only erasable syntax; `import type` for types.
- Every user-facing string goes through a catalog (`packages/web/src/i18n/{en,ru}.ts`, `packages/core/src/locales/{en,ru}.ts`); text for the model stays English.
- Tests write temp files only under `tmpdir()`.
- No row in `skill_agents` = the skill is the whole team's.

---

### Task 1: Who has a skill (core)

**Files:**
- Modify: `packages/core/src/db.ts` (migration), `packages/core/src/cluster.ts` (`MAIN_TABLES`), `packages/core/src/skills.ts`, `packages/core/src/app.ts` (wire holders; `removeAgent`), `packages/core/src/bus.ts` + `packages/shared/src/types.ts` (`skills.updated` event)
- Test: `packages/core/test/skill-holders.test.ts`

**Interfaces:**
- Produces: `class SkillHolders { get(skill): string[]; all(): Map<string, string[]>; set(skill, agents: string[]): void; dropAgent(id): void }`;
  `hasSkill(agent: Pick<AgentDef,"id"|"skills">, skill: string, holders: string[]): boolean`;
  `SkillIndex.holders?: SkillHolders`; `SkillIndex.forAgent(agent, also?: string): Skill[]`; `SkillIndex.has(agent, name, also?): boolean`; `SkillIndex.ownOf(agentId): string[]`.

- [ ] Write tests: `SkillHolders` on `openDb(":memory:")` (set → get, `[]` deletes the row, `dropAgent` removes one and an emptied list goes back to the team); `hasSkill` with globs and holders; `forAgent` with `also`.
- [ ] Run: `npx vitest run packages/core/test/skill-holders.test.ts` → fails (no exports).
- [ ] Migration: `` `create table skill_agents(skill text primary key, agents text not null);` `` at the end of `MIGRATIONS`; `{ name: "skill_agents", pk: ["skill"] }` in `MAIN_TABLES`.
- [ ] `skills.ts`:

```ts
export function hasSkill(agent: Pick<AgentDef, "id" | "skills">, skill: string, holders: string[]): boolean {
  return matchesAny(skill, agent.skills.length ? agent.skills : ["*"]) && (!holders.length || holders.includes(agent.id));
}

export class SkillHolders {
  constructor(private db: Db) {}
  get(skill: string): string[] {
    const r = this.db.prepare("select agents from skill_agents where skill = ?").get(skill) as { agents: string } | undefined;
    return json<string[]>(r?.agents, []);
  }
  all(): Map<string, string[]> {
    const rows = this.db.prepare("select skill, agents from skill_agents").all() as Array<{ skill: string; agents: string }>;
    return new Map(rows.map((r) => [r.skill, json<string[]>(r.agents, [])]));
  }
  set(skill: string, agents: string[]): void {
    const list = [...new Set(agents)];
    if (!list.length) this.db.prepare("delete from skill_agents where skill = ?").run(skill);
    else this.db.prepare("insert into skill_agents(skill, agents) values (?, ?) on conflict(skill) do update set agents = excluded.agents").run(skill, JSON.stringify(list));
  }
  dropAgent(agentId: string): void {
    for (const [skill, agents] of this.all()) if (agents.includes(agentId)) this.set(skill, agents.filter((a) => a !== agentId));
  }
}
```

  `SkillIndex.forAgent(agent, also?)` = `list().filter((s) => s.name === also || hasSkill(agent, s.name, held.get(s.name) ?? []))`; `has` the same for one name; `ownOf(id)` = names of listed skills whose holders include `id`.
- [ ] `app.ts`: after `openDb`, `this.skills.holders = new SkillHolders(this.db)`; `removeAgent`: after `this.agents.remove(id)`, `if (!this.agents.get(id)) { this.skills.holders?.dropAgent(id); this.bus.emit("skills.updated", {}); }`.
- [ ] `bus.ts` event `"skills.updated": Record<string, never>` + `toUiEvent` case; `UiEvent` union member in `packages/shared/src/types.ts`.
- [ ] Run the test → passes. Commit.

### Task 2: Sessions see their own skills and their teammates'

**Files:** Modify `packages/core/src/runner.ts` (`forAgent(agent, task?.skill)`; `dispatchContext` team `skills: this.d.skills.ownOf(a.id)`), `packages/core/src/prompt.ts` (team entry `skills?: string[]`, printed first in the parentheses: `(skills: a, b; brains: …; on: …)`; the "Choose who does it" line says skills in the team list are that teammate's own).
- Test: `packages/core/test/skill-holders.test.ts` (prompt via `buildSystemPrompt`).

- [ ] Test: a dispatch team entry with `skills: ["insta-post"]` prints `- smm: SMM — Runs pages (skills: insta-post; on: MacBook)`; the Skills section lists only the given skills.
- [ ] Implement, run, commit.

### Task 3: Chat tools

**Files:** Modify `packages/core/src/tools/core-tools.ts` (`skill_load`), `packages/core/src/tools/hub-tools.ts` (`HUB_TOOLS_FOR_EVERY_AGENT`, `agents_list`, new `skills_list` and `skill_assign`, `skill_save`, `skill_delete`), `packages/core/src/locales/{en,ru}.ts` (`skills.assign`, `skills.assignTeam` card texts), `packages/core/src/server/api.ts` (`/api/skills` adds `agents`).
- Test: `packages/core/test/skill-holders.test.ts` (a Hub on fixtures, like `taught-skills.test.ts`), `packages/core/test/taught-skills.test.ts` (result text).

- [ ] Tests on a hub: `hub_skill_assign` sets / clears / refuses an unknown skill or agent and is offered to every agent; `hub_skills_list` shows `has`; `skill_load` of a skill given to another agent refuses and names them, while a task following that skill loads it; `hub_agents_list` shows `skills`; `/api/skills` carries `agents`; removing an agent gives its only-skill back to the team.
- [ ] `skill_load`: refuse when `!d.skills.has(agent, name, task?.skill)` with `"<name> is not one of your skills: <id> (<name>) has it. Ask them with team_message or hand them the work with task_delegate."`.
- [ ] `hub_skill_assign {name, agents}`: checks, `holders.set`, audit `skill.assign`, emit `skills.updated`; notes agents whose skill patterns leave it out.
- [ ] `hub_skill_save` inside `save()`: new → `holders.set(name, [ctx.agentId])`; `replaces` with another name → the old holders move to the new name; result: "It is yours: only you have it; hub_skill_assign gives it to teammates when the person wants." / "Who has it stays the same."; emit `skills.updated`. `hub_skill_delete`: `holders.set(name, [])`, emit.
- [ ] Run tests (`skill-holders`, `taught-skills`, `i18n`), commit.

### Task 4: Web

**Files:** Modify `packages/web/src/pages/Skills.tsx` (holders per skill: avatars + names or "Whole team"; a "Who has it" button → `askInChat(undefined, t("skills.askHolders", { name }), navigate)`; reload on `skills.updated` / `agents.updated`), `packages/web/src/pages/Agents.tsx` (chips with each agent's own skills from `/api/skills`), `packages/web/src/state/app.ts` (nothing unless needed), `packages/web/src/i18n/{en,ru}.ts`.

- [ ] Implement; `npm run typecheck`; `npx vitest run packages/core/test/i18n.test.ts`; build the web (`npm run build -w @piomio/web` or `npm run build`). Commit.

### Task 5: Verification

- [ ] `npm run typecheck`, `npm test`.
- [ ] A throwaway hub (temp data dir): give a skill to an agent with the API/tool, look at the Skills and Agents pages in the browser pane; stop the hub and delete its data dir.
