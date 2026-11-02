---
title: Pages
description: Interactive pages agents make in the chat: maps with routes, places, the weather, tables and checklists. How they open, how to change them, where they are kept and what they can reach.
---

Some answers are better as a page than as a message: a walk with its stops on a map, a trip plan, a comparison, a
checklist, a report. Any agent on the team can make one. It arrives as a card in the chat, and the page opens full
screen inside Piomio, on the computer and on the phone.

## Ask for a page

Just say what you want to see:

- "Make a page for Saturday's walk: a route through the old town, places with prices, and the weather."
- "Put the three flats we looked at side by side on a page."
- "Make a packing checklist for the trip."

Agents also make a page on their own when an answer has a lot of structure or pictures. The message tells you what
the page holds, and the card below it shows a picture, the title, a line or two and **Open**.

## What a page can show

A page is a small web app the agent writes in React, on a kit that comes with Piomio. It has:

- **Layout and controls:** cards, tabs, accordions, tables, badges, buttons, sliders, switches, checkboxes, dialogs,
  carousels, progress bars and icons (the shadcn/ui components and Lucide icons), styled with Tailwind.
- **A map** with numbered pins and a route along real roads and paths, on foot, by car or by bike, with the distance
  and time. Choosing a place in a list can move the map to it. Maps use OpenStreetMap.
- **The weather:** a live forecast for a place, up to 7 days ahead, from Open-Meteo.
- **Place cards:** a photo, why it is worth it, the address, hours, price, rating and tags, with buttons:
  - **Route** opens directions in Apple Maps on Apple devices and in Google Maps elsewhere.
  - **Website** opens the place's site.
  - **Ask** sends "Tell me more about …" to the agent.
- **Pictures and video:** a header with a photo, a photo gallery, figures with a label. YouTube and Vimeo videos open
  outside the page.
- **Live data** from a few free services: Open-Meteo (weather, air quality, sea), Frankfurter (exchange rates) and
  Wikipedia, Wikimedia and Wikidata.
- **Things that stay ticked:** a checklist or a choice you make on the page is saved on your hub and is still there
  the next time anyone opens it.

A page follows the app's light or dark look, and its own words (the forecast, "Route", the error screen) are in the
hub's language. There is no chart block in the kit: an agent shows numbers as tables, figures and progress bars.

## Open a page

Press the card. The page covers the chat; the bar on top has its title and a close button (Escape works too).

Inside a page:

- Links open outside it: in your browser, or in the system browser on the phone.
- Buttons that talk to the agent (like **Ask** on a place) close the page and send those words to the chat as your
  message, so the conversation goes on from there.
- If the page breaks, it shows **This page didn't open** with the error and an **Ask to fix it** button. The hub also
  keeps the error for the agent, so it can see what went wrong in your browser.

Pages open everywhere the chat does: in the desktop app, in a browser, through the link that reaches your hub from
anywhere (see [Access from anywhere](anywhere.md)), and in the [iPhone app](phone.md), where the page takes the whole
screen. Telegram gets the agent's words but not the page: open the card in the app.

To see a page again later, ask for it: "show me the walk page again". The agent puts its card in the chat once more.

## Change a page

Ask in the same chat: "add a coffee stop after the museum", "make the map bigger", "switch the prices to euros". The
agent changes the page's code or only its data, and a page that is open reloads by itself with the new version.

Because the facts usually live in the page's data, small changes are quick: the agent can swap the list of places or
the prices without touching the layout.

A task on a schedule can keep a page up to date too, for example a morning summary that refreshes every day (see
[Tasks, schedules and the Inbox](tasks.md)). Pages can't be deleted from the app or the chat yet.

## Where pages are kept

Each page is a folder in the hub's data folder:

```text
pages/<page id>/page.tsx    the code the agent wrote
pages/<page id>/page.js     the same code compiled for the browser
pages/<page id>/data.json   the facts the page shows
```

The title, the card's line and picture, who made it, its version and what you ticked on it are kept in the hub's
database. Limits per page: 200 KB of code, 1 MB of data and 256 KB of saved ticks and choices.

## What a page can and cannot reach

An agent's page runs in a sandbox. The hub serves it at its own address with a secret part, and the browser treats
it as a stranger to Piomio:

- It can't read your Piomio session, call Piomio's API or see your chats, memory or vault.
- It can load only what the hub hands it: the kit, its own data, pictures (the hub fetches them for it), map tiles,
  road routes, and JSON from the services listed above. It can't contact other sites, so the agent puts what it found
  into the page's data.
- It can't use the camera, the microphone or your location, can't embed other sites and can't send forms anywhere.
- When the code is compiled, the hub refuses anything the page tries to import beyond the kit.

There is no button to share a page or open it in a separate tab: pages open inside Piomio.

## Related

- [The chat](chat.md): cards, maps and pictures in messages.
- [Agents and the team](agents.md): who makes what.
- [Security model](security.md): how the hub keeps agents' work apart from your data.
