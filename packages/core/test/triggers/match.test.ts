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
