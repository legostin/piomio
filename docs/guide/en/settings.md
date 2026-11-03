---
title: Settings and environment variables
nav: Settings
description: What the Settings panel changes, the hub settings without a field, every environment variable with its default and where it goes for each kind of install, the ports and the folders.
---

Most of Piomio is set up in the chat: you say what you want, and the assistant changes it or shows a card with buttons. The **Settings** panel holds the same things as a second way, plus a few that only you may change. Environment variables are for what has to be known before the hub starts: addresses, ports, folders and security walls.

## Change settings in the chat

Just say it: "turn on quiet hours from 22:00", "my time zone is Europe/Berlin", "send the digest at 8:30 and 18:00", "answer me in Russian". The assistant can change:

- the time zone, the hub language and the default agent;
- quiet hours, digest times and notifications per hour;
- parallel sessions per brain;
- whether the default agent's replies to what you type in the web UI also go to Telegram;
- auto mode, or asking you every time (turning auto mode on shows you a card first, see [Approvals and auto mode](approvals.md));
- speech to text for voice messages (except your own server), and the voice and speed for reading aloud; it also downloads the local speech engine ("install local speech recognition"), see [Voice](#voice).

It also connects plugins and services, changes their settings and makes agents. The rest of the **General** page is yours alone: the network allowlists, the approval timings, the details in Telegram and your own speech-to-text server. The assistant can propose adding a host via a network permission card; other changes to these lists are made in the panel.

## The Settings panel

**Settings** at the bottom of the sidebar opens the panel next to the chat (full screen on a phone). Its sections:

| Group | Sections |
|---|---|
| **Assistant** | **Agents**, **Skills & commands**, and pages plugins add ([Agents and the team](agents.md)) |
| **Activity** | **Tasks**, **Inbox** ([Tasks, schedules and the Inbox](tasks.md)) |
| **Connections** | **Plugins** ([Plugins and integrations](plugins.md)), **Brains** ([Brains and sign-in](brains.md)), **Machines** ([Machines and other computers](machines.md)), **Devices** ([The iPhone app](phone.md)), **MCP servers** |
| **General** | **General** (below), **Security console** ([Security model](security.md)), **Sign out** |

## General

The hub's own settings. Change what you need and press **Save** (at the top and at the bottom). They apply to the whole hub, and the page picks up what the assistant changed in the chat meanwhile.

### Time zone and default agent

- **Time zone**: for schedules, quiet hours and digests. It starts as the computer's time zone (`TZ`).
- **Default agent**: opens first, answers in Telegram and picks up new tasks. An archived agent can't be the default.

### Language

- **Interface language in this browser**: saved only in this browser; the page reloads after a change.
- **Hub language**: notifications, Telegram messages, approval cards and agent replies use it, and so does the interface in browsers that haven't picked their own. It is set from the first user's browser during setup, unless `PIOMIO_LANG` pins it.

### Notifications

- **Quiet hours** (on, 23:00 to 08:00): notifications arrive silently, and anything unimportant waits until morning.
- **Digest times** (09:00 and 19:00): type `HH:MM` and press Enter to add one.
- **Notifications per hour** (4, from 0 to 100): the limit on urgent notifications per trigger.

See [Tasks, schedules and the Inbox](tasks.md).

### Approvals

- **Wait for a decision, sec** (45, from 0 to 600): how long an agent waits for your answer before it postpones the action.
- **Approval lifetime, h** (24, from 1 to 720): after that the request is cancelled.
- **Show details in Telegram** (off): the action's full parameters in the Telegram message. Off, it is a short summary and a link to the console.

See [Approvals and auto mode](approvals.md).

### Brains

- **Parallel sessions per brain** (2, from 1 to 16): how many tasks and agent threads run at once on one brain on one computer. The rest wait in line; your own conversations never wait.
- **Extra allowed hosts**: where brains may connect besides the default list (Anthropic, OpenAI, Kimi, GitHub, npm and the like). Wildcards like `*.example.com` work. The built-in list is visible here too. New public hosts can be proposed in chat via a network permission card; Always allow adds the host here. Remove an entry and save to stop new connections using that permanent permission.

### Voice

Voice messages and audio files are turned into text before the agent answers, and the hub can read text aloud with a voice of its own.

- **Speech to text**: **Automatic: OpenAI or Groq if the vault has a key, else this computer** (the default), **This computer (free, offline)**, **Groq (has a free tier)**, **OpenAI**, **My own server (OpenAI-compatible)** or **Off**. The keys are `groq_api_key` and `openai_api_key` in the vault; the assistant asks for one in the chat when it needs it.
- **Model**: empty means the service's default.
- **Server address** and **Key in the vault**: for your own server, for example a local Whisper. The address goes up to `/audio/transcriptions`, such as `http://127.0.0.1:8000/v1`.
- **Voice for reading aloud** and **Speed** (0.75× to 1.5× here, 0.5× to 2× in the chat): the voice the hub speaks with. Unset, it is Dmitri for a Russian hub and Ryan otherwise, at 1×. Saved with **Save**.

Under the choice you see what works now, or that nothing is set up and voice messages reach the agent as audio files.

#### The local speech engine

The hub can speak and hear on its own computer, free and without the internet once it is downloaded. It is not in the installers: **Install** downloads it when you want it, or say "install local speech recognition" in the chat. Each download is checked against a fixed checksum before it is unpacked, one at a time, with its progress under the button; a broken one leaves nothing behind and shows why, with **Retry**. What it downloads:

- the engine itself, the first time: about 20 MB ([sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), Apache-2.0, and the espeak-ng phonemizer the voices need, GPL-3.0, which runs in a process of its own);
- a voice, about 20 MB each (the table below);
- speech recognition for the hub language, when **Speech to text** is **This computer (free, offline)**: GigaAM v3 for Russian (156 MB, MIT), Parakeet TDT v3 for English and 24 other European languages (465 MB, CC BY 4.0).

| Voice | Language | License of its recordings |
|---|---|---|
| Dmitri | Russian | CC0 |
| Denis | Russian | CC0 |
| Irina | Russian | unknown |
| Ryan | English | CC BY-NC-SA 4.0 (non-commercial) |
| Amy | English | unknown |

The local engine hears WAV recordings, such as the phrases a voice overlay sends. Telegram voice notes and what the web chat records are in other formats: they still need a Groq or OpenAI key. Everything goes into the `voice` folder in the data folder (see [Files and folders](#files-and-folders)); delete it to free the space.

### Plugins' cards

Each plugin with settings has a card here: its keys, typed straight into the vault, and its own options. See [Plugins and integrations](plugins.md).

### Security

**Open console** opens the security console, where the password, passkeys, the vault, rules and the audit log live. **Sign out** signs this browser out.

### This app

Only in the desktop app: **Quit Piomio** stops it until you open it again, and **Reset Piomio…** deletes everything it keeps on this computer after asking. See [Install on a Mac or PC](install.md).

## Settings without a field

| Setting | Default | How to change it |
|---|---|---|
| Replies to Telegram (`channelMirror`) | on | in the chat: "don't send my web conversations to Telegram" |
| Approval mode (`approvalMode`) | auto mode | in the chat, see [Approvals and auto mode](approvals.md) |
| Access from anywhere (`remoteAccess`) | off | its card, or "turn on access from anywhere", see [Access from anywhere](anywhere.md) |
| Private hosts (`egressPrivateAllow`) | empty | only through the API, below |

`egressPrivateAllow` lists the hosts on your local network that plugins and brains may reach, such as `searxng` or `nas.local`: the egress filter refuses private addresses otherwise. To set it, open the chat in your browser, open the browser's developer console on that tab and run:

```js
const { csrf } = await (await fetch("/api/bootstrap")).json();
await (await fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json", "x-csrf": csrf }, body: JSON.stringify({ egressPrivateAllow: ["searxng", "nas.local"] }) })).json();
```

The list you send replaces the old one, and it applies at once.

## Environment variables

### Where they go

| Install | Where | Then |
|---|---|---|
| Linux server | `~/.config/piomio/env` of the user `piomio` ([On a Linux server](server.md)) | `systemctl --user restart piomio` |
| Desktop app | no file for variables; the ports go in `desktop.json` in the data folder | **Restart** in the icon's menu |
| From source | the shell, before `npm start` | a restart |

`desktop.json` is `{"port": 19000}`: the console then takes the next port and the egress proxy the port + 9, unless `consolePort` and `egressPort` say otherwise.

### Addresses and ports

| Variable | Default | What it does |
|---|---|---|
| `PIOMIO_HOST` | `127.0.0.1` | where the chat and the console listen |
| `PIOMIO_PORT` | `8080` (desktop `41780`) | the chat, its API and the agents' MCP endpoint |
| `PIOMIO_CONSOLE_PORT` | the port + 1 | the security console |
| `PIOMIO_EGRESS_PORT` | `8089` (desktop: the port + 9) | the egress proxy, always on `127.0.0.1` |
| `PIOMIO_PUBLIC_URL` | `http://localhost:<port>` | the chat's address: links, the origin check, passkeys |
| `PIOMIO_CONSOLE_URL` | the same host, the console port | the console's address |
| `PIOMIO_ALLOWED_HOSTS` | none | more host names the hub answers to, comma-separated |
| `PIOMIO_TRUST_PROXY` | off | `1` trusts `X-Forwarded-*` from a reverse proxy |

### Phones, access from anywhere and other machines

| Variable | Default | What it does |
|---|---|---|
| `PIOMIO_DEVICE_PORT` | the port + 2 (`8082`, desktop `41782`) | the phones' HTTPS port |
| `PIOMIO_DEVICE_HOST` | `0.0.0.0` | where that port listens |
| `PIOMIO_DEVICES` | on | `0` closes the phones' port; phones then come through the link |
| `PIOMIO_DEVICE_URLS` | detected | addresses for the pairing QR, comma-separated, ahead of the detected ones |
| `PIOMIO_TAILNET_HOSTNAME` | `piomio` | the node's name in your tailnet, the link's first label |
| `PIOMIO_TAILNET_BIN` | the node that comes with the app | the Tailscale node program for access from anywhere |
| `PIOMIO_REPLICA_NAME` | the host name | this machine's name among the hub's replicas |
| `PIOMIO_NODE_URLS` | this machine's address | where machines reach this hub, comma-separated |

### Data, language and time

| Variable | Default | What it does |
|---|---|---|
| `PIOMIO_DATA_DIR` | see [Files and folders](#files-and-folders) | the data folder |
| `PIOMIO_LANG` | none | `en` or `ru`: the hub language from the start (the first browser doesn't set it then), and the language of the commands' messages |
| `TZ` | the system's | the default time zone |
| `PIOMIO_SETUP_TOKEN` | random | sets the setup code in advance |

### Brains and security

| Variable | Default | What it does |
|---|---|---|
| `PIOMIO_API_KEYS` | off | `1` lets agents think through plain API keys too; set it alike on every replica |
| `PIOMIO_INSTALL_CLIS` | off (`1` in the desktop app and on a server install) | `1` lets **Sign in** install a missing CLI into `<data>/tools`, and reads the PATH of the user's login shell |
| `PIOMIO_BRAIN_HOME` | `<data>/home/agent` (the user's home in the desktop app and on a server) | the brain CLIs' home, where their sign-ins live |
| `PIOMIO_SANDBOX_BRAINS` | on, on macOS | `0` turns off the macOS sandbox around CLI brains |
| `PIOMIO_VAULT_PASSPHRASE_FILE` | none | a file with the vault passphrase: the vault opens by itself at start |

### Integrations, maps and the browser

| Variable | Default | What it does |
|---|---|---|
| `PIOMIO_GOOGLE_CLIENT_ID`, `PIOMIO_GOOGLE_CLIENT_SECRET` | Piomio's client | your own Google OAuth client (type Desktop app) |
| `PIOMIO_ROUTER_URL` | `https://routing.openstreetmap.de` | the OSRM server for routes on maps |
| `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | off | `1` stops the automatic Chromium download |
| `PLAYWRIGHT_BROWSERS_PATH` | Playwright's cache | where Chromium is |

### Updates

| Variable | Default | What it does |
|---|---|---|
| `PIOMIO_INSTALL_ROOT` | set by the server's launcher | where `install.sh` put the hub; such a hub updates on the **Update** button |
| `PIOMIO_UPDATE_URL` | GitHub's latest release | another release feed to update from, for a local check |
| `PIOMIO_RELEASES_REPO` | `legostin/piomio` | the repository whose releases bring updates, release notes and the desktop downloads |

### Installers

| Variable | Default | Read by |
|---|---|---|
| `PIOMIO_VERSION` | the latest release | `install.sh`: the release to install |
| `PIOMIO_NAME` | the host name | `install.sh` with an invite: the computer's name |
| `PIOMIO_NO_WAIT` | off | `install.sh`: `1` shows Tailscale's sign-in page without waiting for the link |
| `PIOMIO_REPO`, `PIOMIO_ARCHIVE` | `legostin/piomio`, none | `install.sh`: another repository's releases, or a local archive |
| `PIOMIO_NODE_HOME` | `~/.piomio-node` | `piomio-node`: its key, pairing and policy |

### For development

`PIOMIO_APP_ROOT` (the app's folder), `PIOMIO_PLUGINS` (`all`, `none` or a list of built-in plugins to start), `PIOMIO_DEBUG` (every plugin log line in the hub's log, not only errors), `PIOMIO_DEV_ORIGIN` and `PIOMIO_CONSOLE_DEV_ORIGIN` (dev servers of the UIs), and `PIOMIO_GOOGLE_AUTH_URL`, `PIOMIO_GOOGLE_TOKEN_URL`, `PIOMIO_GOOGLE_REVOKE_URL`, `PIOMIO_GOOGLE_USERINFO_URL`. The desktop app sets `PIOMIO_DESKTOP`, `PIOMIO_DESKTOP_APP` and `PIOMIO_DESKTOP_PORT` itself.

## Ports

| | Desktop app | Server, from source |
|---|---|---|
| The chat, its API and MCP | `41780` | `8080` |
| The security console | `41781` | `8081` |
| The phones' HTTPS port | `41782` | `8082` |
| The egress proxy | `41789` | `8089` |

The chat and the console listen on `127.0.0.1` unless `PIOMIO_HOST` says otherwise; the egress proxy always does. The phones' port listens on every address, so phones at home reach it.

## Files and folders

| Install | Data | Settings | Log |
|---|---|---|---|
| macOS app | `~/Library/Application Support/Piomio` | `desktop.json` in the data folder | `logs/hub.log` in the data folder (**Show log** in the icon's menu) |
| Windows app | `%LOCALAPPDATA%\Piomio` | `desktop.json` in the data folder | `logs\hub.log` in the data folder |
| Linux server | `~/.local/share/piomio` | `~/.config/piomio/env` | `journalctl --user -u piomio` |
| From source | `.data` in the repository | the shell | the terminal |
| A computer of your hub | `~/.piomio-node` | `~/.piomio-node/policy.json` | `journalctl --user -u piomio-node`, or the app's log |

An install from when Piomio was called Owlbot keeps its `Owlbot` folder. In the data folder: `piomio.db` (chats, agents, tasks, settings), `vault.db` (the vault, encrypted), `workspaces` (the agents' working folders), `plugins` and `plugins-data` (installed plugins and their data, memory included), `agents`, `skills`, `commands`, `pages`, `tailnet` (the access-from-anywhere node), `devices` (the phones' certificate), `tools` (CLIs installed from the chat), `voice` (the local speech engine and its voices, once downloaded) and `backups`.
