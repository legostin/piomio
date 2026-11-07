// The declarative signal filter: a small JSON tree of leaf checks on a dotted path,
// combined with all / any / not. Pure: no I/O, bounded in depth and size.

export type Leaf =
  | { path: string; eq: unknown } | { path: string; ne: unknown }
  | { path: string; contains: string } | { path: string; matches: string; flags?: string }
  | { path: string; in: unknown[] } | { path: string; exists: boolean }
  | { path: string; gt: number } | { path: string; lt: number };
export type Match = Leaf | { all: Match[] } | { any: Match[] } | { not: Match };

const MAX_DEPTH = 8;
const MAX_LEAVES = 50;
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

function compile(pattern: string, flags: string | undefined): RegExp | string {
  if (pattern.length > MAX_PATTERN) return `a regular expression is at most ${MAX_PATTERN} characters`;
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    return `not a valid regular expression: ${(e as Error).message}`;
  }
}

/** English reason the filter is malformed, or undefined when it is valid. */
export function matchError(m: unknown): string | undefined {
  let leaves = 0;
  const walk = (node: unknown, depth: number, where: string): string | undefined => {
    if (depth > MAX_DEPTH) return `filter is too deep (at most ${MAX_DEPTH} levels)`;
    if (!isObject(node)) return `${where} must be an object`;
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
    if (++leaves > MAX_LEAVES) return `filter has too many checks (at most ${MAX_LEAVES})`;
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
    return typeof re === "string" ? false : re.test(got);
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
