// The site's words: one flat catalog per language (src/locales), the same keys in each (locales.test.ts), `{name}`
// placeholders. English is the source of truth and the fallback.

import { createContext, useContext } from "react";
import type { Lang } from "../site.config";
import en from "./locales/en.json";
import ru from "./locales/ru.json";
import zh from "./locales/zh.json";

export type MessageKey = keyof typeof en;
export const CATALOGS: Record<Lang, Record<string, string>> = { en, ru, zh };

export function translator(lang: Lang) {
  const own = CATALOGS[lang] ?? en;
  return (key: MessageKey, params: Record<string, string | number> = {}): string => {
    const raw = own[key] ?? (en as Record<string, string>)[key] ?? key;
    return raw.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
  };
}

export type T = ReturnType<typeof translator>;

export const LangContext = createContext<{ lang: Lang; t: T }>({ lang: "en", t: translator("en") });

export function useI18n() {
  return useContext(LangContext);
}
