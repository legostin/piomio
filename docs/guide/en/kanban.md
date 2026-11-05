---
title: Kanban board
nav: Kanban
description: Projects with columns of their own, a queue, priorities and cards with files; agents that take cards by themselves; review; working with Linear and other trackers.
---

The board is for work you want to keep in view: projects, what is next, what is in progress, what waits for your check. A card is the plan and a task is one run of it, so a card can go through several runs and keeps everything they found. Only what you or an agent put on the board is there: tasks agents start while they talk to you stay on the **Tasks** page (see [Tasks, schedules and the Inbox](tasks.md)).

## Start in the chat

Say "turn on kanban and make a project for my website". The agent turns the integration on, makes the project and shows the board as a card in the chat. From then on just talk: "add a card to Site: write the about page, urgent", "what's on the board?", "start SITE-12".

Kanban is off until you turn it on: the same switch is in **Settings** → **Plugins** → **Kanban**. Once it is on, **Kanban** in the sidebar opens the board. Everything on the page can also be done in the chat.

## Projects and columns

A project is a board of its own: a name, a short key that starts its cards' names (`SITE-12`), notes, and columns. Every run on the project's cards reads the notes, so that is the place for the folder to work in, the repository, and how to report.

Name columns as you like: "make the columns Ideas, Next, Doing, Check, Shipped". Each column also has a type, which tells the board what it means:

| Type | What it means |
|---|---|
| **Backlog** | Not ready. Nothing happens here by itself. |
| **Queue** | Ready. Agents with a rule take cards from here. |
| **In progress** | Being worked on. A run moves its card here. A limit on this column also limits how many cards agents take. |
| **Review** | Finished work waits for your check. Without such a column, finished cards go straight to done. |
| **Done** | Finished. |
| **Cancelled** | Not going to happen. |

A new project starts with Backlog, To do, In progress, Review and Done. Press the settings button beside the project's name to rename columns, change their types and limits, reorder or remove them; cards of a removed column go to another one of the same type. There you can also move the project to the archive, or delete it with its cards.

## Cards

A card has a title, a description in Markdown, a status (its column), a priority, an assignee, labels, a due date, what it waits for, files and comments. Below them are its runs with their results, and its history.

- **Assignee**: an agent, you (**Me**: no agent takes it), or **Anyone**.
- **Waits for**: other cards. A card is not taken while one of them is open. Once it is, the run hears what came of it.
- **Files**: up to 15 MB each from the page, up to 25 MB when an agent attaches them from its folder. A run can read them, and it can attach what it makes.

On the page, **Add a card** at the bottom of a column makes one, and you drag cards between columns. Press a card to open it. On a phone, change a card's **Status** instead of dragging.

## Running a card

Press **Start** on a card and choose the agent, or tell an agent "start SITE-12". The card moves to **In progress**, and the agent gets everything on the card as its task. You can follow it on the task's page, and its question shows on the card.

When the run ends:

- **With a Review column**, the card waits there. Press **Accept** to finish it, or **Return to work** and say what is missing: the same agent gets a new run with your comment and what it reported before. The card in the chat has the same buttons.
- **Without one**, the card goes straight to done.
- **If someone moved the card out of work** in the meantime, it stays where they put it. An agent does this itself when something can't be done: it moves the card to the backlog and says why.
- **If the run fails**, the card stays where it is, with the reason on it, and you get **Didn't work out: "…"**. **Start again** runs it once more.

To stop a run, cancel its task.

## Agents taking cards by themselves

Tell an agent in its chat what it takes: "take cards from the Site project, two at once", "take only urgent cards labelled bug". Then turn on the board's switch: "agents can take cards now". The same is under **Agents wait** at the top of the page. An agent is added there through its chat too. A rule can be paused or removed from that panel.

Whenever something changes, and once a minute, the board looks for a card for each agent with a rule. A card is taken when it:

- is in a **Queue** column;
- has no open run;
- is assigned to this agent or to anyone;
- has nothing open that it waits for;
- fits the rule (its projects, labels and lowest priority);
- doesn't overfill the project's **In progress** column.

The most urgent goes first, then the nearest due date, then the board's order. An empty queue costs nothing: no model runs until there is a card to take.

The hub's rules stay in force:

- **Initiative.** Only an agent at **Acts** takes cards, because below that a background run can only read (see [Agents and the team](agents.md)). The panel says so and offers to raise it in the chat.
- **Budget.** Taking a card uses the agent's daily budget of background runs. When it is spent, cards wait in the queue for the next day.
- **Waiting doesn't hold a place.** A run waiting for your answer or approval doesn't count towards the agent's "at once".
- **Failures.** After a failed run the agent rests for 15 minutes, twice as long after each failure in a row, at most 6 hours, so a broken agent doesn't fail your whole queue. Nothing is retried by itself. Changing its rule ends the rest.

When a card an agent took by itself is finished, you get **Ready for review: …**. A card that goes straight to done waits for the digest instead.

## Text from outside

A card can hold text the agent got from somewhere else: an issue in a tracker, a page, a mail. If an agent took such a card by itself, a stranger's words could become a command. So anything written by an agent after it read outside content marks the card, and no agent takes it until you allow it:

- press **Allow** on the card;
- or move it to a queue yourself;
- or tell the agent, and it asks you on a card if it has read outside content.

New text from such an agent takes your OK back. A run of a marked card treats its text as data rather than instructions, and is careful with its tools like any session that read outside content (see [Approvals and auto mode](approvals.md)).

## Linear and other trackers

Your agents connect the board to other trackers, using the tools of both. Connect the tracker first (see [Plugins and integrations](plugins.md)), then ask:

- "bring the open issues of team ENG from Linear onto the Site board";
- "do that every hour" (an ordinary schedule; the agent running it needs **Acts**);
- "when a card from Linear is finished, comment the result on the issue" (the agent writes that into the project's notes, so every run follows it, and writes to the tracker still ask you as usual).

A card remembers where it came from, so bringing the same issues again updates those cards in place instead of making new ones, and leaves them in their columns. Imported cards hold outside text: pick the ones to run by moving them to the queue. Any other tracker with tools works the same way.
