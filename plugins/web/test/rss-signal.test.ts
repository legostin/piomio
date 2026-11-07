// web.rss_item against a local feed server. Through the testkit: its declaration, and the first poll of a subscription
// as a baseline at the real interval (a setting cannot make it poll faster). Through the provider's factory, with a
// test interval: later polls emit the items not seen yet (key = the item's id), a feed that cannot be read emits
// nothing and is tried again, a poll emits at most 20, stop() ends it, each subscription keeps its own state, a feed
// of thousands of items emits only what is new, and a subscription made afresh starts from a new baseline.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { PluginContext } from "@piomio/plugin-sdk";
import { startPlugin, type PluginHarness } from "@piomio/testkit";
import { rssItemProvider, stateKey } from "../server/signals.ts";

const DIR = join(import.meta.dirname, "..");
const POLL_MS = 100;
const DAY = 86_400_000;

const item = (n: number) =>
  `<item><title>Post ${n}</title><link>https://steppe.example/p${n}</link><pubDate>${new Date(Date.UTC(2026, 9, 1) + n * 3_600_000).toUTCString()}</pubDate><description>About &lt;b&gt;${n}&lt;/b&gt;</description></item>`;
const rss = (ns: number[]) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Steppe</title>${ns.map(item).join("")}</channel></rss>`;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

let server: http.Server;
let base = "";
let body = rss([1, 2]);
let status = 200;
let hits = 0;

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  body = rss([1, 2]);
  status = 200;
  hits = 0;
  server = http.createServer((req, res) => {
    hits++;
    res.writeHead(status, { "content-type": "application/rss+xml" }).end(status === 200 ? body : "down");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  server.close();
});

/** The provider on a fake context: its storage and log, the signals it sent, with a test interval. */
function provider(o: { storage?: Map<string, unknown>; now?: () => number } = {}) {
  const storage = o.storage ?? new Map<string, unknown>();
  const logs: string[] = [];
  const ctx = {
    storage: {
      get: async (k: string) => structuredClone(storage.get(k)),
      set: async (k: string, v: unknown) => void storage.set(k, structuredClone(v)),
      delete: async (k: string) => void storage.delete(k),
      list: async (prefix = "") => [...storage].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })),
    },
    log: { warn: (...a: unknown[]) => logs.push(a.join(" ")), info() {}, debug() {}, error() {} },
  } as unknown as PluginContext;
  const p = rssItemProvider(ctx, () => ({ allowPrivate: true }), { pollMs: POLL_MS, ...(o.now ? { now: o.now } : {}) });
  const handles: Array<{ stop(): void }> = [];
  const signals: Array<{ sub: string; data: any; key?: string; subject?: string }> = [];
  let n = 0;
  return {
    storage,
    logs,
    signals,
    async subscribe(config: Record<string, unknown>) {
      const id = `sub_${++n}`;
      const h = await p.subscribe({ id, config }, (data, e) => void signals.push({ sub: id, data, ...e }));
      handles.push(h);
      return h;
    },
    stopAll: () => handles.forEach((h) => h.stop()),
  };
}

describe("web.rss_item", () => {
  let h: PluginHarness | undefined;
  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  it("is declared as a subscribe source with a config and a data schema", () => {
    const s = JSON.parse(readFileSync(join(DIR, ".piomio-plugin", "plugin.json"), "utf8")).contributes.signals[0];
    expect(s).toMatchObject({ type: "rss_item", mode: "subscribe", external: true });
    expect(s.config.properties.intervalMinutes.minimum).toBe(10);
  });

  it("in the plugin, takes the first poll as a baseline and polls no faster than its interval, whatever the settings say", async () => {
    // A setting an agent could change (hub_plugin_configure) once made it poll as fast as it liked.
    h = await startPlugin({ dir: DIR, settings: { allowPrivate: true, signalPollMs: 50 } });
    await h.subscribeSignal("rss_item", { url: `${base}/feed.xml`, intervalMinutes: 10 });
    await until(() => h!.storage.size === 1);
    expect(h.signals).toHaveLength(0);
    body = rss([1, 2, 3]);
    await sleep(400);
    expect(hits).toBe(1);
    expect(h.signals).toHaveLength(0);
    // The hub would not subscribe without an address.
    await expect(h.subscribeSignal("rss_item", { intervalMinutes: 10 })).rejects.toThrow(/url/);
  });

  it("takes the first poll as a baseline, then emits only new items, once each", async () => {
    const f = provider();
    await f.subscribe({ url: `${base}/feed.xml`, intervalMinutes: 10 });
    await until(() => f.storage.size === 1);
    expect(f.signals).toHaveLength(0);
    body = rss([1, 2, 3]);
    await until(() => f.signals.length === 1);
    expect(f.signals[0]).toMatchObject({
      key: "https://steppe.example/p3",
      subject: "Post 3",
      data: { feed: "Steppe", title: "Post 3", link: "https://steppe.example/p3", summary: "About 3", published: "2026-10-01T03:00:00.000Z" },
    });
    const before = hits;
    await until(() => hits >= before + 2);
    expect(f.signals).toHaveLength(1);
    f.stopAll();
  });

  it("emits nothing and tries again when the feed cannot be read", async () => {
    status = 500;
    const f = provider();
    await f.subscribe({ url: `${base}/feed.xml`, intervalMinutes: 10 });
    await until(() => hits >= 2);
    expect(f.signals).toHaveLength(0);
    expect(f.logs.join("\n")).toContain("HTTP 500");
    status = 200;
    await until(() => hits >= 4);
    // The feed's first successful read is the baseline.
    expect(f.signals).toHaveLength(0);
    body = rss([1, 2, 3]);
    await until(() => f.signals.length === 1);
    f.stopAll();
  });

  it("does not forget what it saw when a poll fails", async () => {
    const f = provider();
    await f.subscribe({ url: `${base}/feed.xml`, intervalMinutes: 10 });
    await until(() => f.storage.size === 1);
    status = 500;
    const n = hits;
    await until(() => hits >= n + 2);
    status = 200;
    await until(() => hits >= n + 4);
    expect(f.signals).toHaveLength(0);
    f.stopAll();
  });

  it("emits at most 20 items in one poll, the newest, oldest first", async () => {
    const f = provider();
    await f.subscribe({ url: `${base}/feed.xml`, intervalMinutes: 10 });
    await until(() => f.storage.size === 1);
    body = rss(range(100, 129));
    await until(() => f.signals.length >= 20);
    await sleep(3 * POLL_MS);
    expect(f.signals).toHaveLength(20);
    expect(f.signals[0].subject).toBe("Post 110");
    expect(f.signals[19].subject).toBe("Post 129");
    f.stopAll();
  });

  it("stops polling on stop()", async () => {
    const f = provider();
    const handle = await f.subscribe({ url: `${base}/feed.xml`, intervalMinutes: 10 });
    await until(() => hits >= 1);
    handle.stop();
    const n = hits;
    await sleep(2 * POLL_MS + 100);
    expect(hits).toBe(n);
  });

  it("keeps each subscription's own state: two configs of one feed both emit a new item", async () => {
    const f = provider();
    await f.subscribe({ url: `${base}/feed.xml`, intervalMinutes: 10 });
    await f.subscribe({ url: `${base}/feed.xml`, intervalMinutes: 20 });
    await until(() => f.storage.size === 2);
    body = rss([1, 2, 3]);
    await until(() => f.signals.length >= 2);
    await sleep(3 * POLL_MS);
    expect(f.signals.map((s) => [s.sub, s.key])).toEqual(
      expect.arrayContaining([
        ["sub_1", "https://steppe.example/p3"],
        ["sub_2", "https://steppe.example/p3"],
      ]),
    );
    expect(f.signals).toHaveLength(2);
    expect(stateKey({ url: "a", intervalMinutes: 10 })).toBe(stateKey({ intervalMinutes: 10, url: "a" }));
    f.stopAll();
  });

  it("emits only what is new from a feed of thousands of items, and never the old ones again", async () => {
    body = rss(range(1, 1500));
    const f = provider();
    await f.subscribe({ url: `${base}/feed.xml`, intervalMinutes: 10 });
    await until(() => f.storage.size === 1);
    body = rss(range(1, 1501));
    await until(() => f.signals.length >= 1);
    const n = hits;
    await until(() => hits >= n + 3);
    expect(f.signals.map((s) => s.subject)).toEqual(["Post 1501"]);
    expect((f.storage.values().next().value as { ids: string[] }).ids).toHaveLength(1000);
    f.stopAll();
  });

  it("starts a fresh subscription from a new baseline, and carries on one the plugin had just before (a restart)", async () => {
    const now = Date.now();
    const config = { url: `${base}/feed.xml`, intervalMinutes: 10 };
    body = rss([1, 2, 3]);
    // Read three days ago (nobody listened since): what came meanwhile is not sent.
    const stale = provider({ storage: new Map<string, unknown>([[stateKey(config), { ids: ["https://steppe.example/p1"], at: now - 3 * DAY }]]) });
    await stale.subscribe(config);
    await until(() => hits >= 3);
    expect(stale.signals).toHaveLength(0);
    stale.stopAll();
    // Read a minute ago (the plugin restarted): it goes on from there.
    const recent = provider({ storage: new Map<string, unknown>([[stateKey(config), { ids: ["https://steppe.example/p1"], at: now - 60_000 }]]) });
    await recent.subscribe(config);
    await until(() => recent.signals.length >= 2);
    expect(recent.signals.map((s) => s.subject)).toEqual(["Post 2", "Post 3"]);
    recent.stopAll();
  });

  it("forgets the state of feeds nobody read for 30 days", async () => {
    const now = Date.now();
    const storage = new Map<string, unknown>([
      ["rss_item:old", { ids: ["x"], at: now - 31 * DAY }],
      ["rss_item:recent", { ids: ["y"], at: now - DAY }],
      ["other", { keep: true }],
    ]);
    const f = provider({ storage });
    await f.subscribe({ url: `${base}/feed.xml`, intervalMinutes: 10 });
    await until(() => storage.size === 3 && !storage.has("rss_item:old"));
    expect([...storage.keys()].sort()).toEqual(["other", "rss_item:recent", stateKey({ url: `${base}/feed.xml`, intervalMinutes: 10 })].sort());
    f.stopAll();
  });
});
