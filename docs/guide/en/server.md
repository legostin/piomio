---
title: On a Linux server
nav: On a Linux server
description: Piomio on a Linux server with one command: what you need, the hub or a computer of your hub, signing in to a brain, opening the chat, files, commands, backups and removal.
---

A server stays on, so your agents keep working while your computer sleeps. One command installs Piomio there as a service, and the agents think with the Claude Code, Codex or Kimi Code you sign in to on that server with your own plan.

This page is the reference. For a guided walk through the same steps, see [Piomio on a server](https://piomio.io/en/server/) on the site.

## What you need

- Linux with systemd on x64 or arm64, with glibc: Ubuntu, Debian, Fedora and the like. Alpine and other musl systems are not supported.
- `curl`, `tar`, `gzip` and `sha256sum` on the server.
- SSH access as root. An ordinary user works too, see [Install without root](#install-without-root).
- A plan for Claude Code, Codex or Kimi Code that you sign in to on the server yourself. See [Brains and sign-in](brains.md).

## Two ways to use a server

- **The hub on the server.** The server is your Piomio: chats, agents, memory and the vault live there. You open it in a browser, the desktop app or the phone app.
- **A computer of your hub.** Your hub stays on your Mac or PC, and the server joins it. Agents run commands there, use its files and think with its brains. The chats stay on your computer, so while it sleeps the server waits.

The same installer does both: without arguments it installs a hub, with an invite link it installs a computer.

## Install the hub

As root:

```bash
curl -fsSL https://piomio.io/install.sh | sh
```

### What the installer does

1. Checks the system: Linux, the processor, systemd, glibc and the tools above. If something is missing, it says what and stops.
2. Run as root, it creates the user `piomio` without sudo. Piomio and its agents work as this user, so that user is the wall around them. It also turns on lingering for `piomio`, so its services keep running when nobody is logged in.
3. Downloads the latest release for your processor from GitHub, checks its SHA-256 and unpacks it. The release brings its own Node.js: nothing else to install.
4. Puts the `piomio` command into `~/.local/bin` and, if the login shell doesn't already look there, adds that folder to the PATH in the user's profile.
5. On the first install as root on a system with `apt-get`, installs the system libraries the agents' browser needs.
6. Writes the settings file `~/.config/piomio/env` (only if there is none) and the systemd user service `piomio`, starts it and waits up to two minutes for an answer.

At the end it prints the version that runs, the setup code (until a password is set), and the brains the user `piomio` has: signed in, or installed but not signed in. If none is signed in, it shows how to sign in.

Then it gets you [the link](#through-the-link). The hub starts with [access from anywhere](anywhere.md) on, so the installer shows Tailscale's sign-in page and waits:

```text
To open Piomio from any phone or browser, sign in to Tailscale (a free account is enough):
  https://login.tailscale.com/a/…
Waiting for the sign-in (Ctrl+C to stop: Piomio keeps running)…
Piomio's link, for any device:
  https://piomio.<your-tailnet>.ts.net/#setup=<code>
```

Open the sign-in page on any device and sign in. If Tailscale asks to allow Funnel, the installer shows that page next. Once the link answers from the internet, the installer prints it, with the setup code in it until a password is set. If you stop waiting, or don't want Tailscale, it prints the `ssh` line for [a tunnel](#through-an-ssh-tunnel) instead.

Three variables change what it does:

| Variable | What it does |
|---|---|
| `PIOMIO_VERSION=0.2.12` | installs that release instead of the latest |
| `PIOMIO_LANG=ru` | the installer speaks Russian (it also follows `LANG`) |
| `PIOMIO_NO_WAIT=1` | shows Tailscale's sign-in page without waiting for the link; also when the output isn't a terminal, for example when an agent runs the installer |

```bash
curl -fsSL https://piomio.io/install.sh | PIOMIO_VERSION=0.2.12 sh
```

### Running it again

Running the same command again updates Piomio to the latest release. If that version is already installed, it just restarts it. Your data and your settings file stay as they are. Only the installed version and the one before it are kept. Usually you don't need this: the **Update** button does the same, see [Updates](#updates).

### Install without root

Run the command as an ordinary user, and Piomio installs for that user, in its home. Then:

- No browser libraries are installed. If the agents' browser doesn't start, ask an admin to run the command the installer suggests.
- Keeping Piomio running after you log out needs lingering. If the installer can't turn it on, it asks you to have an admin run `sudo loginctl enable-linger <user>`.
- Leave out `sudo -iu piomio` in the commands on this page.

## Install as a computer of your hub

1. **Let the server reach your hub.** A hub on a Mac or PC at home is reachable only there until you turn on [access from anywhere](anywhere.md). Say "turn on access from anywhere" in its chat.
2. **Get an invite.** Say "connect a computer" in the chat. The card makes a one-time link that works for an hour; its **Linux server** button shows the command with that link in it, with a copy button. The link's own page shows the same command under **Server without a screen**.
3. **Run it on the server as root:**

   ```bash
   curl -fsSL https://piomio.io/install.sh | PIOMIO_NAME=vps sh -s -- https://piomio.<your-tailnet>.ts.net/join/<code>
   ```

`PIOMIO_NAME` is what the computer is called in **Machines** (without it, the server's host name). The installer creates the user `piomio`, downloads Node.js from nodejs.org (checked against its checksum) and the hub's own `piomio-node` into `~/.local/lib/piomio-node`, pairs with the hub and keeps the daemon running as the systemd user service `piomio-node`.

Then sign in to a brain as `piomio`, the same way as below. The brains become `codex@vps`, `claude-code@vps` and `kimi@vps`. What agents may do on the server is decided there, in `~/.piomio-node/policy.json`: by default they work only in `~/piomio-workspace`, and running commands is off. A change takes effect by itself. More in [Machines and other computers](machines.md).

## Sign in to a brain

The hub runs as the user `piomio`, with that user's home and the PATH of its login shell. Agents think with the CLI that this user is signed in to. Piomio copies nothing, and never takes or stores the CLI's tokens. Sign in yourself, as that user. Codex, for example:

```bash
sudo -iu piomio
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex login --device-auth
```

- Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`, then `claude`.
- Kimi Code: `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`, then `kimi` and `/login`.

While no brain works, the hub looks for the CLIs again every 30 seconds, so a sign-in shows up within a minute without a restart. You can also skip this and press **Sign in** on the card in the chat later: on a server install it first installs a missing CLI into Piomio's data folder. See [Brains and sign-in](brains.md).

## Open the chat

### Through the link

Open the link the installer printed, `https://piomio.<your-tailnet>.ts.net/#setup=<code>`, on any phone or computer. The setup code is already in it: choose a password, and the assistant takes you through the rest in the chat ([First run](first-run.md)). From then on you sign in there with that password. The link works in any browser, the phone app and on your other computers, with no tunnel and no open ports. See [Access from anywhere](anywhere.md).

Didn't sign in to Tailscale during the install? The assistant offers it first thing in the chat, or sign in later and print the link:

```bash
sudo -iu piomio piomio link --wait
```

### Through an SSH tunnel

The chat itself listens only on the server. On your computer, run the line the installer printed and keep it running:

```bash
ssh -N -L 8080:localhost:8080 -L 8081:localhost:8081 root@<server-ip>
```

Then open http://localhost:8080, enter the setup code and choose a password. The assistant takes you through the rest in the chat ([First run](first-run.md)). Lost the code?

```bash
sudo -iu piomio cat ~/.local/share/piomio/setup-code
```

Use the same port numbers on both sides of the tunnel. The hub accepts changes only from the address it knows, `http://localhost:8080`: through `-L 18080:localhost:8080` the page loads, but nothing can be saved. If you change `PIOMIO_PORT`, use the new number on both sides.

### Why not the server's IP?

Piomio opens the chat only on `127.0.0.1`, on purpose:

- The chat (port 8080) speaks plain HTTP. Over the internet your password and session would travel unencrypted, and bots find an open port within minutes.
- Passkeys work only over HTTPS or on `localhost`, so `http://<ip>:8080` can't use them.
- Port 8081 is the security console: approvals, the vault, rules and the audit log. It should never face the internet.

If you still want the bare address, with plain HTTP and no passkeys, put this in `~/.config/piomio/env`:

```ini
PIOMIO_HOST=0.0.0.0
PIOMIO_PUBLIC_URL=http://<server-ip>:8080
```

Then, as root, `ufw allow 8080/tcp` (only 8080: the console now listens on every address too, so keep 8081 closed), and as `piomio`, `systemctl --user restart piomio`. Without `PIOMIO_PUBLIC_URL` the hub refuses every address but `localhost`.

### Ports

| Port | What | Listens on |
|---|---|---|
| 8080 | the chat, its API and the agents' MCP endpoint | `127.0.0.1` (`PIOMIO_HOST`) |
| 8081 | the security console | `127.0.0.1` (`PIOMIO_HOST`) |
| 8082 | HTTPS for the phone app | every address (`PIOMIO_DEVICE_HOST`) |
| 8089 | the egress proxy for brains and plugins | `127.0.0.1` only |

Port 8082 uses the hub's own certificate, which the phone app pins from the pairing QR code, so it is fine to open: `ufw allow 8082/tcp`. `PIOMIO_DEVICES=0` in the settings file closes it; phones then come through the link. See [The iPhone app](phone.md).

## Files and folders

All paths are in the home of the user Piomio runs as (`/home/piomio` after an install as root).

| Path | What |
|---|---|
| `~/.local/lib/piomio/` | the app: `versions/<version>`, `current` (the one that runs) and the launcher `piomio` |
| `~/.local/bin/piomio` | the `piomio` command |
| `~/.local/share/piomio/` | the data: database, vault, workspaces, plugins, memory, the setup code |
| `~/.config/piomio/env` | settings, one `NAME=value` per line |
| `~/.config/systemd/user/piomio.service` | the service |
| `~/.local/lib/piomio-node/`, `~/.piomio-node/` | on a computer of your hub: the daemon with its Node; its key, pairing and policy |

The brain CLIs keep their own sign-ins in that home, where you signed in to them. After a change in the settings file, restart: `systemctl --user restart piomio`. Every variable is listed in [Settings and environment variables](settings.md#environment-variables).

## Commands

### The hub

Run these after `sudo -iu piomio`:

| Command | What it does |
|---|---|
| `piomio version` | prints the installed version |
| `piomio link [--wait]` | prints the link from anywhere, or Tailscale's sign-in page while it waits for one; `--wait` waits for the sign-in |
| `piomio backup [folder]` | makes a backup, see [Backups](#backups) |
| `piomio reset-password <new>` | sets a new password for the chat (8 characters or more) and signs out every session |
| `piomio devices pair` | shows a QR code for the phone app right in the terminal, with its link and code |
| `piomio audit-verify` | checks the audit log's hash chain |
| `piomio uninstall` | removes the app and the service, see [Remove Piomio](#remove-piomio) |
| `systemctl --user restart piomio` | restarts Piomio |
| `systemctl --user status piomio` | shows whether it runs |
| `journalctl --user -u piomio -f` | follows the log |

These commands don't read `~/.config/piomio/env`, only systemd does. If you changed `PIOMIO_DATA_DIR` or the ports there, load the file first:

```bash
set -a; . ~/.config/piomio/env; set +a; piomio devices pair
```

`piomio replica invite` and `piomio replica join` belong to hub replicas, see [Machines and other computers](machines.md).

### A computer of your hub

| Command | What it does |
|---|---|
| `piomio-node status` | whether it is paired, its policy, its CLIs and whether the hub answers |
| `piomio-node policy` | the policy file's path and contents |
| `piomio-node version` | the daemon's version |
| `journalctl --user -u piomio-node -f` | follows the log |
| `piomio-node uninstall` | removes the daemon and its service; the key and the policy stay |

## Updates

The hub checks GitHub for a new release every hour, and right away when you open Piomio or come back to it (at most every ten minutes). When there is one, the server's row in **Machines** shows **Update**, and the assistant offers it in the chat at most once a day. You can also just say "update Piomio".

On the button the hub downloads the release, checks its signature, makes sure the new version starts, keeps a copy of the database and restarts. It is back in about a minute, and the assistant tells you what changed. If the new version doesn't come up three times in a row, the server goes back to the previous version with the database as it was before, and the assistant says so in the chat.

A computer of your hub gets its new `piomio-node` from the hub: its row in **Machines** shows **Update** when it is behind. See [Updates](updates.md).

## Backups

```bash
piomio backup
```

This writes a copy to `~/.local/share/piomio/backups/<date and time>`: the database (chats, agents, tasks, settings), the vault (still encrypted with your vault passphrase), and the folders with agents, skills, commands, installed plugins and the plugins' data, memory included. It works while Piomio runs. Not in the backup: the agents' working folders (`workspaces`), pages, the CLIs' sign-ins and the access-from-anywhere node.

With a folder name, the copy goes there instead. Use a new, empty folder each time: an existing database file there makes the backup fail.

Keep copies off the server too, for example with `scp` to your computer. There is no restore command: to restore by hand, stop Piomio (`systemctl --user stop piomio`), move `piomio.db` and `vault.db` in the data folder aside together with their `-wal` and `-shm` files, copy the backup's files and folders in, and start it again.

Before every update the hub also keeps a copy of the database by itself, and uses it if it has to go back.

## Remove Piomio

As `piomio`:

```bash
piomio uninstall
```

This stops and removes the service, the `piomio` command and `~/.local/lib/piomio`. Your data stays in `~/.local/share/piomio` and the settings in `~/.config/piomio`: delete them yourself if you no longer need them. The user `piomio` stays too.

On a computer of your hub, `piomio-node uninstall` removes the daemon, its Node and its service. The key and the policy stay in `~/.piomio-node`. Remove the computer in **Machines** as well.
