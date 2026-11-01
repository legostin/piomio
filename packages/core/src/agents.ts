// Agents are markdown files with frontmatter (compatible with Claude Code subagent files).
// Sources, later wins: builtin (repo /agents) → plugin agents with `brains:` → user (/data/agents).
// What the person did with them (archived, deleted built-ins) is agents-state.ts: the team is the agents not archived.

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { stringify as toYaml } from "yaml";
import type { AgentDef, Locale } from "@piomio/shared";
import { normalizeLocale, parseAvatar, parseFrontmatter, parseThinking } from "@piomio/shared";
import type { AgentsState } from "./agents-state.ts";

export const DEFAULT_BRAINS = ["claude-code@local", "codex@local", "kimi@local", "api:*"];

export function agentFromMarkdown(id: string, text: string, source: string): AgentDef {
  const { data, body } = parseFrontmatter(text);
  const list = (v: unknown, d: string[]): string[] =>
    Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : d;
  const initiative = Number(data.initiative ?? 1);
  const machines = list(data.machines, []);
  return {
    id,
    name: String(data.name ?? id),
    description: String(data.description ?? ""),
    brains: list(data.brains, DEFAULT_BRAINS),
    ...(machines.length ? { machines } : {}),
    model: data.model ? String(data.model) : undefined,
    thinking: parseThinking(data.thinking),
    initiative: (initiative === 0 || initiative === 2 ? initiative : 1) as 0 | 1 | 2,
    tools: list(data.tools, ["*"]),
    skills: list(data.skills, ["*"]),
    policyProfile: String(data.policyProfile ?? "default"),
    budget: {
      backgroundRunsPerDay: Number(data.budget?.backgroundRunsPerDay ?? 30),
      tokensPerDay: data.budget?.tokensPerDay ? Number(data.budget.tokensPerDay) : undefined,
    },
    prompt: body.trim(),
    source,
    avatar: parseAvatar(data.avatar),
    i18n: parseAgentI18n(data.i18n),
  };
}

function parseAgentI18n(v: unknown): AgentDef["i18n"] {
  if (!v || typeof v !== "object") return undefined;
  const out: NonNullable<AgentDef["i18n"]> = {};
  for (const [k, x] of Object.entries(v as Record<string, any>)) {
    const l = normalizeLocale(k);
    if (!l || !x || typeof x !== "object") continue;
    out[l] = { ...(x.name ? { name: String(x.name) } : {}), ...(x.description ? { description: String(x.description) } : {}) };
  }
  return Object.keys(out).length ? out : undefined;
}

/** The agent with its name and description in `locale` (when the definition has a translation). */
export function localizedAgent(a: AgentDef, locale: Locale): AgentDef {
  const tr = a.i18n?.[locale];
  return tr ? { ...a, name: tr.name ?? a.name, description: tr.description ?? a.description } : a;
}

/**
 * `prev` with `patch` applied. A translated agent keeps its other languages: a new name or description goes into its
 * `locale` translation when it has one, the rest into the definition.
 */
export function patchAgent(prev: AgentDef, patch: Partial<AgentDef>, locale: Locale): AgentDef {
  const tr = prev.i18n?.[locale];
  if (!tr || (patch.name === undefined && patch.description === undefined)) return { ...prev, ...patch };
  const { name, description, ...rest } = patch;
  const edited = { ...tr, ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}) };
  return { ...prev, ...rest, i18n: { ...prev.i18n, [locale]: edited } };
}

export function agentName(a: AgentDef, locale: Locale): string {
  return a.i18n?.[locale]?.name ?? a.name;
}

export function agentToMarkdown(a: AgentDef): string {
  const fm: Record<string, unknown> = {
    name: a.name,
    description: a.description,
    ...(parseAvatar(a.avatar) ? { avatar: parseAvatar(a.avatar) } : {}),
    brains: a.brains,
    ...(a.machines?.length ? { machines: a.machines } : {}),
    ...(a.model ? { model: a.model } : {}),
    ...(parseThinking(a.thinking) ? { thinking: parseThinking(a.thinking) } : {}),
    initiative: a.initiative,
    tools: a.tools,
    skills: a.skills,
    policyProfile: a.policyProfile,
    budget: a.budget,
    ...(a.i18n ? { i18n: a.i18n } : {}),
  };
  return `---\n${toYaml(fm).trim()}\n---\n${a.prompt.trim()}\n`;
}

export class AgentRegistry {
  private agents = new Map<string, AgentDef>();
  builtinDir: string;
  userDir: string;
  pluginDirs: Array<{ pluginId: string; dir: string }> = [];

  constructor(builtinDir: string, userDir: string) {
    this.builtinDir = builtinDir;
    this.userDir = userDir;
    mkdirSync(userDir, { recursive: true });
    this.reload();
  }

  private loadDir(dir: string, source: string, requireBrains: boolean): void {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const id = basename(f, ".md").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      try {
        const text = readFileSync(join(dir, f), "utf8");
        if (requireBrains && parseFrontmatter(text).data.brains === undefined) continue;
        this.agents.set(id, agentFromMarkdown(id, text, source));
      } catch (e) {
        console.error(`[agents] failed to load ${f}:`, (e as Error).message);
      }
    }
  }

  reload(): void {
    this.agents.clear();
    this.loadDir(this.builtinDir, "builtin", false);
    for (const p of this.pluginDirs) this.loadDir(p.dir, `plugin:${p.pluginId}`, true);
    this.loadDir(this.userDir, "user", false);
    if (!this.agents.has("assistant")) {
      this.agents.set(
        "assistant",
        agentFromMarkdown(
          "assistant",
          "---\nname: Assistant\ndescription: Main assistant\ni18n:\n  ru:\n    name: Ассистент\n    description: Главный ассистент\n---\nYou are a friendly and proactive personal assistant.",
          "builtin",
        ),
      );
    }
  }

  /** Set by the hub (agents-state.ts); the registry alone knows of no archive. */
  state: () => Pick<AgentsState, "archived" | "removed"> = () => ({ archived: [], removed: [] });

  /** An agent by id, archived ones too (their dialog still opens); never one the person deleted. */
  get(id: string): AgentDef | undefined {
    const a = this.agents.get(id);
    return a && !this.state().removed.includes(id) ? a : undefined;
  }

  /** The team: every agent but the archived (asleep) ones. */
  list(): AgentDef[] {
    const { archived } = this.state();
    return this.all().filter((a) => !archived.includes(a.id));
  }

  /** The team and the archive. */
  all(): AgentDef[] {
    const { removed } = this.state();
    return [...this.agents.values()]
      .filter((a) => !removed.includes(a.id))
      .sort((a, b) => (a.id === "assistant" ? -1 : b.id === "assistant" ? 1 : a.name.localeCompare(b.name)));
  }

  isArchived(id: string): boolean {
    return this.state().archived.includes(id);
  }

  /** The agent ships with the hub or a plugin (the person's own copy, if any, sits over it). */
  shipped(id: string): boolean {
    const f = (dir: string) => existsSync(join(dir, `${id}.md`));
    return id === "assistant" || f(this.builtinDir) || this.pluginDirs.some((p) => f(p.dir));
  }

  save(a: AgentDef): AgentDef {
    const id = a.id.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    writeFileSync(join(this.userDir, `${id}.md`), agentToMarkdown({ ...a, id }));
    this.reload();
    return this.get(id)!;
  }

  remove(id: string): void {
    const f = join(this.userDir, `${id}.md`);
    if (existsSync(f)) rmSync(f);
    this.reload();
  }
}
