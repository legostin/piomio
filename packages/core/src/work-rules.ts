// The team's standing rules for where work goes (docs/superpowers/specs/2026-11-02-persistent-agents-design.md): said
// once to any agent ("renders go to LEGOSTIN-PC"), kept in the settings (so replicas have them too) and followed by
// every dialog when it starts tasks.

import type { WorkRule } from "@piomio/shared";
import { newId, nowIso } from "@piomio/shared";
import type { Settings } from "./settings.ts";

/** Settings key: the rules, oldest first. */
const KEY = "workRules";
/** More than this many is no longer a rule book anyone follows. */
export const MAX_WORK_RULES = 30;

export class WorkRules {
  private settings: Settings;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  list(): WorkRule[] {
    const v = this.settings.getKey<unknown>(KEY, []);
    return Array.isArray(v) ? v.filter((r): r is WorkRule => !!r && typeof r.id === "string" && typeof r.when === "string") : [];
  }

  /** A new rule, or the one with `id` changed (its other fields as given). Undefined: no rule with that id, or too many. */
  set(r: Omit<WorkRule, "id" | "createdAt"> & { id?: string }): WorkRule | undefined {
    const all = this.list();
    const old = r.id ? all.find((x) => x.id === r.id) : undefined;
    if (r.id && !old) return undefined;
    if (!old && all.length >= MAX_WORK_RULES) return undefined;
    const rule: WorkRule = {
      id: old?.id ?? newId("rule_"),
      when: r.when,
      ...(r.machine ? { machine: r.machine } : {}),
      ...(r.agent ? { agent: r.agent } : {}),
      ...(r.brain ? { brain: r.brain } : {}),
      createdAt: old?.createdAt ?? nowIso(),
    };
    this.settings.setKey(KEY, old ? all.map((x) => (x.id === old.id ? rule : x)) : [...all, rule]);
    return rule;
  }

  remove(id: string): WorkRule | undefined {
    const all = this.list();
    const gone = all.find((x) => x.id === id);
    if (gone) this.settings.setKey(KEY, all.filter((x) => x !== gone));
    return gone;
  }

  /** What a dialog's session was opened with: a changed rule opens it again with the new instructions. */
  stamp(): string {
    return JSON.stringify(this.list());
  }
}

/** "rendering → computer LEGOSTIN-PC (mach_…); agent blenderist; brain claude-code", names from `name`. */
export function ruleLine(r: WorkRule, computerName: (id: string) => string): string {
  const to = [r.machine ? `computer ${computerName(r.machine)} (${r.machine})` : "", r.agent ? `agent ${r.agent}` : "", r.brain ? `brain ${r.brain}` : ""].filter(Boolean).join("; ");
  return `- ${r.id}: ${r.when}${to ? ` → ${to}` : ""}`;
}
