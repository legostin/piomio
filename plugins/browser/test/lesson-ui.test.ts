import { describe, expect, it } from "vitest";
import en from "../.piomio-plugin/locales/en.json" with { type: "json" };
import type { LessonStep } from "../ui/src/host.ts";
import { dictationFor, KEEP_MS, newNoteLink, openDictation, type Dictation } from "../ui/src/note-link.ts";
import { placeNote } from "../ui/src/note-place.ts";
import { canNote, canRemove, stepLine } from "../ui/src/step-text.ts";

/** A translator that shows which string was asked for and with what. */
const echo = (key: string, params?: Record<string, string | number>) => (params ? `${key} ${JSON.stringify(params)}` : key);
const step = (s: Partial<LessonStep> & Pick<LessonStep, "kind">): LessonStep => ({ id: 1, ...s });

describe("a step of the lesson in the person's words", () => {
  it("words every kind of step", () => {
    const button = { role: "button", name: "В корзину" };
    const lines: Array<[LessonStep, string]> = [
      [step({ kind: "page", title: "Каталог", url: "https://shop.example/catalog" }), 'ui.step.page {"page":"Каталог"}'],
      [step({ kind: "page", title: "", url: "https://www.shop.example/catalog" }), 'ui.step.page {"page":"shop.example/catalog"}'],
      [step({ kind: "click", target: button, count: 1 }), 'ui.step.click {"what":"«В корзину»"}'],
      [step({ kind: "click", target: button, count: 2 }), 'ui.step.clickDouble {"what":"«В корзину»"}'],
      [step({ kind: "click", target: button, count: 3 }), 'ui.step.clickTimes {"what":"«В корзину»","count":3}'],
      [step({ kind: "click", target: button, count: 1, button: "right" }), 'ui.step.clickRight {"what":"«В корзину»"}'],
      [step({ kind: "click", target: { role: "clickable", name: "" }, count: 1 }), 'ui.step.click {"what":"ui.step.unnamed"}'],
      [step({ kind: "click", target: { role: "clickable", name: "", frame: "pay.example" }, count: 1 }), 'ui.step.click {"what":"ui.step.inFrame {\\"site\\":\\"pay.example\\"}"}'],
      [step({ kind: "type", target: { role: "textbox", name: "Количество" }, value: "2" }), 'ui.step.type {"value":"2","what":"«Количество»"}'],
      [step({ kind: "type", target: { role: "textbox", name: "Пароль" }, secret: true }), 'ui.step.typeSecret {"what":"«Пароль»"}'],
      [step({ kind: "key", key: "Enter", count: 1 }), 'ui.step.key {"key":"Enter"}'],
      [step({ kind: "key", key: "ArrowDown", count: 3 }), 'ui.step.key {"key":"ArrowDown ×3"}'],
      [step({ kind: "tab", action: "new" }), "ui.step.tabNew"],
      [step({ kind: "tab", action: "switch" }), "ui.step.tabSwitch"],
      [step({ kind: "tab", action: "close" }), "ui.step.tabClose"],
      [step({ kind: "scroll", count: 4 }), "ui.step.scroll"],
      [step({ kind: "file", names: ["кот.jpg", "пёс.png"] }), 'ui.step.file {"names":"кот.jpg, пёс.png"}'],
      [step({ kind: "highlight", text: "Итого 2 400 ₸" }), 'ui.step.highlight {"text":"Итого 2 400 ₸"}'],
      [step({ kind: "highlight", text: "" }), "ui.step.highlightEmpty"],
      [step({ kind: "say", text: "выбираю самое дешёвое" }), 'ui.step.say {"text":"выбираю самое дешёвое"}'],
    ];
    for (const [s, line] of lines) expect(stepLine(s, echo)).toBe(line);
    // Every string it asks for is in the catalog.
    const asked = new Set(lines.map(([, line]) => line.split(" ")[0]).concat(["ui.step.unnamed", "ui.step.inFrame"]));
    for (const key of asked) expect(en).toHaveProperty([key]);
  });

  it("cuts long names and texts", () => {
    const line = stepLine(step({ kind: "highlight", text: "я".repeat(300) }), (_k, p) => String(p?.text));
    expect(line).toHaveLength(90);
    expect(line.endsWith("…")).toBe(true);
  });

  it("knows what the person may change on a step", () => {
    expect(canRemove(step({ kind: "page" }))).toBe(false);
    expect(canRemove(step({ kind: "click" }))).toBe(true);
    expect(canNote(step({ kind: "page" }))).toBe(false);
    expect(canNote(step({ kind: "say" }))).toBe(false);
    expect(canNote(step({ kind: "highlight" }))).toBe(true);
  });
});

describe("where the note of a frame goes", () => {
  const layer = { width: 800, height: 600 };
  const card = { width: 320, height: 100 };

  it("sits under the frame, at its left edge", () => {
    expect(placeNote({ left: 100, top: 50, width: 200, height: 80 }, layer, card)).toEqual({ left: 100, top: 138 });
  });

  it("goes above a frame near the bottom, and inside the picture for a frame as tall as the picture", () => {
    expect(placeNote({ left: 100, top: 480, width: 200, height: 100 }, layer, card)).toEqual({ left: 100, top: 372 });
    expect(placeNote({ left: 100, top: 20, width: 200, height: 570 }, layer, card)).toEqual({ left: 100, top: 492 });
  });

  it("stays inside the picture at its right edge and on a narrow phone", () => {
    expect(placeNote({ left: 700, top: 50, width: 90, height: 40 }, layer, card).left).toBe(472);
    expect(placeNote({ left: 300, top: 50, width: 60, height: 40 }, { width: 340, height: 500 }, card).left).toBe(12);
    // A picture smaller than the card: its corner, never outside.
    expect(placeNote({ left: 0, top: 0, width: 20, height: 20 }, { width: 300, height: 90 }, card)).toEqual({ left: 8, top: 8 });
  });
});

describe("whose note the person's words are", () => {
  const note = (since: number, until: number | null = null): Dictation => ({ since, until, put: () => {} });

  it("gives the words to the note that was open when they began", () => {
    const link = newNoteLink();
    expect(dictationFor(link, 1000)).toBeNull();
    const a = note(1000);
    openDictation(link, a, 1000);
    expect(dictationFor(link, 999)).toBeNull();
    expect(dictationFor(link, 1000)).toBe(a);
    expect(dictationFor(link, 5000)).toBe(a);
  });

  it("keeps a closed note's words for it when the next note is already open", () => {
    const link = newNoteLink();
    const a = note(1000);
    openDictation(link, a, 1000);
    a.until = 4000;
    const b = note(6000);
    openDictation(link, b, 6000);
    // Said into the first note, sent after a pause, routed when the second is open.
    expect(dictationFor(link, 3000)).toBe(a);
    // Between the two cards: the lesson's own stream.
    expect(dictationFor(link, 5000)).toBeNull();
    expect(dictationFor(link, 7000)).toBe(b);
  });

  it("prefers the newest note when two fit and forgets notes closed long ago", () => {
    const link = newNoteLink();
    const a = note(1000, 4000);
    openDictation(link, a, 1000);
    const b = note(3500);
    openDictation(link, b, 3500);
    expect(dictationFor(link, 3800)).toBe(b);
    openDictation(link, note(4000 + KEEP_MS), 4000 + KEEP_MS);
    expect(link.targets).not.toContain(a);
    expect(link.targets).toContain(b);
  });
});
