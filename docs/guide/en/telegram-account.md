---
title: Your Telegram account
nav: Telegram account
description: Connect your own Telegram account so agents can read the chats you open to them: the QR sign-in, read only or sending too, which chats agents see, and how to disconnect.
---

This connects your own Telegram account, not a bot. Your agents can then read the chats you open to them, find
messages, fetch attachments and, if you turn it on, write for you. It is separate from [the Telegram bot](telegram.md),
which is how you talk to your team from Telegram.

It starts as closed as it can be: read only, with no chat open. You open what you want agents to see.

## Connect

Say "connect my Telegram account" in the chat. The assistant turns the integration on and shows its card:

1. Press **Connect**. A QR code appears.
2. In Telegram on your phone open **Settings → Devices → Link Desktop Device** and point the phone at the code. The
   code changes every half a minute.
3. If your account has two-step verification, the card asks for its password. It goes to Telegram once and is kept
   nowhere; agents never see it.

The card then shows your name and **Connected**. Telegram lists the session as **Piomio** in **Settings → Devices**.

The same card is in **Settings → Plugins → Telegram account**, and the assistant shows it again whenever you ask
("show my Telegram account").

The session's key is kept in the encrypted vault (as `telegram_account_session`), never in settings or in a chat. So
the vault comes first: on a hub that has none yet the card says **No vault yet** and asks for a passphrase to create
it; when the vault is locked it says **Vault locked** and asks for the passphrase. After that the card goes on by
itself, and a connected account comes back by itself once the vault is open.

> The app's Telegram keys come with official releases. A build made from the source without them shows **Not
> available** on the card.

## Read only, or sending too

Under **What agents may do**:

- **Read only** (the default): agents can't send anything. They don't even have the tool for it.
- **Read and send**: agents can write from your account, to chats that are open to them. Each message waits for your
  yes on an approval card that names the chat and the text. Auto mode never answers for you here: a message to
  people is always yours to approve. **Always allow this** on the card makes a rule for that chat and that agent.

When an agent needs to send while sending is off, it asks you on a card in the chat with **Allow** and **Not now**.
It can't switch the mode itself.

Reading marks nothing as read and shows no "typing…".

## Which chats agents see

Under **Chats agents may see** there is a switch for each kind: **Private chats**, **Groups**, **Channels** and
**Bots**. All four are off after you connect.

Under **Exceptions** you open or close single chats whatever their kind. Type a name into **Find a chat to open or
close…** and press **Open** or **Close**:

- **Always closed** wins over everything. Use it for chats you never want agents in, and then open the kind.
- **Always open** opens one chat while its kind stays closed.
- **×** puts a chat back to what its kind says.

Two chats have rules of their own:

- **Telegram's service chat**, where sign-in codes arrive, never opens.
- **Saved Messages** stays closed when you open private chats. It opens only as an exception.

A chat that is not open does not exist for agents: it is not in their lists, a search skips it, reading it by name
or id answers "no such chat", and its new messages start nothing. You see all your chats in the finder; agents never
do.

In the chat you can just say "open the Family chat to agents". The agent shows a card with the chats that name fits
and an **Allow** button next to each; only your tap opens one. The agent is not told which chats the name matched.

## What agents can do

- Tell you what is new in one go: the open chats with unread messages and what was written there. Chats you muted in
  Telegram are left out unless you ask for them. Reading marks nothing as read.
- List the open chats, each with its last message, and read their messages.
- Find messages by words, in one chat or in all the open ones.
- Bring an attachment (a photo, a file, a voice message) into their folder, up to 40 MB.
- Send text and files, in the **Read and send** mode, with your approval each time.
- React to a new message: a trigger can start on "A new Telegram message" in an open chat. See
  [Tasks, schedules and the Inbox](tasks.md).

What agents read in Telegram was written by other people, so the hub treats it as outside content: see
[After outside content](approvals.md#after-outside-content).

A long message's approval card shows its beginning; the security console shows the whole text.

Telegram limits how often an account is asked, so Piomio asks it no more than once in three seconds. Right after you
connect, the list of a large account's chats takes up to a minute to load; after that it is kept. If Telegram still
asks to wait, the agent tells you how long and asks nothing more until then.

## Disconnect

- **Disconnect** on the card ends the session in Telegram, deletes its key from the vault and puts the mode back to
  **Read only**. Your choice of chats is kept for the next time.
- You can also end the session from Telegram: **Settings → Devices**, then the **Piomio** session. The card then says
  **Disconnected in Telegram**, and agents can't read anything until you connect again.
- "Turn the Telegram account off", or the switch in **Settings → Plugins**, turns the whole integration off. The
  session stays signed in until you disconnect.
