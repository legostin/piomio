# Piomio desktop app (Tauri 2, macOS and Windows)

Approved 2026-10-26. Replaces the installers of `2026-10-26-desktop-installers-design.md`: Inno Setup with a C# tray
on Windows, a self-contained AppleScript app with a LaunchAgent on macOS. Docker stays the server install.
Implementation plan: `docs/superpowers/plans/2026-10-26-desktop-app.md`.

## Goal

Piomio on a computer is an app, not a link that opens in the browser. Its own window shows the hub's web UI with no
browser tab or visible address, a menu bar / tray icon shows its state, and closing the window keeps it running in the
background (Telegram, tasks, triggers). Quit stops it. Browser and phone access to the hub keep working.

The first run asks what this computer is: a new hub, or a machine joining an existing hub.

In the first version: the window with automatic sign-in, the tray, the hub or the machine in the background, the
first-run choice, `piomio://pair` links, the macOS `.dmg` and `.pkg`, the Windows installer and silent installs.
Later: system notifications, auto-update, code signing and notarization.

## Layout

```
packages/desktop/                    npm workspace @piomio/desktop
  ui/                                the app's own screens (first run, pairing, errors): TypeScript, esbuild
  src-tauri/
    tauri.conf.json, Cargo.toml, build.rs, capabilities/setup.json
    src/main.rs                      plugins, commands, window events
    src/app.rs                       state, paths, modes, what the tray, links and a second launch do
    src/commands.rs                  commands of the setup screens
    src/settings.rs                  <app config dir>/settings.json, the machine pairing in ~/.piomio-node
    src/supervisor.rs                runs and watches the hub or node process
    src/window.rs                    the hub window and the setup window, navigation rules, close-to-tray
    src/tray.rs                      menu and status
    src/autostart.rs                 start at login (a LaunchAgent on macOS, HKCU Run on Windows)
    src/login.rs                     one-time sign-in tickets
    src/deeplink.rs                  piomio://pair parsing
    src/i18n.rs                      catalogs from packaging/desktop/locales (include_str!)
    src/shellpath.rs                 macOS: the user's login-shell PATH
    src/migration.rs                 macOS: the AppleScript build's LaunchAgent goes
packaging/desktop/                   stage.mjs, launch.mjs, resolve.mjs, locales/{en,ru}.json, build.mjs (new)
packaging/macos/                     the silent .pkg around the app: generate.mjs (Installer pages, distribution),
                                     pkg.mjs, scripts/{preinstall,postinstall}, uninstall.sh
packaging/windows/generate.mjs       NSIS hooks from the catalogs: start after a silent install, the data question
```

Removed: `packaging/windows/{piomio.iss,build.mjs,tray/}`, `packaging/macos/{build.mjs,bin/}` and the AppleScript
launcher in `generate.mjs`. `stage.mjs`, `launch.mjs` and `resolve.mjs` stay, except the stdin handling that moves
into the core (see Sign-in). The stage leaves out `packages/desktop` (only its `package.json` stays, so `npm ci` finds
the workspace) and drops dangling links and Node's `bin/npm`/`bin/npx` links: codesign refuses the former, the Tauri
bundler would copy the latter as broken files (the hub runs npm through `npm-cli.js`).

Changes outside the app, kept small: `packages/core` (`desktop-login.ts`, the stdin commands in `cli.ts start`,
`POST /api/auth/desktop` in `server/main-app.ts`), `packages/node` (`run` stops on a `stop` line), `packages/web` (the
`#desktop=` ticket, the Machines page link). Brain detection, the login-shell PATH in the core and the chat's setup
card belong to another workstream and are not touched.

The bundle identifier is `ai.piomio.app`, the product and binary name `Piomio`. The staged app tree
(`dist/desktop/stage-<target>/app`) is a Tauri resource named `app`: `Piomio.app/Contents/Resources/app` on macOS,
`<install dir>\app` on Windows.

## Modes and settings

`<app config dir>/settings.json` (`~/Library/Application Support/ai.piomio.app`, `%APPDATA%\ai.piomio.app`):

```json
{ "mode": "hub", "autostart": true }    // mode "hub" | "node"; no file = first run
```

- **hub**: the hub runs here, with the data dir and ports of `launch.mjs`: `~/Library/Application Support/Piomio` or
  `%LOCALAPPDATA%\Piomio`, ports from `<data>/desktop.json` (default 41780, console 41781, egress proxy 41789: away
  from 8080, which servers and dev tools tend to hold, and from OpenClaw's 18789; Docker keeps 8080). Before a start
  the app checks all three and reports the first busy one.
- **node**: this computer is a machine of another hub. `packages/node` keeps its state in `~/.piomio-node` (hub URL,
  key, policy) as with the CLI.

CLI arguments: `--background` (no window: start at login), `--mode hub|node` (makes the first-run choice when none
was made; also through a second launch, for CI and silent installs), `--quit` (stops the running instance through
single-instance).

Environment for development and tests: `PIOMIO_DATA_DIR` marks a dev or test run: the app then writes no
start-at-login entries, leaves the AppleScript build's agent alone and keeps its own settings and the node log in
that data dir (`app/settings.json`, `logs/node.log`), away from an installed app's. `PIOMIO_APP_ROOT` points a dev run at a staged
tree, `PIOMIO_NODE_HOME` moves the node state.

## Process supervision (`supervisor.rs`)

The app runs one child process on the bundled Node (`app/runtime/node.exe`, `app/runtime/<arm64|x64>/bin/node`):

- hub: `node app/packaging/desktop/launch.mjs run` with `PIOMIO_DESKTOP=1`;
- node: `node app/packages/node/dist/piomio-node.mjs run` with `PIOMIO_DESKTOP=1` and `PIOMIO_LANG` from the app's
  language.

The child's stdin is a pipe only the app holds. stdout and stderr go to the log (`<data>/logs/hub.log` for the hub,
`<app log dir>/node.log` for the node), rotated at 5 MB with one previous file kept. Before starting the hub the app
checks its three ports: one taken → status "port busy" with that port and no start. A crash restarts the child after 2 s; five crashes within two
minutes stop the retries (status "keeps stopping", Restart tries again). Quit and Restart write `stop` to stdin and
kill after 15 s (Windows has no SIGTERM for a windowless child). The child also stops when its stdin closes, so it
never outlives the app, even after a crash of the app. On Windows the child runs in a job object with kill-on-close,
so plugins and brain CLIs end with it; on macOS the app kills the child's process group.

On macOS a GUI app gets a bare PATH. The hub reads the user's login-shell PATH itself (`packages/core/src/user-path.ts`,
with `PIOMIO_INSTALL_CLIS=1`); `piomio-node` does not, so for the node (its `run` and `pair`) the app reads the login
shell's PATH once (`$SHELL -ilc`, 5 s timeout, the usual Homebrew and `~/.local/bin` folders as the fallback) and
passes it on.

Migration on macOS: the AppleScript build (on `main` before this app) ran the hub from its own LaunchAgent
`ai.owlbot.hub` with the same data dir and port. When `~/Library/LaunchAgents/ai.owlbot.hub.plist` exists, the app
boots that agent out and deletes the plist before it starts its own hub. The pre-rename open-bot 0.1.0 is not migrated
(the rename made a clean break); its hub keeps running on 8080 next to the app until it is uninstalled.

## Windows (`window.rs`)

Two windows:

- **main** shows the hub's own web UI. Hub mode: the address `node launch.mjs url` prints once the hub answers; with
  `#setup=<code>` the setup form opens as today, otherwise the app adds `#desktop=<ticket>` (see Sign-in). Node mode:
  the hub URL from `~/.piomio-node`; the user signs in with that hub's password.
- **setup** shows the app's own screens (`ui/`): the first-run choice, pairing, a link to confirm, "starting…" and
  "did not start".

The hub page gets no app commands: `capabilities/setup.json` grants them to the setup window only. Navigation in the
main window stays on the hub's origin; any other link and every new-window request opens in the system browser.
Closing the main window hides it; on macOS the app then drops its Dock icon (accessory) until a window opens again.
Closing the setup window before the first choice quits. The webview keeps its cookies, so a session survives restarts.
Passkeys do not work in the macOS webview for these origins; WebView2 on Windows supports them.

## Sign-in (hub mode)

The app signs its own window in with one-time tickets, sent over the child's stdin:

1. When it opens the main window, the app makes a 32-byte random ticket and writes `ticket <base64url>` to the hub's
   stdin.
2. The core reads stdin when `PIOMIO_DESKTOP=1` (`cli.ts start`): `stop` stops the hub (moved here from `launch.mjs`),
   `ticket <t>` stores the SHA-256 of `t` with a 60 s expiry, in memory only (`packages/core/src/desktop-login.ts`).
3. The window opens `<hub>/#desktop=<t>`. The web UI posts the ticket to `POST /api/auth/desktop` before it decides
   between sign-in form and app (origin-checked like the other auth routes); a valid, unused ticket creates a normal
   session cookie and an audit entry `auth.desktop`. Used, expired or unknown tickets get 401 and the page shows the
   usual sign-in form.

Only the process that started the hub holds that stdin, so other programs of the same user cannot mint tickets. The
owner still sets a password at first run: browser, phone and the security console need it.

## First run and pairing (`ui/`)

With no settings the app opens the setup window, "How will you use this computer?":

- **A new Piomio on this computer** → mode hub, start the hub, open the main window (the setup form with the code
  filled in), turn on start at login.
- **Connect to my Piomio** → a form: hub address, the code from the hub's Machines page, the machine name (default:
  the computer's name). The app runs `node piomio-node.mjs pair <url> <code> --name <name>` and shows the last lines
  of its output on failure (the CLI's own localized text). On success: mode node, start the node, open the hub's UI.
  When `~/.piomio-node/config.json` already exists, the screen offers to use that connection.

Tray "Set up again…" shows this screen again; what runs keeps running until a different choice is made, and nothing is
deleted.

`piomio://pair?hub=<url>&code=<code>` (deep-link plugin; on Windows it arrives through single-instance) opens a
confirmation with the hub address and the name field, then pairs as above. In hub mode the screen says this computer
stops being a hub (its data stays; "Set up again…" goes back). The hub's Machines page shows a "Connect with the app"
link next to the `piomio-node pair` command (`packages/web/src/pages/Machines.tsx`).

Commands of the setup screens: `get_state`, `choose_hub`, `pair`, `use_existing_node`, `open_log`, `retry`, `dismiss`.

## Tray (`tray.rs`)

Status line (starting, running, restarting, keeps stopping, port busy, stopped; node: "Machine of <hub>" while the
node process runs), the update item (below), Open Piomio, Start at login (checkbox), Show log, Restart, Set up
again…, Quit. On Windows a click
on the icon opens the window; on macOS it shows the menu. Texts come from `packaging/desktop/locales` (`tray.*` and
`app.*` keys); the language follows the system, English as the fallback.

## Updates (`update.rs`)

The app updates itself from the project's GitHub releases with `tauri-plugin-updater`. It reads `latest.json` of the
latest release (`https://github.com/legostin/piomio/releases/latest/download/latest.json`) a minute after start
and every six hours, and downloads a newer version in the background. Every file is checked against the project's
minisign key: its public half is in `tauri.conf.json`, so only builds signed with it install. Installing is the
person's choice: the tray item reads "Check for updates", "Checking…", then "Install update <version>". Picking it
(or `Piomio --update`) stops the hub cleanly (its tasks wait in the queue, a standby replica takes over meanwhile),
installs, and restarts the app. On macOS the new `.app` replaces the old one in place. On Windows the NSIS installer
runs in passive mode. A failed install starts the hub again.

- Building: with the signing key (`TAURI_SIGNING_PRIVATE_KEY`, a GitHub secret for CI, or `~/.tauri/piomio.key` on a
  release machine) `build.mjs` turns on `createUpdaterArtifacts` and also writes `piomio-<version>-mac.app.tar.gz` and
  the Windows installer's `.sig`. Without the key the installers are built as before, without update files.
- Developer ID (`packaging/macos/sign.mjs`): with the secrets `APPLE_CERTIFICATE` (a .p12 with the "Developer ID
  Application" identity, base64) and `APPLE_CERTIFICATE_PASSWORD`, `desktop.yml` imports the identity into a keychain
  of the run's own. `build.mjs` then signs our binaries in the staged hub (the Tailscale node; Node's keep Node's
  signature) with the hardened runtime and a timestamp, Tauri signs the app, and with `APPLE_ID` + `APPLE_PASSWORD`
  (an app-specific password; the team comes from the identity) notarizes and staples it; the disk image is signed,
  notarized and stapled after it. A "Developer ID Installer" identity in the same .p12 signs the .pkg too. The job
  checks the signatures, the tickets and Gatekeeper's verdict. Without the secrets (a fork's PR) the app is signed
  ad hoc as before.
- Releasing: `release.yml` passes the secret to `desktop.yml` and writes `latest.json` with
  `packaging/desktop/latest-json.mjs` (the universal Mac app for both architectures, the Windows installer). Updates
  need increasing versions: the tag is the root `package.json` version.
- After an update the hub's leader sees a newer version than at its last start (`meta.app_version`, per replica). It
  hands the default agent the release's notes from the GitHub API. The agent then tells the person, in their
  language, which version they are on and what changed (`packages/core/src/updates.ts`). The note it leaves in the
  dialog is replicated, so another replica on the same version stays quiet.
- The test build and a dev run do not update. The test build takes a feed only when pointed at one
  (`PIOMIO_UPDATE_URL`, plain http allowed), for a local end-to-end check.

## Start at login (`autostart.rs`)

On by default after the first-run choice; the tray checkbox toggles `autostart` in the settings, and the app applies
the setting at every start (which also repairs the entry after a move or an upgrade). The app then starts with
`--background`.

- macOS: the app's own LaunchAgent `~/Library/LaunchAgents/ai.piomio.app.plist` (`AssociatedBundleIdentifiers`, so
  System Settings names Piomio). It runs a small `/bin/sh -c` guard: `<exe> --background` while the app is there, and
  it deletes its own plist once the app was moved to the Trash. `SMAppService.mainApp` was the first idea, but a login
  item started that way gets no arguments and would open the window at every login.
- Windows: the HKCU Run value `Piomio` = `"<exe>" --background`. The Tauri uninstaller removes that value by the
  product name (not on an update).

## Packaging

`npm run package:desktop` (on the target OS) builds the UIs, stages the hub (`stage.mjs`), builds
`packages/desktop/ui` and runs `tauri build` with the staged tree as a resource (`packaging/desktop/build.mjs` passes
the target-specific paths through `--config`). `@tauri-apps/cli` is a dev dependency; Rust comes from rustup.

- macOS: `--target universal-apple-darwin` (needs the `aarch64` and `x86_64` Rust targets). Bundles `app` and `dmg`
  (drag to Applications), signed ad hoc. The bundler signs without `--deep`: Node keeps its own Developer ID signature
  and notarization, which a quarantined copy needs. Outputs `dist/desktop/piomio-<version>.dmg` and, through
  `pkgbuild` + `productbuild`, `dist/desktop/piomio-<version>.pkg` with the same app for silent installs
  (`sudo installer -pkg … -target /`, SSH, MDM): the preinstall quits a running app, removes the previous copy and the
  AppleScript build's agent; the postinstall opens the app for the user at the console. `uninstall.sh` (in the app's
  Resources) removes it without the Finder. Uninstalling by hand: move the app to the Trash; the data stays.
- Windows: the NSIS bundle, per user (no administrator rights), English and Russian,
  `dist/desktop/piomio-setup-<version>-x64.exe`. It installs into the template's default `%LOCALAPPDATA%\Piomio`,
  which also holds the hub's data: the uninstaller removes only the files it installed. `/S` installs silently and
  starts the app in the background unless `/NOSTART` is given. On uninstall a hook asks (default No) before deleting
  `%LOCALAPPDATA%\Piomio`; a silent uninstall or an update keeps it.

## Test build

`npm run package:desktop -- --test` builds **Piomio Test** (identifier `ai.piomio.test`, links `piomio-test://`,
`piomio-test-<version>.dmg` or `piomio-test-setup-<version>-x64.exe`, no `.pkg`). The app sees the flavor in its
identifier (`flavor.rs`): data in `Piomio Test`, node pairing in `~/.piomio-node-test`, its own LaunchAgent / Run value,
ports right after the app's (41790, 41791, 41799: `PIOMIO_DESKTOP_PORT` for `launch.mjs`), and no 0.1.0 migration. So it
runs next to an installed Piomio. Window titles and the tray tooltip read "Piomio Test", the tray menu starts with
"Test build · port 41790" and the setup screens show a strip saying it is a test build.

## Checks

- `cargo test` in `packages/desktop/src-tauri`: settings, deep links, texts, tickets, the supervisor (with `node` as a
  fake child), PATH parsing, the LaunchAgent, tray texts, origins, arguments.
- vitest: `desktop-login.ts` and `POST /api/auth/desktop` (single use, expiry, origin), the node daemon's stdin,
  `launch.mjs`, the stage filter, the web ticket and pairing link, the NSIS hooks, catalog parity.
- `.github/workflows/desktop.yml`, clean runners:
  - macOS: build universal; the image holds the app and an `/Applications` link; `codesign --verify --strict`; Node
    keeps its Team ID; copy the app, run it with `--mode hub --background`, check `/api/auth/state`, the setup URL and
    the LaunchAgent, `--quit`, the hub is gone; the `.pkg` installs silently, the app runs, `uninstall.sh` removes it,
    the data stays.
  - Windows: `/S /NOSTART`, run with `--mode hub --background`, check the hub and the Run value, `--quit`, `/S`
    uninstall, the data stays, the Run value is gone.

## Not covered

System notifications, code signing and notarization, Windows on ARM, Linux, a styled disk image window,
migrating the pre-rename open-bot 0.1.0 install.
