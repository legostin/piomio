# Browser traffic for agents

The person, 2026-11-23: "ещё дать агенту доступ к трафику всему этого браузера, чтоб он мог видеть запросы, записывать
их, перехватывать и изменять, в виде плагина". The second piece after scripts for taught skills
(`2026-11-23-skill-scripts-design.md`), in its own PR on top of that one.

## What the code does today

- One Chrome for all agents and the person, started by the browser plugin in its own process
  (`plugins/browser/server/manager.ts`, Playwright's persistent context, through the hub's egress proxy). Each agent
  keeps to its own tab.
- Agents see a page as its elements and text. What the page asks its server and gets back is invisible to them, so a
  price list an app loads as JSON is scraped off the screen.
- Agents cannot run JavaScript of their own in a page. Clicks with consequences go through `browser_submit` (a
  pre-approved rule of a taught skill, the person's words, or a card).
- Plugins are separate processes and cannot call one another.

## Decided (the person's answers, 2026-11-23)

- An ability of its own in the Plugins catalog, **off by default**.
- **Seeing and recording requests, blocking them and replacing responses is the agent's to do.** Changing an outgoing
  request, or sending one of its own that is not a GET, is an action with consequences: a card, or a rule the person
  approved ahead of time for a taught skill.
- **Cookies, tokens and passwords never reach the model.**
- Refined when the design was shown, and approved: replacing a *page* (HTML) or a *script* is code of the agent's
  running on the site as the person, past the click guard. It is an action with consequences too. Replacing data
  (JSON, text, pictures) stays free.

## Design

### Where it lives

- **The catalog card** is a plugin of its own, `plugins/browser-traffic`: a manifest with `defaultEnabled: false`,
  its translations and its `offer`. It has no server.
- **The engine** is in the browser plugin (`plugins/browser/server/traffic/`), where the Playwright context is. The
  browser plugin asks the hub whether `browser-traffic` is on (`plugins.enabled`, a new core method) and hears about
  changes (`plugins.updated`, now among the events a plugin may subscribe to). While it is off the traffic tools are
  not registered and nothing is kept.

### The log

While the ability is on, every tab's requests go into a log in the plugin's memory (never on disk): the last 1500
requests of the browser, with headers, the request's body (up to 256 KB) and the response's body when it is text of
up to 512 KB (JSON, HTML, scripts, form data; pictures and media keep their size only), 48 MB of bodies in all, the
oldest dropped first. WebSocket connections keep their last 200 messages. Requests an agent sends itself are logged
too.

`browser_requests` (read, taints like every browser tool):

- a list, newest last: `#412 POST api.shop.kz/v1/cart → 200 json 1.2 KB 140 ms`, narrowed by `match` (a mask of
  host and path, `*` for any run of characters, no scheme), `method`, `status`, `type` (xhr, document, script,
  websocket…), `since` (a request's number), `tab: "all"` (the agent's own tab otherwise);
- `id`: one request in full: headers, the request's body, the response's body (`maxChars`);
- `json: true`: the same as JSON, for a skill's script.

`browser_requests_save` (local-write) writes the narrowed list as a HAR file into the session's workspace, with the
same hiding as below.

### What is hidden

In the plugin (`traffic/redact.ts`), before any text leaves it for the model or a file. A hidden value reads
`«hidden»`.

- **By name**: the headers `Cookie`, `Set-Cookie` (cookie names stay), `Authorization`, `Proxy-Authorization` and
  any header, query parameter, form field or JSON key whose name has token, secret, password, passwd, pwd, auth,
  session, sid, csrf, xsrf, key, signature, otp, pin, cvv, cvc, card number or code in it.
- **By shape**: JSON Web Tokens, `Bearer …`, long random strings (32+ characters of mixed letters and digits; not
  UUIDs), card numbers (13–19 digits passing the Luhn check).
- **By value**: every value that travelled in `Cookie`, `Set-Cookie` or `Authorization` of this browser, every value
  hidden by name, and everything `browser_fill_secret` typed, is hidden wherever it shows up again (a body, an
  address, another header).

The hub's own redactor still replaces vault secrets in every tool result after that.

When an agent sends a recorded request again, the hidden values go back in by themselves: the agent uses them without
seeing them. Hiding by name and shape is not perfect (a token in an oddly named field of an odd shape passes); a
session that has read the web still cannot send what it saw to a new address without the person (the egress guard).

### Rules: block and replace (free)

`browser_request_rule` (local-write): `block` requests by `match` (and `method`), or `respond` to them with a
`status`, `contentType` and `body`, or `patch` the real response's JSON (`set`: path → value). `list` and `remove`.

- A rule lives on the agent's own tab, for 30 minutes unless `minutes` says otherwise (at most 240), and is gone
  with the tab or the browser.
- Free rules replace **data only**: requests of the kinds xhr, fetch, eventsource, image, media, font, and never
  with HTML or JavaScript as the content type. A page, a script, a stylesheet or a worker matching the mask is left
  alone, and the rule says so.
- A free answer may not name another site (`https://…`, `//…` in the body or in `set`): the page would load it, and
  the address could carry what the agent read. Such an answer is `browser_request_change`'s.
- While a tab has a rule, Chrome's HTTP cache is off on it (how interception works). No rules, no interception.
- The live view shows that an agent is changing the tab's traffic, with "Remove"; the person can also ask in the chat.

### Changes with consequences (a card)

`browser_request_change` (external): a rule that changes **outgoing** requests (`request`: set or remove headers,
query parameters, the body, a JSON patch of the body, another address) or replaces a **page or script**
(`response`). The card shows the site, the mask and the agent's `description`. One approval covers that rule for its
lifetime.

`browser_request_send` (external): a request of the agent's own that is not a GET: `method`, `url`, `headers`,
`body` or `data` (a JSON body), or `from` (a logged request's number) with what to change; the browser's cookies go with it, and with `from`
the original's hidden headers too. `amount` and `currency` when it spends money: the amount must be in what is sent.
Asked ahead of time for a taught skill: `hub_skill_save`'s `allow` takes `{request: "POST https://api.shop.kz/v1/orders*",
maxAmount, currency}`, shown on the skill's card, and becomes a rule for `browser_request_send`: the method, and an
address that starts exactly as approved (the tool refuses an address a URL parser would rewrite: `..`, backslashes,
`user@`). The person's own
words do not stand in for this card: a raw request has no control whose name the hub could check them against.

`browser_request_get` (read): a GET of the agent's own, like opening an address: free, and in a session that has read
the web a new address asks first (the egress guard reads `url`).

Requests of the agent's own leave through the browser's context (`context.request`): its cookies and the hub's
proxy, not Chrome's own network stack.

### Skill scripts

`browser.requests(filter)` → the list as objects (JSON bodies parsed), `browser.fetch(url, {headers})`,
`browser.send({method, url, data, body, from, …})`. `fetch` and `send` are held to the skill's sites; each is the same tool
call as the agent's own.

### Not in this version

- WebSocket messages are seen, not changed (a connection can be blocked).
- Requests of service workers may be missing from the log.
- Requests sent by the agent, and the real answer a `patch` rule fetches, come from Node's network stack (through
  the hub's proxy, with the browser's cookies), not Chrome's: a site that fingerprints connections can tell.

## Contracts changed

- `CORE_METHODS`: `plugins.enabled` (`{id}` → `{enabled}`).
- Plugin SDK `EventName`: `plugins.updated`.
- `SkillAllow`: a `request` form beside `label`.

## Testing

- `redact`: headers, addresses, JSON, forms, shapes, known values, round trip of hidden values on resend.
- Log and rules on real Chromium against a local test server: capture, bodies, masks, block, respond, patch, the
  data-only limit, expiry, the outgoing change, send and get.
- Core: `plugins.enabled`; a skill's `request` pre-approval and its card line; scripts' `requests`, `fetch`, `send`.
- The tools are absent while `browser-traffic` is off and appear when it is turned on.
- A live check on a throwaway hub with the real browser.

## Docs

`docs/guide/{en,ru}/browser.md`: a section on traffic; the teach-by-demo skill: the three script calls.
