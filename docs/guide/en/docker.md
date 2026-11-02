---
title: In Docker
nav: In Docker
description: Piomio in Docker: the image and its tags, the .env file, the data volume, opening the chat safely, the users and the egress filter inside, the vault, phones, updates and building the image yourself.
---

The Docker image is Piomio with everything it needs: the hub, the web UI, the security console, the built-in plugins, the official Claude Code, Codex and Kimi Code CLIs, a Chromium for the agents' browser and the Tailscale node for access from anywhere. It is the strongest isolation Piomio has: brains and plugins run as separate users with their own folders, and their network goes through a filter that can be enforced by the kernel. See [Security model](security.md).

You need a Linux server (or any computer) with Docker and Docker Compose, on amd64 or arm64. Without Docker, see [On a Linux server](server.md).

## Start it

```bash
git clone https://github.com/legostin/piomio.git && cd piomio
docker compose up -d
docker compose logs piomio | grep -A1 "Piomio:"
```

The last command prints the setup code you enter on the first visit. Then [open the chat](#open-it) and go through the [first start](#first-start).

## The image and its tags

`docker compose` takes the ready image `ghcr.io/legostin/piomio` from GitHub, built for linux/amd64 and linux/arm64. Which one runs is set by `PIOMIO_IMAGE_TAG` in `.env`:

| Tag | What it is |
|---|---|
| `latest` | the last release (the default) |
| `main` | every change to the main branch, and rebuilt every Monday with fresh system packages, CLIs and Chromium |
| `0.2.12`, `0.2` | a given release, or the newest one of a line |

The CLIs in the image don't update themselves: a newer image brings newer ones.

## Settings: the .env file

Settings go in `.env` next to `docker-compose.yml`. Copy [.env.example](https://github.com/legostin/piomio/blob/main/.env.example), which lists each one with an example, and uncomment what you need:

```bash
cp .env.example .env
```

`docker-compose.yml` itself reads two of them: `PIOMIO_IMAGE_TAG` and `PIOMIO_BIND`. Everything else goes into the container. After a change, run `docker compose up -d` again. All variables with their defaults: [Settings and environment variables](settings.md#environment-variables).

## The data volume

Everything Piomio keeps is in the volume `piomio-data`, mounted at `/data`:

| Path in `/data` | What |
|---|---|
| `piomio.db` | chats, agents, tasks, channels, settings |
| `vault.db` | the vault, encrypted with your vault passphrase |
| `home/agent` | the brain CLIs' home: your Claude Code, Codex and Kimi Code sign-ins |
| `home/plugin` | the home of other plugins and MCP servers |
| `workspaces` | the agents' working folders |
| `plugins`, `plugins-data` | installed plugins, and each plugin's own data (memory included) |
| `agents`, `skills`, `commands` | agents, skills and commands you made |
| `pages` | pages the agents made |
| `tailnet` | the keys of the access-from-anywhere node |
| `devices` | the certificate the phone app pins |
| `backups` | backups made with the `backup` command |

The hub's log is the container's output: `docker compose logs -f piomio`.

## Open it

The chat (port 8080) and the security console (port 8081) are published on the server itself, `127.0.0.1`, so nothing faces the internet.

### Through SSH

Nothing to set up. On your computer, run this and keep it running:

```bash
ssh -N -L 8080:localhost:8080 -L 8081:localhost:8081 <user>@<server>
```

Then http://localhost:8080 in your browser is the hub, passkeys included. Keep the same port numbers on both sides: the hub accepts changes only from the address it knows.

### On the server's address

Put this in `.env` and run `docker compose up -d`:

```ini
PIOMIO_BIND=0.0.0.0
PIOMIO_PUBLIC_URL=http://<address>:8080
```

Without `PIOMIO_PUBLIC_URL` the hub refuses every address but `localhost`. This is plain HTTP with no passkeys, and Docker opens published ports past `ufw`. On the open internet, put HTTPS in front.

### HTTPS in front

With your own domain and a reverse proxy (Caddy, nginx and the like) on the server, keep `PIOMIO_BIND=127.0.0.1`, point the proxy at `127.0.0.1:8080` and `127.0.0.1:8081` (WebSockets included), give the console an address of its own, and tell the hub:

```ini
PIOMIO_PUBLIC_URL=https://piomio.example.com
PIOMIO_CONSOLE_URL=https://console.piomio.example.com
PIOMIO_TRUST_PROXY=1
```

`PIOMIO_ALLOWED_HOSTS` adds more host names the hub answers to. With Tailscale on the server, `tailscale serve` can put HTTPS in front of both ports instead; see [Access from anywhere](anywhere.md).

### From anywhere

After the setup, say "turn on access from anywhere" in the chat. The hub's own Tailscale node, which is in the image, gives it a permanent HTTPS link. See [Access from anywhere](anywhere.md).

## First start

1. Open the chat, enter the **setup code** from the logs (`docker logs piomio` shows it too) and choose a password. Your browser's language becomes the hub language, unless `PIOMIO_LANG` pins it.
2. Until a brain works, the chat shows a setup card. Press **Sign in** on Claude Code, Codex or Kimi Code and sign in on the maker's own page with your own plan. The sign-in is kept in `/data/home/agent`; Piomio never takes or stores the tokens. On a hub started with `PIOMIO_API_KEYS=1`, the card also takes an API key. See [Brains and sign-in](brains.md).
3. Then the assistant leads the rest of the setup in the chat. See [First run](first-run.md).

## Users inside the container

| User | Runs | Its folders |
|---|---|---|
| `piomio` | the hub | owns `/data` |
| `agent` | the brain CLIs (Claude Code, Codex, Kimi Code) | `/data/home/agent` |
| `plugin` | other plugins and MCP servers | `/data/home/plugin`, and `/data/plugins-data/<plugin>` for each plugin |

The hub starts the others through `sudo` and hands each only the variables it needs. The agents' working folders belong to the group `piomio`, which `agent` is in, so the brains can write there; the database and the vault belong to `piomio` alone.

## The egress filter

Brains and plugins reach the network only through the hub's egress proxy on `127.0.0.1:8089`, each with its own allowlist:

- Brains may reach their makers (Anthropic, OpenAI, Kimi), GitHub, npm, PyPI and the like, plus **Extra allowed hosts** in **Settings → General**.
- A plugin may reach the hosts its permissions name.
- Addresses on private networks (your LAN, `localhost`) are refused unless the host is listed in `egressPrivateAllow`, see [Settings without a field](settings.md#settings-without-a-field).

By default (`PIOMIO_EGRESS_ENFORCED=proxy`) the programs are told to use the proxy, and a program that ignores that could still connect directly. To have the kernel block that, uncomment `cap_add: [NET_ADMIN]` in `docker-compose.yml`, put this in `.env` and run `docker compose up -d`:

```ini
PIOMIO_EGRESS_ENFORCED=iptables
```

Then `agent` and `plugin` can reach only the loopback (the proxy and the hub) and DNS. The log says `egress enforced with iptables`. Without the capability it warns `iptables unavailable` and falls back to the proxy alone.

## Unlock the vault automatically

After a restart the vault is sealed until you unlock it. Two ways to have it open by itself:

- **In the chat.** On the vault card, leave **Unlock automatically after restarts (the passphrase is kept on this server)** on. The passphrase goes into `/data/vault.passphrase`, readable by the hub only.
- **A file you provide**, for example a Docker secret. Put a `docker-compose.override.yml` next to `docker-compose.yml` (Compose reads it by itself):

  ```yaml
  services:
    piomio:
      secrets:
        - piomio_vault
  secrets:
    piomio_vault:
      file: ./vault-passphrase.txt
  ```

  and in `.env`:

  ```ini
  PIOMIO_VAULT_PASSPHRASE_FILE=/run/secrets/piomio_vault
  ```

The file has to be there when the hub starts and readable by the user `piomio` inside the container. If there is no vault yet, the passphrase in the file creates it. If unlocking fails, the log says `[vault] auto-unlock failed`.

## Phones

The phone app talks to the hub over its own HTTPS port, 8082 inside the container. Inside Docker the hub only sees the container's addresses, which phones can't reach. To pair over your network, publish the port (uncomment `- "8082:8082"` in `docker-compose.yml`, or add it in the override file) and list the addresses phones should use in `.env`:

```ini
PIOMIO_DEVICE_URLS=https://192.168.1.10:8082
```

Without that, phones come through the link of [access from anywhere](anywhere.md). To pair, say "connect my phone" in the chat, or open **Settings → Devices** and press **Connect a phone**. See [The iPhone app](phone.md).

## The browser

Chromium is in the image. It runs with a real window on a virtual display inside the container, so pages see an ordinary browser and screenshots look real. Chromium needs shared memory: keep `shm_size: 1gb` from `docker-compose.yml` (with plain `docker run`, `--shm-size=1g`). See [The browser and teach mode](browser.md).

## Container commands

```bash
docker exec piomio piomio-entrypoint reset-password 'new-password'
docker exec piomio piomio-entrypoint backup
docker exec piomio piomio-entrypoint audit-verify
```

- `reset-password` sets a new password (8 characters or more) and signs out every session.
- `backup` copies the database, the vault (still encrypted), agents, skills, commands, plugins and their data into `/data/backups/<date and time>`. A folder after it puts the copy there instead; use a new, empty one each time. Not in the backup: the working folders, pages and the CLIs' sign-ins.
- `audit-verify` checks the audit log's hash chain and exits with code 2 if it is broken.

A backup in the volume is lost with the volume, so copy it out:

```bash
docker cp piomio:/data/backups ./piomio-backups
```

Other everyday commands: `docker compose logs -f piomio` (the log), `docker compose restart piomio` (a restart), `docker compose ps` (the health check shows whether the hub answers).

## Update

```bash
git pull && docker compose pull && docker compose up -d
```

`git pull` brings the newest `docker-compose.yml`, `docker compose pull` the newest image of your tag. The **Update** button of the desktop app and of server installs is not for Docker: the hub says so when asked. If you pinned a version in `PIOMIO_IMAGE_TAG`, change it there first. See [Updates](updates.md).

## Build the image yourself

```bash
docker compose up -d --build
```

This builds the image from the folder you cloned instead of pulling it. The build compiles the web UI and the Tailscale node and downloads the CLIs and Chromium, so it takes a while. Without Compose: `docker build -f docker/Dockerfile -t piomio .` from the repository root.

## Remove it

`docker compose down` stops and removes the container; the `piomio-data` volume with all your data stays. `docker compose down -v` deletes the volume too: chats, the vault, the sign-ins, everything. It can't be undone, so make and copy out a backup first.
