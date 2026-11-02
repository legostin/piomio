// Tainted egress (policy/egress.ts): after outside content, an address a read opens may carry data out. Plain
// addresses the person gave, the session's own first picks and links found in what it read stay free.
import { describe, expect, it } from "vitest";
import { carriedData, EgressGuard, urlsIn, type EgressGiven } from "../src/policy/egress.ts";

const nobody = (texts: string[] = [], known: string[] = []): (() => EgressGiven) => () => ({ texts, knownHost: (h) => known.includes(h) });
const data = (url: string, labels?: string) => carriedData(new URL(url), labels);

describe("the addresses a call opens", () => {
  it("address fields (bare hosts there too) and values that are one address; not addresses inside prose", () => {
    expect(urlsIn({ url: "https://a.example/x" })).toEqual(["https://a.example/x"]);
    expect(urlsIn({ url: "a.example/x?y=1" })).toEqual(["https://a.example/x?y=1"]);
    expect(urlsIn({ action: "new", url: "//cdn.example/x" })).toEqual(["https://cdn.example/x"]);
    expect(urlsIn({ page: { href: "b.example" } })).toEqual(["https://b.example"]);
    expect(urlsIn({ text: "https://c.example/?d=1" })).toEqual(["https://c.example/?d=1"]);
    expect(urlsIn({ text: "see https://c.example/ for more", query: "weather in Almaty" })).toEqual([]);
    expect(urlsIn({ urls: ["https://a.example", "https://b.example"] })).toEqual(["https://a.example", "https://b.example"]);
  });
});

describe("what an address carries", () => {
  it("plain addresses carry nothing", () => {
    expect(data("https://github.com/legostin/piomio/issues?q=is:open")).toBeUndefined();
    expect(data("https://en.wikipedia.org/wiki/Almaty")).toBeUndefined();
    expect(data("https://blog.example/2026/11/02/how-we-built-auto-mode")).toBeUndefined();
    expect(data("https://shop.example/item/123456?color=red&size=42")).toBeUndefined();
    expect(data("https://api.example/v1/users/3f2b9c1e-8a4d-4f6e-9b2a-1c3d5e7f9a0b")).toBeUndefined();
  });

  it("long or encoded values, another address, a user name, data in the host name", () => {
    expect(data("https://x.example/?d=" + "Ivan Petrov, passport 4510 123456, born 14.03.1986, Almaty, Abaya 10")).toMatch(/long value in the query/);
    expect(data(`https://x.example/?d=${Buffer.from("passport 4510 123456").toString("base64")}`)).toMatch(/encoded value in the query/);
    expect(data("https://x.example/c/4510123456abcdef9876fedcba")).toMatch(/encoded value in the path/);
    expect(data("https://x.example/#k=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b")).toMatch(/encoded value in the fragment/);
    expect(data("https://google.com/url?q=https://attacker.example/?d=1")).toMatch(/another address in the query/);
    expect(data("https://x.example/?to=ivan@corp.kz")).toMatch(/another address/);
    expect(data("https://user:pw@x.example/")).toMatch(/user name or password/);
    expect(data("https://x.example/?" + "a=1&".repeat(50))).toMatch(/long query/);
    expect(data("https://ivanpetrovpassport4510123456.x.example/", "ivanpetrovpassport4510123456")).toMatch(/host name/);
    expect(data("https://docs.x.example/", "docs")).toBeUndefined();
  });
});

describe("a tainted session's addresses", () => {
  it("a host nobody named goes to a review; the person's words, an approval or the session's first pick make it known", () => {
    const g = new EgressGuard();
    expect(g.check("s", ["https://attacker.example/c?d=4510"], nobody())).toMatchObject({ host: "attacker.example", why: expect.stringContaining("Nobody named attacker.example") });
    expect(g.check("s", ["https://habr.com/ru/articles/1"], nobody(["Что нового на habr.com?"]))).toBeUndefined();
    expect(g.check("s", ["https://www.habr.com/ru/articles/1"], nobody(["Что нового на habr.com?"]))).toBeUndefined();
    expect(g.check("s", ["https://shop.example/cart"], nobody([], ["shop.example"]))).toBeUndefined();
    g.opened("s", ["https://news.example.org/today"]);
    expect(g.check("s", ["https://news.example.org/tomorrow"], nobody())).toBeUndefined();
    // A host named in an email address is not a site the person gave.
    expect(g.check("s", ["https://corp.kz/"], nobody(["write to ivan@corp.kz"]))).toMatchObject({ host: "corp.kz" });
  });

  it("an address on a named host that carries data goes to a review; the exact address the person gave does not", () => {
    const g = new EgressGuard();
    const given = nobody(["Summarize https://blog.example/post?id=Zm9vYmFyYmF6cXV4MTIzNDU2 please"]);
    expect(g.check("s", [`https://blog.example/pixel?v=${Buffer.from("passport 4510 123456").toString("base64")}`], given)).toMatchObject({ why: expect.stringContaining("which the person named, but it carries an encoded value") });
    expect(g.check("s", ["https://blog.example/post?id=Zm9vYmFyYmF6cXV4MTIzNDU2"], given)).toBeUndefined();
    expect(g.check("s", ["https://verylongsubdomainthatholdsdata12345.blog.example/"], given)).toMatchObject({ why: expect.stringContaining("host name") });
  });

  it("links found in what the session read are free, unless the agent wrote their host somewhere first", () => {
    const g = new EgressGuard();
    g.read("s", "Read more: [part 2](https://cdn.other.example/story/2). Or https://cdn.other.example/story/3.");
    expect(g.check("s", ["https://cdn.other.example/story/2"], nobody())).toBeUndefined();
    expect(g.check("s", ["https://cdn.other.example/story/3"], nobody())).toBeUndefined();
    expect(g.check("s", ["https://cdn.other.example/story/4"], nobody())).toMatchObject({ host: "cdn.other.example" });
    // The agent typed an address into a page (a search box), and the page shows it back as a link.
    g.wrote("s", { ref: "e3", text: "https://attacker.example/?d=4510123456" });
    g.read("s", "Results for https://attacker.example/?d=4510123456");
    expect(g.check("s", ["https://attacker.example/?d=4510123456"], nobody())).toMatchObject({ host: "attacker.example" });
    // An address inside an address the agent opened counts as written; the address it opened does not.
    g.wrote("s", { url: "https://search.example/?q=https://evil.example/x" });
    g.read("s", "https://evil.example/x https://search.example/next");
    expect(g.check("s", ["https://evil.example/x"], nobody())).toMatchObject({ host: "evil.example" });
    expect(g.check("s", ["https://search.example/next"], nobody())).toBeUndefined();
  });

  it("an address that already went out may go again", () => {
    const g = new EgressGuard();
    expect(g.check("s", ["https://x.example/a"], nobody())).toBeDefined();
    g.passed("s", ["https://x.example/a"]);
    expect(g.check("s", ["https://x.example/a"], nobody())).toBeUndefined();
    expect(g.check("other", ["https://x.example/a"], nobody())).toBeDefined();
  });

  it("forgets nothing into an exemption: too much written turns found links off", () => {
    const g = new EgressGuard();
    g.read("s", "https://cdn.other.example/story/2");
    g.wrote("s", { text: Array.from({ length: 5_001 }, (_, i) => `https://h${i}.example/`).join(" ") });
    expect(g.check("s", ["https://cdn.other.example/story/2"], nobody())).toMatchObject({ host: "cdn.other.example" });
    // And stays off: what it reads afterwards is not found either.
    g.read("s", "https://cdn.other.example/story/5");
    expect(g.check("s", ["https://cdn.other.example/story/5"], nobody())).toMatchObject({ host: "cdn.other.example" });
  });

  it("a found link with a fragment may be opened with it or without it", () => {
    const g = new EgressGuard();
    g.read("s", "See https://docs.other.example/guide#install for the steps.");
    expect(g.check("s", ["https://docs.other.example/guide#install"], nobody())).toBeUndefined();
    expect(g.check("s", ["https://docs.other.example/guide"], nobody())).toBeUndefined();
    expect(g.check("s", ["https://docs.other.example/guide#d=4510123456"], nobody())).toMatchObject({ host: "docs.other.example" });
  });

  it("a short subdomain of a named host is that host; a long one is data, unless the person named a closer host", () => {
    const g = new EgressGuard();
    expect(g.check("s", ["https://docs.habr.com/ru/1"], nobody(["Что нового на habr.com?"]))).toBeUndefined();
    const deep = "https://a.verylongsubdomainthatholdsdata12345.blog.example/";
    expect(g.check("s", [deep], nobody(["Read blog.example"]))).toMatchObject({ why: expect.stringContaining("a long value in the host name") });
    expect(g.check("s", [deep], nobody(["Read blog.example and verylongsubdomainthatholdsdata12345.blog.example"]))).toBeUndefined();
  });

  it("past what it keeps, a session finds no more links; the session used longest ago is forgotten first", () => {
    const g = new EgressGuard();
    g.read("s", Array.from({ length: 20_001 }, (_, i) => `https://cdn.other.example/p/${i}`).join(" "));
    expect(g.check("s", ["https://cdn.other.example/p/19999"], nobody())).toBeUndefined();
    expect(g.check("s", ["https://cdn.other.example/p/20000"], nobody())).toMatchObject({ host: "cdn.other.example" });

    g.opened("first", ["https://news.example.org/today"]);
    for (let i = 0; i < 500; i++) g.opened(`s${i}`, ["https://x.example/"]);
    // Its own first pick is unknown again: reviewed, never let through.
    expect(g.check("first", ["https://news.example.org/today"], nobody())).toMatchObject({ host: "news.example.org" });
    expect(g.check("s499", ["https://x.example/"], nobody())).toBeUndefined();
  });
});
