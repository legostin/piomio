# HTTP client: requests by hand and by agents, with a history

Asked 2026-11-18: a built-in plugin for working with HTTP requests: a visual interface, automation through agents, a
history and search.

## Decisions

- **An integration of its own**, `integrations/http-client` (tool prefix `http`), shaped like kanban: a server, a page
  at `/http` with a place in the sidebar, a card in the chat. Built in, off until turned on. Not a part of `web`: its
  `web_fetch` only reads pages, and a tool that reads must not be the tool that acts.
- **Reading is free, acting asks.** `http_get` (GET and HEAD) is a `read`; `http_send` (any method, headers, body) is
  `external`: the person answers a card for each call, or once with "always" for a host, as for any action.
- **One history for everyone.** Every request, the person's and the agents', is written to the same journal with who
  sent it. The page and `http_history` search the same thing.
- **Saved requests and environments** are the person's library: a request has a name (agents call it by name), an
  environment is a set of `{{variables}}`. Agents read and run them, and save their own.
- **Secrets stay in the vault.** A value may hold `vault://<id>` (or `vault://<id>#<field>`): the plugin puts the secret
  in when the request leaves. The history keeps the reference, and a secret echoed by the server is cut from what is
  stored and from what the model reads.
- **This computer is closed.** Loopback and link-local addresses are refused for the page and for agents alike (the
  hub's own API lives there). Hosts in the person's own network follow the hub's rule: closed until they allow one.
- Not in this version: WebSocket, gRPC, server-sent events, assertions and chains of requests (an agent does those),
  Postman and OpenAPI import, a signal source (the hub's watch triggers already follow an address).

## Outside content

A request can carry out what a session has read. The address in `url` is already checked by the hub (tainted egress),
but nothing else in a call is. So in a session that has read outside content `http_get` takes an address or a saved
request's name and nothing more: no `headers`, `query` or `vars` (each could hold what was read). The agent is told to
use `http_send`, which the person sees. `http_save` is `askWhenTainted`: a tainted session cannot quietly write a request
or a variable that a later free `http_get` would send. Responses come from outside: `http_get`, `http_send` and
`http_history` are sources.

On a redirect to another origin the request drops `Authorization`, `Cookie`, `Proxy-Authorization` and every header that
held a vault secret; each hop is checked like the first address.

## Pieces

`server/`
- `types.ts`: `RequestSpec` (method, url, query, headers, body, bodyType), `ResponseData`, `Entry` (one line of the
  history), `SavedRequest`, `Environment`, and what the page reads.
- `net.ts`: which addresses are open (public; the person's own network when the hub's proxy decides; never this
  computer), with an injectable DNS lookup.
- `vars.ts`: `{{name}}` from the call's `vars`, then the environment; `vault://` references resolved through
  `ctx.vault.get(ref, { domain: host })`; the list of secrets put in, for redaction.
- `send.ts`: one request: builds it, follows up to 5 redirects by hand, 30 s by default (120 s at most), reads up to
  5 MB, decodes text by charset, tells text from binary, measures time.
- `history.ts`: SQLite (`node:sqlite`) in the plugin's data folder: a row per request and an FTS5 trigram index over
  method, address, headers and bodies, with a plain `LIKE` search when FTS5 is missing or the query is under three
  characters. Bodies are kept up to 512 KB each (a binary response: its type and size only); the newest 5000 rows stay.
  Filters: text, host, method, status (`200`, `4xx`, `error`), since, who.
- `saved.ts`: saved requests and environments in `ctx.storage` (replicated with the hub's data), names unique without
  case. In a tainted session `http_get` also refuses `url` together with `saved`, and a `{{variable}}` or a `vault://`
  reference written into the address: only a saved request may hold those there.
- `curl.ts`: a request as a curl command, and a pasted curl command as a request.
- `client.ts`: what both the tools and the page call: resolve a saved request, fill variables and secrets, send, redact,
  write the history, tell the open pages (`ctx.ui.emit("changed")`).
- `tools.ts`, `http.ts`, `index.ts`.

Tools (descriptions and results in English):

| Tool | Effect | What |
|---|---|---|
| `http_get` | read, source | GET or HEAD an address or a saved request; `card: true` shows the response to the person |
| `http_send` | external, source | any method with headers and a body (`json`, `text`, `form`), or a saved request |
| `http_history` | read, source | search the journal, or one entry in full by id (`offset` to read on) |
| `http_saved` | read | saved requests and environments |
| `http_save` | local-write, askWhenTainted | save, change or remove a request or an environment's variables; `fromHistory` saves a sent one |

A result for the model: the status line, time, size, type and the history id; the response headers; the body, JSON
pretty-printed, cut at `maxChars` (20 000 by default) with how to read on.

The page's routes (never public): `GET /state`, `GET /history`, `GET|DELETE /history/:id`, `DELETE /history`,
`POST /send`, `POST|PUT|DELETE /requests[/:id]`, `POST|PUT|DELETE /environments[/:id]`, `PUT /active-environment`,
`POST /curl/parse`, `POST /curl/format`.

`ui/src/`: `index.tsx` (route, sidebar link, the `response` card), `HttpPage.tsx` (the list on the left: search, History
and Saved; the request on the right: method, address, Params / Headers / Body, environment, Send; the response below:
status, time, size, Body / Headers), `widgets.tsx`, `shared.tsx`, `styles.ts`. Buttons: Save, Copy as curl, Ask an
agent (opens the default agent's chat with the request in the person's words). A curl command pasted into the address
field becomes the request. Everything the page does, the tools do.

## Errors

A refused address, a timeout, a DNS or TLS failure is an entry in the history too (`error` instead of a status, with a
code: `local` for this computer, `lan` for a host of the person's network not yet allowed, `timeout`, `network`,
`invalid`), and an `isError` result that says what to do. A missing vault item names the item and never the value. The page shows errors in
the person's language (`error.*` in the locales).

## Tests

`test/http-client.test.ts` with the testkit against a local server: methods, headers, bodies, redirects (and what is
dropped across origins), the size cap, binary responses, variables and vault references with redaction, the tainted
rules, the history (search, filters, the 5000 cap), saved requests and environments, curl both ways, the page's routes.
A local server is on loopback, which the plugin refuses, so the tests start it with `PIOMIO_HTTP_CLIENT_TEST_LOCAL=1`
(a test seam: only the environment of the plugin's process can set it, which no agent can change); the refusals are
tested without it.
