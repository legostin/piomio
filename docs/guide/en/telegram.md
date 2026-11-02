---
title: Telegram
description: Talk to your agents in Telegram: create a bot, connect and link it, what arrives there, what you can send, the bot's commands, and how to unlink it.
---

Telegram is one more way to reach your team. Replies, notifications, the digest and approval cards come to your
phone, and you can write, send photos, files and voice messages, or share a place. The bot is your own: you create
it, and it answers only your private chat with it.

Your hub doesn't need a public address for this: it asks Telegram for new messages itself, so the bot works from a
laptop at home too.

## Create a bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Pick a name, then a username that ends in `bot`.
3. BotFather answers with a token like `1234567890:AA…`. Copy it.

## Connect it

Say "connect Telegram" in the chat. The assistant shows Telegram's card:

1. Paste the token into **Telegram bot token** and press **Save to vault**. It goes straight into the encrypted vault
   (as `telegram_bot_token`); the assistant never sees it. Pasting the token into a chat message works too: the hub
   recognises it, takes it out of the message and stores it.
2. The bot connects by itself. The card then says: "Last step: open @your_bot in Telegram and tap Start — the chat
   links itself."
3. Press **Open the bot in Telegram**, then **Start** in Telegram. The bot answers "Done — this chat is now linked to
   Piomio."

If the button doesn't suit you, send the bot the command the card shows, `/start` and a six-digit code. **New code**
makes another one.

The same card is in **Settings → Plugins → Telegram → Connection**. Its badge shows the state: **Connected**,
**Waiting to be linked**, **No token**, **Token rejected** (replace the token), **No connection** or **Connecting…**.

### Only your chat

The bot links to exactly one private chat: the one the code came from.

- A group can't be linked: the bot says only a private chat can.
- Anyone else who writes to the bot gets one polite "this bot is personal" reply, and nothing else.
- After five wrong codes from one chat, linking from that chat is blocked; after twenty wrong codes in all, the code
  changes.

## Who answers

In Telegram you talk to your **default agent**, in the same conversation as its chat in the app. It can hand work to
teammates as usual (see [Agents and the team](agents.md)). To change who answers, say "make Anna the default agent",
or pick **Default agent** in **Settings → General**.

Replies to what you type in that agent's chat in the app also go to Telegram, with your words quoted above them
("You, in the web app:"), so Telegram reads as one conversation. Say "stop sending my web chat replies to Telegram" to
turn that off. Other agents' chats and group chats are not mirrored to Telegram.

## What comes to Telegram

- **Replies**, with formatting: bold, italics, lists, links, quotes and code. Headings turn bold, a table becomes an
  aligned block, and a long reply is split into several messages. While the agent works, Telegram shows "typing…".
- **Pictures** from a reply arrive as a photo or an album of up to ten. A large picture comes as a file. What Telegram
  won't take arrives as links.
- **Maps** arrive as a location pin with the place's name.
- **Notifications**, with the title in bold. Those from your reminders and watches have buttons: **👍 Useful**,
  **🔉 Less often** and **🔕 Turn off**. In quiet hours they come without a sound.
- **The digest** (see [Tasks, schedules and the Inbox](tasks.md)).
- **Approval cards** with **✅ Approve** and **❌ Deny**. After your tap the message shows the outcome; if you already
  answered elsewhere, it says so.

Notifications and the digest also get an **Open** button when the hub's address (`PIOMIO_PUBLIC_URL`) is a public https
address, and approval cards an **🔐 Open the console** button when the console's (`PIOMIO_CONSOLE_URL`) is. See
[Settings and environment variables](settings.md).

An approval card in Telegram is short by default: which agent asks and which action, plus a link to the security
console with the details. To see the full details in Telegram, turn on **Show details in Telegram** in **Settings →
General**. More in [Approvals and auto mode](approvals.md).

[Pages](pages.md) and other cards stay in the app: Telegram gets the agent's words.

## What you can send

Write as you would in the app. You can also send:

- **Photos, albums, files, videos and audio.** An album goes to the agent as one message. Files land in the agent's
  working folder.
- **Voice messages.** The hub writes them down before the agent answers, once speech to text is set up; the first
  time, the assistant offers to set it up (see [The chat](chat.md)).
- **Places**: a location or a venue reaches the agent with its name, address and coordinates.
- **Forwarded messages and replies.** The agent learns where a forwarded message came from and what your reply
  answers.

Telegram lets bots download files up to 20 MB. For a bigger file the bot says so: send it in the app instead. Stickers,
polls and contacts don't get through.

If you paste a key or a token into a message, the hub moves it into the vault and the bot deletes your message, so the
secret doesn't stay in the chat. If Telegram doesn't allow the delete, the bot asks you to delete it yourself.

## Commands

| Command | What it does |
|---|---|
| `/tasks` | Tasks in progress and the five that finished last, with their status. |
| `/stop` | Stops the assistant's current work. |
| `/help` | A short help. |

The bot's command menu shows these in the hub's language. Other commands, like `/task` or `/goal`, go to the assistant
as in the app (see [The chat](chat.md)). Everything the bot writes is in the hub's language.

## Unlink or turn it off

- **Unlink the chat:** ask the assistant to show Telegram's setup, or open **Settings → Plugins → Telegram →
  Connection**, and press **Unlink**. The bot tells the old chat it was unlinked and makes a new code, so you can link
  another chat.
- **Replace the token:** **Replace** next to the token on the same card. Do this after you revoke the token in
  BotFather.
- **Turn Telegram off:** "turn Telegram off", or the switch on its page in **Settings → Plugins**.

## Settings

The Telegram plugin's **Settings** hold the vault reference to the token and **Bot API address**. Change the address
only if you run your own Bot API server; it is usually `https://api.telegram.org`.
