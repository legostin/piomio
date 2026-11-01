# Archive, delete and pin agents

Asked 2026-11-01: "добавить архивирование и удаление агентов, из веба и из приложения. Удалить можно только из интерфейса
и из чата с основным агентом, даже его самого, но всегда спрашивать разрешение. Для основного обязательно выбрать нового
главного или создать его из чата, до этого удалять нельзя. В приложении и в десктопе контекстное меню у агентов. Их можно
закрепить наверху списка." The person's choices: deleting takes the agent's dialog with it; the archive puts the agent to
sleep; the default agent is shown large at the top, as in the examples; the menu also has "Make default", "Mark unread"
and "Agent settings".

## What each state means
- **Pinned**: the agent's row sits under the default agent, above the rest, in the order pinned. Stored in the hub
  (settings key `agents`), so the web, the desktop app and the phone agree.
- **Archived (asleep)**: out of the team list; its schedules and channels do not run (a schedule's run is "skipped",
  the agent is archived); teammates neither see nor reach it; nobody can write in its dialog until it comes back. Its
  dialog, memory, settings and schedules stay. One tap brings it back.
- **Deleted**: gone for good with its dialog (messages), its tasks and its schedules. Channels it edited pass to the
  default agent; it leaves group chats. A built-in agent can be deleted too: the hub remembers it is gone.
- **The default agent** cannot be archived or deleted without a successor: an active agent that becomes the default in
  the same step. With no other agent, the person makes one in the chat first.
- **Mark unread**: the agent's last message counts as unread again (the badge shows 1) until the dialog is read.

## Who can do it
- The person, from the agent's menu (web, desktop, phone). Deleting asks for a confirmation that says the dialog,
  schedules and tasks go for good; for the default agent the person first picks who becomes the default, or opens the
  new-agent chat.
- The default agent, in its chat, with hub tools: `agent_delete` (always an approval card, whatever the person's rules
  or auto mode say; never in background work; may delete itself only with `successor`), `agent_archive`, `agent_pin`, and
  `hub_settings_update {defaultAgent}`. Other agents may not delete or archive; they are told to ask the default agent.

## Contract (hub ↔ web, desktop, iOS)
Types (`packages/shared/src/types.ts`):
- `AgentDef.archived?: boolean`: set when the hub lists agents.
- `TeamMember.pinned?: number`: the place among the pinned, 0 first; absent when not pinned.

API (session cookie + `x-csrf`, JSON):
- `GET /api/agents`: every agent, archived ones too (`archived: true`).
- `GET /api/team`: active agents only, with `pinned`.
- `POST /api/agents/:id/pin` `{ pinned: boolean }` → `{ ok: true }`.
- `POST /api/agents/:id/archive` `{ archived: boolean, successor?: string }` → `{ ok: true, defaultAgent }`.
- `DELETE /api/agents/:id?successor=<id>` → `{ ok: true, defaultAgent }`.
- Both answer 400 `{ error }` (key `agent.successorNeeded`) for the default agent without a valid successor (an active
  agent other than this one).
- `PATCH /api/settings { defaultAgent }`: make default (existing); an archived agent cannot be the default (400).
- `POST /api/conversations/:id/unread` → `{ ok: true }`; `POST /api/conversations/:id/read` (existing) marks read.
- `POST /api/conversations/:id/messages` in an archived agent's dialog → 409 `{ error }` (key `agent.archivedChat`).
- Events: `agents.updated` after pin, archive, restore, delete (clients refetch `/api/agents` and `/api/team`);
  `settings.updated` when the default changes; `team.updated` when a dialog is marked read or unread.
- Plugins hear `agent.removed { agentId }` (the triggers plugin deletes the agent's schedules).

## Web and desktop (`packages/web`)
- The agents tab: the default agent large at the top (big avatar with a star, name, working line, unread badge), then
  the pinned (a pin mark on the row), then the rest by latest message. At the end, "Archive · N" when anything is there;
  it opens the archived agents in the sidebar (back arrow), each with "Restore" and "Delete".
- The agent's menu: right click on the row, a long press on touch, and a "⋯" button on hover. Items: Pin / Unpin; Mark
  unread / Mark read; Make default (not on the default agent); Agent settings; Archive; Delete (red).
- An archived agent's dialog (opened by a link) shows "<name> is in the archive · Restore" instead of the composer.

## iOS (`~/claude-projects/piomio-ios`)
- The Agents tab: the default agent large at the top, as in the examples, then pinned, then the rest; "Archive" at the
  end opens the archived agents.
- A long press opens the menu with a preview of the dialog's last message; the same items as the web. Swipe left: Pin,
  Archive; swipe right: Read / Unread. Deleting confirms with a system dialog; for the default agent, the successor
  is picked first.
