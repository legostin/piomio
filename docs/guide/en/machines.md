---
title: Machines and other computers
nav: Machines and other computers
description: Connect your laptop, work computer or a server to the hub: one-time invite links, what agents may do there, who works where right now, agents bound to computers, the hub on several computers, and removing one.
---

A machine is another computer of yours connected to the hub: a laptop, a work computer, a home server. Agents can then think with its Claude Code, Codex and Kimi Code (signed in there, on your plans), work with files in the folders you allow and, if you turn it on, run commands. The computer connects out to the hub, so it needs no open ports.

## Connect a computer

Say "connect a computer" (or "connect my laptop") in the chat. The assistant shows a card, **Connect a computer or a phone**: press **Get a link**. You get a one-time link like `https://piomio.<your-tailnet>.ts.net/join/AB12CD34`. It works once, within an hour; the card counts down and has **New link** and **Cancel link**. Open the link on the computer you want to connect, or send it there.

**Settings** → **Machines** → **Connect a machine** makes the same link.

> A hub in the desktop app opens only on its own computer until you turn on [access from anywhere](anywhere.md). Until then the card says other devices can't reach it and offers to set that up; the link appears once the hub has an address others can reach.

The link's page shows what to do on the device it was opened on: a computer, an iPhone or a server without a screen; the rest are under **Another kind of device**. For a server you needn't open it at all: the card's **Linux server** button shows the command with the link in it.

### A Mac or Windows PC

1. With the Piomio app installed, press **Open Piomio** on the link's page. The app asks once whether to connect this computer.
2. No app yet? The page has the download for macOS and Windows. Install it, come back and press **Open Piomio** again.
3. You can also start from the app: on its first start it asks **How will you use this computer?** Choose **Connect to my Piomio**, paste the **Invite link**, give a **Machine name** and press **Connect**.

That computer then runs no hub of its own: its window shows your hub. When the web UI is open on another computer than the hub's, the card also offers **Connect this computer**.

### A Linux server

The card's **Linux server** button, and the link's page under **Server without a screen**, show one command with your link already in it. Copy it and run it on the server as root (Linux with systemd, x64 or arm64):

```bash
curl -fsSL https://piomio.io/install.sh | PIOMIO_NAME=vps sh -s -- https://piomio.<your-tailnet>.ts.net/join/<code>
```

It makes the user `piomio`, puts Node.js (from nodejs.org) and the hub's own `piomio-node` in `~/.local/lib/piomio-node` and keeps them running as the systemd user service `piomio-node`. `PIOMIO_NAME` is what the computer is called in **Machines**; without it, the server's host name. Then sign its brains in as `piomio` ([Brains and sign-in](brains.md#on-a-server)).

After `sudo -iu piomio`:

| Command | |
|---|---|
| `piomio-node status` | whether it's paired, its policy, its CLIs and whether the hub answers |
| `journalctl --user -u piomio-node -f` | the log |
| `piomio-node uninstall` | removes the service; the key and the policy stay |

### Anything else, by hand

Any computer with Node.js 24.5 or newer can run the daemon from one file the hub serves:

```bash
curl -fsSLo piomio-node.mjs https://<your hub>/download/piomio-node.mjs
node piomio-node.mjs pair https://<your hub>/join/<code> --name laptop
node piomio-node.mjs run
```

`run` stays connected and reconnects by itself after a hub restart or a network drop. To start it with the computer (launchd, Task Scheduler, systemd), see the [piomio-node guide](https://github.com/legostin/piomio/blob/main/packages/node/README.md).

The daemon keeps its files in `~/.piomio-node` (`PIOMIO_NODE_HOME` moves it): `config.json` (the hub and the machine's name), `key.json` (its private key, readable by you only) and `policy.json`. Pairing creates an Ed25519 key and sends the hub only its public half; on every connection the daemon proves it holds the key.

## What you see on the hub

Each computer gets a card in **Settings** → **Machines**: **online** or **offline**, its system, host name and when it was last seen, a badge for each CLI with its version (or "not installed", "sign-in needed") and **Folders: …** it allows. The pencil renames it; **Set up** and **Disconnect** are below.

Its brains join the **Brains** page under the computer's name, like **Codex (ChatGPT) @ laptop**. They think with the sign-in on that computer: sign them in there, the usual way for each CLI. One signed in later is found within a minute.

Agents work there with a few tools: list and read files, write files, run commands. Writing a file and running a command count as actions that reach outside, so they go through [approvals](approvals.md).

Agents also know each computer's graphics cards (an app or daemon from 0.2.18 on reports them), so "render this on a computer with a GPU" finds the right one. To send some kind of work to one computer every time, tell any agent once, for example "run renders on LEGOSTIN-PC": it becomes a rule the whole team follows, and such tasks think with the agent's brain on that computer, waiting for it while it is off (see [Rules for where work goes](tasks.md#rules-for-where-work-goes)).

## What agents may do there

The owner of the computer decides, not the hub: in `~/.piomio-node/policy.json` on that computer. The daemon checks every request against it itself. The file is made with safe defaults on first start:

```json
{
  "allowedDirs": ["/home/me/piomio-workspace"],
  "exec": { "enabled": false, "allowCommands": [] },
  "fs": { "read": true, "write": true },
  "brains": {
    "claude-code": { "enabled": true, "allowedTools": ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite", "Task", "Skill", "mcp__piomio"] },
    "codex": { "enabled": true, "sandbox": "workspace-write" },
    "kimi": { "enabled": true }
  },
  "workspacesRoot": "/home/me/piomio-workspace",
  "hubChanges": true
}
```

| Field | What it decides |
|---|---|
| `allowedDirs` | the only folders the hub may touch; every path must stay inside one of them |
| `fs.read`, `fs.write` | reading and listing, writing (text files up to 5 MB read, 10 MB written) |
| `exec.enabled` | running commands: **off by default** |
| `exec.allowCommands` | patterns of allowed commands, like `"git status"` or `"npm test*"`; empty allows any |
| `exec.shell`, `exec.maxTimeoutMs` | the shell, and a time limit per command (30 minutes by default) |
| `brains.claude-code` | whether Claude Code may be used, and its tools allowed without asking (`Bash` isn't among them) |
| `brains.codex` | whether Codex may be used, and its sandbox: `read-only`, `workspace-write` or `danger-full-access` |
| `brains.kimi` | whether Kimi Code may be used; it has no sandbox, so its commands follow `exec` and its writes `fs.write` |
| `workspacesRoot` | where agents' working folders are made |
| `hubChanges` | whether you may turn commands on and off from the chat (`true` by default); `false` keeps every permission in this file |

A change takes effect within a couple of seconds, with no restart. A mistake in the file is reported in the daemon's log, and the previous version stays in force. `piomio-node policy` prints the file and its path.

Keep in mind:

- **Commands mean a shell with your user's rights.** The folder limit applies to where a command starts, not to what it does. Turn `exec` on deliberately, ideally with an `allowCommands` list.
- **`~/.piomio-node` is off limits** to the hub's file and command tools, even inside an allowed folder: the hub can't read the key or rewrite the policy. The one thing it may change is `exec.enabled`, and only after your yes on a card (below), unless `hubChanges` is `false`.
- The hub never sees the whole policy, only the allowed folders and which brains there are. The hub's environment variables don't reach the brains there, apart from the time zone and language.

## Commands on a computer

Commands are off on a new computer, so its programs (Blender, a build) don't start from the hub. To allow them, say so in the chat: "allow commands on LEGOSTIN-PC". The assistant shows a card, **Allow commands on the computer LEGOSTIN-PC**, and after your **Allow** the computer turns `exec.enabled` on in its own policy. From then on Claude Code there asks the hub about each command it isn't allowed by itself, and auto mode checks it the way it does on the hub's computer (see [Approvals and auto mode](approvals.md)). "Forbid commands on LEGOSTIN-PC" turns them off the same way. The computer needs Piomio 0.2.20 or newer for this; with `"hubChanges": false` in its policy it refuses.

A command there that only looks at the computer or the repository (`pwd`, `ls`, `git status`, `git log`, `git rev-parse`, `df`, `uname`), with flags and revisions but no paths, runs without a review. That computer has no sandbox around the commands, so reading a file's contents there, and every command that changes something, is checked by auto mode, which knows the agent's access. Neither happens on a Windows computer, on a computer the agent is not bound to, or after the session read outside content: there every command is checked. The hub's own computer is first in the agents' list of computers: an agent there runs its commands in its own shell, not through `machine_exec`.

## Who works where right now

Under the team in the sidebar, the **Machines** line shows a dot for every computer, the hub's own included (online or offline), and how many agents are at work; a click opens it into the full list. While agents work on one, a line per agent shows what it's on and what it's doing right now: thinking, writing, in the terminal, reading files, editing files, on the web, using a tool, "needs you" while it waits for your approval, or "waiting for connection" while its brain is not connected for now. A line opens that chat or task. The iPhone app's **Hub** tab has the same **Machines** section. A server that runs the hub and `piomio-node` side by side (a replica, say) is one computer there, named as you named its `piomio-node` (`PIOMIO_NAME`, `vps`), not by the server's host name.

## Agents bound to computers

By default an agent works on any computer. To keep one to a computer, pick it under **Where it thinks** in the agent's settings, then a brain on it, or say "let Ada work only on my laptop, with Codex"; the assistant asks with buttons which computer and which brain. A bound agent thinks only with those computers' brains and never moves elsewhere: while none of them is online, its chat waits for one with a passing line and answers once it is back (after half an hour it says so, and you send the message again). "Let Ada work anywhere again" undoes it.

When the assistant hands work to a teammate, it also picks the computer, and asks you only when the choice isn't clear. A task placed on a computer runs on that computer's brain.

## Models, keys and a spend limit per computer

**Set up** on a computer's card opens the chat with a request in your words: what that computer may use. You can also just ask.

- By default each CLI there uses its own sign-in, with any model. You can narrow which models its Claude Code and Codex may use.
- On a hub started with `PIOMIO_API_KEYS=1`, a computer's Claude Code and Codex can think through API keys from the hub's vault instead: Claude Code with Anthropic, DeepSeek, Kimi (Moonshot) or GLM (Z.ai) keys, Codex with an OpenAI key. You list the allowed models, each with its price per million tokens, and can set a spend limit in dollars per day or per month. A small gateway on that computer adds the key, keeps to the list (a model off it becomes the cheapest allowed one) and stops at the limit: those brains rest until the period ends. The key reaches the computer only in the daemon's memory, never its disk or the CLI's environment.

Each change waits for your approval. The card then shows the setup in a line, with what was spent so far.

## The hub on several computers

A hub can live on more than one of your computers, so it keeps working while one sleeps. Each **replica** holds the whole hub; one leads at a time.

1. Say "make my server a replica of the hub". The assistant asks for your approval, then gives a one-time `piomio://replica?…` link.
2. On the other computer, where Piomio is installed, run as the user the hub runs as:

   ```bash
   piomio replica join '<link>' --name vps --url https://<its address>:8082
   ```

   `--url` is where the other replicas reach it: its port for phones (the hub's port + 2). If the data folder there already holds a hub, `--force` replaces it, data and all.
3. Start the hub there. It catches up and waits as a standby.

How it behaves:

- **Who leads.** The **primary** replica leads while it's online: at first the computer the hub started on. If the leader goes quiet for about eight seconds, the next replica takes over, and gives the lead back once the primary is back and caught up (after five minutes awake, if it had been asleep). **Settings** → **Machines** shows it in one line, **The hub lives on**: each replica with **leads**, **standby**, **away** or **vault locked**, and a star on the primary.
- **The primary.** Say "keep the hub on the vps" (or tap the outlined star next to a replica in that line) and that replica becomes the primary: the lead moves there within a minute or two, once the running replies are done, and stays while it's up. A laptop that sleeps, wakes and drops off no longer takes the lead from a server that stays up; it leads only while the primary is away. In the addresses the hub gives phones, the leader's comes first, then the primary's.
- **What the leader does.** Tasks, channels, digests and plugins run on the leader only. The web UI, the desktop app and the security console work on any replica: a standby checks that it's you, then passes what you do and what you open on to the leader, so a change takes effect at once and replies come in live. In a standby's console, a tap on an approval reaches the agent waiting for it, and the vault, rules and audit log you see are the leader's; signing in, your password and passkeys stay with that computer's console. Phones and machines that reach a standby are passed on to the leader too. When the lead moves, the phones and windows connected to the replica that led reconnect by themselves and get replies live from the new leader: there's no need to reopen a chat. While a standby can't reach the leader, its web UI and console show its own copy, a few seconds behind, and changes wait ("The hub is moving to …: try again in a moment").
- **Every replica's computer thinks.** While another replica leads, a replica's computer is a computer of the hub like any other: its hub connects it to the leader as a machine of its own, with no invite, so agents bound to it keep working there with its Claude Code, Codex or Kimi, and **Where it thinks** shows it under the same name whoever leads. While that replica leads, they think there as on the hub's own computer. A server that already runs `piomio-node` next to its hub uses that one instead. What agents may do through this machine is set as on any computer ([What agents may do there](#what-agents-may-do-there)), in `node/policy.json` in the hub's data folder; its working folders are beside it, in `node-workspaces`. **Disconnect** on its card turns it off: the replica's computer then thinks only while that replica leads.
- **What is shared.** Chats, tasks, approvals and rules, settings, agents, skills, channels, pages, working folders, phones and machines, your password and passkeys, memory facts and the vault, still encrypted. Each replica keeps its own audit log, and brains sign in on each computer separately.
- **The vault.** When a replica's vault is locked (after a restart, say), the leader asks you, with an approval card, to hand it the vault's key, which the replica keeps in memory only. Allowing it always for that replica skips the card next time.

"How is the cluster?" shows the replicas and which is the primary; "remove the replica vps" takes one out for good (with your approval). `PIOMIO_REPLICA_NAME` names a replica, `PIOMIO_NODE_URLS` says where machines reach it ([Settings and environment variables](settings.md)).

## Updates

A computer running `piomio-node` older than the hub shows **Update** on its row in the **Machines** block and in the phone's **Hub** tab. Pressed, it gets the hub's own version over its connection and restarts in a few seconds. A computer connected through the Piomio app shows **Update** too, from Piomio 0.2.20 on: pressed (or "update LEGOSTIN-PC" in the chat), the app there downloads its update and restarts with it in a few minutes. An older app updates from its own tray menu (**Install update**) once; an app older than 0.2.7 can't update itself, so install the current one on that computer from [piomio.io](https://piomio.io). Agents know which Piomio each computer runs and say when one is older than the hub. More in [Updates](updates.md).

## Remove a computer

In **Settings** → **Machines**, press **Disconnect** on its card and confirm. Its key is revoked and the daemon can't connect again; to bring the computer back, connect it anew. Connected anew, it takes its old record's place (the hub knows it by its host name), whether you connect it before or after removing the old one: agents that thought with its brains or were bound to it, tasks waiting for it and the team's rules for where work goes move to it. In the chat, "disconnect my old laptop" does the same, after your approval.

On the computer itself: a server's `piomio-node uninstall` removes the service (the key and the policy stay in `~/.piomio-node`). In the desktop app, **Reset Piomio…** in the icon's menu also removes this computer's connection to a hub.
