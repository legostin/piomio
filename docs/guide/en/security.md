---
title: Security model
nav: Security model
description: How Piomio guards your secrets and your computers: the chat and the security console, the vault, signing in, the sandbox in each kind of install, the network filter, other computers and phones, the audit log, and what leaves your machines.
---

Piomio holds your conversations, your keys and your agents' work on your own computer or server. This page shows the walls between its parts, what each kind of install adds, and where the limits are. What agents may do without asking you is on [Approvals and auto mode](approvals.md).

## The chat and the security console

The hub serves two separate sites:

- **the chat**: the web UI, plugins' pages and the API the apps use;
- **the security console**: approvals, the vault, rules, the audit log, the password and passkeys.

The console has its own sign-in cookie and a strict Content Security Policy: only its own scripts run there, and `frame-ancestors 'none'` keeps any page from framing it. Once you're signed in, every request must come from the console's own address and carry its CSRF token. No plugin code ever runs in it, so a plugin's page in the chat can't read or press anything there. You sign in to it separately, and its session ends after 30 minutes without activity. Open it from **Settings** → **Security console**. The link for [access from anywhere](anywhere.md) doesn't serve it.

The ports:

| Install | Chat | Console | Phones | Egress proxy |
|---|---|---|---|---|
| Desktop app | 41780 | 41781 | 41782 | 41789 |
| Server install | 8080 | 8081 | 8082 | 8089 |

The chat and the console listen only on the computer itself (`127.0.0.1`), unless you change `PIOMIO_HOST`. The phones' port listens on every address, so a phone can come over Wi-Fi: it speaks HTTPS with the hub's own certificate, and its API needs a paired phone's token. `PIOMIO_DEVICES=0` closes it. The egress proxy listens on `127.0.0.1` only. See [Settings and environment variables](settings.md).

## Signing in

- One password for the chat and the console, at least 8 characters, kept as an Argon2id hash. The first one is set with a one-time setup code (see [First run](first-run.md)).
- A chat session lasts 30 days; a console session ends after 30 idle minutes.
- Passkeys: in the console, **Account** → **Passkeys** → **Add passkey**. One works for both sites. They need HTTPS or `localhost`, and a host name rather than an IP address. Through the link it is the password only.
- After 10 wrong passwords from one address within 15 minutes, that address has to wait. Through the link, 30 failures from all addresses within an hour pause sign-in through the link for an hour; the computer's own address keeps working. Every failure goes into the audit log.
- The desktop app signs its own window in with one-time tickets passed over a pipe only the app holds.
- **Change password** under **Account** → **Password** ends every session. So does the `reset-password` command, for when you've lost it.

## The vault

The vault keeps passwords, API keys, tokens and personal data.

- Each item's secret fields are encrypted with XChaCha20-Poly1305 under a random data key. The data key is itself encrypted with a key derived from your vault password by Argon2id. Names, types and scopes stay readable, so the list shows while the vault is sealed.
- Models only ever see `vault://id`. The hub puts the value where it's used: the browser types a login on its own site, a plugin gets its key.
- Secret values of 6 characters or more, and their base64 and URL-encoded forms, are replaced with `[redacted: vault://id]` in tool results going to models, in messages to channels such as Telegram, in plugin logs and in the audit log. The one exception is an item where you turned on **Allow the model to read the value** (meant for harmless data such as a delivery address).
- The vault password can't be recovered. **Change vault password** re-encrypts only the data key, not the items.

### Secrets in the chat

- When an agent needs a key, it shows a card with a secure field and **Save to vault**. The value goes straight into the vault; the assistant only learns `vault://id`. A login card asks for a username and password for one site: the browser types them there, the assistant never sees them.
- A token pasted into a message is recognised and moved to the vault before the message is stored or reaches a model; the message keeps the reference. This covers the formats plugins declare and well-known ones (Anthropic, OpenAI, OpenRouter, xAI, Groq, GitHub, GitLab, Slack, Google API, Stripe live keys, Hugging Face, Notion). If the vault is locked, the token is removed and stored nowhere.
- Claude tokens from `claude setup-token` are removed and never stored: Claude Code signs in on each computer by itself (see [Brains and sign-in](brains.md)).
- From the chat you can create or unlock the vault. Reading items, sealing it and changing who gets what happen only in the console.

### Who gets an item

Each item has an **Access scope** in the console: **Domains** (where a login may be filled in; empty means the domain of its URL), **Plugins** (for a login, empty means none), **Agents** and **Tools**. A plugin gets an item only when its permissions name it (you see them when you install it) or you granted it under **Account** → **Plugins and their permissions**, and the item's scope allows that plugin, agent and site. Lookups, allowed or refused, go into the audit log, and so does every time you reveal a value in the console.

### Sealed after a restart

The data key lives only in memory. After a restart the vault is sealed until you unlock it, in the chat or the console. To have it unlock by itself:

- tick **Unlock automatically after restarts (the passphrase is kept on this server)** when you create or unlock it in the chat: the password goes into `vault.passphrase` in the data folder, readable only by the hub's user;
- or set `PIOMIO_VAULT_PASSPHRASE_FILE` to a file holding it.

Either way, whoever can read that file can open the vault. **Seal** in the console wipes the key from memory at once. A replica of the hub on another computer (see [Machines and other computers](machines.md)) gets the data key from an unlocked one only after you tap yes on a card, and never writes it to disk.

## The sandbox, by kind of install

### The desktop app

The hub, its plugins and the brains run as you, in your home folder, so each CLI uses the sign-in you already have. On macOS the CLI brains' own commands and files are kept in a sandbox: Seatbelt for Claude Code, Codex's own with a profile from the hub, and Kimi Code asks the hub before each command and change. Your credentials and the hub's data are closed to Claude Code and Codex, and refused in any brain's command. On Windows there is no sandbox around the brains yet: in a task their commands and file changes run as you without asking. Details on [Approvals and auto mode](approvals.md#the-brains-own-commands-and-files).

### A server install

Run as root, `install.sh` creates a user `piomio` without sudo and installs for it; run as an ordinary user, it installs for that user. Everything runs as that one user, and Linux has no sandbox around the brains, so their commands in tasks run without cards. Give that user nothing it shouldn't reach. See [On a Linux server](server.md).

In every install, a dialog's brain only looks: commands and file changes go to tasks.

## The network filter

Brains and plugins reach the network through the hub's egress proxy, each with its own allowlist:

- Brains: their providers' and sign-in hosts (Anthropic, Claude, OpenAI, ChatGPT, Kimi), Google APIs, OpenRouter, npm, PyPI, GitHub and a few hosts the CLIs themselves report errors and usage to. Add more under **Settings** → **General** → **Brains** → **Extra allowed hosts** (`brainEgressAllow`).
- Plugins: the hosts their permissions list, which you see when you install one and under **Account** → **Plugins and their permissions** in the console. An MCP server you add yourself may reach any public host unless its config lists `network`.
- Private addresses (your home network, loopback, link-local, Tailscale's `100.64.0.0/10`) are refused for everyone unless the host is in `egressPrivateAllow`. That setting has no field yet; it is set through `PATCH /api/settings`.
- The proxy resolves a name once and connects to exactly that address, so a DNS answer can't change in between. Refusals go into the audit log.

Agents can't change these lists from the chat.

## Other computers

- A computer joins with a one-time invite, valid for an hour. It makes an Ed25519 key; the hub keeps the public half and challenges the computer with it on every connect.
- A command or a file write there is an external action, so your approvals and rules apply. So does that computer's own policy, `~/.piomio-node/policy.json`, which only its owner edits: which folders (by default `~/piomio-workspace`), whether commands may run at all (off by default) and which, and which brains. Both have to agree.
- **Machines** → **Disconnect** revokes its key. See [Machines and other computers](machines.md).

## Phones

- The QR code or link carries a one-time code and the fingerprint of the hub's certificate; the app pins that certificate.
- The phone makes a key in its Secure Enclave. A yes from the app's own approvals list is signed with it after Face ID.
- The hub gives the phone its token once and keeps only a hash of it.
- **Devices** → **Disconnect**: the phone loses access at once, and its open connections close. See [The iPhone app](phone.md).

## The audit log

It records every tool call (the input shortened, the start of the output), every policy decision, approvals and how they were answered, auto mode's verdicts, the brains' own requests, rule changes, vault lookups, sign-ins and failed attempts, settings changes and refused network requests. Secret values are redacted.

The entries form a hash chain: each one includes the hash of the one before, so a changed or deleted entry breaks the chain from that point on. To check it:

- in the console: **Audit** → **Verify integrity**;
- on a server install: `piomio audit-verify`, after `sudo -iu piomio`; from source: `node packages/core/src/cli.ts audit-verify`. It exits with code 2 if the chain is broken.

The log lives in the hub's own database. The chain shows tampering; it can't stop someone who controls the computer from replacing the whole log.

## What leaves your machines

- **The brains.** What an agent works on goes to its brain's provider through the official CLI, under your own plan: Anthropic for Claude Code, OpenAI for Codex, Moonshot for Kimi Code. Auto mode's reviews go there too. Each CLI signs in on its own computer; Piomio never takes or stores their tokens. If you turn on `PIOMIO_API_KEYS`, the API providers you add keys for get it as well.
- **Composio.** Apps you connect through it carry a small badge with its name. Signing in and every request go through Composio's cloud, which keeps those apps' keys and sees what the agent reads and sends.
- **Tailscale.** The link from anywhere runs on the hub's own Tailscale node in your tailnet. Piomio doesn't send Tailscale the node's logs. See [Access from anywhere](anywhere.md).
- **What you connect.** Telegram, Google, the sites the agents' browser opens, a speech-to-text service if you set one up, GitHub when the hub looks for updates.

The hub sends no usage data of its own.

## Backups and the vault

The `backup` command copies the hub's database, the vault (still encrypted), agents, skills, commands, and plugins with their data: on a server install `piomio backup`, from source `node packages/core/src/cli.ts backup`. It doesn't copy the auto-unlock password file, so a backup's vault opens only with the vault password. Without that password nobody can open it, Piomio included: keep it in a password manager.
