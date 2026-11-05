import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCALES } from "../../../shared/src/i18n";
import { CHAPTERS } from "../demo/protocol";
import en from "./en.json";
import ru from "./ru.json";
import zh from "./zh.json";

const catalogs: Record<string, Record<string, string>> = { en, ru, zh };
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("site catalogs", () => {
  it("have the same keys in every language", () => {
    const keys = Object.keys(en).sort();
    for (const [lang, c] of Object.entries(catalogs)) expect(Object.keys(c).sort(), lang).toEqual(keys);
  });

  it("have no empty strings and the same placeholders as English", () => {
    for (const [lang, c] of Object.entries(catalogs))
      for (const [k, v] of Object.entries(c)) {
        expect(v.trim(), `${lang} ${k}`).not.toBe("");
        expect(placeholders(v), `${lang} ${k}`).toEqual(placeholders((en as Record<string, string>)[k]));
      }
  });

  it("tell every chapter of the demo", () => {
    for (const id of CHAPTERS) for (const part of ["chip", "time", "title", "text"]) expect(en, `${id}.${part}`).toHaveProperty(`chapter.${id}.${part}`);
  });
});

describe("the demo contract", () => {
  it("names the same chapters as the demo's scripts", () => {
    const src = readFileSync(resolve(import.meta.dirname, "../../../web/src/demo/scenarios/types.ts"), "utf8");
    const list = /CHAPTER_IDS\s*=\s*\[([^\]]*)\]/.exec(src)?.[1] ?? "";
    expect([...list.matchAll(/"([a-z-]+)"/g)].map((m) => m[1])).toEqual([...CHAPTERS]);
  });
});

// README language badges describe the product; translated documentation is linked separately.
describe("README product language claims", () => {
  it("advertises the supported app locales even in the translated README", () => {
    for (const file of ["README.md", "README.ru.md", "README.zh-CN.md"]) {
      const source = readFileSync(resolve(import.meta.dirname, "../../../..", file), "utf8");
      const badge = source.match(/src="https:\/\/img\.shields\.io\/badge\/([^" ]+)-1c1814\?style=flat-square"/g)
        ?.find((b) => /(?:EN|RU)%20/.test(b));
      expect(badge, file).toBeTruthy();
      const codes = decodeURIComponent(badge!).match(/badge\/([^"?]+)-1c1814/)![1].split(" · ").map((l) => l.toLowerCase()).sort();
      expect(codes, file).toEqual([...LOCALES].sort());
    }
  });
});
