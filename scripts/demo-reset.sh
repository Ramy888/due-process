#!/usr/bin/env bash
# Resets the desk for a fresh demo run.
#   scripts/demo-reset.sh              clear local state (runs, trails, trades, signal sales, CRE run logs)
#   scripts/demo-reset.sh --redeploy   also redeploy on Base Sepolia (costs test gas, ~0.004 ETH)
# On-chain state cannot be rolled back: a judgment's 24 h auto-approve revocation and a suspended licence stay on the
# deployed DeskLedger, so a clean on-chain demo needs --redeploy.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -f data/runtime/desk.sqlite
rm -rf proof/runs workflows/payloads/runtime
echo "local desk state cleared"
if [ "${1:-}" = "--redeploy" ]; then
  ./scripts/deploy-base-sepolia.sh
fi
