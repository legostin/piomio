# Pio: the assistant that is always next to you

2026-11-03. A small companion that lives on the computer's screen, above every app: it sees which window the person
works in, talks and listens, now and then says something useful by itself, takes over the mouse and keyboard when the
person hands it control, and gives bigger work to the team. Its context is its own dialog and session, so the main
agents' dialogs stay clean.

## Shape

- A built-in plugin `plugins/pio` that ships **turned off** (`defaultEnabled: false`). It brings the agent Pio
  (`agents/pio.md`), its tools (`pio_*`), the watch loop, its settings and the overlay's UI (a bare route).
- What the plugin cannot do alone goes into the core, each piece generic:
  - **Offers**: a built-in plugin that ships off may carry `offer` (English, for the model) in its manifest. Once per
    plugin, when the hub leads and the first-run intro is over, the default agent gets the offer as a note and puts it
    to the person with buttons (`show_choices`); a yes is `hub_plugin_enable`. Offered ids are kept in the settings
    table (`plugin_offers`), so a replica or a restart does not offer again.
  - **Companion agents**: `companion: true` in an agent's frontmatter (`AgentDef.companion`, `TeamMember.companion`).
    The web shows such an agent as a small pinned row at the very top of the team, above the default agent's card,
    with its live state; it is never the default agent.
  - **Quiet turns**: `conversations.tell` takes `quiet: true`: the note is not stored, the reply message is hidden
    while it streams (`Message.quiet`), and a reply that is empty or starts with `[quiet]` is deleted instead of shown.
    A quiet tell is skipped when the conversation is busy (`{ skipped: "busy" }`).
  - **Bare routes**: `ui.routes.add({ ..., bare: true })` renders the route alone (no sidebar, no panels): the overlay.
  - **Voice engine** (below): local speech-to-text and text-to-speech in the hub, used by Pio and by every voice note.
- The desktop app (Tauri) gets the overlay window and the native commands it needs (below).

## Pio, the agent

- `agents/pio.md`: `companion: true`, thinking `chat: fast` (the router takes the lightest fast model the brains have,
  e.g. Haiku), `initiative: 1`, all tools (it is a dialog: the front desk rules apply, it only looks; work goes to
  teammates with `task_delegate` / `team_message`). Russian name "Пио".
- Its prompt: a colleague sitting next to the person. Short, spoken-style replies (one or two sentences unless asked);
  never reads code or long lists aloud; delegates anything longer than a quick look; uses `pio_look` when the person
  points at the screen ("this", "here", "что тут"); in control mode does what the person asked and nothing else.
- Context each turn (`turn.context` hook, only Pio's dialog): `[On screen]` the active app and window title, how long,
  the last few windows; whether co-working, voice and control are on.

## The overlay (desktop app)

- Window `pio`: transparent, frameless, always on top, on every desktop, no Dock/taskbar entry, does not take focus
  when shown. It loads the hub's `/pio/overlay` (same origin and cookies as the main window).
- Shown while the plugin is on and the person has not hidden it: the main window's page navigates to
  `piomio://pio?show=1|0` (like reset/quit links); the app keeps `pio` in its settings and opens the window at start.
- The bubble (56 px) shows Pio's face with a ring for its state: idle, watching, listening, thinking, speaking,
  driving. Hover opens the card (resized by `pio_frame`): switches **Work together**, **Voice**, **Hand over control**;
  a text field; the last lines; "Open chat". Pio's own lines pop out beside the bubble and fade after ~12 s (stay while
  hovered). The bubble can be dragged; the app remembers where.
- Native commands, granted only to the `pio` window and only to the hub's origin:
  - `pio_frontmost` → `{ app, bundleId?, title?, pid, bounds }` of the active window, skipping Piomio's own windows.
  - `pio_capture { target: "window"|"screen", maxSide }` → JPEG (base64) and its geometry (origin, scale), scaled to
    at most 1440 px. macOS: `screencapture`; Windows: xcap.
  - `pio_frame { expanded }`, `pio_permissions` (screen recording, accessibility) and `pio_open_settings`.
  - `pio_control_begin` → a **native** confirmation ("Let Pio use the mouse and keyboard?"): the page cannot fake it.
    Then a red frame around the screen (a click-through window) and Esc as a global shortcut: Esc, the card's switch
    or 10 minutes end control (`pio-control-ended` event to the page); the person's own mouse does not, it stays
    theirs to use meanwhile.
  - `pio_act { action: click|double_click|right_click|move|drag|type|key|scroll|open, ... }` (enigo; `open` starts an
    app or a URL), refused unless control is on.
  - Push-to-talk: ⌥Space as a global shortcut while voice is on (pressed/released events).
- macOS permissions: Screen Recording (window titles and captures), Accessibility (control), Microphone (already
  declared). The card says what is missing and opens the right Settings pane.

## Seeing and saying

- While **Work together** is on, the overlay asks `pio_frontmost` every 2 s and sends changes to the plugin
  (`observe`). The plugin keeps a short timeline per computer (in memory only).
- Every 15 s the overlay sends its state (the switches, the current window, Pio's chat) and the plugin answers each
  one (`seen`): a window the hub forgot (a restart, the computer asleep for over a minute) is back whole with the next
  heartbeat, and three unanswered heartbeats make the face say the hub is out of reach instead of "listening".
- `pio_look { target? }` (read): the plugin asks the overlay for a capture and returns the image in the tool result.
  Nothing is stored. Screen content is outside content: the session is marked tainted (`_meta.taint`).
- The watch loop: a window that stayed ≥ 15 s after a change, or ~5 min on one window, makes a quiet turn:
  `[Watch] The person is in Figma — "Landing v3" for 4 min; before: Safari — "Tailwind docs". Say one short useful
  thing only if it truly helps now, else reply [quiet].` Caps by chattiness: quiet ≥ 30 min between remarks, normal
  ≥ 10 min, chatty ≥ 3 min. No watch turns while the person talks with Pio, while Pio drives, or while the person is
  away (no window change for 15 min).
- Pio's replies (asked or not) appear in the overlay and in its dialog; with voice on they are spoken.

## Voice

- **Engine**: sherpa-onnx (Apache-2.0) through `sherpa-onnx-node`. Not in the installers: the hub downloads the
  wrapper and the platform's package from the npm registry (pinned version, checked against the registry's sha512)
  into `<data>/voice/runtime/node_modules` the first time voice is used, and loads it with `createRequire`.
  Models download from the sherpa-onnx releases into `<data>/voice/models/<id>`.
- **Text to speech**: Piper voices (VITS, ~21 MB int8 each). Catalog: Russian Dmitri (male, CC0, default for ru),
  Denis (male, CC0), Irina (female), English Ryan (male, default for en), Amy (female). `POST /api/speech/say
  { text, voice? }` → `audio/wav`. Markdown is stripped; long text is split into sentences.
- **Speech to text**: a new transcription provider `local` (catalog: GigaAM v3 with punctuation for Russian,
  Parakeet TDT v3 for other languages). `auto` keeps OpenAI → Groq first and falls back to `local` when it is
  installed. `POST /api/speech/transcribe` (a 16 kHz WAV) → `{ text }`: the overlay's live phrases.
- Settings `voice: { voice?, speed? }` and `transcription.provider: "local"`, changed in the chat (Pio's
  `pio_settings` tool, the default agent's `hub_settings_update`) or the Settings page; `GET /api/speech` says what is
  installed and what downloads.
- **Listening** in the overlay: the mic with echo cancellation, an energy-based voice detector cuts phrases (700 ms
  of silence, 20 s max); each phrase is transcribed; it goes to Pio when it names Pio ("Пио", "Pio"), while ⌥Space is
  held, or within 20 s after Pio spoke. Everything else is dropped unsaved. Pio stops speaking when the person starts.
- The mic looks after itself (`mic.ts`): a capture WebKit ended or muted (the computer slept, a headset came or went)
  or a context it suspended is noticed within 5 s, woken, and opened again after 10 s; meanwhile the face says it
  cannot hear instead of "listening", and a phrase the hub could not transcribe is said in the card.
- Voice needs a secure page: the hub at localhost or https.

## Control

- The person hands control in the card or by voice ("Пио, сделай…" + the card's button); the native confirmation
  appears on that computer. While it lasts, Pio's `pio_click/type/key/scroll/open` reach the overlay (plugin event →
  page → `pio_act`) and every action goes to the audit log. Coordinates are in the last capture's pixels; the
  overlay maps them back to screen points.
- Without control the tools answer: "The person has not handed you control. Ask them to press 'Hand over control'."
- Watch turns stop while Pio drives.

## Security

- Captures only while co-working is on, never stored; the overlay's native commands exist only in the `pio` window
  and only for the hub's origin; control only after the native confirmation, ended by Esc, the card's switch or time.
- What Pio sees on screen marks its session tainted, so the hub's egress guards apply to anything it sends out.

## Testing

- Core: offers (once, after the intro, not for enabled plugins), quiet turns (kept, dropped, skipped when busy),
  companion members, bare routes, the voice catalog and downloads (a fake registry and release server), WAV
  parsing, provider choice with `local`.
- Plugin: the watch loop's timing and caps with a fake clock, `pio_look` and control round trips through a fake
  overlay, the turn context.
- Desktop: unit tests for geometry mapping and settings; the native parts checked by hand on the Mac.
- Web: the companion row, the overlay's phrase gating (name, push-to-talk, follow-up window).
