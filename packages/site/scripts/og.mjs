// Open Graph pictures (1200×630, one per language), drawn from a small HTML card in the site's style with Playwright.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FONTS = resolve(import.meta.dirname, "../../web/src/assets/fonts");

function card(t) {
  const font = (name) => pathToFileURL(join(FONTS, name)).href;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Onest; src: url(${font("onest-latin-wght-normal.woff2")}); unicode-range: U+0000-00FF, U+2000-206F; font-weight: 100 900; }
@font-face { font-family: Onest; src: url(${font("onest-cyrillic-wght-normal.woff2")}); unicode-range: U+0400-045F; font-weight: 100 900; }
@font-face { font-family: Unbounded; src: url(${font("unbounded-latin-wght-normal.woff2")}); unicode-range: U+0000-00FF, U+2000-206F; font-weight: 200 900; }
@font-face { font-family: Unbounded; src: url(${font("unbounded-cyrillic-wght-normal.woff2")}); unicode-range: U+0400-045F; font-weight: 200 900; }
* { box-sizing: border-box; }
body { margin: 0; width: 1200px; height: 630px; background: #f7f4ef; color: #1c1814; font-family: Onest, sans-serif; overflow: hidden; position: relative; }
.glow { position: absolute; right: -120px; top: -80px; width: 760px; height: 760px; border-radius: 50%; background: radial-gradient(closest-side, rgba(255,190,60,.35), transparent); }
.left { position: absolute; left: 72px; top: 70px; width: 600px; }
.brand { display: flex; align-items: center; gap: 14px; font: 700 30px Unbounded; }
h1 { font: 800 60px/1.06 Unbounded; letter-spacing: -0.02em; margin: 52px 0 0; }
mark { background: linear-gradient(transparent 58%, #ffd56b 58%, #ffc43d 92%, transparent 92%); color: inherit; padding: 0 6px; }
p { font-size: 24px; line-height: 1.45; color: #5d564d; margin: 26px 0 0; width: 540px; }
.win { position: absolute; right: 56px; top: 92px; width: 440px; height: 450px; border-radius: 22px; background: #ece7e0; box-shadow: 0 0 0 1px rgba(70,50,20,.08), 0 40px 80px -30px rgba(70,45,10,.35); overflow: hidden; }
.bar { height: 36px; display: flex; gap: 8px; align-items: center; padding: 0 16px; }
.bar i { width: 12px; height: 12px; border-radius: 50%; display: block; }
.sheet { position: absolute; inset: 36px 0 0 0; background: #f7f4ef; padding: 22px; display: flex; flex-direction: column; gap: 14px; }
.u { align-self: flex-end; background: #ffc43d; color: #2b1a03; border-radius: 18px 18px 6px 18px; padding: 12px 16px; font-size: 18px; font-weight: 500; }
.a { display: flex; gap: 10px; }
.av { width: 32px; height: 32px; border-radius: 10px; background: linear-gradient(#ff8fc8,#db2777); flex: none; position: relative; }
.av::before, .av::after { content: ""; position: absolute; top: 12px; width: 7px; height: 7px; border-radius: 50%; background: #fff; }
.av::before { left: 8px; } .av::after { right: 8px; }
.b { background: #fff; border-radius: 6px 18px 18px 18px; padding: 12px 16px; font-size: 16px; line-height: 1.45; box-shadow: 0 1px 2px rgba(70,45,10,.08); }
.card { margin-left: 42px; background: #fff; border-radius: 16px; padding: 14px 16px; font-size: 15px; font-weight: 600; box-shadow: 0 1px 2px rgba(70,45,10,.08); }
.btn { display: inline-block; margin-top: 10px; padding: 7px 16px; border-radius: 999px; background: linear-gradient(#ffd56b,#ffad29); font-size: 14px; }
</style></head><body>
<div class="glow"></div>
<div class="left">
  <div class="brand">${readFileSync(resolve(import.meta.dirname, "../public/favicon.svg"), "utf8").replace("<svg ", '<svg width="54" height="54" ')} Piomio</div>
  <h1>${t.lead} <mark>${t.marker}</mark></h1>
  <p>${t.sub}</p>
</div>
<div class="win">
  <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
  <div class="sheet">
    <div class="u">${t.ask}</div>
    <div class="a"><div class="av"></div><div class="b">${t.answer}</div></div>
    <div class="card">${t.card}<br><span class="btn">${t.approve}</span></div>
  </div>
</div>
</body></html>`;
}

const TEXT = {
  en: {
    lead: "Your own AI team",
    marker: "on your computer",
    sub: "Free and open source. It uses the Claude Code or Codex plan you already have, and asks before anything leaves.",
    ask: "Go through my mail",
    answer: "Done: 47 emails. Three matter, a reply to Anna is drafted.",
    card: "Send an email to anna@studio-north.example",
    approve: "Allow",
  },
  ru: {
    lead: "Своя команда ИИ-агентов",
    marker: "на твоём компьютере",
    sub: "Бесплатно и с открытым кодом. Думает на твоей подписке Claude Code или Codex и спрашивает, прежде чем что-то отправить.",
    ask: "Разбери почту",
    answer: "Готово: 47 писем. Важного три, ответ Анне готов.",
    card: "Отправить письмо anna@sever-studio.example",
    approve: "Разрешить",
  },
};

/** Writes og-<lang>.png into `dist`; without a browser it says so and leaves them out. */
export async function ogImages(dist, languages) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.warn("[site] no playwright: Open Graph pictures skipped");
    return;
  }
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    console.warn(`[site] no browser for Open Graph pictures (npx playwright install chromium): ${e.message.split("\n")[0]}`);
    return;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    for (const lang of languages) {
      await page.setContent(card(TEXT[lang] ?? TEXT.en), { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(dist, `og-${lang}.png`), type: "png" });
    }
  } finally {
    await browser.close();
  }
}
