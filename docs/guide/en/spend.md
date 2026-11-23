---
title: What each conversation and task spends
nav: Spend
description: How much each dialog, group chat and task spent at API prices, with which models and effort, how big its context is now, and what usually drives it. In the chat and in Settings.
---

Piomio keeps a record of every turn an agent takes: which conversation or task it was in, the model and effort that answered, the tokens it used and what they would cost. You can ask in the chat or open **Settings → Spend**.

## Ask in the chat

Ask the default agent: "what ate my limit today?", "which task cost the most this week?", "how much did Ada spend on Fable this month?". It looks it up and answers with the conversations and tasks that spent the most, their models and effort, the split between cache reads and writes, and how big each one's context is now. It can look at today (from midnight in the hub's time zone), the last 7 days or the last 30 days, for the whole team or one agent.

## The Spend section

**Settings → Spend** (in the **Activity** group) shows the same, for **Today**, **7 days** or **30 days**:

- the total, the number of turns and a bar of the tokens by kind: **Cache read**, **Cache write**, **Fresh input** and **Output**;
- **Conversations and tasks**, the one that spent most first: its agent, each model it thought with and at what effort, the dollars and turns, the cache reads and writes, the output and **context now**. A task opens its page; a dialog or a group chat opens the chat;
- the hub's own quick model on its own line: **Auto mode's reviewer** and the **Quick model** that checks triggers and writes summaries;
- **By agent and by model**, folded until you open it.

**Ask in chat** sends the same question to the default agent.

## What the dollars mean

The dollars are an API-price equivalent: what the same tokens would cost on the model provider's API. A subscription bills differently, and Anthropic does not publish how its limits are counted, so read them as a way to compare threads and models, not as a bill.

- Claude Code prices its own turns. The first turn after its process starts again from an earlier conversation is priced by Piomio instead.
- For the other brains (Codex, Kimi Code, API keys) Piomio prices the tokens from public list prices. Such figures are estimates and carry a **≈**.
- A model with no known price shows its tokens and no dollars.

Turns are kept for 90 days.

## What usually drives it

- **Cache writes.** A long conversation that resumes after more than an hour without messages, or whose instructions changed, writes its whole context to the provider's cache again. The **Cache write** part of the bar shows it. See [Long conversations](chat.md#long-conversations) and the context caps in [Settings](settings.md#brains).
- **The model and effort.** Fable costs about twice as much as Opus per token, and a higher effort thinks longer. See [Models and depth](brains.md#models-and-depth).
- **Long contexts.** Every turn reads the whole context; **context now** shows how big it is.
