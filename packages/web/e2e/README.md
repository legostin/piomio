Panel safe-area regression checks use the production components with local data and a simulated desktop-shell signal.

Run from the repository root:

```sh
npx playwright install chromium webkit
npx playwright test --config packages/web/e2e/playwright.config.ts
```

The `panel-layout` CI job captures the library and page using the base branch's sources, then restores the PR sources
and checks both browser engines. Screenshots are uploaded as the `panel-layout` artifact.

Coverage: full-window coverage and opacity, 52px traffic-light clearance, close buttons remaining clickable, removing
the desktop inset in fullscreen/web/mobile, responsive settings, and a tall modal in a short window.

The fixture does not emulate native traffic lights, dragging a real Tauri window, an iOS notch, or touch gestures.
Before merging, verify those on macOS: library → page → close → search, photo → edit/cancel, full-screen map, expanded
live view, settings and plugin panes at narrow/wide widths, connection cards and Cmd+K. Drag the top strip, click the
close buttons, enter/leave native fullscreen, and confirm no chat text shows above the panel. Compare web and iPhone.
