// What the hub refuses of a plugin's signals, apart from routing and rates: a declaration (contributes.signals) whose
// schema could take more than linear time on outside content, or does not compile; a subscription's config its source's
// config schema refuses; a signal of a type not declared, of a refused declaration, of a subscribe-mode type without its
// subscription, with a key or subject that is no string, or whose data is past the intake's caps or does not match its
// schema. The registry (sources.ts) and the testkit (@piomio/testkit's startPlugin) both check with these, so a
// plugin's own test meets the hub's refusals. Pure, but for a cache of what was checked; English messages, for logs.
//
// A declared schema runs on the hub's thread against outside content, so it is checked once, when the declarations are
// first read: its patterns compile on V8's linear-time engine (match.ts), and what could take more than linear time
// (uniqueItems, $ref, long enums, many patterns) or work asynchronously is refused.

import { Ajv, type ValidateFunction } from "ajv";
import type { SignalDecl } from "@piomio/shared";
import { linearRegExp } from "./match.ts";
import { canonicalJson, dataProblem } from "./pipeline.ts";
import { BUILTIN_SOURCES } from "./types.ts";

/** A declared schema, at most: as JSON, its nesting, an enum's values, its patterns. */
const SCHEMA_MAX = 16 * 1024;
const SCHEMA_DEPTH = 32;
const ENUM_MAX = 1000;
const PATTERNS_MAX = 100;
/** Config checks kept per declaration (by canonical config). */
const CONFIG_CHECKS_KEPT = 1000;
/** The hub's own sources are hub.*: no plugin's. */
export const HUB_SOURCE = "hub";
/** Types no plugin's source may take: core's own sources and the signals they bring. */
const RESERVED = new Set<string>([...BUILTIN_SOURCES, "time.tick"]);
/** Keywords whose value maps names to schemas (the names are no keywords), and keywords whose value is data. */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]);
const DATA_KEYWORDS = new Set(["enum", "const", "default", "examples", "$comment", "title", "description"]);
const REFS = ["$ref", "$dynamicRef", "$recursiveRef"];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A declared type as checked once: its compiled schemas, or why it is refused. */
export type CheckedDecl = AcceptedDecl | { refused: string };
export interface AcceptedDecl {
  data?: ValidateFunction;
  config?: ValidateFunction;
}

/** What a plugin sent with ctx.signals (its emit, or its provider's). */
export interface PluginEmit {
  type: string;
  data: unknown;
  key?: string;
  subject?: string;
  /** The subscription a provider's signal came by (signals.subscribe's id). */
  subscription?: string;
}

/** Patterns of a declared schema run on V8's linear-time engine (match.ts); one it cannot run is refused at compile. */
const linearPatterns = Object.assign((pattern: string, flags: string) => linearRegExp(pattern, flags), { code: "linearRegExp" });

/** Why a declared schema is refused before it is compiled; undefined when it may be. */
function schemaRefusal(schema: unknown): string | undefined {
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(schema));
  } catch {
    return "is not JSON";
  }
  if (size > SCHEMA_MAX) return `is over ${SCHEMA_MAX / 1024} KB`;
  let patterns = 0;
  const stack: Array<[unknown, number]> = [[schema, 0]];
  while (stack.length) {
    const [s, depth] = stack.pop()!;
    if (!s || typeof s !== "object") continue;
    if (depth > SCHEMA_DEPTH) return `is nested deeper than ${SCHEMA_DEPTH} levels`;
    if (Array.isArray(s)) {
      for (const x of s) stack.push([x, depth + 1]);
      continue;
    }
    const o = s as Record<string, unknown>;
    if (o.uniqueItems === true) return "uses uniqueItems (its check takes quadratic time)";
    if ("$async" in o) return "uses $async (signals are checked as they come)";
    for (const k of REFS) if (k in o) return `uses ${k} (write the schema out in full: a reference can make its check exponential)`;
    if (Array.isArray(o.enum) && o.enum.length > ENUM_MAX) return `has an enum of more than ${ENUM_MAX} values`;
    if (typeof o.pattern === "string") patterns++;
    if (o.patternProperties && typeof o.patternProperties === "object") patterns += Object.keys(o.patternProperties).length;
    if (patterns > PATTERNS_MAX) return `has more than ${PATTERNS_MAX} patterns`;
    for (const [k, v] of Object.entries(o)) {
      if (DATA_KEYWORDS.has(k)) continue;
      if (SCHEMA_MAPS.has(k) && v && typeof v === "object" && !Array.isArray(v)) for (const x of Object.values(v)) stack.push([x, depth + 1]);
      else stack.push([v, depth + 1]);
    }
  }
  return undefined;
}

function checkDecl(ajv: Ajv, pluginId: string, decl: SignalDecl): CheckedDecl {
  if (pluginId === HUB_SOURCE || RESERVED.has(`${pluginId}.${decl.type}`)) return { refused: "it takes the name of one of the hub's own sources" };
  const out: AcceptedDecl = {};
  for (const what of ["data", "config"] as const) {
    const schema = decl[what];
    if (!schema) continue;
    const bad = schemaRefusal(schema);
    if (bad) return { refused: `its ${what} schema ${bad}` };
    try {
      out[what] = ajv.compile(schema);
    } catch (e) {
      return { refused: `its ${what} schema does not compile: ${message(e)}` };
    }
  }
  return out;
}

/** Each plugin's declarations, checked once when first read (they change only with its layout), by type. */
const checkedDecls = new WeakMap<SignalDecl[], Map<string, CheckedDecl>>();

/** A plugin's declarations by type, checked the first time they are read (`onRefused` hears each refusal then). */
export function checkSignalDecls(pluginId: string, decls: SignalDecl[], onRefused?: (type: string, why: string) => void): Map<string, CheckedDecl> {
  let out = checkedDecls.get(decls);
  if (out) return out;
  out = new Map();
  // One Ajv per plugin's declarations: their $ids cannot clash with another plugin's.
  const ajv = new Ajv({ strict: false, validateFormats: false, logger: false, unicodeRegExp: false, code: { regExp: linearPatterns } });
  for (const decl of decls) {
    const c = checkDecl(ajv, pluginId, decl);
    out.set(decl.type, c);
    if ("refused" in c) onRefused?.(decl.type, c.refused);
  }
  checkedDecls.set(decls, out);
  return out;
}

/** The declarations the hub refuses, with why (the plugin's own types, without its id). */
export function refusedSignalDecls(pluginId: string, decls: SignalDecl[]): Array<{ type: string; why: string }> {
  const out: Array<{ type: string; why: string }> = [];
  for (const [type, c] of checkSignalDecls(pluginId, decls)) if ("refused" in c) out.push({ type, why: c.refused });
  return out;
}

/** The first thing a compiled schema found wrong, in one line. */
export function mismatch(v: ValidateFunction, what: string): string {
  const e = v.errors?.[0];
  return `${what} does not match the declared schema${e ? `: ${e.instancePath || "(top)"} ${e.message ?? "is invalid"}` : ""}`;
}

const configChecks = new WeakMap<ValidateFunction, Map<string, { problem?: string }>>();
const FITS: { problem?: string } = Object.freeze({});

/**
 * A subscription's config against its source's config schema, checked once per (declaration, canonical config): a
 * sync or a boot reads the answer. `problem` says why it does not fit.
 */
export function checkedConfig(pluginId: string, decls: SignalDecl[], type: string, config: Record<string, unknown>): { problem?: string } {
  const c = checkSignalDecls(pluginId, decls).get(type);
  if (!c) return { problem: `signal type "${type}" is not declared` };
  if ("refused" in c) return { problem: `signal type ${pluginId}.${type} is refused: ${c.refused}` };
  const v = c.config;
  if (!v) return FITS;
  let kept = configChecks.get(v);
  if (!kept) configChecks.set(v, (kept = new Map()));
  const canon = canonicalJson(config);
  let r = kept.get(canon);
  if (!r) {
    r = v(config) ? FITS : { problem: mismatch(v, "its config") };
    if (kept.size >= CONFIG_CHECKS_KEPT) kept.delete(kept.keys().next().value!);
    kept.set(canon, r);
  }
  return r;
}

/**
 * The cheap checks of a signal a plugin sent: its type is declared and not refused, a subscribe-mode one came by a
 * subscription `subscribed` takes (the hub's active one for that type), its key and subject are strings. Gives the
 * declaration to check the data against (signalDataProblem), or the English error the plugin's log shows.
 */
export function checkSignalEmit(
  pluginId: string,
  decls: SignalDecl[],
  m: PluginEmit,
  o: { subscribed(id: string, type: string): boolean; onRefused?: (type: string, why: string) => void },
): { ok: true; decl: SignalDecl; checked: AcceptedDecl } | { ok: false; error: string } {
  const type = typeof m?.type === "string" ? m.type : "";
  const full = `${pluginId}.${type}`;
  const decl = decls.find((d) => d.type === type);
  if (!decl) return { ok: false, error: `signal type "${type}" is not declared in contributes.signals` };
  const checked = checkSignalDecls(pluginId, decls, o.onRefused).get(type);
  if (!checked || "refused" in checked) return { ok: false, error: `signal type ${full} is refused: ${checked && "refused" in checked ? checked.refused : "not checked"}` };
  if (decl.mode === "subscribe") {
    if (m.subscription === undefined) return { ok: false, error: `${full} is a subscribe-mode source: its signals come only by a subscription the hub made (the emit its provider is given)` };
    if (!o.subscribed(String(m.subscription), type)) return { ok: false, error: `subscription ${String(m.subscription)} is not active for ${full}` };
  }
  if (m.key !== undefined && typeof m.key !== "string") return { ok: false, error: `${full}: key must be a string` };
  if (m.subject !== undefined && typeof m.subject !== "string") return { ok: false, error: `${full}: subject must be a string` };
  return { ok: true, decl, checked };
}

/** Why a signal's data is refused: past the intake's caps (50 levels, 256 KB), or not what its schema says. */
export function signalDataProblem(pluginId: string, type: string, checked: AcceptedDecl, data: unknown): string | undefined {
  const problem = dataProblem(data) ?? (checked.data && !checked.data(data) ? mismatch(checked.data, "its data") : undefined);
  return problem ? `${pluginId}.${type} was refused: ${problem}` : undefined;
}
