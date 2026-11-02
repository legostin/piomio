---
title: The browser and teach mode
nav: Browser and teach mode
description: The agents' own browser: which browser it is, the live view where you watch and take over, tabs, search and history, signing in to sites, web search, and teaching an agent a task by showing it once.
---

Your agents have a browser of their own. They open sites, read pages, fill in forms and press buttons in it, and you
can watch every step and take over at any moment. You can also show an agent a task once, talking as you go, and it
learns to do it for you.

## Which browser it is

- **Google Chrome, when the computer has it.** Otherwise Piomio downloads Chromium once, the first time an agent needs
  a browser: the live view shows **Installing Chromium**, and the agent's step waits for it.
- **Its own profile.** Sign-ins and cookies stay between runs, in the hub's data folder
  (`plugins-data/browser/profile`). It is not your everyday Chrome: your own sign-ins and bookmarks are not in it.
- **No window of its own** on a Mac or a PC: you see it in the live view. On a Linux machine with a display (`DISPLAY`
  set, Xvfb too), it runs with a window. The **Headless mode** setting changes that.
- It closes after 30 minutes without use and starts again when an agent needs it.

The browser's settings are on its page: **Settings → Plugins → Browser → Settings**. You can also ask in the chat:
"switch the browser's search to Yandex", "let the browser open local addresses".

## Watch and take over

When an agent works in the browser, the live view opens by itself in a corner of the window, showing the page and the
agent's current step. After the work stops it shrinks to a small pill. **Browser** in the sidebar opens it at any time,
**Expand** makes it a full browser, and you can drag the small window to another corner.

- **Take control** hands the page to you: your clicks and keys go to it, and the agent waits. Use it to pass a
  captcha, sign in yourself or fix something. **Return control to the agent** gives it back.
- When an agent hits a captcha, the live view says **Needs you** and asks you to take control and pass it.
- What you do while an agent waits reaches that agent with its next step, so it carries on from where you left off.

### Tabs, the address bar and history

- **Tabs** look like Chrome's on a wide screen and like a list of cards on a phone. A **New tab** shows a search field
  and the sites opened most often. Each agent works in a tab of its own, so two agents never take each other's page.
- **The address bar** takes an address or words to search for. Words go to DuckDuckGo unless you pick Google, Yandex
  or Bing in **Search engine for the address bar**. While you type, it suggests open tabs and pages from the history.
- **History** lists pages by day with the time and who opened them (you or an agent). You can search it, delete a page
  or **Clear history**. It is kept for 90 days. Agents can look in it too ("that site I had open yesterday") and clear
  it only after you approve on a card.
- The **More** menu (⋯) has **Copy link**, **Open in your browser** and **Teach the agent**.

### On the phone

The live view becomes a phone browser: the address on top, the buttons at the bottom, **Take over** and **Hand back**.
Tap to click, drag to scroll, pinch to zoom up to 4× (only on your screen: the page and the agent don't notice), and
**Back to 100%** to reset. When you tap a text field, the keyboard comes up by itself; the **Keyboard** button opens
it otherwise.

### Files from you

If a page asks for a file while you are in control, a bar says **The page asks for a file**. **Choose a file…** opens
your own computer's files or your phone's photos and sends what you pick to the page, up to 25 MB per file.

## How it behaves toward sites

The agents' browser is an ordinary browser, not a scraper. It doesn't announce itself as automated, it has a real
window size, and without a window it doesn't call itself headless. It also plays fair: it doesn't solve captchas or
try to get around a site's checks.

- Many "checking your browser" pages pass by themselves; the agent waits up to 12 seconds for them.
- On a real captcha the agent tries another site that answers as well, or asks you to take over. Once you pass a
  check, the profile usually keeps it.
- By default it can't open addresses of the hub's own computer or your local network (`localhost`, `192.168.*`,
  `10.*`). **Allow the agent to open local addresses** lifts that.
- What a page says is outside content: agents don't take orders from it (see [Security model](security.md)).

## What runs by itself and what asks you

Opening pages, reading, scrolling, screenshots, ordinary clicks (links, tabs, menus, checkboxes) and typing run by
themselves. A step with consequences asks first:

- **Buttons that act:** buy, pay, order, send, post, delete, unsubscribe, book, confirm, a form's submit, in any
  language. The card shows the site, the button's name and what will happen. If another site is open by then, or the
  button changed its name since you allowed it ("Pay $5" became "Pay $500"), nothing is clicked.
- **Uploads:** the card lists the files and the site.
- **Downloads** go to the agent's working folder, up to 200 MB (**Maximum download size, MB**).

If you asked for exactly that action in your own words ("delete those two records"), the hub checks your words against
the button and the site and runs it without a card; the chat shows a quiet **you asked** line instead. Anything that
spends money asks every time. More in [Approvals and auto mode](approvals.md).

## Sign in to sites

Say "sign in to my account on example.com". The agent shows a secure card with **Username, email or phone** and
**Password**. What you type goes straight into the encrypted vault, for that site only: the browser types it there,
and the agent never sees it. Moving through the sign-in steps (Next, Log in) needs no approval.

In the security console's vault you can also add a **TOTP secret (2FA)** to a login: the browser then types the
current one-time code too. Or simply take control and sign in yourself: the profile keeps you signed in.

## Web search

Agents search the web with the Web plugin:

- **With a search API**, the search goes there: a Brave Search or Tavily key, or your own SearXNG server. With several,
  the first one set up wins, in that order.
- **Without one**, the search goes through the agents' browser, as you would search: DuckDuckGo first, then Bing,
  Google and Yandex if one shows a captcha or nothing. The results page stays open, so the agent can read answer boxes
  like the weather or traffic.

The keys go into **Settings → Plugins → Web → Connection** (**Brave Search API key**, **Tavily API key**). The SearXNG
address and the choice of engine are in the Web plugin's **Settings**; a SearXNG on your own network also needs the hub
to be allowed to reach it (see [Settings and environment variables](settings.md)).

## Teach mode: show a task once

### Show it

Say "let me show you how I order water on 5vodi.kz", or pick **Teach the agent** in the browser's **More** menu (then
the default agent gets it and asks what it was for). The live view opens with control in your hands and a bar on top:
what you are showing, the steps so far, the microphone, Highlight, **Done** and **Cancel**.

- **Do it the way you always do.** Clicks, typing and pages are recorded. Passwords and codes never are.
- **Talk.** Your words are written into the recording. That needs speech to text set up (see [The chat](chat.md)) and
  a microphone; without them you show without voice, and the agent asks about the why afterwards.
- **Highlight a part of the page** to point at what matters: draw a frame around the total, the right size, the
  delivery date.
- Press **Done**. The recording goes to the agent's chat, with pictures of what you framed in its working folder.

### From the recording to a skill

The agent retells what it saw in a few lines and asks only what is unclear, with buttons for short answers: what
changes each time (the quantity, the address) and what stays. For each step with consequences it asks whether it may
do it without asking next time, and up to what amount: "Place the order without me if the total is under 3,000 ₸?"

Then it shows a card: **Save the skill «order-water-5vodi»**, with every click it may make without asking listed on
it ("Without asking: «Place order» on 5vodi.kz, up to 3,000 KZT"). Tap **Allow**: nothing is saved without your tap.

A skill is instructions the agent follows with understanding, not a replay of your clicks: it finds buttons by their
names, checks what you pointed at, and asks when something looks different. Skills you teach are kept in the hub's
data folder, under `skills/`.

### Run it later

- **Ask:** "order water, three bottles". The agent follows the skill and asks for anything it can't know.
- **Pre-approved clicks** run without a card only within the limit, and only when the amount is on the page. Above it,
  you get a card as usual.
- **On a schedule:** "do it every Friday at 10". The scheduled run clicks and types by itself; steps with consequences
  still need the limit you approved or your tap. See [Tasks, schedules and the Inbox](tasks.md).

When the site changes and the agent gets stuck, it asks you to take over or to show that one step again. Afterwards
it offers to update the skill, and you confirm on a card again.

### Who on the team has it

A taught skill belongs to the agent that learned it. To share it, say "give the water skill to Anna too" or "let
everyone use it"; to drop it, "forget the water skill". **Settings → Skills & commands** shows who has each skill
(**Whole team** or the names), and you change that in the chat. More in [Agents and the team](agents.md).

### Routines Piomio notices

With **Remember what I do in the browser** on (the default), what you do in the agents' browser by yourself is kept
for 30 days, only on the hub, without passwords, codes or card numbers. When you do the same thing on the same site
three times, or twice on different days, the assistant offers to take it over. Say yes and it turns it into a skill
as above; say no and it won't offer that one again.

"Forget what I did in the browser today" clears it. Turn the setting off, and what you do by yourself isn't kept.

## Related

- [Approvals and auto mode](approvals.md): cards, "you asked", rules.
- [Plugins and integrations](plugins.md): the Web plugin and search keys.
- [The iPhone app](phone.md): the live view on the phone.
