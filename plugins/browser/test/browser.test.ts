// End-to-end tests: the plugin runs in a real child process (testkit harness) and drives headless Chromium
// against a local HTTP server.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type AddressInfo, type Socket } from "node:net";
import type { ToolResult } from "@piomio/shared";
import { catalogLookup, localizeValue, readPluginLayout, renderTemplate } from "@piomio/shared";
import { startPlugin, type PluginHarness } from "@piomio/testkit";
import { chromium } from "playwright";
import { pageCall } from "../server/page-script.ts";
import { PAGE_RULES } from "../server/safety.ts";

const PLUGIN_DIR = join(import.meta.dirname, "..");

/**
 * The harness gives the plugin its own HOME, where Playwright finds no browsers and would download Chromium on the
 * first call (too slow for a test, and impossible behind the fake proxy below, which tunnels every CONNECT to a plain
 * HTTP server). Point the plugin at the browsers this machine already has, unless PLAYWRIGHT_BROWSERS_PATH is set.
 */
function browsersEnv(): Record<string, string> {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return {};
  const exe = chromium.executablePath();
  const m = /^(.*?)[\\/]chromium-\d+[\\/]/.exec(exe);
  return m && existsSync(exe) ? { PLAYWRIGHT_BROWSERS_PATH: m[1] } : {};
}
const SECRET = "S3cr3t-Pa55!word";
const LONG = Array.from({ length: 600 }, (_, i) => `Строка номер ${i} с некоторым текстом.`).join("\n");

const page = (title: string, body: string) =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const PAGES: Record<string, string> = {
  "/": page(
    "Главная",
    `<h1>Магазин</h1>
     <a href="/about">О нас</a>
     <form method="post" action="/order"><input name="name" placeholder="Имя"><button>Купить</button></form>
     <form role="search" action="/search"><input type="search" name="q" aria-label="Поиск"><button>Найти</button></form>
     <textarea aria-label="Заметка"></textarea>
     <select aria-label="Город"><option>Москва</option><option>Казань</option></select>
     <a href="/file.txt">Скачать отчёт</a>
     <a href="/delete-account">Удалить аккаунт</a>`,
  ),
  "/about": page("О нас", `<h1>О нас</h1><p>Мы продаём всё.</p>`),
  "/login": page(
    "Вход",
    `<form method="post" action="/login">
       <input name="username" aria-label="Логин">
       <input type="password" name="password" aria-label="Пароль">
       <input type="text" name="pin" aria-label="Код">
       <button type="submit">Войти</button>
       <button type="button" id="noop">Показать пароль</button>
     </form>`,
  ),
  "/signup": page(
    "Регистрация",
    `<form method="post" action="/signup">
       <input type="email" name="email" aria-label="Почта">
       <input type="password" name="password" autocomplete="new-password" aria-label="Пароль">
       <button type="submit">Создать аккаунт</button>
     </form>`,
  ),
  "/long": page("Длинная", `<main><p>${LONG.replace(/\n/g, "<br>")}</p></main>`),
  "/confirm": page("Записи", `<button onclick="if (confirm('Точно удалить?')) document.title = 'Удалено'">Удалить запись</button>`),
  "/captcha": page("Проверка", `<p>Подтвердите действие</p><div class="g-recaptcha" style="width:304px;height:78px;border:1px solid #ccc"></div>`),
  "/frame": page("Фрейм", `<p>Встроенная форма:</p><iframe src="/inner" style="width:600px;height:200px"></iframe>`),
  "/inner": page("Внутри", `<form method="post" action="/order"><input name="name" aria-label="Имя во фрейме"><button>Заказать</button></form>`),
  // Controls with consequences hide behind ARIA names, icons, identifiers and JS; ordinary ones must stay one click.
  "/actions": page(
    "Действия",
    `<h1>Действия</h1>
     <button aria-label="Карточка товара">Buy now</button>
     <span role="button" tabindex="0" data-testid="placeYourOrderButton">→</span>
     <button onclick="return confirm('Sure?')">Archive</button>
     <a href="/items/5/delete" title="Корзина">🗑</a>
     <a href="/posts/1" data-method="delete">Destroy</a>
     <a href="/unsubscribe?u=1">Отписаться</a>
     <a href="/blog/how-to-delete-your-account">How to delete your account in five easy steps</a>
     <button>Оформить заказ</button>
     <button>Подписаться</button>
     <button>Перевести 500 ₽</button>
     <button>Забронировать</button>
     <form class="checkout-form" action="/pay"><input aria-label="Карта"><button type="button" onclick="this.form.submit()">Continue</button></form>
     <form action="/profile"><input aria-label="Ник"><button type="button">Continue editing</button></form>
     <button onclick="document.title = 'В корзине'">Add to cart</button>
     <button>Remove filter</button>
     <button>Мои заказы</button>
     <button>Sign in</button>
     <button role="tab">Delete account</button>
     <input type="checkbox" id="news"><label for="news">Subscribe to the newsletter</label>
     <div contenteditable="true" aria-label="Send a message" style="min-height:20px;border:1px solid #ccc"></div>
     <input aria-label="Отправить сообщение">`,
  ),
  "/upload": page(
    "Загрузка",
    `<style>body{margin:0}</style>
     <input id="up" type="file" aria-label="Фото" style="position:absolute;left:0;top:0;width:400px;height:60px">
     <p id="got" style="position:absolute;top:120px">нет</p>
     <script>up.onchange = async () => { const f = up.files[0]; got.textContent = f.name + ":" + (await f.text()); }</script>`,
  ),
  "/red": page("Красная", `<style>html,body{margin:0;height:100%;background:#f00}</style>`),
  "/blue": page("Синяя", `<style>html,body{margin:0;height:100%;background:#00f}</style>`),
  // A page that stops answering: its main thread spins for good half a second after it opened.
  "/hang": page("Висит", `<style>html,body{margin:0;height:100%;background:#0f0}</style><script>setTimeout(() => { for (;;) {} }, 500)</script>`),
  "/opener": page(
    "Ссылки",
    `<style>html,body{margin:0;height:100%;background:#f00}</style>
     <a href="/blue" target="_blank" style="position:absolute;left:0;top:0;width:50%;height:100%">в новой вкладке</a>
     <a href="#" onclick="window.open('/blue', 'w', 'popup,width=600,height=400'); return false" style="position:absolute;right:0;top:0;width:50%;height:100%">в окне</a>`,
  ),
  "/counter": page(
    "Счётчик",
    `<style>body{margin:0}</style>
     <button id="b" style="position:absolute;left:0;top:0;width:640px;height:400px" onclick="this.textContent = 'нажато ' + (++window.n)">нажато 0</button>
     <input id="t" aria-label="Поле" style="position:absolute;left:0;top:500px;width:640px;height:40px">
     <script>window.n = 0</script>`,
  ),
};

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  let s = "";
  for await (const c of req) s += c;
  return new URLSearchParams(s);
}

function authorizedSeen(auth: string | undefined): boolean {
  return !!auth && Buffer.from(auth.replace(/^Basic\s+/i, ""), "base64").toString() === "tok_test:x";
}

function text(r: ToolResult): string {
  return r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
}

function refOf(snapshot: string, re: RegExp): string {
  const line = snapshot.split("\n").find((l) => /^\[e\d+\]/.test(l) && re.test(l));
  if (!line) throw new Error(`no element matching ${re} in:\n${snapshot}`);
  return /^\[(e\d+)\]/.exec(line)![1];
}

async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("browser plugin (headless Chromium)", () => {
  let h: PluginHarness;
  let server: Server;
  let base: string;
  const workspace = mkdtempSync(join(tmpdir(), "browser-ws-"));
  /** Same contract as the hub's files.deliver (packages/core/src/core-call.ts), minus the session lookup. */
  const fakeCore = (method: string, p: any) => {
    // Speech-to-text is set up and hears the same words every time.
    if (method === "speech.transcribe") return p.check ? { available: true } : { text: "здесь главное — счётчик" };
    // The agent's workspace holds one photo; anything else is not there.
    if (method === "files.fetch") {
      if (p.path !== "attachments/cat.jpg") throw new Error(`there is no ${p.path} in the workspace`);
      return { name: "cat.jpg", size: 9, data: Buffer.from("meow-jpeg").toString("base64") };
    }
    if (method !== "files.deliver") return {};
    const dir = join(workspace, "downloads");
    mkdirSync(dir, { recursive: true });
    let rel: string = p.path;
    if (!rel) {
      const dot = p.name.lastIndexOf(".");
      let candidate = p.name;
      for (let i = 1; existsSync(join(dir, candidate)); i++) candidate = `${p.name.slice(0, dot)} (${i})${p.name.slice(dot)}`;
      rel = `downloads/${candidate}`;
    }
    appendFileSync(join(workspace, rel), Buffer.from(p.data, "base64"));
    return { path: rel, absolutePath: join(workspace, rel) };
  };
  const posted: Array<{ path: string; body: URLSearchParams }> = [];
  const outputs: string[] = [];

  const call = async (name: string, input: Record<string, unknown> = {}) => {
    const r = await h.invoke(name, input);
    outputs.push(JSON.stringify(r));
    return r;
  };
  const ok = async (name: string, input: Record<string, unknown> = {}) => {
    const r = await call(name, input);
    expect(r.isError, text(r)).toBeFalsy();
    return text(r);
  };
  /** Close every tab but the first: the tests after this one work in a single tab. */
  const closeExtraTabs = async () => {
    for (let i = 0; i < 20; i++) {
      const extra = [...(await ok("tabs", { action: "list" })).matchAll(/^(\d+) /gm)].map((m) => Number(m[1])).filter((n) => n > 1);
      if (!extra.length) return;
      h.uiMessage({ type: "tab", action: "close", index: Math.max(...extra) });
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("the extra tabs did not close");
  };

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "POST") {
        const body = await readBody(req);
        posted.push({ path: url.pathname, body });
        const html =
          url.pathname === "/order" ? page("Заказ", `<p>Заказ принят: ${body.get("name")}</p>`) : page("Кабинет", `<p>Вход выполнен: ${body.get("username")}</p>`);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
        return;
      }
      if (url.pathname === "/search") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("Поиск", `<p>Результаты для: ${url.searchParams.get("q")}</p>`));
        return;
      }
      if (url.pathname === "/file.txt") {
        res
          .writeHead(200, { "content-type": "text/plain", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent("отчёт 1.txt")}` })
          .end("hello file");
        return;
      }
      const html = PAGES[url.pathname];
      if (!html) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    h = await startPlugin({
      dir: PLUGIN_DIR,
      settings: { headless: "always", allowLocalNetwork: true, takeoverWaitSec: 0 },
      vault: { "site-login": { url: base, username: "alice", password: SECRET } },
      core: fakeCore,
      env: browsersEnv(),
    });
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
    server?.close();
  });

  it("registers browser tools with effects and source flags", () => {
    const effects = Object.fromEntries([...h.tools.values()].map((t) => [t.name, t.effect]));
    expect(effects).toEqual({
      open: "read",
      search: "read",
      snapshot: "read",
      get_text: "read",
      screenshot: "read",
      scroll: "read",
      back: "read",
      tabs: "read",
      wait: "read",
      click: "local-write",
      type: "local-write",
      press_key: "local-write",
      fill_secret: "local-write",
      download: "local-write",
      submit: "external",
      history: "read",
      history_clear: "external",
      teach: "local-write",
      journal: "local-write",
      upload: "external",
    });
    expect([...h.tools.values()].every((t) => t.source === true)).toBe(true);
    // The approval summary is a catalog reference: the hub resolves it in the hub language, then fills {field}s.
    // The card names the site and the control as the page shows it, not only the agent's own description.
    const summary = h.tools.get("submit")!.approvalSummary!;
    expect(summary).toBe("%approval.submit%");
    const { messages, manifest } = readPluginLayout(PLUGIN_DIR);
    // The live view's history routes: the hub answers 404 for a plugin that does not declare them.
    expect(manifest.contributes.http).toBe(true);
    const input = { ref: "e7", label: "Pay $34.00", url: "https://shop.example/checkout?step=3", description: "Pay for 2 items, $34.00" };
    expect(renderTemplate(localizeValue(summary, catalogLookup(messages, "en")), input)).toBe("Browser, shop.example, “Pay $34.00”: Pay for 2 items, $34.00");
    expect(renderTemplate(localizeValue(summary, catalogLookup(messages, "ru")), input)).toBe("Браузер, shop.example, «Pay $34.00»: Pay for 2 items, $34.00");
    expect(h.tools.get("submit")!.inputSchema.required).toEqual(["ref", "label", "url", "description"]);
  });

  it("opens a page and lists interactive elements with refs", async () => {
    const opened = await ok("open", { url: base + "/" });
    expect(opened).toContain("Opened.");
    expect(opened).toContain(`Page: Главная — ${base}/`);
    expect(opened).toContain(`Главная — ${base}/`);
    const snap = await ok("snapshot");
    expect(snap).toContain("# Магазин");
    expect(snap).toMatch(/\[e\d+\] link "О нас" -> \/about/);
    expect(snap).toMatch(/\[e\d+\] textbox "Имя"/);
    expect(snap).toMatch(/\[e\d+\] button "Купить" \(needs browser_submit\)/);
    expect(snap).toMatch(/\[e\d+\] button "Найти"(?! \(needs)/);
    expect(snap).toMatch(/\[e\d+\] select "Город" value="Москва" options: Москва \| Казань/);
    // Refs are stable across snapshots of the same page.
    expect(refOf(await ok("snapshot"), /"О нас"/)).toBe(refOf(snap, /"О нас"/));
  });

  it("clicks a link and goes back", async () => {
    const snap = await ok("snapshot");
    const r = await ok("click", { ref: refOf(snap, /link "О нас"/) });
    expect(r).toContain(`О нас — ${base}/about`);
    const back = await ok("back");
    expect(back).toContain(`Главная — ${base}/`);
    // Old refs do not survive navigation.
    const stale = await call("click", { ref: refOf(snap, /link "О нас"/) });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain("browser_snapshot");
  });

  it("types into fields and chooses select options", async () => {
    const snap = await ok("snapshot");
    await ok("type", { ref: refOf(snap, /textbox "Имя"/), text: "Иван" });
    await ok("type", { ref: refOf(snap, /select "Город"/), text: "Казань" });
    const after = await ok("snapshot");
    expect(after).toMatch(/textbox "Имя" value="Иван"/);
    expect(after).toMatch(/select "Город" value="Казань"/);
    const bad = await call("type", { ref: refOf(snap, /link "О нас"/), text: "x" });
    expect(bad.isError).toBe(true);
  });

  it("refuses submit-like clicks and Enter in forms, pointing to browser_submit", async () => {
    const snap = await ok("snapshot");
    const buyRef = refOf(snap, /button "Купить"/);
    const buy = await call("click", { ref: buyRef });
    expect(buy.isError).toBe(true);
    // The refusal hands the model the exact call, label and url included.
    expect(text(buy)).toContain(`Call browser_submit with ref "${buyRef}", label "Купить", url "${base}/"`);
    const del = await call("click", { ref: refOf(snap, /link "Удалить аккаунт"/) });
    expect(del.isError).toBe(true);
    const enter = await call("press_key", { key: "Enter", ref: refOf(snap, /textbox "Имя"/) });
    expect(enter.isError).toBe(true);
    expect(text(enter)).toContain("browser_submit");
    const note = await call("press_key", { key: "Enter", ref: refOf(snap, /textbox "Заметка"/) });
    expect(note.isError).toBe(true);
    expect(posted).toHaveLength(0);
    // Search boxes are fine: Enter there is just navigation.
    await ok("type", { ref: refOf(snap, /textbox\[search\] "Поиск"/), text: "чайник" });
    const search = await ok("press_key", { key: "Enter" });
    expect(search).toContain("Поиск —");
    expect(await ok("get_text")).toContain("Результаты для: чайник");
  });

  it("treats a line break at the end of browser_type like Enter", async () => {
    await ok("open", { url: base + "/" });
    const snap = await ok("snapshot");
    const name = refOf(snap, /textbox "Имя"/);
    const typed = await ok("type", { ref: name, text: "Привет\n" });
    expect(typed).toContain('Typed into [' + name + '] "Имя": "Привет".');
    expect(typed).toContain("nothing was submitted");
    expect(typed).toContain(`Call browser_submit with ref "${name}", label "Имя"`);
    // The same in a field outside any form.
    expect(await ok("type", { ref: refOf(snap, /textbox "Заметка"/), text: "строка\r\n  " })).toContain("nothing was submitted");
    expect(posted).toHaveLength(0);
    const after = await ok("snapshot");
    expect(after).toMatch(/textbox "Имя" value="Привет"/);
    expect(after).toMatch(/textbox "Заметка" value="строка"/);
    // A search box searches: Enter there is just navigation.
    const search = await ok("type", { ref: refOf(snap, /textbox\[search\] "Поиск"/), text: "самовар\n" });
    expect(search).toContain("Pressed Enter.");
    expect(await ok("get_text")).toContain("Результаты для: самовар");
  });

  it("classifies consequential controls by name, text, identifiers, links and forms", async () => {
    await ok("open", { url: base + "/actions" });
    const snap = await ok("snapshot");
    const needs = (re: RegExp) => {
      const line = snap.split("\n").find((l) => /^\[e\d+\]/.test(l) && re.test(l));
      if (!line) throw new Error(`no element matching ${re} in:\n${snap}`);
      return line.includes("(needs browser_submit)");
    };
    // An ARIA name that hides "Buy now", an icon with a test id, a JS confirm, links that act.
    expect(needs(/button "Карточка товара"/)).toBe(true);
    expect(needs(/button "→"/)).toBe(true);
    expect(needs(/button "Archive"/)).toBe(true);
    expect(needs(/link "🗑"/)).toBe(true);
    expect(needs(/link "Destroy"/)).toBe(true);
    expect(needs(/link "Отписаться"/)).toBe(true);
    expect(needs(/button "Оформить заказ"/)).toBe(true);
    expect(needs(/button "Подписаться"/)).toBe(true);
    expect(needs(/button "Перевести 500 ₽"/)).toBe(true);
    expect(needs(/button "Забронировать"/)).toBe(true);
    // "Continue" in a payment form commits it even as a plain JS button; elsewhere it is just a button.
    expect(needs(/button "Continue"(?! editing)/)).toBe(true);
    expect(needs(/button "Continue editing"/)).toBe(false);
    // Ordinary browsing stays one click: articles, carts, filters, tabs, sign-in, checkboxes, fields.
    expect(needs(/link "How to delete your account/)).toBe(false);
    expect(needs(/button "Add to cart"/)).toBe(false);
    expect(needs(/button "Remove filter"/)).toBe(false);
    expect(needs(/button "Мои заказы"/)).toBe(false);
    expect(needs(/button "Sign in"/)).toBe(false);
    expect(needs(/tab "Delete account"/)).toBe(false);
    expect(needs(/checkbox "Subscribe to the newsletter"/)).toBe(false);
    expect(needs(/textbox "Send a message"/)).toBe(false);
    expect(needs(/textbox "Отправить сообщение"/)).toBe(false);

    for (const re of [/button "→"/, /link "🗑"/, /button "Archive"/, /button "Continue"(?! editing)/]) {
      const r = await call("click", { ref: refOf(snap, re) });
      expect(r.isError, text(r)).toBe(true);
      expect(text(r)).toContain("Nothing was clicked");
    }
    expect(posted).toHaveLength(0);
    expect(await ok("click", { ref: refOf(snap, /checkbox "Subscribe to the newsletter"/) })).toContain("Clicked");
    expect(await ok("snapshot")).toMatch(/checkbox "Subscribe to the newsletter" \[x\]/);
    expect(await ok("click", { ref: refOf(snap, /button "Add to cart"/) })).toContain("В корзине —");
    expect(await ok("click", { ref: refOf(snap, /textbox "Send a message"/) })).toContain("Clicked");
  });

  it("works inside iframes with the same safety rules", async () => {
    await ok("open", { url: base + "/frame" });
    const snap = await ok("snapshot");
    expect(snap).toContain(`-- iframe ${new URL(base).host} --`);
    const field = refOf(snap, /textbox "Имя во фрейме"/);
    await ok("type", { ref: field, text: "Фрейм" });
    expect((await call("press_key", { key: "Enter", ref: field })).isError).toBe(true);
    expect((await call("click", { ref: refOf(snap, /button "Заказать"/) })).isError).toBe(true);
    expect(posted).toHaveLength(0);
    expect(await ok("snapshot")).toMatch(/textbox "Имя во фрейме" value="Фрейм"/);
  });

  it("submits a form through browser_submit", async () => {
    await ok("open", { url: base + "/" });
    const snap = await ok("snapshot");
    await ok("type", { ref: refOf(snap, /textbox "Имя"/), text: "Пётр" });
    const buy = refOf(snap, /button "Купить"/);
    const wrong = await call("submit", { ref: buy, label: "Купить", url: "https://shop.example/", description: "Купить" });
    expect(wrong.isError).toBe(true);
    expect(text(wrong)).toContain("The page has changed");
    // The user approved a control by its name: another name on the card means nothing is clicked.
    const renamed = await call("submit", { ref: buy, label: "Купить за 1 ₽", url: base + "/", description: "Купить" });
    expect(renamed.isError).toBe(true);
    expect(text(renamed)).toContain('Not done: [' + buy + '] is now button "Купить", but the user approved "Купить за 1 ₽"');
    const noLabel = await call("submit", { ref: buy, url: base + "/", description: "Купить" });
    expect(noLabel.isError).toBe(true);
    expect(text(noLabel)).toContain("Parameter label is required");
    expect(posted).toHaveLength(0);
    const r = await ok("submit", { ref: buy, label: "купить", url: base + "/", description: "Оформить заказ в тестовом магазине" });
    expect(r).toContain("Done: Оформить заказ в тестовом магазине");
    expect(r).toContain("Заказ —");
    expect(posted.at(-1)).toMatchObject({ path: "/order" });
    expect(posted.at(-1)!.body.get("name")).toBe("Пётр");
  });

  it("accepts confirm() dialogs only inside an approved submit", async () => {
    await ok("open", { url: base + "/confirm" });
    const snap = await ok("snapshot");
    const ref = refOf(snap, /button "Удалить запись"/);
    expect((await call("click", { ref })).isError).toBe(true);
    const r = await ok("submit", { ref, label: "Удалить запись", url: base + "/confirm", description: "Удалить запись" });
    expect(r).toContain("Удалено —");
  });

  it("fills secrets from the vault without revealing them", async () => {
    await ok("open", { url: base + "/login" });
    const snap = await ok("snapshot");
    const vaultRef = "vault://site-login";
    await ok("fill_secret", { ref: refOf(snap, /textbox "Логин"/), vaultRef, field: "username" });
    const pw = await ok("fill_secret", { ref: refOf(snap, /textbox\[password\] "Пароль"/), vaultRef });
    expect(pw).toContain("the value is not shown");
    await ok("fill_secret", { ref: refOf(snap, /textbox "Код"/), vaultRef });
    const notInput = await call("fill_secret", { ref: refOf(snap, /button "Показать пароль"/), vaultRef });
    expect(notInput.isError).toBe(true);
    const after = await ok("snapshot");
    expect(after).toMatch(/textbox "Логин" value="alice"/);
    expect(after).toMatch(/textbox\[password\] "Пароль" value="••••••"/);
    expect(after).toMatch(/textbox "Код" value="••••••"/);
    await ok("get_text");
    await ok("screenshot");
    // A sign-in step is not an action with consequences: a plain click, no approval.
    expect(after).toMatch(/button "Войти"(?! \(needs browser_submit\))/);
    const r = await ok("click", { ref: refOf(after, /button "Войти"/) });
    expect(r).toContain("Кабинет —");
    const login = posted.find((p) => p.path === "/login")!;
    expect(login.body.get("password")).toBe(SECRET);
    expect(login.body.get("pin")).toBe(SECRET);
    expect(login.body.get("username")).toBe("alice");
    for (const o of outputs) expect(o).not.toContain(SECRET);
    expect(h.logs.join("\n")).not.toContain(SECRET);
  });

  it("still asks before creating an account", async () => {
    await ok("open", { url: base + "/signup" });
    expect(await ok("snapshot")).toMatch(/button "Создать аккаунт" \(needs browser_submit\)/);
  });

  it("returns a JPEG screenshot as an image part", async () => {
    await ok("open", { url: base + "/" });
    const r = await call("screenshot");
    const img = r.content.find((c) => c.type === "image") as { type: "image"; data: string; mimeType: string };
    expect(img.mimeType).toBe("image/jpeg");
    const buf = Buffer.from(img.data, "base64");
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);
    expect(buf.length).toBeLessThan(400_000);
    expect(text(r)).toContain("Screenshot of the visible area");
  });

  it("truncates page text", async () => {
    await ok("open", { url: base + "/long" });
    const t = await ok("get_text", { maxChars: 500 });
    expect(t).toContain("Строка номер 0");
    expect(t).not.toContain("Строка номер 599");
    expect(t).toMatch(/truncated: showing 500 of \d+ characters/);
  });

  it("downloads files by ref and by url", async () => {
    await ok("open", { url: base + "/" });
    const snap = await ok("snapshot");
    const byRef = await ok("download", { ref: refOf(snap, /link "Скачать отчёт"/) });
    expect(byRef).toMatch(/File saved to the workspace: downloads\/отчёт 1\.txt \(.*, 10 B\)/);
    const byUrl = await ok("download", { url: base + "/file.txt" });
    expect(byUrl).toMatch(/workspace: downloads\/отчёт 1 \(1\)\.txt/);
    const dir = join(h.dataDir, "downloads");
    expect(readdirSync(dir).sort()).toEqual(["отчёт 1 (1).txt", "отчёт 1.txt"]);
    expect(readFileSync(join(dir, "отчёт 1.txt"), "utf8")).toBe("hello file");
    // The hub copied them into the agent's workspace (see the fake files.deliver in beforeAll).
    expect(readFileSync(join(workspace, "downloads", "отчёт 1.txt"), "utf8")).toBe("hello file");
    expect(h.coreCalls.filter((c) => c.method === "files.deliver").every((c) => c.params.sessionId)).toBe(true);
    // Opening a file URL downloads it instead of failing.
    expect(await ok("open", { url: base + "/file.txt" })).toMatch(/The URL turned out to be a file; it was downloaded\. File saved to the workspace: downloads\/отчёт 1 \(2\)\.txt/);
  });

  it("manages tabs", async () => {
    await ok("tabs", { action: "new", url: base + "/about" });
    const list = await ok("tabs", { action: "list" });
    expect(list).toMatch(/2 \* О нас/);
    await ok("tabs", { action: "switch", index: 1 });
    await ok("tabs", { action: "close", index: 2 });
    expect(await ok("tabs", { action: "list" })).not.toContain("О нас");
  });

  it("tells the model to hand captchas to the user", async () => {
    const r = await ok("open", { url: base + "/captcha" });
    expect(r).toContain("captcha");
    expect(r).toContain("take control");
  });

  it("reports activity for the live view: who drives the browser and when it needs the user", async () => {
    const acts = () =>
      h.coreCalls.filter((c) => c.method === "ui.emit" && (c.params as { channel: string }).channel === "activity").map((c) => (c.params as { payload: any }).payload);
    const from = acts().length;
    await ok("open", { url: base + "/captcha" });
    const during = acts().slice(from);
    expect(during.some((a) => a.busy === "open" && a.agentId === "assistant")).toBe(true);
    expect(during.at(-1)).toMatchObject({ running: true, busy: null, agentId: "assistant", control: "agent", attention: true });

    // Taking control answers the request; a page without a captcha clears it too.
    h.uiMessage({ type: "control", on: true });
    await until(() => acts().at(-1)?.control === "user" && acts().at(-1)?.attention === false);
    h.uiMessage({ type: "control", on: false });
    await until(() => acts().at(-1)?.control === "agent");
    await ok("snapshot");
    expect(acts().at(-1)).toMatchObject({ attention: true });
    await ok("open", { url: base + "/about" });
    expect(acts().at(-1)).toMatchObject({ busy: null, attention: false, url: base + "/about" });

    // A UI that loads later asks for the current value.
    const before = acts().length;
    h.uiMessage({ type: "activity" });
    await until(() => acts().length > before);
    expect(acts().at(-1)).toMatchObject({ running: true, url: base + "/about" });
  });

  it("keeps the agent away from local addresses unless allowed", async () => {
    h.setSettings({ headless: "always", takeoverWaitSec: 0 });
    const r = await call("open", { url: base + "/" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("local network");
    expect((await call("download", { url: "http://169.254.169.254/latest" })).isError).toBe(true);
    h.setSettings({ headless: "always", allowLocalNetwork: true, takeoverWaitSec: 0 });
    await ok("open", { url: base + "/" });
  });

  it("reports pane errors with a code the UI translates", async () => {
    h.uiMessage({ type: "navigate", url: "ftp://example.com/" });
    const err = await until(() => h.coreCalls.find((c) => c.method === "ui.emit" && (c.params as { channel: string }).channel === "error"));
    expect((err.params as { payload: unknown }).payload).toEqual({
      message: "Only http(s) URLs can be opened, not ftp:",
      code: "urlProtocol",
      params: { protocol: "ftp:" },
    });
  });

  it("streams frames to the UI and lets the user take over", async () => {
    await ok("open", { url: base + "/counter" });
    const emits = () => h.coreCalls.filter((c) => c.method === "ui.emit").map((c) => c.params as { channel: string; payload: any });
    h.uiMessage({ type: "watch", on: true });
    const frame = await until(() => emits().find((e) => e.channel === "frame"));
    expect(Buffer.from(frame.payload.data, "base64")[0]).toBe(0xff);
    // The page gets what the 1280×900 window leaves under its toolbar.
    expect(frame.payload).toMatchObject({ width: 1280, url: base + "/counter" });
    expect(frame.payload.height).toBeGreaterThan(700);
    const height: number = frame.payload.height;
    await until(() => emits().find((e) => e.channel === "state" && e.payload.running && e.payload.url === base + "/counter"));

    h.uiMessage({ type: "control", on: true });
    await until(() => emits().find((e) => e.channel === "control" && e.payload.user === true));
    const blocked = await call("snapshot");
    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toContain("The user is controlling the browser");

    // Click the big button (top-left 640x400 of the page) and type into the field below it.
    const framesBefore = emits().filter((e) => e.channel === "frame").length;
    for (const action of ["down", "up"]) h.uiMessage({ type: "input", event: "mouse", action, x: 0.1, y: 0.1, button: "left", clickCount: 1 });
    // The repaint after the click arrives as a screencast frame.
    await until(() => emits().filter((e) => e.channel === "frame").length > framesBefore);
    for (const action of ["down", "up"]) h.uiMessage({ type: "input", event: "mouse", action, x: 0.1, y: 520 / height, button: "left", clickCount: 1 });
    for (const key of ["a", "b"]) {
      h.uiMessage({ type: "input", event: "key", action: "down", key, code: `Key${key.toUpperCase()}` });
      h.uiMessage({ type: "input", event: "key", action: "up", key, code: `Key${key.toUpperCase()}` });
    }
    h.uiMessage({ type: "input", event: "text", text: "вг" });
    h.uiMessage({ type: "control", on: false });
    await until(() => emits().find((e) => e.channel === "control" && e.payload.user === false));
    await new Promise((r) => setTimeout(r, 300));
    const snap = await ok("snapshot");
    expect(snap).toContain('button "нажато 1"');
    expect(snap).toContain('textbox "Поле" value="abвг"');
    h.uiMessage({ type: "watch", on: false });
  });

  it("shows the tab the person switches to", async () => {
    const all = () => h.coreCalls.filter((c) => c.method === "ui.emit").map((c) => c.params as { channel: string; payload: any });
    const lastFrame = (since: number) => all().slice(since).filter((e) => e.channel === "frame").at(-1)?.payload as { data: string; url: string } | undefined;
    // The colour in the middle of a streamed JPEG frame, read by decoding it in a page.
    const viewer = await (await chromium.launch()).newPage();
    const colour = async (data: string) => {
      const [r, g, b] = await viewer.evaluate(async (src) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        return [...ctx.getImageData(img.width >> 1, img.height >> 1, 1, 1).data];
      }, `data:image/jpeg;base64,${data}`);
      return r > 200 && b < 60 ? "red" : b > 200 && r < 60 ? "blue" : `rgb(${r},${g},${b})`;
    };
    try {
      await ok("open", { url: base + "/red" });
      const from = all().length;
      h.uiMessage({ type: "watch", on: true, id: "tabs" });
      h.uiMessage({ type: "navigate", text: base + "/blue", newTab: true });
      const state = await until(() => all().slice(from).find((e) => e.channel === "state" && e.payload.url === base + "/blue" && !e.payload.loading));
      await until(async () => {
        const f = lastFrame(from);
        return f?.url === base + "/blue" && (await colour(f.data)) === "blue";
      });
      for (const [url, want] of [
        [base + "/red", "red"],
        [base + "/blue", "blue"],
      ]) {
        const mark = all().length;
        h.uiMessage({ type: "tab", action: "switch", index: state.payload.tabs.find((t: any) => t.url === url).index });
        // The picture is the tab switched to, not the one the stream started on.
        const seen = await until(async () => {
          const f = lastFrame(mark);
          return f?.url === url && (await colour(f.data)) === want ? f : undefined;
        }).catch(async () => {
          const f = lastFrame(mark);
          throw new Error(`after switching to ${url}: last frame ${f?.url} is ${f ? await colour(f.data) : "none"}`);
        });
        expect(seen.url).toBe(url);
      }

      // Tabs a site opens itself: a link to a new tab and a popup window, clicked by the person in control.
      h.uiMessage({ type: "navigate", text: base + "/opener" });
      await until(async () => {
        const f = lastFrame(from);
        return f?.url === base + "/opener" && (await colour(f.data)) === "red";
      });
      h.uiMessage({ type: "control", on: true });
      await until(() => all().find((e) => e.channel === "control" && e.payload.user === true));
      for (const x of [0.25, 0.75]) {
        const before = all().length;
        for (const action of ["down", "up"]) h.uiMessage({ type: "input", event: "mouse", action, x, y: 0.5, button: "left", clickCount: 1 });
        await until(async () => {
          const f = lastFrame(before);
          return f?.url === base + "/blue" && (await colour(f.data)) === "blue";
        }).catch(async () => {
          const f = lastFrame(before);
          throw new Error(`after the click at ${x}: last frame ${f?.url} is ${f ? await colour(f.data) : "none"}`);
        });
        const has = (tabs: any[], url: string) => tabs.some((t) => t.url === url);
        const tabs = (
          await until(() =>
            all()
              .slice(before)
              .filter((e) => e.channel === "state" && has(e.payload.tabs, base + "/opener") && has(e.payload.tabs, base + "/blue"))
              .at(-1),
          )
        ).payload.tabs;
        for (const [url, want] of [
          [base + "/opener", "red"],
          [base + "/blue", "blue"],
        ]) {
          const mark = all().length;
          const tab = [...tabs].reverse().find((t: any) => t.url === url);
          h.uiMessage({ type: "tab", action: "switch", index: tab.index });
          await until(async () => {
            const f = lastFrame(mark);
            return f?.url === url && (await colour(f.data)) === want;
          }).catch(async () => {
            const f = lastFrame(mark);
            throw new Error(`a site's tab: after switching to ${url} (tab ${tab.index}): last frame ${f?.url} is ${f ? await colour(f.data) : "none"}`);
          });
        }
        // Back to the page with the links for the next one.
        h.uiMessage({ type: "tab", action: "switch", index: [...tabs].find((t: any) => t.url === base + "/opener").index });
        await until(async () => lastFrame(all().length - 1)?.url === base + "/opener" || (await Promise.resolve(false)));
      }
      h.uiMessage({ type: "control", on: false });
    } finally {
      h.uiMessage({ type: "watch", on: false, id: "tabs" });
      await viewer.context().browser()?.close();
      await closeExtraTabs();
    }
  });

  it("keeps switching tabs when one of them stops answering", async () => {
    const all = () => h.coreCalls.filter((c) => c.method === "ui.emit").map((c) => c.params as { channel: string; payload: any });
    const lastFrame = (since: number) => all().slice(since).filter((e) => e.channel === "frame").at(-1)?.payload as { data: string; url: string } | undefined;
    await ok("open", { url: base + "/red" });
    const from = all().length;
    h.uiMessage({ type: "watch", on: true, id: "hang" });
    h.uiMessage({ type: "navigate", text: base + "/hang", newTab: true });
    const tabs = (await until(() => all().slice(from).find((e) => e.channel === "state" && e.payload.tabs.some((t: any) => t.url === base + "/hang") && !e.payload.loading))).payload.tabs;
    const red = tabs.find((t: any) => t.url === base + "/red").index;
    const hung = tabs.find((t: any) => t.url === base + "/hang").index;
    // Now it hangs.
    await new Promise((r) => setTimeout(r, 1500));
    try {
      for (const [index, url] of [
        [red, base + "/red"],
        [hung, base + "/hang"],
        [red, base + "/red"],
      ] as const) {
        const mark = all().length;
        h.uiMessage({ type: "tab", action: "switch", index });
        // A frame of a live tab comes; the hung one may show nothing new, but must not hold up the next switch.
        if (url.endsWith("/red")) {
          await until(() => lastFrame(mark)?.url === url, 15_000).catch(() => {
            throw new Error(`after switching to ${url}: last frame is of ${lastFrame(mark)?.url ?? "nothing"}`);
          });
        } else await new Promise((r) => setTimeout(r, 1000));
      }
    } finally {
      h.uiMessage({ type: "watch", on: false, id: "hang" });
      await closeExtraTabs();
    }
  }, 60_000);

  it("opens a text field's keyboard on a phone: what is under the finger, and where the focus is", async () => {
    await ok("open", { url: base + "/counter" });
    const all = () => h.coreCalls.filter((c) => c.method === "ui.emit").map((c) => c.params as { channel: string; payload: any });
    // Earlier tests streamed this page and took control too: only what this one makes counts.
    const from = all().length;
    const emits = () => all().slice(from);
    h.uiMessage({ type: "watch", on: true, id: "phone" });
    const frame = await until(() => emits().find((e) => e.channel === "frame" && e.payload.url === base + "/counter"));
    const height: number = frame.payload.height;
    h.uiMessage({ type: "control", on: true });
    await until(() => emits().find((e) => e.channel === "control" && e.payload.user === true));
    const answer = async (seq: number, y: number) => {
      h.uiMessage({ type: "probe", id: "phone", seq, x: 0.1, y });
      return (await until(() => emits().find((e) => e.channel === "probe" && e.payload.seq === seq))).payload;
    };
    expect(await answer(1, 520 / height)).toEqual({ id: "phone", seq: 1, editable: true });
    expect(await answer(2, 0.1)).toEqual({ id: "phone", seq: 2, editable: false });
    // Tapping the field focuses it: the live view hears so after the click.
    const before = emits().filter((e) => e.channel === "focus").length;
    for (const action of ["down", "up"]) h.uiMessage({ type: "input", event: "mouse", action, x: 0.1, y: 520 / height, button: "left", clickCount: 1 });
    const focus = await until(() => emits().filter((e) => e.channel === "focus").slice(before).find((e) => e.payload.editable === true));
    expect(focus.payload).toEqual({ editable: true });
    h.uiMessage({ type: "control", on: false });
    await until(() => emits().find((e) => e.channel === "control" && e.payload.user === false));
    h.uiMessage({ type: "watch", on: false, id: "phone" });
  });

  it("learns from the person: a demonstration with clicks, typing, a highlight and speech reaches the agent's chat", async () => {
    await ok("open", { url: base + "/counter" });
    const all = () => h.coreCalls.filter((c) => c.method === "ui.emit").map((c) => c.params as { channel: string; payload: any });
    const from = all().length;
    const emits = () => all().slice(from);
    h.uiMessage({ type: "watch", on: true, id: "teach" });
    const frame = await until(() => emits().find((e) => e.channel === "frame" && e.payload.url === base + "/counter"));
    const height: number = frame.payload.height;
    const started = await h.invokeText("teach", { goal: "нажать кнопку" }, { sessionId: "s-teach", conversationId: "c-teach", agentId: "assistant" });
    expect(started).toContain("The live view is open on the person's screen");
    expect(started).toContain("Their speech is transcribed");
    // The live view pops up for it, control in the person's hands, with the bar.
    const st = await until(() => emits().find((e) => e.channel === "state" && e.payload.teach && e.payload.control === "user"));
    expect(st.payload.teach).toMatchObject({ goal: "нажать кнопку", scope: "task", speech: true, steps: 0 });
    expect(await until(() => emits().find((e) => e.channel === "activity" && e.payload.teach))).toMatchObject({ payload: { attention: true, control: "user" } });
    expect(text(await call("teach", { goal: "ещё раз" }))).toContain("already showing");

    for (const action of ["down", "up"]) h.uiMessage({ type: "input", event: "mouse", action, x: 0.1, y: 0.1, button: "left", clickCount: 1 });
    await until(() => emits().find((e) => e.channel === "state" && e.payload.teach?.steps >= 1));
    const speech = await h.http({ method: "POST", path: "/teach/speech", body: { data: Buffer.from("audio").toString("base64"), mimeType: "audio/webm", durationMs: 0 } });
    expect(speech.body).toEqual({ text: "здесь главное — счётчик" });
    for (const action of ["down", "up"]) h.uiMessage({ type: "input", event: "mouse", action, x: 0.1, y: 520 / height, button: "left", clickCount: 1 });
    for (const key of ["4", "2"]) h.uiMessage({ type: "input", event: "key", action: "down", key, code: `Digit${key}` });
    h.uiMessage({ type: "input", event: "key", action: "down", key: "Enter", code: "Enter" });
    h.uiMessage({ type: "highlight", x0: 0, y0: 0, x1: 0.6, y1: 380 / height });
    const lit = await until(() => emits().find((e) => e.channel === "highlight"));
    expect(lit.payload).toMatchObject({ ok: true });
    expect(lit.payload.text).toContain("нажато 1");
    await until(() => emits().find((e) => e.channel === "state" && e.payload.teach?.steps >= 4));
    h.uiMessage({ type: "teach", action: "done" });

    const told = await until(() => h.coreCalls.find((c) => c.method === "conversations.tell" && c.params.conversationId === "c-teach"));
    const note: string = told.params.text;
    expect(note).toContain("[Browser] The person finished showing you how to: нажать кнопку");
    // The names are the ones browser_snapshot gives, as they were when the person acted.
    expect(note).toContain("Clicked button «нажато 0»");
    expect(note).toContain('The person said: "здесь главное — счётчик"');
    expect(note).toContain("Typed «42» into textbox «Поле»");
    expect(note).toContain("Pressed Enter in textbox «Поле»");
    expect(note).toMatch(/Pointed at this place \(look here\): «нажато 1»\. .*Picture: rec-[a-z0-9]+-1\.jpg\./);
    expect(note.indexOf("Clicked button")).toBeLessThan(note.indexOf("The person said"));
    expect(note.indexOf("The person said")).toBeLessThan(note.indexOf("Typed «42»"));
    // The recording, its JSON and the picture are in the agent's workspace.
    const id = /Recording (rec-[a-z0-9]+)/.exec(note)![1];
    expect(note).toContain(`downloads/${id}.md`);
    for (const f of [`${id}.md`, `${id}.json`, `${id}-1.jpg`]) expect(existsSync(join(workspace, "downloads", f)), f).toBe(true);
    expect(readFileSync(join(workspace, "downloads", `${id}-1.jpg`))[0]).toBe(0xff);
    await until(() => emits().find((e) => e.channel === "control" && e.payload.user === false));
    expect(await ok("journal", { action: "list" })).toContain(`${id} · `);
    expect(await ok("journal", { action: "read", id })).toContain("Typed «42» into textbox «Поле»");

    // A takeover while the agent works: what the person did comes with the agent's next browser result.
    await ok("open", { url: base + "/counter" });
    h.uiMessage({ type: "control", on: true });
    await until(() => emits().find((e) => e.channel === "control" && e.payload.user === true) && emits().filter((e) => e.channel === "control").length >= 3);
    for (const action of ["down", "up"]) h.uiMessage({ type: "input", event: "mouse", action, x: 0.1, y: 0.1, button: "left", clickCount: 1 });
    await new Promise((r) => setTimeout(r, 300));
    h.uiMessage({ type: "control", on: false });
    await until(() => emits().filter((e) => e.channel === "control" && e.payload.user === false).length >= 2);
    const next = await ok("snapshot");
    expect(next).toContain("While you waited, the person did this in the browser");
    expect(next).toContain("Clicked button «нажато 0»");
    expect(await ok("snapshot")).not.toContain("While you waited");

    expect(await ok("journal", { action: "forget", day: "all" })).toMatch(/Forgotten: [1-9]/);
    expect(await ok("journal", { action: "list" })).toBe(await ok("journal", { action: "list" }));
    h.uiMessage({ type: "watch", on: false, id: "teach" });
  });

  it("saves a sharp copy of a screenshot for the person, to show in the chat", async () => {
    await ok("open", { url: base + "/about" });
    const r = await h.invoke("screenshot", { share: true }, { sessionId: "s1" });
    expect(r.content[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    const said = text(r);
    const path = /A copy for the person is in your workspace: (downloads\/screenshot-[^ ]+\.png)\./.exec(said)?.[1];
    expect(path, said).toBeTruthy();
    expect(said).toContain(`show_images {images: [{path: "${path}"}]}`);
    // A PNG, whole.
    expect(readFileSync(join(workspace, path!)).subarray(1, 4).toString()).toBe("PNG");
    // Not asked to share: nothing is saved.
    expect(text(await h.invoke("screenshot", {}, { sessionId: "s1" }))).not.toContain("A copy for the person");
  });

  it("puts a file from the agent's workspace into a file field, and the person's own through the live view", async () => {
    await ok("open", { url: base + "/upload" });
    const ref = refOf(await ok("snapshot"), /Фото/);
    const missing = await h.invoke("upload", { ref, files: ["secret.txt"], url: base + "/upload", description: "x" }, { sessionId: "s1" });
    expect(text(missing)).toContain("Could not take secret.txt from your workspace");
    const done = await h.invoke("upload", { ref, files: ["attachments/cat.jpg"], url: base + "/upload", description: "Фото кота" }, { sessionId: "s1" });
    expect(text(done), text(done)).toContain("Chose «cat.jpg»");
    expect(await ok("get_text")).toContain("cat.jpg:meow-jpeg");
    expect(h.tools.get("upload")!.approvalSummary).toBe("%approval.upload%");

    // The person clicks the field in the live view: no dialog can show there, so the view asks and the hub answers.
    await ok("open", { url: base + "/upload" });
    const all = () => h.coreCalls.filter((c) => c.method === "ui.emit").map((c) => c.params as { channel: string; payload: any });
    const from = all().length;
    const emits = () => all().slice(from);
    h.uiMessage({ type: "watch", on: true, id: "files" });
    const frame = await until(() => emits().find((e) => e.channel === "frame" && e.payload.url === base + "/upload"));
    h.uiMessage({ type: "control", on: true });
    await until(() => emits().find((e) => e.channel === "control" && e.payload.user === true));
    for (const action of ["down", "up"]) h.uiMessage({ type: "input", event: "mouse", action, x: 0.1, y: 30 / frame.payload.height, button: "left", clickCount: 1 });
    expect((await until(() => emits().find((e) => e.channel === "filechooser" && e.payload.open))).payload).toMatchObject({ open: true, multiple: false });
    const r = await h.http({ method: "POST", path: "/upload/files", body: { files: [{ name: "мой.png", data: Buffer.from("png!").toString("base64") }] } });
    expect(r.body).toEqual({ ok: true });
    await until(() => emits().find((e) => e.channel === "filechooser" && e.payload.open === false));
    // Nothing waits any more.
    expect((await h.http({ method: "POST", path: "/upload/cancel", body: {} })).body).toMatchObject({ ok: false });
    h.uiMessage({ type: "control", on: false });
    await until(() => emits().find((e) => e.channel === "control" && e.payload.user === false));
    expect(await ok("get_text")).toContain("мой.png:png!");
    h.uiMessage({ type: "watch", on: false, id: "files" });
  });

  it("keeps each agent in its own tab, so one cannot take the page another works on", async () => {
    const as = (agentId: string, name: string, input: Record<string, unknown> = {}) => h.invoke(name, input, { agentId }).then(text);
    // The photo critic fills a form; the news agent then searches in the same browser.
    expect(await as("fotokritik", "open", { url: base + "/upload" })).toContain(`Page: Загрузка — ${base}/upload`);
    expect(await as("newsdesk", "open", { url: base + "/about" })).toContain(`Page: О нас — ${base}/about`);
    // The critic's next call is on its own page, not the news agent's: an upload approved for it still finds the form.
    const ref = refOf(await as("fotokritik", "snapshot"), /Фото/);
    expect(await as("fotokritik", "upload", { ref, files: ["attachments/cat.jpg"], url: base + "/upload", description: "Фото кота" })).toContain("Chose «cat.jpg»");
    expect(await as("newsdesk", "get_text")).toContain("Мы продаём всё.");
    expect(await as("fotokritik", "get_text")).toContain("cat.jpg:meow-jpeg");
    // A tab opened for an agent of its own is no news to it.
    expect(await as("newsdesk", "snapshot")).not.toContain("A new tab opened");
    // Their tabs go; the rest of the tests work in the assistant's.
    await as("newsdesk", "tabs", { action: "close" });
    await as("fotokritik", "tabs", { action: "close" });
    expect(await ok("tabs", { action: "list" })).not.toMatch(/^2 /m);
  });

  it("refuses an approved action when the amount it spends is not on the page", async () => {
    await ok("open", { url: base + "/" });
    const snap = await ok("snapshot");
    const r = await call("submit", { ref: refOf(snap, /Купить/), label: "Купить", url: base + "/", description: "Купить", amount: 2400, currency: "KZT" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("the amount 2400 is not on the page");
  });

  it("keeps a history of the pages the person and the agents open, and shows each tab's state", async () => {
    await h.http({ method: "DELETE", path: "/history" });
    await ok("open", { url: base + "/about" });
    const emits = () => h.coreCalls.filter((c) => c.method === "ui.emit").map((c) => c.params as { channel: string; payload: any });
    // Earlier tests showed /long too: only what this one makes counts.
    const from = emits().length;
    h.uiMessage({ type: "watch", on: true, id: "history" });
    h.uiMessage({ type: "navigate", text: base + "/long" });
    const state = await until(() =>
      emits()
        .slice(from)
        .find((e) => e.channel === "state" && e.payload.url === base + "/long" && !e.payload.loading && e.payload.tabs.some((t: any) => t.icon)),
    );
    expect(state.payload).toMatchObject({ canGoBack: true, canGoForward: false, searchEngine: "duckduckgo" });
    expect(state.payload.tabs.find((t: any) => t.active)).toMatchObject({ url: base + "/long", loading: false, icon: base + "/favicon.ico" });
    h.uiMessage({ type: "watch", on: false, id: "history" });

    const list = await until(async () => {
      const r = (await h.http({ path: "/history" })).body as { visits: Array<{ url: string; title: string; by: string }> };
      return r.visits.length >= 2 && r.visits[0].title ? r : undefined;
    });
    expect(list.visits.slice(0, 2).map((v) => [v.url, v.title, v.by])).toEqual([
      [base + "/long", "Длинная", "user"],
      [base + "/about", "О нас", "assistant"],
    ]);
    const found = (await h.http({ path: "/history", query: { q: "нас" } })).body as { visits: Array<{ url: string }> };
    expect(found.visits.map((v) => v.url)).toEqual([base + "/about"]);
    expect(((await h.http({ path: "/suggest", query: { q: "127.0" } })).body as { visits: unknown[] }).visits.length).toBeGreaterThan(0);
    expect(((await h.http({ path: "/top" })).body as { sites: Array<{ url: string }> }).sites[0].url).toBe(base + "/");

    const history = await ok("history", { query: "Длинная" });
    expect(history).toContain(`the user · Длинная — ${base}/long`);
    expect(history).not.toContain("/about");
    const cleared = await ok("history_clear", { query: "нас", description: "Страница «О нас»" });
    expect(cleared).toContain("Deleted 1 visit");
    expect(((await h.http({ path: "/history", query: { q: "нас" } })).body as { visits: unknown[] }).visits).toEqual([]);
    expect(((await h.http({ method: "DELETE", path: "/history" })).body as { removed: number }).removed).toBeGreaterThan(0);
  });
});

describe("reading a search engine's results", () => {
  const SERP = page(
    "Results",
    `<div class="g"><a href="/url?q=https%3A%2F%2Fgoogle-target.example%2Fa&amp;sa=U"><h3>Google, wrapped</h3></a><span>Google snippet text that is long enough</span></div>
     <div class="g"><a href="https://www.google.com/goto?url=OPAQUE" ping="/url?url=OPAQUE2"><h3>Google, opaque</h3></a><span>Opaque snippet</span></div>
     <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=x&amp;u=a1aHR0cHM6Ly9iaW5nLXRhcmdldC5leGFtcGxlL3BhZ2U_eD0x&amp;ntb=1">Bing, wrapped</a></h2><p>Bing snippet</p></li>
     <article><h2><a href="https://ddg-target.example/">DuckDuckGo, direct</a></h2><div>DDG snippet</div></article>
     <div data-text-ad="1"><a href="https://ad.example/"><h3>An ad</h3></a></div>
     <li><a href="https://yandex.ru/images/search?text=x"><h2>Картинки</h2></a></li>
     <li><a href="https://yandex.ru/maps/213/moscow/probki/"><h2>Пробки в Москве — Яндекс Карты</h2></a><div>Пробки в режиме онлайн</div></li>
     <h2>A heading without a link</h2>`,
  );

  it("unwraps the engines' links and leaves out ads and the engine's own pages", async () => {
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage();
      // Served as Google's own page (relative /url links resolve there); nothing leaves this machine.
      await p.route("**/*", (r) => r.fulfill({ contentType: "text/html; charset=utf-8", body: SERP }));
      await p.goto("https://www.google.com/search?q=x");
      const own = /^([a-z0-9-]+\.)*google\.[a-z.]+\/|^(www\.)?(yandex\.[a-z.]+|ya\.ru)\/(an|images|video|search|news|q)\b/.source;
      const results = await p.evaluate(pageCall("results", { rules: PAGE_RULES, max: 10, own }));
      expect(results).toEqual([
        { title: "Google, wrapped", url: "https://google-target.example/a", snippet: "Google snippet text that is long enough" },
        { title: "Google, opaque", url: "https://www.google.com/goto?url=OPAQUE", snippet: "Opaque snippet" },
        { title: "Bing, wrapped", url: "https://bing-target.example/page?x=1", snippet: "Bing snippet" },
        { title: "DuckDuckGo, direct", url: "https://ddg-target.example/", snippet: "DDG snippet" },
        { title: "Пробки в Москве — Яндекс Карты", url: "https://yandex.ru/maps/213/moscow/probki/", snippet: "Пробки в режиме онлайн" },
      ]);
    } finally {
      await browser.close();
    }
  });
});

describe("browser plugin behind the hub egress proxy", () => {
  let h: PluginHarness;
  let proxy: Server;
  let origin: Server;
  const seen: Array<{ method: string; url: string; auth?: string }> = [];

  beforeAll(async () => {
    // Every host "behind" the proxy is served by this local origin.
    origin = createServer((req, res) => {
      const path = req.url ?? "/";
      const local = `http://127.0.0.1:${(origin.address() as AddressInfo).port}/secret`;
      if (path.endsWith("/data.csv")) {
        res.writeHead(200, { "content-type": "text/csv" }).end("a,b\n1,2\n");
      } else if (path.endsWith("/redirect")) {
        res.writeHead(302, { location: local }).end();
      } else if (path.endsWith("/secret")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("Секретная админка", "<h1>Админка</h1>"));
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("Через прокси", `<h1>Через прокси</h1><a href="${local}">Локальная ссылка</a>`));
      }
    });
    await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
    const originPort = (origin.address() as AddressInfo).port;
    // A minimal proxy that, like the hub's egress proxy, wants the token in Proxy-Authorization (plain HTTP and CONNECT).
    const authorized = (auth: string | undefined) => !!auth && Buffer.from(auth.replace(/^Basic\s+/i, ""), "base64").toString() === "tok_test:x";
    proxy = createServer((req, res) => {
      const auth = req.headers["proxy-authorization"] as string | undefined;
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth });
      if (!authorized(auth)) {
        res.writeHead(auth ? 403 : 407, { "proxy-authenticate": 'Basic realm="piomio"' }).end();
        return;
      }
      const target = new URL(req.url ?? "/");
      const up = request({ host: "127.0.0.1", port: originPort, path: target.pathname + target.search, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      req.pipe(up);
    });
    proxy.on("connect", (req, socket: Socket, head) => {
      const auth = req.headers["proxy-authorization"] as string | undefined;
      seen.push({ method: "CONNECT", url: req.url ?? "", auth });
      if (!authorized(auth)) {
        socket.end(`HTTP/1.1 ${auth ? "403 Forbidden" : "407 Proxy Authentication Required"}\r\nProxy-Authenticate: Basic realm="piomio"\r\n\r\n`);
        return;
      }
      const up = connect(originPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      up.on("error", () => socket.destroy());
      socket.on("error", () => up.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const url = `http://tok_test:x@127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    h = await startPlugin({
      dir: PLUGIN_DIR,
      settings: { headless: "always" },
      env: { ...browsersEnv(), HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, NO_PROXY: "", no_proxy: "" },
    });
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
    proxy?.close();
    origin?.close();
  });

  it("sends browser traffic through the proxy with the token from the env", async () => {
    const r = await h.invoke("open", { url: "http://proxied.example/" });
    expect(r.isError, text(r)).toBeFalsy();
    expect(text(r)).toContain("Через прокси — http://proxied.example/");
    expect(seen.some((s) => s.url === "http://proxied.example/" && authorizedSeen(s.auth))).toBe(true);
    // Downloads by URL use the browser context's request API, which must use the same proxy and token.
    const d = await h.invoke("download", { url: "http://proxied.example/data.csv" });
    expect(d.isError, text(d)).toBeFalsy();
    expect(readFileSync(join(h.dataDir, "downloads", "data.csv"), "utf8")).toBe("a,b\n1,2\n");
    expect(seen.filter((s) => s.url.includes("proxied.example")).every((s) => !s.auth || authorizedSeen(s.auth))).toBe(true);
  });

  it("searches for words typed into the address bar", async () => {
    h.uiMessage({ type: "navigate", text: "сова птица" });
    await until(() => seen.find((s) => s.method === "CONNECT" && s.url === "duckduckgo.com:443"));
    h.setSettings({ headless: "always", searchEngine: "bing" });
    h.uiMessage({ type: "navigate", text: "сова птица" });
    await until(() => seen.find((s) => s.method === "CONNECT" && s.url === "www.bing.com:443"));
  });

  it("does not let links or redirects from public pages take the agent to local addresses", async () => {
    await h.invoke("open", { url: "http://proxied.example/" });
    const snap = text(await h.invoke("snapshot"));
    const click = await h.invoke("click", { ref: refOf(snap, /link "Локальная ссылка"/) });
    expect(click.isError).toBe(true);
    expect(text(click)).toContain("local address 127.0.0.1");
    expect(text(click)).not.toContain("Секретная админка");
    expect(text(click)).toContain("about:blank");
    const redirect = await h.invoke("open", { url: "http://proxied.example/redirect" });
    expect(redirect.isError).toBe(true);
    expect(text(redirect)).not.toContain("Секретная админка");
  });
});
