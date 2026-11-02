---
title: Plugins and integrations
description: The Plugins catalog, what comes built in, connecting services like Notion, Linear, Granola and the apps behind Composio, MCP servers, Claude Code and Codex plugins, and integrations your agents build for you.
---

Almost everything Piomio does beyond the chat is a plugin: the browser, memory, reminders, Telegram, the weather,
your Notion. Services you connect and abilities you turn on are called integrations. They all live in one catalog,
and you can set every one of them up by asking the assistant.

## Connect from the chat

Say what you want in plain words:

- "Connect Notion." "Turn on the weather." "Set up Telegram."
- "Can you see my Linear issues?" (if Linear isn't connected yet, the agent says so and offers it)

The assistant shows the integration's card in the chat, with its status and the one button that moves it forward:

- **Turn on** for an ability that only needs switching on, like the weather or currency rates.
- **Sign in to …** for a service with its own sign-in, like Notion, Linear or Granola.
- **Set up** for a plugin that needs a key or a token. The field on the card sends the value straight into the
  encrypted vault; the agent only ever sees a reference to it.

Once it is connected, the agent hears about it and carries on with what you asked. A card shows **Not connected**,
**Needs reconnecting** or **Unavailable** when something is missing, and the agent tells you what to press.

## The Plugins catalog

Everything is also under **Settings → Plugins**:

- **Search** at the top ("Search: weather, calendar, maps…") and category chips: **All**, **Everyday**, **Travel &
  places**, **Money**, **Work & productivity**, **News & reading**, **Communication**, **The assistant**, **Brains**
  and **More**.
- **Popular**: the plugins your agents used most in the last 30 days, then Piomio's own picks.
- Each row shows the name, one line about it, and its state: **On**, **Needs setup** or **Not working**. A plugin
  that is off shows nothing.

Press a row to open the plugin's page:

- The switch (**Turned on** / **Turned off**) and its status.
- A button that continues in the chat: **Connect in the chat**, **Fix in the chat** or **Set up in the chat**. It opens
  the assistant's chat with a short request in your words.
- **Try: "…"**, an example to ask once it works.
- **Connection** (keys, sign-in, Telegram's linking), **Settings**, **About the plugin** (what it may reach and what
  it adds) and **Logs**. At the bottom, **Restart**, and for plugins you installed, **Delete**. Built-in plugins can
  only be turned off.

## What comes with Piomio

These are on from the start:

| Plugin | What it does |
|---|---|
| **Browser** | The agents' own browser, with a live view you can take over. See [The browser and teach mode](browser.md). |
| **Web** | Reads web pages and RSS feeds, and searches the web: through the browser, or Brave, Tavily or your own SearXNG. |
| **Memory** | The team's long-term memory about you, which you can see and change. |
| **Triggers** | Reminders, schedules, page watches and webhooks that start work by themselves. See [Tasks, schedules and the Inbox](tasks.md). |
| **Telegram** | Chat with your agents in Telegram. Needs a bot of your own: see [Telegram](telegram.md). |
| **Yandex Maps and 2GIS** | Adds both apps to "Open in…" on the maps agents show in the chat. |
| **Claude Code**, **Codex**, **Kimi Code** | The brains. See [Brains and sign-in](brains.md). |

These wait until you turn them on:

| Integration | What it does | Connects with |
|---|---|---|
| **Weather** | Forecast for any place as a card: now, by the hour, the week (Open-Meteo). | **Turn on** |
| **Currency rates** | Exchange rates and conversion (ECB rates through Frankfurter, others through ExchangeRate-API). | **Turn on** |
| **Crypto prices** | Prices from CoinGecko with the 24-hour change and a 7-day chart. | **Turn on** |
| **Holidays & days off** | Public holidays and long weekends of about 120 countries (Nager.Date). | **Turn on** |
| **World clock & units** | Live clocks for other cities, time zones, miles, pounds, Fahrenheit. Works offline. | **Turn on** |
| **Wikipedia** | Search and read Wikipedia in any language; articles arrive as a card. | **Turn on** |
| **Granola** | Your meeting notes: summaries, transcripts, questions across meetings. | Granola's sign-in |
| **Notion** | Search, read and write pages and databases, comment. | Notion's sign-in |
| **Linear** | Find and read issues, projects, cycles and documents; create and update issues; comment. | Linear's sign-in |
| **Blender** | Blender for the agents through the official MCP server from Blender Lab. | **Turn on** |
| **Composio** | Slack, GitHub, Google apps, Microsoft 365, Jira, Zoom and more through an outside service. | A Composio key, then each app's sign-in |

The catalog also holds **Access from anywhere**, the private link to your hub (see [Access from anywhere](anywhere.md)).
The API brain appears only when the hub runs with `PIOMIO_API_KEYS=1` (see [Brains and sign-in](brains.md)).

## Services you sign in to: Notion, Linear, Granola

1. Ask "connect Notion" (or press **Connect in the chat** on its page).
2. Press **Sign in to Notion** on the card. The service's own sign-in page opens; allow access there.
3. The browser comes back to Piomio and the card turns connected.

If the hub runs on a server or you sign in from a phone, the return page may not open. Copy the address from the
browser's address bar and paste it into the card's field, then press **Done**. The sign-in is kept in the vault, so the
vault must be unlocked (the card offers it).

The agents then see what your account can open. Reading runs by itself; creating or changing something asks you on a
card, unless you say "always allow Linear" (see [Approvals and auto mode](approvals.md)). Notes from the services:
Notion's search filters and comments partly need its Business plan, and Granola's free plan covers the last 30 days.
**Disconnect** on the card signs Piomio out.

## Apps through Composio

Composio is an outside service that signs in to apps for you. Everything that goes through it carries a **Composio**
badge; tap it to read what that means: the account's keys are kept in Composio's cloud, not on your hub, and Composio
sees what the agent reads and sends. Prefer a native integration when there is one.

1. Ask "connect Slack through Composio". The first time, the card asks for your Composio API key: sign up at
   platform.composio.dev and make a key under Settings, API keys. It goes into your vault.
2. Press **Sign in to Slack**: Composio's page signs you in to Slack.
3. Allow everything the service's page asks for. On Google's page, tick every box: an empty box breaks the app's tools
   later, and the card then asks you to sign in again.

Ready in the catalog: Slack, GitHub, Gmail, Google Drive, Docs, Sheets, Calendar, Tasks and Meet, HubSpot, Dropbox,
Box, Outlook, Microsoft Teams, OneDrive, Trello, Jira, Zoom, Calendly, Figma, Salesforce, LinkedIn, YouTube and
Reddit. For anything else, ask: the agent searches Composio's list (about a thousand apps) and adds those Composio can
sign in to by itself. Google Calendar, Gmail and the other Google apps connect this way today.

## Blender

Turn it on and agents can look at your scene, its objects and files, take screenshots, render and run Python in
Blender. It needs Blender 5.1 or newer on the computer the hub runs on. On first use Piomio finds Blender, installs the
official MCP add-on into it and opens Blender when an agent needs it. Every change asks you first.

## MCP servers

Any MCP server can give your agents more tools. **Settings → MCP servers** lists the connected ones with their status
(**connected**, **connecting**, **error**, **disabled**), where each came from (**yours** or a plugin's), its tools and a
**Reconnect** button.

Below the list is your config, in the `.mcp.json` format. A server has a `command` (it runs as a process) or a `url`
(over HTTP). Keys and tokens go in as `vault://<id>` references, never as values; keep the values in the vault.
**Insert an example** fills in a template:

```json
{
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "vault://github_token" }
  },
  "docs": {
    "type": "http",
    "url": "https://example.com/mcp",
    "headers": { "Authorization": "vault://docs_token" }
  }
}
```

Press **Save**. The config is kept as `mcp.json` in the hub's data folder. Tools a server marks read-only run by
themselves; the others ask you first. From the chat, agents can list the servers and reconnect one; to add a server in
the chat, ask an agent to wrap it as an integration (below).

## Install a plugin from a link

At the bottom of the catalog, **Install from a link** takes a git repository (`https://…`, `git@…`) or a folder on the
hub's computer. Piomio plugins, Claude Code plugins and Codex plugins all work: their skills, commands and MCP servers
become available to your agents.

Paste the address and press **Check**. The plugin is first downloaded to a temporary folder, and you see what it asks
for: the sites it may reach, vault items, hub actions. When something deserves attention (it may reach any site, add
MCP servers, bring skills), turn on **I trust this plugin** first. Then press **Install and enable**.

## Ask an agent to build an integration

When nothing in the catalog does what you need, ask: "make an integration for my air quality sensor's API". The agent
follows its **make-integration** skill: it builds the integration in its working folder, with the card it shows in the
chat, and asks to install it. An approval card lists the name and everything it asks for: the internet hosts, the
secrets, the hub actions. Once you allow it, the integration is installed, turned on and listed in the catalog. Ask for
changes the same way; the agent installs the new version over it.

## For developers

- [docs/plugins.md](https://github.com/legostin/piomio/blob/main/docs/plugins.md): the plugin API, manifests,
  permissions, UI modules.
- [integrations/README.md](https://github.com/legostin/piomio/blob/main/integrations/README.md): adding an integration
  (`npm run new:integration -- <id>`) and the template the agents use.
