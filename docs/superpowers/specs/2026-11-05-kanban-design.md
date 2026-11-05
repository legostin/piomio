# Kanban: a board on top of tasks

Asked 2026-11-04: a customizable kanban plugin that extends tasks: statuses, a queue, priorities, projects, cards with
content and attachments; autonomous agents take cards themselves when that is turned on and told to them in the chat;
and it should work with the Linear plugin that already exists.

## Decisions

- **A card is the plan, a task is one run of it.** The board holds what the person or an agent put there. A card lives
  through any number of runs (a returned card gets a new one). Tasks agents start while talking do not appear on the
  board: the Tasks page already shows them.
- **Statuses belong to the project.** Each project has its own columns, each with a hidden type: `backlog`, `queue`,
  `active`, `review`, `done`, `cancelled`. The engine only reads the type, whatever the column is called. A new project
  starts from a standard set. Columns may have a work-in-progress limit.
- **The board decides where a finished card goes.** A project with a `review` column: the card goes there and the person
  is told; they accept it or return it with a comment, and a new run starts. Without one: straight to `done`.
- **Linear gets no code here.** Agents are the link between plugins: they have `linear_*` and `kanban_*` tools. The board
  gives them what makes that work: an `external` reference on a card (importing again updates, never duplicates) and a
  skill (`kanban-trackers`) that says how. A regular sync is an ordinary schedule. Any other tracker works the same way.
- **Card fields:** title, description (Markdown), status, priority, assignee (an agent or "me"), labels, due date,
  blocked by (other cards), attachments, comments, runs, history. No sub-cards or custom fields in this version.

## Taking cards by themselves

Two switches: one for the whole board (off by default), one rule per agent, both set in the chat (`kanban_pickup`) or on
the board. A rule says which projects, which labels, from what priority and how many cards at once.

An engine in the plugin takes cards, not a waking agent, so an empty queue costs no tokens. It looks when something
changes and once a minute. A card is taken when it is in a `queue` column, has no open run, is unassigned or assigned to
this agent, every card it waits for is closed, and the project's `active` column has room. Order: priority, due date,
position on the board.

The rules of the hub stay in force, not worked around:

- Only agents with initiative "Acts" (2) take cards: below that a background run can only read.
- The day's budget of background runs: `tasks.create` got `skipIfNoBudget`, so a spent budget leaves the card in the
  queue instead of failing it, and it is taken the next day.
- A run waiting for the person (a question, an approval) does not hold the agent's slot.
- A failed run leaves the card where it is, marked; the person is told, and the agent's taking pauses (15 minutes,
  doubling up to 6 hours, until a run succeeds), so a broken agent does not fail the whole queue. Nothing is retried by
  itself: the hub already retries inside a task.

Runs started by the person's own request (the board's Start, `kanban_start` in a dialog) are not background work: no
initiative or budget applies, like any task started from a conversation.

## Outside content

A card imported from a tracker is outside text, and an agent taking it alone would make it a command. So:

- A write from a tainted session marks the card `outside`. Tools that return such a card taint the reader
  (`_meta.taint`); runs of it start tainted (`tasks.create` got `tainted`).
- An `outside` card is not taken automatically until the person allows it: moving it to a queue by hand, pressing Allow,
  or `kanban_allow` (`askWhenTainted`, so a tainted session gets a card or a review). Any later tainted write takes that
  back.
- Creating and editing cards does not ask: importing fifty issues is not fifty cards to approve, and nothing happens with
  them until they are allowed.
- `kanban_pickup` and `kanban_project_save` are `askWhenTainted` (project notes go into every run's goal); `kanban_delete`
  is `external`, so it always asks.

## Pieces

`integrations/kanban/`, self-contained, off until turned on in the catalog (like other built-in integrations).

- `server/board.ts`: projects and cards in memory, written through to `ctx.storage` (so replicas get them).
- `server/work.ts`: runs: starting one, following `task.updated`, moving the card on, telling the person, return, accept.
- `server/pickup.ts`: rules and the engine.
- `server/files.ts`: attachments in the plugin's data folder; `files.fetch` / `files.deliver` to and from workspaces.
- `server/tools.ts`, `server/http.ts`: agents' tools and the board's API over the same operations.
- `ui/src`: the board page, the card panel, chat cards (`card`, `board`) that read the live card and offer its actions.
  The page is a full view reached from a sidebar link (`nav: false` and `layout.sidebar`): `nav: true` would open it in
  the narrow panel beside the chat, too small for columns, and would lose the deep link in the URL.

A run starts one of three ways, and that says who hears about it:

- **person** (the board's Start): the hub tells them "Done" or "Failed", like any task they started.
- **dialog** (`kanban_start`): the result goes back to that conversation, like `task_delegate`.
- **auto** (the engine took the card): nobody is waiting, so the board tells the person when it finished, and the hub
  tells them about a failure. Background work, under the initiative and the budget.

The hub changes only in `tasks.create` (`tainted`, `skipIfNoBudget`, `byAgent`), `Runner.hasBudget`, `agents.list` (names
in the hub's language, as a plugin shows them to the person), and the note a queued task sends its starter, which now
needs a parent conversation: an engine's run has none and would wake the agent's dialog. Kanban runs are `user` or
`agent`, not `trigger`: the Tasks page files those under Schedules.

Chat first: everything has a tool. "New project" and adding an agent's rule on the page open a chat. Quick add, dragging
and the column form are the second way.

Attachments are at most 25 MB from a workspace and 15 MB from the page (the hub's request limit, in base64).

## Tests

`integrations/kanban/test`: against the plugin harness with a fake hub: projects and columns, cards and dependencies,
import, taking order and limits, each reason a card is not taken, finishing with and without review, failure and pause,
return and accept, outside content, attachments, restart. `packages/core/test/core-call.test.ts`: the new options.
