// web.rss_item: a subscribe-mode signal source. While some trigger listens to a feed, the feed is read every
// `intervalMinutes` (at least 10) with the same code as web_rss; each item not seen before is emitted once, with the
// item's id as the signal's key. The first successful read of a feed is only a baseline. A feed that cannot be read
// emits nothing and is tried again at the next interval.

import { createHash } from "node:crypto";
import type { PluginContext, SignalProvider } from "@piomio/plugin-sdk";
import { guardedFetch, DEFAULT_USER_AGENT } from "./fetch.ts";
import { findFeeds, parseFeed, type FeedItem, type ParsedFeed } from "./rss.ts";

/** Items one poll emits at most (the newest); older new ones are marked seen without a signal. */
export const MAX_PER_POLL = 20;
export const MIN_INTERVAL_MINUTES = 10;
/** Ids remembered per feed. */
const SEEN_MAX = 1000;
const KEY_MAX = 200;

interface Seen {
  ids: string[];
}

export interface RssSettings {
  allowPrivate?: boolean;
  userAgent?: string;
  /** Tests only: the poll interval in milliseconds, instead of intervalMinutes. */
  signalPollMs?: number;
}

/** An item's identity: its link, else its title with its date. */
export function itemId(i: FeedItem): string {
  const id = i.url ?? `${i.title}|${i.date ?? ""}`;
  return id.length > KEY_MAX ? createHash("sha256").update(id).digest("hex") : id;
}

/** The feed at `url`, or the first feed a page there points to. Throws with the reason when it cannot be read. */
async function readFeed(url: string, s: RssSettings): Promise<ParsedFeed> {
  const opts = { allowPrivate: !!s.allowPrivate, userAgent: s.userAgent || DEFAULT_USER_AGENT };
  let page = await guardedFetch(url, opts);
  if (page.status >= 400) throw new Error(`HTTP ${page.status} ${page.statusText} at ${page.url}`.trim());
  let feed = parseFeed(page.text, page.url);
  if (!feed) {
    const found = findFeeds(page.text, page.url);
    if (!found.length) throw new Error(`no RSS or Atom feed at ${page.url}`);
    page = await guardedFetch(found[0].url, opts);
    if (page.status >= 400) throw new Error(`HTTP ${page.status} ${page.statusText} at ${page.url}`.trim());
    feed = parseFeed(page.text, page.url);
    if (!feed) throw new Error(`${found[0].url} is not a feed that can be read`);
  }
  return feed;
}

/** Newest first: by date when the feed dates its items, else in the feed's own order. */
function newestFirst(items: FeedItem[]): FeedItem[] {
  const dated = items.some((i) => i.date);
  return items
    .map((item, n) => ({ item, n }))
    .sort((a, b) => (dated ? (b.item.date ?? "").localeCompare(a.item.date ?? "") : 0) || a.n - b.n)
    .map((x) => x.item);
}

export function rssItemProvider(ctx: PluginContext, settings: () => RssSettings): SignalProvider {
  return {
    subscribe(sub, emit) {
      const url = String(sub.config.url ?? "").trim();
      if (!url) throw new Error("rss_item: config.url is required");
      const minutes = Math.max(MIN_INTERVAL_MINUTES, Number(sub.config.intervalMinutes) || 60);
      const storageKey = `rss_item:${createHash("sha256").update(url).digest("hex").slice(0, 32)}`;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const poll = async () => {
        let feed: ParsedFeed;
        try {
          feed = await readFeed(url, settings());
        } catch (e) {
          ctx.log.warn(`rss_item: ${url} could not be read, trying again later: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        if (stopped) return;
        const known = await ctx.storage.get<Seen>(storageKey);
        const items = newestFirst(feed.items);
        const ids = new Set(known?.ids ?? []);
        const fresh = known ? items.filter((i) => !ids.has(itemId(i))) : [];
        // Newest items first in `ids`, so the cap drops the oldest.
        const remembered = [...items.map(itemId), ...(known?.ids ?? [])].filter((id, n, all) => all.indexOf(id) === n).slice(0, SEEN_MAX);
        await ctx.storage.set(storageKey, { ids: remembered } satisfies Seen);
        for (const i of fresh.slice(0, MAX_PER_POLL).reverse()) {
          if (stopped) return;
          emit(
            {
              ...(feed.title ? { feed: feed.title } : {}),
              title: i.title,
              ...(i.url ? { link: i.url } : {}),
              ...(i.date ? { published: i.date } : {}),
              ...(i.summary ? { summary: i.summary } : {}),
            },
            { key: itemId(i), subject: i.title },
          );
        }
      };

      const loop = async () => {
        try {
          await poll();
        } catch (e) {
          ctx.log.warn(`rss_item: ${url}: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (stopped) return;
        timer = setTimeout(loop, settings().signalPollMs ?? minutes * 60_000);
      };

      // The first poll (the baseline) runs on its own: the hub's subscribe does not wait for the network.
      timer = setTimeout(loop, 0);
      return {
        stop() {
          stopped = true;
          if (timer) clearTimeout(timer);
        },
      };
    },
  };
}
