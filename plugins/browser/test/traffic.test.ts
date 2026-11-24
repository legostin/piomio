// The traffic ability end to end: the plugin in a real child process drives headless Chromium against a local site
// that sets a session cookie, calls its own API with a bearer token and takes a password. What agents read of that
// traffic never has the cookie, the token or the password in it; what they send again carries them all the same.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { ToolResult } from "@piomio/shared";
import { startPlugin, type PluginHarness } from "@piomio/testkit";
import { chromium } from "playwright";

const PLUGIN_DIR = join(import.meta.dirname, "..");
const HIDDEN = "«hidden»";
const SESSION = "s3ss10nC00k1eV4lue77";
const TOKEN = "t0kenForTheApi9x8y7z6";
const PASSWORD = "hunter2-Pa55";
const SECRETS = [SESSION, TOKEN, PASSWORD];

function browsersEnv(): Record<string, string> {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return {};
  const exe = chromium.executablePath();
  const m = /^(.*?)[\\/]chromium-\d+[\\/]/.exec(exe);
  return m && existsSync(exe) ? { PLAYWRIGHT_BROWSERS_PATH: m[1] } : {};
}

const APP = `<!doctype html><html><head><meta charset="utf-8"><title>Shop</title><script src="/app.js"></script></head><body>
<h1>Shop</h1><ul id="list">loading</ul><p id="made">real page</p>
<button id="buy">Add to cart</button><p id="cart"></p>
<form method="post" action="/login"><input name="username" value="anna"><input type="password" name="password" value="${PASSWORD}"><button>Sign in</button></form>
<script>
  const auth = { Authorization: "Bearer ${TOKEN}" };
  fetch("/api/items?page=1", { headers: auth })
    .then((r) => r.json())
    .then((d) => (list.innerHTML = d.items.map((i) => "<li>" + i.title + ": " + i.price + "</li>").join("")))
    .catch(() => (list.textContent = "failed to load"));
  buy.onclick = () =>
    fetch("/api/cart", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ item: 7, quantity: 2, total: 2400, csrf_token: "${TOKEN}" }) })
      .then((r) => r.json())
      .then((d) => (cart.textContent = "in cart: " + d.quantity));
</script></body></html>`;

function text(r: ToolResult): string {
  return r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
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

async function readBody(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const c of req) s += c;
  return s;
}

describe("browser traffic (headless Chromium)", { timeout: 60_000 }, () => {
  let h: PluginHarness;
  let server: Server;
  let base: string;
  let host: string;
  let on = false;
  const workspace = mkdtempSync(join(tmpdir(), "traffic-ws-"));
  /** What the site's API received: the test's proof of what really left the browser. */
  const seen: Array<{ method: string; path: string; query: string; auth?: string; cookie?: string; extra?: string; body: string }> = [];
  const outputs: string[] = [];

  const fakeCore = (method: string, p: any) => {
    if (method === "plugins.enabled") return { enabled: p.id === "browser-traffic" && on };
    if (method !== "files.deliver") return {};
    const dir = join(workspace, "downloads");
    mkdirSync(dir, { recursive: true });
    const rel: string = p.path ?? `downloads/${p.name}`;
    appendFileSync(join(workspace, rel), Buffer.from(p.data, "base64"));
    return { path: rel, absolutePath: join(workspace, rel) };
  };

  const call = async (name: string, input: Record<string, unknown> = {}) => {
    const r = await h.invoke(name, input);
    outputs.push(text(r));
    return r;
  };
  const ok = async (name: string, input: Record<string, unknown> = {}) => {
    const r = await call(name, input);
    expect(r.isError, text(r)).toBeFalsy();
    return text(r);
  };
  const refused = async (name: string, input: Record<string, unknown> = {}) => {
    const r = await call(name, input);
    expect(r.isError, text(r)).toBe(true);
    return text(r);
  };
  const setOn = async (value: boolean) => {
    on = value;
    h.emit("plugins.updated", {});
    await until(() => h.tools.has("requests") === value);
  };
  /** The number of the newest request matching a mask. */
  const lastId = async (match: string, method?: string, type?: string) => {
    const list = await ok("requests", { match, ...(method ? { method } : {}), ...(type ? { type } : {}) });
    const ids = [...list.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]));
    expect(ids.length, list).toBeGreaterThan(0);
    return ids[ids.length - 1];
  };
  const pageText = () => ok("get_text");
  const reload = async () => {
    await ok("open", { url: `${base}/app` });
    await until(async () => !(await pageText()).includes("loading"));
  };

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const body = req.method === "GET" ? "" : await readBody(req);
      if (url.pathname.startsWith("/api/")) {
        seen.push({ method: req.method!, path: url.pathname, query: url.search, auth: req.headers.authorization, cookie: req.headers.cookie, extra: req.headers["x-extra"] as string | undefined, body });
      }
      if (url.pathname === "/app") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": `sid=${SESSION}; Path=/; HttpOnly` }).end(APP);
      if (url.pathname === "/app.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(`window.addEventListener("load", () => { made.textContent = "real script"; });`);
      if (url.pathname === "/api/items") {
        return void res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ page: Number(url.searchParams.get("page")), items: [{ title: "Water 19 l", price: 1200 }, { title: "Pump", price: 3500 }], refresh_token: TOKEN }));
      }
      if (url.pathname === "/api/cart") {
        if (req.method === "POST") return void res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, quantity: JSON.parse(body || "{}").quantity ?? 0 }));
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, deleted: req.method === "DELETE" }));
      }
      if (url.pathname === "/login") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<title>In</title><p>signed in as ${new URLSearchParams(body).get("username")}</p>`);
      res.writeHead(404).end("not found");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    base = `http://${host}`;
    h = await startPlugin({ dir: PLUGIN_DIR, settings: { headless: "always", allowLocalNetwork: true, takeoverWaitSec: 0 }, core: fakeCore, env: browsersEnv() });
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
    server?.close();
  });

  it("has no traffic tools and keeps nothing until the ability is turned on", async () => {
    await ok("open", { url: `${base}/app` });
    for (const name of ["requests", "requests_save", "request_rule", "request_get", "request_change", "request_send"]) expect(h.tools.has(name), name).toBe(false);
    await setOn(true);
    expect(h.tools.get("requests")?.effect).toBe("read");
    expect(h.tools.get("request_rule")?.effect).toBe("local-write");
    expect(h.tools.get("request_get")?.effect).toBe("read");
    expect(h.tools.get("request_change")?.effect).toBe("external");
    expect(h.tools.get("request_send")?.effect).toBe("external");
    // What happened before it was on was not recorded.
    expect(await ok("requests")).toContain("No requests recorded yet");
  });

  it("lists what the page asked and shows one request in full, with secrets hidden", async () => {
    await reload();
    const list = await ok("requests");
    expect(list).toMatch(new RegExp(`#\\d+ \\S+ GET ${host.replace(/\./g, "\\.")}/app → 200 html`));
    expect(list).toMatch(/GET \S+\/api\/items\?page=1 → 200 json/);
    expect(list).toMatch(/GET \S+\/app\.js → 200 javascript/);

    const only = await ok("requests", { match: "/api/*", method: "get" });
    expect(only.split("\n").filter((l) => l.startsWith("#"))).toHaveLength(1);
    expect(await ok("requests", { status: "4xx" })).toContain("No requests match");

    const full = await ok("requests", { id: await lastId("/api/items") });
    expect(full).toContain("Water 19 l");
    expect(full).toContain(`Authorization: Bearer ${HIDDEN}`);
    expect(full).toContain(`sid=${HIDDEN}`);
    expect(full).toContain(`"refresh_token":"${HIDDEN}"`);

    // The page itself, whose body spells the token and the password out, and whose answer sets the cookie.
    const doc = await ok("requests", { id: await lastId("/app", "GET", "document"), maxChars: 20000 });
    expect(doc).toContain(`set-cookie: sid=${HIDDEN}; Path=/; HttpOnly`);
    expect(doc).toContain(`Authorization: "${HIDDEN}"`);
    expect(doc).toContain(`name="password" value="${HIDDEN}"`);
    expect(doc).toContain(`name="username" value="anna"`);

    const json = JSON.parse(await ok("requests", { match: "/api/items", json: true, bodies: true }));
    expect(json.total).toBe(1);
    expect(json.requests[0]).toMatchObject({ method: "GET", status: 200, type: "fetch", responseBody: { page: 1, items: [{ title: "Water 19 l", price: 1200 }, { title: "Pump", price: 3500 }], refresh_token: HIDDEN } });
    expect(json.requests[0].requestHeaders.authorization).toBe(`Bearer ${HIDDEN}`);
  });

  it("hides a password a form posts, and what an agent sends again still carries the token and the cookie", async () => {
    const snap = await ok("snapshot");
    const ref = /^\[(e\d+)\] button "Add to cart"/m.exec(snap)![1];
    await ok("submit", { ref, label: "Add to cart", url: `${base}/app`, description: "Add to the cart" });
    await until(async () => (await pageText()).includes("in cart: 2"));
    const post = await lastId("/api/cart", "POST");
    const full = await ok("requests", { id: post });
    expect(full).toContain(`"csrf_token":"${HIDDEN}"`);
    expect(full).toContain(`"total":2400`);

    // GET again with other parameters: the page's Authorization goes along, unseen.
    seen.length = 0;
    const got = await ok("request_get", { url: `${base}/api/items?page=1`, from: await lastId("/api/items"), query: { page: "3" } });
    expect(got).toContain("→ 200 OK");
    expect(got).toContain(`"page":3`);
    expect(seen).toMatchObject([{ method: "GET", path: "/api/items", query: "?page=3", auth: `Bearer ${TOKEN}`, cookie: `sid=${SESSION}` }]);

    // The recorded POST with one field of its JSON changed; the hidden field keeps its value.
    seen.length = 0;
    const sent = await ok("request_send", { method: "POST", url: `${base}/api/cart`, from: post, set: { quantity: 5 }, description: "Add five to the cart" });
    expect(sent).toContain("→ 201 Created");
    expect(sent).toContain(`"quantity":5`);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", auth: `Bearer ${TOKEN}`, cookie: `sid=${SESSION}` });
    expect(JSON.parse(seen[0].body)).toEqual({ item: 7, quantity: 5, total: 2400, csrf_token: TOKEN });

    // A request of its own, with no recorded one behind it: the browser's cookie, no token.
    seen.length = 0;
    await ok("request_send", { method: "DELETE", url: `${base}/api/cart`, description: "Empty the cart" });
    expect(seen).toMatchObject([{ method: "DELETE", cookie: `sid=${SESSION}` }]);
    expect(seen[0].auth).toBeUndefined();
    // What the agent sent is in the log too.
    expect(await ok("requests", { type: "agent" })).toMatch(/DELETE \S+\/api\/cart → 200 json .*\[sent by /);

    // An amount that is not what the request carries, the hidden mark as a value, and another site are refused.
    expect(await refused("request_send", { method: "POST", url: `${base}/api/cart`, from: post, description: "x", amount: 999 })).toContain("the amount 999 is not in the request");
    await ok("request_send", { method: "POST", url: `${base}/api/cart`, from: post, description: "x", amount: 2400, currency: "KZT" });
    expect(await refused("request_send", { method: "POST", url: `${base}/api/cart`, description: "x", data: { csrf_token: HIDDEN } })).toContain(`data has ${HIDDEN} in it`);
    expect(await refused("request_send", { method: "POST", url: `${base}/api/../login`, description: "x" })).toContain("the whole address as the request goes out");
    // For a skill's script: the answer as JSON, and a wait for the page's own call.
    const asJson = JSON.parse((await ok("request_get", { url: `${base}/api/items?page=4`, json: true })).split("\n")[0]);
    expect(asJson).toMatchObject({ method: "GET", status: 200, type: "agent", responseBody: { page: 4 } });
    expect(JSON.parse(await ok("requests", { match: "/api/cart", method: "POST", json: true, waitMs: 2000 })).total).toBeGreaterThan(0);
    expect(await refused("request_send", { method: "POST", url: "http://127.0.0.2:9/api/cart", from: post, description: "x" })).toContain("goes only there");
    expect(await refused("request_send", { method: "GET", url: `${base}/api/cart`, description: "x" })).toContain("browser_request_get");

    // The sign-in form: the password is in the request's body and never in what the agent reads.
    const button = /^\[(e\d+)\] button "Sign in"/m.exec(await ok("snapshot"))![1];
    await ok("submit", { ref: button, label: "Sign in", url: `${base}/app`, description: "Sign in" });
    const login = await ok("requests", { id: await lastId("/login", "POST") });
    expect(login).toContain(`username=anna&password=${HIDDEN}`);
  });

  it("saves the log as a HAR file without the secrets", async () => {
    const saved = await ok("requests_save", { match: "/api/*", name: "shop-api" });
    const path = /to (\S+\.har) /.exec(saved)![1];
    const har = JSON.parse(readFileSync(join(workspace, path), "utf8"));
    expect(har.log.version).toBe("1.2");
    expect(har.log.entries.length).toBeGreaterThan(3);
    const first = har.log.entries.find((e: any) => e.request.url.endsWith("/api/items?page=1"));
    expect(first.request.headers).toContainEqual({ name: "Authorization", value: `Bearer ${HIDDEN}` });
    expect(JSON.parse(first.response.content.text).items[0].title).toBe("Water 19 l");
    for (const s of SECRETS) expect(readFileSync(join(workspace, path), "utf8")).not.toContain(s);
  });

  it("blocks requests, answers for them and patches real answers, on data only", async () => {
    expect(await ok("request_rule", { action: "block", match: "/api/items" })).toMatch(/^Set: rule \d+: \/api\/items → block; tab \d+, 0 hits, 30 min left/);
    await reload();
    expect(await pageText()).toContain("failed to load");
    expect(await ok("requests", { status: "failed" })).toMatch(/api\/items\?page=1 → failed .*\[blocked by rule \d+\]/);

    // A newer rule wins: a made-up answer.
    await ok("request_rule", { action: "respond", match: "/api/items", body: JSON.stringify({ items: [{ title: "Made up", price: 1 }] }) });
    await reload();
    expect(await pageText()).toContain("Made up: 1");
    expect(await ok("requests", { match: "/api/items", since: 0 })).toMatch(/\[answered by rule \d+\]/);

    expect(await ok("request_rule", { action: "remove" })).toBe("Removed 2 rules.");
    await ok("request_rule", { action: "patch", match: "/api/items", set: { "items.0.price": 5, "items.1.title": "Patched" }, minutes: 5 });
    await reload();
    const shown = await pageText();
    expect(shown).toContain("Water 19 l: 5");
    expect(shown).toContain("Patched: 3500");

    // Code is not data: an answer with HTML or a script is refused, and a script matching a data rule is left alone.
    expect(await refused("request_rule", { action: "respond", match: "/app", contentType: "text/html", body: "<h1>mine</h1>" })).toContain("browser_request_change");
    // Nor is an address of another site: the page would be sent there (a picture, a link), with whatever the address carries.
    for (const body of ['{"items":[{"title":"x","price":1,"img":"https://evil.example/p.png?d=1200"}]}', '{"next":"\\/\\/evil.example\\/more"}', "see http://203.0.113.9/x"]) {
      expect(await refused("request_rule", { action: "respond", match: "/api/items", body })).toMatch(/points the page at (evil\.example|203\.0\.113\.9), which is not the site of this tab/);
    }
    expect(await refused("request_rule", { action: "patch", match: "/api/items", set: { "items.0.title": "<img src=//evil.example/a>" } })).toContain("evil.example");
    await ok("request_rule", { action: "respond", match: "/api/none", body: JSON.stringify({ next: `${base}/api/items?page=2`, note: "price 1200 // per bottle, ratio 3://4" }) });
    await ok("request_rule", { action: "remove" });
    await ok("request_rule", { action: "respond", match: "/app.js", contentType: "text/plain", body: "made.textContent = 'agent script'" });
    await reload();
    expect(await pageText()).toContain("real script");
    expect(await ok("request_rule", { action: "list" })).toMatch(/\/app\.js → answer 200 text\/plain .* 0 hits, 1 left alone/);

    // The live view is told whose rules change the tab's traffic, and the person's «Remove» takes them all away.
    h.uiMessage({ type: "watch", id: "t" });
    const state = () => h.coreCalls.filter((c) => c.method === "ui.emit" && c.params.channel === "state").at(-1)?.params.payload as any;
    await until(() => state()?.traffic?.length === 1);
    expect(state().traffic[0]).toMatchObject({ rules: 1 });
    h.uiMessage({ type: "traffic.clear" });
    await until(() => state()?.traffic?.length === 0);
    expect(await ok("request_rule", { action: "list" })).toBe("You have no rules.");
    await reload();
    expect(await pageText()).toContain("Water 19 l: 1200");
  });

  it("changes what the browser sends and answers for a script, as approved rules", async () => {
    expect(await refused("request_change", { match: "/api/items", url: "http://other.example/", description: "x", request: { headers: { "X-Extra": "1" } } })).toContain("The page has changed");
    expect(await refused("request_change", { match: "/api/items", url: `${base}/app`, description: "x" })).toContain("Give `request`");
    await ok("request_change", { match: "/api/items", url: `${base}/app`, description: "Ask for page 2 with a mark", request: { headers: { "X-Extra": "from-agent" }, query: { page: "2" } } });
    seen.length = 0;
    await reload();
    expect(seen).toMatchObject([{ path: "/api/items", query: "?page=2", extra: "from-agent", auth: `Bearer ${TOKEN}` }]);

    await ok("request_change", { match: "/app.js", url: `${base}/app`, description: "Replace the page's script", response: { contentType: "text/javascript", body: "window.addEventListener('load', () => { made.textContent = 'agent script'; });" } });
    await reload();
    expect(await pageText()).toContain("agent script");
    await ok("request_rule", { action: "remove" });
  });

  it("never shows a secret, and forgets everything when the ability is turned off", async () => {
    for (const out of outputs) for (const s of SECRETS) expect(out.includes(s), `${s} in: ${out.slice(0, 300)}`).toBe(false);
    await setOn(false);
    expect(h.tools.has("request_send")).toBe(false);
    await setOn(true);
    expect(await ok("requests", { tab: "all" })).toContain("No requests recorded yet");
  });
});
