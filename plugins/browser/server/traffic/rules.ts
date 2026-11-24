// What agents do to the traffic of their own tab: block requests, answer them, patch what the server answered, and
// (approved by the person on a card) change what the browser sends. A rule lives on one tab for a while and is gone
// with it. Interception is on only while a tab has a rule: it turns Chrome's HTTP cache off there.

import type { Page, Request, Route } from "playwright";
import { type TrafficLog, maskRe, maskTarget } from "./log.ts";

/** Requests whose answers are data to the page. Pages, scripts, styles and workers are code: a card. */
export const DATA_TYPES = new Set(["xhr", "fetch", "eventsource", "image", "media", "font", "texttrack"]);
/** Content a free rule may not answer with: the page would run it. */
const CODE_TYPE = /html|javascript|ecmascript|wasm|xml|svg/i;

export const RULE_MINUTES = 30;
export const RULE_MAX_MINUTES = 240;
const MAX_RULES_PER_AGENT = 20;

export interface Respond {
  status: number;
  contentType: string;
  body: string;
  headers?: Record<string, string>;
}

/** Changes to what the browser sends. */
export interface RequestChange {
  headers?: Record<string, string>;
  removeHeaders?: string[];
  /** Query parameters to set; null removes one. */
  query?: Record<string, string | null>;
  body?: string;
  /** Path → value in the JSON body. */
  set?: Record<string, unknown>;
  /** Send it to this address instead. */
  url?: string;
}

export interface RuleSpec {
  match: string;
  method?: string;
  kind: "block" | "respond" | "patch" | "change";
  respond?: Respond;
  /** Path → value in the real response's JSON. */
  patch?: Record<string, unknown>;
  request?: RequestChange;
  /** The person approved it on a card: it may answer for pages and scripts too. */
  approved?: boolean;
  description?: string;
  minutes?: number;
}

export interface Rule extends RuleSpec {
  id: number;
  agentId: string;
  page: Page;
  tab: string;
  re: RegExp;
  until: number;
  hits: number;
  /** Matching requests left alone because a free rule may not answer for them (a page, a script). */
  skipped: number;
}

/** Every string inside a JSON value. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) strings(x, strings(k, out));
  return out;
}

/**
 * Sites other than the page's own that a made-up answer points it at («https://…», «//…»). A page loads what its data
 * names (a picture, a link, a next call), so an answer of the agent's that names another site is an address the agent
 * sends the browser to: not a free rule's to do.
 */
export function foreignHosts(texts: string[], pageUrl: string): string[] {
  let site = "";
  try {
    site = new URL(pageUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    /* no page: every address is another site's */
  }
  const all: string[] = [];
  for (const t of texts) {
    all.push(t.replace(/\\\//g, "/"));
    try {
      strings(JSON.parse(t), all);
    } catch {
      /* not JSON: the text itself */
    }
  }
  const found = new Set<string>();
  for (const t of all) {
    for (const m of t.matchAll(/(?:\bhttps?:|\bwss?:|(?<![:\w]))\/\/(?:[^\s/?#"'<>@]*@)?([a-z0-9][a-z0-9.-]*\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]|localhost)/gi)) {
      const host = m[1].toLowerCase().replace(/^www\./, "");
      if (!site || (host !== site && !host.endsWith(`.${site}`) && !site.endsWith(`.${host}`))) found.add(host);
    }
  }
  return [...found];
}

/** Set `value` at a dotted path («data.items.0.price»), making objects on the way. */
export function setPath(root: unknown, path: string, value: unknown): void {
  const keys = path.split(".").filter(Boolean);
  if (!keys.length || root === null || typeof root !== "object") return;
  let at = root as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = at[keys[i]];
    if (next === null || typeof next !== "object") at[keys[i]] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    at = at[keys[i]] as Record<string, unknown>;
  }
  at[keys[keys.length - 1]] = value;
}

/** A rule in one line, for the agent and the live view. */
export function ruleLine(r: Rule, now = Date.now()): string {
  const what =
    r.kind === "block"
      ? "block"
      : r.kind === "respond"
        ? `answer ${r.respond!.status} ${r.respond!.contentType} (${r.respond!.body.length} characters)`
        : r.kind === "patch"
          ? `patch the response: ${Object.keys(r.patch ?? {}).join(", ")}`
          : `change the request: ${describeChange(r.request ?? {})}`;
  const left = Math.max(1, Math.round((r.until - now) / 60_000));
  return `rule ${r.id}: ${r.method ? `${r.method} ` : ""}${r.match} → ${what}; tab ${r.tab}, ${r.hits} hit${r.hits === 1 ? "" : "s"}${r.skipped ? `, ${r.skipped} left alone (pages and scripts need browser_request_change)` : ""}, ${left} min left`;
}

export function describeChange(c: RequestChange): string {
  return [
    c.url ? `send to ${c.url}` : "",
    c.headers ? `set headers ${Object.keys(c.headers).join(", ")}` : "",
    c.removeHeaders?.length ? `remove headers ${c.removeHeaders.join(", ")}` : "",
    c.query ? `query ${Object.keys(c.query).join(", ")}` : "",
    c.body !== undefined ? "replace the body" : "",
    c.set ? `body fields ${Object.keys(c.set).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export class TrafficRules {
  private rules: Rule[] = [];
  private seq = 0;
  private routed = new Map<Page, (route: Route, request: Request) => Promise<void>>();
  private log: TrafficLog;
  private changed: () => void;

  constructor(log: TrafficLog, changed: () => void = () => {}) {
    this.log = log;
    this.changed = changed;
  }

  async add(page: Page, tab: string, agentId: string, spec: RuleSpec): Promise<Rule> {
    this.expire();
    if (this.rules.filter((r) => r.agentId === agentId).length >= MAX_RULES_PER_AGENT) throw new Error(`There are ${MAX_RULES_PER_AGENT} rules already: remove some first (action: "remove").`);
    const minutes = Math.min(RULE_MAX_MINUTES, Math.max(1, Math.round(spec.minutes ?? RULE_MINUTES)));
    const rule: Rule = { ...spec, id: ++this.seq, agentId, page, tab, re: maskRe(spec.match), until: Date.now() + minutes * 60_000, hits: 0, skipped: 0 };
    this.rules.push(rule);
    if (!this.routed.has(page)) {
      const handler = (route: Route, request: Request) => this.handle(page, route, request);
      this.routed.set(page, handler);
      page.once("close", () => this.closed(page));
      await page.route("**/*", handler);
    }
    this.changed();
    return rule;
  }

  /** An agent's rules (all of them for the person). */
  list(agentId?: string): Rule[] {
    this.expire();
    return this.rules.filter((r) => !agentId || r.agentId === agentId);
  }

  /** Remove one rule of the agent's, or all of them; with no agent, everyone's (the person's «Remove»). */
  async remove(agentId: string | undefined, id?: number): Promise<number> {
    const gone = this.rules.filter((r) => (!agentId || r.agentId === agentId) && (id === undefined || r.id === id));
    this.rules = this.rules.filter((r) => !gone.includes(r));
    await this.unrouteIdle();
    if (gone.length) this.changed();
    return gone.length;
  }

  /** The browser closed: its tabs and their rules are gone. */
  reset(): void {
    const had = this.rules.length;
    this.rules = [];
    this.routed.clear();
    if (had) this.changed();
  }

  /** For the live view: who changes the traffic of which tab. */
  summary(): Array<{ agentId: string; tab: string; rules: number }> {
    this.expire();
    const by = new Map<string, { agentId: string; tab: string; rules: number }>();
    for (const r of this.rules) {
      const key = `${r.agentId}\n${r.tab}`;
      by.set(key, { agentId: r.agentId, tab: r.tab, rules: (by.get(key)?.rules ?? 0) + 1 });
    }
    return [...by.values()];
  }

  private closed(page: Page): void {
    this.routed.delete(page);
    const had = this.rules.length;
    this.rules = this.rules.filter((r) => r.page !== page);
    if (had !== this.rules.length) this.changed();
  }

  private expire(): void {
    const now = Date.now();
    if (!this.rules.some((r) => r.until <= now)) return;
    this.rules = this.rules.filter((r) => r.until > now);
    void this.unrouteIdle();
    this.changed();
  }

  private async unrouteIdle(): Promise<void> {
    for (const [page, handler] of this.routed) {
      if (this.rules.some((r) => r.page === page)) continue;
      this.routed.delete(page);
      if (!page.isClosed()) await page.unroute("**/*", handler).catch(() => {});
    }
  }

  private note(request: Request, text: string): void {
    const set = () => {
      const e = this.log.entryOf(request);
      if (e) e.note = text;
      return !!e;
    };
    // The log may hear of the request a moment after the route does.
    if (!set()) setTimeout(set, 100);
  }

  private async handle(page: Page, route: Route, request: Request): Promise<void> {
    this.expire();
    const target = maskTarget(request.url());
    const method = request.method();
    // The newest matching rule answers.
    const rule = this.rules.findLast((r) => r.page === page && (!r.method || r.method === method) && r.re.test(target));
    try {
      if (!rule) return await route.fallback();
      if (rule.kind === "block") {
        rule.hits++;
        this.note(request, `blocked by rule ${rule.id}`);
        return await route.abort("blockedbyclient");
      }
      if (rule.kind === "change") {
        rule.hits++;
        this.note(request, `changed by rule ${rule.id}`);
        return await route.continue(await overrides(request, rule.request ?? {}));
      }
      // Answering for a page or a script is code of the agent's on the site: only a rule the person approved.
      const type = request.resourceType();
      if (!rule.approved && !DATA_TYPES.has(type)) {
        rule.skipped++;
        return await route.fallback();
      }
      if (rule.kind === "respond") {
        const r = rule.respond!;
        rule.hits++;
        this.note(request, `answered by rule ${rule.id}`);
        return await route.fulfill({ status: r.status, contentType: r.contentType, body: r.body, headers: { ...(await corsHeaders(request)), ...r.headers } });
      }
      // patch: the real answer with some of its JSON replaced.
      const res = await route.fetch();
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        rule.skipped++;
        return await route.fulfill({ response: res });
      }
      if (!rule.approved && CODE_TYPE.test(res.headers()["content-type"] ?? "")) {
        rule.skipped++;
        return await route.fulfill({ response: res });
      }
      for (const [path, value] of Object.entries(rule.patch ?? {})) setPath(json, path, value);
      rule.hits++;
      this.note(request, `patched by rule ${rule.id}`);
      return await route.fulfill({ response: res, json });
    } catch {
      // The tab went away, or the request was already handled: nothing to answer.
      await route.fallback().catch(() => {});
    }
  }
}

/** A made-up answer to another site's script needs that site's leave to be read (CORS), as the real one had. */
async function corsHeaders(request: Request): Promise<Record<string, string>> {
  const origin = await request.headerValue("origin").catch(() => null);
  return origin ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true" } : {};
}

/** What route.continue takes for a change. */
async function overrides(request: Request, c: RequestChange): Promise<{ url?: string; headers?: Record<string, string>; postData?: string }> {
  const out: { url?: string; headers?: Record<string, string>; postData?: string } = {};
  if (c.url || c.query) {
    const u = new URL(c.url ?? request.url());
    // A new address keeps the query the page sent, unless it brings its own.
    if (c.url && !u.search) u.search = new URL(request.url()).search;
    for (const [k, v] of Object.entries(c.query ?? {})) {
      if (v === null) u.searchParams.delete(k);
      else u.searchParams.set(k, v);
    }
    out.url = u.href;
  }
  if (c.headers || c.removeHeaders?.length) {
    const headers = await request.allHeaders();
    for (const name of c.removeHeaders ?? []) delete headers[name.toLowerCase()];
    for (const [k, v] of Object.entries(c.headers ?? {})) headers[k.toLowerCase()] = v;
    out.headers = headers;
  }
  if (c.body !== undefined) out.postData = c.body;
  else if (c.set) {
    try {
      const json = JSON.parse(request.postData() ?? "{}");
      for (const [path, value] of Object.entries(c.set)) setPath(json, path, value);
      out.postData = JSON.stringify(json);
    } catch {
      /* the body is not JSON: sent as it was */
    }
  }
  return out;
}

export { CODE_TYPE };
