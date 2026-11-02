---
title: First run
description: What happens the first time you open Piomio: the password, signing in to a brain, meeting your assistant and the rest of the setup in the chat.
---

The first run takes a few minutes and happens almost entirely in the chat. You choose a password, give the assistant a brain, and then it introduces itself and leads the rest of the setup one step at a time. Nothing here needs a terminal on the desktop app. On a server you need one code from the installer.

## 1. Choose a password

### In the desktop app

After you pick **A new Piomio on this computer** (see [Install on a Mac or PC](install.md)), the window shows **First run** and asks only for a **New password** (at least 8 characters) and **Repeat the password**. Press **Save and sign in**. The app has already passed the setup code along, so there's nothing to copy.

From then on the app's window signs itself in. You type the password only in another browser, on `http://localhost:41780`, or on your phone.

### On a server or in Docker

Open the chat (on a server that's usually `http://localhost:8080` through the `ssh -L` line the installer printed). The **First run** form asks for the **Setup code** too. It proves you are the person who installed the hub, so nobody who finds the page first can claim it.

Where the code is:

| Install | Where to find the setup code |
|---|---|
| Server, with `install.sh` | The installer prints it at the end (`Setup code: …`). Lost it? `sudo -iu piomio cat ~/.local/share/piomio/setup-code` |
| Docker | In the log: `docker compose logs piomio \| grep -A1 "Piomio:"` (or `docker logs piomio`) |
| Any hub | The log line `Piomio: first run. Open … and enter the setup code: …` |

On a server the code stays the same until someone sets the password. In Docker a new one is made at every start until then, so take it from the latest log, or set your own in advance with `PIOMIO_SETUP_TOKEN`. More in [On a Linux server](server.md) and [In Docker](docker.md).

Forgot the password later? On a server run `piomio reset-password <new-password>` as the user Piomio runs as; in Docker, `docker exec piomio piomio-entrypoint reset-password 'new-password'`. You can also add passkeys later, which sign you in without a password (see [Security model](security.md)).

## The hub language

The interface language on the first-run screen becomes the **hub language**: your browser's language, or the one you pick with the switch under the form. Piomio uses it for notifications, Telegram messages, approval cards and its own messages. Agents answer in the language you write to them.

To change it later, say so in the chat ("switch the hub language to Russian"), or go to **Settings** → **Language** → **Hub language**. Each browser can also keep its own **Interface language in this browser** without changing the hub's. If the server sets `PIOMIO_LANG=en` or `PIOMIO_LANG=ru`, that language wins at setup (see [Settings and environment variables](settings.md)).

## 2. Give the assistant a brain

Until some brain works, Piomio shows only your assistant: **Hi! I'm your assistant**, and a card with a row for each brain this computer can use: Claude Code, Codex and Kimi Code.

- **Sign in** on a row starts that CLI's own sign-in. You sign in on the maker's page with your own account and plan. For Codex and Kimi Code you type a one-time code from the card on that page; for Claude Code you copy the code the page shows and paste it back into the card (not into the chat). The row turns green once it works.
- **Install and sign in** appears where the CLI isn't installed yet and the hub can install it (the desktop app and a server installed with `install.sh`). It's a one-time download of a few hundred MB, then the sign-in starts.
- **Check again** looks for CLIs again, for example after you installed or signed in to one in a terminal. The hub also looks by itself every 30 seconds while no brain works, so a sign-in you finished over SSH shows up within a minute.

One working brain is enough. Piomio never takes or stores the CLIs' tokens: each CLI keeps its own sign-in on the computer it runs on. Details, and how to sign in on a server: [Brains and sign-in](brains.md).

> Plain API keys (Anthropic, OpenAI, OpenRouter or your own OpenAI-compatible server) can be brains too, but only on a hub started with `PIOMIO_API_KEYS=1`. Then the card also has **Or an API key: Anthropic, OpenAI, OpenRouter, your own server**. Without that setting, the card offers only the CLIs.

If a brain stops working later (signed out, uninstalled), the same card shows up in the chat. Whatever you write meanwhile waits, and the assistant answers it as soon as a brain works again, within a day.

## 3. Meet your assistant

As soon as a brain works, the app opens on your assistant's chat and the assistant speaks first. A new hub has two agents: the **Assistant** and a **Researcher**. The assistant leads the introduction itself, one short question at a time, and you mostly answer with buttons:

1. **Its name.** It asks what you'd like to call it and offers three or four names as buttons. Pick one or type your own.
2. **Its look.** A profile card shows up in the chat with its avatar and how proactive it is. Change them on the card, or just tell it.
3. **How it talks to you.** Formal or casual, short or detailed answers, a character. What you say goes into its instructions.
4. **Your team.** It asks who else should join right away and suggests three or four roles that would help you (a secretary, a programmer, a finance helper…), plus "nobody for now". For each one you pick, it shows a card with the new teammate's name and description, rewrites it when you correct it, and creates the agent on your yes.

Say "not now" to skip any of these. More about agents and teams: [Agents and the team](agents.md).

## 4. The rest of the setup

After the introduction, the assistant still has a few things to offer. It brings them up when they fit, after answering whatever you asked, one at a time, and starts each only when you agree:

| Step | What happens |
|---|---|
| Telegram | Chat, notifications and approvals on your phone. You make a bot with @BotFather, and a card in the chat takes its token. See [Telegram](telegram.md). |
| A backup brain | When a second CLI is installed (or can be), it offers to sign it in too, so agents carry on when the first one hits its limit. See [Brains and sign-in](brains.md). |
| Other computers | A card with a one-time link to open on another computer or server, so agents can work there. See [Machines and other computers](machines.md). |
| Getting to know you | How to address you, your language, what you want help with. It keeps each fact in memory. |

Say "not now" and that step is put aside: the assistant won't bring it up again. Say "let's continue the setup" any time to get back to what's left. A step counts as done by itself when you've already done it some other way, such as connecting Telegram from **Settings**.

Whenever a step needs a token, key or password, the assistant shows a secure field in the chat instead of asking you to paste it into a message. The value goes straight into the encrypted vault; the model only ever sees a `vault://` reference. The first time, the card asks you to create the vault: **First, create the vault**, with a passphrase of 8 characters or more that only you know. See [Security model](security.md).

## What to try first

Just write the way you would to a person. Several things in one message are fine. Some ideas:

- "Remind me to call the dentist tomorrow at 10." A reminder, set right away. See [Tasks, schedules and the Inbox](tasks.md).
- "Compare three laptops under $1,500 for programming." Anything with steps becomes a task on the side, and the answer comes back as a reply to your message.
- "Every morning, collect news about electric cars." An agent starts a news channel and edits it. See [Channels](channels.md).
- "Make a page for Saturday's walk in the park." An interactive page right in the chat. See [Pages](pages.md).
- "Connect my Notion." A card shows up and you sign in once. See [Plugins and integrations](plugins.md).
- Show an agent a chore in its browser once, and it can do it again later. See [The browser and teach mode](browser.md).

Anything an agent sends or buys on your behalf waits for your tap on a card first. See [Approvals and auto mode](approvals.md). More on how the chat works: [The chat](chat.md).
