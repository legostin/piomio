# Setting up Piomio: instructions for an AI agent

You are a coding agent (Claude Code, Codex, Kimi Code or similar) and the person asked you to install Piomio on the machine you run on and set it up. Piomio is a self-hosted team of AI agents the person talks to in a chat; its agents think with the Claude Code, Codex or Kimi Code the person is signed in to. Follow these steps in order. Talk to the person in their language, briefly, one question at a time.

## Rules

- Download only from `https://piomio.io` and `https://github.com/legostin/piomio` (and, if a CLI is missing, its official installer named below).
- Never ask for, read out, type or store a password, token or API key. The person chooses Piomio's password in Piomio's own window or page; keys go into Piomio's encrypted vault through its chat later.
- Never copy a CLI's sign-in (`~/.claude*`, `~/.codex`, `~/.kimi`, keychain items) to another user or machine. Whoever runs Piomio signs in as themselves.
- Never delete or move Piomio's data: `~/Library/Application Support/Piomio` or `.../Owlbot` (macOS), `%LOCALAPPDATA%\Piomio` (Windows), `~/.local/share/piomio` (Linux). Reinstalling and updating keep it.
- Ask before you use `sudo` or root, replace an installed Piomio, or change a firewall. Don't make the chat reachable from the network: it stays on `localhost`, and "access from anywhere" in Piomio's chat gives it a private HTTPS link later.
- If a step fails, read the error, try the fix this guide gives, and otherwise tell the person what happened in plain words. Don't improvise around a security check.

## 1. Look at the machine

Find out the OS, the CPU architecture, whether it has a screen (a Mac or PC the person sits at) or is a server reached over SSH, and whether Piomio is already there:

- macOS: `/Applications/Piomio.app` (also `~/Applications`).
- Windows: a `Piomio.exe` under `%LOCALAPPDATA%`, or Piomio in Settings → Apps.
- Linux: `command -v piomio`, `~/.local/lib/piomio`, or a `piomio` user (`id piomio`).

Already installed? Don't reinstall. Make sure it runs (open the app, or `systemctl --user status piomio` as the user it runs as) and tell the person how to open the chat (the last step). Updates come on Piomio's own Update button.

## 2. Ask one question: which way

- **A new Piomio here** (most people): this machine becomes the person's Piomio. Chats, agents and memory live here.
- **A computer of the Piomio they already have**: their Piomio stays where it is, and this machine joins it so agents can work here. They need an invite: in their Piomio's chat they say "connect a computer" and get a one-time link `https://<hub>/join/<code>` (it works for an hour). Their Piomio must be reachable from here: on a home computer that means "turn on access from anywhere" in its chat first.

## 3a. macOS (13.5 or later, Apple silicon or Intel)

```sh
v=$(curl -fsSL https://github.com/legostin/piomio/releases/latest/download/latest.json | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1)
tmp=$(mktemp -d)
curl -fL -o "$tmp/piomio.dmg" "https://github.com/legostin/piomio/releases/latest/download/piomio-$v.dmg"
hdiutil attach -nobrowse -quiet -mountpoint "$tmp/mnt" "$tmp/piomio.dmg"
ditto "$tmp/mnt/Piomio.app" /Applications/Piomio.app   # not writable for this user? ~/Applications/Piomio.app
hdiutil detach -quiet "$tmp/mnt"; rm -rf "$tmp"
```

The app is signed and notarized by Apple. Then start it:

- A new Piomio here: `open -a Piomio --args --mode hub`. Its window asks the person to pick a password: tell them to do that.
- A computer of their Piomio: `open -a Piomio --args --mode node`, then `open "<invite link>"`: the page has **Open Piomio**, which the person clicks.

## 3b. Windows (10 or 11, x64)

In PowerShell:

```powershell
$v = (Invoke-RestMethod https://github.com/legostin/piomio/releases/latest/download/latest.json).version
$exe = "$env:TEMP\piomio-setup.exe"
Invoke-WebRequest "https://github.com/legostin/piomio/releases/latest/download/piomio-setup-$v-x64.exe" -OutFile $exe
Start-Process $exe -ArgumentList "/S" -Wait; Remove-Item $exe
$app = Get-ChildItem $env:LOCALAPPDATA -Filter Piomio.exe -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1
Start-Process $app.FullName -ArgumentList "--mode", "hub"   # a computer of their Piomio: "--mode", "node"
```

It installs for this user only, without administrator rights. A new Piomio: the person picks a password in its window. A computer of their Piomio: `Start-Process "<invite link>"`, and the person clicks **Open Piomio** on that page.

On a Mac or PC Piomio thinks with the CLIs this user is already signed in to, so the sign-in you run under works as it is: nothing to sign in again.

## 3c. Linux server (systemd, x64 or arm64)

On Alpine and other musl systems, use Docker instead: https://piomio.io/en/server/#docker.

Ask the person how Piomio should run, then install:

- **As its own user (recommended)**: run as root, which creates the user `piomio` without sudo; agents then can't touch the rest of the server. Ask before using root or sudo; if sudo needs a password, give the person the command to run themselves.
- **As the user you run as**: no root needed, and Piomio uses this user's CLI sign-in as it is, but agents get this user's rights.

A new Piomio here:

```sh
curl -fsSL https://piomio.io/install.sh | sh
```

A computer of their Piomio (`PIOMIO_NAME` is what it's called in their Machines list):

```sh
curl -fsSL https://piomio.io/install.sh | PIOMIO_NAME=<name> sh -s -- "<invite link>"
```

The installer prints the setup code, the `ssh -L` line that opens the chat, and the brains it found. Keep that output for the last step.

**Sign in to a brain** as the user Piomio runs as (`sudo -iu piomio` when it is `piomio`; skip if Piomio runs as you and you are signed in). The person does the sign-in, since it opens their account; give them the commands for the CLI they use:

- Codex: `curl -fsSL https://chatgpt.com/codex/install.sh | sh`, then `codex login --device-auth`.
- Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`, then `claude` and follow its sign-in.
- Kimi Code: `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`, then `kimi` and `/login`.

Piomio sees a new sign-in within a minute; no restart. Check it: `systemctl --user status piomio` (or `piomio-node status` for a computer of their Piomio) as that user, and `journalctl --user -u piomio -n 50` if something is off.

## 4. Tell the person how to open the chat

End with a short summary: what you installed and where, what they still have to do, and how to open the chat:

- Mac or PC, a new Piomio: the Piomio window is open; they pick a password there, and the assistant in the chat takes them through the rest (Telegram, other computers, getting to know them). The chat is also at http://localhost:41780 on this computer.
- A server with a new Piomio: on their own computer they run the `ssh -N -L 8080:localhost:8080 -L 8081:localhost:8081 <user>@<server>` line the installer printed and keep it running, open http://localhost:8080, enter the setup code and pick a password. Later "turn on access from anywhere" in the chat gives a permanent private link with no tunnel.
- A computer of their Piomio: it shows up in the Machines list of their Piomio; they decide there what agents may do on it.

More: the docs at https://piomio.io/en/docs/ (each page also as Markdown: https://piomio.io/en/docs/server.md, …; the list is in https://piomio.io/llms.txt), the server guide at https://piomio.io/en/server/ and the README at https://github.com/legostin/piomio.
