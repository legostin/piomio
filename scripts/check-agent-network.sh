#!/usr/bin/env bash
# Run on the hub's Mac outside an agent sandbox: the proxy/hub tests bind loopback ports.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run typecheck
node node_modules/typescript/bin/tsc -p packages/console/tsconfig.json --noEmit
npm test -- \
  packages/core/test/network-approvals.test.ts \
  packages/core/test/network-approval-hub.test.ts \
  packages/core/test/egress.test.ts \
  packages/core/test/brain-egress.test.ts \
  packages/core/test/native-network-permission.test.ts \
  packages/core/test/native-permission.test.ts \
  packages/core/test/hub-approval.test.ts \
  packages/brains-cli/test/network.test.ts \
  packages/web/src/pages/chat/network-approval.test.ts \
  packages/core/test/i18n.test.ts \
  packages/web/src/i18n/i18n.test.ts \
  packages/console/src/lib/lib.test.ts
npm run build -w @piomio/web
npm run build -w @piomio/console
