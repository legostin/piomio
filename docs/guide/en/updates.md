---
title: Updates
description: How Piomio updates on each kind of install (the desktop app, a server, your other computers, from source) and how releases work.
---

Piomio never updates behind your back. When a new release is out, you see an **Update** button and the assistant offers it in the chat; you choose when. After the update, the assistant tells you what changed. How the update itself happens depends on how you installed Piomio.

| Install | How it updates |
|---|---|
| The desktop app | **Update** in the sidebar, the assistant's offer, or the icon's menu |
| A server installed with `install.sh` | **Update** in the sidebar, the assistant's offer, or `install.sh` again |
| A computer joined with `install.sh` or `piomio-node` | **Update** on its row, from your hub |
| A Mac or PC joined through the desktop app | The app's own menu |
| From source | `git pull`, `npm install`, `npm run build` |

## How releases work

- **Every change that ships becomes a release by itself.** When a change to the app lands, the patch version goes up (0.2.12, then 0.2.13…) and a release is published, so new versions come often. Changes to the website or these docs release nothing. A new minor or major version (0.3.0, 1.0.0) is made by hand.
- **Releases live on GitHub**, at [github.com/legostin/piomio/releases](https://github.com/legostin/piomio/releases): the desktop installers, the files the desktop app updates from, the Linux archives with their checksums and signatures, and `install.sh`.
- **Updates are signed.** The files the desktop app and a server install update from are signed with Piomio's update key. The public half is built into the app and the hub, so they install only what that key signed.
- **Your version** shows on the sign-in screen ("version 0.2.13"). On a server, `piomio version` prints it. Hover over **Update** to see the version it updates to.

## The desktop app

The app looks for a new release a minute after it starts and then every hour; the hub also looks when you open Piomio or come back to it (at most every ten minutes), so **Update** shows soon after a release. It downloads a new one in the background, but installs nothing until you say so. There are three ways to say so:

- **In the sidebar.** Above the row of icons at the bottom, **Update Piomio to …** appears. Press it. (Other computers' updates are on their rows under **Machines**.)
- **In the chat.** When a new version is out, the assistant tells you and offers buttons to update now or not now. It brings up each version once, and no more than once a day. You can also just write "update Piomio".
- **In the icon's menu.** The update item says **Install update …** once a release is downloaded. **Check for updates** looks right away.

Then the app stops the hub cleanly (tasks that were running wait in the queue for the new version), installs the update, and starts again. It's back in a minute or two, with all your data. On Windows the installer shows a small progress window and asks nothing.

If the update can't be done, the app stays on the version it had and the hub keeps running (or starts again). **Update** comes back so you can try later, and the menu item says **Update failed: check again**. When the download fails after you pressed **Update** or agreed in the chat, the assistant tells you why.

## A server installed with install.sh

A hub installed with `install.sh` checks GitHub's latest release every hour, and when you open its page or come back to it (at most every ten minutes). When there's a newer one, the server's row under **Machines** in the sidebar shows **Update**, and the assistant offers it in the chat (each version once, at most once a day). You can also say "update the server".

What happens when you agree:

1. The hub downloads the release's archive for its processor (x64 or arm64) and its signature, and checks the signature against Piomio's update key.
2. It unpacks the new version next to the running one and makes sure it starts and reports the right version.
3. It keeps a copy of the database as it is, switches to the new version and restarts. It's back in about a minute.

If anything fails before the switch, nothing changes: the hub stays on its version and the assistant says why.

If the new version doesn't come up after the switch (it crashes, or doesn't answer within three minutes) three starts in a row, the launcher goes back to the previous version by itself and puts the database copy back, so everything is as it was before the update. The assistant tells you, with the command for the log: `journalctl --user -u piomio`. That version isn't offered again; the next release is.

Once the new version is up, the copy of the database goes. The previous version stays on disk next to the new one, and older ones are deleted.

You can also update by running the installer again, as root:

```bash
curl -fsSL https://piomio.io/install.sh | sh
```

It downloads the latest release, checks its checksum, switches to it and restarts. It doesn't do the automatic rollback, so the **Update** button is the safer way. `PIOMIO_VERSION=x.y.z` in front of `sh` installs a given release instead.

Want your own copy before an update? `piomio backup` (after `sudo -iu piomio`) copies the database, the vault, agents and plugins into `~/.local/share/piomio/backups`. More about server installs: [On a Linux server](server.md).

## Your other computers

A computer joined with `install.sh` and an invite link, or one where you run `piomio-node.mjs` yourself, gets new versions from your hub, not from GitHub. When it runs an older version than the hub, its row under **Machines** shows **Update**. Or ask in the chat, for example "update the computer vps".

The hub sends its own build of the daemon. The computer checks it, keeps the old file next to it, and restarts in a few seconds. It has to be online. So when you update, update the hub first, then your computers.

A `piomio-node.mjs` from before this feature doesn't report its version, so the hub can't offer it an update. Download it again once from your hub.

A Mac or PC joined through the desktop app (**Connect to my Piomio**) doesn't get **Update** on its row: the app updates it, from its own icon menu, as above. More in [Machines and other computers](machines.md).

## From source

A hub run from a clone of the repository doesn't update itself; the assistant tells you so if you ask. Update it yourself:

```bash
git pull
npm install
npm run build
```

Then stop the hub and start it again (`npm start`).

## What changed

After an update, whichever way you installed Piomio, the first time the new version starts, the assistant writes in its chat which version you're on now and what changed for you. It writes in the hub's language, from the release's notes on GitHub, and leaves out what only developers care about. It does this once per version.

## Updating from somewhere else

`PIOMIO_UPDATE_URL` points updates at another source, for checking a build of your own before release. For a server install it's an address that answers like GitHub's `releases/latest`; for the desktop app it's a `latest.json`. The files still have to be signed with Piomio's key. See [Settings and environment variables](settings.md).
