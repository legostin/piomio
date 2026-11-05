Panel safe-area regression checks use the production components with local data and a simulated desktop-shell signal.

Run from the repository root:

```sh
npx playwright install chromium webkit
npx playwright test --config packages/web/e2e/playwright.config.ts
```

The `panel-layout` CI job captures the library and page using the base branch's sources, then restores the PR sources
and checks both browser engines. Screenshots are uploaded as the `panel-layout` artifact.

Coverage: 52 checks across Chromium/WebKit. Library, page, settings, plugin pane, expanded live view, full-screen map,
media viewer, photo editor, modal card and command palette at 1100×720 (simulated macOS shell) and 390×844 (phone).
Checks cover traffic-light clearance, controls fitting horizontally, close/collapse/cancel, desktop inset removal,
document opacity, responsive settings, and a tall modal in a short window. Every panel/width is captured.

The fixture does not emulate native traffic lights, dragging a real Tauri window, an iOS notch, or touch gestures.
Browser screenshots cannot prove that the native window is opaque. On macOS put another application with large,
contrasting text behind Piomio and inspect the top edge while opening panels, resizing, overscrolling and switching
between light/dark appearance. The text behind Piomio must never show through, including before WebKit paints.

## Native macOS check (founder)

The PR's `desktop app` workflow builds the macOS installer. Its artifact is a review build, not a release.
If that build is unavailable, from this branch's worktree run one command (Node 24, Go, Rust and Xcode tools needed):

```sh
bash scripts/dev-macos-panels.sh
```

This builds and starts the branch's native app with its own hub/data under `.data/macos-panel-dev`, port 41820.
It does not reuse the installed hub or its data. Complete initial setup in this test copy to open its panels.
The command's syntax is checked; launching it from the agent sandbox is unavailable and has not been verified.

1. Open the library/page, photo/editor, map, live view, settings/plugin pane, a modal card and Cmd+K. At normal and
   narrow window widths, headers and controls must clear the red/yellow/green traffic lights.
2. Put another application with large contrasting text behind Piomio. No text from it may show through the top
   strip when opening panels, resizing, overscrolling, changing theme or entering/leaving native fullscreen.
3. Drag the top strip: the Piomio window must move.
4. Click ✕ (and Cancel/collapse where applicable): the intended panel must close; the macOS window must stay open.
