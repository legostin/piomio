import { describe, expect, it } from "vitest";
import {
  againAfterNavigation,
  decideHeadless,
  filenameFromDisposition,
  findChrome,
  launchArgs,
  windowedUserAgent,
  isPrivateHost,
  normalizeUrl,
  proxyFromEnv,
  readSettings,
  resolveAddress,
  sanitizeFilename,
  totpCode,
} from "../server/util.ts";
import { addressKind, searchUrl } from "../server/address.ts";
import {
  ACTION_HINT_RE,
  ACTION_LABEL_RE,
  CHECKOUT_FORM_RE,
  LINK_ACTION_LABEL_RE,
  LINK_ACTION_PATH_RE,
  PAGE_RULES,
  PROCEED_LABEL_RE,
  activationKey,
  amountOnPage,
  keyNeedsSubmit,
  sameLabel,
  splitTrailingNewline,
  submitCall,
} from "../server/safety.ts";
import { keyEventParams } from "../server/manager.ts";

describe("settings", () => {
  it("applies defaults and accepts booleans for headless", () => {
    expect(readSettings({})).toEqual({ headless: "auto", idleMinutes: 30, allowLocalNetwork: false, takeoverWaitSec: 10, maxDownloadMb: 200, searchEngine: "duckduckgo", rememberActions: true });
    expect(readSettings({ searchEngine: "yandex" }).searchEngine).toBe("yandex");
    expect(readSettings({ searchEngine: "altavista" }).searchEngine).toBe("duckduckgo");
    expect(readSettings({ headless: false }).headless).toBe("never");
    expect(readSettings({ headless: true }).headless).toBe("always");
    expect(readSettings({ idleMinutes: "5" }).idleMinutes).toBe(5);
    expect(readSettings({ idleMinutes: -3 }).idleMinutes).toBe(1);
  });

  it("is headed only with a display", () => {
    expect(decideHeadless("auto", { DISPLAY: ":99" }, "linux")).toBe(false);
    expect(decideHeadless("auto", {}, "linux")).toBe(true);
    expect(decideHeadless("auto", {}, "win32")).toBe(true);
    expect(decideHeadless("never", {}, "win32")).toBe(false);
    expect(decideHeadless("always", { DISPLAY: ":99" }, "linux")).toBe(true);
  });
});

describe("an ordinary browser", () => {
  it("finds Google Chrome where it is installed", () => {
    const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    expect(findChrome("darwin", {}, (p) => p === mac)).toBe(mac);
    expect(findChrome("darwin", { HOME: "/Users/me" }, (p) => p.startsWith("/Users/me/"))).toBe("/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(findChrome("linux", {}, (p) => p === "/usr/bin/google-chrome")).toBe("/usr/bin/google-chrome");
    expect(findChrome("win32", { LOCALAPPDATA: "C:/Users/me/AppData/Local" }, (p) => p.includes("Local"))).toMatch(/Local.Google.Chrome.Application.chrome\.exe$/);
    expect(findChrome("linux", {}, () => false)).toBeNull();
  });

  it("calls itself Chrome when headless", () => {
    expect(windowedUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36")).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
    );
  });

  it("launches without automation switches, with a screen and user agent only when headless", () => {
    const ua = "Mozilla/5.0 Chrome/156.0.0.0";
    const headless = launchArgs({ headless: true, platform: "darwin", userAgent: ua, proxy: true });
    expect(headless).toContain("--disable-blink-features=AutomationControlled");
    expect(headless).toContain(`--user-agent=${ua}`);
    expect(headless.some((a) => a.startsWith("--screen-info={1920x1080"))).toBe(true);
    expect(headless).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
    const headed = launchArgs({ headless: false, platform: "linux", userAgent: ua, proxy: false });
    expect(headed.some((a) => a.startsWith("--user-agent") || a.startsWith("--screen-info"))).toBe(false);
    expect(headed).toContain("--window-size=1280,900");
    expect(headed.some((a) => a.includes("enable-automation") || a.includes("webrtc"))).toBe(false);
  });
});

describe("proxy", () => {
  it("takes the egress token from the URL userinfo", () => {
    const env = { HTTPS_PROXY: "http://tok_abc:x@127.0.0.1:8089", NO_PROXY: "127.0.0.1,localhost" };
    expect(proxyFromEnv(env)).toEqual({ server: "http://127.0.0.1:8089", username: "tok_abc", password: "x" });
    expect(proxyFromEnv(env, true)?.bypass).toBe("127.0.0.1,localhost");
    expect(proxyFromEnv({})).toBeUndefined();
  });
});

describe("urls", () => {
  it("recognizes local and private hosts", () => {
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.1", "172.20.0.5", "169.254.169.254", "[::1]", "fd00::1", "router", "nas.local", "host.docker.internal", "app.localhost"]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "2001:4860:4860::8888"]) expect(isPrivateHost(h), h).toBe(false);
    // WHATWG URL normalizes numeric hosts, so decimal tricks are caught too.
    expect(isPrivateHost(new URL("http://2130706433/").hostname)).toBe(true);
  });

  it("normalizes user input", () => {
    expect(normalizeUrl("example.com/a").href).toBe("https://example.com/a");
    expect(normalizeUrl("localhost:3000").href).toBe("http://localhost:3000/");
    expect(normalizeUrl("http://x.test/").href).toBe("http://x.test/");
    expect(() => normalizeUrl("file:///etc/passwd")).toThrow(/http/);
    expect(() => normalizeUrl("javascript:alert(1)")).toThrow();
  });

  it("tells an address from words to search for", () => {
    for (const a of ["example.com", "https://example.com/a b", "ru.wikipedia.org/wiki/Сова", "localhost:3000", "192.168.0.1", "[::1]:8080", "nas:8080/x", "кц.рф", "about:blank", "ftp://example.com/", "xn--d1acufc.xn--p1ai"]) {
      expect(addressKind(a), a).toBe("url");
    }
    for (const w of ["пробки алматы", "weather", "1.5", "v1.2", "what is example.com", "javascript:alert(1)", "mailto:a@b.c", "C++"]) {
      expect(addressKind(w), w).toBe("search");
    }
    expect(addressKind("   ")).toBe("empty");
  });

  it("searches the chosen engine for words and opens addresses", () => {
    expect(searchUrl("duckduckgo", "пробки алматы")).toBe("https://duckduckgo.com/?q=%D0%BF%D1%80%D0%BE%D0%B1%D0%BA%D0%B8%20%D0%B0%D0%BB%D0%BC%D0%B0%D1%82%D1%8B");
    expect(searchUrl("google", "a&b")).toBe("https://www.google.com/search?q=a%26b");
    expect(searchUrl("yandex", "x")).toBe("https://yandex.ru/search/?text=x");
    expect(searchUrl("bing", "x")).toBe("https://www.bing.com/search?q=x");
    expect(resolveAddress(" example.com ", "google").href).toBe("https://example.com/");
    expect(resolveAddress("C++ tutorial", "bing").href).toBe("https://www.bing.com/search?q=C%2B%2B%20tutorial");
    expect(() => resolveAddress("ftp://example.com/", "google")).toThrow(/http/);
    expect(() => resolveAddress("", "google")).toThrow(/Empty/);
  });
});

describe("files", () => {
  it("sanitizes names", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("..")).toBe("download");
    expect(sanitizeFilename("a<b>:c?.pdf")).toBe("a_b_c_.pdf");
    expect(sanitizeFilename("CON.txt")).toBe("_CON.txt");
    expect(sanitizeFilename("")).toBe("download");
    expect(sanitizeFilename("x".repeat(300) + ".zip").length).toBeLessThanOrEqual(120);
  });

  it("parses Content-Disposition", () => {
    expect(filenameFromDisposition(`attachment; filename="a b.txt"`)).toBe("a b.txt");
    expect(filenameFromDisposition(`attachment; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82.txt`)).toBe("отчёт.txt");
    expect(filenameFromDisposition(undefined)).toBeUndefined();
  });
});

describe("reading a page that navigates", () => {
  const gone = () => Promise.reject(new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation"));

  it("reads the new document once the navigation has loaded it", async () => {
    const calls: string[] = [];
    let first = true;
    const read = () => (calls.push("read"), first ? ((first = false), gone()) : Promise.resolve("the new page"));
    expect(await againAfterNavigation(read, async () => void calls.push("settle"))).toBe("the new page");
    expect(calls).toEqual(["read", "settle", "read"]);
  });

  it("tries once more only, and passes other errors on", async () => {
    await expect(againAfterNavigation(gone, async () => {})).rejects.toThrow(/Execution context was destroyed/);
    let reads = 0;
    const broken = () => (reads++, Promise.reject(new Error("the page is not responding")));
    await expect(againAfterNavigation(broken, async () => {})).rejects.toThrow("the page is not responding");
    expect(reads).toBe(1);
  });
});

describe("totp", () => {
  it("matches the RFC 6238 SHA-1 vector", () => {
    // Secret "12345678901234567890" in base32, T = 59 s → 94287082 (8 digits).
    const uri = "otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8";
    expect(totpCode(uri, 59_000)).toBe("94287082");
    expect(totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1111111109_000)).toBe("081804");
  });
});

describe("safety", () => {
  it("flags action labels in English and Russian", () => {
    const actions = [
      ...["Buy now", "Purchase", "Pay $34.00", "Proceed to checkout", "Check out", "Order", "Place your order", "Send", "Submit application", "Confirm"],
      ...["Delete", "Remove", "Erase all data", "Publish", "Post", "Tweet", "Transfer funds", "Withdraw", "Top up", "Sell", "Place bid", "Donate"],
      ...["Subscribe", "Unsubscribe", "Book now", "Reserve a table", "Approve", "Vote", "Deactivate", "Sign", "Sign the petition", "Apply now"],
      ...["Close account", "Empty trash", "Discard draft", "Remove from list"],
      ...["Купить", "Купи", "Купите", "Покупка", "Оплатить", "Перейти к оплате", "Заказать", "Оформить заказ", "Оформите", "Отправить", "Подтвердить"],
      ...["Удалить", "Удалите", "Удаление", "Стереть", "Опубликовать", "Разместить объявление", "Перевести 500 ₽", "Пожертвовать", "Подписаться"],
      ...["Подписать договор", "Отписаться", "Забронировать", "Списать", "Продать", "Вывести средства", "Пополнить", "Записаться на приём"],
      ...["Подать заявку", "Оставить заявку", "Проголосовать", "Сделать ставку", "Отменить бронь", "Закрыть счёт", "Деактивировать", "Очистить корзину"],
    ];
    for (const s of actions) expect(ACTION_LABEL_RE.test(s), s).toBe(true);
    const ordinary = [
      ...["Купон", "Search", "Next", "Далее", "Найти", "Orders", "Resend code", "PayPal", "Facebook", "Sign in", "Sign up", "Sign out", "Add to cart"],
      ...["Remove filter", "Remove all filters", "Remove from cart", "Posted 3 hours ago", "Postcode", "Notebook", "Payments", "Мои заказы", "Заказы"],
      ...["Удалённая работа", "Продажи", "Корзина", "Войти", "Показать ещё"],
    ];
    for (const s of ordinary) expect(ACTION_LABEL_RE.test(s), s).toBe(false);
    expect(LINK_ACTION_LABEL_RE.test("Удалить аккаунт")).toBe(true);
    expect(LINK_ACTION_LABEL_RE.test("Отписаться от рассылки")).toBe(true);
    expect(LINK_ACTION_LABEL_RE.test("Destroy")).toBe(true);
    expect(LINK_ACTION_LABEL_RE.test("Мои заказы")).toBe(false);
  });

  it("reads identifiers, acting links and checkout forms", () => {
    // The page script splits identifiers into words first: placeYourOrder1 → "place Your Order".
    for (const s of ["place Your Order", "buy Now Button", "checkout Btn", "btn delete", "submit Order", "pay button", "tweet Button", "send button"]) {
      expect(ACTION_HINT_RE.test(s), s).toBe(true);
    }
    for (const s of ["post card menu", "submit btn", "paypal button", "payment method", "like post", "resend code", "sort order"]) expect(ACTION_HINT_RE.test(s), s).toBe(false);
    for (const s of ["delete", "unsubscribe", "opt-out", "Destroy"]) expect(LINK_ACTION_PATH_RE.test(s), s).toBe(true);
    for (const s of ["how-to-delete-your-account", "deleted", "items"]) expect(LINK_ACTION_PATH_RE.test(s), s).toBe(false);
    for (const s of ["checkout form", "payment", "order details", "оформление заказа", "оплата"]) expect(CHECKOUT_FORM_RE.test(s), s).toBe(true);
    for (const s of ["profile", "search", "settings"]) expect(CHECKOUT_FORM_RE.test(s), s).toBe(false);
    for (const s of ["Continue", "Next →", "→ Proceed", "Далее", "Продолжить", "OK", "Ок"]) expect(PROCEED_LABEL_RE.test(s), s).toBe(true);
    for (const s of ["Back", "Не далее", "Окно", "Nextcloud"]) expect(PROCEED_LABEL_RE.test(s), s).toBe(false);
    // Everything the page needs crosses into it as plain sources.
    expect(new RegExp(PAGE_RULES.action, "iu").test("Оплатить")).toBe(true);
    expect(JSON.parse(JSON.stringify(PAGE_RULES))).toEqual(PAGE_RULES);
  });

  it("treats a trailing line break as Enter", () => {
    expect(splitTrailingNewline("Привет\n")).toEqual({ text: "Привет", enter: true });
    expect(splitTrailingNewline("a\r\n  ")).toEqual({ text: "a", enter: true });
    expect(splitTrailingNewline("line 1\nline 2")).toEqual({ text: "line 1\nline 2", enter: false });
    expect(splitTrailingNewline("a\nb\n\n")).toEqual({ text: "a\nb", enter: true });
    expect(splitTrailingNewline("plain")).toEqual({ text: "plain", enter: false });
  });

  it("checks the approved label against the element", () => {
    expect(sameLabel("Pay $34.00", "Pay $34.00")).toBe(true);
    expect(sameLabel(" pay  $34.00 ", "Pay $34.00")).toBe(true);
    expect(sameLabel("«Купить»", "Купить")).toBe(true);
    expect(sameLabel("Pay $34.00", "Pay $340.00")).toBe(false);
    expect(sameLabel("Pay…", "Pay $500")).toBe(false);
    expect(sameLabel("", "Delete")).toBe(false);
    const long = "Confirm the transfer of 500 RUB to the account ending in 1234 at Example Bank today";
    const shown = long.slice(0, 79) + "…";
    expect(sameLabel(shown, shown)).toBe(true);
    expect(sameLabel(shown, long)).toBe(true);
    expect(submitCall("e5", "Pay", "https://shop.example/")).toContain('Call browser_submit with ref "e5", label "Pay", url "https://shop.example/"');
  });

  it("requires browser_submit for Enter in fields and forms", () => {
    const base = { tag: "input", name: "", editable: false, inForm: false, search: false, submit: false };
    expect(activationKey("Enter")).toBe("enter");
    expect(activationKey("Control+Enter")).toBe("enter");
    expect(activationKey("Space")).toBe("space");
    expect(activationKey("Tab")).toBeNull();
    expect(keyNeedsSubmit("enter", { ...base, editable: true })).toBe(true);
    expect(keyNeedsSubmit("enter", { ...base, editable: true, inForm: true, search: true })).toBe(false);
    expect(keyNeedsSubmit("enter", { ...base, tag: "a" })).toBe(false);
    expect(keyNeedsSubmit("space", { ...base, editable: true })).toBe(false);
    expect(keyNeedsSubmit("space", { ...base, submit: true })).toBe(true);
  });
});

describe("takeover keys", () => {
  it("maps UI keyboard events to CDP", () => {
    expect(keyEventParams({ key: "a", code: "KeyA", action: "down" }, 0)).toMatchObject({ type: "keyDown", text: "a", windowsVirtualKeyCode: 65 });
    expect(keyEventParams({ key: "Enter", code: "Enter", action: "down" }, 0)).toMatchObject({ type: "keyDown", text: "\r", windowsVirtualKeyCode: 13 });
    expect(keyEventParams({ key: "a", code: "KeyA", action: "down" }, 2)).toMatchObject({ type: "rawKeyDown", text: undefined });
    expect(keyEventParams({ key: "ArrowLeft", action: "up" }, 0)).toMatchObject({ type: "keyUp", windowsVirtualKeyCode: 37 });
    // A Windows key code is a native one only on Windows: on a Mac, Shift (16) made Chrome open its settings.
    expect(keyEventParams({ key: "Shift", code: "ShiftLeft", keyCode: 16, action: "down" }, 8, "darwin")).not.toHaveProperty("nativeVirtualKeyCode");
    expect(keyEventParams({ key: "Shift", code: "ShiftLeft", keyCode: 16, action: "down" }, 8, "linux")).not.toHaveProperty("nativeVirtualKeyCode");
    expect(keyEventParams({ key: "Shift", code: "ShiftLeft", keyCode: 16, action: "down" }, 8, "win32")).toMatchObject({ nativeVirtualKeyCode: 16 });
    expect(keyEventParams({ key: "" }, 0)).toBeNull();
  });
});

describe("amounts on the page", () => {
  it("finds an amount however the site writes it, and not inside a longer number", () => {
    for (const text of ["Итого: 2400 ₸", "Итого: 2 400 ₸", "Итого: 2\u00a0400 ₸", "Total $2,400.00", "2.400,00 €", "к оплате 2400.00"]) {
      expect(amountOnPage(text, 2400), text).toBe(true);
    }
    expect(amountOnPage("Итого: 12 400 ₸", 2400)).toBe(false);
    expect(amountOnPage("Итого: 2 4000 ₸", 2400)).toBe(false);
    expect(amountOnPage("Total $34.50", 34.5)).toBe(true);
    expect(amountOnPage("Total $34.50", 34)).toBe(false);
    expect(amountOnPage("Total $34", 34.5)).toBe(false);
    expect(amountOnPage("anything", Number.NaN)).toBe(false);
  });
});
