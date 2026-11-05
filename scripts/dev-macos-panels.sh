#!/bin/bash
# Run from this branch's isolated checkout. Uses a new hub, data directory and port; never the installed hub's data.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$(uname -s)" != Darwin ]; then echo "This command needs macOS." >&2; exit 1; fi
if [ ! -d node_modules ]; then npm ci; fi
node packaging/desktop/stage.mjs --target darwin
npm run build:ui -w @piomio/desktop
task_dev_data="$PWD/.data/macos-panel-dev"
mkdir -p "$task_dev_data"
if [ ! -f "$task_dev_data/desktop.json" ]; then printf '{"port":41820}\n' > "$task_dev_data/desktop.json"; fi
export PIOMIO_APP_ROOT="$PWD/dist/desktop/stage-darwin/app"
export PIOMIO_DATA_DIR="$task_dev_data"
export PIOMIO_NODE_HOME="$task_dev_data/node"
exec cargo run --locked --manifest-path packages/desktop/src-tauri/Cargo.toml -- --mode hub
