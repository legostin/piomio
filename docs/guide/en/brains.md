---
title: Brains and sign-in
nav: Brains and sign-in
description: What agents think with: the official Claude Code, Codex and Kimi Code CLIs on your own plan, signing them in from the chat, the order agents try them, models and depth, and API keys.
---

A brain is what an agent thinks with. Piomio has no model of its own: it runs the official command-line tools of the model makers, signed in with your own account and the plan you already have. Each agent has a list of brains it may use, in order, and moves to the next one when the first can't answer.

## The three brains

| Brain | The official CLI | You sign in with |
|---|---|---|
| Claude Code | `claude` (`@anthropic-ai/claude-code`) | your Claude account |
| Codex | `codex` (`@openai/codex`) | your ChatGPT account |
| Kimi Code | `kimi` (`@moonshot-ai/kimi-code`) | your Kimi account |

Each one signs in on its maker's own page. Piomio starts the CLI's own sign-in and, for Claude Code, hands it the code you paste: that's all. The CLI keeps its login where it always does, in the home folder of the user Piomio runs as. Piomio never reads, copies or stores those tokens.

> Anthropic's terms don't let apps store Claude tokens, so Piomio doesn't take a token from `claude setup-token` either. If you paste one into a message, the hub cuts it out before anyone sees it and keeps it nowhere; the assistant shows the sign-in card instead.

On a Mac with the ChatGPT or Codex app installed, Piomio runs the newest Codex it finds: the one on your `PATH` or the copy inside the app. Newer models come to newer versions of Codex first.

## Sign in from the chat

On a new hub, before any brain works, the chat shows a card: **To answer you, I need a brain**. It has a row for Claude Code, Codex and Kimi Code, each with **Sign in**. Whatever you write meanwhile waits and gets answered as soon as one brain works.

Later, just ask: "connect Codex", "sign Claude Code in again", "connect Kimi". The assistant puts a sign-in card into the chat. There is nothing to type in a terminal.

### Codex and Kimi Code: a one-time code

1. Press **Sign in**. In a few seconds the card shows **Open** and a code.
2. Press **Open** and sign in on OpenAI's (or Kimi's) page.
3. Enter the code from the card there. Codex's code works for 15 minutes, Kimi's for 30; the card shows until when.
4. The card checks the sign-in by itself and shrinks to one line: "Codex: signed in".

Enter the code only on the page you opened from the card, and never share it.

### Claude Code: paste the code back

1. Press **Sign in**, then **Open**: Claude's sign-in page opens.
2. Sign in. The page shows a code: copy it.
3. Paste it into the card's field (**Code from the page**), not into the chat, and press **Continue**.

You have 15 minutes to finish. The card then checks the sign-in and turns green.

If a sign-in fails or runs out of time, the card says why and offers **Try again**. **Cancel** stops one in progress. A card for a brain that is already signed in has **Sign in again**, for switching accounts.

### When the CLI isn't installed

The desktop app and a server installed with `install.sh` can install a missing CLI for you. The row then says **Not installed** and the button is **Install and sign in**: the hub installs the CLI from its official npm package into `<data>/tools` (a one-time download of a few hundred MB), then the sign-in starts by itself.

A CLI you installed yourself wins: the hub finds it on the `PATH` of your login shell first. So a Claude Code or Codex you already use, signed in, works as it is, with no second sign-in. Installed something just now? Press **Check again** on the card.

Running from source? Set `PIOMIO_INSTALL_CLIS=1` to get the same installs, or install the CLIs yourself.

### On a server

A hub installed with `install.sh` runs as the user `piomio`, and agents think with whatever that user is signed in to. **Sign in** in the chat works there just the same. If you prefer the terminal, sign in yourself, as that user:

```bash
sudo -iu piomio
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex login --device-auth
```

Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`, then `claude` and its sign-in. Kimi Code: `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`, then `kimi` and `/login`. Piomio notices the sign-in within a minute; nothing needs a restart. Sign in as `piomio`, not as root, or the hub won't see it. More in [On a Linux server](server.md).

### Each computer signs in on its own

A sign-in belongs to the computer where the CLI runs. When you connect another computer, its Claude Code, Codex and Kimi Code become brains too, and they think with the sign-in on that computer. Their card says **This brain signs in on its own computer.** Piomio never carries a sign-in from one computer to another. See [Machines and other computers](machines.md).

## The Brains page

Open **Settings** → **Brains**. It lists every brain the hub knows, on this computer and on your other computers, each with a status:

| Status | What it means |
|---|---|
| **ready** | installed, signed in and not over a limit |
| **sign-in needed** | the CLI is there but not signed in: press **Sign in** |
| **needs setup** | an API brain without its key, server or model |
| **unavailable** | the CLI doesn't start, usually because it isn't installed |
| **limited until …** | it hit its plan's limit; agents skip it until that time |
| **not checked** | not checked yet |
| **not connected** | an agent names a brain the hub doesn't have now: its plugin is off or its computer is offline |

Under the name you see its model, version, where it runs and when it was last checked. **Check all** and **Check** look again; **Clear limit** forgets a recorded limit so agents try the brain before the reset time. Below, **How to connect** has a sign-in card for Claude Code, Codex and Kimi Code.

The same works in the chat: "which brains do we have?", "check Codex again", "Claude's limit should be over by now, try it".

## Which brain answers

Each agent has its brains in order (**Brains, in order** in the agent's settings). You can also just say "let Ada use Codex first".

- **In a chat**, the agent thinks with the brain you picked for it, or else the first in its list. If that one can't answer now (not signed in, over its limit), the next ready one does. If you picked the brain yourself, the chat goes back to it once it can; otherwise the chat stays on the brain it moved to until you change the agent's brains.
- **Tasks, channels and schedules** get their brain per piece of work: the hub puts the agent's brains in the order that suits it (a quick errand, everyday work or hard thinking; code or writing), with a model and effort for each, and the first that can work now takes it.
- **When every brain is over its limit**, the chat says so and when it will carry on. A task waits and starts again at the reset time.
- **When the agent's brains are only not connected for now** (the hub moving to another computer, a computer asleep, a plugin restarting), the chat shows a passing line instead of an error: "No connection to the brain · I'll answer as soon as it is back". The agent answers once one is back, and the line goes by itself. **Stop** ends the wait. Only after half an hour without one does the chat say it can't start. A task waits for its brains quietly in the same way.
- **A brain on the hub's computer also stands for the same brain on your other computers**, after the agent's own list. Work goes to Codex on your laptop when the hub's Codex is out or busy.
- **An agent none of whose brains is set up** thinks with any other brain the hub has, the quickest first, unless it is bound to particular computers.

How many tasks share one brain at a time is **Parallel sessions per brain** in **Settings** → **General** → **Brains** (2 by default). The rest wait in line; your own conversations never do.

## Models and depth

In an agent's chat, the brain button in the header opens **How Ada thinks in this chat**:

| Preset | What it does |
|---|---|
| **Auto** | answers at once on the quickest brain; picks the brain and depth for each task |
| **Fast** | quick answers, light thinking |
| **Balanced** | everyday work |
| **Deep** | thinks longer over hard things |

A new agent thinks **Auto**. Each brain turns a preset into its own model and effort. On Claude Code, for example, **Fast** is Sonnet at low effort, **Balanced** is Opus at medium effort and **Deep** is Opus at extra-high effort (high, on a CLI without it). **Exact model and effort** lets you pick a **Model** and an **Effort** yourself. The levels come from the installed CLI; an effort a brain doesn't have becomes the nearest one it has.

The same menu lists the agent's brains: picking one makes it the first for the chat. **Different for tasks, channels, schedules** opens a short chat with the agent to set each kind of work apart; a kind without its own choice thinks as in the chat. **Connect another brain** opens the Brains page.

Agents on Codex always run at its standard speed. The **Fast** preset is only a model and an effort: Codex's own Fast mode, which uses up a plan quicker, stays off for agents even when your `~/.codex/config.toml` turns it on.

Between your messages, the Claude Code or Codex of a chat stays running for 10 minutes, for up to three chats per brain, so the next answer starts sooner. While it waits it uses no tokens.

### /brain and /effort

The hub answers these at once, without asking the model:

| You write | What happens |
|---|---|
| `/brain` | a card with the agent's brains and the one it thinks with now |
| `/brain codex` | the agent thinks with Codex in this chat (only a ready brain) |
| `/effort` | a card with the levels: the four presets and the brain's own efforts |
| `/effort deep`, `/effort high` | sets that level |

Names work in English and Russian. In Telegram the answer comes in words. In a group chat, write them in that agent's own chat.

## API keys as brains

By default agents think only through the CLIs, on your plans. A hub started with `PIOMIO_API_KEYS=1` (set alike on every computer that runs the hub) also lets them think through plain API keys:

- the API brain: `api:anthropic`, `api:openai`, `api:openrouter` and `api:custom` for Ollama, LM Studio, vLLM or any OpenAI-compatible server; Kimi, DeepSeek, GLM, Qwen, Gemini, Grok, Mistral and Groq are there too;
- Codex with an OpenAI API key;
- API keys for the Claude Code and Codex on your other computers ([Machines and other computers](machines.md)).

To give a key, say "connect OpenRouter", or paste the key into a message: the hub recognises the usual formats, takes the key out of the message and stores it in the vault. The setup card and the Brains page then have an **API keys** section with a field per provider. Keys live in the vault under these ids:

| Vault id | Used for |
|---|---|
| `anthropic_api_key` | `api:anthropic` |
| `openai_api_key` | `api:openai`, Codex with a key |
| `openrouter_api_key` | `api:openrouter` |
| `custom_llm_api_key` | `api:custom`, only if your server needs a key |

The others follow the same pattern: `moonshot_api_key`, `deepseek_api_key`, `zhipu_api_key`, `qwen_api_key`, `gemini_api_key`, `xai_api_key`, `mistral_api_key`, `groq_api_key`.

### Your own model server

`api:custom` talks to `http://127.0.0.1:11434/v1` (Ollama) with the model `llama3.1` until you change them: ask the assistant, or set **OpenAI-compatible server URL** and **OpenAI-compatible server model** in the **API brain** plugin's settings. A server on the same computer is always reachable. One elsewhere on your network has to be allowed: add its host to **Extra allowed hosts** in **Settings** → **General** → **Brains** (`brainEgressAllow`). Because its address is a private one, it also has to be in `egressPrivateAllow`, which has no field yet ([Settings and environment variables](settings.md)).

### Keys that work either way

Keys that aren't brains don't need `PIOMIO_API_KEYS`: web search (`brave_api_key`, `tavily_api_key`), the Telegram bot token and speech-to-text for voice messages (a Groq or OpenAI key, or your own Whisper server) all work on any hub.

What brains may do on their own computer, the sandbox and auto mode are in [Approvals and auto mode](approvals.md).
