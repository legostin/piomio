// Skills the person taught by showing a task in the agents' browser (docs/superpowers/specs/2026-10-31-teach-mode-design.md).
// hub_skill_save writes one on the person's tap: <dataDir>/skills/<name>/SKILL.md (frontmatter `taught: true`, `sites`)
// with the files the agent keeps from the recording, and one browser_submit rule per click the person pre-approved
// (created via "skill", noted `skill:<name>`). Errors are English: they go back to the model.

import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { stringify as toYaml } from "yaml";
import type { Locale, Rule, RuleCondition } from "@piomio/shared";
import { hostOf, parseFrontmatter } from "@piomio/shared";
import { tFor } from "./i18n.ts";
import type { RuleStore } from "./policy/rules.ts";
import { MAX_SCRIPT_BYTES } from "./signals/sandbox.ts";
import { SKILL_SCRIPT_FILE, SKILL_SCRIPT_PREV } from "./skill-scripts.ts";
import { USER_SKILLS, type Skill, type SkillIndex } from "./skills.ts";

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_SKILL_DESCRIPTION = 300;
export const MAX_SKILL_INSTRUCTIONS = 20_000;
export const MAX_SKILL_FILES = 20;
export const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SITES = 20;
const MAX_ALLOW = 10;
const MAX_LABEL = 120;

/**
 * What the person agreed may run without a card: a click (browser_submit on `site`, on the control named `label`), or
 * a request of the agent's own (browser_request_send of `request.method` to an address that starts as
 * `request.address` does).
 */
export interface SkillAllow {
  site: string;
  label?: string;
  request?: { method: string; address: string };
  maxAmount?: number;
  currency?: string;
}

/** hub_skill_save's input, checked and normalized. */
export interface SkillSave {
  name: string;
  description: string;
  instructions: string;
  files: string[];
  sites: string[];
  allow: SkillAllow[];
  replaces?: string;
  /** The skill's script (skill-scripts.ts): JavaScript for the mechanical part of the task, run with skill_run. */
  script?: string;
}

/** The rule note that ties a pre-approval to its skill. */
export const skillNote = (name: string): string => `skill:${name}`;

/** "5vodi.kz", "https://www.5vodi.kz/cart" → "5vodi.kz"; undefined for anything that is not one site. */
export function siteHost(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  if (!s || /[\s*?]/.test(s)) return undefined;
  const host = hostOf(s.includes("://") ? s : `https://${s}`);
  if (!host || (!host.includes(".") && host !== "localhost")) return undefined;
  return host.replace(/^www\./, "");
}

/** A run of digits, with the spaces (no-break ones too), commas and dots that group them ("2 400,50"). */
const DIGIT_RUN = /\d(?:[\s.,]?\d)*/g;

/** The rule's label condition: the exact name, or a pattern where the numbers in it may change ("Pay * ₸"). */
export function labelCondition(label: string): RuleCondition {
  const l = label.trim();
  return /\d/.test(l) ? { field: "label", op: "glob", value: l.replace(DIGIT_RUN, "*") } : { field: "label", op: "eq", value: l };
}

/** The rule one pre-approval becomes. */
export function allowRule(skill: string, a: SkillAllow): Omit<Rule, "id" | "createdAt"> {
  const conditions: RuleCondition[] = a.request
    ? // The address is matched from its first character (scheme and host as approved), so nothing before the path can vary.
      [{ field: "url", op: "domain", value: a.site }, { field: "method", op: "eq", value: a.request.method }, { field: "url", op: "glob", value: a.request.address }]
    : [{ field: "url", op: "domain", value: a.site }, labelCondition(a.label ?? "")];
  if (a.maxAmount !== undefined) conditions.push({ field: "amount", op: "max", value: a.maxAmount });
  if (a.currency) conditions.push({ field: "currency", op: "eq", value: a.currency });
  return { tool: a.request ? "browser_request_send" : "browser_submit", conditions, decision: "allow", note: skillNote(skill), createdVia: "skill" };
}

const REQUEST_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** "POST https://api.5vodi.kz/v1/orders*" → the method and the address pattern (its host spelled out, no query). */
function allowRequest(v: unknown): { method: string; address: string; site: string } {
  const m = typeof v === "string" ? /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(v) : null;
  const method = m?.[1].toUpperCase() ?? "";
  const example = 'e.g. "POST https://api.5vodi.kz/v1/orders*"';
  if (!m || !REQUEST_METHODS.has(method)) fail(`allow.request is a method (POST, PUT, PATCH or DELETE) and an address, ${example}.`);
  const address = /^https?:\/\//i.test(m![2]) ? m![2] : `https://${m![2]}`;
  const parts = /^(https?:\/\/)([^/?#*]+)(\/[^?#]*)$/i.exec(address);
  if (!parts || address.length > 300) fail(`allow.request: the address needs its host and a path, without a query, and * only in the path, ${example}.`);
  const site = siteHost(parts![2]) ?? fail(`allow.request: ${JSON.stringify(parts![2])} is not a site.`);
  return { method, address: `${parts![1].toLowerCase()}${parts![2].toLowerCase()}${parts![3]}`, site };
}

function fail(message: string): never {
  throw new Error(message);
}

function str(v: unknown, field: string, max: number): string {
  if (typeof v !== "string" || !v.trim()) fail(`${field} is required.`);
  const s = (v as string).trim();
  if (s.length > max) fail(`${field} is too long (at most ${max} characters).`);
  return s;
}

function list(v: unknown, field: string, max: number): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return fail(`${field} must be a list.`);
  if (v.length > max) fail(`${field}: at most ${max}.`);
  return v;
}

/** Check hub_skill_save's fields (not yet the files or the names of other skills: see `checkSkillSave`). */
export function parseSkillSave(input: any): SkillSave {
  const i = input && typeof input === "object" ? input : {};
  const name = typeof i.name === "string" ? i.name.trim() : "";
  if (!SKILL_NAME_RE.test(name)) fail(`name must be lowercase Latin letters, digits and dashes, up to 40 characters, e.g. "order-water" (got ${JSON.stringify(i.name ?? null)}).`);
  const description = str(i.description, "description", MAX_SKILL_DESCRIPTION);
  const instructions = str(i.instructions, "instructions", MAX_SKILL_INSTRUCTIONS);
  const files = list(i.files, "files", MAX_SKILL_FILES).map((f) => (typeof f === "string" && f.trim() ? f.trim() : fail("files: each one is a path in your workspace, e.g. downloads/teach-1.md.")));
  const allow = list(i.allow, "allow", MAX_ALLOW).map((raw: any): SkillAllow => {
    let a: SkillAllow;
    if (raw?.request !== undefined && raw?.request !== null && raw?.request !== "") {
      if (raw?.label) fail("allow: one entry is a click (label) or a request, not both.");
      const { site, ...request } = allowRequest(raw.request);
      a = { site, request };
    } else {
      const site = siteHost(raw?.site) ?? fail(`allow: ${JSON.stringify(raw?.site ?? null)} is not a site; give its address, e.g. 5vodi.kz.`);
      a = { site, label: str(raw?.label, "allow.label", MAX_LABEL) };
    }
    if (raw?.maxAmount !== undefined && raw?.maxAmount !== null) {
      const v = raw.maxAmount;
      const n = typeof v === "number" ? v : typeof v === "string" && /^\d+(?:\.\d+)?$/.test(v.trim()) ? Number(v.trim()) : Number.NaN;
      if (!Number.isFinite(n) || n <= 0) fail("allow.maxAmount must be a positive number, e.g. 3000.");
      a.maxAmount = n;
    }
    if (raw?.currency !== undefined && raw?.currency !== null && raw?.currency !== "") {
      const c = typeof raw.currency === "string" ? raw.currency.trim().toUpperCase() : "";
      if (!c || c.length > 10 || /\s/.test(c)) fail('allow.currency is the currency code, e.g. "KZT".');
      a.currency = c;
    }
    return a;
  });
  const sites = [
    ...new Set([
      ...list(i.sites, "sites", MAX_SITES).map((s) => siteHost(s) ?? fail(`sites: ${JSON.stringify(s)} is not a site; give its address, e.g. 5vodi.kz.`)),
      ...allow.map((a) => a.site),
    ]),
  ];
  const out: SkillSave = { name, description, instructions, files, sites, allow };
  if (i.replaces !== undefined && i.replaces !== null && i.replaces !== "") out.replaces = str(i.replaces, "replaces", 40);
  if (i.script !== undefined && i.script !== null && i.script !== "") out.script = scriptText(i.script);
  return out;
}

/** A script's text as it is kept: at most 64 KB, with one line break at its end. */
export function scriptText(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) fail("script is required: the whole JavaScript of the skill's script.");
  const code = `${(v as string).replace(/\s+$/, "")}\n`;
  if (Buffer.byteLength(code) > MAX_SCRIPT_BYTES) fail(`script is longer than ${MAX_SCRIPT_BYTES / 1024} KB.`);
  return code;
}

/** A path in the workspace (relative to it or absolute inside it): the real file, or what is wrong with it. */
function workspaceFile(path: string, workspace: string): string {
  let real: string;
  let root: string;
  try {
    real = realpathSync(resolve(workspace, path));
    root = realpathSync(workspace);
  } catch {
    return fail(`files: ${path}: no such file in your workspace.`);
  }
  if (real !== root && !real.startsWith(root + sep)) fail(`files: ${path} is outside your workspace.`);
  const st = statSync(real);
  if (!st.isFile()) fail(`files: ${path} is not a file.`);
  if (st.size > MAX_SKILL_FILE_BYTES) fail(`files: ${path} is larger than 5 MB.`);
  return real;
}

/**
 * What saving it would replace and the real files to copy, or why it cannot be saved: the name of a built-in, a
 * plugin's or the person's own skill is not taken over, and a taught skill is updated only when `replaces` names it.
 */
export function checkSkillSave(s: SkillSave, d: { skills: SkillIndex; skillsDir: string; workspace?: string }): { files: string[]; replaced?: string } {
  const taken = d.skills.get(s.name);
  if (taken && !taken.taught) {
    fail(
      taken.source === USER_SKILLS
        ? `The person already has a skill named "${s.name}" that was not taught by showing: pick another name.`
        : `"${s.name}" is a skill of ${taken.source === "piomio" ? "the hub" : `the ${taken.source} plugin`}: pick another name.`,
    );
  }
  if (s.replaces !== undefined) {
    if (!d.skills.get(s.replaces)?.taught) fail(`There is no taught skill "${s.replaces}" to replace: see the skills list (taught ones are marked).`);
    if (taken && s.replaces !== s.name) fail(`A taught skill named "${s.name}" exists already: to update it, pass replaces "${s.name}".`);
  } else if (taken) {
    fail(`A taught skill named "${s.name}" exists already: to update it, pass replaces "${s.name}"; for a new one, pick another name.`);
  }
  // A folder of that name that is not the skill being replaced (no SKILL.md, another name inside) is the person's.
  const target = join(d.skillsDir, s.name);
  if (existsSync(target) && target !== (s.replaces ? d.skills.get(s.replaces)?.dir : undefined)) fail(`The skills folder already has "${s.name}": pick another name.`);
  if (s.files.length && !d.workspace) fail("files: the files are on another computer; the hub keeps only files from a workspace on the hub. Save without files.");
  return { files: s.files.map((f) => workspaceFile(f, d.workspace!)), ...(s.replaces ? { replaced: s.replaces } : {}) };
}

/** An amount as the reader writes it: "3 000 ₸", "$34.50", "3 000 KZT". */
export function formatAmount(n: number, currency: string | undefined, locale: Locale): string {
  const digits = Number.isInteger(n) ? 0 : 2;
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: "narrowSymbol", minimumFractionDigits: digits, maximumFractionDigits: 2 }).format(n);
    } catch {
      /* not a currency Intl knows */
    }
  }
  const num = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: 2 }).format(n);
  return currency ? `${num} ${currency}` : num;
}

/** The approval card's line: the skill, then each click it may do without asking (numbers in a label shown as "…"). */
export function skillSaveSummary(s: Pick<SkillSave, "name" | "description" | "allow" | "replaces" | "script">, locale: Locale): string {
  const t = tFor(locale);
  const head = s.replaces
    ? t("skills.update", { name: s.replaces === s.name ? s.name : `${s.replaces} → ${s.name}`, description: s.description })
    : t("skills.save", { name: s.name, description: s.description });
  const allows = s.allow.map((a) => {
    const amount = a.maxAmount !== undefined ? t("skills.allowAmount", { amount: formatAmount(a.maxAmount, a.currency, locale) }) : "";
    if (a.request) return t("skills.allowRequest", { method: a.request.method, address: a.request.address.replace(/^https:\/\//, ""), amount });
    const text = (a.label ?? "").trim();
    const label = labelCondition(text).op === "glob" ? text.replace(DIGIT_RUN, "…") : text;
    return t("skills.allow", { label, site: a.site, amount });
  });
  return [head, ...(s.script ? [t("skills.withScript")] : []), ...allows].join(" · ");
}

/** "recording.md", "recording-2.md": a name not yet used in the folder (SKILL.md stays the skill's own). */
function freeName(name: string, used: Set<string>): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length) || "file";
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem}-${n}${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Write the skill (after the person's tap): a replaced skill's folder and pre-approvals go first; then the files,
 * SKILL.md, one rule per pre-approval, its sites as known targets, and the index reloads.
 */
export function saveTaughtSkill(
  s: SkillSave,
  checked: { files: string[]; replaced?: string },
  d: { skills: SkillIndex; rules: RuleStore; skillsDir: string; agentId: string; now?: Date },
): { dir: string; files: string[]; rules: Rule[] } {
  const now = (d.now ?? new Date()).toISOString();
  const old = checked.replaced ? d.skills.get(checked.replaced) : undefined;
  let created = now;
  // An update that brings no script keeps the one the skill has (and the version before it).
  const kept = old ? { script: readOr(join(old.dir, SKILL_SCRIPT_FILE)), prev: readOr(join(old.dir, SKILL_SCRIPT_PREV)) } : {};
  if (old) {
    try {
      const prev = parseFrontmatter(readFileSync(join(old.dir, "SKILL.md"), "utf8")).data.created;
      if (typeof prev === "string") created = prev;
    } catch {
      /* the old SKILL.md is unreadable: a new date */
    }
    rmSync(old.dir, { recursive: true, force: true });
  }
  removeSkillRules(d.rules, [s.name, ...(checked.replaced ? [checked.replaced] : [])]);

  const dir = join(d.skillsDir, s.name);
  mkdirSync(dir, { recursive: true });
  const used = new Set(["skill.md", SKILL_SCRIPT_FILE, SKILL_SCRIPT_PREV]);
  const files = checked.files.map((src) => {
    const name = freeName(basename(src), used);
    cpSync(src, join(dir, name), { dereference: true });
    return name;
  });
  const front = { name: s.name, description: s.description, taught: true, sites: s.sites, agent: d.agentId, created, updated: now };
  writeFileSync(join(dir, "SKILL.md"), `---\n${toYaml(front).trimEnd()}\n---\n\n${s.instructions.trim()}\n`);
  const script = s.script ?? kept.script;
  const prev = s.script !== undefined && kept.script !== undefined && kept.script !== s.script ? kept.script : kept.prev;
  if (script !== undefined) writeFileSync(join(dir, SKILL_SCRIPT_FILE), script);
  if (script !== undefined && prev !== undefined) writeFileSync(join(dir, SKILL_SCRIPT_PREV), prev);

  const rules = s.allow.map((a) => d.rules.create(allowRule(s.name, a)));
  d.rules.addKnownTargets(s.sites.flatMap((h) => [h, `www.${h}`]));
  d.skills.reload();
  return { dir, files, rules };
}

/** The pre-approvals of these skills (rules created via "skill" with their note). */
function removeSkillRules(rules: RuleStore, names: string[]): number {
  const notes = new Set(names.map(skillNote));
  let n = 0;
  for (const r of rules.list()) {
    if (r.createdVia === "skill" && r.note && notes.has(r.note)) {
      rules.remove(r.id);
      n++;
    }
  }
  return n;
}

/** hub_skill_delete: a taught skill's folder and its pre-approvals. */
export function deleteTaughtSkill(name: string, d: { skills: SkillIndex; rules: RuleStore }): { rules: number } {
  const s = d.skills.get(name);
  if (!s) fail(`There is no skill "${name}".`);
  if (!s.taught) fail(`"${name}" was not taught by showing: only taught skills can be deleted this way.`);
  rmSync(s.dir, { recursive: true, force: true });
  const rules = removeSkillRules(d.rules, [name]);
  d.skills.reload();
  return { rules };
}

function readOr(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** A taught skill's script, when it has one. */
export function readSkillScript(skill: Pick<Skill, "dir">): string | undefined {
  return readOr(join(skill.dir, SKILL_SCRIPT_FILE));
}

/**
 * skill_script_save: a new version of a taught skill's script. The one it had stays beside it as the previous version.
 * Nothing else of the skill changes (its sites and pre-approvals are the person's, through hub_skill_save's card).
 */
export function saveSkillScript(skill: Pick<Skill, "dir" | "taught" | "name">, code: string): { replaced: boolean } {
  if (!skill.taught) fail(`"${skill.name}" was not taught by showing: only a taught skill has a script.`);
  const file = join(skill.dir, SKILL_SCRIPT_FILE);
  const old = readOr(file);
  if (old === code) fail("That is the script the skill already has: nothing changed.");
  if (old !== undefined) writeFileSync(join(skill.dir, SKILL_SCRIPT_PREV), old);
  writeFileSync(file, code);
  return { replaced: old !== undefined };
}

/** skill_script_save restore: the previous version becomes the script again, and the one it replaces becomes the previous. */
export function restoreSkillScript(skill: Pick<Skill, "dir" | "name">): void {
  const file = join(skill.dir, SKILL_SCRIPT_FILE);
  const prevFile = join(skill.dir, SKILL_SCRIPT_PREV);
  const prev = readOr(prevFile);
  if (prev === undefined) fail(`"${skill.name}" has no previous version of its script to go back to.`);
  const now = readOr(file);
  if (now === undefined) renameSync(prevFile, file);
  else {
    writeFileSync(prevFile, now);
    writeFileSync(file, prev as string);
  }
}
