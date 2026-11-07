import { describe, expect, it } from "vitest";
import { matchError, matches, pathGet } from "../../src/signals/match.ts";

const sig = { type: "x.mail", data: { from: { address: "ann@client.com" }, subject: "Invoice #42 for November", size: 1200, labels: ["inbox", "work"] } };

describe("signal filter", () => {
  it("reads dotted paths, array indexes included", () => {
    expect(pathGet(sig, "data.from.address")).toBe("ann@client.com");
    expect(pathGet(sig, "data.labels.1")).toBe("work");
    expect(pathGet(sig, "data.nope.deeper")).toBeUndefined();
  });

  it("checks each leaf", () => {
    expect(matches({ path: "data.from.address", eq: "ann@client.com" }, sig)).toBe(true);
    expect(matches({ path: "data.from.address", ne: "ann@client.com" }, sig)).toBe(false);
    expect(matches({ path: "data.subject", contains: "invoice" }, sig)).toBe(true); // contains ignores case
    expect(matches({ path: "data.subject", matches: "^Invoice #\\d+" }, sig)).toBe(true);
    expect(matches({ path: "data.subject", matches: "^invoice", flags: "i" }, sig)).toBe(true);
    expect(matches({ path: "data.labels", contains: "work" }, sig)).toBe(true); // an array contains an element
    expect(matches({ path: "data.from.address", in: ["bob@x.com", "ann@client.com"] }, sig)).toBe(true);
    expect(matches({ path: "data.cc", exists: false }, sig)).toBe(true);
    expect(matches({ path: "data.size", gt: 1000 }, sig)).toBe(true);
    expect(matches({ path: "data.size", lt: 1000 }, sig)).toBe(false);
  });

  it("combines with all, any and not; no filter matches everything", () => {
    expect(matches(undefined, sig)).toBe(true);
    expect(matches({ all: [{ path: "data.size", gt: 1 }, { not: { path: "data.from.address", matches: "noreply" } }] }, sig)).toBe(true);
    expect(matches({ any: [{ path: "data.size", gt: 5000 }, { path: "data.subject", contains: "nothing" }] }, sig)).toBe(false);
  });

  it("explains a malformed filter", () => {
    expect(matchError({ path: "data.x", eq: 1 })).toBeUndefined();
    expect(matchError({ path: "data.x" })).toMatch(/one of eq, ne, contains, matches, in, exists, gt, lt/);
    expect(matchError({ path: "data.x", matches: "(" })).toMatch(/regular expression/);
    expect(matchError({ all: "x" })).toMatch(/all must be a list/);
    expect(matchError({ path: "", eq: 1 })).toMatch(/path/);
    // Bounded: no deeper than 8 levels, no more than 50 leaves.
    let deep: any = { path: "a", eq: 1 };
    for (let i = 0; i < 9; i++) deep = { not: deep };
    expect(matchError(deep)).toMatch(/too deep/);
  });
});

describe("signal filter limits", () => {
  const leafN = (n: number) => ({ all: Array.from({ length: n }, () => ({ path: "a", eq: 1 })) });
  it("ignores prototype paths", () => {
    expect(pathGet({}, "__proto__")).toBeUndefined();
    expect(pathGet({}, "constructor")).toBeUndefined();
    expect(pathGet({ a: 1 }, "a.constructor")).toBeUndefined();
  });
  it("bounds size and depth", () => {
    expect(matchError(leafN(50))).toBeUndefined();
    expect(matchError(leafN(51))).toMatch(/too many/);
    expect(matchError({ all: Array.from({ length: 51 }, () => ({ all: [] })) })).toMatch(/too many/);
    let d: any = { path: "a", eq: 1 };
    for (let i = 0; i < 7; i++) d = { not: d };
    expect(matchError(d)).toBeUndefined(); // 8 levels
    expect(matchError({ not: d })).toMatch(/too deep/);
  });
  it("a malformed filter matches nothing", () => {
    expect(matches({ path: "a" } as any, { a: 1 })).toBe(false);
    expect(matches({ path: "a", eq: 1, ne: 2 } as any, { a: 1 })).toBe(false);
    expect(matchError({ path: "a", eq: 1, ne: 2 })).toMatch(/exactly one/);
  });
  it("compares objects with eq", () => {
    expect(matches({ path: "a", eq: { x: [1] } }, { a: { x: [1] } })).toBe(true);
    expect(matches({ path: "a", eq: { x: [2] } }, { a: { x: [1] } })).toBe(false);
  });
  it("refuses regular expressions that can take forever", () => {
    for (const p of ["(a+)+$", "(a|aa)*", "(\\w+\\s?)*$", "((a+)b)*", "(a)\\1"]) {
      expect(matchError({ path: "a", matches: p }), p).toMatch(/take forever/);
    }
    for (const p of ["^Invoice #\\d+", "[a+]+", "\\(a+\\)+", "(?:ab)c+", "(ab)+"]) {
      expect(matchError({ path: "a", matches: p }), p).toBeUndefined();
    }
  });
  it("tests a huge value quickly", () => {
    const big = "x".repeat(1_000_000);
    const t0 = Date.now();
    expect(matches({ path: "a", matches: "^x+$" }, { a: big })).toBe(true); // only the first 10k characters are tested
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
