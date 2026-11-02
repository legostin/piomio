---
title: Access from anywhere
nav: Access from anywhere
description: One permanent HTTPS link to your hub through Piomio's own Tailscale node: turning it on, what goes through the link and what never does, wrong-password limits, the node's keys, and your own Tailscale or proxy instead.
---

On its own, the hub opens only where it runs: the desktop app on `localhost`, a server on `127.0.0.1`. Access from anywhere gives it one permanent link, `https://piomio.<your-tailnet>.ts.net`. The link opens in any browser, serves the iPhone app away from home and lets your other computers connect, with nothing to install on them and no ports to open. Piomio runs its own [Tailscale](https://tailscale.com) node for it and opens the link with Tailscale Funnel.

## Turn it on

Say "turn on access from anywhere" in the chat: the assistant shows its card. The same card is in **Settings** → **Plugins**, under **Communication**: **Access from anywhere**. The **Devices** page and the card for connecting a device have a **Set it up** button that leads there too.

1. Press **Turn on**. The card says **Starting the Tailscale node…**
2. **Sign in to Tailscale.** A free account (Google, Apple, GitHub or Microsoft) is enough; a new account gets a new tailnet. The `piomio` node joins it.
3. **Allow Funnel.** Tailscale asks the tailnet's admin once, so the link opens from the internet.
4. The card shows the link, a copy button and **QR code** for opening it on a phone, and the Tailscale account it runs under.

Turning it on needs a Piomio password, which every hub has after its first-run setup. If your tailnet makes new devices wait for approval, the card says Tailscale is waiting for the admin to approve the `piomio` machine (admin console → Machines).

## What goes through the link

- **The web UI.** Sign in with your Piomio password. Passkeys belong to the computer's own address, so through the link it is always the password.
- **The iPhone app**, away from home. Phones reach the hub at the same name on port `8443`, where they see the hub's own certificate they pinned when pairing. A phone paired before the link existed learns it the next time it connects. See [The iPhone app](phone.md).
- **Your other computers.** While the hub's own address works only on its computer, invite links for new computers point at the link, and `piomio-node` stays connected through it. Brains on those computers reach the hub's tools through the link with their own session tokens. See [Machines and other computers](machines.md).

Never through the link:

- the first-run setup (the setup code and the first password) and the desktop app's own sign-in;
- the security console with approvals, the vault, rules and the audit: it stays on the computer;
- plugin webhooks, and the pages a sign-in returns to (Google's, an MCP service's): when one doesn't come back, the card asks you to paste the address from the browser's address bar instead.

## Wrong passwords

Each address gets 10 wrong passwords in 15 minutes, then it has to wait. Through the link, wrong passwords also count together, from every address: 30 within an hour pause signing in from outside for an hour, and you get a notification, **Someone is guessing your password**. Signing in on the computer itself keeps working. If it wasn't you, change the password in the security console on that computer.

## The node and its keys

- **Its keys** live in `<data>/tailnet`, in the hub's data folder.
- **Turn off** stops the node and the link; the keys stay, so turning it on again brings the same link back. Phones and browsers away from home lose access meanwhile.
- **Forget the node** signs it out of Tailscale and deletes its keys. The link stops working, and turning it on again makes a new node.
- If you turn it off from a page you opened through the link, the card warns you that this page stops working too.
- **Key expiry.** By default Tailscale asks a node to sign in again after 180 days. Two weeks before that, the card warns you with the date and **Open the Tailscale admin console**, where you can turn key expiry off for `piomio`.
- **No logs to Tailscale.** Piomio doesn't send Tailscale the node's logs.
- The node starts with the hub whenever the switch is on. If it stops on its own, the hub starts it again, waiting a little longer each time, and the card shows what went wrong meanwhile.

The node is called `piomio` in your tailnet, which makes the link's first label; `PIOMIO_TAILNET_HOSTNAME` names it otherwise.

## Where the node comes from

The desktop app, the server install and the Docker image include the node. When you run Piomio from source, build it with Go:

```bash
npm run build:tailnet
```

Without it, the card says access from anywhere isn't in this build. `PIOMIO_TAILNET_BIN` points the hub at a node binary somewhere else.

## Your own Tailscale or proxy instead

You can also put HTTPS in front of the hub yourself. Don't open ports `8080` and `8081` to the internet over plain HTTP: the password would travel unencrypted, and `8081` is the security console.

With Tailscale installed on the hub's computer and HTTPS certificates enabled for your tailnet, `tailscale serve` puts HTTPS in front of both ports, inside your tailnet only:

```bash
tailscale serve --bg --https=8080 http://127.0.0.1:8080
tailscale serve --bg --https=8081 http://127.0.0.1:8081
```

Then tell the hub its addresses, in `.env` next to `docker-compose.yml` or in `~/.config/piomio/env` on a server, and restart it:

```ini
PIOMIO_PUBLIC_URL=https://my-box.tailnet.ts.net:8080
PIOMIO_CONSOLE_URL=https://my-box.tailnet.ts.net:8081
```

This way the security console is reachable from your other devices too, and passkeys work, since they need HTTPS or `localhost`. Behind another reverse proxy that sets `X-Forwarded-*` headers, add `PIOMIO_TRUST_PROXY=1`. The hub answers only to the host names it knows (`localhost`, the hosts of `PIOMIO_PUBLIC_URL` and `PIOMIO_CONSOLE_URL`); more go in `PIOMIO_ALLOWED_HOSTS`. All variables are in [Settings and environment variables](settings.md).
