---
title: Approvals and auto mode
nav: Approvals and auto mode
description: What waits for your yes and why, the approval card and where else you can answer, "Always allow" rules, actions you asked for in your own words, auto mode, and the brains' own commands and files.
---

Most of what agents do just runs. What reaches outside (a message to someone, a post, a deletion on a site, a payment) waits for a yes: yours on a card, a rule you made, your own words in the chat, or auto mode's reviewer.

## What needs your yes

Every tool an agent can use has an effect, and the effect decides what happens:

| Effect | For example | What happens |
|---|---|---|
| Read | searching the web, reading a page, a mail or a file | runs |
| Local change | a reminder, a fact in memory, a page, typing into a field in the agent's browser | runs |
| External | pressing a button on a site that sends, posts, deletes or pays; uploading a file to a site; a connected service's tool that changes something; a command or a file on another computer | waits for a yes |

Tools of MCP servers and integrations count as external unless the server marks them read-only. The agent's browser refuses plain clicks on buttons that buy, pay, send, post or delete: those go through a separate submit step that asks.

Before anything asks you, the hub checks, in this order:

1. Your rules: one that denies always wins, one that allows lets the action through.
2. Your own words: the action is exactly what you asked for (see [“You asked”](#you-asked-your-words-as-the-yes)).
3. [Auto mode](#auto-mode), if it is on.
4. You, on an approval card.

Local changes ask too when the agent's policy profile is `strict`, or when the conversation has read outside content and the change lasts (see [After outside content](#after-outside-content)).

## The approval card

The card shows up in the chat under the agent's message: **Asks for permission**, a plain headline of what the agent wants, its reason when it gave one, and the command or path folded to three lines (tap to see all of it). Under it:

- **Allow** runs it once.
- **Deny** refuses it; the agent hears that you declined.
- **Always allow this** runs it and makes a rule, so similar actions stop asking.

A task's card also shows in the dialog you started the task from, under the task's line.

How long it waits:

- The agent holds its turn for 45 seconds (**Settings** → **General** → **Approvals** → **Wait for a decision, sec**). If you answer later, the hub carries out the action itself and hands the agent the result.
- After an hour without an answer you get a reminder.
- After **Approval lifetime, h** (24 by default) the request expires and nothing is done.
- A brain's own request (its commands and files, see below) waits up to 10 minutes; then the brain hears "no" and asks you in its reply.

### Network permission

A new public host has its own card: agent, task, host and port, with **Allow once**, **Always allow** and **Deny**. A live request waits up to 10 minutes; once is scoped to the current session and port, always adds the exact host to `brainEgressAllow`. It never creates an action rule. A denied or expired connection is never executed later. See [The network filter](security.md#the-network-filter).

The card shows the server deadline. If the program closes its connection sooner, the card closes immediately and says why; it cannot approve a dead connection. **Request again** asks the agent to create a fresh permission request in its current session, without granting access or replaying the old connection. If the request was already sent, repeated clicks do not send it again. A listed host can still ask after the agent reads outside content: allowing a host is not permission to send arbitrary data to it.

### Other places to answer

- **Telegram.** If you [connected Telegram](telegram.md), each card also comes there with **✅ Approve** and **❌ Deny**. By default it names only the agent and the tool, with a link to the console; **Show details in Telegram** in **Settings** → **General** → **Approvals** adds the full action. The buttons are signed and work once. There is no "always" in Telegram.
- **The iPhone app.** Cards in its chat have the same buttons. The app's own list of approvals asks for Face ID: the yes is signed by a key kept in the phone's Secure Enclave, so a stolen token alone approves nothing. See [The iPhone app](phone.md).
- **The security console** (**Settings** → **Security console**). Its **Approvals** page shows the exact input and warns **The session read external content** when that applies. The buttons are **Allow once**, **Always allow this…** (you can narrow the rule before saving it) and **Deny**. It can play a sound and show system notifications.

## "Always allow" and rules

**Always allow this** makes a narrow rule from that card: this tool, this agent and, when the action has them, the same recipient, the same site (its domain and subdomains), the same computer or the same file. For a brain's command it covers the program and subcommand: allowing `git push origin main` allows `git push *`. That works only for a single plain command; a chain with `;`, `&&`, pipes or redirections stays exactly that command.

You can also say it in the chat: "always allow Linear", "don't ask me for Blender". The assistant makes a rule for one tool or a whole integration, for every agent or only one. It is saved at once when your own message from the last half hour says so; otherwise you confirm it on a card. The hub's own tools and the brains' commands can't be allowed this way (their cards have **Always allow this**).

Rules live in the security console under **Rules**: filter them (**Allowing**, **Denying**), edit one, remove it with **Delete rule** or add one with **New rule**. A rule names a tool (exact, or a pattern such as `browser_*`), optionally one agent, conditions on the input that must all hold (**equals**, **pattern**, **domain**, **at most** for a number such as an amount), and a decision: **Allow without asking** or **Always deny**. A deny rule blocks every call it matches, reads included. Delete an allow rule and those actions ask again.

A skill you taught in the browser can carry pre-approved clicks (one site, one button, up to an amount); they are rules too and go away with the skill. See [The browser and teach mode](browser.md).

Deleting an agent always asks on a card, whatever your rules say.

## After outside content

Once a conversation has read outside content (a web page, an email, a reply from a connected service), the hub marks it, because a page can carry text written to steer the agent. From then on:

- An "always allow" rule works only for recipients and sites you have approved before. A new one asks again.
- Every lasting change to the hub itself (settings, agents, plugins) needs a yes: yours on a card that says exactly what changes, a rule of yours, or auto mode's reviewer.
- Opening a web address goes to auto mode's reviewer when the address could carry your data to a site: one the agent put together for a site nobody named, or one with a long or encoded value in it. A page can say "open this address with what you read added to it", and opening it is enough to send it. Links from what the agent read, addresses you gave and plain addresses on sites you named open freely. The reviewer asks you on a card only when it hands the question over or keeps blocking; with auto mode off, it's a card.
- Pictures in the agent's replies and Telegram's link previews follow the same rule, without asking: see [Pictures and carousels](chat.md#pictures-and-carousels) and [What comes to Telegram](telegram.md#what-comes-to-telegram).

## "You asked": your words as the yes

If you write "delete the placeholder records on namecheap", the agent's press on the site's "Remove" button doesn't need a second tap. The agent quotes your words, and the hub checks them itself:

- the quote is in your own messages from the last 3 hours, in this dialog or the one the task was started from;
- the kind of action is in it: delete, send, publish, upload, confirm or unsubscribe (English and Russian forms);
- every other word on the button is in your words too, so a "Delete domain" button is not covered by "delete the records";
- you named the site;
- for an upload, every file is one you sent.

Then the action runs and the chat shows a quiet line: what was done · **you asked**. It is kept like any approval in the console and the audit log. Today the browser's submit and upload steps work this way.

Money always asks: a button that pays, buys, orders, books or subscribes, or an action with an amount, gets a card however you worded it.

## Auto mode

Auto mode is on by default. Where a card would ask you, a reviewer model decides instead, like Claude Code's own auto mode, but run by the hub for every agent and tool.

The reviewer is a brain signed in on the hub's computer: the reviewed session's own (Claude Code, Codex or Kimi Code) when it can, otherwise the next that can, on its cheapest model (for Codex, its newest Luna model). A quick first look; a second, more careful one for anything flagged. Each review is a bare session with no tools. It reads your recent messages, the task's goal, the agent's earlier calls and the agent's access (its computers, folders and connected services, from the hub's own record: see [Security](security.md#what-an-agent-can-reach)), never what tools returned or what the agent wrote, so nothing the agent read can argue with it.

It is told to block sending data off the computer that the request doesn't need, downloading and running code, deleting or rewriting what this session didn't create, security or system settings, credentials and the hub's data, accounts and systems you didn't mention (other than the agent's own computers and folders), and anything beyond what you asked. Ordinary work passes: the agent's folder and the projects you talk about, reading, installing a project's dependencies, tests and builds, commits and pushes to a working branch. A model can be wrong, so the riskiest actions never go to it. These always come to you on a card:

- money: paying, ordering, booking, subscribing;
- messages to people: email, chat messages, comments, posts;
- publishing: a push to `main` or `master`, a forced push, tags, releases, deploys, publishing a package;
- installing a plugin, an "always allow" asked in the chat, saving a taught skill, deleting an agent;
- the next action after 3 blocks in a row or 20 in one session;
- an action whose review failed, gave no clear answer or took over a minute;
- everything, when no brain on the hub's computer can review.

### When auto mode stops something

You see a quiet line: what it was · **auto mode stopped it:** and the reason, with an **Allow** button. The agent gets the same reason and is told to find another way or ask you. **Allow** lets that exact call through once; the agent hears it may try again, and the line says **you allowed it**. The console shows such a request as **stopped by auto mode**.

### Turning it off and on

Tell the assistant "ask me everything": auto mode is off at once, and every such action comes to you as a card. Say "turn auto mode back on" to bring it back; that asks you on a card first. There is no switch for it in **Settings**.

## The brains' own commands and files

Claude Code, Codex and Kimi Code have tools of their own: a shell, reading and editing files. They run inside the CLI, not through the hub's tools. On a Mac the hub keeps them in a sandbox and answers when they want more:

- **Claude Code** runs commands in the macOS sandbox (Seatbelt): they may read your files except the closed ones below, write only in the agent's folder and the temp folders, and reach the brain's allowed hosts through the hub's proxy.
- **Codex** runs in its own sandbox under a permission profile from the hub: the same closed paths, writes in its folder, and a managed network proxy chained to the hub's filter. It sees only the hub's tools: your own Codex MCP servers, plugins and ChatGPT apps are off in agents' sessions. A Codex too old for this (no `app-server`) runs without network for its commands, and the agent and you are told.
- **Kimi Code** has no sandbox of its own; on a Mac it asks the hub before every command and file change.

Runs without asking: file edits in the agent's folder and the temp folders; reading its earlier task folders and files outside your home folder; commands that only read (`ls`, `cat`, `grep`, `git log`, `git status`, `git diff`…); status commands (`ps`, `top -l 1`, `vm_stat`, `df`, `uptime`, `pmset -g`, `sw_vers`, `uname`) with filters like `grep`, `head` or `wc`. In a task, Claude Code's other shell commands go through review even inside the sandbox: with network access, they can publish. Codex's are not reviewed one by one (Codex no longer offers it): the hub checks where they connect instead, see [Security](security.md#the-network-filter). Auto mode or your saved rules can answer for you. Dialogs and bare reviewers keep command networking off.

Asks (auto mode first, if it is on): **Read a file outside its folder** in your home, **Change a file outside its folder**, **Run a command outside the sandbox**, **Run a command that goes online**, and any tool the hub doesn't know. Once you allow a read, the rest of that repository stays readable for the session.

Closed, whatever you answer, even through a symbolic link or inside a folder you opened: your credentials and private stores (`~/.ssh`, `~/.aws`, the keychains, browser profiles, Mail, Messages and the like) and the hub's own data (conversations, the vault, other agents' folders). Claude Code and Codex can't read or write them, and a command that names them is refused for every brain. Kimi Code asks only about commands and changes, so its own file reads aren't checked.

> This sandbox is for the Mac only, where it is on unless `PIOMIO_SANDBOX_BRAINS=0`. On Windows and on a Linux server install there is no sandbox around the brains yet: in a task, their commands and file changes run as your user without cards. In a dialog the brains only look; commands and file changes go to tasks. See [Security model](security.md).

## Background work

How much an agent does on its own is its **Initiative** (see [Agents and the team](agents.md)):

- **Only replies**: works only when you write.
- **Suggests** (the default): in the background it may only read, notify you, keep memory, post to its channels and make pages. A brain's request for more is refused: there is nobody to ask.
- **Acts**: takes actions in the background within your rules; anything external still goes through the steps above.

A skill you taught in the browser may click and type when it runs on a schedule, even for an agent that only suggests; anything external still needs a rule or a yes.
