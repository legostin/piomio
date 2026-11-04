---
title: The iPhone app
nav: The iPhone app
description: Piomio on your iPhone: the team, every chat with its cards, tasks, the Inbox and approvals with Face ID. Pairing with a QR code, how the phone reaches the hub at home and away, location, and disconnecting a phone.
---

The Piomio app for iPhone is your hub in your pocket: the team, every chat with all its cards, tasks, the Inbox and approvals that need Face ID. The phone runs no brains. It connects to your hub, wherever that runs: your Mac or PC, or a server.

> The app is in beta on TestFlight: open [the invitation](https://testflight.apple.com/join/g4hCfeXA) on the iPhone, install Apple's TestFlight app if it asks, and press **Install**. It needs an iPhone with iOS 26 or later.

## What's in the app

| Tab | What you find there |
|---|---|
| **Team** | your agents' chats, group chats and channels, the default agent at the top |
| **Tasks** | **Work** (what runs now and what ended recently), **Channels**, **Schedules** |
| **Inbox** | reports, digests, notes from your agents and approvals waiting for you |
| **Hub** | the connection, **Memory**, **Schedules**, **Catalog**, **Machines**, **Brains**, **Vault**, location and this phone |

A chat on the phone is the same chat as on the computer, cards included: sign-in cards, forms, maps, pages, approvals. You can dictate instead of typing and change how an agent thinks from its header. Settings, new agents, brains and plugins you change by asking the assistant in the chat, or on the computer.

The app keeps the lists and the chats you opened, so it opens with them at once and refreshes them from the hub. **Clear cache** in the **Hub** tab removes that copy and the chats' pictures; the phone stays connected ([What your device keeps](chat.md#what-your-device-keeps)).

## Connect the phone

1. **Get a QR code on the computer.** Say "connect my phone" in the chat, or open **Settings** → **Devices** → **Connect a phone**. The card shows a QR code that works once, within an hour, and, when other devices can reach the hub, a link to send to the phone. On a server installed with `install.sh`, `piomio devices pair` (as the user `piomio`) prints the QR right in the terminal.
2. **Open it on the phone.** In the app press **Scan QR code**, or point the iPhone's camera at the code. You can also open the link on the phone (its page has **Open in Piomio**) or copy it and press **Paste link**.
3. **Confirm.** The app shows **Connect to (your hub)?** with the hub's **Addresses** and whether each answers, and the encryption check: **Key matches**. Give the phone a name under **Phone name** and press **Connect with Face ID**.

The phone appears in **Settings** → **Devices** under **Connected phones**, with its model and when it was last seen. The pencil renames it.

If **Connect a phone** is greyed out, phones can't reach the hub right now: the phones' port is closed and access from anywhere is off. See below.

## How the phone reaches the hub

The QR code gives the phone every address the hub can be reached at, and the phone tries them all at once: it prefers the address that worked last time, then the earliest one in the list that answers. So it switches between home and away by itself.

- **At home: the phones' own port.** The hub opens one HTTPS port for phones on your network, its port + 2: `41782` in the desktop app, `8082` on a server. Only this port opens to the network; the web UI and the security console stay where they were. If the phone can't connect at home, allow incoming connections to that port in the computer's firewall (`ufw allow 8082/tcp` on a server).
- **Over Tailscale.** If the computer itself runs Tailscale, its Tailscale address is in the list too: a phone with Tailscale on reaches it from anywhere.
- **Away: the access-from-anywhere link.** With [access from anywhere](anywhere.md) on, the hub's permanent link is in the list as well, and phones use it away from home. A phone paired before the link existed learns it the next time it connects.

The order in the QR is: addresses from `PIOMIO_DEVICE_URLS`, then the computer's Wi-Fi and Ethernet addresses, its other local ones, the link, its Tailscale address and last any public one.

### Encryption without a domain

The phones' port speaks HTTPS with the hub's own certificate, made on first use and kept in the hub's data folder (`devices`). The QR code carries its fingerprint, and the app trusts that certificate and nothing else: no domain, no certificate authority. Through the access-from-anywhere link the phone sees the same certificate, so the same check holds.

### Settings for the phones' port

| Variable | Default | |
|---|---|---|
| `PIOMIO_DEVICE_PORT` | the hub's port + 2 | the phones' HTTPS port |
| `PIOMIO_DEVICE_HOST` | `0.0.0.0` | where it listens |
| `PIOMIO_DEVICES` | on | `0` closes the port; phones then reach the hub only through the link |
| `PIOMIO_DEVICE_URLS` | detected | addresses for the QR, comma-separated, ahead of the detected ones |

Behind a port forward or a proxy the hub can't see the address phones should use, so list it yourself: `PIOMIO_DEVICE_URLS=https://home.example.com:8082`. More variables in [Settings and environment variables](settings.md).

## Approvals with Face ID

When an agent wants to send, buy or change something outside, the approval card comes to the phone too: in the chat (**Allow**, **Deny**) and in the **Inbox** (**Approve**, **Deny**). Saying yes asks for Face ID.

- While pairing, the phone makes a key in its Secure Enclave and gives the hub only the public half. Approving signs a one-time challenge with that key, and the hub checks the signature.
- The phone's token sits in the iPhone's Keychain; the hub keeps only its hash. A stolen token alone can't approve anything.
- Rules, the vault's items and the audit log stay in the security console on the computer. The app can create or unlock the vault when a card needs it.

How approvals and auto mode work on every device: [Approvals and auto mode](approvals.md).

## Share your location

In the **Hub** tab, turn on **Share my location with agents**. Agents then know where you are, for places nearby and directions.

- iOS asks for location access first, then may ask once whether to allow it always, so moves reach the hub in the background.
- The phone reports when you move noticeably, not a constant stream, and names the place itself. The hub keeps only the last place.
- Turning it off makes the hub forget the place, and so does disconnecting the phone.

## Disconnect a phone

In **Settings** → **Devices**, press **Disconnect** on the phone's card. It loses access right away, and the app on it signs out. On the phone itself: **Hub** → **Disconnect this phone**. To use it again, connect it anew with a new QR code.
