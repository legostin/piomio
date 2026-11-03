---
title: Pio, the assistant always next to you
nav: Pio, always next to you
description: Pio floats over every app on your Mac or PC: it sees which window you work in, talks and listens with a local voice, says something useful on its own now and then, takes the mouse and keyboard when you hand them over, and passes bigger work to the team.
---

Pio is a small face that floats over every app on your computer, like a colleague at the next desk. It sees which
window you work in, you can talk to it and it answers out loud, it now and then says something useful by itself, and
when you hand it the mouse and keyboard it does things for you. Bigger work it passes to your team, so the other
agents' chats stay clean.

Pio needs the Piomio desktop app on a Mac or a Windows PC. On other devices Pio is still there as a chat.

## Turn Pio on

Pio comes turned off. After the update (on a new hub: right after the introductions) your main assistant offers it
once in the chat, with buttons. While Pio is off, a **Turn on Pio** line waits under your main assistant in the
sidebar; it asks the assistant for you. You can also ask any time: "turn on Pio". To turn it off, say "turn off Pio", or switch it off in **Settings → Plugins → Pio — always
next to you**.

Once Pio is on, two things appear:

- **Its face** in a corner of your screen, above every window. Drag it wherever you like.
- **Its chat**: in the sidebar Pio's small face flies beside your main assistant, with what it is doing under its name. Everything you say to Pio and everything it says is there.
  Pio's chat is its own: what you discuss with Pio does not fill the other agents' chats.

## The face and its card

Hover over the face to open its card:

- **Work together**: Pio sees which app and window are active (their names and titles). It checks every two seconds
  and keeps only the last few windows, in memory, never on disk.
- **Voice**: you talk to Pio and it answers out loud (see below).
- **Hand over control**: Pio may use the mouse and keyboard (see below).
- A field to type to Pio, its last lines, **Open chat** and ✕ to hide the face. To bring it back, click Pio next to your
  main assistant in the sidebar, or tell Pio "come back".

The ring around the face shows what Pio is doing: watching, listening, hearing you, thinking, speaking, or driving
(red). The same word shows next to Pio in the sidebar.

When Pio says something while the card is closed, its line pops out next to the face for a few seconds.

## What Pio sees

With **Work together** on, Pio knows the active app and window title before each answer, and the windows before it.
Pio can also read the active window as text through macOS's accessibility (what screen readers use): the page's
address or the document's file, what you selected, the field you type in, and the text it shows, never a password
field. For mail, documents, code and pages that is quicker and more exact than a picture, so Pio reads first and looks
at a picture for charts and layout.

When you ask Pio to look ("Pio, look what's wrong with this chart", "what's here?"), the face sends a picture of your
active window with your words, so Pio sees what you mean at once; otherwise Pio takes the picture itself when it needs
one. The picture goes with that message into Pio's chat (its files, like any photo you send), nowhere else.

Now and then Pio takes a quiet look on its own: when you settled in a new window, or after you worked in one window for
a while. It speaks up only when it has something truly useful to say (a mistake, a faster way, something from memory
or from the team's work); otherwise it stays silent, and these looks leave nothing in its chat.

How often it may speak up on its own is up to you. Say it in Pio's chat: "talk less", "speak up whenever you have a
tip". There are three levels: quiet (rarely), normal, chatty. Pio never looks on its own while you are talking with it
or while it drives.

What is on your screen is outside content for Piomio: after Pio looked, the hub's guards for outside content apply to
its chat (see [Security](security.md)).

## Voice

Turn on **Voice** in the card. The first time, Pio offers to download its voice once: the speech engine
([sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), open source), a voice and a speech-to-text model. Everything runs
on the hub's own computer, with no keys and no cloud. Until the download finishes, Pio speaks with your computer's own
voice.

- **Voices:** Russian Dmitri (male, the default for Russian), Denis (male) and Irina (female); English Ryan (male,
  the default) and Amy (female). Ask your assistant to switch: "let Pio speak with Denis's voice".
- **Speech to text:** GigaAM for Russian, Parakeet for other languages, also local. If the hub has an OpenAI or Groq key
  for voice messages, those are used first (see [Settings](settings.md)).

Pio does not answer everything it hears. By default it answers:

- what you say after its name, the wake phrase: "Pio, what's wrong with this chart?";
- what you say while holding **⌥Space** (Alt+Space on Windows), name or not;
- your answer right after it spoke (for 20 seconds).

The rest of what the mic hears is dropped and never saved. You can change that in Pio's chat: "listen only while I hold
the key", or "hear everything I say". When you start speaking, Pio stops talking.

> Voice works when Piomio opens the hub at `localhost` (the hub on this computer) or over `https`.

## Hand over control

Ask Pio to do something ("Pio, open my last invoice and send it to Anna") and press **Hand over control** in the card.
Your computer asks to confirm in its own window, which no page can fake. Then:

- a red frame goes around the screen while Pio drives;
- Pio looks, clicks, types, presses keys, scrolls and opens apps or sites, one small step at a time;
- **Esc**, any move of your own mouse, or 10 minutes take control back at once; so does the switch in the card.

Pio does only what you asked. It never types passwords, card numbers or codes, and it does not send, pay, delete or
publish unless that is exactly what you asked for. Every step is in the hub's security log.

## On a Mac: permissions

macOS asks once for each of these, for Piomio:

| Permission | What for |
|---|---|
| **Screen Recording** | window titles and Pio's look at the screen |
| **Accessibility** | reading the window's text, and the mouse and keyboard when you hand over control |
| **Microphone** | Pio's voice |

When one is missing, Pio's card says so and **Open Settings** goes to the right place in System Settings.

## Pio and the team

Pio thinks with a fast model, so it answers at once. Anything that takes steps (research, code, a long read, the
browser, work on another computer) it gives to a teammate as a task and tells you who took it. You see the task in
Pio's chat and in **Tasks**, like any other.
