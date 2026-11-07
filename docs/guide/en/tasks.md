---
title: Tasks, schedules and the Inbox
nav: Tasks, schedules, Inbox
description: How a request becomes a task on the side, the task line and the Tasks page, /task and /goal, reminders, schedules and watched pages, what background runs tell you, the Inbox, the digest and quiet hours.
---

You talk to an agent; the work happens on the side. Anything with steps becomes a task that runs by itself and reports back, and the dialog stays free. Schedules and watched pages start tasks on their own, and what they find reaches you as a message, a notification or a line in the digest.

## How a request becomes a task

You just ask: "compare the three laptops I sent and pick one", "check why the site is slow". The agent you talk to answers quick things itself. Anything that needs steps or deep thought goes to a task at once, one task per request: two requests in one message become two tasks. The agent says in one line what it started, and a task line appears in its reply.

The agent also chooses:

- **who does it**: itself, or the teammate whose role or skills fit better;
- **where**: the computer whose files, apps or hardware the work needs (rendering, 3D and model training go to a computer with a strong graphics card); the task uses a suitable available brain on that computer;
- **how hard it is** (fast, balanced or deep) and what it is about (code, analysis, writing, research, an errand). From that the hub picks the brain, model and effort.

If the right agent or computer is unclear and it matters, the agent asks you one short question first. A task placed on a computer that is offline waits for it and starts when it comes online (for up to a day). Agents bound to certain computers never start tasks elsewhere (see [Agents and the team](agents.md)).

Creating a task puts it in the queue; it does not confirm that its brain has started. At each start, including a retry, the hub checks installation and sign-in on the selected computer and reads the agent's current settings. If the preferred brain is unavailable, cannot open a session or has reached its limit, the task can use another suitable brain. A brain explicitly required for the task stays mandatory, as does its computer. If no option works, the failure reports the actual reason instead of assuming that you have not signed in.

### Rules for where work goes

Say once, to any agent, how some kind of work should always go: "run renders on LEGOSTIN-PC", "code goes to Codex", "research is for the researcher". The agent saves it as a rule, and from then on every agent's dialog follows it when it starts tasks: that computer, that agent, that brain. What you say in a request itself wins over a rule. "What rules do we have?" lists them, and "drop the render rule" removes one.

### The task line

The task line sits inside the agent's message. It shows the agent's face (pulsing while it works), the title, the computer when it isn't the hub's own, and the status. While the task runs, the status is its current step: **Reading report.pdf**, **Running: npm test**, **On the web…**.

| Status | Meaning |
|---|---|
| **queued** | Waits for its agent's brain to be free, or for a brain or computer to come online (**waiting for LEGOSTIN-PC to come online, then it starts**) |
| **running** | Working |
| **awaiting approval** | An action needs your yes (see [Approvals and auto mode](approvals.md)) |
| **awaiting reply** | It asked a question and waits for the answer |
| **paused** | The brain hit its plan's limit and the task carries on at the reset (**resumes 14:30**), or you paused a goal |
| **done** | Finished |
| **failed** | It didn't work out |
| **cancelled** | Stopped by you or the agent |

Tap the line to open the task.

### When it is done

The result goes back to the agent who started the task, and it tells you the outcome in a few lines, in its own words. If you wrote about other things in the meantime, the report comes as a reply to your original request.

### When it hits a wall

A task doesn't stop at the first obstacle. When a step fails (a site doesn't open, a folder is closed, a tool refuses), it tries other ways to the same result, two or three really different ones, before it reports that something can't be done, and then it says what it tried and what would unblock it. It never works around your own "no" on an approval. When a task still comes back without what you asked, the agent who started it tries once more another way before telling you it failed.

The hub doesn't give up on a task either:

- **No brain connected** (the computer just woke up, a brain is restarting): the task waits and starts as soon as one is back, for up to 30 minutes (a day for a task placed on a computer).
- **The brain broke off mid-work**: the task goes on from where it stopped, up to three times.

Only after that does it fail.

A task you started yourself (with `/task` or **New task**) ends with a notification, **Done: …**, in that agent's dialog. A task that fails sends **Didn't work out: “…”**, saying why; only background checks started by a schedule fail quietly.

### Questions both ways

A task can ask whoever started it. The agent in your dialog answers from what it knows; otherwise it asks you in one short message and passes your answer on. Meanwhile the task line says **awaiting reply**, and the task's page shows the question under **Asks**.

You can add to a task while it runs. Tell the agent "for the laptops, only ones under 1.5 kg", and it sends that into the task, which takes it at its next step. A finished task picks up again with a new note. You can also write on the task's own page.

To stop a task, say "stop that", or press **Cancel** on the task's page. **Stop** in the dialog only stops the agent's current reply, not the tasks it started.

### Limits

- At most 4 tasks run at once on the hub, and each brain on each computer runs **Parallel sessions per brain** at a time (2 by default, in **Settings** → **General**). The rest wait in line; your own dialogs never do.
- A task can start sub-tasks, at most three levels deep.
- When the hub restarts, tasks that were running are queued again.

## The Tasks page

**Tasks** at the bottom of the sidebar shows how many tasks are active. The page lists everything agents work on, newest first:

- **Work**: your requests, delegated work and messages between agents;
- **Channels**: every run of a channel's editor (see [Channels](channels.md));
- **Schedules**: runs started by schedules and watched pages, and above them, under **Set up**, the schedules themselves. Tapping one opens the agent's chat to talk it over.

Filter with **All**, **Active**, **Waiting**, **Done** and **Failed**, or search by title and goal. Each row shows the agent, who started it (**you**, **agent** or **trigger**), **background** for background tasks, and the status.

**New task** opens a form, the second way to the same thing: **What needs doing**, an optional **Title**, the **Agent**, and **Background task** (runs without you, within the agent's initiative). Ctrl+Enter or Cmd+Enter creates it.

A task's page has **Cancel** while it runs and **Retry** once it is over. Its summary shows the **Goal** and the **Result**; **More** opens them in full, and a sub-task links to its parent. Below is the task's own conversation with a field to write in. Turn on **Show steps** in the **⋯** menu to see each tool call. Tasks stay in the list; there is no delete.

For work you want to plan ahead, with projects, a queue, priorities and cards agents take by themselves, there is the [Kanban board](kanban.md): a card there is the plan, and each of its runs is a task here.

## /task and /goal

`/task <what to do>` starts a task for the agent of this chat at once, without the model deciding anything: **Task started: …**, then **Done: …** at the end.

`/goal <what to reach>` sets a long goal. The agent works toward it round after round on its own: after each reply the goal is queued again, until the agent reports it reached or says it is blocked and asks you. The task line shows **round 3 of 20**.

- Each chat has one goal; a new `/goal` replaces the open one. `/goal` alone shows it.
- After 20 rounds the goal pauses and you get **Goal paused: …**. `/goal resume` gives it 20 more.
- `/goal pause` (or `stop`), `/goal resume` (or `continue`), `/goal clear` (or `cancel`).

## Reminders, schedules and watched pages

Say what you want and when:

- "remind me tomorrow at 9 to call the bank";
- "every weekday at 8:30 tell me the weather and my first meeting";
- "watch this page and tell me when the price drops below 500";
- "when this webhook fires, sort the order".

The agent sets it up and says in one line when it runs. `/schedule` does the same: `/schedule every Monday at 10 a summary of last week`, or `/schedule` alone to see what you have.

| Kind | In the app | What it does |
|---|---|---|
| Schedule | **Schedule** | Repeats in your time zone, written as a cron line such as `0 9 * * 1-5` |
| One-time | **One-time** | Fires once at the given time, like a reminder |
| Watch | **Watch** | Checks a page or JSON every N minutes (at least 5, an hour by default) and starts the agent only when the value changes |
| Webhook | **Webhook** | Gives you an address with a secret; an outside service posts an event and the agent handles it |
| Review | **Review** | A regular look through memory, tasks and upcoming plans; writes only if something matters |

You never write the cron line yourself: the agent turns your words into it. Times are in the hub's time zone. The assistant starts with one review, **Daily review**, at 10:00 and 18:00 on weekdays.

A schedule can name a computer. If that computer is offline when it is due, the run doesn't start and you get **“…” did not run**. A schedule can also follow a skill you taught (see [The browser and teach mode](browser.md)).

Limits: each schedule runs at most 24 times a day unless you raise it; a run is skipped while the previous one is still going; runs missed while the hub was off catch up once; addresses on your local network can't be watched unless you turn on **Allow watching local network addresses** in the Triggers plugin's settings.

To change or stop one, say so: "pause the weather schedule", "delete the price watch". The same is on the **Triggers** page (**Settings** → **Triggers**): **Create trigger**, and on each card the **On** switch, **Run now**, **Check** (for a watch), **Edit**, **History** and **Delete**.

## What a background run tells you

A run nobody watches ends in one of two ways.

**Reports.** A one-time reminder, and a schedule that runs at most three times a day, are reports: at its time the agent's final reply arrives as its message in its dialog and in Telegram, captioned **scheduled, 09:00**.

**Checks.** Watches, reviews, webhooks and more frequent schedules decide on their own whether you should hear about it:

| Level | What happens |
|---|---|
| silent | Nothing worth saying; kept just for the record |
| digest | Useful but not urgent; waits for the next digest |
| notify | Worth interrupting you now |
| ask | Needs your decision; comes as a question |

Agents are told to be conservative and interrupt only when it really matters. Under a check's notification there are three buttons: **useful**, **less often** (a watch checks half as often, a review drops one of its times) and **turn off** (the schedule stops).

Below the **Acts** initiative, a background run can only read and suggest (see [Agents and the team](agents.md)).

## The Inbox

**Inbox** at the bottom of the sidebar, with the number of unread items, collects what came in for you: reports, notifications, questions and digests.

- At the top: **Digest at 19:00 · 3 items** and **Collect now**, which has the assistant write the digest right away.
- **Waiting for you**: unread questions, and approvals waiting in the security console.
- Then everything by day. Click a row to read it; **Open in chat** jumps to the card, and **task →** to the task behind it.
- **Behind the scenes** holds what didn't reach you directly, each with why: went into a digest, silent, a duplicate, quiet hours, the rate limit, a muted schedule.

Opening the Inbox marks what you see as read, and reading the chat it came to counts too.

Notifications and questions also come as cards in the dialog of the agent that raised them, and to Telegram when it is connected (see [Telegram](telegram.md)). The app shows a short toast for each one. The desktop app that runs your hub shows them, and every message an agent writes to you in a chat, as the computer's own notifications while you're not looking at its window; a connected iPhone gets them as pushes ([The iPhone app](phone.md#notifications)).

## The digest

At each **Digest times** moment (09:00 and 19:00 by default) the hub gathers what waits for a digest, sections plugins add and the last day's channel headlines (up to 6 channels, 5 headlines each). The assistant writes a short digest from it: **Morning digest**, **Afternoon digest** or **Evening digest**, in its dialog and in Telegram, with its sources under it. If it isn't written within three minutes, the hub sends a plain card with the same sections.

No waiting items means no digest: channel headlines alone don't make one. "Send me the digest now" works too.

## Quiet hours and time zone

Say "turn on quiet hours from 22:00" or "my time zone is Asia/Almaty", and the assistant changes the setting. The same is in **Settings** → **General**:

- **Time zone**: for schedules, quiet hours and digests. At first it is the `TZ` environment variable or the computer's own zone.
- **Quiet hours**: on by default, 23:00 to 08:00. Urgent notifications go into the digest instead, questions still come, and Telegram messages arrive without a sound.
- **Digest times**: when digests go out.
- **Notifications per hour**: the limit on urgent notifications per schedule (4 by default). Over it, they go into the digest. The same notification within six hours is kept silent.
