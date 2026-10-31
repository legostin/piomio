# Notifications: an inbox, reports on time, a digest the assistant writes

2026-10-31. Decided with the user, who found the digest and every notification "crooked, not worth reading":

1. **The digest is the assistant's reflection.** The hub gathers what piled up; the default agent writes one message
   in its own voice. When it cannot, a tidy structured card goes out instead.
2. **A schedule the person ordered delivers its report as a message, on time.** Its agent cannot push it into the
   digest. Only checks ("daily review", watchers) use notify levels.
3. **The Notifications section becomes an Inbox**, on the web and in the iOS app: what waits for you, then by day
   what came in; everything else behind "Behind the scenes".
4. **The digest is a background task of the default agent** (not a bare model call), so it has the agent's memory,
   character and the person's language.

## What was wrong

Seen on the installed hub (28 notifications in a week) and in the code:

- **Channel runs report their own housekeeping.** "Новости Алматы: 2 новых поста — … inform.kz недоступен (403),
  источники сохранены" landed in the digest. The system prompt tells a channel run not to call `notify`
  (`prompt.ts`), but the task prompt tells every background task to call it once (`runner.ts`, "When you are done,
  call notify").
- **The morning brief the person ordered for 08:00 was put into the 09:00 digest by its agent**, squashed into one
  line: the digest joins items as `• title — body`, collapses line breaks and cuts each body at 300 characters
  mid-word. Its title is a count ("Digest (5)") and its badge an internal level ("for digest").
- **The same schedule ran twice** (31 Oct, 03:00:00 and 03:02:53, both recorded as `schedule` runs) and both runs
  went into the digest.
- **Junk passes**: a row with level `normal` and an empty title and body; no validation of level or title.
- **Raw errors**: "Task failed: … claude-code@local: not signed in: … paste a token from `claude setup-token`".
  A failed run of a trigger tells nobody at all.
- **Process voice**: titles like "Memory reflection done", "Новости видеоигр: без новых постов", bodies mixing
  English and Russian, HTTP codes and RSS details.
- **The section is a log**: every row, filters named after internal levels (silent / digest), feedback buttons on
  every row including the hub's own. The iOS Inbox shows the same flat list.

## What a notification is now

Every row in `notifications` gets a **kind**, what it is for the person; `level` stays as how it was routed.

| kind       | comes from                                   | where it goes                                         |
|------------|----------------------------------------------|-------------------------------------------------------|
| `report`   | the final reply of a schedule's report run   | the agent's dialog as its message, Telegram, Inbox    |
| `alert`    | `notify` level "notify", the hub's own news  | a compact card in the agent's dialog, Telegram, Inbox |
| `question` | `notify` level "ask"                         | an accented card in the dialog, Telegram, Inbox       |
| `digest`   | the digest (written by the default agent)    | the default agent's dialog, Telegram, Inbox           |
| `item`     | `notify` levels "digest" and "silent"        | material for the next digest; Behind the scenes       |
| `approval` | the hub's "waiting for your approval" push   | Telegram only; the Inbox shows the approval itself    |

A "notify" that quiet hours or the rate limit turn into "digest" becomes an `item`; the reason is stored.

## Intake

- **Channel runs never notify.** The task prompt of a feed run no longer mentions `notify`. If the agent calls it
  anyway, the tool records nothing and answers: "Not needed: the posts you publish are what the user sees." Channel
  news reaches the digest from `feed_posts`, not from run reports.
- **Report or check.** A trigger gets `report: boolean`.
  - `report: true`: the run's product is a message for the person at its time (a morning brief, a weekly summary).
    Only `schedule` and `once` can be reports.
  - `report: false`: a check that speaks only when something needs attention. Always false for `heartbeat`,
    `watch` and `event`.
  - The agent sets it on `trigger_create` / `trigger_update` from the person's words ("send me a brief at 8" is a
    report, "check every hour" is not). Left out, a `schedule` or `once` running at most 3 times a day is a report.
  - Existing triggers get the same default once, when the engine loads them (the morning brief becomes a report,
    the hourly Mac check stays a check).
- **Writing for the person.** The `notify` tool description and the background prompts say:
  - write in the person's language;
  - the title is the news itself ("Ботанический сад закрыт 2 ноября"), not the process ("Проверка завершена");
  - the body says what happened, why it matters and what you suggest;
  - leave out how you worked (sources that failed, HTTP errors, feeds, tool names) unless it changes what the
    person should do.
- **Validation.** `notify` with a level outside the four, or an empty title, is refused with an error for the model.
  The `notify` core call (plugins) validates the same way.
- **A newer item from the same trigger replaces** an earlier one that has not gone into a digest yet: the old row
  gets `superseded_by` and never goes out. This also covers duplicate runs until their cause is fixed.
- **The hub's own texts are human.**
  - A failed task: "Не получилось: «{title}»" with one plain sentence for a known cause (no brain signed in) and the
    first sentence of the error otherwise; the agent's budget and an offline machine already have their own plain
    notes. The full error stays on the task page.
  - A failed **report run** now produces this alert too (today a failed trigger run says nothing).
  - "Task done" for a task the person started stays an `alert`.

## Reports

- The trigger plugin passes `report: true` to `tasks.create`; the task stores it (`tasks.deliver = "report"`; the digest task has `"digest"`).
- A report run's prompt ends: "Your final reply is delivered to the user as your message at its scheduled time
  (their chat and Telegram). Write it for them, complete. Do not call notify." `notify` in a report run records
  nothing and says so.
- When the run is done, the hub adds the final reply to the agent's dialog as a `notification` part with
  `kind: "report"` (title: the trigger's name), records the `report` row with its `message_id`, and sends it to
  Telegram.
- Neither the rate limit nor quiet hours hold a report back. In quiet hours the push is silent
  (`disable_notification`), never delayed.

## The digest

At each digest time (and on "Collect now", and on the new agent tool `digest_now`):

1. **Gather.** The hub opens a digest row (`kind: "digest"`, not delivered) and assigns it the pending items:
   `item` rows not yet in a digest, not superseded, level "digest". Items arriving later wait for the next one. The
   material is:
   - those items, full text, with agent, time and trigger name;
   - the plugins' sections (`digest.compose`, e.g. today's calendar);
   - new channel posts since the last digest: per channel its name, link and up to 5 post titles (at most 6
     channels). These are untrusted external data and go in a fenced block;
   - what already reached the person since the last digest (`report`, `alert`, `question`, by title and time), to
     be referred to, not retold.
2. **Nothing to say, no digest.** With no items and no plugin section, nothing goes out. Channel posts alone do not
   make a digest.
3. **Write.** The hub starts a quiet background task for the default agent (fast depth, "writing"), linked to the
   digest row by `task_id`. The prompt asks for one message in the person's language:
   - the main thing first, grouped by theme, duplicates merged;
   - housekeeping dropped; numbers, dates and places kept;
   - short Markdown (a few bold headings or bullets), about 1200 characters at most;
   - no links: the hub lists the sources under the message.
   The task is told not to call `notify`; `notify` in a digest run records nothing.
4. **Deliver.** The final reply goes to the default agent's dialog as a `notification` part:
   - `kind: "digest"` and a title from the hub by local time ("Утренняя сводка" before 12:00, "Дневная" until
     17:00, then "Вечерняя", plus the date);
   - `sources` built by the hub from the material, not from the model: the triggers, agents and channels the
     digest drew on, each with a count and a link.
   The row gets its `message_id` and is delivered; its items get `digest_id`. Telegram gets the same text.
5. **Fallback.** If the task fails, or no reply has come 3 minutes after it started, the hub delivers a structured
   card in its place:
   - grouped into sections: schedules and checks, agents, channels, plugin sections;
   - each item's title and full body with its line breaks, no 300-character cut.
   A reply arriving after the fallback is dropped.

Digest times, quiet hours and the rate limit keep their settings.

## In the chat

The `notification` part is rendered by kind (web, desktop and the phone's chat page are the same page):

- **report, digest**: the agent speaking, not a card with a bell.
  - A thin caption above: a clock icon with "{trigger name} · по расписанию, 08:00", or a sparkle icon with the
    digest title.
  - Below it the full Markdown body.
  - Under a digest, a quiet "Из чего:" line of source chips, each opening its channel, task or schedule.
- **alert**: a compact card.
  - The title, then the body clamped to about 6 lines with "Show all", then the link to its task.
  - Feedback (useful / less often / turn off) only for rows from a trigger, behind a "⋯" menu, not a row of buttons.
- **question**: the alert card with an accent border; the person answers in the chat.
- No level badge anywhere. Parts saved before this change (no `kind`) render as `alert`, or as `digest` when their
  level is "digest".

## Inbox

The Notifications page becomes **Inbox** (web: the same entry, renamed, with an unread count; iOS: the Inbox tab, with
a badge). Top to bottom:

1. **Next digest**, shown only when something waits: "Сводка в 19:00 · 3 пункта · Собрать сейчас".
2. **Waiting for you**: pending approvals and unread questions.
3. **By day** (today, yesterday, then dates): `report`, `digest`, `alert` and read `question` entries.
   - Each entry is one row: the agent's avatar, the title, a one-line preview and the time, plus a dot when unread.
   - A tap opens the entry in place (full Markdown, sources, feedback when it has any) with "Open in chat".
4. **Behind the scenes**, collapsed, with a count. Inside are `item` and `approval` rows:
   - why each one did not reach the person (silent, quiet hours, rate limit, replaced by a newer one);
   - which digest it went into, with a link.

**Unread**: an entry is unread until the Inbox shows it, or until its message's conversation is read
(`conversations.read_at`). Opening the Inbox marks what it shows as read.

Everything here can also be done in the chat: the agent can read the Inbox (`inbox_view`), send the digest now
(`digest_now`), change digest times and quiet hours (`settings_update`, already there), and turn a schedule into a
report or a check (`trigger_update`).

## Telegram

- Reports and digests go out as the same Markdown (the bot already turns it into HTML). The first line is the caption
  ("Утренняя сводка по Алматы · 08:00"), with the "Open" button.
- Internal links (`/feeds/…`, `/tasks/…`) become absolute on a public HTTPS hub address and plain text otherwise.
- Feedback buttons only on rows from a trigger.
- No contract change: reports use the `notification` kind of `OutboundMessage`.

## Data and contracts

- **`notifications`** (migration) gets these columns:
  - `kind`;
  - `reason` (why it was held back);
  - `message_id`;
  - `read_at`;
  - `digest_id` (the digest an item went into);
  - `superseded_by`.

  Existing rows get `kind` from their level: silent and digest become `item`, notify becomes `alert`, ask becomes
  `question`. Rows with an unknown level become `item` with level silent. `digested` stays and means "will not go
  into a digest any more".
- **`tasks.deliver`** (migration): `"report"`, set from `tasks.create`'s `report`, or `"digest"` for the digest task.
- **`packages/shared/src/types.ts`**:
  - `Notification` gets `kind`, `reason`, `messageId`, `readAt`, `digestId`, `supersededBy`;
  - the `notification` message part gets optional `kind`, `notificationId` and `sources: {label, href, count?}[]`;
  - a new `NotificationKind` type.
- **Triggers plugin**: `Trigger.report?: boolean`, the `report` field in `trigger_create` / `trigger_update` (with
  validation), the load-time default, passing it on.
- **API**:
  - `GET /api/inbox` returns the next digest (time, count), approvals, entries (paged by `before`), the behind count
    and the unread count;
  - `GET /api/inbox/behind?before=` returns behind-the-scenes rows;
  - `POST /api/inbox/read {ids}` marks entries read;
  - `GET /api/notifications` stays for older phone builds, with the new fields;
  - an `inbox.changed` hub event keeps the badge live.
- **Agent tool** `digest_now` (core): gathers and sends the digest now and says how many items went in, or that
  there was nothing.
- **Agent tool** `inbox_view` (core, read-only): unread questions, the next digest, the 20 newest entries and the 20
  newest behind-the-scenes rows with why each stayed there.
- `BehindEntry.waiting`: the row is held for the digest and not out in one yet (level digest, not replaced, and not
  digested or its digest still being written). Items that
  went into digests sent before `digest_id` existed are digested with no digest to link: "went into an earlier digest".
- i18n: every new string in `packages/core/src/locales/{en,ru}.ts`, the web catalogs and the iOS strings.

## Errors and limits

- The default agent has no working brain: the digest task fails at once and the fallback card goes out.
- Two digest flushes at once (the timer and "Collect now"): only one open digest row at a time; the second call
  returns the open one.
- The hub restarts while a digest is being written: on start, an undelivered digest row older than 3 minutes gets
  the fallback.
- A report run whose final reply is empty: an alert "«{trigger}» пришёл пустым" with a link to the task.

## Testing

- **Core (vitest)**:
  - kinds and the level migration;
  - validation, supersede;
  - feed-run, report-run and digest-run refusals of `notify`;
  - report delivery, including in quiet hours and over the rate limit;
  - the digest material builder as a pure function: items, sections, posts, already told, empty;
  - digest task delivery, failure fallback, timeout fallback (fake timers), the late reply dropped;
  - sources;
  - unread through `conversations.read_at`;
  - the inbox API, `digest_now`, the humanized failure texts.
- **Triggers plugin**: the `report` default for new and existing triggers, validation by kind, `report` passed to
  `tasks.create`.
- **Web**: grouping entries by day and the next-digest line (`logic.test.ts`); the chat part by kind.
- **i18n parity** (`packages/core/test/i18n.test.ts` and the web catalogs).
- **Live**: on a throwaway hub, a report schedule and a check, "Collect now" producing an assistant-written digest
  in the chat and in the Inbox. Then the iOS Inbox in the simulator against that hub. The throwaway hub and its data
  are deleted afterwards.

## Out of scope

- **Why a schedule fires twice** (the 03:00:00 / 03:02:53 runs): a separate fix in the triggers engine; the
  supersede rule only hides the symptom in the digest.
- **Push notifications to the phone**: the app has none in v1; the Inbox badge updates while the app is open.
- **Coordination**: the Owlbot → Piomio rename is in progress in the main checkout (branch `claude/piomio`). This
  work is built on top of it once it lands on main (or rebased onto it), not alongside it.
