import { describe, expect, it } from "vitest";
import { entitiesToHtml, escapeHtml, htmlToPlain, isPublicHttpUrl, markdownToHtml, splitMarkdown, TELEGRAM_LIMIT } from "../server/format.ts";

describe("telegram formatting", () => {
  it("escapes HTML special characters", () => {
    expect(escapeHtml(`a < b && c > "d"`)).toBe(`a &lt; b &amp;&amp; c &gt; "d"`);
    expect(markdownToHtml("if a<b & c>d")).toBe("if a&lt;b &amp; c&gt;d");
  });

  it("converts basic markdown to Telegram HTML", () => {
    expect(markdownToHtml("**bold** and *it* and _it2_ and ~~gone~~")).toBe("<b>bold</b> and <i>it</i> and <i>it2</i> and <s>gone</s>");
    expect(markdownToHtml("run `a <b> & c` now")).toBe("run <code>a &lt;b&gt; &amp; c</code> now");
    expect(markdownToHtml("see [docs](https://example.com/a_b?x=1&y=2)")).toBe('see <a href="https://example.com/a_b?x=1&amp;y=2">docs</a>');
    expect(markdownToHtml("# Title\n- one\n- two")).toBe("<b>Title</b>\n• one\n• two");
    expect(markdownToHtml("```ts\nconst a = 1 < 2;\n```")).toBe('<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>');
    expect(markdownToHtml("```\n**not bold**\n```")).toBe("<pre>**not bold**</pre>");
  });

  it("leaves snake_case words, URLs and non-public links alone", () => {
    expect(markdownToHtml("call my_tool_name now")).toBe("call my_tool_name now");
    expect(markdownToHtml("open https://example.com/a_b_c/*x*")).toBe("open https://example.com/a_b_c/*x*");
    expect(markdownToHtml("[console](http://localhost:8081/#/a)")).toBe("console (http://localhost:8081/#/a)");
    expect(isPublicHttpUrl("https://bot.example.com/x", { httpsOnly: true })).toBe(true);
    expect(isPublicHttpUrl("http://bot.example.com/x", { httpsOnly: true })).toBe(false);
    expect(isPublicHttpUrl("https://localhost/x")).toBe(false);
  });

  it("keeps escaped brackets and backslashes as text, so a name cannot make a link of its own", () => {
    expect(markdownToHtml("From: [Evil\\](https://evil.example) \\[x](https://hub.example.com/channels/f1)")).toBe(
      'From: <a href="https://hub.example.com/channels/f1">Evil](https://evil.example) [x</a>',
    );
    expect(markdownToHtml("C:\\\\ and \\[note\\] stay, C:\\Users too")).toBe("C:\\ and [note] stay, C:\\Users too");
    expect(markdownToHtml("`a\\[b`")).toBe("<code>a\\[b</code>");
  });

  it("turns tables into aligned monospace blocks, task lists into boxes, images into links", () => {
    const html = markdownToHtml("| City | Temp |\n|---|---:|\n| **Berlin** | 12 |\n| Rome | 21 |\n\nafter");
    expect(html).toBe("<pre>City    Temp\n──────  ────\nBerlin  12\nRome    21</pre>\n\nafter");
    expect(markdownToHtml("- [ ] milk\n- [x] eggs")).toBe("☐ milk\n☑ eggs");
    expect(markdownToHtml("![a cat](https://example.com/cat.png)")).toBe('<a href="https://example.com/cat.png">🖼 a cat</a>');
    expect(markdownToHtml("```\n| a | b |\n|---|---|\n```")).toBe("<pre>| a | b |\n|---|---|</pre>");
  });

  it("splits long text under the limit and keeps code fences balanced", () => {
    const para = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20);
    const code = "```py\n" + Array.from({ length: 200 }, (_, i) => `print(${i})  # line ${i}`).join("\n") + "\n```";
    const text = [para, para, code, para, "x".repeat(9000)].join("\n\n");
    const chunks = splitMarkdown(text);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(TELEGRAM_LIMIT - 96);
      expect((c.match(/^\s*```/gm) ?? []).length % 2).toBe(0);
      expect(htmlToPlain(markdownToHtml(c)).length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    }
    // Nothing lost apart from the inserted fences.
    const joined = chunks.join("\n").replace(/\n?```py\n|\n```(?=\n|$)/g, "\n");
    for (let i = 0; i < 200; i++) expect(joined).toContain(`print(${i})`);
    expect(splitMarkdown("short")).toEqual(["short"]);
  });

  it("rebuilds HTML from message entities", () => {
    const text = "Hi bold and link <x>";
    const html = entitiesToHtml(text, [
      { type: "bold", offset: 3, length: 4 },
      { type: "text_link", offset: 12, length: 4, url: "https://e.com/?a=1&b=2" },
    ]);
    expect(html).toBe('Hi <b>bold</b> and <a href="https://e.com/?a=1&amp;b=2">link</a> &lt;x&gt;');
  });
});
