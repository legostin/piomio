import { setFlagsFromString } from "node:v8";

// The declarative signal filter: a small JSON tree of leaf checks on a dotted path,
// combined with all / any / not. Pure: no I/O, bounded in depth and size.

export type Leaf =
  | { path: string; eq: unknown } | { path: string; ne: unknown }
  | { path: string; contains: string } | { path: string; matches: string; flags?: string }
  | { path: string; in: unknown[] } | { path: string; exists: boolean }
  | { path: string; gt: number } | { path: string; lt: number };
export type Match = Leaf | { all: Match[] } | { any: Match[] } | { not: Match };

// Filters are written by people and agents and run against text from outside (a mail subject, a
// webhook body). V8's experimental linear-time engine (the `l` flag) rules out catastrophic
// backtracking; it only affects regexes compiled with `l`, the rest of the process is untouched.
setFlagsFromString("--enable-experimental-regexp-engine");
// This ties the hub to Node versions that ship V8's experimental engine (Node >= 24 does).
// Without it regular expressions in filters are switched off rather than run unguarded.
let linearEngine = true;
try {
  new RegExp("a", "l");
} catch {
  linearEngine = false;
}

const MAX_OUTSIDE_PATTERN = 1000;

/**
 * A regular expression on V8's linear-time engine, for a pattern written outside the hub that runs on outside text (a
 * plugin's signal schema). Throws when it cannot run in linear time (backreferences, lookaround, large counted
 * repeats), when it would mean something else without the u flag (\p{…} classes, \u{…} escapes), or when this Node
 * has no such engine: such a pattern is refused, never run on the backtracking one.
 */
export function linearRegExp(pattern: string, flags = ""): RegExp {
  if (!linearEngine) throw new Error("this hub's Node.js has no linear-time regexp engine");
  if (pattern.length > MAX_OUTSIDE_PATTERN) throw new Error(`a regular expression is at most ${MAX_OUTSIDE_PATTERN} characters`);
  if (flags.includes("u") || flags.includes("v")) throw new Error("regular expressions run without the u and v flags");
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== "\\") continue;
    const n = pattern[++i];
    if (n === "p" || n === "P") throw new Error("\\p{…} classes are not supported (they need the u flag)");
    if (n === "u" && pattern[i + 1] === "{") throw new Error("\\u{…} escapes are not supported (they need the u flag)");
  }
  try {
    return new RegExp(pattern, `l${flags}`);
  } catch (e) {
    const msg = (e as Error).message;
    throw new Error(/linear time/i.test(msg) ? `/${pattern}/ cannot run in linear time (no backreferences, lookaround or large counted repeats)` : `not a valid regular expression: ${msg}`);
  }
}

const MAX_DEPTH = 8;
const MAX_NODES = 50; // every node below the root counts, so breadth is bounded too
const MAX_TEST_CHARS = 10_000; // bounds the work per test even though matching is linear
const MAX_PATTERN = 500;
const OPS = ["eq", "ne", "contains", "matches", "in", "exists", "gt", "lt"] as const;
const OPS_LIST = OPS.join(", ");

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reads "data.from.address" or "items.0.id"; undefined when any step is missing. */
export function pathGet(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const key of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    if (!Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * True when a pattern can backtrack catastrophically: a repeated group whose body holds a repeating
 * quantifier or an alternation, or a backreference. A conservative scan, not a full parser.
 */
// A compiled filter regex: `fold` means the value is lowercased before testing (the `i` flag,
// emulated because the linear engine refuses it).
type Compiled = { re: RegExp; fold: boolean } | string;
const compiled = new Map<string, Compiled>();
const CACHE_MAX = 500;

/** Lowercases a pattern except escapes: a backslash and the character after it stay as written. */
function foldPattern(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\" && i + 1 < pattern.length) out += pattern[i] + pattern[++i];
    else out += pattern[i]!.toLowerCase();
  }
  return out;
}

/** Whether lowercasing the pattern (the `i` emulation) would change what it means. */
function foldChangesMeaning(pattern: string): boolean {
  const changes = (c: string) => c.toLowerCase() !== c;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") {
      const n = pattern[++i];
      if (n !== undefined && /[xuc0-7]/.test(n)) return true;
    } else if (c === "[") {
      for (i++; i < pattern.length && pattern[i] !== "]"; i++) {
        const a = pattern[i]!;
        if (a === "\\") {
          i++;
        } else if (pattern[i + 1] === "-" && pattern[i + 2] !== undefined && pattern[i + 2] !== "]" && pattern[i + 2] !== "\\") {
          if (changes(a) !== changes(pattern[i + 2]!)) return true;
          i += 2;
        }
      }
    }
  }
  return false;
}

/** Lowercases per character, keeping the length: a character whose lowercase differs in length stays as it is. */
function foldValue(text: string): string {
  let out = "";
  for (const ch of text) {
    const low = ch.toLowerCase();
    out += low.length === ch.length ? low : ch;
  }
  return out;
}

function compile(pattern: string, flags: string | undefined): Compiled {
  const key = `${pattern}/${flags ?? ""}`;
  const hit = compiled.get(key);
  if (hit !== undefined) return hit;
  let out: Compiled;
  const fl = flags ?? "";
  if (pattern.length > MAX_PATTERN) out = `a regular expression is at most ${MAX_PATTERN} characters`;
  else if (!linearEngine) out = "this hub's Node.js has no linear-time regexp engine; regular expressions in filters are off";
  else if (!/^[ims]*$/.test(fl) || new Set(fl).size !== fl.length) out = "regular expression flags may only be i, m and s, each once";
  else if (fl.includes("i") && foldChangesMeaning(pattern)) out = "with the i flag, write letters as they are, not as escapes or mixed-case ranges";
  else {
    const fold = fl.includes("i");
    try {
      out = { re: new RegExp(fold ? foldPattern(pattern) : pattern, "l" + fl.replace("i", "")), fold };
    } catch (e) {
      const msg = (e as Error).message;
      out = /linear time/i.test(msg)
        ? "this regular expression cannot run in linear time (no backreferences, lookahead or \\p classes); simplify it"
        : `not a valid regular expression: ${msg}`;
    }
  }
  if (compiled.size >= CACHE_MAX) compiled.delete(compiled.keys().next().value!);
  compiled.set(key, out);
  return out;
}

/** English reason the filter is malformed, or undefined when it is valid. */
export function matchError(m: unknown): string | undefined {
  let nodes = -1; // the root is free: one `all` may hold 50 checks
  const walk = (node: unknown, depth: number, where: string): string | undefined => {
    if (depth > MAX_DEPTH) return `filter is too deep (at most ${MAX_DEPTH} levels)`;
    if (!isObject(node)) return `${where} must be an object`;
    if (++nodes > MAX_NODES) return `filter has too many parts (at most ${MAX_NODES})`;
    if ("all" in node || "any" in node) {
      const key = "all" in node ? "all" : "any";
      const list = node[key];
      if (!Array.isArray(list)) return `${key} must be a list of filters`;
      for (const child of list) {
        const err = walk(child, depth + 1, key);
        if (err) return err;
      }
      return undefined;
    }
    if ("not" in node) return walk(node.not, depth + 1, "not");
    if (typeof node.path !== "string" || node.path === "") return "each check needs a non-empty path";
    const ops = OPS.filter((op) => op in node);
    if (ops.length !== 1) return `check on ${node.path} needs exactly one of ${OPS_LIST}`;
    const op = ops[0]!;
    const v = node[op];
    if (op === "contains" && typeof v !== "string") return `contains on ${node.path} must be a string`;
    if (op === "in" && !Array.isArray(v)) return `in on ${node.path} must be a list`;
    if (op === "exists" && typeof v !== "boolean") return `exists on ${node.path} must be true or false`;
    if ((op === "gt" || op === "lt") && typeof v !== "number") return `${op} on ${node.path} must be a number`;
    if (op === "matches") {
      if (typeof v !== "string") return `matches on ${node.path} must be a string`;
      if (node.flags !== undefined && typeof node.flags !== "string") return `flags on ${node.path} must be a string`;
      const re = compile(v, node.flags as string | undefined);
      if (typeof re === "string") return re;
    }
    return undefined;
  };
  return walk(m, 1, "filter");
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function leaf(node: Record<string, unknown>, value: unknown): boolean {
  const got = pathGet(value, node.path as string);
  if ("eq" in node) return same(got, node.eq);
  if ("ne" in node) return !same(got, node.ne);
  if ("contains" in node) {
    const want = node.contains as string;
    if (typeof got === "string") return got.toLowerCase().includes(want.toLowerCase());
    if (Array.isArray(got)) {
      return got.some((el) => el === want || (typeof el === "string" && el.toLowerCase() === want.toLowerCase()));
    }
    return false;
  }
  if ("matches" in node) {
    if (typeof got !== "string") return false;
    const re = compile(node.matches as string, node.flags as string | undefined);
    if (typeof re === "string") return false;
    const text = got.length > MAX_TEST_CHARS ? got.slice(0, MAX_TEST_CHARS) : got;
    return re.re.test(re.fold ? foldValue(text) : text);
  }
  if ("in" in node) return (node.in as unknown[]).some((el) => same(got, el));
  if ("exists" in node) return (got !== undefined) === node.exists;
  if ("gt" in node) return typeof got === "number" && Number.isFinite(got) && got > (node.gt as number);
  if ("lt" in node) return typeof got === "number" && Number.isFinite(got) && got < (node.lt as number);
  return false;
}

/** True when the value passes the filter; no filter passes everything, a malformed one nothing. */
export function matches(m: Match | undefined, value: unknown): boolean {
  if (m === undefined) return true;
  if (matchError(m) !== undefined) return false;
  const run = (node: Match): boolean => {
    if ("all" in node) return node.all.every(run);
    if ("any" in node) return node.any.some(run);
    if ("not" in node) return !run(node.not);
    return leaf(node as Record<string, unknown>, value);
  };
  return run(m);
}
