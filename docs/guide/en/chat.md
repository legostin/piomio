---
title: The chat
description: Talking to your agents: messages in a row, the live step line, stopping, buttons and cards, files, photos and voice, the library of everything you sent each other, the hub's own /commands, group chats and their archive.
---

Every agent on your team has one long dialog with you. You write as you would to a person, and the agent answers, asks back with buttons, shows pictures and maps, and sends longer work to tasks on the side. The chat is the same in the desktop app, in a browser and in the iPhone app, which shows the same chat page. Telegram is covered in [Telegram](telegram.md), the phone in [The iPhone app](phone.md).

## Reply to a specific message

Choose **Reply** on your message or an agent’s message. The composer shows the author and a quote; the cross cancels the selection. Send text or an attachment: the quote stays in the chat and reaches the agent as context. Click the quote to open the original, loading older history when needed.

In a group, the quoted agent answers if they are still a member, unless you explicitly `@mention` someone else. Replying to your own message goes to the group lead.

## The sidebar

The sidebar has three tabs: **Agents**, **Groups** and **Channels**. A dot on a tab you are not looking at means something unread there.

- **Agents**: your team. The default agent sits large on top with a star (**Default agent**); its dialog is the start page. Pinned agents come next, then the rest. Each row shows the last message, **Working…** while the agent is busy, and how many messages you have not read. **Add agent** at the end opens a short chat that makes a new one, and **Archive · N** holds the agents you put to sleep. Right-click a row, long-press it on the phone, or use **⋯** for the agent's menu. All of this is in [Agents and the team](agents.md).
- **Groups**: chats with several agents at once (see [Group chats](#group-chats) below). Each group has a menu too, and **Archive · N** at the end holds the groups you put away.
- **Channels**: news feeds an agent edits for you, see [Channels](channels.md).

Below the tabs are **Inbox**, **Tasks** (with a live count of active tasks) and **Settings**. Tasks and the Inbox are covered in [Tasks, schedules and the Inbox](tasks.md).

## Talking to an agent

Type in the field at the bottom and press Enter. Shift+Enter starts a new line. On the phone Return is a new line and the arrow button sends. What you typed but did not send stays in the field when you switch chats.

Opening a chat and starting to type gets the agent's brain ready, so the first reply comes sooner.

### Several messages in a row

You don't have to put everything into one message.

- Messages you send before the agent starts answering reach it together, as one turn.
- If it is already answering, a new message joins the reply in progress: the brain takes it at its next step, and the answer goes on in a new message under yours. A brain that cannot take input mid-turn gets it as the next turn instead.
- Every agent is a front desk. It answers quick things itself and sends anything with steps (research, code, checking, long writing) to a task on the side, then says in one line what it started. The dialog stays free, and you can keep writing. How tasks work is in [Tasks, schedules and the Inbox](tasks.md).
- Your own dialogs never wait in line. Tasks and messages between agents do wait when a brain is busy (**Parallel sessions per brain** in **Settings** → **General**).

### The live step line

While the agent works, a short line under its name says what it is doing now, in place of typing dots: **Reading plan.md**, **Running: npm test**, **On the web…**, **Starting a task…**, **Writing to a teammate…**. **Waiting for your permission** shows in amber when an action needs your yes (see [Approvals and auto mode](approvals.md)). When the words of the reply start to flow, the line gives way to them.

### Replies to your message

When a task finishes after you have already written about other things, the agent's report comes as a reply: a quote of your original request sits above it. Tap the quote (**In reply to your message: show it**) to jump to that message.

### Stopping

While an agent answers, the send button turns into **Stop**. It stops the reply in progress. In a group chat the members still waiting for their turn don't answer either. If there is nothing running you see **Nothing to stop**.

Stop does not cancel tasks the agent already started. Say "stop that" and the agent cancels the task, or press **Cancel** on the task's page.

### Show steps and the model badge

The **⋯** menu in the chat's top bar has **Show steps**. With it on, the chat also shows tool calls and service messages, which are hidden by default. In an agent's dialog the same menu has **Agent settings**.

A small chip after the time of each reply (**How this reply was made**) shows which **Brain**, **Model** and **Effort** answered when you tap it.

## Buttons and cards

### Quick replies

When the answer is one of a few clear options, the agent puts buttons under its message: "Mornings", "Twice a day", "Yes". A tap sends the option's words as your message, and the buttons settle on your pick. You can always type something else instead.

### Live cards

Many things appear as cards inside the agent's messages, and the cards change in place as things move on:

- a task line with its status and current step (tap it to open the task);
- a new agent's draft while you shape it together, with **Create agent**;
- a channel's card with how often it posts, **Gather now** and **Pause**;
- approval cards with **Allow**, **Deny** and **Always allow this**;
- sign-in cards for a brain or a service, a card asking for a key that goes straight into the vault, a page the agent made.

Whatever a card does, you can also say in words in the chat.

## What agents show

### Formatting

Replies are Markdown: headings, lists, tables, links and code blocks with a Copy button. Raw HTML is shown as plain text, never run.

### Pictures and carousels

An agent can show pictures right in the chat: one picture as a card, two to ten as a carousel you swipe. Tap one to open it full screen. Pictures a task shows also reach the dialog that started the task.

The hub loads every picture for the chat itself, so a picture's address reaches its site as soon as you see it. After the agent has read outside content (a web page, an email), a picture whose address it put together itself doesn't load on its own: the address could carry data from the chat to that site. In its place is a quiet line, **Picture from** and the site, with **Show**: tap it and the picture loads, from then on everywhere. Pictures from what the agent read, from your own messages and plain addresses on sites you named load as usual. A news card, a channel post or a page cover just leaves such a picture out.

### Maps and routes

For places, addresses and directions the agent shows an OpenStreetMap map: places with symbols and short notes, and a route through them. Walking, driving and cycling routes follow real roads and paths and show length and time; public transport is drawn as straight lines.

- In the chat the map ignores scrolling until you click it, so the chat scrolls past it. Zoom buttons appear once you use it.
- **Full screen** shows the list of places.
- **Open in…** opens the place or the route in **Apple Maps**, **Google Maps** or **OpenStreetMap**. The **Yandex Maps and 2GIS** plugin, on by default, adds those two apps.

News cards from channels and pages agents make are described in [Channels](channels.md) and [Pages](pages.md).

## Files, photos and screenshots

There are three ways to send a file:

- the paperclip (**Attach files**) next to the field;
- paste: a screenshot or a copied file goes in as an attachment;
- drop files anywhere on the chat (**Drop files here to send them**).

Files upload at once, with a progress bar on each chip. A failed one gets a retry button; any of them can be removed before you send. You can send up to 10 files per message, each up to 25 MB, with or without text.

### Mark up a picture before sending

A picture waiting in the field has a pen button (**Mark up**). It opens the picture full screen with **Pen**, **Highlighter**, **Arrow**, **Frame**, **Oval** and **Text**, six colours, three thicknesses, **Undo** and **Redo**. **Done** replaces the picture with the marked-up copy, and the chip says **marked up**.

### Where files go

A file you send is saved in the agent's folder for that chat, in the hub's data folder: `workspaces/<agent>/<chat>/attachments/`. The agent gets its path and can open it with its own tools. When the agent thinks on another computer, that computer takes the file from the hub before the agent starts. A file over 50 MB comes with the hub's file sync instead, within seconds; only one over 200 MB stays on the hub.

### The media viewer

Tap a picture or a video in the chat to open the viewer. It holds all the chat's pictures and videos:

- pinch, the mouse wheel or a double tap zooms, and a drag moves a zoomed picture;
- swipe or the arrows go to the next item, and a drag down or **Close** closes it;
- **Download** saves the file (the desktop app puts it in Downloads, the iPhone app opens the share sheet), and **Open the original** opens the file itself.

Other files show as a chip that opens the file.

### The library

Everything you and an agent sent each other gathers in its library: photos and videos, voice messages, documents and other files, the pictures it showed and the pages it made. It covers the agent's dialog, its tasks and the group chats it is in, newest first, and comes from the hub, so it is the same on the computer, in a browser and on the phone.

- Open it with the library button next to **⋯** in the agent's chat.
- **All** shows a shelf of each kind; **Pages**, **Photos and videos**, **Files** and **Voice and audio** show all of one kind. The search field finds words in names, captions and what a voice message said.
- A picture or a video opens in the viewer, a page full screen, a file in the browser (the iPhone app opens the share sheet), and a voice message plays in place.

The agent has the same library. Ask "send me the contract from last week again" or "what did I send you on Monday": it finds the file, opens it in its folder to work on it, or sends it back to the chat. Documents and other files an agent makes reach you as files in the chat (and in Telegram), and stay in the library even if the agent later changes its own copy.

### What your device keeps

The chat shows a small copy of each photo or screenshot, which the hub makes once; the picture itself loads only when you open it in the viewer. Your device also keeps the latest messages of the dialogs you opened, the team, the group chats and those small copies, so a chat opens at once, even before the hub answers, and the hub's answer replaces what was kept. Signing out removes it all.

**Clear cache** removes what this device keeps; you stay signed in. It is in **Settings** under **General**, in the command palette, in the desktop app's menu bar (tray) menu and in the iPhone app's **Hub** tab.

## Voice messages

Voice messages and audio files are turned into text before the agent answers. The words appear under the voice message, and the agent reads them like a typed message.

- Telegram voice notes and audio files you attach are transcribed this way.
- The mic in the iPhone app is different: hold it while you speak, let go, and the phone's own dictation sends your words as text. It needs no setup.

### Set up speech to text

Say "set up voice messages". The assistant asks for a Groq or OpenAI API key with a card that saves it straight into the vault. Groq has a free tier. Once a key is in the vault, voice messages work.

The same lives in **Settings** → **General** → **Voice**. Under **Speech to text** you pick one of these:

| Option | What it uses |
|---|---|
| **Automatic: OpenAI or Groq if the vault has a key, else this computer** | The default. OpenAI first, then Groq, then the local engine once it is installed |
| **This computer (free, offline)** | The hub's own engine: **Install** downloads it (GigaAM v3 for Russian, Parakeet TDT v3 otherwise), see [the local speech engine](settings.md#the-local-speech-engine). It hears WAV recordings only, not Telegram's voice notes |
| **Groq (has a free tier)** | `groq_api_key` in the vault, model `whisper-large-v3-turbo` |
| **OpenAI** | `openai_api_key` in the vault, model `gpt-4o-mini-transcribe` |
| **My own server (OpenAI-compatible)** | **Server address** (up to `/audio/transcriptions`, for example a local Whisper at `http://127.0.0.1:8000/v1`), a **Model** and, if it needs one, a **Key in the vault** (`vault://…`) |
| **Off** | Nothing is transcribed |

**Model** is optional for Groq and OpenAI. The line under the choice says **Working now: …** or **Not set up: voice messages reach the agent as audio files**. When nothing is set up, the agent gets the audio file and offers to set it up.

Limits: recordings longer than 10 minutes and files over 25 MB are not transcribed on their own. The agent can still transcribe a long one if you ask.

## The hub's own commands

Type `/` at the start of the field to see the commands. These six are answered by the hub itself, at once and without the model. The exception is `/schedule`, which goes to the agent as a request.

| Command | What it does |
|---|---|
| `/task <what to do>` | Starts a task for this chat's agent and shows its task line. `/task find three flats near the park` |
| `/goal <what to reach>` | A long goal: the agent works toward it round after round on its own until it is reached. `/goal` alone shows the open goal |
| `/schedule <when and what>` | Asks the agent to set up a recurring schedule or a one-time reminder. `/schedule` alone lists what you have |
| `/brain [name]` | Shows what the agent thinks with, or switches its brain in this chat: `/brain codex` |
| `/effort [level]` | Shows or sets how deeply it thinks: `auto`, `fast`, `balanced`, `deep`, or one of the brain's own levels such as `high` |
| `/archive` | Shows a card to put the agent in the archive |

A chat has one goal at a time; a new `/goal` replaces the open one. `/goal pause`, `/goal resume` and `/goal clear` control it, and a goal pauses by itself after 20 rounds and tells you. More in [Tasks, schedules and the Inbox](tasks.md).

Picking a command that needs words puts it in the field; the others are sent at once. Sent from Telegram, a command's answer comes back as text with a link to the chat. In a setup chat the hub doesn't answer commands.

Other names in the list are commands from skills and plugins: a Markdown template that becomes the request the agent gets, with `$ARGUMENTS` replaced by the words after the name. Your own go in `commands/<name>.md` in the hub's data folder. They are listed under **Settings** → **Skills & commands**.

## Group chats

A group chat is you with two to eight agents of your team. The first member leads.

Say "make a group with Researcher and the assistant for the trip plan" in any agent's dialog, and the group appears in the **Groups** tab. Ask in the group itself to rename it, add or remove someone, or change who leads. The same is in the form behind **New group** in the **Groups** tab (**Name**, **Members**, **Lead**) and behind the group's name in its header (**Group settings**). The tab needs at least two agents on the team.

### Who answers

- A message that mentions nobody goes to the lead.
- `@name` (an agent's id or name) asks that member; mention several and they answer one after another, in that order.
- `@all` (or `@все`) asks everyone, each in turn.
- An agent can hand the floor to another by mentioning them in its reply. There are at most three hand-offs per message of yours, so agents can't pass the floor around forever.

The header shows who is answering now and who is next (**Researcher is answering… · then Assistant**). **Stop** ends the whole round.

Each member reads what others said since its own last reply, up to the last 40 messages, and longer messages are trimmed. In a group, `/task`, `/goal` and `/schedule` go to the lead; `/brain`, `/effort` and `/archive` belong in an agent's own dialog.

> Group chats live in the web UI, the desktop app and the iPhone app. They are not mirrored to Telegram: only the default agent's dialog is.

In an agent's own dialog `@` works too: it offers your teammates, and the agent writes to the one you name and tells you the answer.

### Archive and delete

Every group has a menu in the **Groups** tab: right-click it, long-press it on a touch screen, or use **⋯**. It has **Mark unread**, **Group settings**, **Archive** and **Delete**.

**Archive** puts the group away. It leaves the **Groups** tab, the round in progress and the tasks started there stop, and nobody can write in it. Its messages stay. Archived groups wait behind **Archive · N** at the end of the tab; an archived group's chat shows **“Name” is in the archive** with **Restore** in place of the message box.

**Delete** is for good: the chat goes with all its messages and the tasks started there. The confirmation offers **Archive instead**.

The same works in the chat: ask the group's members or any agent ("put the trip group in the archive", "bring back the trip group", "delete the Scratch group"). An agent deletes a group only after you confirm on a card.
