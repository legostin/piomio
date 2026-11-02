// The Pio window's ears and mouth, the parts that need no browser: phrases cut from the mic, which of them are for
// Pio, the WAV the hub reads, what of a reply is said out loud, and where a click of a look lands on the screen.
import { describe, expect, it } from "vitest";
import { asksToLook, forPio, FOLLOW_MS, namesPio } from "../ui/src/voice/gate.ts";
import { speakable } from "../ui/src/voice/speakable.ts";
import { Vad, type VadEvent } from "../ui/src/voice/vad.ts";
import { downsample, encodeWav } from "../ui/src/voice/wav.ts";
import { desktopOf, toScreen } from "../ui/src/desktop.ts";
import { brief, langOf, personLang, voiceFor } from "../ui/src/voice/lang.ts";

const RATE = 16_000;
const FRAME = 320; // 20 ms

function frame(level: number): Float32Array {
  const f = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) f[i] = (i % 2 ? 1 : -1) * level;
  return f;
}

function run(vad: Vad, plan: Array<[level: number, ms: number]>): VadEvent[] {
  const out: VadEvent[] = [];
  for (const [level, ms] of plan) for (let t = 0; t < ms; t += 20) {
    const e = vad.feed(frame(level));
    if (e) out.push(e);
  }
  return out;
}

describe("phrases from the mic", () => {
  it("cuts a phrase when the person stops speaking", () => {
    const events = run(new Vad({ sampleRate: RATE }), [
      [0.002, 500],
      [0.2, 1000],
      [0.002, 800],
    ]);
    expect(events.map((e) => e.type)).toEqual(["start", "end"]);
    const end = events[1] as Extract<VadEvent, { type: "end" }>;
    // The phrase, its first syllable and the quiet that ended it.
    expect(end.samples.length / RATE).toBeGreaterThan(1);
    expect(end.samples.length / RATE).toBeLessThan(2.2);
  });

  it("drops a click and ends a phrase that runs too long", () => {
    expect(run(new Vad({ sampleRate: RATE }), [[0.002, 300], [0.3, 100], [0.002, 900]]).map((e) => e.type)).toEqual(["start", "drop"]);
    expect(run(new Vad({ sampleRate: RATE, maxMs: 2000 }), [[0.002, 300], [0.2, 3000]]).map((e) => e.type)).toEqual(["start", "end", "start"]);
  });

  it("takes everything while the key is held, quiet included", () => {
    const vad = new Vad({ sampleRate: RATE });
    expect(vad.hold(true)?.type).toBe("start");
    expect(run(vad, [[0.002, 2000]])).toEqual([]);
    const end = vad.hold(false);
    expect(end?.type).toBe("end");
  });
});

describe("which words are for Pio", () => {
  const at = { keyHeld: false, now: 1000, followUntil: 0 };
  it("hears its name, however speech-to-text spelled it, and takes it off the start", () => {
    expect(forPio("Пио, что не так с формулой?", "name", at)).toBe("что не так с формулой?");
    expect(forPio("Эй, Pio — открой почту", "name", at)).toBe("открой почту");
    expect(forPio("а ты что думаешь, пио?", "name", at)).toBe("а ты что думаешь, пио?");
    expect(forPio("мы выпили пиво", "name", at)).toBeUndefined();
    expect(namesPio("Opioid crisis")).toBe(false);
  });
  it("wakes on its name at the start, however it was heard", () => {
    expect(forPio("Pio, погляди, что не так с этим графиком", "name", at)).toBe("погляди, что не так с этим графиком");
    expect(forPio("Пиу, привет", "name", at)).toBe("привет");
    expect(forPio("Окей, Пио! Открой почту", "name", at)).toBe("Открой почту");
    expect(namesPio("Био, ты тут?")).toBe(true);
    expect(namesPio("биология интересная")).toBe(false);
  });

  it("knows when the words ask to look at the screen", () => {
    expect(asksToLook("погляди, что не так с этим графиком")).toBe(true);
    expect(asksToLook("что тут написано?")).toBe(true);
    expect(asksToLook("исправь ошибку в этой формуле")).toBe(true);
    expect(asksToLook("what's wrong with this chart?")).toBe(true);
    expect(asksToLook("look at the sidebar")).toBe(true);
    expect(asksToLook("напомни купить молоко")).toBe(false);
    expect(asksToLook("это важно, запиши")).toBe(false);
  });

  it("takes an answer right after Pio spoke, and what is said with the key held", () => {
    expect(forPio("да, давай", "name", { ...at, followUntil: at.now + FOLLOW_MS })).toBe("да, давай");
    expect(forPio("да, давай", "name", at)).toBeUndefined();
    expect(forPio("сделай скриншот", "key", { ...at, keyHeld: true })).toBe("сделай скриншот");
    expect(forPio("Пио, привет", "key", at)).toBeUndefined();
    expect(forPio("просто мысли вслух", "all", at)).toBe("просто мысли вслух");
    expect(forPio("   ", "all", at)).toBeUndefined();
  });
});

describe("the WAV for speech-to-text", () => {
  it("is 16 kHz mono 16-bit PCM", () => {
    const one = downsample(new Float32Array(48_000).fill(0.5), 48_000);
    expect(one.length).toBe(16_000);
    const wav = encodeWav(one);
    const v = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(32_000);
    expect(v.getInt16(44, true)).toBe(16383);
  });
});

describe("what Pio says out loud", () => {
  it("drops Markdown, code and links", () => {
    expect(speakable("**Сохрани** файл: `cmd+s`. Подробнее [тут](https://x.test).\n```js\nfoo()\n```")).toBe("Сохрани файл: cmd+s. Подробнее тут.");
    expect(speakable("- one\n- two")).toBe("one two");
  });
  it("stops at a sentence end when the reply is long", () => {
    const long = `${"Это первая фраза. ".repeat(30)}Конец`;
    const s = speakable(long, 100);
    expect(s.length).toBeLessThanOrEqual(100);
    expect(s.endsWith(".")).toBe(true);
  });
});

describe("the desktop app around the window", () => {
  it("knows its own Pio window", () => {
    expect(desktopOf({ piomioDesktop: { scheme: "piomio", pio: true } })).toEqual({ scheme: "piomio", pio: true });
    expect(desktopOf({ piomioDesktop: { scheme: "piomio-test" } })).toEqual({ scheme: "piomio-test", pio: false });
    expect(desktopOf({})).toBeUndefined();
  });
  it("puts a point of a look on the screen", () => {
    // A Retina window at (100, 50) points, captured at 2 px per point and scaled to half: 1 px = 1 pt.
    expect(toScreen(200, 100, { origin: { x: 100, y: 50 }, scale: 1 })).toEqual({ x: 300, y: 150 });
    expect(toScreen(200, 100, { origin: { x: 0, y: 0 }, scale: 2 })).toEqual({ x: 100, y: 50 });
  });
});

describe("the person's language", () => {
  const voices = [
    { id: "piper-ru-dmitri", lang: "ru", gender: "male" as const, installed: true },
    { id: "piper-ru-irina", lang: "ru", gender: "female" as const, installed: false },
    { id: "piper-en-ryan", lang: "en", gender: "male" as const, installed: true },
  ];
  it("comes from their own words, not the hub's setting", () => {
    expect(langOf("Пио, что тут не так?")).toBe("ru");
    expect(langOf("Open the Figma file")).toBe("en");
    expect(langOf("Сохрани в Google Docs")).toBe("ru");
    expect(personLang(["hello", "Пио, глянь сюда"], "en")).toBe("ru");
    expect(personLang([], "en")).toBe("en");
  });
  it("picks the voice of the words: the hub's pick when it speaks them, else a male one", () => {
    expect(voiceFor("ru", voices, "piper-en-ryan", true)?.id).toBe("piper-ru-dmitri");
    expect(voiceFor("ru", voices, "piper-ru-irina", false)?.id).toBe("piper-ru-irina");
    expect(voiceFor("ru", voices, "piper-ru-irina", true)?.id).toBe("piper-ru-dmitri");
    expect(voiceFor("de", voices, "piper-en-ryan", true)).toBeUndefined();
  });
  it("shows the first sentences of a long reply beside the face", () => {
    const long = "Готово: сегодня 184 визита, и 165 из них пришли из Сингапура. Ещё 13 из Китая, по два из США. Отказы 99,5 %, так что это почти наверняка боты.";
    expect(brief(long, 110)).toBe("Готово: сегодня 184 визита, и 165 из них пришли из Сингапура. Ещё 13 из Китая, по два из США.");
    expect(brief("Коротко.")).toBe("Коротко.");
    expect(brief("слово ".repeat(60)).endsWith("…")).toBe(true);
  });
});
