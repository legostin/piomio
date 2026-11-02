# Server install without Docker: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `curl … | sh` installs the hub on a Linux server as a user, the hub uses that user's signed-in CLIs, and the
hub and its nodes update on a button with a rollback (spec `docs/superpowers/specs/2026-11-02-server-install-design.md`).

**Architecture:** A Linux release archive (the desktop stage with Linux Node) + a POSIX installer and launcher in
`packaging/linux/`; `packages/core/src/self-update.ts` checks releases, verifies minisign, swaps `current` and settles
trial/rollback; nodes swap their single file on `node.update`; the machines view carries offers.

**Tech Stack:** Node 24 TypeScript (type stripping), POSIX sh, systemd user units, minisign (ed25519 + BLAKE2b),
GitHub Actions, React (web), SwiftUI (iOS repo `~/claude-projects/piomio-ios`).

## Global Constraints

- Only erasable TS syntax; local imports with `.ts`; `import type` for types.
- Every user-facing string through catalogs (core `locales/{en,ru}.ts`, web catalog, node `messages.ts`); model text in English.
- New env var `PIOMIO_INSTALL_ROOT` → `.env.example` and both READMEs' tables.
- Tests write only under `tmpdir()`.
- Linux only for the install (x64/arm64, systemd, glibc); the Docker image is unchanged.

## File map

- `packages/shared/src/update-key.ts` — the update public key (same as tauri.conf.json). Exported from shared.
- `packages/core/src/minisign.ts` — `verifyMinisign(data: Buffer | file, sigText, pubkeyText): boolean`.
- `packages/core/src/self-update.ts` — `InstallLayout`, `settleBeforeStart(cfg)`, `HubUpdates` (check, offer, install, confirm, machine updates).
- `packages/core/src/config.ts` — `installRoot?: string` from `PIOMIO_INSTALL_ROOT`.
- `packages/core/src/cli.ts` — `version`, `status` commands; settle before `start`.
- `packages/core/src/app.ts` — wire `updates`; re-probe while no brain works.
- `packages/core/src/activity.ts` — `view()` adds `update`/`updating`.
- `packages/core/src/server/api.ts` — `POST /api/machines/:id/update`.
- `packages/core/src/tools/hub-tools.ts` — `machine_update` (exposed `hub_machine_update`).
- `packages/core/src/locales/{en,ru}.ts` — status/CLI lines.
- `packages/shared/src/types.ts` — `MachineInfo.version?`, `MachineInfo.selfUpdate?`, `MachineActivity.update?`, `MachineActivity.updating?`.
- `packages/node/src/version.ts`, `packages/node/src/self-update.ts`, `info.ts`, `service.ts`, `cli.ts`; `scripts/build-node-bundle.mjs` (define).
- `packaging/linux/{start.mjs,piomio,install.sh,build.mjs}`; `packaging/desktop/stage.mjs` (linux targets).
- `packages/web/src/components/MachinesBlock.tsx` + web catalogs; iOS Hub tab machines.
- `.github/workflows/desktop.yml` (linux job), `release.yml` (assets), `site.yml` + site build (install.sh), READMEs, `.env.example`.

## Tasks

### Task 1: minisign check and the update key
- [ ] Test `packages/core/test/minisign.test.ts`: a fixture signed with a throwaway key (made with `tauri signer generate`/`sign`) verifies; a flipped byte, a wrong key and a broken trusted comment fail.
- [ ] Implement `verifyMinisign` (alg `Ed`: ed25519 over the data; `ED`: over BLAKE2b-512 of the data; global signature over signature‖trusted comment; key ids match). Streams files.
- [ ] `UPDATE_PUBKEY` in shared, equal to tauri.conf.json's pubkey (test asserts equality).

### Task 2: install layout, trial and rollback files
- [ ] Test `packages/core/test/self-update.test.ts` with a temp install root: `settleBeforeStart` restores the snapshot over `piomio.db` (and drops `-wal`/`-shm`) when `rolled-back` exists; `confirmStarted` removes `trial` + snapshot when `trial`'s target is this version, prunes versions but current + previous, copies the launcher; `switchTo` points `current` atomically.
- [ ] Implement in `self-update.ts`.

### Task 3: release check and the hub's own update
- [ ] Test: `latestOffer(repo, version, arch, fetch)` picks `piomio-<v>-linux-<arch>.tar.gz` + `.sig` from a newer release, none for the same/older one or without the asset.
- [ ] Test: `installUpdate` with a local archive (built in the test with `tar`), a fake signature check and a fake `version` run: unpacks to `versions/<v>`, snapshots the DB, writes `trial`, switches `current`, calls `restart`; a failing version check leaves everything as it was.
- [ ] Implement `HubUpdates` (daily check timer, once-per-version note through `runner.tellAgent`, `updating` state, events).

### Task 4: wiring in the hub
- [ ] `config.installRoot`; `cli.ts`: `version` prints `config.version`; `start` runs `settleBeforeStart` first; `status` prints version, address, data dir and the brains found.
- [ ] `app.ts`: `updates` created, started when leading, confirm after start, rollback note; brains re-checked every 30 s while none works.
- [ ] Activity view offers: `update` for "local" from `HubUpdates.offer`, for nodes when `selfUpdate` and older than the hub; `updating`. Test in `activity.test.ts`.
- [ ] API route + tool `machine_update` (effect local-write). Test the tool's text for "nothing to update".

### Task 5: node version and self-update
- [ ] `version.ts` (`__PIOMIO_VERSION__` define, else the root package.json); `--version`; `MachineInfo.version`/`selfUpdate`.
- [ ] Test `packages/node/test/self-update.test.ts`: a fake bundle file + a new one that prints the version → swapped, `.prev` kept, restart called; a wrong sha or a new file that prints another version → nothing changes.
- [ ] `node.update` handler in `service.ts`; hub side `MachineHub.update(id)` sends the bundle.

### Task 6: interface
- [ ] Web: "Update"/"Updating…" on the machine row; catalogs en/ru; i18n parity test passes.
- [ ] iOS: the same on the Hub tab's machines (subagent in `~/claude-projects/piomio-ios`).

### Task 7: packaging, CI, docs
- [ ] `stage.mjs`: `linux-x64`/`linux-arm64` targets (Node `node-v…-linux-<arch>.tar.xz`, tailnet `linux-<arch>`); `packaging/linux/build.mjs` makes `dist/linux/piomio-<v>-linux-<arch>.tar.gz` (+ `.sha256`, `.sig` with the key).
- [ ] `start.mjs`, launcher `piomio`, `install.sh`; `desktop.yml` linux matrix job with an install check in the runner; `release.yml` asserts and publishes; site serves `install.sh`.
- [ ] READMEs (en/ru): server section leads with the one command; `PIOMIO_INSTALL_ROOT` row; `.env.example`.

### Task 8: checks
- [ ] `npm run typecheck`, `npm test`, `npm run build`.
- [ ] OrbStack Ubuntu: install as root from a local archive, sign a CLI in as `piomio`, hub sees it; update to a newer build; a broken build rolls back. Delete the VM and build output.
