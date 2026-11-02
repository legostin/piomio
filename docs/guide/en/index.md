---
title: Piomio documentation
nav: Overview
description: What Piomio is, what it is made of, and where to start: a map of the documentation.
---

Piomio is a small team of AI agents that lives on your own computers. Each agent has a name, a face, a job and a memory, and you talk to them in a chat the way you would to colleagues. Quick things they answer on the spot. Anything with steps becomes a task that runs on the side, and the answer comes back as a reply to your message. Before an agent sends or buys anything, it asks you.

The agents think with the official **Claude Code**, **Codex** and **Kimi Code** CLIs, signed in with the plan you already have. Piomio is free and open source, and it runs on your Mac, your PC or your own server. Your chats, memory and secrets stay there.

These pages explain how to install it, how to work with it and how it keeps you safe. They describe the newest release.

## What Piomio is made of

### The hub

The hub is Piomio itself: one program that runs on one of your computers or a server and keeps everything in one place. That's the chats, agents, memory, tasks and schedules, plugins, the encrypted vault for your secrets, and a separate security console for approvals and the audit log. You install the hub once, then reach it from wherever you are.

### Brains

A brain is what an agent thinks with: the official Claude Code, Codex or Kimi Code CLI, signed in with your own account and plan. You sign in from a card in the chat. Piomio only hands the one-time code to the CLI and never takes or stores its tokens. Each agent has its brains in order of preference: when one hits its plan's limit, the agent carries on with the next. Plain API keys can be brains too, on hubs that turn that on. See [Brains and sign-in](brains.md).

### Agents

A new hub starts with an **Assistant** and a **Researcher**. The assistant is the one you talk to most: it answers, hands longer work to tasks, sets up Piomio for you and makes new teammates when you ask. Each agent has its own name, look, instructions, brains and tools, and you can put several into one group chat. See [Agents and the team](agents.md).

### Plugins and integrations

Much of what agents can do comes from plugins: the browser, memory, reminders and schedules, web search, Telegram, weather and maps. Integrations connect outside services such as Notion or Linear, or Slack, GitHub, Google apps and many more through Composio, an outside service. Usually that's one sentence in the chat ("connect my Notion") and one sign-in. See [Plugins and integrations](plugins.md).

### Your other computers

More computers can join your hub: a laptop, a work PC or a server. Agents can then work with files there and think with that computer's own Claude Code, Codex or Kimi Code. Each computer decides for itself what agents may do on it. See [Machines and other computers](machines.md).

### The apps you talk through

The same chats, cards and approvals are everywhere:

- **The desktop app** for macOS and Windows: it runs the hub in the background and shows it in its window.
- **Any browser**: on the computer that runs the hub, or from anywhere with [Access from anywhere](anywhere.md).
- **Telegram**: replies, notifications and approval buttons on your phone. See [Telegram](telegram.md).
- **The iPhone app**: pairs with your hub through a QR code. See [The iPhone app](phone.md).

## Where to start

First, decide where the hub runs. It should be a computer that's on when you want your agents to work.

| Where | Good for | Guide |
|---|---|---|
| Your Mac or Windows PC | The quickest start: about two minutes, nothing else to install | [Install on a Mac or PC](install.md) |
| A Linux server | Agents that keep working while your computer sleeps; one command | [On a Linux server](server.md) |
| Docker | A server with the strongest isolation between the hub, its brains and plugins | [In Docker](docker.md) |

Then open Piomio for the first time: choose a password, sign in to a brain and meet your assistant. [First run](first-run.md) walks through it. From there the assistant leads the rest of the setup in the chat, one step at a time.

Already use Claude Code, Codex or Kimi Code? It can install Piomio for you: see [Install with your own AI](install.md#install-with-your-own-ai).

## The rest, by topic

**Working with the team**

- [The chat](chat.md): writing to agents, buttons and cards in messages, files, photos and voice.
- [Agents and the team](agents.md): making agents, their look and brains, group chats.
- [Tasks, schedules and the Inbox](tasks.md): work on the side, reminders, schedules, and what reaches you.
- [Channels](channels.md): news feeds that agents collect and edit for you.
- [Pages](pages.md): interactive pages agents make instead of a wall of text.
- [The browser and teach mode](browser.md): the agents' own browser, and showing them a chore once.

**Brains and computers**

- [Brains and sign-in](brains.md): Claude Code, Codex and Kimi Code, limits and backups.
- [Machines and other computers](machines.md): joining computers and servers, and what agents may do there.
- [The iPhone app](phone.md): pairing your phone and approving on it.
- [Telegram](telegram.md): your own bot for chats, notifications and approvals.
- [Access from anywhere](anywhere.md): one private link to your hub.
- [Updates](updates.md): how each kind of install gets new versions.

**Safety**

- [Approvals and auto mode](approvals.md): what waits for your yes, and how to say it once.
- [Security model](security.md): the vault, the security console, the sandbox and the audit log.

**Reference**

- [Plugins and integrations](plugins.md): what's built in and how to add more.
- [Settings and environment variables](settings.md): every setting, and where it goes.
- [Troubleshooting](troubleshooting.md): what to check when something doesn't work.

## A few words used here

| Word | Meaning |
|---|---|
| Hub | Your Piomio: the program that holds the chats, agents, memory and vault. |
| Brain | What an agent thinks with: Claude Code, Codex, Kimi Code or an API key. |
| Agent | A member of your team, with a name, a face, a job and a memory. |
| Task | Work an agent does on the side; its result comes back to the chat. |
| Machine | A computer that has joined your hub, or the hub's own computer. |
| Card | A live block in a message: a sign-in, an approval, a setting, a draft. |
| Vault | Where your keys and passwords are kept, encrypted. Agents only ever see `vault://` references. |

Piomio's source code, issues and releases are on [GitHub](https://github.com/legostin/piomio). For developers there are separate guides in the repository: [writing plugins](https://github.com/legostin/piomio/blob/main/docs/plugins.md) and [adding integrations](https://github.com/legostin/piomio/blob/main/integrations/README.md).
