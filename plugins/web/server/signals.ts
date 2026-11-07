// web.rss_item: a subscribe-mode signal source. While some trigger listens to a feed, the feed is read every
// `intervalMinutes` (at least 10) with the same code as web_rss; each item not seen before is emitted once, with the
// item's id as the signal's key. Each subscription (a feed with its config) keeps what it saw in ctx.storage. Its first
// successful read is only a baseline, unless it read the feed just before (the plugin or the hub restarted): then it
// goes on from there. What is kept of a feed nobody read for 30 days is forgotten. A feed that cannot be read emits
// nothing and is tried again at the next interval.

import { createHash } from "node:crypto";
import type { PluginContext, SignalProvider } from "@piomio/plugin-sdk";
import { guardedFetch, DEFAULT_USER_AGENT } from "./fetch.ts";
import { findFeeds, parseFeed, type FeedItem, type ParsedFeed } from "./rss.ts";

/** Items one poll emits at most (the newest); older new ones are marked seen without a signal. */
export const MAX_PER_POLL = 20;
export const MIN_INTERVAL_MINUTES = 10;
/** Items of a feed looked at, and ids remembered, per subscription: the newest. Older items are neither new nor kept. */
const SEEN_MAX = 1000;
const KEY_MAX = 200;
const PREFIX = "rss_item:";
const DAY_MS = 86_400_000;
/** What is kept of a feed nobody read for this long is forgotten. */
const FORGET_MS = 30 * DAY_MS;
/** State read longer ago than this (twice the interval, and some) is from an earlier subscription: a new baseline. */
const restartSlack = (intervalMs: number) => 2 * intervalMs + 10 * 60_000;

/** What a subscription saw: the ids of the newest items, newest first, and when it last read the feed (ms). */
interface Seen {
  ids: string[];
  at: number;
}

export interface RssSettings {
  allowPrivate?: boolean;
  userAgent?: string;
}

/** Only for tests, through the factory (never a setting: an agent can change those). */
export interface RssProviderOptions {
  /** The poll interval in milliseconds, instead of intervalMinutes. */
  pollMs?: number;
  now?: () => number;
}

/** An item's identity: its link, else its title with its date. */
export function itemId(i: FeedItem): string {
  const id = i.url ?? `${i.title}|${i.date ?? ""}`;
  return id.length > KEY_MAX ? createHash("sha256").update(id).digest("hex") : id;
}

/** A value as JSON with every object's keys sorted: two configs that say the same thing are the same text. */
function canonicalJson(v: unknown): string {
  return (
    JSON.stringify(v, (_k, x: unknown) =>
      x && typeof x === "object" && !Array.isArray(x)
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, (x as Record<string, unknown>)[k]]),
          )
        : x,
    ) ?? "null"
  );
}

/** Where a subscription keeps what it saw: by its whole config, so two configs of one feed never share it. */
export function stateKey(config: Record<string, unknown>): string {
  return `${PREFIX}${createHash("sha256").update(canonicalJson(config)).digest("hex").slice(0, 32)}`;
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

/** Forgets what is kept of feeds nobody read for 30 days (and state of an older shape). */
async function forgetOld(ctx: PluginContext, now: number): Promise<void> {
  for (const { key, value } of await ctx.storage.list(PREFIX)) {
    const at = (value as Partial<Seen> | null)?.at;
    if (typeof at !== "number" || now - at > FORGET_MS) await ctx.storage.delete(key);
  }
}

export function rssItemProvider(ctx: PluginContext, settings: () => RssSettings, o: RssProviderOptions = {}): SignalProvider {
  const now = o.now ?? Date.now;
  return {
    subscribe(sub, emit) {
      const url = String(sub.config.url ?? "").trim();
      if (!url) throw new Error("rss_item: config.url is required");
      const minutes = Math.max(MIN_INTERVAL_MINUTES, Number(sub.config.intervalMinutes) || 60);
      const intervalMs = o.pollMs ?? minutes * 60_000;
      const storageKey = stateKey(sub.config);
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      /** This subscription read the feed once already: what is kept is its own. */
      let baselined = false;

      const poll = async () => {
        let feed: ParsedFeed;
        try {
          feed = await readFeed(url, settings());
        } catch (e) {
          ctx.log.warn(`rss_item: ${url} could not be read, trying again later: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        if (stopped) return;
        const stored = await ctx.storage.get<Seen>(storageKey);
        // A first read is a baseline, unless the state is this subscription's own from just before (a restart).
        const known = baselined || (stored && typeof stored.at === "number" && now() - stored.at <= restartSlack(intervalMs)) ? stored : undefined;
        baselined = true;
        // Only the newest SEEN_MAX items count: an older one is neither new nor remembered, so it never comes back as new.
        const items = newestFirst(feed.items).slice(0, SEEN_MAX);
        const ids = items.map(itemId);
        const had = new Set(known?.ids ?? []);
        const fresh = known ? items.filter((_, n) => !had.has(ids[n])) : [];
        // Newest items first, so the cap drops the oldest.
        const remembered = [...new Set([...ids, ...(known?.ids ?? [])])].slice(0, SEEN_MAX);
        await ctx.storage.set(storageKey, { ids: remembered, at: now() } satisfies Seen);
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
        timer = setTimeout(loop, intervalMs);
      };

      // The first poll (the baseline) runs on its own: the hub's subscribe does not wait for the network.
      timer = setTimeout(() => {
        void forgetOld(ctx, now())
          .catch((e) => ctx.log.warn(`rss_item: could not forget old feeds: ${e instanceof Error ? e.message : String(e)}`))
          .then(() => (stopped ? undefined : loop()));
      }, 0);
      return {
        stop() {
          stopped = true;
          if (timer) clearTimeout(timer);
        },
      };
    },
  };
}
