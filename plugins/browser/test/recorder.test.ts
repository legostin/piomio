import { describe, expect, it } from "vitest";
import { hintText, MARKS, Recorder, toMarkdown, type Target } from "../server/recorder.ts";

const link = (name: string): Target => ({ role: "link", name });
const field = (name: string, extra: Partial<Target> = {}): Target => ({ role: "textbox", name, editable: true, ...extra });

function rec(kind: "teach" | "takeover" = "teach") {
  return new Recorder({ id: "r1", kind, goal: "order water", now: 1_000 });
}

describe("recorder", () => {
  it("turns presses into clicks and a quick second press into a double click", () => {
    const r = rec();
    r.page("https://shop.example/", "Shop", 1_000);
    r.click(link("Каталог"), 2_000);
    r.click(link("Вода"), 3_000);
    r.click(link("Вода"), 3_200);
    r.click(link("Вода"), 9_000);
    r.click(null, 9_500);
    r.click(link("Меню"), 9_600, "right");
    const steps = r.finish(10_000).steps;
    expect(steps.map((s) => (s.kind === "click" ? [s.target.name, s.count, s.button ?? "left"] : s.kind))).toEqual([
      "page",
      ["Каталог", 1, "left"],
      ["Вода", 2, "left"],
      ["Вода", 1, "left"],
      ["Меню", 1, "right"],
    ]);
  });

  it("merges typing into one field, takes back Backspace and trusts the field's own value", () => {
    const r = rec();
    const qty = field("Количество");
    r.text("2", qty, 1_100);
    r.text("5", qty, 1_200);
    r.key("Backspace", qty, 1_300);
    r.key("Shift", qty, 1_320);
    r.key("Tab", qty, 1_350);
    const city = field("Город");
    r.text("Алм", city, 1_400);
    r.fieldValue(city, "Алматы");
    r.key("Enter", city, 1_500);
    r.key("ArrowDown", undefined, 1_600);
    r.key("ArrowDown", undefined, 1_700);
    const steps = r.finish(2_000).steps;
    expect(steps).toEqual([
      { kind: "type", at: 1_100, target: qty, value: "2" },
      { kind: "type", at: 1_400, target: city, value: "Алматы" },
      { kind: "key", at: 1_500, key: "Enter", target: city, count: 1 },
      { kind: "key", at: 1_600, key: "ArrowDown", count: 2 },
    ]);
  });

  it("never keeps what goes into a secret field", () => {
    const r = rec();
    const pw = field("Пароль", { secret: true });
    r.text("hunter2", pw, 1_100);
    r.fieldValue(pw, "hunter2");
    r.key("Backspace", pw, 1_200);
    const out = r.finish(2_000);
    expect(out.steps).toEqual([{ kind: "type", at: 1_100, target: pw, secret: true }]);
    expect(JSON.stringify(out)).not.toContain("hunter2");
    expect(toMarkdown(out)).toContain("Typed a secret into textbox «Пароль» (not recorded");
  });

  it("drops a field left empty and pages seen again without anything in between", () => {
    const r = rec();
    r.page("https://shop.example/", "", 1_000);
    r.page("https://shop.example/", "Shop", 1_100);
    r.page("about:blank", "", 1_150);
    r.text("x", field("Поиск"), 1_200);
    r.key("Backspace", field("Поиск"), 1_300);
    r.page("https://shop.example/cart", "Cart", 1_400);
    const out = r.finish(2_000);
    expect(out.steps.map((s) => (s.kind === "page" ? s.title : s.kind))).toEqual(["Shop", "Cart"]);
    expect(out.origin).toBe("https://shop.example");
  });

  it("places speech where it was said, though its words come later", () => {
    const r = rec();
    r.click(link("A"), 1_000);
    r.click(link("B"), 5_000);
    r.click(link("C"), 9_000);
    r.say("здесь выбираю самое дешёвое", 4_000);
    r.say("  ", 6_000);
    expect(r.finish(10_000).steps.map((s) => (s.kind === "say" ? s.text : s.kind === "click" ? s.target.name : s.kind))).toEqual([
      "A",
      "здесь выбираю самое дешёвое",
      "B",
      "C",
    ]);
    expect(r.actions).toBe(3);
  });

  it("writes the recording for the model with consequential steps and highlights called out", () => {
    const r = rec();
    r.page("https://shop.example/", "Shop", 1_000);
    r.click({ role: "button", name: "Оформить заказ", submit: true }, 2_000);
    r.highlight({ text: "Итого:   2 400 ₸", controls: [{ role: "button", name: "Оплатить" }], image: "r1-1.jpg" }, 3_000);
    r.scroll(3_500);
    r.scroll(3_600);
    r.click({ role: "clickable", name: "", frame: "pay.example" }, 4_000);
    const md = toMarkdown(r.finish(70_000));
    expect(md).toContain("# Recording r1");
    expect(md).toContain("The person showed how to: order water.");
    expect(md).toContain("1. Landed on «Shop» — https://shop.example/");
    expect(md).toContain("2. Clicked button «Оформить заказ» — an action with consequences (browser_submit)");
    expect(md).toContain("3. Pointed at this place (look here): «Итого: 2 400 ₸». Controls there: button «Оплатить». Picture: r1-1.jpg.");
    expect(md).toContain("4. Scrolled the page (×2)");
    expect(md).toContain("5. Clicked something inside an embedded frame of pay.example");
    expect(hintText(r.finish(70_000))).toMatch(/^While you waited, the person did this in the browser/);
  });
});

describe("recorder: clicking into a field", () => {
  it("folds the click that focused a field into the typing there", () => {
    const r = rec();
    const f = field("Поле");
    r.click(f, 1_000);
    r.text("42", f, 1_100);
    r.click(f, 2_000);
    r.click(link("Далее"), 3_000);
    expect(r.finish(4_000).steps).toEqual([
      { kind: "type", at: 1_000, target: f, value: "42" },
      { kind: "click", at: 2_000, target: f, count: 1 },
      { kind: "click", at: 3_000, target: link("Далее"), count: 1 },
    ]);
  });
});

describe("recorder: files for a page", () => {
  it("records the names of the files chosen for the file field just clicked, in place of that click", () => {
    const r = rec();
    const upload: Target = { role: "file", name: "Upload Photo:" };
    r.click(upload, 1_000);
    r.files(["кот.jpg"], 2_000);
    r.files(["a.png", "b.png"], 3_000);
    const out = r.finish(4_000);
    expect(out.steps).toEqual([
      { kind: "file", at: 2_000, names: ["кот.jpg"], target: upload },
      { kind: "file", at: 3_000, names: ["a.png", "b.png"] },
    ]);
    const md = toMarkdown(out);
    expect(md).toContain("1. Chose the file «кот.jpg» for file «Upload Photo:» — an upload (browser_upload with a file from your workspace)");
    expect(md).toContain("2. Chose 2 files «a.png», «b.png» — an upload");
  });
});

describe("recorder: what the person adds to a step", () => {
  const frame = (r: Recorder, at: number) => r.highlight({ text: "Итого 2 400 ₸", controls: [], image: "r1-1.jpg" }, at);

  it("says what a framed place means and what the person noted on it", () => {
    const r = rec();
    const id = frame(r, 2_000);
    expect(id).toBeGreaterThan(0);
    expect(r.annotate(id, { mark: "check", note: "  не больше\nтрёх тысяч " })).toBe(true);
    const out = r.finish(3_000);
    expect(out.steps).toEqual([{ kind: "highlight", at: 2_000, text: "Итого 2 400 ₸", controls: [], image: "r1-1.jpg", mark: "check", note: "не больше трёх тысяч" }]);
    expect(toMarkdown(out)).toContain('1. Marked a place to check every time: «Итого 2 400 ₸». Picture: r1-1.jpg. The person\'s note: "не больше трёх тысяч"');
  });

  it("has a line for every meaning, and plain «look here» again when the meaning is taken back", () => {
    const lines: Record<string, string> = {
      check: "Marked a place to check every time: «Итого 2 400 ₸».",
      varies: "Marked what changes from time to time (an input of the task): «Итого 2 400 ₸».",
      avoid: "Marked a place not to touch: «Итого 2 400 ₸».",
      wait: "Marked what to wait for before going on: «Итого 2 400 ₸».",
      result: "Marked the result to bring back: «Итого 2 400 ₸».",
    };
    expect(Object.keys(lines)).toEqual([...MARKS]);
    for (const mark of MARKS) {
      const r = rec();
      r.annotate(frame(r, 2_000), { mark });
      expect(toMarkdown(r.finish(3_000))).toContain(`1. ${lines[mark]}`);
    }
    const r = rec();
    const id = frame(r, 2_000);
    r.annotate(id, { mark: "avoid", note: "x" });
    r.annotate(id, { mark: null, note: "" });
    expect(toMarkdown(r.finish(3_000))).toContain("1. Pointed at this place (look here): «Итого 2 400 ₸». Picture: r1-1.jpg.\n".trim());
    expect(JSON.stringify(r.finish(3_000))).not.toMatch(/mark|note/);
  });

  it("lists the steps with numbers that stay the same while words arrive late", () => {
    const r = rec();
    r.page("https://shop.example/", "Shop", 1_000);
    r.click(link("A"), 2_000);
    r.click(link("B"), 5_000);
    const before = r.list();
    r.say("сюда", 3_000);
    const after = r.list();
    expect(after.map((s) => s.kind)).toEqual(["page", "click", "say", "click"]);
    expect(after.filter((s) => s.kind === "click").map((s) => s.id)).toEqual(before.filter((s) => s.kind === "click").map((s) => s.id));
    expect(new Set(after.map((s) => s.id)).size).toBe(4);
    // The list is a copy: changing it changes nothing.
    after[1].note = "x";
    expect(r.list()[1].note).toBeUndefined();
    // Numbers never leave the recorder.
    expect(JSON.stringify(r.finish(6_000))).not.toContain('"id":1');
    expect(r.finish(6_000).steps.every((s) => !("id" in s))).toBe(true);
  });

  it("takes a step out, but never a page", () => {
    const r = rec();
    r.page("https://shop.example/", "Shop", 1_000);
    r.click(link("Мимо"), 2_000);
    r.click(link("Каталог"), 3_000);
    const [page, slip] = r.list();
    expect(r.remove(slip.id)).toBe(true);
    expect(r.remove(slip.id)).toBe(false);
    expect(r.remove(page.id)).toBe(false);
    expect(r.finish(4_000).steps.map((s) => (s.kind === "click" ? s.target.name : s.kind))).toEqual(["page", "Каталог"]);
    expect(r.actions).toBe(1);
  });

  it("rewrites what the person said, and drops it when nothing is left", () => {
    const r = rec();
    r.say("выбираю самое дышовое", 1_000);
    r.say("шум", 2_000);
    const [words, noise] = r.list();
    expect(r.annotate(words.id, { text: "выбираю самое дешёвое" })).toBe(true);
    expect(r.annotate(noise.id, { text: " " })).toBe(true);
    expect(r.finish(3_000).steps).toEqual([{ kind: "say", at: 1_000, text: "выбираю самое дешёвое" }]);
  });

  it("puts a note on a click or typing, and refuses what does not fit the step", () => {
    const r = rec();
    r.page("https://shop.example/", "Shop", 1_000);
    r.click(link("Каталог"), 2_000);
    r.say("слова", 2_500);
    const [page, click, say] = r.list();
    expect(r.annotate(click.id, { note: "всегда отсюда" })).toBe(true);
    expect(r.annotate(page.id, { note: "x" })).toBe(false);
    expect(r.annotate(say.id, { note: "x" })).toBe(false);
    expect(r.annotate(click.id, { mark: "check" })).toBe(false);
    expect(r.annotate(click.id, { text: "x" })).toBe(false);
    expect(r.annotate(999, { note: "x" })).toBe(false);
    expect(r.annotate(click.id, { note: "я".repeat(600) })).toBe(true);
    expect(r.list()[1].note).toHaveLength(500);
    r.annotate(click.id, { note: "всегда отсюда" });
    expect(toMarkdown(r.finish(3_000))).toContain('2. Clicked link «Каталог» — the person\'s note: "всегда отсюда"');
  });

  it("keeps the note of a click that turns into typing or into a chosen file", () => {
    const r = rec();
    const f = field("Количество");
    r.click(f, 1_000);
    r.annotate(r.list()[0].id, { note: "сколько бутылей" });
    r.text("2", f, 1_100);
    const upload: Target = { role: "file", name: "Фото" };
    r.click(upload, 2_000);
    r.annotate(r.list()[1].id, { note: "с телефона" });
    r.files(["кот.jpg"], 2_500);
    expect(r.finish(3_000).steps).toEqual([
      { kind: "type", at: 1_000, target: f, value: "2", note: "сколько бутылей" },
      { kind: "file", at: 2_500, names: ["кот.jpg"], target: upload, note: "с телефона" },
    ]);
  });

  it("counts its changes", () => {
    const r = rec();
    const seen = [r.rev];
    const next = () => {
      expect(r.rev).toBeGreaterThan(seen.at(-1)!);
      seen.push(r.rev);
    };
    r.click(link("A"), 1_000);
    next();
    r.say("слова", 1_500);
    next();
    const id = frame(r, 2_000);
    next();
    r.annotate(id, { note: "x" });
    next();
    r.remove(id);
    next();
  });
});
