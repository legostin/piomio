---
title: Install on a Mac or PC
nav: Install on a Mac or PC
description: The Piomio desktop app for macOS and Windows: which file to download, the first start, the menu bar icon, where your data lives, ports and uninstalling.
---

The desktop app is the easiest way to run Piomio. It holds the whole hub (the chats, agents, memory and the vault) and keeps it running in the background on your Mac or PC. It brings everything it needs, so there is no Node.js, Docker or WSL to install. It takes about two minutes.

Want Piomio on a server that stays on instead? See [On a Linux server](server.md) or [In Docker](docker.md).

## What you need

- **macOS 13.5 or later**, on Apple silicon or Intel (one app for both).
- **Windows 10 or 11**, 64-bit (x64).
- An account with at least one of **Claude Code**, **Codex** or **Kimi Code**. Agents think with these official CLIs, signed in with your own plan. If the CLI isn't on the computer yet, Piomio can install it for you (see [Claude Code, Codex and Kimi Code](#claude-code-codex-and-kimi-code)).

## Download

Get the file for your system from the [latest release on GitHub](https://github.com/legostin/piomio/releases/latest) or from [piomio.io](https://piomio.io):

| File | What it is |
|---|---|
| `piomio-<version>.dmg` | macOS: a disk image. This is the one most people want. |
| `piomio-<version>.pkg` | macOS: a package for silent installs over SSH or MDM. |
| `piomio-setup-<version>-x64.exe` | Windows 10 and 11: the installer. |

The other files in a release (`latest.json`, `.sig` signatures, `…-mac.app.tar.gz`, the Linux archives and `install.sh`) are for updates and servers. You don't need them.

If your hub already runs somewhere else, its invite page (the link you get when you ask it to connect a computer) also has a **Download for …** button for your system.

## Install on macOS

1. Open the disk image and drag **Piomio** to **Applications**.
2. Open Piomio from **Applications**.

The Mac app is signed and notarized by Apple, so macOS opens it without a warning.

## Install on Windows

1. Run `piomio-setup-<version>-x64.exe`. It installs for your Windows user only, into `%LOCALAPPDATA%\Piomio`, and needs no administrator rights.
2. Open Piomio.

The Windows app isn't signed yet, so SmartScreen may say "Windows protected your PC". Choose **More info**, then **Run anyway**.

## The first start

The first window asks **How will you use this computer?**

- **A new Piomio on this computer.** Your hub runs here, and the chats, agents and vault stay on this computer. Piomio starts, then its window asks you to choose a password (at least 8 characters). There is no setup code to copy: the app passes it along by itself. From then on the app signs its own window in, so you need the password only in another browser or on your phone. Then the chat asks you to sign in to a brain: [First run](first-run.md) walks through it.
- **Connect to my Piomio.** Your hub already runs on another computer or a server, and this computer becomes one of its machines: agents can use its Claude Code, Codex and the folders you allow. Paste an **Invite link** and check the **Machine name** (your computer's name is filled in), then press **Connect**. To get a link, say "connect a computer" in your hub's chat, or press **Connect a machine** on its **Machines** page. Easier still: open the invite link on this computer and press **Open Piomio** on that page. The app then asks **Connect to …?** with everything filled in. More in [Machines and other computers](machines.md).

If this computer was connected to a hub before, the window also offers **Use the existing connection to …**.

Closing this first window without choosing quits the app. You can change your mind later with **Set up again…** in the menu.

## Claude Code, Codex and Kimi Code

On the desktop, the hub runs as your own user and thinks with the CLIs in your account:

- **Already installed and signed in?** Piomio finds it (it reads the same PATH your terminal uses) and uses it as it is. No second sign-in.
- **Not installed?** Its row on the sign-in card says **Install and sign in**. Piomio downloads the official package into its own data folder (a one-time download of a few hundred MB), then the sign-in starts. If you later install the CLI yourself, your copy wins.

You sign in on the maker's own page with your own account. Piomio only hands the one-time code to the CLI; it never takes or stores the CLI's tokens. More in [Brains and sign-in](brains.md).

## The menu bar or tray icon

Piomio keeps an icon in the menu bar (macOS) or the system tray (Windows). On a Mac any click opens its menu. On Windows a click opens the window, and a right click opens the menu.

| Item | What it does |
|---|---|
| The first line | The state: **Starting…**, **Running**, **Restarting…**, **Stopped: it kept crashing**, **Port … is taken**, or **Machine of …** when this computer is connected to another hub. |
| **Check for updates** | Looks for a new release now. When one is downloaded, it turns into **Install update …**. See [Updates](updates.md). |
| **Open Piomio** | Opens the window. |
| **Start at login** | Starts Piomio in the background when you sign in to your computer. On by default. |
| **Show log** | Opens the log: the hub's, or the machine daemon's when this computer is a machine of another hub. |
| **Restart** | Restarts the hub (or the machine daemon). |
| **Set up again…** | Shows the first window again, to switch between a hub here and a machine of another hub. |
| **Reset Piomio…** | Deletes everything Piomio keeps on this computer, after asking (see [Start from scratch](#start-from-scratch)). |
| **Quit Piomio** | Stops the app and the hub. |

The hub's **Settings** page has the same **Quit Piomio** and **Reset Piomio…** under **This app**, when it runs in the desktop app.

## It keeps running in the background

Closing the window doesn't stop Piomio. Telegram, tasks, schedules and reminders go on, and the icon stays. On a Mac the Dock icon shows only while a window is open. Open the window again from the icon's menu or by opening the app.

**Quit Piomio** stops everything until you open the app again: no replies in Telegram, no reminders, no background tasks.

**Start at login** starts Piomio without a window. On a Mac it's a LaunchAgent (`~/Library/LaunchAgents/ai.piomio.app.plist`); on Windows it's a "Piomio" entry under your user's Run key in the registry. The app rewrites it at every start, so it survives moving the app or an update.

If the hub crashes five times within two minutes, the app stops restarting it and the window says **Piomio did not start**, with **Show log** and **Try again**.

## Where your data lives

| What | macOS | Windows |
|---|---|---|
| The hub's data: chats, agents, memory, the vault, plugins, agents' working folders | `~/Library/Application Support/Piomio` | `%LOCALAPPDATA%\Piomio` |
| The hub's log | `logs/hub.log` in that folder | `logs\hub.log` in that folder |
| This computer's connection to another hub | `~/.piomio-node` | `%USERPROFILE%\.piomio-node` |

On Windows the app itself is installed into the same folder as the data. Updates and reinstalls keep your data. An install from the time Piomio was called Owlbot keeps using its `Owlbot` folder.

## Ports

The hub listens on `http://localhost:41780`: the app's window shows it, and any browser on this computer opens it too (sign in with your password). The other ports are the security console on `41781` and the egress proxy on `41789`. They stay away from ports other tools tend to hold (8080, OpenClaw's 18789). All of them answer only on this computer.

One port does open to your home network: `41782`, the HTTPS port the iPhone app uses at home. See [The iPhone app](phone.md). To reach Piomio from outside your home, see [Access from anywhere](anywhere.md).

To use another port, create `desktop.json` in the data folder:

```json
{ "port": 19000 }
```

The console then uses the next port and the egress proxy the port + 9, unless you also give `consolePort` and `egressPort`. Choose **Restart** in the icon's menu to apply it.

When another program holds the port, the menu says **Port … is taken** and the window explains. Close that program, or move Piomio to another port as above.

## Security on the desktop

The desktop app runs the hub, its plugins and the CLI brains as your own user. The Docker image's separate users and its kernel-level network block aren't there. Approvals, the vault and the audit log work the same everywhere. For the strongest isolation, run Piomio [in Docker](docker.md). The details are in [Security model](security.md).

## Start from scratch

**Reset Piomio…** in the icon's menu (or in **Settings** → **This app**) first asks **Delete all Piomio data?** and lists what goes: the chats, agents, memory, the vault with your secrets, plugins, settings, this computer's connection to a hub and the start-at-login entry. It can't be undone.

- **Delete and start over** deletes it all and shows the first window again.
- **Delete and quit** deletes it all and quits.
- **Cancel** leaves everything as it is.

Your sign-ins to Claude Code, Codex and Kimi Code stay: they belong to those tools, not to Piomio.

## Uninstall

- **macOS.** Move Piomio from **Applications** to the Trash. Its start-at-login entry removes itself at your next login. Your data stays in `~/Library/Application Support/Piomio`; to delete it too, choose **Reset Piomio…** → **Delete and quit** first.
- **Windows.** Use **Settings** → **Apps**, find Piomio and uninstall it. The uninstaller asks whether to delete your data as well. The answer is No unless you choose Yes.

## Install with your own AI

Already use Claude Code, Codex or Kimi Code on this computer? Paste this into it:

```text
Install Piomio on this computer and set it up for me. Follow https://piomio.io/setup.md step by step. Ask me whenever a decision is mine, and never ask me for passwords or keys. At the end, tell me how to open the chat.
```

It works out what the computer is, downloads the right file from the release, installs Piomio and asks you only what is yours to decide: a new Piomio here, or a computer of the Piomio you already have. You still choose the password yourself, in Piomio's window. Piomio then works with that same Claude Code, Codex or Kimi Code, with no second sign-in. [What it will do](https://piomio.io/setup.md) is a public page you can read first.

## Silent installs

For many computers, scripts or MDM:

- **Windows:** `piomio-setup-<version>-x64.exe /S` installs without questions and starts Piomio in the background. Add `/NOSTART` to leave it stopped.
- **macOS:** `sudo installer -pkg piomio-<version>.pkg -target /`. It quits a running Piomio first, replaces the app, and opens it for whoever is signed in at the screen.
- **The first-run choice without a window:** run the app with `--mode hub --background` (or `--mode node`). The app's file is `/Applications/Piomio.app/Contents/MacOS/Piomio` on a Mac and `%LOCALAPPDATA%\Piomio\Piomio.exe` on Windows. The same file with `--quit` stops a running Piomio.
- **Removing a package install on a Mac:** `sudo /Applications/Piomio.app/Contents/Resources/uninstall.sh <uid> <home>` removes the app and its start-at-login entry. Add `--delete-data` to delete the data too.
