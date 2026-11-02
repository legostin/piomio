# Pio, the always-on assistant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pio, a small companion over every app on the desktop: sees the active window, talks and listens (local
open-source voice), says useful things by itself, drives the mouse and keyboard when handed control, and delegates to
the team from its own dialog.

**Architecture:** Three streams with fixed contracts. (A) the desktop app's overlay window and native commands (Rust,
Tauri 2); (B) the hub's voice engine (sherpa-onnx downloaded on demand, local STT + Piper TTS, `/api/speech/*`);
(C) the core plumbing (offers, companion agents, quiet turns, bare routes, message deletion) and the built-in plugin
`plugins/pio` (agent, tools, watch loop, overlay UI). Spec: `docs/superpowers/specs/2026-11-03-pio-always-on-design.md`.

**Tech Stack:** Node 24 TypeScript (type stripping, `.ts` imports, `import type`), vitest, React (web + plugin UI via
`@piomio/ui-sdk`), Rust/Tauri 2.12 (xcap, enigo, tauri-plugin-global-shortcut, tauri-plugin-dialog), sherpa-onnx-node
2.0.1 (Apache-2.0).

## Global Constraints

- Every user-facing string goes through a catalog (core `packages/core/src/locales/{en,ru}.ts`, web
  `packages/web/src/i18n/{en,ru}.ts`, plugin `.piomio-plugin/locales/{en,ru}.json`, desktop `src-tauri/src/i18n.rs`);
  English is the source; parity tests must pass.
- Text for the model (tool descriptions/results, notes, prompts), code and comments: English.
- Only erasable TS syntax; `import type` for types; local imports with `.ts`.
- Plugins only `import type` from `@piomio/plugin-sdk` / `@piomio/ui-sdk`.
- Tool names `pio_<name>` (plugin id `pio`).
- Secrets never in settings or prompts.
- Tests write temp files only under `tmpdir()`; no network in tests (fake servers on 127.0.0.1).
- Docs: changed pages in `docs/guide/{en,ru}/` in the same commit as the feature, both languages, same sections.
- A new server setting (env var) goes in `.env.example` + `docs/guide/{en,ru}/settings.md` (none planned).
- Running downloaded native code (sherpa-onnx) needs the person's OK: unit tests inject a fake module.

---

## Stream A — Desktop overlay (packages/desktop)

### Contract (the overlay page calls these; nothing else may)

Page → app: `window.__TAURI_INTERNALS__.invoke(cmd, args)`; granted only to window label `pio` and only to the
hub's origin (remote capability added at runtime like `hub-window-drag`).

| Command | Args | Returns |
|---|---|---|
| `pio_frontmost` | — | `{ app, bundleId?, title?, pid, bounds:{x,y,width,height} } \| null` (skips Piomio's own windows; screen points) |
| `pio_capture` | `{ target: "window"\|"screen", maxSide?: number }` (default 1440) | `{ jpeg: base64, width, height, origin:{x,y}, scale }` — screen point = origin + pixel / scale |
| `pio_frame` | `{ expanded: boolean }` | `null` — bubble 72×72 ↔ card 380×560, anchored at the bubble's corner nearest the screen edge |
| `pio_permissions` | — | `{ screen: boolean, accessibility: boolean }` |
| `pio_open_settings` | `{ pane: "screen"\|"accessibility"\|"microphone" }` | `null` |
| `pio_control_begin` | `{ reason: string }` | `boolean` — native ask dialog; true starts control |
| `pio_control_end` | — | `null` |
| `pio_act` | `{ action, x?, y?, toX?, toY?, text?, keys?, dx?, dy?, target? }` | `null` or error string; refused unless control is on |
| `pio_hotkey` | `{ on: boolean }` | `null` — registers ⌥Space (Windows: Alt+Space) |
| `pio_hide` | — | `null` — hides the bubble, saves `pio=false` |

`action`: `click | double_click | right_click | move | drag | type | key | scroll | open`. `keys` like `"cmd+shift+t"`,
`"enter"`, `"esc"`; `target` for `open`: an app name or an http(s) URL.

App → page: `window.dispatchEvent(new CustomEvent("piomio-desktop", { detail }))` with
`{ type: "pio-control-ended", why: "esc"|"mouse"|"timeout"|"ended" }` and `{ type: "pio-hotkey", state:
"pressed"|"released" }`.

Main window → app: navigation to `<scheme>://pio?show=1` / `?show=0` (deeplink.rs `WindowAction::Pio(bool)`).

The overlay window's init script: `window.piomioDesktop = Object.freeze({ scheme, test, overlayTitleBar: false, pio:
true })`.

### Task A1: settings + deep link + window

**Files:** Modify `src-tauri/src/settings.rs` (field `pio: bool`, `pio_pos: Option<(f64, f64)>` serde-default),
`src-tauri/src/deeplink.rs` (`WindowAction::Pio(bool)` from `<scheme>://pio?show=1|0`), `src-tauri/src/app.rs`
(`on_window_link` handles it; at startup with a hub URL open the pio window when `settings.pio`), create
`src-tauri/src/pio/mod.rs` (`open(app, hub: Url)`, `close(app)`, `frame(app, expanded)`), `tauri.conf.json`
(`app.macOSPrivateApi: true`), `Cargo.toml` (`tauri` feature `macos-private-api`).

- [ ] Tests (Rust `#[cfg(test)]`): deeplink parses `piomio://pio?show=1` → `Pio(true)`, `?show=0` → `Pio(false)`,
  other hosts unchanged; settings round-trip with and without the new fields (old files load); `frame_rect(bubble:
  Rect, screen: Rect, expanded)` keeps the card on screen and anchored at the nearest corner.
- [ ] Window: `WebviewWindowBuilder::new(app, "pio", External(hub_origin + "/pio/overlay"))`, transparent,
  decorations false, always_on_top, visible_on_all_workspaces, skip_taskbar, shadow false, resizable false,
  focused false, inner_size 72×72, position from `pio_pos` else bottom-right of the main screen (24 px margin);
  `on_navigation` same origin only; remember position on `WindowEvent::Moved`.
- [ ] `cargo test` passes; `cargo build` passes. Commit.

### Task A2: seeing (frontmost, capture, permissions)

**Files:** create `src-tauri/src/pio/screen.rs`; `Cargo.toml` adds `xcap = "0.9"`, `image` (jpeg encode);
`build.rs` lists the new commands; `src-tauri/src/pio/commands.rs` (`#[tauri::command]` fns); `main.rs` registers.

- [ ] macOS frontmost: xcap `Window::all()` → first with `is_focused()` and not our pid, z-order first, non-zero size;
  title may be empty without Screen Recording permission. Windows: same via xcap.
- [ ] Capture: macOS `screencapture -x -o -t jpg -l <window_id> <tmp>` (window) or `-x -t jpg -m`/`-R` (screen);
  Windows xcap `capture_image`; then scale to `maxSide`, JPEG q≈70, return geometry. Temp files under
  `std::env::temp_dir()`, removed right away.
- [ ] Permissions: macOS `CGPreflightScreenCaptureAccess()` and `AXIsProcessTrusted()` (FFI, CoreGraphics /
  ApplicationServices); Windows both true. `pio_open_settings` opens
  `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture|Privacy_Accessibility|Privacy_Microphone`.
- [ ] Unit tests: geometry math `scale_for(w, h, max_side)` and `to_screen(px, origin, scale)`. Commit.

### Task A3: control (ask, frame, act, end) + hotkey

**Files:** create `src-tauri/src/pio/control.rs`, `ui/frame.html` (red 4 px border + "Pio is driving — Esc" label, both
locales via query param), `Cargo.toml` adds `enigo = "0.6"`, `tauri-plugin-global-shortcut = "2"`,
`tauri-plugin-dialog = "2"`; `src-tauri/src/i18n.rs` strings for the dialog and the frame; `Info.plist` +
`macos/*.lproj/InfoPlist.strings` keep the microphone text and say Pio listens too.

- [ ] `pio_control_begin`: native dialog (tauri-plugin-dialog, blocking on a thread) with the reason; yes → state
  `Control { until: now+10 min, expect: cursor }`, open click-through window `pio-frame` over the screen
  (`set_ignore_cursor_events(true)`), register Esc global shortcut, start a 50 ms cursor watch thread: cursor away from
  `expect` by > 4 pt (not by our own action) → end("mouse"); past `until` → end("timeout").
- [ ] `pio_act`: refused (`"control is off"`) unless on; enigo moves/clicks/types/keys/scrolls; `open` runs `open -a`
  / `open <url>` (Windows `cmd /c start`); every action updates `expect`. Key names map (cmd/ctrl/alt/option/shift,
  enter, esc, tab, space, backspace, delete, arrows, f1–f12, letters/digits).
- [ ] End: unregister Esc, close the frame, emit `pio-control-ended` to the `pio` window.
- [ ] `pio_hotkey {on}`: register/unregister ⌥Space with pressed/released events to the `pio` window.
- [ ] Unit tests: key-combo parser (`"cmd+shift+t"` → modifiers + key; unknown → error), control state machine
  (begin/act/end/timeout with an injected clock). Commit.

---

## Stream B — Voice engine (packages/core)

### Contract

- `GET /api/speech` → `SpeechStatus = { runtime: "missing"|"downloading"|"ready"|"failed", error?, voice: string,
  voices: VoiceInfo[], stt: { provider: TranscriptionProvider, local: { model: string, installed: boolean } },
  downloading?: { item: string, received: number, total: number } }`, `VoiceInfo = { id, lang, gender: "male"|"female",
  name, size, license, installed }`.
- `POST /api/speech/install { voice?: string, stt?: boolean }` → `SpeechStatus` (downloads continue in the background;
  progress through the UiEvent `{ type: "speech.status", status }`).
- `POST /api/speech/say { text, voice?, speed? }` → `audio/wav` (409 `{ error }` when the runtime or voice is not
  installed; text cleaned of Markdown, cut at 1000 chars).
- `POST /api/speech/transcribe` (body `audio/wav`, ≤ 25 MB) → `{ text }` (503 `{ error }` when no engine).
- Core methods for plugins (manifest `CORE_METHODS`): `speech.status`, `speech.install` (same shapes).
- Settings: `voice: { voice?: string; speed?: number }` in `CoreSettings`; `transcription.provider` gains `"local"`.

### Task B1: runtime + catalog + WAV

**Files:** create `packages/core/src/speech/catalog.ts` (voices + STT models, URLs from
`https://github.com/k2-fsa/sherpa-onnx/releases/download/{tts-models|asr-models}/<name>.tar.bz2`, sizes, licenses),
`speech/runtime.ts` (download npm tarballs `sherpa-onnx-node@2.0.1` + `sherpa-onnx-<platform>-<arch>@2.0.1`, verify the
registry's `dist.integrity` sha512, extract into `<data>/voice/runtime/node_modules/<name>`, load via
`createRequire(<data>/voice/runtime/)`; injectable `load` for tests), `speech/models.ts` (download + `tar xjf` into
`<data>/voice/models/<id>`, atomic via `.part` dirs), `speech/wav.ts` (parse 16-bit PCM WAV → Float32 + rate; write
Float32 → 16-bit WAV).

- [ ] Tests: WAV round trip; catalog defaults (ru → `piper-ru-dmitri`, en → `piper-en-ryan`); runtime install against a
  fake registry (127.0.0.1) with a bad integrity → `failed`; models extract from a small fixture tar.bz2 made in the
  test with `tar cjf`. Commit.

### Task B2: TTS + local STT + Transcriber provider `local`

**Files:** create `speech/engine.ts` (`SpeechEngine`: `status()`, `install(opts)`, `say(text, opts) → Buffer`,
`recognize(samples, rate) → string`; lazy `OfflineTts` / `OfflineRecognizer` per model, `generateAsync`),
`speech/text.ts` (Markdown → speakable text, sentence split); modify `transcribe.ts` (provider `local`, `auto` falls
back to it when installed; a buffer entry point `transcribeBuffer(buf, mime)`), `settings.ts` (`voice` defaults),
`app.ts` (construct, wire `transcriber.local = engine`).

- [ ] Tests with a fake sherpa module: `say` returns a WAV of the fake samples; Markdown stripped (`**a**` → `a`, code
  blocks dropped, links → text); `pickEngine` with `local` and with `auto` (keys first, then local when installed);
  `recognize` gets 16 kHz Float32. Commit.

### Task B3: API, core methods, UI event, settings page, docs

**Files:** `server/api.ts` (the four routes; raw body parser for `audio/wav`), `packages/shared/src/manifest.ts`
(`speech.status`, `speech.install`), `core-call.ts`, `packages/shared/src/types.ts` (UiEvent `speech.status`),
`packages/web/src/pages/Settings.tsx` (voice row: provider `local` option, voice select, install button + progress),
locales (core + web), `docs/guide/{en,ru}/settings.md` (Voice section) and `chat.md` (voice notes without keys).

- [ ] Hub tests (testkit hub): `/api/speech` status; `/api/speech/say` 409 before install; with a fake engine 200
  `audio/wav`; `/api/speech/transcribe` with the fake engine returns text; i18n parity. Commit.

---

## Stream C — Core plumbing and the Pio plugin

### Task C1: plugin offers

**Files:** `packages/shared/src/manifest.ts` (`offer: z.string().max(2000).optional()`), `packages/core/src/plugins/
offers.ts` (new: `pendingOffers(layouts, enabled, offered) → {id, offer}[]`), `app.ts` (`lead()`: after
`announceUpdate`, when `setup` says the intro is done, tell the default agent each pending offer once; settings row
`plugin_offers` = string[]), test `packages/core/test/offers.test.ts`.

- [ ] Tests: built-in + disabled + offer + not offered → offered once; enabled → not; offered → not; third-party →
  never; intro not done → waits. Commit.

### Task C2: companion agents

**Files:** `packages/shared/src/types.ts` (`AgentDef.companion?: boolean`), `agents.ts` (frontmatter `companion`),
`app.ts` (a companion can't become the default agent: `hub_agent_*` / settings validation), web `lib/team.ts`
(`teamOrder` leaves companions out; `companionOf(entries)`), `pages/chat/TeamList.tsx` (`CompanionRow`: small row
on top with the avatar, name, state dot from `member.running` and the plugin's live state, links to its dialog), web
locales, test `packages/web/src/lib/team.test.ts` (or existing), `packages/core/test/agents.test.ts`.

- [ ] Tests: frontmatter `companion: true` → `companion: true`; teamOrder excludes companions; default agent cannot be
  set to a companion (400 / tool error). Commit.

### Task C3: quiet turns + message deletion

**Files:** `packages/shared/src/types.ts` (`Message.quiet?: boolean`; UiEvent `message.deleted`), `store.ts`
(`deleteMessage(id)`), `bus.ts` (forward `message.deleted`), `runner.ts` (`TurnOpts.quiet`, `tellAgent(conv, note,
{ quiet })` stores no note, skips when busy; `streamTurn` creates the reply with `quiet: true`; at the end: no text or
text starting `[quiet]` → delete every message of the turn, else `quiet: false`), `core-call.ts`
(`conversations.tell` takes `quiet`, `agentId`), web store (drop deleted, hide quiet), test
`packages/core/test/quiet-turns.test.ts` (fake brain answering `[quiet]` / `Hi`).

- [ ] Tests: quiet tell → `[quiet]` reply leaves no messages; real reply stays and is not quiet; busy conversation →
  `{ skipped: "busy" }`; team preview ignores quiet messages. Commit.

### Task C4: bare routes + overlay window rule

**Files:** `packages/ui-sdk/src/index.ts` (`routes.add({ ..., bare?: boolean })`), web `plugins/registry.ts`,
`App.tsx` (`ReadyApp`: a bare route renders alone; in the desktop's overlay window (`window.piomioDesktop?.pio`) only
bare routes render, else nothing and the app is asked to hide the bubble).

- [ ] Test: `matchRoute` keeps `bare`; App picks bare. Commit.

### Task C5: the Pio plugin (server)

**Files:** `plugins/pio/package.json`, `.piomio-plugin/plugin.json` (id `pio`, builtin, defaultEnabled false, offer,
tools, hooks `turn.context`, http, settings `{ chattiness: quiet|normal|chatty = normal, listen: name|key|all = name }`,
permissions core `conversations.tell, agents.list, ui.emit, speech.status, speech.install`, ui `route`),
`.piomio-plugin/locales/{en,ru}.json`, `agents/pio.md`, `server/index.ts`, `server/bodies.ts` (connected overlays,
timeline per body), `server/watch.ts` (pure: `nextWatch(state, now, settings) → note | undefined`), `server/relay.ts`
(request → `ui.emit("act", {id, body, ...})`, await `{type:"result", id}` with a 20 s timeout), `server/tools.ts`
(`look`, `click`, `double_click`, `right_click`, `type`, `key`, `scroll`, `open`, `settings`, `voice`),
`server/context.ts`, tests `plugins/pio/test/*.test.ts`.

- [ ] Tests: watch timing (settle 15 s, steady 5 min, caps per chattiness, none while talking/driving/away); context
  text; relay round trip and timeout; control tools refuse without control; `look` returns an image part and
  `_meta.taint`. Commit.

### Task C6: the overlay UI + main-window bridge

**Files:** `plugins/pio/ui/src/index.tsx` (bare route `/pio/overlay`; in the main desktop window navigate
`<scheme>://pio?show=1` once; on dispose `show=0`), `ui/src/overlay/{Overlay,Bubble,Card,Lines}.tsx`,
`ui/src/desktop.ts` (typed invoke wrappers + event listener), `ui/src/voice/{mic.ts,vad.ts,wav.ts,speaker.ts,gate.ts}`,
`ui/tsconfig.json`; build via `scripts/build-ui-plugins.mjs` (auto-discovers?).

- [ ] Tests (vitest, node): `vad` cuts phrases from synthetic energy frames; `gate` (name / key / follow-up 20 s /
  all); `wav` encode 16 kHz; markdown → sentences for speaking. Commit.

### Task C7: docs + checks

**Files:** `docs/guide/{en,ru}/pio.md` (new page) + `docs/guide/nav.json`, `plugins.md` mention, `README` feature
line if present. Run `npm run typecheck`, `npm test`, `npm run build`, `cargo test` in `packages/desktop/src-tauri`.
