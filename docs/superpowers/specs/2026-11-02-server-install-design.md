# Piomio on a server without Docker: install in one command, use the CLIs that are there, update on a button

Asked 2026-11-01/02. The person: "ideally one of the three (Claude Code, Codex, Kimi Code) is installed and signed in
on the server, and nothing needs doing in the app: neither signing in nor copying, it just sees what is there and
sends work there". Hermes Agent and OpenClaw work that way: they install on the server as a user (a systemd service)
and run the agent with that user's PATH and home. The Docker image can't: the container doesn't see the server's
logins. Decisions: the main server path is a native install; Docker stays as the sealed alternative; installed as root
the installer makes a user `piomio` without sudo; updates come on a button (the machines block and a note in the chat,
with a tool for "update the server"), with a rollback; the machines block offers it for servers and nodes, the desktop
apps keep their tray updater.

## Install

`curl -fsSL https://piomio.io/install.sh | sh` (also a release asset). Linux x64/arm64 with systemd and glibc; anything
else stops with a pointer to Docker. Run as root it creates the user `piomio` (no sudo), installs Chromium's system
libraries (apt), enables linger and installs for that user; run as a user it installs for that user (linger through
`loginctl`, or a hint for an admin).

Layout (home `H`):
- `H/.local/lib/piomio/versions/<v>/` the release's tree (hub, plugins, production node_modules, Node, the tailnet
  binary); `current` → the version that runs; `piomio` the launcher (sh); `H/.local/bin/piomio` links to it.
- `H/.local/share/piomio/` the data (`PIOMIO_DATA_DIR`); `H/.config/piomio/env` settings (`EnvironmentFile`).
- `H/.config/systemd/user/piomio.service`: `ExecStart=%h/.local/lib/piomio/piomio start`, `Restart=always`.

The installer waits for the hub, then prints the version, the setup code, the `ssh -N -L 8080:…` line and which brains
`piomio status` finds; with none signed in, the one command to sign one in as that user. Running it again updates.
`piomio uninstall` removes the app and the service and keeps the data (it says where).

## The hub on a server

`packaging/linux/start.mjs` starts it like the desktop app does: the CLIs' home is the user's (`PIOMIO_BRAIN_HOME`),
the login shell's PATH is read (`PIOMIO_INSTALL_CLIS=1`, which also keeps "sign in from the chat" as the fallback),
ports 8080/8081/8082 on 127.0.0.1 as in Docker, `PIOMIO_INSTALL_ROOT` names the install. While no brain works the hub
looks for the CLIs again every 30 s, so a CLI signed in over SSH is picked up without "Check again".

## Updating the hub (`packages/core/src/self-update.ts`)

Only with `PIOMIO_INSTALL_ROOT`. At start and daily the hub reads the latest GitHub release; a newer one with this
architecture's `piomio-<v>-linux-<arch>.tar.gz` (+ `.sig`) is offered: "Update" on the hub's row in the machines block,
and once per version the default agent tells the person and offers it (`show_choices`). The button, the API
(`POST /api/machines/:id/update`) and the tool `hub_machine_update` do the same:

1. download the archive and its `.sig`; check the minisign signature against the key the desktop updates use
   (`tauri.conf.json`'s pubkey, in `packages/shared`);
2. unpack into `versions/<v>`; run its `piomio version` (the new tree loads and says its version);
3. snapshot the DB into the install root (`VACUUM INTO`), write `trial` = `<from> <to> 0`, point `current` at the new
   version (an atomic rename), stop and exit; systemd starts the new one.
4. The launcher counts starts while `trial` exists; after three failed ones it points `current` back, writes
   `rolled-back`, and starts the old version, which restores the snapshot before it opens the DB and has the agent say
   that the update failed. A new version that started deletes `trial` and the snapshot, keeps the previous version
   only, adopts its own launcher, and the existing note says what changed. A start that never comes up exits after
   three minutes and counts as failed.

## Updating nodes

`piomio-node.mjs` carries its version (esbuild define); `MachineInfo` gains `version` and `selfUpdate` (it runs from
the single file and not inside the desktop app). A node older than the hub gets "Update"; the hub sends it its own
bundle over the open connection (`node.update`: base64 + sha256). The node writes `<file>.next`, runs
`node <file>.next --version`, keeps `<file>.prev`, swaps, answers, and restarts: under systemd it exits with 75
(`Restart=` brings it back), otherwise it starts itself again detached first.

## Interface

`MachineActivity` gains `update?: string` (the version on offer) and `updating?: boolean`. Web/desktop: an "Update"
link on the machine's row, "Updating…" while it runs. iOS: the same on the Hub tab's machines.

## Release

`release.yml`'s installers gain Linux jobs (ubuntu x64 and arm64 runners): stage `linux-<arch>` (packaging/desktop
stage.mjs), tar, sign with `TAURI_SIGNING_PRIVATE_KEY` (`tauri signer sign`), sha256; `install.sh` goes with the
release and the site. READMEs: the server section leads with the one command, Docker second; `PIOMIO_INSTALL_ROOT` in
both tables and `.env.example`.

## Not in it

The Docker image is unchanged; servers on macOS/Windows; Linux without systemd or with musl; automatic updates.

## Checks

Unit tests: signature check, version compare, trial/confirm/rollback files, the machines view's offers, the node's swap.
Live: an OrbStack Ubuntu VM, the archive built and signed here: install as root, a CLI signed in as `piomio` is seen,
update to a newer build, a broken build rolls back. The VM is deleted afterwards.
