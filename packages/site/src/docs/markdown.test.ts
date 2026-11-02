import { describe, expect, it } from "vitest";
import { anchors, links, outline, parseDoc, parseInline, slugify, type Block } from "./markdown";

const body = (md: string): Block[] => parseDoc(md).blocks;

describe("the docs' Markdown", () => {
  it("reads the front matter", () => {
    const doc = parseDoc("---\ntitle: Install: the app\nnav: Install\ndescription: \"Where it goes.\"\n---\n\nText.");
    expect(doc.meta).toEqual({ title: "Install: the app", nav: "Install", description: "Where it goes." });
    expect(doc.blocks).toEqual([{ t: "p", c: [{ t: "text", v: "Text." }] }]);
  });

  it("makes anchors the way GitHub does, unique within the page", () => {
    expect(slugify("Why not the server's IP address?")).toBe("why-not-the-servers-ip-address");
    expect(slugify("Вход из чата")).toBe("вход-из-чата");
    expect(slugify("`piomio` and piomio-node")).toBe("piomio-and-piomio-node");
    const blocks = body("## Files\n\n## Files\n\n### The `.env` file");
    expect(anchors(blocks)).toEqual(["files", "files-1", "the-env-file"]);
    expect(outline(blocks).map((h) => h.level)).toEqual([2, 2, 3]);
  });

  it("parses inline code, bold, italic, links and escapes", () => {
    expect(parseInline("Press **Sign in** in `the card`, see [Brains](brains.md#a) and *this* \\*not\\*.")).toEqual([
      { t: "text", v: "Press " },
      { t: "strong", c: [{ t: "text", v: "Sign in" }] },
      { t: "text", v: " in " },
      { t: "code", v: "the card" },
      { t: "text", v: ", see " },
      { t: "link", href: "brains.md#a", c: [{ t: "text", v: "Brains" }] },
      { t: "text", v: " and " },
      { t: "em", c: [{ t: "text", v: "this" }] },
      { t: "text", v: " *not*." },
    ]);
    expect(parseInline("5 * 3 * 2 and `**raw**`")).toEqual([{ t: "text", v: "5 * 3 * 2 and " }, { t: "code", v: "**raw**" }]);
    expect(parseInline("<b>not html</b>")).toEqual([{ t: "text", v: "<b>not html</b>" }]);
  });

  it("joins a paragraph's lines and stops it at a block", () => {
    expect(body("one\ntwo\n- item")).toEqual([
      { t: "p", c: [{ t: "text", v: "one two" }] },
      { t: "list", ordered: false, start: 1, tight: true, items: [[{ t: "p", c: [{ t: "text", v: "item" }] }]] },
    ]);
  });

  it("parses fenced code, keeping it as it is", () => {
    expect(body("```bash\ncurl -fsSL x | sh\n  indented **not bold**\n```\nafter")).toEqual([
      { t: "code", lang: "bash", code: "curl -fsSL x | sh\n  indented **not bold**" },
      { t: "p", c: [{ t: "text", v: "after" }] },
    ]);
  });

  it("parses nested lists with code inside an item", () => {
    const blocks = body("1. First\n   ```bash\n   run it\n   ```\n2. Second\n   - a\n   - b\n\n3. Third");
    expect(blocks).toHaveLength(1);
    const list = blocks[0] as Extract<Block, { t: "list" }>;
    expect(list.ordered).toBe(true);
    expect(list.items).toHaveLength(3);
    expect(list.items[0][1]).toEqual({ t: "code", lang: "bash", code: "run it" });
    expect(list.items[1][1]).toMatchObject({ t: "list", ordered: false, items: [[{ t: "p" }], [{ t: "p" }]] });
    expect(list.tight).toBe(false);
  });

  it("keeps a list tight without blank lines and takes lazy continuation lines", () => {
    const [list] = body("- one\ncontinued\n- two") as Array<Extract<Block, { t: "list" }>>;
    expect(list.tight).toBe(true);
    expect(list.items[0]).toEqual([{ t: "p", c: [{ t: "text", v: "one continued" }] }]);
  });

  it("parses tables with alignment and escaped pipes", () => {
    expect(body("| id | Used for |\n|:---|---:|\n| `a` | x \\| y |\n| b |")).toEqual([
      {
        t: "table",
        align: ["left", "right"],
        head: [[{ t: "text", v: "id" }], [{ t: "text", v: "Used for" }]],
        rows: [
          [[{ t: "code", v: "a" }], [{ t: "text", v: "x | y" }]],
          [[{ t: "text", v: "b" }], []],
        ],
      },
    ]);
  });

  it("turns quotes into notes and finds every link", () => {
    const blocks = body("> **Note:** see [a](a.md)\n> and [b](b.md).\n\n---\n\n| x |\n|---|\n| [c](c.md#d) |");
    expect(blocks[0]).toMatchObject({ t: "note", c: [{ t: "p" }] });
    expect(blocks[1]).toEqual({ t: "hr" });
    expect(links(blocks)).toEqual(["a.md", "b.md", "c.md#d"]);
  });
});
