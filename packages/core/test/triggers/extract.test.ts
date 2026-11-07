// The watch reads pages off the hub's thread: the same values and errors as extractValue, and a hostile page ends
// with an error in bounded time while the hub's own timers keep running.

import { afterAll, describe, expect, it } from "vitest";
import { PageReader } from "../../src/signals/extract.ts";
import { tFor } from "../../src/i18n.ts";
import { errorFields } from "../../src/signals/errors.ts";
import { extractValue, WatchError } from "../../src/signals/watch.ts";

describe("reading a watched page off the hub's thread", () => {
  const reader = new PageReader();
  afterAll(() => reader.stop());

  const html = `<html><head><title>T</title><style>.x{}</style></head><body>
      <h1>Магазин</h1><div class="price"> 1 200 ₽ </div><div class="price">900&nbsp;₽</div>
      <script>window.nonce = "n"</script></body></html>`;
  const cases: Array<[string, string, { selector?: string; jsonPath?: string }]> = [
    ['{"data":{"items":[{"price":120}]}}', "application/json", { jsonPath: "data.items[0].price" }],
    ['{"a":{"b":[1,2]}}', "application/json", { jsonPath: "a" }],
    ["<html></html>", "text/html", { jsonPath: "a" }],
    ['{"a":1}', "application/json", { jsonPath: "a..b" }],
    ['{"a":1}', "application/json", { jsonPath: "b" }],
    [html, "text/html; charset=utf-8", { selector: ".price" }],
    [html, "text/html", { selector: ".missing" }],
    [html, "text/html", {}],
    ["plain body\n", "text/plain", {}],
  ];

  it("gives what extractValue gives: the value, or the same error", async () => {
    for (const [body, type, opts] of cases) {
      let want: { value?: string; error?: ReturnType<typeof errorFields>; watch?: boolean };
      try {
        want = { value: extractValue(body, type, opts) };
      } catch (e) {
        want = { error: errorFields(e), watch: e instanceof WatchError };
      }
      let got: typeof want;
      try {
        got = { value: await reader.read(body, type, opts) };
      } catch (e) {
        got = { error: errorFields(e), watch: e instanceof WatchError };
      }
      expect(got).toEqual(want);
    }
  });

  it("ends a page that takes too long with an error, while the hub's timers keep ticking", async () => {
    // Unclosed nested tags: node-html-parser takes quadratic time (tens of seconds on the hub's thread).
    const hostile = "<div>".repeat(100_000);
    let ticks = 0;
    let gap = 0;
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      gap = Math.max(gap, now - last);
      last = now;
      ticks++;
    }, 10);
    const t0 = Date.now();
    try {
      const err = await reader.read(hostile, "text/html", {}, 500).then(
        () => undefined,
        (e) => e,
      );
      expect(err).toBeInstanceOf(WatchError);
      expect(err).toMatchObject({ code: "extractTimeout", params: { seconds: 1 } });
    } finally {
      clearInterval(timer);
    }
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(ticks).toBeGreaterThan(10);
    expect(gap).toBeLessThan(1000);
    // The next page gets a fresh reader.
    expect(await reader.read("<p>ok</p>", "text/html", {})).toBe("ok");
  });

  it("a worker that fails gives a coded, translatable error", async () => {
    const broken = new PageReader(new URL("data:text/javascript,throw new Error('boom')"));
    try {
      const err = await broken.read("<p>x</p>", "text/html", {}).then(
        () => undefined,
        (e) => e,
      );
      expect(err).toBeInstanceOf(WatchError);
      expect(err).toMatchObject({ code: "extractFailed", params: { reason: expect.stringContaining("boom") } });
    } finally {
      broken.stop();
    }
    expect(tFor("en")("triggers.error.extractFailed", { reason: "x" })).toBe("Could not read the page: x");
    expect(tFor("ru")("triggers.error.extractFailed", { reason: "x" })).toBe("Не удалось прочитать страницу: x");
  });

  it("says why in the person's language", () => {
    expect(tFor("en")("triggers.error.extractTimeout", { seconds: 10 })).toBe("Reading the page took longer than 10 seconds: it is too large or too deeply nested");
    expect(tFor("ru")("triggers.error.extractTimeout", { seconds: 10 })).toBe("Страница разбиралась дольше 10 секунд: она слишком большая или слишком глубоко вложенная");
    expect(tFor("ru")("triggers.error.extractTimeout", { seconds: 1 })).toMatch(/^Страница разбиралась дольше 1 секунды:/);
  });
});
