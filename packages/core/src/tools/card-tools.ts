// show_cards: options an agent found (places, products, apps, plans) as cards in the chat: a slider the person swipes,
// each card opening its position full screen, drawn by the app from what the agent gave, or a page the agent made.
import type { CardItem, ImageItem, MessagePart, PageView, ToolDescriptor, ToolResult } from "@piomio/shared";
import type { ToolRegistry } from "./registry.ts";
import { clip, imageSource } from "./core-tools.ts";

export interface CardToolDeps {
  registry: ToolRegistry;
  /** A page by its id or title (Pages.find): a position may open one. */
  page: (key: string) => PageView | undefined;
  /** Add a card to the reply the agent is writing (SessionRunner.attachPart). */
  attachPart: (conversationId: string, part: MessagePart) => void;
  /** For the person: here, and from a task also in the dialog that started it (SessionRunner.showToPerson). */
  showToPerson?: (conversationId: string, part: MessagePart, taskId?: string) => void;
  /** The folders of the tasks a conversation started (SessionRunner.startedWorkspaces). */
  startedWorkspaces?: (conversationId: string) => string[];
  /** <dataDir>/workspaces: `file:` image sources are relative to it. */
  workspacesRoot: string;
}

export const MAX_CARDS = 12;
const MAX_CARD_IMAGES = 8;
const MAX_TEXT = 4000;

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

const web = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  if (!/^https?:\/\/\S+$/i.test(s)) return undefined;
  try {
    return new URL(s).href;
  } catch {
    return undefined;
  }
};

/** Markdown keeps its lines. */
const prose = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : "";
  return s ? (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s) : undefined;
};

const lines = (v: unknown, max: number, chars: number): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).flatMap((x) => clip(x, chars) ?? []).slice(0, max);

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function registerCardTools(d: CardToolDeps): void {
  const spec: Omit<ToolDescriptor, "owner"> = {
    name: "show_cards",
    description:
      "Show the user options as cards in the chat: places to go, products, apps, plans, anything they pick from or look through. Two or more are a " +
      "swipeable slider; a tap opens the position full screen with everything you gave it: photos, why it fits, the description, specs, pros and cons, " +
      "the address with a map and a route, links. Give each what you know (only `title` is required), real pictures when you have them, and the same " +
      "fields across the cards so they compare. Its page has a \"Choose\" button: the tap comes back as the user's message with the title (pick: false " +
      "when there is nothing to choose). When a position needs more than this (a comparison table, a day plan, something interactive), make a page with " +
      "page_create and pass it as `page`: the card opens it instead. When your reply also goes to the user's phone (Telegram), cards with a picture go " +
      "there as captioned photos. Do not repeat the cards as text; write only what ties them together, in the user's language like the cards.",
    effect: "read",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Above the cards, e.g. “Italian places nearby” (≤ 80 chars)" },
        pick: { type: "boolean", description: "The \"Choose\" button on a position's page (default true)" },
        items: {
          type: "array",
          minItems: 1,
          maxItems: MAX_CARDS,
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "The name (≤ 120 chars)" },
              subtitle: { type: "string", description: "A line under it: what it is, the district, the maker" },
              images: {
                type: "array",
                maxItems: MAX_CARD_IMAGES,
                description: "Its pictures, the first on the card: each a public http(s) `url` or a `path` in your workspace",
                items: { type: "object", properties: { url: { type: "string" }, path: { type: "string" }, caption: { type: "string" } } },
              },
              price: { type: "string", description: "As the user reads it: “12 000 ₸”, “from $9 a month”, “Free”" },
              rating: { type: "number", description: "0–5" },
              badge: { type: "string", description: "A short mark on the picture: “Best pick”, “Cheapest” (≤ 30 chars)" },
              tags: { type: "array", items: { type: "string" }, description: "A few short words: the cuisine, the platform, the kind" },
              why: { type: "string", description: "Why it fits this user: a line or two, shown highlighted" },
              text: { type: "string", description: "The description on its page, Markdown" },
              specs: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["label", "value"] }, description: "Facts as label and value" },
              pros: { type: "array", items: { type: "string" } },
              cons: { type: "array", items: { type: "string" } },
              address: { type: "string" },
              hours: { type: "string", description: "Opening hours" },
              lat: { type: "number", description: "With lon: a map and a route on its page" },
              lon: { type: "number" },
              links: { type: "array", items: { type: "object", properties: { label: { type: "string" }, url: { type: "string" } }, required: ["url"] }, description: "Its site, where to buy or book" },
              page: { type: "string", description: "A page you made for it (its id or title): the card opens that page instead" },
            },
            required: ["title"],
          },
        },
      },
      required: ["items"],
    },
  };

  d.registry.register({ ...spec, owner: "core" }, async (input: any, ctx: any) => {
    const i = input ?? {};
    const list: unknown[] = Array.isArray(i.items) ? i.items : [];
    if (!list.length) return text("Give items: [{title, …}, …].", true);
    if (list.length > MAX_CARDS) return text(`At most ${MAX_CARDS} cards at once: show the best ones.`, true);
    const more = d.startedWorkspaces?.(ctx.conversationId) ?? [];
    const items: CardItem[] = [];
    const problems: string[] = [];
    for (const [n, raw] of list.entries()) {
      const x = obj(raw);
      const title = clip(x.title ?? x.name, 120);
      const label = `card ${n + 1}${title ? ` (${title})` : ""}`;
      if (!title) {
        problems.push(`${label}: give a title`);
        continue;
      }
      const it: CardItem = { title };

      // `image` (one address or path) is what models reach for first.
      const shots: unknown[] = Array.isArray(x.images) ? x.images : x.image ? [x.image] : [];
      const images: ImageItem[] = [];
      for (const shot of shots.slice(0, MAX_CARD_IMAGES)) {
        const s = typeof shot === "string" ? (/^https?:\/\//i.test(shot.trim()) ? { url: shot } : { path: shot }) : obj(shot);
        const src = await imageSource(s, ctx, d, more);
        if (typeof src !== "string") problems.push(`${label}, a picture: ${src.error}`);
        else images.push({ src, ...(clip(s.caption, 200) ? { caption: clip(s.caption, 200) } : {}) });
      }
      if (images.length) it.images = images;

      const subtitle = clip(x.subtitle, 120);
      if (subtitle) it.subtitle = subtitle;
      const price = clip(x.price, 60);
      if (price) it.price = price;
      if (x.rating !== undefined && x.rating !== null && x.rating !== "") {
        const r = typeof x.rating === "string" ? Number(x.rating.replace(",", ".")) : x.rating;
        if (typeof r !== "number" || !Number.isFinite(r) || r < 0 || r > 5) problems.push(`${label}: rating is a number from 0 to 5`);
        else it.rating = Math.round(r * 10) / 10;
      }
      const badge = clip(x.badge, 30);
      if (badge) it.badge = badge;
      const tags = lines(x.tags, 6, 30);
      if (tags.length) it.tags = tags;
      const why = clip(x.why, 300);
      if (why) it.why = why;
      const body = prose(x.text ?? x.description);
      if (body) it.text = body;
      const specs = (Array.isArray(x.specs) ? x.specs : []).flatMap((s) => {
        const [k, v] = [clip(obj(s).label, 60), clip(obj(s).value, 200)];
        return k && v ? [{ label: k, value: v }] : [];
      });
      if (specs.length) it.specs = specs.slice(0, 20);
      const pros = lines(x.pros, 8, 200);
      if (pros.length) it.pros = pros;
      const cons = lines(x.cons, 8, 200);
      if (cons.length) it.cons = cons;
      const address = clip(x.address, 200);
      if (address) it.address = address;
      const hours = clip(x.hours, 120);
      if (hours) it.hours = hours;

      if (x.lat !== undefined || x.lon !== undefined) {
        const [lat, lon] = [Number(x.lat), Number(x.lon)];
        if (x.lat === undefined || x.lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          problems.push(`${label}: lat (−90…90) and lon (−180…180) go together`);
        } else {
          it.lat = lat;
          it.lon = lon;
        }
      }

      // `url` (one address) reads as its only link.
      const links: NonNullable<CardItem["links"]> = [];
      for (const l of Array.isArray(x.links) ? x.links : x.url ? [x.url] : []) {
        const url = web(typeof l === "string" ? l : obj(l).url);
        if (!url) problems.push(`${label}: a link's url must be an http(s) address`);
        else links.push({ url, ...(clip(obj(l).label, 40) ? { label: clip(obj(l).label, 40) } : {}) });
      }
      if (links.length) it.links = links.slice(0, 5);

      if (typeof x.page === "string" && x.page.trim()) {
        const page = d.page(x.page.trim());
        if (!page) problems.push(`${label}: no page "${x.page}" (see page_list)`);
        else it.pageId = page.id;
      }
      items.push(it);
    }
    if (problems.length) return text(`Nothing shown. ${problems.join("; ")}.`, true);

    const title = clip(i.title, 80);
    const pick = i.pick !== false;
    const part: MessagePart = { type: "cards", ...(title ? { title } : {}), items, ...(pick ? {} : { pick: false }) };
    if (d.showToPerson) d.showToPerson(ctx.conversationId, part, ctx.taskId);
    else d.attachPart(ctx.conversationId, part);
    return text(
      `The user now sees ${items.length === 1 ? "the card" : `a slider of ${items.length} cards`} in the chat; each opens its own page. ` +
        (pick ? "Their choice comes back as their message with the position's title. " : "") +
        "Do not list the positions again as text.",
    );
  });
}
