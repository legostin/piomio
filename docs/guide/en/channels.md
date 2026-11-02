---
title: "Channels: the news feeds agents edit"
nav: Channels
description: A channel is news on a topic you choose, gathered by an agent on a schedule. Setting one up in the chat, how often it posts, what a post holds, reading, changing and stopping it.
---

This page is about news channels: feeds an agent of your team gathers for you. The places where you talk to agents (the desktop app, a browser, Telegram, the iPhone) are covered in [The chat](chat.md), [Telegram](telegram.md) and [The iPhone app](phone.md).

## What a channel is

You say what you want to follow, in your own words: "every morning, collect news about AI and electric cars, skip funding rounds". An agent of the team becomes the channel's editor. At the times you chose it finds what is new, reads each item and posts the gist with numbers, a picture and a link. You read the posts like a feed, in the app and on the phone.

A channel holds:

- **your brief**: what to follow and what to leave out, in your words;
- **the editor**: the agent that gathers it;
- **when**: times of day, and days of the week if you want;
- **sources**: the list of feeds, sites and searches the editor keeps for itself;
- **posts**: what the editor published.

## Setting one up in the chat

Open the **Channels** tab in the sidebar and press **New channel**. A short setup chat opens with the first question already there: "What should the channel follow? Say it in your own words: what you want to know about, and what to leave out."

1. Answer in your own words.
2. The agent asks only what is still missing, one short message at a time: how often (with buttons), and who edits it, if more than one agent fits.
3. It makes the channel and shows its card under the reply. The first gathering starts at once: the channel row says **The editor is finding sources and the first news…**
4. The setup chat stays as the channel's settings chat. Come back to it any time with **Channel settings** on the channel's page.

You can also ask in any agent's dialog: "make a channel about the Almaty housing market, every evening". The card then appears in that dialog. Unless you name another editor, the default agent edits the channel. A setup chat you left without making anything is cleared away the next time the hub starts, once it is a day old.

## How often it posts

A channel gathers at fixed times of day, from one to twelve a day, on every day or only on some days. A new channel gathers at 08:00 and 19:00 every day. Times are in the hub's time zone (**Settings** → **General** → **Time zone**).

The channel's card has quick choices:

| Choice | When |
|---|---|
| **Mornings** | 08:00, every day |
| **Morning and evening** | 08:00 and 19:00, every day |
| **Three times a day** | 08:00, 13:00 and 19:00, every day |
| **Mondays** | 09:00, on Mondays |

For anything else, just say it: "gather at 7:30 and 18:00 on weekdays". A custom schedule shows on the card as its times.

- A time missed while the hub was off is gathered once when it starts again.
- If a gathering is still going when the next time comes, that time is skipped.
- While the editor is in the archive, its channels wait.

Posts are written in the hub's language (**Settings** → **General** → **Language** → **Hub language**).

## What a gathering does

Each gathering is a background task of the editor, titled **Channel “…”**. It shows on the **Tasks** page under **Channels**.

On the first run the editor looks for sources (RSS and Atom feeds first, then sites and searches), saves the list and gives the channel a short name. On every run it:

- collects what is new since the last run and fits your brief;
- opens and reads each item itself, not just the feed's line;
- posts the gist so you need not open the link: the key facts, numbers and names, what changed and why it matters, in two to five sentences or a few bullets, never a teaser;
- adds the link, the source's name and the item's picture.

A few strong items beat many weak ones, and when nothing new is worth it, nothing is posted. The editor doesn't repeat itself: it sees its last 30 posts, the same link is never posted twice in a channel, the same title not twice in a week, and one run posts at most 20 items.

Every gathering of a channel works in the same folder, `workspaces/<editor>/feed-<id>` in the hub's data folder, so scripts and notes the editor keeps there carry over to the next run. A gathering can always read feeds and pages, search and post, whatever the editor's initiative. It never sends you notifications.

## What a post holds

Each post is a title that links to the item, a few lines of text with the gist, a large picture when the item has one, and the source and time. On the channel's page posts are grouped by day, newest first, 30 at a time; **Older posts** loads more.

## Reading channels

In the web UI and the desktop app, the **Channels** tab lists your channels. Each row shows the channel's tile, its name, the latest post's title, the time and how many posts you haven't read. A tile glows while the editor is gathering and turns grey when the channel is paused. A dot on the tab means unread posts.

Open a channel to read it; that marks it read. Under the name you see the editor and when it gathers. While a gathering runs, a line says **The editor is gathering news…**. An empty channel says **Nothing yet. New posts appear here when the editor finds something worth it.**

Ask any agent "what's new in my AI channel?" and it can show posts as news cards right in the chat, with a **Channel** link to the full feed.

On the iPhone, channels are on the **Team** tab under **Channels**, with the same posts, pull to refresh, and a **More** menu with **Gather now** and **Channel settings** (see [The iPhone app](phone.md)).

New posts don't send notifications. The digest lists the last day's headlines of up to six channels, five each, but headlines alone don't make a digest go out (see [Tasks, schedules and the Inbox](tasks.md)).

## Changing or stopping a channel

Say it to the editor or any agent, or in the channel's settings chat:

- "add Electrek to the sources", "skip anything about crypto";
- "only on weekdays", "gather at 7 instead";
- "let Researcher edit it";
- "rename it to Clean energy";
- "pause the AI channel" and later "turn it back on";
- "gather now".

The agent shows the channel's card and changes what you asked. The card has the same controls: the schedule choices, **Gather now**, **Pause** (then **Resume**), and the trash button. The trash button arms on the first tap (**Delete it and its posts?**) and deletes on the second. On the channel's page, the refresh button gathers now and **Channel settings** opens the settings chat; for a channel made in an ordinary dialog it opens the editor's dialog with "Let's set up the channel “…”".

Deleting is done only with the trash button on the card: agents can pause a channel but not delete it. Deleting removes the channel and all its posts. Its past gatherings stay on the **Tasks** page.

If you delete the editor agent, its channels pass to the default agent.

## Channels, tasks and schedules

Channels keep their own schedule. They are not triggers: they don't appear under **Schedules** on the **Tasks** page or on the **Triggers** page, and nothing you change there touches them. Their runs appear under **Channels** on the **Tasks** page.

Use a channel for a steady feed of posts on a topic. For a single report at a set time, a reminder, or an alert when a page changes, ask for a schedule or a watch instead (see [Tasks, schedules and the Inbox](tasks.md)).
