---
title: Troubleshooting
nav: Troubleshooting
description: Problems people meet with Piomio and what to do about them: the desktop app, brains, signing in, servers, phones, access from anywhere, Telegram, the vault, the browser, the logs and backups.
---

When something goes wrong, first ask in the chat: "why doesn't Telegram answer?", "which brains work?". The assistant sees the state of the brains, plugins and machines, and many fixes are a button on a card it shows. If the chat itself doesn't open, start with the [logs](#where-the-logs-are).

## The desktop app

### "Port … is taken"

Another program holds the port Piomio needs (41780, or 41781 and 41789 next to it). Close that program and press **Try again**. Or give Piomio other ports: put `{"port": 19000}` into `desktop.json` in its data folder ([where that is](settings.md#files-and-folders)) and choose **Restart** in the icon's menu.

### "Piomio keeps stopping" or "Piomio did not answer in time"

**Show log**, in the window or in the icon's menu, opens the hub's log with the reason. **Try again** starts it again. "Piomio's files are damaged" means the app itself is broken: install it again. Your data is in your user folder, not in the app, so it stays.

### "This sign-in link has expired. Sign in with your password."

The app signs its window in with a one-time link. When that link is too old, sign in with your Piomio password once.

### The window stays white on Windows

Piomio was ended abruptly (by an update, a crash or **End task**) and left the window's saved graphics data damaged: the page runs, but nothing is drawn. The app clears that data when it starts after such an exit, so the next start draws the window again. On a version from before that fix, install the next update from the icon's menu (**Install update …**): the new version clears it as it starts.

### Windows warns that it protected your PC

The Windows app isn't signed yet. Choose **More info → Run anyway**. See [Install on a Mac or PC](install.md).

## Brains and sign-in

### The assistant says it needs a brain

The card "To answer you, I need a brain" means no brain works yet. Press **Sign in** on Claude Code, Codex or Kimi Code and sign in on the maker's own page with your own plan. Your message is answered as soon as one works. In the desktop app and on a server install, a missing CLI is installed first. See [Brains and sign-in](brains.md).

### A CLI is signed in, but Piomio doesn't see it

- **Desktop app:** Piomio uses your user's CLIs and the PATH of your login shell. Installed one just now? Press **Check again** on the card.
- **Server:** sign in as the user Piomio runs as, `piomio`, not as root. Check with `sudo -iu piomio`, then `codex login status` or `claude auth status`. While no brain works, Piomio looks again every 30 seconds.
- **A computer of your hub:** sign in as the user its daemon runs as. `piomio-node status` lists each CLI and whether it is signed in.

### "Paste the whole code from the sign-in page"

Claude Code shows a code after you sign in on its page. Copy all of it into the card, not into the chat. For Codex and Kimi Code it is the other way round: you enter the card's code on their page.

### "The sign-in took too long and was stopped"

The code from the card works only for a while (the card says until when). Press **Try again** and finish on the sign-in page sooner.

### "Kimi Code: this Kimi account's plan does not include Kimi Code"

The Kimi account you signed in with has no Kimi Code plan. Sign in with an account that has one, or use another brain.

### A brain hit its limit

The agent moves on to the next brain in its list, if it has one. The **Brains** page shows until when a brain is limited. Give your agents a second brain to fall back on, see [Agents and the team](agents.md).

### I pasted a token from `claude setup-token`

Piomio removes it from your message and keeps it nowhere: Anthropic's terms don't allow apps to store these tokens. Sign Claude Code in with **Sign in** instead.

## Signing in to Piomio

### "Wrong setup code", or the code is lost

The setup code works only until you choose a password. Where to find it:

- **Desktop app:** the window opens with the code already filled in.
- **Server:** `sudo -iu piomio cat ~/.local/share/piomio/setup-code`

### Forgot the password

- **Server:** `piomio reset-password '<new password>'`, after `sudo -iu piomio`.
- **From source:** `node packages/core/src/cli.ts reset-password '<new password>'`.

Both sign out every session. The desktop app signs its own window in, so there you need the password only in other browsers.

### "Too many failed attempts. Wait 15 minutes."

Ten wrong passwords or codes from one address within 15 minutes lock that address out for a while. Wait, or sign in on the computer itself.

### "Host not allowed. Add it to PIOMIO_ALLOWED_HOSTS."

You opened the hub at an address it doesn't know, such as the server's IP or a domain. Set `PIOMIO_PUBLIC_URL` to that address, or add the name to `PIOMIO_ALLOWED_HOSTS`, and restart. Before you open the hub on a bare IP, read [Why not the server's IP?](server.md#why-not-the-servers-ip).

### The page opens, but nothing saves ("Origin not allowed")

The address in your browser differs from the hub's `PIOMIO_PUBLIC_URL`, for example through an SSH tunnel to another local port. Use the same port numbers on both sides of the tunnel, or set `PIOMIO_PUBLIC_URL` to the address you actually use.

## On a server

### The installer stops before it installs

| It says | What to do |
|---|---|
| "This installer is for Linux servers" | on a Mac or a Windows PC, install the app: [Install on a Mac or PC](install.md) |
| "This processor (…) is not supported" | only x86_64 and arm64 are: use a server with one of them |
| "This Linux has no systemd" or "uses musl" | use Ubuntu, Debian, Fedora or the like |
| "Piomio's installer needs curl" (or `tar`, `gzip`, `sha256sum`) | install that tool and run it again |
| "Could not find the latest release on GitHub" | run it with `PIOMIO_VERSION=x.y.z` |
| "The download does not match its checksum" | run it again |

### "Piomio did not answer within two minutes"

The installer prints the command that shows the log: run it and read the last lines. If another program holds port 8080, put another one in `~/.config/piomio/env` (`PIOMIO_PORT=9090`) and run `systemctl --user restart piomio` as `piomio`.

### "Could not keep Piomio running after you log out"

Lingering couldn't be turned on, so Piomio would stop when you log out. Have an admin run `sudo loginctl enable-linger <user>`.

### `systemctl --user` can't connect to the bus

Open the user's shell with `sudo -iu piomio`, not with `su` or `sudo -u`: the installer set that shell up so `systemctl --user` and `journalctl --user` work there.

### The chat doesn't open on localhost:8080

The `ssh -L` line has to keep running while you use the chat. On the server, `sudo -iu piomio`, then `systemctl --user status piomio` and `journalctl --user -u piomio -n 50` show whether Piomio runs and what stops it. If port 8080 is taken on your own computer, free it: a tunnel to another local port loads the page but can't save.

### An update went back to the old version

When a new version doesn't start three times in a row, the server goes back to the previous one with the database as it was, and the assistant tells you in the chat. That version isn't offered again; a newer one will be. The log shows why: `journalctl --user -u piomio`.

### A computer of your hub doesn't connect

- "Could not reach the hub": the invite link has to open from the server, so try `curl -I <link>` there. A hub at home needs [access from anywhere](anywhere.md) turned on.
- "The invite has expired or was already used": each link works once, for an hour. Ask the chat for a new one and run the installer again.
- The `piomio-node` service stopped: `piomio-node status` says whether it is still paired. A computer removed from **Machines** has to be connected again with a new invite.

## The phone

### The phone doesn't connect at home

Allow incoming connections to the phones' port in the computer's firewall: 8082 on a server (`ufw allow 8082/tcp`), 41782 in the desktop app. Or turn on [access from anywhere](anywhere.md), and the phone uses the link. See [The iPhone app](phone.md).

### "Phones cannot reach the hub"

The phones' port is closed (`PIOMIO_DEVICES=0`) and access from anywhere is off. Turn one of them on.

### "This computer has no network address a phone could use"

Connect the computer to Wi-Fi or Tailscale.

### "Port … for phones is taken"

Another program holds the phones' port. Set `PIOMIO_DEVICE_PORT` to a free one and restart Piomio.

### "The invite has expired or was already used"

Each QR code and link works once. Say "connect my phone" in the chat, or press **Connect a phone** in **Settings → Devices** again.

### "The Face ID confirmation did not check out"

The approval's signature from the phone didn't verify. Try again.

## Access from anywhere

### "Access from anywhere is not in this build of Piomio"

The hub's Tailscale node is missing. The desktop app and the server install include it; when you run from source, build it with `npm run build:tailnet` (needs Go).

### "Tailscale is waiting for your tailnet's admin to approve the piomio machine"

Your tailnet requires approving new machines. Approve `piomio` in Tailscale's admin console, under Machines.

### Passkeys don't work through the link

Passkeys belong to the computer's own address. Through the link, sign in with your password.

### "Signing in from outside is paused for an hour"

30 wrong passwords came through the link within an hour, so signing in from outside pauses for an hour. Signing in on the computer itself keeps working. If it wasn't you, change your password in the security console.

### The security console doesn't open through the link

By design: the console, the first-run setup and plugin webhooks never go through the link. Open the console on the computer itself, or through an SSH tunnel to port 8081. See [Access from anywhere](anywhere.md).

## Telegram

### "Telegram rejected the bot token"

Get a new token from @BotFather and say "connect Telegram" in the chat: the card takes the new one. See [Telegram](telegram.md).

### The bot doesn't answer

It is waiting to be linked. On the Telegram card, press **Open the bot in Telegram** and tap Start, or send the bot the `/start` command with the code from the card. The bot answers only the one private chat it is linked to.

### "Sorry, this bot is personal and already linked to another chat."

Press **Unlink** on the Telegram card, then link it again from the chat you want.

### "… is over 20 MB"

Telegram doesn't let bots download larger files. Send it in the web chat instead.

### "The bot is blocked in the linked chat"

You blocked the bot in Telegram. Unblock it there.

## The vault

### "The vault is sealed"

After a restart the vault is sealed until you unlock it, and meanwhile agents can't use keys or sign in to sites. Unlock it on the card in the chat or in the security console. Leave **Unlock automatically after restarts (the passphrase is kept on this server)** on, and it opens by itself next time. You can also give it a passphrase file with `PIOMIO_VAULT_PASSPHRASE_FILE`, see [Sealed after a restart](security.md#sealed-after-a-restart).

### "Automatic unlock from a file is configured but did not work"

The log says `[vault] auto-unlock failed` with the reason: usually the passphrase in the file is wrong, or the hub can't read the file.

### I forgot the vault passphrase

It can't be recovered: neither Piomio nor anyone else can decrypt the vault without it. That is the point of the vault.

## The browser and the network

### "Installing Chromium"

The agents' browser downloads Chromium once, on first use; browser calls wait for it. Give it a minute.

### "Could not install Chromium"

It tries again the next time the browser is needed. On a server, check that it can reach the internet.

### "Chromium is not installed, and the automatic install is turned off"

`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` is set. Remove it, or install Chromium yourself with `npx playwright install chromium`.

### The browser doesn't start on a server

Chromium needs system libraries, which the installer puts in only on the first install as root on systems with `apt-get`. Install them as root:

```bash
/home/piomio/.local/lib/piomio/current/runtime/bin/node /home/piomio/.local/lib/piomio/current/node_modules/playwright/cli.js install-deps chromium
```

### "… resolves to a private address; add it to egressPrivateAllow to allow"

A plugin or a brain tried to reach a host on your local network, which the egress filter refuses. If that host is yours, add it to `egressPrivateAllow`, see [Settings without a field](settings.md#settings-without-a-field).

## Where the logs are

| Where Piomio runs | The log |
|---|---|
| Desktop app | **Show log** in the icon's menu: `logs/hub.log` in the data folder |
| Linux server | `journalctl --user -u piomio -f`, after `sudo -iu piomio` |
| A computer of your hub | `journalctl --user -u piomio-node -f` on a server; **Show log** in the app |
| A plugin | **Settings → Plugins**, the plugin, **Logs** |
| What agents did | the **Audit** page of the security console |

## Backups and starting over

### Make a backup

- **Server:** `piomio backup` writes a copy to `~/.local/share/piomio/backups`. See [Backups](server.md#backups).
- **Desktop app:** quit Piomio (**Quit Piomio** in the icon's menu) and copy its data folder.

### Restore a backup

There is no restore command. Stop Piomio, move `piomio.db` and `vault.db` in the data folder aside together with their `-wal` and `-shm` files, copy the backup's files and folders in, and start Piomio again. The vault opens with the passphrase it had when the backup was made.

### Start over

- **Desktop app:** **Reset Piomio…** in the icon's menu, or in **Settings → General → This app**. It deletes the chats, agents, memory, the vault, plugins, settings and this computer's connection to a hub, after asking. Your Claude Code and Codex sign-ins stay: they belong to those tools.
- **Server:** as `piomio`, `systemctl --user stop piomio`, move `~/.local/share/piomio` aside, then `systemctl --user start piomio`. The hub starts empty with a new setup code; your CLI sign-ins stay.
