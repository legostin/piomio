# Archive and delete group chats

Asked 2026-11-03: group chats get **Archive** and **Delete** in their menu, like agents (2026-11-01-agent-archive-design.md),
and the same in the chat with an agent.

## What each state means
- **Archived**: out of the Groups list; its round in progress and the tasks started there stop; nobody writes in it
  (409) and nothing wakes it (a late task report or an answered card starts no turn). Its messages stay; one tap brings
  it back as it was. Stored in the hub (settings key `groups`: `{ archived: [conversationId…] }`), so every client and
  replica agrees.
- **Deleted**: gone for good with its conversation: messages, sessions, approvals, the tasks started there (and the
  tasks those started) with their threads, and the notifications of all of them. Its members' live brain sessions close.

## Who can do it
- The person, from the group's menu in the web and desktop sidebar (right click, long press, "⋯"): Mark unread / read,
  Group settings, Archive, Delete; an archived group: Restore, Delete. Deleting confirms and offers the archive instead.
- Any agent, in the chat, when the person asks (group-tools.ts): `group_archive { group?, archived }` and
  `group_delete { group? }` (without `group`: the group this chat is). A delete always waits for the person's yes on a
  card, whatever their rules or auto mode say, and never runs in background work. Asked in the group itself, the
  member's turn ends as usual and nobody speaks after it; a delete happens once that turn has ended.

## Contract (hub ↔ web, desktop, iOS)
- `GroupChat.archived?: true` on an archived group.
- `GET /api/groups`: active groups only (as before). `GET /api/groups?all=1`: the archived ones too.
- `POST /api/groups/:id/archive { archived: boolean }` → the `GroupChat`; 404 `{ error }` (key `group.notFound`) for
  anything but a group chat.
- `DELETE /api/groups/:id` → `{ ok: true }`; 404 as above.
- `POST /api/conversations/:id/messages` in an archived group → 409 `{ error }` (key `group.archivedChat`).
- Events: `group.updated` (with `archived`) after archive and restore; `group.deleted { conversationId }` after a delete.

## iOS (`~/claude-projects/piomio-ios`), not done yet
- Its Groups list keeps working (`/api/groups` leaves the archived out), but a `group.updated` with `archived: true`
  should take the group out of the list, and `group.deleted` should drop it.
- The menu (long press, swipes) and an archive list, as for agents, are still to come; the chat page it shows is the
  web's, which already puts "“Name” is in the archive · Restore" in place of the composer.
