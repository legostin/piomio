// web.rss_item against a local feed server: the first poll is a baseline, later polls emit the items not seen yet (key =
// the item's id), a feed that cannot be read emits nothing and is tried again, a poll emits at most 20, stop() ends it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { startPlugin, type PluginHarness } from "@piomio/testkit";

const DIR = join(import.meta.dirname, "..");

const item = (n: number) =>
  `<item><title>Post ${n}</title><link>https://steppe.example/p${n}</link><pubDate>${new Date(Date.UTC(2026, 9, 1) + n * 3_600_000).toUTCString()}</pubDate><description>About &lt;b&gt;${n}&lt;/b&gt;</description></item>`;
const rss = (ns: number[]) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Steppe</title>${ns.map(item).join("")}</channel></rss>`;

let server: http.Server;
let base = "";
let body = rss([1, 2]);
let status = 200;
let hits = 0;
let h: PluginHarness;

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

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
  // signalPollMs is a test-only override of the interval.
  h = await startPlugin({ dir: DIR, settings: { allowPrivate: true, signalPollMs: 100 } });
});

afterEach(async () => {
  await h?.stop();
  server.close();
});

describe("web.rss_item", () => {
  it("is declared as a subscribe source with a config and a data schema", () => {
    const s = JSON.parse(readFileSync(join(DIR, ".piomio-plugin", "plugin.json"), "utf8")).contributes.signals[0];
    expect(s).toMatchObject({ type: "rss_item", mode: "subscribe", external: true });
    expect(s.config.properties.intervalMinutes.minimum).toBe(10);
  });

  it("takes the first poll as a baseline, then emits only new items, once each", async () => {
    const id = await h.subscribeSignal("rss_item", { url: `${base}/feed.xml`, intervalMinutes: 10 });
    await until(() => h.storage.size === 1);
    expect(h.signals).toHaveLength(0);
    body = rss([1, 2, 3]);
    await until(() => h.signals.length === 1);
    expect(h.signals[0]).toMatchObject({
      type: "rss_item",
      key: "https://steppe.example/p3",
      subject: "Post 3",
      data: { feed: "Steppe", title: "Post 3", link: "https://steppe.example/p3", summary: "About 3" },
    });
    expect((h.signals[0] as any).data.published).toBe("2026-10-01T03:00:00.000Z");
    const before = hits;
    await until(() => hits >= before + 2);
    expect(h.signals).toHaveLength(1);
    await h.stopSignal(id);
  });

  it("emits nothing and tries again when the feed cannot be read", async () => {
    status = 500;
    await h.subscribeSignal("rss_item", { url: `${base}/feed.xml`, intervalMinutes: 10 });
    await until(() => hits >= 2);
    expect(h.signals).toHaveLength(0);
    expect(h.logs.join("\n")).toContain("HTTP 500");
    status = 200;
    await until(() => hits >= 4);
    // The feed's first successful read is the baseline.
    expect(h.signals).toHaveLength(0);
    body = rss([1, 2, 3]);
    await until(() => h.signals.length === 1);
  });

  it("does not forget what it saw when a poll fails", async () => {
    await h.subscribeSignal("rss_item", { url: `${base}/feed.xml`, intervalMinutes: 10 });
    await until(() => h.storage.size === 1);
    status = 500;
    const n = hits;
    await until(() => hits >= n + 2);
    status = 200;
    await until(() => hits >= n + 4);
    expect(h.signals).toHaveLength(0);
  });

  it("emits at most 20 items in one poll, the newest, oldest first", async () => {
    await h.subscribeSignal("rss_item", { url: `${base}/feed.xml`, intervalMinutes: 10 });
    await until(() => h.storage.size === 1);
    body = rss(Array.from({ length: 30 }, (_, i) => 100 + i));
    await until(() => h.signals.length >= 20);
    await new Promise((r) => setTimeout(r, 350));
    expect(h.signals).toHaveLength(20);
    expect(h.signals[0].subject).toBe("Post 110");
    expect(h.signals[19].subject).toBe("Post 129");
  });

  it("stops polling on stop()", async () => {
    const id = await h.subscribeSignal("rss_item", { url: `${base}/feed.xml`, intervalMinutes: 10 });
    await h.stopSignal(id);
    const n = hits;
    await new Promise((r) => setTimeout(r, 400));
    expect(hits).toBe(n);
  });
});
