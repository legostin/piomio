// Agent Skills (folders with SKILL.md) and slash commands (commands/*.md).

import { readdirSync, readFileSync, existsSync, mkdirSync, cpSync, statSync, rmSync } from "node:fs";
import { join, basename, relative } from "node:path";
import type { AgentDef } from "@piomio/shared";
import { matchesAny, parseFrontmatter } from "@piomio/shared";
import { json, type Db } from "./db.ts";

export interface Skill {
  name: string;
  description: string;
  dir: string;
  source: string;
  /**
   * The person taught it by showing the task (frontmatter `taught: true`, written by hub_skill_save on their tap): its
   * background runs may click and type. Only the user's own skills folder counts; a plugin's skill saying so does not.
   */
  taught: boolean;
  /** The sites it works on (frontmatter `sites`). */
  sites: string[];
}

/** The source of the skills in the hub's data dir (`<dataDir>/skills`), where taught skills are saved. */
export const USER_SKILLS = "user";

/** Frontmatter `sites`: a list, or one site as a string. */
function sitesOf(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  return list.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim());
}

export interface Command {
  name: string;
  description: string;
  body: string;
  source: string;
}

/** The agent has the skill: its name fits the agent's patterns, and it is the whole team's (no holders) or the agent's. */
export function hasSkill(agent: Pick<AgentDef, "id" | "skills">, skill: string, holders: string[]): boolean {
  return matchesAny(skill, agent.skills.length ? agent.skills : ["*"]) && (!holders.length || holders.includes(agent.id));
}

/** Who has each skill (table skill_agents): a skill with no row is the whole team's, one with a row only its agents'. */
export class SkillHolders {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** The agents the skill was given to; empty: the whole team. */
  get(skill: string): string[] {
    const r = this.db.prepare("select agents from skill_agents where skill = ?").get(skill) as { agents: string } | undefined;
    return json<string[]>(r?.agents, []);
  }

  all(): Map<string, string[]> {
    const rows = this.db.prepare("select skill, agents from skill_agents").all() as Array<{ skill: string; agents: string }>;
    return new Map(rows.map((r) => [r.skill, json<string[]>(r.agents, [])]));
  }

  /** Give the skill to these agents only; none: back to the whole team. */
  set(skill: string, agents: string[]): void {
    const list = [...new Set(agents)];
    if (!list.length) this.db.prepare("delete from skill_agents where skill = ?").run(skill);
    else this.db.prepare("insert into skill_agents(skill, agents) values (?, ?) on conflict(skill) do update set agents = excluded.agents").run(skill, JSON.stringify(list));
  }

  /** An agent left the team: its skills stay with the others, and one only it had goes back to the whole team. */
  dropAgent(agentId: string): void {
    for (const [skill, agents] of this.all()) if (agents.includes(agentId)) this.set(skill, agents.filter((a) => a !== agentId));
  }
}

export class SkillIndex {
  private skills = new Map<string, Skill>();
  private commands = new Map<string, Command>();
  roots: Array<{ source: string; skillsDir?: string; commandsDir?: string }> = [];
  /** Who has each skill (the hub sets it); without it every skill is the whole team's. */
  holders?: SkillHolders;

  setRoots(roots: Array<{ source: string; skillsDir?: string; commandsDir?: string }>): void {
    this.roots = roots;
    this.reload();
  }

  reload(): void {
    this.skills.clear();
    this.commands.clear();
    for (const r of this.roots) {
      if (r.skillsDir && existsSync(r.skillsDir)) {
        for (const d of readdirSync(r.skillsDir)) {
          const dir = join(r.skillsDir, d);
          const file = join(dir, "SKILL.md");
          if (!existsSync(file)) continue;
          try {
            const { data } = parseFrontmatter(readFileSync(file, "utf8"));
            const name = String(data.name ?? d);
            const taught = r.source === USER_SKILLS && data.taught === true;
            this.skills.set(name, { name, description: String(data.description ?? ""), dir, source: r.source, taught, sites: sitesOf(data.sites) });
          } catch (e) {
            console.error(`[skills] bad SKILL.md in ${dir}:`, (e as Error).message);
          }
        }
      }
      if (r.commandsDir && existsSync(r.commandsDir)) {
        for (const f of readdirSync(r.commandsDir)) {
          if (!f.endsWith(".md")) continue;
          const { data, body } = parseFrontmatter(readFileSync(join(r.commandsDir, f), "utf8"));
          const name = basename(f, ".md");
          this.commands.set(name, { name, description: String(data.description ?? ""), body, source: r.source });
        }
      }
    }
  }

  list(): Skill[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The skills `agent` has; `also` is one its session follows anyway (a trigger's run of a skill). */
  forAgent(agent: Pick<AgentDef, "id" | "skills">, also?: string): Skill[] {
    const held = this.holders?.all() ?? new Map<string, string[]>();
    return this.list().filter((s) => s.name === also || hasSkill(agent, s.name, held.get(s.name) ?? []));
  }

  has(agent: Pick<AgentDef, "id" | "skills">, name: string, also?: string): boolean {
    return name === also || hasSkill(agent, name, this.holders?.get(name) ?? []);
  }

  /** The skills given to the agent itself (not the whole team's ones). */
  ownOf(agentId: string): string[] {
    const held = this.holders?.all() ?? new Map<string, string[]>();
    return this.list()
      .filter((s) => held.get(s.name)?.includes(agentId))
      .map((s) => s.name);
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /** SKILL.md plus a listing of bundled files. */
  load(name: string): string | undefined {
    const s = this.skills.get(name);
    if (!s) return undefined;
    const body = readFileSync(join(s.dir, "SKILL.md"), "utf8");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (f !== "SKILL.md") files.push(relative(s.dir, p).replace(/\\/g, "/"));
      }
    };
    walk(s.dir);
    return `${body}\n\n---\nSkill files (directory ${s.dir}):\n${files.map((f) => `- ${f}`).join("\n") || "(none)"}`;
  }

  /** Copy enabled skills into a workspace folder the harness reads (e.g. .claude/skills). */
  materialize(targetDir: string, skills: Skill[]): void {
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(targetDir, { recursive: true });
    for (const s of skills) cpSync(s.dir, join(targetDir, s.name.replace(/[^a-zA-Z0-9_-]/g, "-")), { recursive: true });
  }

  listCommands(): Command[] {
    return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** "/name args" → prompt text, or undefined if not a known command. */
  expandCommand(text: string): string | undefined {
    const m = /^\/([a-zA-Z0-9_:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (!m) return undefined;
    const cmd = this.commands.get(m[1]);
    if (!cmd) return undefined;
    const args = (m[2] ?? "").trim();
    const positional = args.split(/\s+/);
    let body = cmd.body.replace(/\$ARGUMENTS/g, args);
    body = body.replace(/\$(\d)/g, (_, n: string) => positional[Number(n) - 1] ?? "");
    return body.trim();
  }
}
