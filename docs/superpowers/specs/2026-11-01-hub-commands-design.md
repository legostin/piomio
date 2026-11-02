# The hub's own commands

2026-11-01. Asked by the person: "у нас есть подсказки команд но нет самих команд. начнем с технических. /task
создаст задачу /brain меню смены мозгов /archive архивировать агента /effort /goal /schedule". Decided with them:
`/goal` is a long goal as in Codex (the agent works toward it round after round until it is reached); the archive
itself is built on its own branch (`claude/agent-archive`, spec 2026-11-01-agent-archive-design.md), here only the
command that opens it.

## What the person sees

The composer already says "/ for commands"; now the list has the hub's own commands first, then the skills' ones.
A command the person writes stays in the chat as they wrote it; the hub answers at once, without the model, with a
card or a line (in Telegram: the same in words). Only `/schedule` goes to the agent, which understands "every
morning at nine".

| Command | What it does |
| --- | --- |
| `/task <what to do>` | Starts a task for the chat's agent now; its live line appears in the chat. Without words: a hint. |
| `/goal <what to reach>` | A long goal: a task that keeps going round after round until the agent says it is reached, or that it needs the person (then it waits for their answer, as a task's question does). 20 rounds, then it pauses and says so; `/goal resume` gives it 20 more. One goal per chat: a new one replaces the old. `/goal` alone shows the current goal's line; `/goal pause`, `/goal resume`, `/goal clear`. |
| `/brain [name]` | A card with the agent's brains (and the models of the one it uses); a tap switches. `/brain codex` switches at once. |
| `/effort [level]` | A card with the depth (auto, fast, balanced, deep) and the brain's efforts; `/effort deep` or `/effort high` sets it at once. |
| `/schedule [when and what]` | The agent sets up a schedule or a one-time reminder with its trigger tools; alone, it shows the schedules and asks what to set up. |
| `/archive` | A card that archives the agent (asleep, see the archive spec); in the default agent's chat it first asks who becomes the main agent. After that the card says it is in the archive, with Restore. |

- Choosing a command that needs words (`/task`, `/goal`, `/schedule`) puts it in the field; the others are sent at
  once.
- Where: an agent's dialog and a task's chat (the task's agent). In a group chat `/task`, `/goal` and `/schedule` are
  for the lead; the rest answer "write it in the agent's own chat".
- `/brain` and `/effort` change the agent's choice for its chats, the same one as the picker in the chat's header
  (tasks, channels and schedules follow it unless they have their own).

## Model

- `GET /api/commands`: `{ name, description, source, args? }`, the hub's (source `hub`, `args` the hint for words)
  in the reader's language, then the skills'. A skill command with the name of a hub command is not listed.
- `MessagePart` `thinking` gets `focus?: "brain" | "effort"`: the card shows only that part of the header picker.
- `MessagePart` `{ type: "agent_archive"; agentId }`: the archive card. It calls `POST /api/agents/:id/archive`.
- `Task.kind: "goal"`, `Task.rounds`: the rounds done (column `rounds`).

## Behaviour (core)

- `commands.ts` (`HubCommands`): parses "/name args" at the start of a message, answers in the conversation (a
  system message with the card, or an error line) and on the channel the message came from (text). The runner asks
  it first, before skill commands; `/schedule` comes back as a prompt for an ordinary turn.
- `/task`: `createTask` (by the user, the dialog as its starter), its line in the chat.
- `/goal`: `createTask { kind: "goal" }`. The first round's prompt explains the loop; after each turn the runner
  counts a round and, unless the agent called `goal_report`, queues the next one ("round N of 20: carry on").
  `goal_report { status: "achieved", summary }` ends it as done (reported like any user task); `"blocked"` asks the
  person (task_ask) and the goal waits for the answer, then carries on. Every 20th round it pauses with a notice.
  A goal the person paused stays paused even when its turn is cut off; `/goal resume` wakes only a paused one, and a
  message written on its page carries it on.
- `/brain` and `/effort` use `applyThinking` + `saveAgent`, as the header picker does.
