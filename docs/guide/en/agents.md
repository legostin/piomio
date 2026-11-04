---
title: Agents and the team
description: The team you start with, what an agent is on disk, making and changing agents in the chat, initiative, which brain answers, pin, archive and delete, agents bound to a computer, project folders, what agents know, memory and skills.
---

Piomio is a team, not one bot. Each agent is a role with its own name, face, character, brains and tools, and its own long dialog with you. They know about each other, pass work along and remember what matters about you.

## The team you start with

A new hub has two agents:

- **Assistant** (the default agent): your main helper. It also runs Piomio itself: settings, new agents, keys, connections. Only the default agent can make, change, archive or delete other agents.
- **Researcher**: searches, compares and sums up information from several sources and keeps track of topics. Its tools are limited to the web, the browser, memory, tasks, teammates, schedules and channels.

On the first run the assistant offers a few more roles for your team and builds the ones you want with you (see [First run](first-run.md)).

The default agent's dialog is the start page, and what you write in Telegram goes there too (see [Telegram](telegram.md)). Any other agent can become the default: **Make default** in its menu.

## Every agent is a front desk

In its own dialog, every agent answers quick things at once and sends anything with steps to a task on the side: research, code, checking, browsing, long writing. It picks who does the work (itself or a teammate whose role or skills fit) and on which computer, and asks you one short question only when that is unclear and matters. Questions for a teammate go to them as a message, and the reply comes back into the dialog. How tasks run and report back is in [Tasks, schedules and the Inbox](tasks.md).

In the dialog the agent's own tools only look. Claude Code runs there without its shell and file-editing tools, Codex runs read-only, and Kimi's permission prompts are refused. Running commands and changing files is a task's work.

## What an agent is

An agent is a Markdown file: settings at the top, its instructions below. The format is compatible with Claude Code subagent files.

- The built-in agents ship in the app's `agents/` folder.
- Yours live in `agents/<id>.md` in the hub's data folder (on a Mac `~/Library/Application Support/Piomio`, on Windows `%LOCALAPPDATA%\Piomio`, on a Linux server `~/.local/share/piomio`). Changing a built-in agent writes your copy there, and your copy wins.
- Changes you make to the files by hand are picked up when the hub restarts.
- Which agents are pinned or archived is kept in the hub's settings, not in the files.

```yaml
---
name: Chef
description: Plans the week's meals and the shopping list.
avatar:
  color: orange
  shape: flower
brains:
  - claude-code@local
  - codex@local
  - kimi@local
  - api:*
initiative: 1
tools:
  - "*"
skills:
  - "*"
budget:
  backgroundRunsPerDay: 30
---
You plan meals for the family. Ask about allergies once, remember them, and keep lists short.
```

| Field | What it is |
|---|---|
| `name`, `description` | The name, and a line on what the agent is for. Teammates see it when they choose who does a task |
| `avatar` | The face: a colour (teal, blue, indigo, violet, pink, red, orange, amber, green, slate) and a shape (circle, square, hexagon, diamond, triangle, star, flower, drop). The eyes are drawn from the agent's id |
| `brains` | The brains it may use, in order. `api:*` means every API provider you set up |
| `machines` | The computers it may work on. Empty means any |
| `folders` | Its project folders: `name`, `path`, the computer (`machine`, none for the hub's own) and a `note` (see below) |
| `thinking` | How it thinks for each kind of work: `chat`, `task`, `feed`, `schedule` |
| `initiative` | 0, 1 or 2 (see below). Default 1 |
| `tools`, `skills` | Which tools and skills it may use, as name patterns. `*` is all |
| `budget.backgroundRunsPerDay` | How many times a day it may work on its own. Default 30 |
| `i18n` | Its name and description in other languages |

## Making a new agent

Tell the assistant: "make an agent for recipes". Or press **Add agent** at the end of the team list (also **New agent** on the Agents page and in the command palette, Ctrl+K or Cmd+K). A short setup chat opens with the first question already there: "What should the new agent do? Describe its job in a sentence or two, and I'll put it together."

1. Answer in your own words. The assistant asks only what is missing, one short message at a time, starting with a name.
2. A **New agent** card appears: face, name and description. Pick **Colour** and **Shape** on the card, or leave them.
3. Something off? Just say it, and the description follows.
4. It asks how proactive the agent should be; answer in words or pick on the card under **How proactive**.
5. Say yes or press **Create agent**. The card says the agent is on the team, with **Open dialog**, and the setup chat becomes the new agent's dialog.

The new agent's id is made from its name. An existing agent is never replaced. A setup chat that made nothing is cleared away when the hub next starts, once it is a day old.

## Changing an agent

Talk to the agent itself: "call yourself Ada", "answer shorter", "show me how you look". It changes its own name, description, face, initiative and instructions, and shows a **How I look** card with the face pickers and **How proactive**. After it has read outside content (a web page, an email), it asks you on a card first. The assistant can change any agent the same way.

The same is on the **Agents** page: **Settings** → **Agents**. Each card shows the face, name, description and badges: the initiative, **built-in** or **yours**, the brain in use (for an agent bound to a computer, the computer and its brain: **LEGOSTIN-PC → Claude Code**), and the agent's own skills. **Edit** opens **Name**, the face, **Description**, **Prompt**, **Initiative** and **Where it thinks**; **More settings** adds **ID**, **Model**, **Policy profile**, **Tools**, **Skills** and **Background runs per day**.

## Initiative

Initiative says how much an agent does on its own, in background work: schedules, channels and background tasks. In your conversations, and in the tasks started from them, it changes nothing.

| Level | In the app | What the app says |
|---|---|---|
| 0 | **Only replies** | Works only when you write. Takes no background tasks |
| 1 | **Suggests** | Can work in the background, but only with read-only tools: finds, summarizes, suggests. The default |
| 2 | **Acts** | Takes actions in the background within your rules; anything external goes through approvals |

What the hub enforces today: below **Acts**, a background run sees only tools that read, plus a few it always may use (notify you, memory, posting to a channel, pages). It proposes actions instead of taking them. A skill you taught it may still use the browser when it runs on a schedule.

Each agent also has a daily budget of background runs (30 by default, 40 for the assistant). When it is used up, further runs that day fail and you get a notice.

## Which brain answers

An agent lists its brains in order; the first one that is signed in and ready answers, and on a limit or an error the next takes over. Within that, the hub picks the model and effort for each request: something light for a "thanks", a quick strong model for the dialog, an everyday one for tasks and the most capable one for deep work. Code goes to brains that can run code. How brains are added and signed in is in [Brains and sign-in](brains.md).

In a dialog, the brain you chose stays first. Tap the picker next to the agent's name in the dialog's header (**How Assistant thinks in this chat**):

- **Auto**, **Fast**, **Balanced** or **Deep**;
- **Exact model and effort** for a fixed **Model** and **Effort**;
- **Brain**: which one answers here;
- **Different for tasks, channels, schedules** opens the chat to set those apart;
- **Connect another brain**.

`/brain` and `/effort` in the chat do the same (see [The chat](chat.md)). The chip after a reply's time shows which brain, model and effort made it.

## Pin, archive, delete

Every agent has a menu: right-click it in the team list, long-press on the phone, or **⋯**. It has **Pin**, **Mark unread**, **Make default**, **Agent settings**, **Archive** and **Delete**. The default agent has no **Pin** or **Make default**.

**Archive** puts the agent to sleep. It leaves the team list and its teammates' lists; its running work stops; its schedules and channels don't run; its dialog takes no messages. Its dialog, memory and settings stay. Archived agents wait behind **Archive · N** at the end of the team list; **Restore** brings one back with everything it had. `/archive` in an agent's dialog shows the same as a card.

**Delete** is for good. It removes the agent's file, its dialog, tasks, schedules and notifications, and takes it out of group chats. Channels it edited pass to the default agent, and skills only it had go back to the whole team. Memory is not touched. The confirmation offers **Archive instead**. When the assistant deletes an agent at your request, it always asks you on a card.

Archiving or deleting the default agent first asks who takes its place.

## Agents on particular computers

An agent can be bound to computers: "let the coder work only on my laptop". It then uses only those computers' brains, never others, and its tasks don't go anywhere else. While none of them is online, its dialog says so; your message stays there, and you send it again once a computer is back. The same is under **Agent settings** → **Where it thinks**: pick a computer, then a brain on it, and the agent thinks only there, with that brain. **Anywhere** keeps the ordered list of brains instead. Computers are covered in [Machines and other computers](machines.md).

## Project folders

Tell an agent where a project lives, in your own words: "the site is in ~/code/site", "my thesis is in Documents/Thesis on the PC". It adds the folder with a card in the chat, and the folder opens when you tap **Allow**. From the next task on, the agent's brains on that computer read and change the files there without asking you each time, and the agent knows each project by its name: "fix the footer on the site" goes to the right folder. "Stop working in the site folder" closes it again, with no card.

The agent still works in a folder of its own for each task, so its notes, drafts, downloads and skills never land in your project. A folder never opens if it is your whole home, a system folder, the hub's own data or one with your keys and passwords (such as `~/.ssh`). On a connected computer, that computer's own settings still decide what the agent may touch there. In a dialog the agent only looks; changing the files is work for a task.

## What an agent knows

Agents are meant to feel like people who know where and when they are. Each turn an agent knows:

- who it is, which brain, model and effort it thinks with, and which computer it runs on;
- the local time: a `[Now: …]` line, refreshed at most every 10 minutes;
- a `[You now]` block whenever something changed: this conversation, its other work, what each teammate is busy with, which computers are online and where you are;
- in its dialog, the tasks it started that are still open.

Its dialog, its tasks and its messages with teammates are all the same agent, so it can say what else it is busy with.

Where you are comes from the iPhone app when you turn on sharing your location on its **Hub** tab (see [The iPhone app](phone.md)). The hub keeps only your last place and forgets it when you turn sharing off.

## Memory

The team remembers what matters about you. Tell any agent "remember that I'm allergic to nuts", or just mention it; agents also save facts as they learn them, and a line under the reply says **Remembered:** with the fact. The facts that matter come back into later conversations by themselves, and a nightly pass tidies memory and adds what was missed.

- Agents remember, change and forget facts without asking, also after reading outside content. Every change is kept in the fact's history and can be undone.
- Secrets are refused: passwords, tokens and card numbers belong in the vault.
- A fact can be for the whole team or for one agent only.

The **Memory** page (**Settings** → **Memory**) shows what the team knows, grouped as **You**, **Preferences**, **People**, **Places**, **Projects**, **Timeline**, **How you like things done** and **Notes**. You can search, **Edit**, **Forget** (then **Undo**), open a fact's **History · N versions**, **Tidy up** and **Export**. Facts that are no longer true wait under **No longer true**. Facts left pending by older versions show under **Waiting for your OK**, with **Remember** and **Don't**.

On disk each fact is a Markdown file in `plugins-data/memory/memory/` in the hub's data folder. With git installed, every change is committed (**History in git** in the Memory plugin's settings).

## Skills of their own

A skill is a set of instructions an agent loads when it needs it. A skill belongs to the whole team or only to the agents it was given to. Each agent's own skills appear in the team list other agents see, so work that needs a skill goes to the agent who has it.

- A skill you teach an agent by showing it in the browser belongs to that agent (see [The browser and teach mode](browser.md)).
- Say "give the invoices skill only to Ada" or "give it back to the whole team".
- **Settings** → **Skills & commands** lists skills, commands and tools. Each skill shows who has it: **Whole team** or the agents' faces. Tap that line to decide in the chat.
- Your own skills are folders with a `SKILL.md` in `skills/` in the hub's data folder.
