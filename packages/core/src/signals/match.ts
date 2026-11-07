// The declarative signal filter: a small JSON tree of leaf checks on a dotted path,
// combined with all / any / not. Pure: no I/O, bounded in depth and size.

export type Leaf =
  | { path: string; eq: unknown } | { path: string; ne: unknown }
  | { path: string; contains: string } | { path: string; matches: string; flags?: string }
  | { path: string; in: unknown[] } | { path: string; exists: boolean }
  | { path: string; gt: number } | { path: string; lt: number };
export type Match = Leaf | { all: Match[] } | { any: Match[] } | { not: Match };

const MAX_DEPTH = 8;
const MAX_NODES = 50; // every node below the root counts, so breadth is bounded too
const MAX_TEST_CHARS = 10_000; // residual risk: a slow pattern is still slow on 10k characters; the scan above catches the usual causes
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
 * True when a pattern can backtrack catastrophically: a quantified group whose body holds a
 * quantifier or an alternation, or a backreference. A conservative scan, not a full parser.
 */
function riskyPattern(pattern: string): boolean {
  type Frame = { q: boolean; alt: boolean };
  const stack: Frame[] = [{ q: false, alt: false }];
  const top = () => stack[stack.length - 1]!;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") {
      const n = pattern[i + 1];
      if (n !== undefined && (/[1-9]/.test(n) || n === "k")) return true;
      i++;
    } else if (c === "[") {
      for (i++; i < pattern.length && pattern[i] !== "]"; i++) if (pattern[i] === "\\") i++;
    } else if (c === "(") {
      stack.push({ q: false, alt: false });
      if (pattern[i + 1] === "?") i++; // group syntax such as (?: (?= (?<name>
    } else if (c === ")") {
      if (stack.length === 1) continue;
      const g = stack.pop()!;
      const rest = pattern.slice(i + 1);
      const quantified = /^(?:[*+?]|\{\d+,\d*\})/.test(rest);
      if (quantified && (g.q || g.alt)) return true;
      const parent = top();
      parent.q = parent.q || g.q || quantified;
      parent.alt = parent.alt || g.alt;
    } else if (c === "|") {
      top().alt = true;
    } else if (c === "*" || c === "+" || c === "?" || (c === "{" && /^\{\d+(?:,\d*)?\}/.test(pattern.slice(i)))) {
      top().q = true;
    }
  }
  return false;
}

// Compiled patterns (or the reason one was refused), so a filter is not recompiled per call.
const compiled = new Map<string, RegExp | string>();
const CACHE_MAX = 500;

function compile(pattern: string, flags: string | undefined): RegExp | string {
  const key = `${pattern}/${flags ?? ""}`;
  const hit = compiled.get(key);
  if (hit !== undefined) return hit;
  let out: RegExp | string;
  if (pattern.length > MAX_PATTERN) out = `a regular expression is at most ${MAX_PATTERN} characters`;
  else if (riskyPattern(pattern)) out = "a regular expression with nested repetition or a backreference can take forever; simplify it";
  else {
    try {
      out = new RegExp(pattern, flags);
    } catch (e) {
      out = `not a valid regular expression: ${(e as Error).message}`;
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
    re.lastIndex = 0;
    return re.test(got.length > MAX_TEST_CHARS ? got.slice(0, MAX_TEST_CHARS) : got);
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
